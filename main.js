import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

// 在 ES Module 里自己算出 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let httpServer;
/** 仅打包后才加载，开发时不 import electron-updater，避免打不开 */
let autoUpdaterRef = null;

async function createWindow() {
  // 打包分发出去的 .dmg：不启动本地 server，所有请求走云端，避免用户机器上暴露 API Key
  const isPackaged = app.isPackaged;
  if (isPackaged) {
    try {
      const mod = await import('electron-updater');
      // 兼容 CJS / ESM 导出形式
      autoUpdaterRef = mod.autoUpdater || (mod.default && mod.default.autoUpdater) || null;
      if (!autoUpdaterRef) {
        console.error('electron-updater 加载成功但未找到 autoUpdater 导出');
      }
    } catch (e) {
      console.error('electron-updater 加载失败:', e);
    }
  }
  if (!isPackaged) {
    try {
      // 仅开发时按需加载 server，避免打包后因 import server 而触发 db 在只读目录打开导致 SQLITE_CANTOPEN
      const { startServer } = await import('./server.js');
      console.log('🚀 开发模式：正在启动本地后端...');
      httpServer = await startServer(3000);
      console.log('✅ 本地后端已启动');
    } catch (err) {
      console.error('❌ 本地后端启动失败:', err);
      if (err.code === 'EADDRINUSE') {
        try {
          httpServer = await startServer(3001);
          console.log('✅ 本地后端在 3001 启动');
        } catch (err2) {
          console.error('❌ 启动失败:', err2);
        }
      }
    }
  } else {
    console.log('📦 已打包模式：使用云端 API，不启动本地 server');
  }

  // 创建窗口
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // 3. 加载网页
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // 开发版和打包版都自动打开开发者工具，方便你随时查看报错
  mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    // 关闭服务器
    if (httpServer) {
      httpServer.close();
      console.log('后端服务器已关闭');
    }
    mainWindow = null;
  });

  // 仅打包后启用自动更新
  if (autoUpdaterRef) {
    autoUpdaterRef.autoDownload = true;
    autoUpdaterRef.on('update-available', () => {
      mainWindow?.webContents?.send('update-available');
    });
    autoUpdaterRef.on('update-not-available', () => {
      mainWindow?.webContents?.send('update-not-available');
    });
    autoUpdaterRef.on('update-downloaded', () => {
      mainWindow?.webContents?.send('update-downloaded');
    });
    autoUpdaterRef.on('error', (err) => {
      mainWindow?.webContents?.send('update-error', err.message);
    });
  }
}

// 供渲染进程调用的更新接口
ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) return { ok: false, reason: 'dev' };
  if (!autoUpdaterRef) return { ok: false, reason: 'updater-missing' };
  try {
    const result = await autoUpdaterRef.checkForUpdates();
    return { ok: true, updateInfo: result?.updateInfo };
  } catch (e) {
    return { ok: false, reason: e.message || String(e) };
  }
});
ipcMain.handle('install-update', () => {
  if (autoUpdaterRef) autoUpdaterRef.quitAndInstall(false, true);
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});