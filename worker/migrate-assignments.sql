-- 課題の割り当て。
--
-- シチュエーションを受講者本人に選ばせると、やさしい設定と知っている品物を
-- 選べてしまい訓練にならない。管理者が「誰にどのモードを」を決める形にする。
--
-- staff_id が空なら会社の全員向け。難易度は人によって変えたいので割り当て側に持つ。
CREATE TABLE IF NOT EXISTS assignments (
  id         TEXT PRIMARY KEY,
  company    TEXT NOT NULL,
  staff_id   TEXT,                                  -- NULL = 会社の全員
  mode_id    TEXT NOT NULL REFERENCES modes (id) ON DELETE CASCADE,
  difficulty TEXT NOT NULL DEFAULT 'normal',
  note       TEXT NOT NULL DEFAULT '',              -- 「ここを意識して」
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assign_company ON assignments (company, active);
CREATE INDEX IF NOT EXISTS idx_assign_staff ON assignments (staff_id);

-- 品物を引く点数はシナリオの一部なのでモード側に持つ
ALTER TABLE modes ADD COLUMN item_count INTEGER NOT NULL DEFAULT 1;

-- いまあるモードは、全社の全員向けとして引き継ぐ（いきなり誰も練習できなくならないように）
INSERT INTO assignments (id, company, staff_id, mode_id, difficulty, note, active, created_at)
SELECT lower(hex(randomblob(8))), c.code, NULL, m.id, 'normal', '', 1, datetime('now')
  FROM companies c CROSS JOIN modes m
 WHERE NOT EXISTS (
   SELECT 1 FROM assignments a WHERE a.company = c.code AND a.mode_id = m.id AND a.staff_id IS NULL
 );
