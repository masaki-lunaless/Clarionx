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

-- 商品マスタ（後から追加）。ロープレで扱う品物を、AIの想像ではなく実在の型番から出す。
-- 相場は「新品時の実勢価格」と「美品での買取率」の2つだけ持ち、
-- その場の状態（ランク・付属品）に応じた正解額は Worker 側で計算する。
-- 採点のたびに正解が揺れないよう、この計算はAIに任せない。
CREATE TABLE IF NOT EXISTS products (
  id         TEXT PRIMARY KEY,
  client     TEXT NOT NULL,               -- ナレッジ空間。case/criteria と同じ軸
  category   TEXT NOT NULL DEFAULT '',    -- 腕時計・バッグ・ジュエリー など
  brand      TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',    -- 型番
  name       TEXT NOT NULL,
  new_price  INTEGER NOT NULL DEFAULT 0,  -- 新品時の実勢価格（円）
  retention  INTEGER NOT NULL DEFAULT 30, -- 美品(A)での買取率（%）。商材ごとに大きく違う
  notes      TEXT NOT NULL DEFAULT '',    -- 真贋・状態の見どころ。客役の口から出る材料になる
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_client ON products (client, category, brand);

-- モードに品物の指定を持たせる。
-- product_id を入れると毎回その品物。空なら category の中から実施ごとに引く。
ALTER TABLE modes ADD COLUMN product_id TEXT REFERENCES products (id) ON DELETE SET NULL;
ALTER TABLE modes ADD COLUMN product_category TEXT NOT NULL DEFAULT '';

-- 実施ごとに引いた品物と、その場の状態・正解額を固定して持つ。
-- 受講者には採点が終わるまで返さない（index.js の hideProduct）。
ALTER TABLE runs ADD COLUMN item TEXT;

-- 権限（後から追加）。会社コード＋共通パスワード＋個人コードで入る。
--
-- ナレッジ（案件・判断基準・モード・商品・用語）は knowledge_space で共有できるが、
-- 実施記録（runs）は会社コードで必ず分かれる。2社で同じ教材を使いつつ、
-- 互いのログは見えないようにするための分け方。
CREATE TABLE IF NOT EXISTS companies (
  code            TEXT PRIMARY KEY,           -- 会社コード（ログインで入力する）
  name            TEXT NOT NULL,
  pass_hash       TEXT NOT NULL,              -- PBKDF2-SHA256
  pass_salt       TEXT NOT NULL,
  knowledge_space TEXT NOT NULL,              -- ナレッジを読む先。同じ値の会社は教材を共有する
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- 個人コード。表示と編集の範囲はここの role で決まる。
--   admin   … 全部（統合・マスタ編集・スタッフ管理・自社の全記録）
--   trainer … 蓄積とインタビュー、自社の全記録。統合とマスタ編集は不可
--   trainee … ロープレと自分の記録だけ
CREATE TABLE IF NOT EXISTS staff (
  id         TEXT PRIMARY KEY,
  company    TEXT NOT NULL REFERENCES companies (code) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'trainee',
  store      TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_code ON staff (company, code);

-- ログインセッション。token はハッシュで持つ（漏れても再利用できないように）
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  company    TEXT NOT NULL,
  staff_id   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

-- 誰がやった記録かを持つ。trainee は自分の分しか見られない
ALTER TABLE runs ADD COLUMN staff_id TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN store TEXT NOT NULL DEFAULT '';

-- シナリオに商品を複数ひも付ける（後から追加）。
-- 現場では1人が「バッグと財布」のように複数点を持ってくる。
CREATE TABLE IF NOT EXISTS mode_products (
  mode_id    TEXT NOT NULL REFERENCES modes (id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mode_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_mode_products ON mode_products (mode_id, seq);

ALTER TABLE runs ADD COLUMN items TEXT;

-- 開始前にシチュエーションを変えられるようにする（後から追加）。
-- モードの既定をその回かぎり上書きする。採点も上書き後の客タイプで行う。
ALTER TABLE runs ADD COLUMN customer_type TEXT;
ALTER TABLE runs ADD COLUMN scenario TEXT;
ALTER TABLE runs ADD COLUMN difficulty TEXT NOT NULL DEFAULT 'normal';
-- 商品マスタは client = '*' の1本に統一する（会社・ナレッジ空間をまたいで共通）

-- 課題の割り当て（後から追加）。管理者が「誰にどのモードを」を決める。
CREATE TABLE IF NOT EXISTS assignments (
  id         TEXT PRIMARY KEY,
  company    TEXT NOT NULL,
  staff_id   TEXT,
  mode_id    TEXT NOT NULL REFERENCES modes (id) ON DELETE CASCADE,
  difficulty TEXT NOT NULL DEFAULT 'normal',
  note       TEXT NOT NULL DEFAULT '',
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assign_company ON assignments (company, active);
CREATE INDEX IF NOT EXISTS idx_assign_staff ON assignments (staff_id);
ALTER TABLE modes ADD COLUMN item_count INTEGER NOT NULL DEFAULT 1;
