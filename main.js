import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer } from './server.js';

// 在 ES Module 里自己算出 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let httpServer;

async function createWindow() {
  // 打包分发出去的 .dmg：不启动本地 server，所有请求走云端，避免用户机器上暴露 API Key
  const isPackaged = app.isPackaged;
  if (!isPackaged) {
    try {
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

  // 🟢 关键：打开开发者工具，让你看到哪里报错
  mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    // 关闭服务器
    if (httpServer) {
      httpServer.close();
      console.log('后端服务器已关闭');
    }
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});