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
const DEFAULT_SERIAL_INVENTORY_COUNT = 30000;
const settingsCache = new Map();
const SERIAL_PATTERN = /^\d{11}$/;

async function initDb() {
  const sqlPath = path.join(__dirname, "db", "init.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await pool.query(sql);
  await ensureDefaultSerialInventory();
  await ensureDefaultAdminUser();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const iterations = 120000;
  const keylen = 64;
  const digest = "sha512";
  const hash = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString("hex");
  return { hash, salt, iterations, digest };
}

function verifyPassword(password, record) {
  const { password_salt, password_iter, password_digest, password_hash } = record;
  const hash = crypto
    .pbkdf2Sync(password, password_salt, Number(password_iter), 64, password_digest)
    .toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(password_hash, "hex"));
}

async function ensureDefaultAdminUser() {
  const username = ADMIN_USERNAME;
  const password = ADMIN_PASSWORD;
  if (!password) {
    console.warn("ADMIN_PASSWORD is required to seed admin user.");
    return;
  }
  const existing = await pool.query("SELECT 1 FROM admin_users WHERE username = $1 LIMIT 1", [username]);
  if (existing.rows?.length) return;
  const { hash, salt, iterations, digest } = hashPassword(password);
  await pool.query(
    `INSERT INTO admin_users (username, password_hash, password_salt, password_iter, password_digest, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [username, hash, salt, iterations, digest]
  );
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

function normalizeSerial(raw) {
  return String(raw || "").trim();
}

function parseSerialInput(input = []) {
  const seen = new Set();
  return input
    .map((value) => normalizeSerial(value))
    .filter((serial) => SERIAL_PATTERN.test(serial))
    .filter((serial) => {
      if (seen.has(serial)) return false;
      seen.add(serial);
      return true;
    });
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

async function serialSummary() {
  const result = await pool.query(
    `SELECT
      COUNT(*) FILTER (WHERE is_active = TRUE) AS total_active,
      COUNT(*) FILTER (WHERE is_active = TRUE) AS active_total,
      COUNT(*) FILTER (WHERE is_active = TRUE AND is_allocated = FALSE) AS available_total,
      COUNT(*) FILTER (WHERE is_allocated = TRUE) AS allocated_total
     FROM serial_inventory`
  );
  const row = result.rows?.[0] || {};
  return {
    totalActive: Number(row.total_active || 0),
    activeTotal: Number(row.active_total || 0),
    availableTotal: Number(row.available_total || 0),
    allocatedTotal: Number(row.allocated_total || 0),
  };
}

async function ensureDefaultSerialInventory() {
  const existing = await pool.query(
    `SELECT
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE is_active = TRUE)::int AS active_count
     FROM serial_inventory`
  );
  const count = Number(existing.rows?.[0]?.count || 0);
  const activeCount = Number(existing.rows?.[0]?.active_count || 0);
  if (activeCount >= DEFAULT_SERIAL_INVENTORY_COUNT) return;

  const defaults = [];
  for (let i = 1; i <= DEFAULT_SERIAL_INVENTORY_COUNT; i += 1) {
    defaults.push(String(i).padStart(11, "0"));
  }
  await upsertSerials(defaults, count > 0 ? "append" : "replace");
}

async function upsertSerials(serials, mode = "replace") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const serial of serials) {
      await client.query(
        `INSERT INTO serial_inventory (serial, is_active, updated_at)
         VALUES ($1, TRUE, NOW())
         ON CONFLICT (serial)
         DO UPDATE SET is_active = TRUE, updated_at = NOW()`,
        [serial]
      );
    }

    if (mode === "replace") {
      await client.query(
        `UPDATE serial_inventory
         SET is_active = FALSE, updated_at = NOW()
         WHERE is_allocated = FALSE
           AND serial <> ALL($1::text[])`,
        [serials]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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

app.get("/api/serials/summary", async (req, res) => {
  try {
    const summary = await serialSummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: "Failed to load serial summary" });
  }
});

app.post("/api/admin/login", (req, res) => {
  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  pool
    .query(
      "SELECT username, password_hash, password_salt, password_iter, password_digest FROM admin_users WHERE username = $1 LIMIT 1",
      [username]
    )
    .then((result) => {
      const record = result.rows?.[0];
      if (!record || !verifyPassword(password, record)) {
        return res.status(401).json({ error: "Invalid username or password" });
      }
      const token = createSession();
      setAuthCookie(res, token);
      return res.json({ ok: true });
    })
    .catch(() => res.status(500).json({ error: "Login failed" }));
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

app.get("/api/admin/serials", requireAdmin, async (req, res) => {
  try {
    const list = await pool.query(
      `SELECT serial, is_active, is_allocated, allocated_wallet, allocated_at, updated_at
       FROM serial_inventory
       ORDER BY serial ASC
       LIMIT 5000`
    );
    const summary = await serialSummary();
    return res.json({ items: list.rows, summary });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load serial inventory" });
  }
});

app.post("/api/admin/serials", requireAdmin, async (req, res) => {
  const mode = req.body?.mode === "append" ? "append" : "replace";
  const serials = parseSerialInput(Array.isArray(req.body?.serials) ? req.body.serials : []);
  if (!serials.length) return res.status(400).json({ error: "No valid serials supplied" });

  try {
    await upsertSerials(serials, mode);
    const summary = await serialSummary();
    return res.json({ ok: true, summary, accepted: serials.length, mode });
  } catch (err) {
    return res.status(500).json({ error: "Failed to save serial inventory" });
  }
});

app.get("/api/admin/mints", requireAdmin, async (req, res) => {
  const limitRaw = Number(req.query?.limit || 200);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.trunc(limitRaw))) : 200;
  try {
    const [rowsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT wallet_address, serial, ounces, slvr, usd_text, usd_raw, eth_raw, minted_at, created_at
         FROM wallet_mints
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      ),
      pool.query("SELECT COUNT(*)::int AS total FROM wallet_mints"),
    ]);
    return res.json({
      total: Number(countResult.rows?.[0]?.total || 0),
      items: rowsResult.rows,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to load mint history" });
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
  const ounces = Number(body.ounces);
  const slvr = Number(body.slvr);
  const usdText = body.usd == null ? null : String(body.usd);
  const usdRaw = body.usdRaw == null ? null : Number(body.usdRaw);
  const ethRaw = body.ethRaw == null ? null : Number(body.ethRaw);
  const mintedAt = body.ts ? new Date(body.ts) : new Date();

  if (!Number.isFinite(ounces) || ounces <= 0) {
    return res.status(400).json({ error: "Invalid ounces" });
  }
  if (!Number.isFinite(slvr) || slvr <= 0) {
    return res.status(400).json({ error: "Invalid slvr" });
  }
  if (Number.isNaN(mintedAt.getTime())) {
    return res.status(400).json({ error: "Invalid timestamp" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const serialRow = await client.query(
      `SELECT serial
       FROM serial_inventory
       WHERE is_active = TRUE AND is_allocated = FALSE
       ORDER BY serial ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );
    const serial = serialRow.rows?.[0]?.serial;
    if (!serial) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "No serials available. Please contact admin." });
    }

    await client.query(
      `INSERT INTO wallet_mints (wallet_address, serial, ounces, slvr, usd_text, usd_raw, eth_raw, minted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [walletAddress, serial, ounces, slvr, usdText, usdRaw, ethRaw, mintedAt.toISOString()]
    );

    await client.query(
      `UPDATE serial_inventory
       SET is_allocated = TRUE, allocated_wallet = $2, allocated_at = NOW(), updated_at = NOW()
       WHERE serial = $1`,
      [serial, walletAddress]
    );
    await client.query("COMMIT");

    return res.status(201).json({
      ok: true,
      item: {
        serial,
        ounces: ounces.toFixed(2),
        slvr: slvr.toFixed(0),
        usd: usdText,
        usdRaw,
        ethRaw,
        ts: mintedAt.toISOString(),
      },
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // no-op
    }
    return res.status(500).json({ error: "Failed to save mint" });
  } finally {
    client.release();
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
