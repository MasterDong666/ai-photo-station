# AI 摄影工作站 - 阿里云部署指南

本文档引导你把 **后端服务** 部署到阿里云 ECS，桌面端（Electron）可继续在本地运行，并连接云上 API。

---

## 一、部署架构说明

- **上云部分**：仅 Node 后端（`server.js` + `db.js` + SQLite），提供 `/register`、`/login`、`/analyze`、`/generate` 等接口。
- **本地部分**：Electron 桌面应用不变，只需把「接口地址」改成你的云服务器地址即可。

---

## 二、阿里云 ECS 准备

1. **购买 / 已有 ECS**
   - 系统建议：**Ubuntu 22.04** 或 **CentOS 7/8**。
   - 开放安全组端口：**22**（SSH）、**3000**（后端，若用 Nginx 反向代理则还需 **80/443**）。

2. **登录服务器**
   ```bash
   ssh root@你的公网IP
   ```

3. **安装 Node.js（推荐 18+）**
   ```bash
   # Ubuntu/Debian
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs

   # 验证
   node -v   # v20.x.x
   npm -v
   ```

---

## 三、上传代码并安装依赖

### 方式 A：本地上传（无 Git）

在**你本地电脑**项目目录打包（排除 node_modules 和无关文件）：

```bash
cd /Users/dong/Desktop/ai-photo-station
tar --exclude=node_modules --exclude=dist --exclude=.git -czvf ai-photo-station.tar.gz .
```

上传到服务器并解压：

```bash
# 本机执行（把 你的公网IP 换成实际 IP）
scp ai-photo-station.tar.gz root@你的公网IP:/opt/

# 登录服务器后
ssh root@你的公网IP
mkdir -p /opt/ai-photo-station
cd /opt/ai-photo-station
tar -xzvf /opt/ai-photo-station.tar.gz -C /opt/ai-photo-station
```

### 方式 B：Git 克隆（推荐）

在服务器上：

```bash
cd /opt
git clone 你的仓库地址 ai-photo-station
cd ai-photo-station
```

### 安装依赖（二选一后必做）

**云服务器上只跑后端，不要装 Electron**，否则会报引擎版本要求（如 Node 22+）和一堆废弃包警告。请用：

```bash
cd /opt/ai-photo-station
npm install --omit=dev
```

这样只会安装 `dependencies`（express、cors、dotenv、bcrypt、node-fetch、sqlite3），不会安装 `devDependencies` 里的 electron、electron-builder，避免 EBADENGINE 和多余依赖。安装完成后直接 `npm run server` 或 `node server.js` 即可。

---

## 四、配置环境变量

**重要**：`.env` 不在 Git 里（已在 .gitignore），服务器上必须自己建，否则会 503（未配置 GEMINI_KEY）。`git pull` / `git reset` 不会覆盖 `.env`，但若目录是全新 clone 的，需要新建。

1. **复制示例配置（若已有 .env.example）或新建**
   ```bash
   cp .env.example .env
   # 若没有 .env.example，直接新建：nano .env
   ```

2. **编辑 .env**
   ```bash
   nano .env
   ```
   至少填写：
   - `GEMINI_KEY=你的Gemini接口Key`
   - `PORT=3000`
   - `HOST=0.0.0.0`（允许外网访问）

   若把数据库放到固定目录，可设置：
   - `DB_PATH=/opt/ai-photo-station/data/users.db`

3. **确保 server 读取 .env**  
   项目已使用 `dotenv`，`node server.js` 会自动加载项目根目录下的 `.env`。

---

## 五、运行后端（二选一）

### 方式 1：直接运行（测试用）

```bash
cd /opt/ai-photo-station
npm run server
# 或
node server.js
```

看到 `Server running on http://0.0.0.0:3000` 即成功。  
浏览器访问：`http://你的公网IP:3000`，若能看到接口（例如用 Postman 请求 `/register` 或返回 404 的 GET），说明服务已对外。

### 方式 2：用 PM2 守护（推荐生产）

```bash
# 安装 PM2
npm install -g pm2

# 启动
cd /opt/ai-photo-station
pm2 start server.js --name ai-photo-api

# 开机自启
pm2 startup
pm2 save
```

常用命令：
- `pm2 status`：查看状态  
- `pm2 logs ai-photo-api`：看日志  
- `pm2 restart ai-photo-api`：重启  

---

## 六、安全组与防火墙

- **阿里云控制台**：安全组里放行 **3000**（或你用的端口）。
- **本机防火墙**（若开了）：
  ```bash
  # Ubuntu ufw
  sudo ufw allow 3000
  sudo ufw reload
  ```

---

## 七、（可选）Nginx 反向代理 + HTTPS

若希望用域名 + 80/443 访问，且不用带端口：

1. 安装 Nginx，并申请域名与 SSL（如阿里云免费证书）。
2. 新增站点配置（示例）：

```nginx
server {
    listen 80;
    server_name api.你的域名.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 100m;
    }
}
```

3. 重载 Nginx：`sudo nginx -t && sudo systemctl reload nginx`。  
4. 前端/桌面端 API 地址填：`http://api.你的域名.com` 或 `https://api.你的域名.com`。

---

## 八、桌面端连接云上 API

部署完成后，桌面端需要把请求发到云服务器而不是本机。

### 方法 1：改代码里的默认地址（简单）

在 `index.html` 里找到：

```javascript
const API_BASE = ... "http://localhost:3000";
```

把 `http://localhost:3000` 改成你的云地址，例如：

- `http://你的公网IP:3000`
- 或 `https://api.你的域名.com`

保存后重新打包/运行 Electron 即可。

### 方法 2：通过 Electron 注入（灵活）

在 Electron 主进程（如 `main.js`）里，在创建 `BrowserWindow` 之后、加载页面之前，通过 `webPreferences` 或 `preload` 把云地址注入到 `window.__API_BASE__`，这样前端里的 `API_BASE` 会自动用云地址，无需改 `index.html`。  
（当前前端已支持：若存在 `window.__API_BASE__` 则优先使用。）

---

## 九、自检清单

- [ ] 服务器已安装 Node 18+
- [ ] 代码已上传/克隆到服务器
- [ ] `npm install` 已执行
- [ ] `.env` 已配置（至少 `GEMINI_KEY`、`PORT`、`HOST=0.0.0.0`）
- [ ] `npm run server` 或 `pm2 start server.js` 能正常跑
- [ ] 安全组/防火墙已放行 3000（或 80/443）
- [ ] 本机浏览器或 Postman 能访问 `http://公网IP:3000`
- [ ] 桌面端已把 `API_BASE` 改为云地址并重新运行

---

## 十、常见问题

- **外网访问不到**：检查安全组、防火墙、以及 `HOST=0.0.0.0`。
- **请求跨域**：后端已开 CORS，一般无需再配；若用 Nginx，确保没有改掉 Origin 导致跨域。
- **数据库位置**：默认在项目根目录 `users.db`，可用 `DB_PATH` 指定到固定目录便于备份。
- **上传大图 413**：Nginx 需设置 `client_max_body_size 100m;`（上面示例已含）。

按以上步骤即可把项目接入阿里云；后续若要优化生成效果，再单独改生成逻辑即可。
