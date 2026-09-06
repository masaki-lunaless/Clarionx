-- 2026-09 追加分だけの差分。schema.sql は初回作成用で、ALTER が二重に走るため本番には流せない。
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY, client TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '', brand TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL, new_price INTEGER NOT NULL DEFAULT 0, retention INTEGER NOT NULL DEFAULT 30,
  notes TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_client ON products (client, category, brand);

ALTER TABLE modes ADD COLUMN product_id TEXT REFERENCES products (id) ON DELETE SET NULL;
ALTER TABLE modes ADD COLUMN product_category TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN item TEXT;

CREATE TABLE IF NOT EXISTS companies (
  code TEXT PRIMARY KEY, name TEXT NOT NULL,
  pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, knowledge_space TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY, company TEXT NOT NULL REFERENCES companies (code) ON DELETE CASCADE,
  code TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'trainee',
  store TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_code ON staff (company, code);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, company TEXT NOT NULL, staff_id TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

ALTER TABLE runs ADD COLUMN staff_id TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN store TEXT NOT NULL DEFAULT '';
