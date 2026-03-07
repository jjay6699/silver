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
