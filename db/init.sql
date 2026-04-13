CREATE TABLE IF NOT EXISTS wallet_mints (
  id BIGSERIAL PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  serial TEXT NOT NULL,
  ounces NUMERIC(12,4) NOT NULL,
  slvr NUMERIC(20,4) NOT NULL,
  usd_text TEXT,
  usd_raw NUMERIC(20,8),
  eth_raw NUMERIC(20,12),
  minted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wallet_serial_unique UNIQUE (wallet_address, serial)
);

CREATE INDEX IF NOT EXISTS idx_wallet_mints_wallet_created
  ON wallet_mints (wallet_address, created_at DESC);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS serial_inventory (
  serial TEXT PRIMARY KEY,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_allocated BOOLEAN NOT NULL DEFAULT FALSE,
  allocated_wallet TEXT,
  allocated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_users (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iter INTEGER NOT NULL,
  password_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_serial_inventory_available
  ON serial_inventory (is_active, is_allocated, serial);
