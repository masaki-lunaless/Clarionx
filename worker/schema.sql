-- Clarion のデータモデル
--
-- 3つのステップに対応する：
--   1. 蓄積   … cases / turning_points / questions
--   2. ロープレ … modes / runs（フィードバック含む）
--   3. 統合   … criteria（複数のcaseを束ねて生成）
--
-- client列は ACCESS_TOKENS のラベル（clientA など）。将来クライアントごとに
-- データを分離するときの軸で、いまは全行に入るだけ。

-- 1. 蓄積 -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cases (
  id           TEXT PRIMARY KEY,
  client       TEXT NOT NULL,
  title        TEXT NOT NULL,
  ace_name     TEXT NOT NULL DEFAULT '',   -- 誰の接客か
  context      TEXT NOT NULL DEFAULT '',   -- 店舗・商材などの前提
  transcript   TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT 'text', -- 'audio' | 'text'
  occurred_on  TEXT NOT NULL DEFAULT '',   -- 接客があった日
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cases_client ON cases (client, created_at DESC);

CREATE TABLE IF NOT EXISTS turning_points (
  id       TEXT PRIMARY KEY,
  case_id  TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  label    TEXT NOT NULL DEFAULT '',
  quote    TEXT NOT NULL DEFAULT '',
  why      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tp_case ON turning_points (case_id, seq);

CREATE TABLE IF NOT EXISTS questions (
  id               TEXT PRIMARY KEY,
  turning_point_id TEXT NOT NULL REFERENCES turning_points (id) ON DELETE CASCADE,
  case_id          TEXT NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  seq              INTEGER NOT NULL,
  question         TEXT NOT NULL,
  answer           TEXT NOT NULL DEFAULT '',
  answered_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_q_tp ON questions (turning_point_id, seq);
CREATE INDEX IF NOT EXISTS idx_q_case ON questions (case_id);

-- 3. 統合 -------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS criteria (
  id              TEXT PRIMARY KEY,
  client          TEXT NOT NULL,
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '',
  markdown        TEXT NOT NULL,
  source_case_ids TEXT NOT NULL DEFAULT '[]',  -- JSON配列
  qa_count        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_criteria_client ON criteria (client, created_at DESC);

-- 2. ロープレ ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS modes (
  id            TEXT PRIMARY KEY,
  client        TEXT NOT NULL,
  name          TEXT NOT NULL,
  criteria_id   TEXT NOT NULL REFERENCES criteria (id) ON DELETE CASCADE,
  customer_type TEXT NOT NULL,
  scenario      TEXT NOT NULL DEFAULT '',
  voice         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_modes_client ON modes (client, created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  client      TEXT NOT NULL,
  mode_id     TEXT REFERENCES modes (id) ON DELETE SET NULL,
  criteria_id TEXT,
  trainee     TEXT NOT NULL DEFAULT '',
  history     TEXT NOT NULL DEFAULT '[]',  -- JSON
  score       TEXT,                        -- JSON
  -- フィードバック。3の統合で重み付け・除外の材料にする
  fb_realism  TEXT,  -- 客の再現度: real | mostly | off | wrong
  fb_scoring  TEXT,  -- 採点の納得感: agree | mostly | off | wrong
  fb_note     TEXT NOT NULL DEFAULT '',    -- 「自分ならこうする」など
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_client ON runs (client, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_criteria ON runs (criteria_id);

-- 素材の濃さ（後から追加）。判断が起きている場面が含まれているかの見立て。
-- 50時間の録画から、インタビューする価値のある区間を選ぶために使う。
ALTER TABLE cases ADD COLUMN assessment TEXT;

-- ブランド・用語マスタ（後から追加）。クライアントごとに1つ。
-- 「正式表記 = よくある誤り1, 誤り2」の行を並べたテキストで持つ。
-- Excelからの貼り付けで一気に入れられるよう、構造化せずテキストのまま置く。
CREATE TABLE IF NOT EXISTS glossary (
  client     TEXT PRIMARY KEY,
  text       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- 方言（後から追加）。標準語に直されると本人の言葉が失われるため、
-- 書き起こし・整形・ロープレの3箇所でこの指定を使う。
ALTER TABLE glossary ADD COLUMN dialect TEXT NOT NULL DEFAULT '';
