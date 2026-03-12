import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { openDb, initDb, get, run, all } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 从 server.js 所在目录加载 .env，避免 PM2 工作目录不同导致读不到
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
app.use(cors());

app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

const BASE_URL = "https://llm-api.mmchat.xyz/gemini";
// API Key 仅从环境变量读取，不写死在代码里（分发出去的 .dmg 中不会包含密钥）
const GEMINI_KEY = process.env.GEMINI_KEY;

// ===== 用户系统配置 =====
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 3);
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);

const db = openDb();

// 先不阻塞：HTTP 立即监听，DB 在后台初始化（避免 initDb 卡住导致永远不 listen）
let dbReady = false;
initDb(db)
  .then(() => {
    dbReady = true;
    console.log("✅ DB 初始化完成");
  })
  .catch((err) => {
    console.error("❌ DB 初始化失败:", err);
  });

// 依赖 DB 的接口在未就绪时返回 503
function requireDb(req, res, next) {
  if (dbReady) return next();
  res.status(503).json({ error: "服务初始化中，请稍候" });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: "未登录：缺少 token" });
  const token = m[1];

  const session = await get(db, `SELECT token, user_id FROM sessions WHERE token = ?`, [token]);
  if (!session) return res.status(401).json({ error: "登录已失效，请重新登录" });

  const user = await get(
    db,
    `SELECT id, username, is_member, usage_count, usage_date FROM users WHERE id = ?`,
    [session.user_id]
  );
  if (!user) return res.status(401).json({ error: "用户不存在" });

  // 每日重置（仅免费用户）
  if (!user.is_member) {
    const t = todayKey();
    if (user.usage_date !== t) {
      await run(db, `UPDATE users SET usage_count = 0, usage_date = ? WHERE id = ?`, [t, user.id]);
      user.usage_count = 0;
      user.usage_date = t;
    }
  }

  req.user = user;
  next();
}

function userDto(user) {
  const isMember = !!user.is_member;
  const remaining = isMember ? Infinity : Math.max(0, FREE_DAILY_LIMIT - (user.usage_count || 0));
  return {
    id: user.id,
    username: user.username,
    is_member: isMember,
    usage_count: user.usage_count || 0,
    remaining
  };
}

async function getLatestSubscription(userId) {
  return await get(
    db,
    `
    SELECT id, plan, starts_at, expires_at, created_at
    FROM subscriptions
    WHERE user_id = ?
    ORDER BY datetime(created_at) DESC
    LIMIT 1
    `,
    [userId]
  );
}

function isSubscriptionActive(sub) {
  if (!sub) return false;
  if (sub.plan === "lifetime") return true;
  if (!sub.expires_at) return false;
  return new Date(sub.expires_at).getTime() >= Date.now();
}

function subscriptionDto(sub) {
  if (!sub) return null;
  return {
    plan: sub.plan,
    starts_at: sub.starts_at,
    expires_at: sub.expires_at,
    active: isSubscriptionActive(sub)
  };
}

// 健康检查（不依赖 DB，用于确认端口已监听）
app.get("/health", (req, res) => res.status(200).send("ok"));

// ===== Auth APIs =====
app.post("/register", requireDb, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "缺少 username 或 password" });
    if (String(password).length < 4) return res.status(400).json({ error: "密码至少 4 位（演示用）" });

    const hashed = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const t = todayKey();
    await run(
      db,
      `INSERT INTO users (username, password, is_member, usage_count, usage_date) VALUES (?, ?, 0, 0, ?)`,
      [String(username), hashed, t]
    );
    const user = await get(db, `SELECT * FROM users WHERE username = ?`, [String(username)]);
    const token = makeToken();
    await run(
      db,
      `INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`,
      [token, user.id, new Date().toISOString()]
    );

    const sub = await getLatestSubscription(user.id);
    const active = isSubscriptionActive(sub);
    if (active && !user.is_member) {
      await run(db, `UPDATE users SET is_member = 1 WHERE id = ?`, [user.id]);
      user.is_member = 1;
    }
    res.json({ token, user: userDto(user), subscription: subscriptionDto(sub) });
  } catch (e) {
    if (String(e?.message || "").includes("UNIQUE")) {
      return res.status(409).json({ error: "用户名已存在" });
    }
    res.status(500).json({ error: e.toString() });
  }
});

app.post("/login", requireDb, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "缺少 username 或 password" });

    const user = await get(db, `SELECT * FROM users WHERE username = ?`, [String(username)]);
    if (!user) return res.status(401).json({ error: "用户名或密码错误" });

    const ok = await bcrypt.compare(String(password), user.password);
    if (!ok) return res.status(401).json({ error: "用户名或密码错误" });

    // 每日重置（仅免费用户）
    if (!user.is_member) {
      const t = todayKey();
      if (user.usage_date !== t) {
        await run(db, `UPDATE users SET usage_count = 0, usage_date = ? WHERE id = ?`, [t, user.id]);
        user.usage_count = 0;
        user.usage_date = t;
      }
    }

    const token = makeToken();
    await run(
      db,
      `INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`,
      [token, user.id, new Date().toISOString()]
    );

    const sub = await getLatestSubscription(user.id);
    const active = isSubscriptionActive(sub);
    if (active && !user.is_member) {
      await run(db, `UPDATE users SET is_member = 1 WHERE id = ?`, [user.id]);
      user.is_member = 1;
    }
    res.json({ token, user: userDto(user), subscription: subscriptionDto(sub) });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// ===== Subscription APIs (方案B) =====
app.post("/subscribe", requireDb, authMiddleware, async (req, res) => {
  try {
    const { plan } = req.body || {};
    const p = String(plan || "").trim();
    const allowed = new Set(["month", "quarter", "year"]);
    if (!allowed.has(p)) return res.status(400).json({ error: "无效 plan（month/quarter/year）" });

    const now = new Date();
    const startsAt = now.toISOString();
    const expires = new Date(now);
    if (p === "month") expires.setMonth(expires.getMonth() + 1);
    if (p === "quarter") expires.setMonth(expires.getMonth() + 3);
    if (p === "year") expires.setFullYear(expires.getFullYear() + 1);

    await run(
      db,
      `INSERT INTO subscriptions (user_id, plan, starts_at, expires_at) VALUES (?, ?, ?, ?)`,
      [req.user.id, p, startsAt, expires.toISOString()]
    );

    await run(db, `UPDATE users SET is_member = 1 WHERE id = ?`, [req.user.id]);
    const sub = await getLatestSubscription(req.user.id);
    const user = await get(db, `SELECT id, username, is_member, usage_count, usage_date FROM users WHERE id = ?`, [req.user.id]);
    res.json({ ok: true, user: userDto(user), subscription: subscriptionDto(sub) });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

app.post("/redeem", requireDb, authMiddleware, async (req, res) => {
  try {
    const { code } = req.body || {};
    const c = String(code || "").trim();
    // 初始永久会员激活码：666（演示用，后续可改成数据库存激活码）
    if (c !== "666") return res.status(400).json({ error: "激活码无效" });

    const now = new Date().toISOString();
    await run(
      db,
      `INSERT INTO subscriptions (user_id, plan, starts_at, expires_at) VALUES (?, ?, ?, NULL)`,
      [req.user.id, "lifetime", now]
    );
    await run(db, `UPDATE users SET is_member = 1 WHERE id = ?`, [req.user.id]);

    const sub = await getLatestSubscription(req.user.id);
    const user = await get(db, `SELECT id, username, is_member, usage_count, usage_date FROM users WHERE id = ?`, [req.user.id]);
    res.json({ ok: true, user: userDto(user), subscription: subscriptionDto(sub) });
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});
/* ✅ 1. 识别接口 (保持原样) */
app.post("/analyze", async (req, res) => {
  console.log("🔍 正在接收识别请求...");
  if (!GEMINI_KEY) return res.status(503).json({ error: "服务未配置 GEMINI_KEY，请在服务器 .env 中设置" });
  try {
    const { images } = req.body;
    if (!images || images.length === 0) return res.status(400).json({ error: "无图片" });

    const prompt = `Analyze product: return JSON { "category":"", "product_type":"", "materials":[], "colors":[], "style_keywords":[], "selling_points":[] }`;

    const response = await fetch(
      `${BASE_URL}/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              ...images.map(img => ({
                inlineData: { mimeType: "image/jpeg", data: img.replace(/^data:image\/\w+;base64,/, "") }
              }))
            ]
          }]
        })
      }
    );

    const data = await response.json();
    if (!response.ok) return res.status(500).json(data);

    res.json({ result: data.candidates[0].content.parts[0].text });
    console.log("✅ 识别成功");
  } catch (e) {
    res.status(500).json({ error: e.toString() });
  }
});

// ===== 电商化：场景 / 光影 / 材质 预设（开箱即用、一致性）
const SCENE_PRESETS = {
  white_bg: "Pure white background, no shadows, e-commerce main image style, 800x800 composition, clean and listable.",
  transparent_bg: "Isolated product on transparent background, no environment, studio lighting, suitable for PNG export.",
  indoor: "Indoor lifestyle setting, warm ambient light, natural environment, lifestyle product shot.",
  premium_dark: "Dark moody background, dramatic side light, premium luxury feel, high contrast.",
  beauty: "Soft diffused light, high skin/product texture quality, clean beauty product style, minimal shadows.",
  tech: "Cool tone, subtle reflections, metal and glass emphasis, tech product aesthetic.",
  food: "Appetizing warm light, fresh look, food photography style, shallow depth of field.",
  fashion: "Flat lay or hanging garment style, neutral background, fashion e-commerce, consistent color."
};

const LIGHTING_PRESETS = {
  default: "",
  left: "Light from left side, soft shadow on right.",
  top: "Top-down soft light, minimal shadow, even illumination.",
  softbox: "Large softbox lighting, very soft shadows, professional studio.",
  hard: "Hard directional light, defined shadows, dramatic."
};

const MATERIAL_PRESETS = {
  none: "",
  metal: "Emphasize metal reflection and surface accuracy, no distortion.",
  glass: "Glass transparency and subtle refraction, clean edges.",
  matte: "Matte surface, no harsh reflections, texture visible.",
  wood: "Natural wood grain and warmth, no plastic look."
};

function buildCommercialPrompt(angle, profile, stylePreset, lighting, material) {
  const scene = SCENE_PRESETS[stylePreset] || SCENE_PRESETS.white_bg;
  const light = LIGHTING_PRESETS[lighting] || "";
  const mat = MATERIAL_PRESETS[material] || "";
  const product = profile?.product_type ? `Product: ${profile.product_type}.` : "";
  const materials = profile?.materials?.length ? `Materials: ${profile.materials.join(", ")}.` : "";
  const colors = profile?.colors?.length ? `Colors: ${profile.colors.join(", ")}.` : "";
  return [
    angle ? `${angle}.` : "",
    "High-end commercial product photography.",
    scene,
    light,
    mat,
    product,
    materials,
    colors,
    "Keep product shape and details identical across all images. Output suitable for 800x800 e-commerce, no watermark, consistent lighting and color, no distortion or warped text."
  ].filter(Boolean).join(" ");
}

/* ✅ 2. 生成接口：支持 preset 或旧版 prompt；统一电商化输出说明 */
app.post("/generate", requireDb, authMiddleware, async (req, res) => {
  console.log("🎨 正在生成背景图...");
  if (!GEMINI_KEY) return res.status(503).json({ error: "服务未配置 GEMINI_KEY，请在服务器 .env 中设置" });
  try {
    const user = req.user;
    const latestSub = await getLatestSubscription(user.id);
    const subActive = isSubscriptionActive(latestSub);
    const isMember = subActive || !!user.is_member;
    if (subActive && !user.is_member) {
      await run(db, `UPDATE users SET is_member = 1 WHERE id = ?`, [user.id]);
    }

    if (!isMember) {
      const remaining = Math.max(0, FREE_DAILY_LIMIT - (user.usage_count || 0));
      if (remaining <= 0) {
        return res.status(402).json({ error: "今日免费额度已用完", remaining: 0 });
      }
    }

    const { prompt, images, angle, profile, stylePreset, lighting, material } = req.body;
    if (!images || !images[0]) return res.status(400).json({ error: "图片丢失" });

    const MODEL_ID = "gemini-2.5-flash-image";

    // 优先使用预设（开箱即用、一致）；兼容旧版只传 prompt
    let fullText;
    if (stylePreset != null && profile != null) {
      fullText = buildCommercialPrompt(angle || "", profile, stylePreset, lighting || "default", material || "none");
    } else {
      const anglePrefix = angle ? `${angle}. ` : "";
      fullText = `High-end commercial photography. ${anglePrefix}${prompt || "Professional product shot, 800x800, clean."}`;
    }

    // 随机 seed 让每次请求有不同随机性，避免 4 张图雷同
    const randomSeed = Math.floor(Math.random() * 2147483647);

    const response = await fetch(
      `${BASE_URL}/v1beta/models/${MODEL_ID}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: fullText },
              { inlineData: {
                  mimeType: "image/jpeg",
                  data: images[0].replace(/^data:image\/\w+;base64,/, "")
                }
              }
            ]
          }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            temperature: 1.4,
            seed: randomSeed
          }
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("❌ 生成报错:", JSON.stringify(result, null, 2));
      return res.status(500).json({ error: "生成失败", details: result });
    }

    const imgPart = result.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (imgPart) {
      console.log("✨ 背景图生成成功！视角:", angle || "(未指定)");
      // 成功后计数 +1（仅免费用户）
      if (!isMember) {
        await run(db, `UPDATE users SET usage_count = usage_count + 1 WHERE id = ?`, [user.id]);
      }
      res.json({ image: imgPart.inlineData.data });
    } else {
      throw new Error("模型未返回图像数据");
    }
  } catch (e) {
    console.error("❌ 崩溃:", e);
    res.status(500).json({ error: e.toString() });
  }
});

// 导出启动函数，以便在 Electron 主进程中调用
// host: 直接运行 server.js 时用 0.0.0.0 以便外网访问；被 Electron 调用时用默认
export function startServer(port = 3000, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`🚀 Server running on http://${host}:${port}`);
      resolve(server);
    });
    server.on("error", reject);
  });
}

// 非 Electron 环境（node server.js / PM2）下自动启动 HTTP；Electron 下由 main.js 调用 startServer
const isElectron = typeof process !== "undefined" && process.versions && process.versions.electron;
if (!isElectron) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || "0.0.0.0";
  console.log(`📡 正在启动 HTTP 服务 ${host}:${port} ...`);
  startServer(port, host).catch((err) => {
    console.error("❌ HTTP 启动失败:", err);
    process.exit(1);
  });
}