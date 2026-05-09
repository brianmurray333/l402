-- L402 Apps Supabase Schema
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)

-- ══════════════════════════════════════
-- 1. Apps directory
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  description TEXT,
  image TEXT,
  icon TEXT,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ══════════════════════════════════════
-- 2. API endpoints directory
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS apis (
  id TEXT PRIMARY KEY,
  provider TEXT,
  name TEXT NOT NULL,
  method TEXT DEFAULT 'GET',
  endpoint TEXT NOT NULL,
  docs_url TEXT,
  description TEXT,
  cost INT,
  cost_type TEXT DEFAULT 'variable',
  direction TEXT DEFAULT 'charges',
  icon TEXT,
  verified BOOLEAN DEFAULT false,
  verified_at TIMESTAMPTZ,
  featured BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ══════════════════════════════════════
-- 3. App submissions (user-submitted apps)
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS app_submissions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  image TEXT,
  icon TEXT,
  status TEXT DEFAULT 'pending',
  payment_hash TEXT,
  submitted_at TIMESTAMPTZ DEFAULT now()
);

-- ══════════════════════════════════════
-- 4. API submissions (user-submitted APIs)
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS api_submissions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  provider TEXT,
  name TEXT NOT NULL,
  method TEXT DEFAULT 'GET',
  endpoint TEXT NOT NULL,
  description TEXT,
  cost INT,
  cost_type TEXT DEFAULT 'variable',
  direction TEXT DEFAULT 'charges',
  icon TEXT,
  verified BOOLEAN DEFAULT false,
  verified_at TIMESTAMPTZ,
  reward_invoice TEXT,
  reward_paid BOOLEAN DEFAULT false,
  payment_hash TEXT,
  submitted_at TIMESTAMPTZ DEFAULT now()
);

-- ══════════════════════════════════════
-- 5. Boosts
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS boosts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('app', 'api')),
  amount_sats INT NOT NULL,
  payment_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_boosts_expires ON boosts (expires_at);

-- ══════════════════════════════════════
-- 6. Lottery rounds
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS lottery_rounds (
  id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  total_pot INT DEFAULT 0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'drawing', 'completed')),
  winner_address TEXT,
  winner_pubkey TEXT,
  winner_amount_contributed INT,
  winner_payout INT,
  winner_house_cut INT,
  winner_payout_status TEXT,
  winner_payout_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ══════════════════════════════════════
-- 7. Lottery entries
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS lottery_entries (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  round_id TEXT NOT NULL REFERENCES lottery_rounds(id),
  lightning_address TEXT,
  node_pubkey TEXT,
  amount_sats INT NOT NULL,
  payment_hash TEXT UNIQUE,
  paid_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lottery_entries_round ON lottery_entries (round_id);
CREATE INDEX IF NOT EXISTS idx_lottery_entries_payment ON lottery_entries (payment_hash);

-- ══════════════════════════════════════
-- 8. Million Sat Homepage — pixel blocks
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS pixel_blocks (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  width INTEGER NOT NULL CHECK (width >= 1),
  height INTEGER NOT NULL CHECK (height >= 1),
  color TEXT DEFAULT '#ff9900',
  image_data TEXT,
  link TEXT,
  title TEXT,
  payment_hash TEXT UNIQUE,
  amount_sats INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pixel_blocks_coords ON pixel_blocks (x, y);

-- ══════════════════════════════════════
-- 9. API submission IP rate events (serverless-safe throttling)
-- ══════════════════════════════════════
CREATE TABLE IF NOT EXISTS api_submission_rate_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_ip TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_sub_rate_ip_time ON api_submission_rate_events (client_ip, created_at DESC);

-- Pending pixel purchases (persists across serverless instance restarts)
CREATE TABLE IF NOT EXISTS pending_pixel_purchases (
  payment_hash TEXT PRIMARY KEY,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  color TEXT DEFAULT '#ff9900',
  image_data TEXT,
  link TEXT,
  title TEXT,
  amount_sats INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
