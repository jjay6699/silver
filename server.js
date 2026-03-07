require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT || 5500);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
});

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin1223";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "K1Um]7f15q_r";
const SESSION_COOKIE = "slvr_admin_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const DEFAULT_PREMIUM_PERCENT = Number(process.env.DEFAULT_PREMIUM_PERCENT || 0.04);
const DEFAULT_FIXED_AUD = Number(process.env.DEFAULT_FIXED_AUD || 4.0);
const settingsCache = new Map();

async function initDb() {
  const sqlPath = path.join(__dirname, "db", "init.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await pool.query(sql);
}

function parseCookies(header = "") {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const idx = part.indexOf("=");
      if (idx === -1) return acc;
      const key = part.slice(0, idx);
      const val = part.slice(idx + 1);
      acc[key] = decodeURIComponent(val);
      return acc;
    }, {});
}

function setAuthCookie(res, token) {
  const isSecure = process.env.NODE_ENV === "production";
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecure) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearAuthCookie(res) {
  const isSecure = process.env.NODE_ENV === "production";
  const attrs = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecure) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function createSession() {
  const token = crypto.randomBytes(24).toString("hex");
  settingsCache.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function requireAdmin(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE];
  const session = token ? settingsCache.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) settingsCache.delete(token);
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return res.redirect("/admin/login");
  }
  next();
}

function validatePremiumConfig(percent, fixedAud) {
  if (!Number.isFinite(percent) || percent < 0 || percent > 1) {
    return "premiumPercent must be a number between 0 and 1";
  }
  if (!Number.isFinite(fixedAud) || fixedAud < 0 || fixedAud > 10000) {
    return "fixedAud must be a number between 0 and 10000";
  }
  return null;
}

async function readPremiumConfig() {
  try {
    const result = await pool.query("SELECT value_json FROM app_settings WHERE key = 'premium_config' LIMIT 1");
    const value = result.rows?.[0]?.value_json;
    const premiumPercent = Number(value?.premiumPercent);
    const fixedAud = Number(value?.fixedAud);
    if (Number.isFinite(premiumPercent) && Number.isFinite(fixedAud)) {
      return { premiumPercent, fixedAud };
    }
  } catch (err) {
    console.warn("Failed to read premium config, using defaults", err.message);
  }
  return { premiumPercent: DEFAULT_PREMIUM_PERCENT, fixedAud: DEFAULT_FIXED_AUD };
}

async function writePremiumConfig(premiumPercent, fixedAud) {
  await pool.query(
    `INSERT INTO app_settings (key, value_json, updated_at)
     VALUES ('premium_config', $1::jsonb, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [JSON.stringify({ premiumPercent, fixedAud })]
  );
}

app.use(express.json({ limit: "256kb" }));

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "up" });
  } catch (err) {
    res.status(500).json({ ok: false, database: "down", error: err.message });
  }
});

app.get("/api/premium-config", async (req, res) => {
  const config = await readPremiumConfig();
  res.json(config);
});

app.post("/api/admin/login", (req, res) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = createSession();
  setAuthCookie(res, token);
  return res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE];
  if (token) settingsCache.delete(token);
  clearAuthCookie(res);
  return res.json({ ok: true });
});

app.get("/api/admin/premium-config", requireAdmin, async (req, res) => {
  const config = await readPremiumConfig();
  res.json(config);
});

app.post("/api/admin/premium-config", requireAdmin, async (req, res) => {
  const premiumPercent = Number(req.body?.premiumPercent);
  const fixedAud = Number(req.body?.fixedAud);
  const error = validatePremiumConfig(premiumPercent, fixedAud);
  if (error) return res.status(400).json({ error });

  try {
    await writePremiumConfig(premiumPercent, fixedAud);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to save premium config" });
  }
});

app.get("/api/mints/:walletAddress", async (req, res) => {
  const walletAddress = String(req.params.walletAddress || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: "Invalid wallet address" });
  }

  try {
    const result = await pool.query(
      `SELECT serial, ounces, slvr, usd_text, usd_raw, eth_raw, minted_at
       FROM wallet_mints
       WHERE wallet_address = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [walletAddress]
    );

    const items = result.rows.map((row) => ({
      serial: row.serial,
      ounces: Number(row.ounces).toFixed(2),
      slvr: Number(row.slvr).toFixed(0),
      usd: row.usd_text,
      usdRaw: row.usd_raw === null ? null : Number(row.usd_raw),
      ethRaw: row.eth_raw === null ? null : Number(row.eth_raw),
      ts: row.minted_at,
    }));

    return res.json({ items });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load mints" });
  }
});

app.post("/api/mints/:walletAddress", async (req, res) => {
  const walletAddress = String(req.params.walletAddress || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: "Invalid wallet address" });
  }

  const body = req.body || {};
  const serial = String(body.serial || "").trim();
  const ounces = Number(body.ounces);
  const slvr = Number(body.slvr);
  const usdText = body.usd == null ? null : String(body.usd);
  const usdRaw = body.usdRaw == null ? null : Number(body.usdRaw);
  const ethRaw = body.ethRaw == null ? null : Number(body.ethRaw);
  const mintedAt = body.ts ? new Date(body.ts) : new Date();

  if (!/^\d{11}$/.test(serial)) {
    return res.status(400).json({ error: "Invalid serial" });
  }
  if (!Number.isFinite(ounces) || ounces <= 0) {
    return res.status(400).json({ error: "Invalid ounces" });
  }
  if (!Number.isFinite(slvr) || slvr <= 0) {
    return res.status(400).json({ error: "Invalid slvr" });
  }
  if (Number.isNaN(mintedAt.getTime())) {
    return res.status(400).json({ error: "Invalid timestamp" });
  }

  try {
    await pool.query(
      `INSERT INTO wallet_mints (wallet_address, serial, ounces, slvr, usd_text, usd_raw, eth_raw, minted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (wallet_address, serial) DO NOTHING`,
      [walletAddress, serial, ounces, slvr, usdText, usdRaw, ethRaw, mintedAt.toISOString()]
    );

    return res.status(201).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to save mint" });
  }
});

app.get("/admin/login", (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "login.html"));
});

app.get("/admin/panel", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "panel.html"));
});

app.use("/admin", express.static(path.join(__dirname, "admin")));
app.use(express.static(__dirname));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  initDb().catch((err) => {
    const details = err && err.message ? err.message : String(err);
    console.error("Database initialization failed:", details);
  });
});
