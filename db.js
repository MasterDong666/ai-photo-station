import path from "path";
import sqlite3 from "sqlite3";
import { fileURLToPath } from "url";

sqlite3.verbose();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getDbPath() {
  // 默认放在项目根目录（开发期好找），也支持用环境变量覆盖
  return process.env.DB_PATH || path.join(__dirname, "users.db");
}

export function openDb() {
  const dbPath = getDbPath();
  const db = new sqlite3.Database(dbPath);
  // 避免同时读写导致 SQLITE_BUSY（例如 Electron 进程与开发脚本并行）
  db.configure("busyTimeout", 30000);
  return db;
}

export function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

export function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

export function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function tableHasColumn(db, table, column) {
  const rows = await all(db, `PRAGMA table_info(${table})`);
  return rows.some((r) => r && r.name === column);
}

async function addColumnIfMissing(db, table, column, ddl) {
  const exists = await tableHasColumn(db, table, column);
  if (!exists) {
    await run(db, `ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export async function initDb(db) {
  // users 表（按你指定的字段 + 额外的 usage_date 用于“每日”额度重置）
  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      is_member INTEGER NOT NULL DEFAULT 0,
      usage_count INTEGER NOT NULL DEFAULT 0,
      usage_date TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    `
  );

  // 兼容旧库：补齐 users.created_at
  // SQLite 限制：ALTER TABLE ADD COLUMN 的 DEFAULT 只能是常量
  // 因此对旧库：先加列，再把已有行补齐为当前时间（新插入行在 CREATE TABLE 的默认值里会自动写入）
  await addColumnIfMissing(db, "users", "created_at", "created_at TEXT");
  await run(db, `UPDATE users SET created_at = datetime('now') WHERE created_at IS NULL OR created_at = ''`);

  // sessions：简单 token 鉴权
  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    `
  );

  // subscriptions：记录订阅历史（方案B）
  await run(
    db,
    `
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    `
  );

  await run(
    db,
    `
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user_created
    ON subscriptions(user_id, created_at);
    `
  );
}

export function closeDb(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

