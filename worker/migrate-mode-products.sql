-- シナリオに商品を複数ひも付ける。
-- 「バッグと財布を持ち込んだ客」のように、現場では1人が複数点を持ってくる。
-- modes.product_id は1点しか持てなかったので、別表に出す。
CREATE TABLE IF NOT EXISTS mode_products (
  mode_id    TEXT NOT NULL REFERENCES modes (id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mode_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_mode_products ON mode_products (mode_id, seq);

-- 既存の1点指定を引き継ぐ
INSERT OR IGNORE INTO mode_products (mode_id, product_id, seq)
SELECT id, product_id, 0 FROM modes WHERE product_id IS NOT NULL AND product_id <> '';

-- 実施ごとに引いた品物は複数になる
ALTER TABLE runs ADD COLUMN items TEXT;
