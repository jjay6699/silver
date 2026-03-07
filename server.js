require("dotenv").config();
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

async function initDb() {
  const sqlPath = path.join(__dirname, "db", "init.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await pool.query(sql);
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
