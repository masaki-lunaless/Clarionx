// Clarion backend — Cloudflare Worker
//
// 3ステップ構成：
//   1. 蓄積   /api/cases …        接客を溜め、なぜを聞き、回答を貯める
//   2. ロープレ /api/modes, /api/runs … 溜めたものから作ったモードで練習し、フィードバックを返す
//   3. 統合   /api/criteria …     複数の案件とフィードバックを束ねて判断基準にする
//
// APIキーの隠蔽と、STT→LLM→TTSの直列処理の集約もここが担う。

import { ApiError, EFFORT, MODELS, generateStructured, generateText } from './llm.js';
import { activeProvider, listVoices, synthesize, transcribe } from './audio.js';
import { ACCESSORIES, CONDITIONS, PRICE_PENALTY, drawItems, priceFor, pricePenalty, totalOf } from './items.js';
import { SEED_PRODUCTS } from './seed-products.js';
import {
  ROLE_LIST, hashPassword, hasRole, newSessionToken, normalizeCode,
  requireRole, sessionDays, sha256, timingSafeEqual,
} from './auth.js';
import * as db from './db.js';
import {
  CUSTOMER_TYPES,
  DIFFICULTIES,
  MOODS,
  SCENES,
  difficultyOf,
  moodOf,
  roleplayTurnRequest,
  typeOf,
  assessTranscriptRequest,
  criteriaRequest,
  fillQuestionsRequest,
  formatTranscriptRequest,
  glossaryBlock,
  followUpRequest,
  roleplaySystemPrompt,
  scoringRequest,
  turningPointsRequest,
  voiceDirection,
} from './prompts.js';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Whisper APIの上限
const MAX_TRANSCRIPT_CHARS = 60000;

// 採点の配点。成約は二値の固定ポイント、残りは判断基準に沿えなかった分の減点。
// 現場の重みに合わせて変えるのはこの2つだけでよい。
export const SCORING = {
  unclosedPenalty: 30, // 不成約なら引く点（成約していれば0）
  maxAxisPenalty: 70,  // 型の不一致で引ける上限。軸数で按分する
  // 品物が設定されている回だけ、上の70を「型50 + 査定額20」に分ける。
  // 品物のない回（従来の記録）は70のまま。過去の点数の意味を変えないため。
  axisPenaltyWithItem: 70 - PRICE_PENALTY.max,
};

/**
 * 減点法で総合点を出す。
 * AIには軸ごとの減点幅（0〜10）・成約の二値判定・提示額の抜き出しだけを任せ、
 * 合計はここで決める。採点のたびに配点が揺れないようにするため。
 */
export function computeTotal(score, items = null) {
  const list = [].concat(items || []).filter(Boolean);
  const axes = score.per_axis || [];
  const cap = axes.length * 10;
  const raw = axes.reduce((sum, a) => sum + Math.min(10, Math.max(0, Number(a.deduction) || 0)), 0);
  const maxAxis = list.length ? SCORING.axisPenaltyWithItem : SCORING.maxAxisPenalty;
  const axisPenalty = cap ? Math.round((raw / cap) * maxAxis) : 0;
  const closePenalty = score.closed ? 0 : SCORING.unclosedPenalty;
  // 複数点なら合計の幅と突き合わせる。点ごとに言われても最後は合計で見る
  const price = list.length ? pricePenalty(totalOf(list), score.offered_price) : null;
  const pricePen = price?.penalty || 0;
  return {
    ...score,
    total: Math.max(0, 100 - closePenalty - axisPenalty - pricePen),
    price: price ? { ...price, offered: score.offered_price ?? null, quote: score.offered_price_quote || '' } : null,
    breakdown: {
      closed: Boolean(score.closed),
      closePenalty,
      axisPenalty,
      maxAxisPenalty: maxAxis,
      pricePenalty: pricePen,
      maxPricePenalty: list.length ? PRICE_PENALTY.max : 0,
    },
  };
}

/**
 * 受講者に返してよい履歴。
 * 表情（mood）は残し、条件の達成状況（flags）は落とす。
 * 前者は対面なら見えているもの、後者は答えそのもの。
 */
export const visibleHistory = (history = []) =>
  history.map(({ flags, ...rest }) => rest);

/** 採点結果の条件idに、読める名前を付けて返す */
export function withFlagLabels(score, customerType) {
  const type = typeOf(customerType);
  if (!type?.flags?.length) return { ...score, flags: [] };
  return {
    ...score,
    flags: type.flags.map((f) => {
      const hit = (score.flags || []).find((x) => x.id === f.id);
      return { id: f.id, label: f.label, hint: f.hint, met: Boolean(hit?.met), evidence: hit?.evidence || '' };
    }),
    breaker: type.breaker,
    track: type.track,
  };
}

/**
 * 品物を受講者に見せてよいかを決める。
 * 練習中に正解額が見えたら訓練にならないので、採点が終わるまでは伏せる。
 * 伏せていること自体は返す（画面に「採点後に開示」と出せるように）。
 */
export function visibleItems(run) {
  const list = run?.items?.length ? run.items : [].concat(run?.item || []).filter(Boolean);
  if (!list.length) return [];
  if (!run.score) return [{ hidden: true }];
  return list;
}

/**
 * 商品マスタだけは会社・ナレッジ空間をまたいで1つにする。
 * 相場は店ごとに違うものではないし、会社ごとに100点ずつ入れ直すのは
 * 導入のたびに効いてくる手間になる。編集できるのは管理者のまま。
 */
const PRODUCTS = '*';

/* -------------------------------- 共通処理 -------------------------------- */

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : '';
  return {
    'access-control-allow-origin': allowOrigin || 'null',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-clarion-token',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(data, request, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(request, env) },
  });
}

/**
 * 認証。入口は2つある。
 *
 * 1. ログイン（会社コード＋共通パスワード＋個人コード）で得たセッショントークン
 * 2. 環境変数 ACCESS_TOKENS の共有トークン（移行前からの入口。管理者として通す）
 *
 * どちらも `x-clarion-token` で送る。返す auth は次の意味を持つ：
 *   client  … ナレッジ空間。案件・判断基準・モード・商品・用語はこの軸
 *   company … 会社コード。実施記録はこの軸で必ず分かれる
 *   staff   … 個人。受講者は自分の記録しか見られない
 */
async function authenticate(request, env) {
  const supplied = request.headers.get('x-clarion-token') || '';

  // 1. ログインセッション
  if (supplied.length === 64 && /^[0-9a-f]+$/.test(supplied)) {
    const row = await db.findSession(env, await sha256(supplied));
    if (row) {
      if (!row.staff_active || !row.company_active) throw new ApiError(401, 'このアカウントは停止されています');
      return {
        client: row.knowledge_space,
        company: row.company,
        companyName: row.company_name,
        staffId: row.staff_id,
        staffCode: row.staff_code,
        staffName: row.staff_name,
        store: row.store || '',
        role: row.role,
        admin: row.role === 'admin',
        via: 'login',
      };
    }
    // 64桁の16進が来てセッションに無い＝期限切れ。共有トークンとしては照合しない
    throw new ApiError(401, 'ログインの有効期限が切れています。もう一度ログインしてください');
  }

  // 2. 共有トークン（移行前からの入口）
  const raw = (env.ACCESS_TOKENS || '').trim();
  if (!raw) return legacyAuth('dev');
  if (!supplied) throw new ApiError(401, 'ログインが必要です');

  for (const entry of raw.split(',').map((t) => t.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    const name = idx === -1 ? 'client' : entry.slice(0, idx);
    const token = idx === -1 ? entry : entry.slice(idx + 1);
    if (token && timingSafeEqual(token, supplied)) return legacyAuth(name, isLegacyAdmin(env, supplied));
  }
  throw new ApiError(401, 'アクセストークンが違います');
}

/**
 * 共有トークンで入った場合。
 * ナレッジ空間と会社コードを同じラベルにするので、これまでのデータの見え方は変わらない。
 */
const legacyAuth = (label, admin = true) => ({
  client: label,
  company: label,
  companyName: label,
  staffId: '',
  staffCode: '',
  staffName: '',
  store: '',
  role: admin ? 'admin' : 'trainee',
  admin,
  via: 'token',
});

function requireAdmin(auth) {
  requireRole(auth, 'admin');
}

/**
 * 共有トークンのうち管理者にするもの。
 * ADMIN_TOKENS 未設定のあいだは全員が管理者＝フルオープン。
 */
function isLegacyAdmin(env, supplied) {
  const raw = (env.ADMIN_TOKENS || '').trim();
  if (!raw) return true;
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .some((token) => timingSafeEqual(token, supplied));
}

// 管理者を絞ると、統合（ステップ3）と削除とマスタ編集が管理者だけになる。
// ADMIN_TOKENS に入れるトークンは、ACCESS_TOKENS にも「同じラベル」で登録すること。
// ラベルが違うとデータの持ち主が別扱いになり、管理者から他の人のデータが見えなくなる。
//   例) ACCESS_TOKENS = "clarion:みんなの共有トークン,clarion:管理者トークン"
//       ADMIN_TOKENS  = "管理者トークン"

async function readBody(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('multipart/form-data')) {
    const form = await request.formData();
    const audio = form.get('audio');
    let payload = {};
    const raw = form.get('payload');
    if (typeof raw === 'string' && raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new ApiError(400, 'payloadのJSONが不正です');
      }
    }
    if (audio && typeof audio !== 'string') {
      if (audio.size > MAX_AUDIO_BYTES) throw new ApiError(413, '音声ファイルが大きすぎます（25MBまで）');
      payload.__audio = audio;
      payload.__filename = audio.name;
    }
    return payload;
  }
  if (!type.includes('application/json')) return {};
  return request.json().catch(() => {
    throw new ApiError(400, 'JSONが不正です');
  });
}

function requireString(value, name, max = MAX_TRANSCRIPT_CHARS) {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, `${name} が必要です`);
  if (value.length > max) throw new ApiError(413, `${name} が長すぎます（${max}文字まで）`);
  return value.trim();
}

/**
 * 音声は書き起こしたら破棄する。監視カメラ録音を保持しない方針のため保存はしない。
 * ブランド・用語マスタをWhisperに先渡しすると、固有名詞の認識精度が上がる。
 */
async function transcribeIfAudio(env, client, body) {
  if (!body.__audio) return '';
  const { text, dialect } = await db.getGlossary(env, client);
  const entries = db.parseGlossary(text);
  const names = entries.map((e) => e.canonical).join('、');
  // 方言の例文を先に置くと、Whisperがその調子を引き継いで標準語に直しにくくなる
  const prompt = [dialect, names, body.vocabulary].filter(Boolean).join('、');
  return transcribe(env, body.__audio, { prompt, filename: body.__filename });
}

function criteriaToMarkdown(doc) {
  const lines = [`# ${doc.title || '判断基準ドキュメント'}`, '', doc.summary || '', ''];
  for (const [i, axis] of (doc.axes || []).entries()) {
    lines.push(`## ${i + 1}. ${axis.name}`, '', axis.principle, '');
    if (axis.signals?.length) lines.push('**この合図が見えたら**', ...axis.signals.map((s) => `- ${s}`), '');
    if (axis.actions?.length) lines.push('**こうする**', ...axis.actions.map((s) => `- ${s}`), '');
    if (axis.ng?.length) lines.push('**やらない**', ...axis.ng.map((s) => `- ${s}`), '');
    if (axis.quotes?.length) lines.push('**本人の言葉**', ...axis.quotes.map((s) => `> ${s}`), '');
  }
  if (doc.gaps?.length) lines.push('## まだ聞けていないこと', '', ...doc.gaps.map((s) => `- ${s}`), '');
  return lines.join('\n');
}


/**
 * 商品マスタの貼り付けテキストを解釈する。
 * 1行 = カテゴリ / ブランド / 型番 / 商品名 / 新品価格 / 買取率% / 備考
 * Excelからの貼り付け（タブ区切り）とCSVの両方を受ける。
 *
 * 読めなかった行はそのまま返す。黙って0件になると、何が悪いのか分からない。
 */
export function parseProducts(text) {
  const rows = [];
  const bad = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // 区切りは行ごとに決める。Excelの貼り付けはタブで、金額に「1,450,000」とカンマが入るため、
    // タブがある行をカンマでも切ると金額が壊れる
    const cols = (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim());
    if (/^(カテゴリ|category)$/i.test(cols[0])) continue; // 見出し行
    const [category = '', brand = '', model = '', name = '', price = '', retention = '', notes = ''] = cols;
    const newPrice = Math.round(Number(String(price).replace(/[,，円¥￥\s]/g, ''))) || 0;
    const rate = Math.round(Number(String(retention).replace(/[%％\s]/g, ''))) || 30;
    if (!name || newPrice <= 0) {
      bad.push(line.slice(0, 80));
      continue;
    }
    rows.push({ category, brand, model, name, newPrice, retention: Math.min(500, Math.max(1, rate)), notes });
  }
  return { rows, bad };
}

/**
 * 実施記録を1件取る。
 * 会社が違えば見えない。受講者は自分の回しか触れない
 * （他人のロープレを続けたり、採点し直したりできないようにする）。
 */
async function findRun(env, auth, id) {
  const runs = await db.listRuns(env, auth.company, {
    staffId: hasRole(auth, 'trainer') ? undefined : auth.staffId || undefined,
  });
  const run = runs.find((r) => r.id === id);
  if (!run) throw new ApiError(404, '実施記録が見つかりません');
  return run;
}

/**
 * どの会社のスタッフを操作するか決める。
 *
 * 共有トークンで入った管理者（移行前からの入口）は、どの会社でも触れる。
 * 会社を作ってスタッフを配るのはこの立場の人なので、ここを塞ぐと初期設定ができない。
 * ログインで入った管理者は、自分の会社だけ。
 */
function targetCompany(auth, requested) {
  const want = String(requested || '').trim().toLowerCase();
  if (!want || want === auth.company) return auth.company;
  if (auth.via === 'token' && auth.admin) return want;
  throw new ApiError(403, '他の会社のスタッフは操作できません');
}

/** ログイン中の人の公開形。画面のタブ出し分けはこれを見て決める */
const meSummary = (auth) => ({
  company: auth.company,
  company_name: auth.companyName,
  knowledge_space: auth.client,
  staff_code: auth.staffCode,
  staff_name: auth.staffName,
  store: auth.store,
  role: auth.role,
  admin: auth.admin,
  via: auth.via,
  can: {
    capture: hasRole(auth, 'trainer'),   // ①蓄積
    merge: hasRole(auth, 'admin'),       // ③統合
    masters: hasRole(auth, 'admin'),     // 商品・用語マスタ
    allRecords: hasRole(auth, 'trainer'), // 他人の記録
  },
});

/* --------------------------------- ルート -------------------------------- */

const routes = [
  ['GET', '/api/health', async (_c) => ({ ok: true, service: 'clarion' })],

  [
    'GET',
    '/api/config',
    async ({ env, auth }) => ({
      customerTypes: CUSTOMER_TYPES.map(({ id, label, hint, track, scene, flags, breaker }) => ({
        id, label, hint, track, scene,
        // 条件の「中身」は教材づくりの材料。受講者にも見えるが、
        // 会話中にどれが立っているかは伏せてある（そちらが答え）
        flags: flags.map(({ id: fid, label: flabel }) => ({ id: fid, label: flabel })),
        breaker,
      })),
      scenes: Object.entries(SCENES).map(([id, sc]) => ({ id, label: sc.label })),
      difficulties: DIFFICULTIES.map(({ id, label, hint }) => ({ id, label, hint })),
      tracks: [
        { id: 'standard', label: '通常', hint: '買う／売ると決めに来ている客。条件が揃えば決める' },
        { id: 'reversal', label: '大逆転', hint: '売る気がない状態から始まる。条件が揃ったときだけ翻る' },
      ],
      moods: MOODS.map(({ id, label, face }) => ({ id, label, face })),
      voices: listVoices(env),
      stt: Boolean(env.OPENAI_API_KEY),
      tts: activeProvider(env),
      models: MODELS,
      client: auth.client,
      admin: auth.admin,
      feedbackOptions: FEEDBACK_OPTIONS,
      conditions: CONDITIONS.map(({ id, label, desc }) => ({ id, label, desc })),
      accessories: ACCESSORIES.map(({ id, label }) => ({ id, label })),
      productCount: await db.countProducts(env, PRODUCTS),
      me: meSummary(auth),
      roles: ROLE_LIST,
    }),
  ],

  /* --------------------------------- 認証 -------------------------------- */

  // 会社コード＋共通パスワード＋個人コード。3つ揃って初めて通す。
  // どれが違ったかは返さない（総当たりの手がかりを渡さないため）
  [
    'POST',
    '/api/login',
    async ({ env, body }) => {
      const companyCode = normalizeCode(body.company, '会社コード');
      const staffCode = normalizeCode(body.staffCode, '個人コード');
      const password = String(body.password || '');
      const deny = () => new ApiError(401, '会社コード・パスワード・個人コードのいずれかが違います');

      const company = await db.getCompany(env, companyCode);
      if (!company) throw deny();
      const { hash } = await hashPassword(password, company.pass_salt);
      if (!timingSafeEqual(hash, company.pass_hash)) throw deny();
      const staff = await db.getStaffByCode(env, companyCode, staffCode);
      if (!staff) throw deny();

      const token = newSessionToken();
      const expiresAt = new Date(Date.now() + sessionDays(env) * 86400000).toISOString();
      await db.createSession(env, {
        tokenHash: await sha256(token),
        company: companyCode,
        staffId: staff.id,
        expiresAt,
      });
      return {
        token,
        expiresAt,
        company: { code: company.code, name: company.name },
        staff: { code: staff.code, name: staff.name, role: staff.role, store: staff.store },
      };
    },
  ],

  [
    'POST',
    '/api/logout',
    async ({ env, request }) => {
      const supplied = request.headers.get('x-clarion-token') || '';
      if (supplied.length === 64) await db.deleteSession(env, await sha256(supplied));
      return { ok: true };
    },
  ],

  ['GET', '/api/me', async ({ auth }) => ({ me: meSummary(auth) })],

  /* ------------------------------ 会社の管理 ------------------------------ */

  ['GET', '/api/companies', async ({ env, auth }) => {
    requireAdmin(auth);
    return { companies: await db.listCompanies(env) };
  }],

  // 会社の作成とパスワード変更。knowledgeSpace を同じ値にした会社どうしは教材を共有する
  [
    'POST',
    '/api/companies',
    async ({ env, auth, body }) => {
      requireAdmin(auth);
      const code = normalizeCode(body.code, '会社コード');
      const name = requireString(body.name, 'name', 100);
      const password = String(body.password || '');
      if (password.length < 8) throw new ApiError(400, 'パスワードは8文字以上にしてください');
      const { hash, salt } = await hashPassword(password);
      await db.upsertCompany(env, {
        code,
        name,
        hash,
        salt,
        knowledgeSpace: String(body.knowledgeSpace || '').trim() || auth.client,
      });
      return { ok: true, code };
    },
  ],

  [
    'DELETE',
    '/api/companies/:code',
    async ({ env, auth, params }) => {
      requireAdmin(auth);
      if (params.code === auth.company) throw new ApiError(400, 'ログイン中の会社は削除できません');
      await db.deleteCompany(env, params.code);
      return { ok: true };
    },
  ],

  /* ---------------------------- スタッフの管理 ---------------------------- */

  ['GET', '/api/staff', async ({ env, auth, url }) => {
    requireAdmin(auth);
    const company = targetCompany(auth, url.searchParams.get('company'));
    return { staff: await db.listStaff(env, company), roles: ROLE_LIST, company };
  }],

  [
    'POST',
    '/api/staff',
    async ({ env, auth, body }) => {
      requireAdmin(auth);
      const code = normalizeCode(body.code, '個人コード');
      const name = requireString(body.name, 'name', 100);
      const role = ROLE_LIST.some((r) => r.id === body.role) ? body.role : 'trainee';
      const company = targetCompany(auth, body.company);
      if (!(await db.getCompany(env, company))) throw new ApiError(404, `会社「${company}」がありません。先に会社を登録してください`);
      return { staff: await db.createStaff(env, company, { code, name, role, store: body.store }) };
    },
  ],

  [
    'PATCH',
    '/api/staff/:id',
    async ({ env, auth, params, body }) => {
      requireAdmin(auth);
      const fields = {};
      if (body.name !== undefined) fields.name = String(body.name).slice(0, 100);
      if (body.store !== undefined) fields.store = String(body.store).slice(0, 100);
      if (body.active !== undefined) fields.active = Boolean(body.active);
      if (body.role !== undefined) {
        if (!ROLE_LIST.some((r) => r.id === body.role)) throw new ApiError(400, '権限の指定が不正です');
        fields.role = body.role;
      }
      await db.updateStaff(env, targetCompany(auth, body.company), params.id, fields);
      return { ok: true };
    },
  ],

  [
    'DELETE',
    '/api/staff/:id',
    async ({ env, auth, params, url }) => {
      requireAdmin(auth);
      if (params.id === auth.staffId) throw new ApiError(400, 'ログイン中の自分は削除できません');
      await db.deleteStaff(env, targetCompany(auth, url.searchParams.get('company')), params.id);
      return { ok: true };
    },
  ],

  /* ------------------------------ 1. 蓄積 ------------------------------- */
  // このブロック（/api/cases と /api/questions）は指導者以上に限定している。
  // 判定はルーター側（GATED）で一括してかけているので、各ルートには書いていない。
  // 実際の接客の書き起こしが入るため、受講者には開かない。

  ['GET', '/api/cases', async ({ env, auth }) => ({ cases: await db.listCases(env, auth.client) })],

  [
    'POST',
    '/api/cases',
    async ({ env, auth, body }) => {
      const transcript = String(body.transcript || '').trim();
      return {
        case: await db.createCase(env, auth.client, { ...body, transcript, source: 'text' }),
      };
    },
  ],

  ['GET', '/api/cases/:id', async ({ env, auth, params }) => ({ case: await db.getCase(env, auth.client, params.id) })],

  [
    'PATCH',
    '/api/cases/:id',
    async ({ env, auth, params, body }) => ({ case: await db.updateCase(env, auth.client, params.id, body) }),
  ],

  [
    'DELETE',
    '/api/cases/:id',
    async ({ env, auth, params }) => {
      requireAdmin(auth); // 回答ごと消えるため
      await db.deleteCase(env, auth.client, params.id);
      return { ok: true };
    },
  ],

  // ブランド・用語マスタ（クライアント全体で共有）
  ['GET', '/api/glossary', async ({ env, auth }) => db.getGlossary(env, auth.client)],

  [
    'POST',
    '/api/glossary',
    async ({ env, auth, body }) => {
      requireAdmin(auth); // 全員に効くので管理者限定にできるようにしておく
      await db.saveGlossary(env, auth.client, { text: body.text, dialect: body.dialect });
      const entries = db.parseGlossary(body.text ?? (await db.getGlossary(env, auth.client)).text);
      return { ok: true, count: entries.length, variants: entries.reduce((n, e) => n + e.variants.length, 0) };
    },
  ],

  // 素材として使えるかを見立てる（50時間の録画から使える区間を選ぶため）
  [
    'POST',
    '/api/cases/:id/assess',
    async ({ env, auth, params }) => {
      const target = await db.getCase(env, auth.client, params.id);
      const transcript = requireString(target.transcript, '書き起こし');
      const out = await generateStructured(env, {
        ...assessTranscriptRequest({ transcript }),
        model: MODELS.chat,
        maxTokens: 1500,
        effort: EFFORT.scoring,
        label: 'assess',
      });
      await db.updateCase(env, auth.client, params.id, { assessment: JSON.stringify(out) });
      return { assessment: out };
    },
  ],

  // 書き起こしに話者と句読点を入れる
  [
    'POST',
    '/api/cases/:id/format',
    async ({ env, auth, params }) => {
      const target = await db.getCase(env, auth.client, params.id);
      const transcript = requireString(target.transcript, '書き起こし');
      const cfg = await db.getGlossary(env, auth.client);
      const formatted = await generateText(env, {
        ...formatTranscriptRequest({
          transcript,
          context: contextOf(target),
          glossary: db.parseGlossary(cfg.text),
          dialect: cfg.dialect,
        }),
        model: MODELS.chat,
        maxTokens: 16000,
        effort: EFFORT.analysis,
        label: 'format',
      });
      const body = stripPreamble(formatted);
      if (!body) throw new ApiError(502, '整形できませんでした');
      return { case: await db.updateCase(env, auth.client, params.id, { transcript: body }) };
    },
  ],

  // 転換点を検出して質問を作り、案件に追記する
  [
    'POST',
    '/api/cases/:id/detect',
    async ({ env, auth, params }) => {
      const target = await db.getCase(env, auth.client, params.id);
      const transcript = requireString(target.transcript, '書き起こし');
      const req = turningPointsRequest({ transcript, context: contextOf(target) });
      const out = await generateStructured(env, { ...req, model: MODELS.analysis, maxTokens: 6000, effort: EFFORT.analysis, label: 'detect' });
      let points = (out.turning_points || []).filter((p) => p && p.quote);

      // スキーマのrequiredは厳密には強制されないため、questionsが欠けることがある。
      // 転換点自体は使えるので、欠けた分だけ埋め直す（全体をやり直すより速く安い）。
      const missing = points.filter((p) => !(p.questions || []).length);
      if (missing.length) {
        console.warn(`questions missing for ${missing.length}/${points.length} turning points; repairing`);
        try {
          const repair = await generateStructured(env, {
            ...fillQuestionsRequest({ transcript, points: missing }),
            model: MODELS.analysis,
            maxTokens: 3000,
            effort: EFFORT.analysis,
            label: 'detect-repair',
          });
          for (const item of repair.items || []) {
            const t = missing[item.index];
            if (t && (item.questions || []).length) t.questions = item.questions;
          }
        } catch (err) {
          console.warn('question repair failed', err?.message || err);
        }
      }

      points = points.filter((p) => (p.questions || []).length);
      if (!points.length) throw new ApiError(502, '転換点を抽出できませんでした。書き起こしを確認してください');
      await db.addTurningPoints(env, params.id, points);
      return { case: await db.getCase(env, auth.client, params.id), added: points.length };
    },
  ],

  [
    'PATCH',
    '/api/questions/:id',
    async ({ env, auth, params, body }) => {
      await db.saveAnswer(env, auth.client, params.id, String(body.answer ?? '').slice(0, 8000));
      return { ok: true };
    },
  ],

  // もう一段掘る
  [
    'POST',
    '/api/questions/:id/follow-up',
    async ({ env, auth, params, body }) => {
      const question = requireString(body.question, 'question', 4000);
      const answer = requireString(body.answer, 'answer', 8000);
      await db.saveAnswer(env, auth.client, params.id, answer);
      const req = followUpRequest({ question, answer, quote: body.quote });
      const out = await generateStructured(env, { ...req, model: MODELS.analysis, maxTokens: 1000, effort: EFFORT.followUp, label: 'follow-up' });
      const questions = out.enough ? [] : out.questions || [];
      if (questions.length) await db.insertFollowUps(env, params.id, questions);
      return { enough: Boolean(out.enough), reason: out.reason || '', added: questions };
    },
  ],

  /* ------------------------------ 3. 統合 ------------------------------- */

  ['GET', '/api/criteria', async ({ env, auth }) => ({ criteria: await db.listCriteria(env, auth.client, auth.company) })],

  // 判断基準の本文はエースのやり方そのもの。指導者以上に限る
  ['GET', '/api/criteria/:id', async ({ env, auth, params }) => {
    requireRole(auth, 'trainer');
    return { criteria: await db.getCriteria(env, auth.client, params.id) };
  }],

  // 統合の材料になるフィードバック（次の統合に食わせる）
  [
    'GET',
    '/api/criteria/:id/feedback',
    async ({ env, auth, params }) => ({ feedback: await db.feedbackForCriteria(env, auth.company, [params.id]) }),
  ],

  [
    'POST',
    '/api/criteria',
    async ({ env, auth, body }) => {
      requireAdmin(auth);
      const caseIds = Array.isArray(body.caseIds) ? body.caseIds.filter(Boolean) : [];
      if (!caseIds.length) throw new ApiError(400, '統合する案件を1件以上選んでください');

      const qa = await db.answeredQA(env, auth.client, caseIds);
      if (!qa.length) throw new ApiError(400, '選んだ案件に回答済みのQ&Aがありません');

      // 前回までのロープレで「的外れ」と評価された点や自由記述を、統合の補足として渡す
      const fbIds = Array.isArray(body.feedbackCriteriaIds) ? body.feedbackCriteriaIds.filter(Boolean) : [];
      const feedback = fbIds.length ? await db.feedbackForCriteria(env, auth.company, fbIds) : [];
      const notes = [body.notes, formatFeedbackNotes(feedback)].filter(Boolean).join('\n\n');

      const req = criteriaRequest({
        qa: qa.map((r) => ({ question: r.question, answer: r.answer, quote: r.quote })),
        notes,
      });
      const doc = await generateStructured(env, { ...req, model: MODELS.analysis, maxTokens: 8000, effort: EFFORT.analysis, label: 'merge' });

      return {
        criteria: await db.createCriteria(env, auth.client, {
          title: doc.title || '判断基準ドキュメント',
          summary: doc.summary || '',
          markdown: criteriaToMarkdown(doc),
          caseIds,
          qaCount: qa.length,
        }),
        usedFeedback: feedback.length,
      };
    },
  ],

  [
    'PATCH',
    '/api/criteria/:id',
    async ({ env, auth, params, body }) => {
      requireAdmin(auth);
      await db.updateCriteria(env, auth.client, params.id, requireString(body.markdown, 'markdown'));
      return { ok: true };
    },
  ],

  [
    'DELETE',
    '/api/criteria/:id',
    async ({ env, auth, params }) => {
      requireAdmin(auth);
      await db.deleteCriteria(env, auth.client, params.id);
      return { ok: true };
    },
  ],


  /* ------------------------------ 商品マスタ ----------------------------- */

  [
    'GET',
    '/api/products',
    async ({ env, auth }) => {
      const products = await db.listProducts(env, PRODUCTS);
      const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];
      // 受講者も開始前に品物を選べるが、相場は渡さない。
      // 現場でも品物は目の前にあり、分からないのは「いくらで買うか」のほう
      if (!hasRole(auth, 'trainer')) {
        return {
          products: products.map(({ id, category, brand, model, name }) => ({ id, category, brand, model, name })),
          categories,
        };
      }
      return { products, categories };
    },
  ],

  // 正解額の試算。管理コンソールの確認用。
  // 計算式を画面側に写すと本番とずれるので、同じ関数をここから呼ぶ
  [
    'GET',
    '/api/products/:id/quote',
    async ({ env, auth, params, url }) => {
      requireRole(auth, 'trainer');
      const product = await db.getProduct(env, PRODUCTS, params.id);
      const condition = CONDITIONS.find((c) => c.id === url.searchParams.get('condition')) || CONDITIONS[1];
      const accessory = ACCESSORIES.find((a) => a.id === url.searchParams.get('accessory')) || ACCESSORIES[1];
      return {
        product: { name: product.name, brand: product.brand, new_price: product.new_price, retention: product.retention },
        condition: { id: condition.id, label: condition.label, ratio: condition.ratio },
        accessory: { id: accessory.id, label: accessory.label, ratio: accessory.ratio },
        ...priceFor(product, condition, accessory),
      };
    },
  ],

  // 1件ずつ足す。総入れ替えはしない
  [
    'POST',
    '/api/products',
    async ({ env, auth, body }) => {
      requireAdmin(auth);
      const name = requireString(body.name, '商品名', 200);
      const newPrice = Math.round(Number(body.newPrice)) || 0;
      if (newPrice <= 0) throw new ApiError(400, '新品価格を入れてください');
      return {
        product: await db.createProduct(env, PRODUCTS, {
          category: String(body.category || '').slice(0, 60),
          brand: String(body.brand || '').slice(0, 100),
          model: String(body.model || '').slice(0, 100),
          name,
          newPrice,
          retention: Math.min(500, Math.max(1, Math.round(Number(body.retention)) || 30)),
          notes: String(body.notes || '').slice(0, 500),
        }),
      };
    },
  ],

  [
    'PATCH',
    '/api/products/:id',
    async ({ env, auth, params, body }) => {
      requireAdmin(auth);
      const fields = {};
      for (const k of ['category', 'brand', 'model', 'name', 'notes']) {
        if (body[k] !== undefined) fields[k] = String(body[k]).slice(0, 500);
      }
      if (body.newPrice !== undefined) fields.newPrice = Math.max(0, Math.round(Number(body.newPrice)) || 0);
      if (body.retention !== undefined) {
        fields.retention = Math.min(500, Math.max(1, Math.round(Number(body.retention)) || 30));
      }
      if (body.active !== undefined) fields.active = Boolean(body.active);
      return { product: await db.updateProduct(env, PRODUCTS, params.id, fields) };
    },
  ],

  [
    'DELETE',
    '/api/products/:id',
    async ({ env, auth, params }) => {
      requireAdmin(auth);
      await db.deleteProduct(env, PRODUCTS, params.id);
      return { ok: true };
    },
  ],

  // 貼り付けたテキストから足す。既存は消さない
  [
    'POST',
    '/api/products/import',
    async ({ env, auth, body }) => {
      requireAdmin(auth);
      const { rows, bad } = parseProducts(body.text || '');
      if (!rows.length) {
        throw new ApiError(
          400,
          '読み取れる行がありませんでした。1行1件で、タブ区切り（Excelからの貼り付け）かカンマ区切りにしてください',
          bad.slice(0, 3),
        );
      }
      return { ...(await db.addProducts(env, PRODUCTS, rows)), bad: bad.slice(0, 20) };
    },
  ],

  // 初期データ。すでにある商品は飛ばして足す
  [
    'POST',
    '/api/products/seed',
    async ({ env, auth }) => {
      requireAdmin(auth);
      const rows = SEED_PRODUCTS.map(([category, brand, model, name, newPrice, retention, notes]) => ({
        category, brand, model, name, newPrice, retention, notes,
      }));
      return db.addProducts(env, PRODUCTS, rows);
    },
  ],

  /* ----------------------------- 2. ロープレ ---------------------------- */

  ['GET', '/api/modes', async ({ env, auth }) => ({
    modes: (await db.listModes(env, auth.client, auth.company)).map((m) => modeSummary(m, { admin: auth.admin })),
  })],

  [
    'POST',
    '/api/modes',
    async ({ env, auth, body }) => {
      // モードは教材。作れるのは管理者だけ（③の統合と同じ扱い）
      requireAdmin(auth);
      const name = requireString(body.name, 'name', 200);
      const criteriaId = requireString(body.criteriaId, 'criteriaId', 100);
      await db.getCriteria(env, auth.client, criteriaId); // 存在確認
      const customerType = requireString(body.customerType, 'customerType', 100);
      const mode = await db.createMode(env, auth.client, {
        name,
        criteriaId,
        customerType,
        scenario: body.scenario,
        voice: body.voice,
        productCategory: String(body.productCategory || '').trim(),
      });
      // 持ち込む品物。複数点を付けられる（バッグと財布、など）
      const ids = [...new Set((body.productIds || []).map((x) => String(x)))].slice(0, 10);
      if (ids.length) await db.setModeProducts(env, PRODUCTS, mode.id, ids);
      return { mode: modeSummary(mode, { admin: auth.admin }), products: await db.listModeProducts(env, mode.id) };
    },
  ],


  // シナリオに付ける品物の付け外し
  [
    'GET',
    '/api/modes/:id/products',
    async ({ env, auth, params }) => {
      requireRole(auth, 'trainer');
      await db.getMode(env, auth.client, params.id); // 持ち主の確認
      return { products: await db.listModeProducts(env, params.id) };
    },
  ],

  [
    'POST',
    '/api/modes/:id/products',
    async ({ env, auth, params, body }) => {
      requireAdmin(auth);
      await db.getMode(env, auth.client, params.id);
      const ids = [...new Set((body.productIds || []).map((x) => String(x)))].slice(0, 10);
      return { products: await db.setModeProducts(env, PRODUCTS, params.id, ids) };
    },
  ],

  [
    'DELETE',
    '/api/modes/:id',
    async ({ env, auth, params }) => {
      requireAdmin(auth);
      await db.deleteMode(env, auth.client, params.id);
      return { ok: true };
    },
  ],

  // 記録。会社をまたいでは見えない。受講者はさらに自分の分だけになる
  ['GET', '/api/runs', async ({ env, auth, url }) => ({
    runs: (
      await db.listRuns(env, auth.company, {
        criteriaId: url.searchParams.get('criteriaId') || undefined,
        staffId: hasRole(auth, 'trainer') ? undefined : auth.staffId || undefined,
      })
    ).map((r) => ({ ...r, items: visibleItems(r), history: r.score ? r.history : visibleHistory(r.history) })),
    scope: hasRole(auth, 'trainer') ? 'company' : 'self',
  })],

  // 開始：客に第一声を言わせるところまで
  [
    'POST',
    '/api/runs',
    async ({ env, auth, body }) => {
      const mode = await db.getMode(env, auth.client, requireString(body.modeId, 'modeId', 100));

      // 開始前にシチュエーションを変えられる。変えた内容はその回だけに効く。
      // 採点も変えた後の客タイプで行うので、モードではなく回のほうに持たせる
      const customerType = CUSTOMER_TYPES.some((t) => t.id === body.customerType) ? body.customerType : null;
      const scenario = body.scenario === undefined ? null : String(body.scenario).slice(0, 2000);
      const picked = [...new Set((body.productIds || []).map((x) => String(x)))].slice(0, 10);
      const difficulty = DIFFICULTIES.some((d) => d.id === body.difficulty) ? body.difficulty : 'normal';
      const effective = {
        ...mode,
        customer_type: customerType || mode.customer_type,
        scenario: scenario === null ? mode.scenario : scenario,
        difficulty,
      };

      // 品物はここで引き、状態と正解額まで固めて run に保存する。
      // 会話の途中で作ると毎ターン変わってしまうため、開始時に一度だけ決める。
      //
      // シナリオに品物が付いていればそれを全部（「バッグと財布」のような持ち込み）。
      // 付いていなければカテゴリから1点を引く。マスタが空なら品物なしで動かす。
      let items = [];
      // 開始前に選び直していればそれを、無ければシナリオに付いているものを
      const attached = picked.length
        ? (await db.listProducts(env, PRODUCTS)).filter((p) => picked.includes(p.id))
        : await db.listModeProducts(env, mode.id);
      if (attached.length) {
        items = drawItems(attached, difficultyOf(difficulty).tolerance);
      } else if (await db.countProducts(env, PRODUCTS)) {
        // 現場では1人が複数点を持ってくる。カテゴリを絞らなければまたいで引く
        const count = Math.min(3, Math.max(1, Math.round(Number(body.itemCount)) || 1));
        items = drawItems(
          await db.drawProducts(env, PRODUCTS, { category: body.category || mode.product_category, count }),
          difficultyOf(difficulty).tolerance,
        );
      }

      const runId = await db.createRun(env, auth.company, {
        modeId: mode.id,
        criteriaId: mode.criteria_id,
        // ログインしていれば実施者は個人コードから決まる。手入力に頼らない
        trainee: (auth.staffName || String(body.trainee || '')).slice(0, 100),
        staffId: auth.staffId,
        store: auth.store,
        items,
        customerType,
        scenario,
        difficulty,
      });
      const { dialect } = await db.getGlossary(env, auth.client);
      const turn = await speakAsCustomer(env, effective, [], { opening: true, dialect, items });
      const history = [{ role: 'customer', text: turn.replyText, mood: turn.mood, flags: turn.flags }];
      await db.saveRun(env, auth.company, runId, { history });
      // item も flags も返さない。正解が見えたら訓練にならない。
      // 表情（mood）だけは返す。対面なら見えているものなので、音声だけの都合で奪わない
      return {
        runId, mode: modeSummary(effective), history: visibleHistory(history),
        itemCount: items.length, replyText: turn.replyText, audioUrl: turn.audioUrl,
        mood: turn.mood, face: turn.face,
      };
    },
  ],

  // 1ターン：音声 → Whisper → Claude → TTS
  [
    'POST',
    '/api/runs/:id/turn',
    async ({ env, auth, params, body }) => {
      const run = await findRun(env, auth, params.id);
      const stored = await db.getMode(env, auth.client, run.mode_id);
      // 開始前に変えたシチュエーションは、最後まで効かせる
      const mode = { ...stored, customer_type: run.customer_type || stored.customer_type,
                     scenario: run.scenario ?? stored.scenario, difficulty: run.difficulty };

      let text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) text = await transcribeIfAudio(env, auth.client, body);
      if (!text) throw new ApiError(400, '発話（音声またはテキスト）が必要です');

      // 「間」の計測値。ブラウザ側で測ったものをそのまま持つ。
      // 読み上げが鳴り終わってから店員が口を開くまでが gap、開始からの経過が at。
      const t = body.timing || {};
      const sec = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 10) / 10 : null);
      const history = [
        ...run.history,
        { role: 'trainee', text, at: sec(t.at), gap: sec(t.gap) },
      ];
      const { dialect } = await db.getGlossary(env, auth.client);
      const turn = await speakAsCustomer(env, mode, history, { dialect, items: run.items });
      history.push({ role: 'customer', text: turn.replyText, mood: turn.mood, flags: turn.flags });
      await db.saveRun(env, auth.company, params.id, { history });
      return {
        transcript: text, history: visibleHistory(history),
        replyText: turn.replyText, audioUrl: turn.audioUrl, mood: turn.mood, face: turn.face,
      };
    },
  ],

  [
    'POST',
    '/api/runs/:id/score',
    async ({ env, auth, params }) => {
      const run = await findRun(env, auth, params.id);
      if (!run.history.length) throw new ApiError(400, '会話がありません');
      const criteria = await db.getCriteria(env, auth.client, run.criteria_id);
      const mode = run.mode_id ? await db.getMode(env, auth.client, run.mode_id).catch(() => null) : null;
      const state = stateOf(run.history);
      const req = scoringRequest({
        history: run.history,
        criteria: criteria.markdown,
        customerType: run.customer_type || mode?.customer_type,
        items: run.items,
        flagsMet: state.everMet,
      });
      const raw = await generateStructured(env, { ...req, model: MODELS.analysis, maxTokens: 4000, effort: EFFORT.scoring, label: 'score' });
      const score = withFlagLabels(computeTotal(raw, run.items), run.customer_type || mode?.customer_type);
      await db.saveRun(env, auth.company, params.id, { score });
      // 採点が済んだので、ここで初めて品物・正解額・条件の到達状況を返す
      return { score, items: run.items };
    },
  ],

  // フィードバック：客の再現度と採点の納得感を別々に受ける
  [
    'PATCH',
    '/api/runs/:id/feedback',
    async ({ env, auth, params, body }) => {
      await findRun(env, auth, params.id); // 他人の回に書けないようにする
      await db.saveFeedback(env, auth.company, params.id, {
        realism: body.realism,
        scoring: body.scoring,
        note: body.note,
      });
      return { ok: true };
    },
  ],

  // 単体TTS（読み上げのやり直し用）
  [
    'POST',
    '/api/tts',
    async ({ env, body }) => {
      const text = requireString(body.text, 'text', 3000);
      const audioUrl = await synthesize(env, text, {
        voice: body.voice,
        speed: body.speed,
        ...voiceDirection(body.customerType),
      });
      return { audioUrl };
    },
  ],
];

export const FEEDBACK_OPTIONS = {
  realism: [
    { value: 'real', label: '現場にいそうな客だった' },
    { value: 'mostly', label: 'だいたい現実的' },
    { value: 'off', label: '少しずれている' },
    { value: 'wrong', label: '的外れ' },
  ],
  scoring: [
    { value: 'agree', label: '納得できる採点' },
    { value: 'mostly', label: 'だいたい納得' },
    { value: 'off', label: '少しずれている' },
    { value: 'wrong', label: '的外れ' },
  ],
};

const labelOf = (kind, value) => FEEDBACK_OPTIONS[kind].find((o) => o.value === value)?.label || value || '未評価';

/** ロープレのフィードバックを、統合プロンプトに渡せる文章にする */
function formatFeedbackNotes(feedback) {
  if (!feedback.length) return '';
  const lines = feedback.map((f) => {
    const head = `- [${f.mode_name || 'モード不明'}] 客の再現度:${labelOf('realism', f.fb_realism)} / 採点:${labelOf('scoring', f.fb_scoring)}`;
    return f.fb_note ? `${head}\n  現場のコメント：${f.fb_note}` : head;
  });
  return `【前回までのロープレに対する現場からのフィードバック】
以下は、この判断基準で練習した人・見た人の評価です。「少しずれている」「的外れ」と言われた点や、
現場のコメントで指摘された内容は、判断基準の書き方が実態と合っていない可能性があります。
統合の際に反映してください。
${lines.join('\n')}`;
}

const contextOf = (c) => [c.ace_name && `対象者：${c.ace_name}`, c.context].filter(Boolean).join('\n');

/**
 * モードの公開形。
 * criteria_markdown は客役への指示なので返さない。
 * product_id と品物名も返さない。どの品物が出るか分かると、事前に相場を調べられてしまう。
 * カテゴリだけは場面設定の一部なので返す。
 */
const modeSummary = (m, { admin = false } = {}) => ({
  id: m.id,
  name: m.name,
  criteria_id: m.criteria_id,
  criteria_title: m.criteria_title,
  customer_type: m.customer_type,
  scenario: m.scenario,
  voice: m.voice,
  product_category: m.product_category || '',
  // 何点持ち込むかは出すが、何を持ち込むかは出さない（それが答えになる）
  attached_count: m.attached_count ?? 0,
  run_count: m.run_count ?? 0,
});

/**
 * 客のセリフに混じったト書きを落とす。
 * プロンプトで禁止しているが完全には守られず、残ると音声でそのまま読み上げられてしまう。
 */
/**
 * 整形結果の前置きを落とす。
 * 「以下、整理しました」のような説明が付いてくることがあり、そのまま書き起こしに残ってしまう。
 * 最初の話者ラベルより前を捨てる。
 */
export function stripPreamble(text) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((l) => /^\s*(店員|客\d?|\?)\s*[：:]/.test(l));
  return (start === -1 ? lines : lines.slice(start)).join('\n').trim();
}

export function stripStageDirections(text) {
  const cleaned = String(text || '')
    .replace(/\*[^*]*\*/g, '')   // *両手でカウンターに置きながら*
    .replace(/（[^）]*）/g, '')    // （うなずいて）
    .replace(/\([^)]*\)/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 全部がト書きだった場合は元の文を返す（無音になるより読み上げたほうがまし）
  return cleaned || String(text || '').trim();
}

/**
 * 会話の履歴から、いまの心境と達成済みの条件を取り出す。
 * 条件は禁じ手で外れることがあるので、「最後のターンの状態」を現在地とする。
 * 一度でも立ったかどうかは everMet で別に数える（採点の材料になる）。
 */
export function stateOf(history = []) {
  const last = [...history].reverse().find((m) => m.role === 'customer');
  const ever = new Set();
  for (const m of history) for (const id of m.flags || []) ever.add(id);
  return {
    mood: last?.mood || null,
    flagsMet: last?.flags || [],
    everMet: [...ever],
  };
}

/**
 * 客役の1発話を作り、読み上げ音声まで用意する。
 *
 * セリフと一緒に心境と条件の達成状況を返させ、次のターンと読み上げの演技に渡す。
 * これが無いと、不満客は20ターン目でも1ターン目と同じ声のままになる。
 */
async function speakAsCustomer(env, mode, history, { opening, dialect, items }) {
  const messages = history.map((m) => ({
    role: m.role === 'trainee' ? 'user' : 'assistant',
    content: String(m.text || '').slice(0, 4000),
  }));
  if (opening) messages.push({ role: 'user', content: '（お客様が来店しました。あなたから最初の一言をどうぞ）' });

  const type = typeOf(mode.customer_type);
  const state = stateOf(history);
  const system = roleplaySystemPrompt({
    customerType: mode.customer_type,
    scenario: mode.scenario,
    criteria: mode.criteria_markdown,
    dialect,
    items,
    mood: state.mood || type?.opening,
    flagsMet: state.flagsMet,
    difficulty: mode.difficulty,
  });

  let out;
  try {
    out = await generateStructured(env, {
      ...roleplayTurnRequest({ system, messages: messages.slice(-40) }),
      model: MODELS.chat,
      maxTokens: 600,
      temperature: 1,
      effort: EFFORT.chat,
      cacheSystem: true,
      label: 'turn',
    });
    // セリフが取れなかったら構造化は失敗扱い。会話を落とすより素のテキストで続ける
    if (!out?.reply?.trim()) throw new ApiError(502, '客役の発話が空でした');
  } catch (err) {
    // 構造化に失敗しても会話は止めない。心境は直前のまま据え置く
    console.warn('turn: structured failed, falling back', err?.message || err);
    const raw = await generateText(env, {
      model: MODELS.chat, system, messages: messages.slice(-40),
      maxTokens: 400, temperature: 1, effort: EFFORT.chat, cacheSystem: true, label: 'turn',
    });
    out = { reply: raw, mood: state.mood, flags_met: state.flagsMet };
  }

  const replyText = stripStageDirections(out.reply);
  const known = new Set((type?.flags || []).map((f) => f.id));
  const flags = (out.flags_met || []).filter((id) => known.has(id));
  const mood = MOODS.some((m) => m.id === out.mood) ? out.mood : state.mood || type?.opening;
  const direction = voiceDirection(mode.customer_type, mood);

  const audioUrl = await synthesize(env, replyText, {
    voice: mode.voice || undefined,
    ...direction,
  });
  return { replyText, audioUrl, mood, flags, face: moodOf(mood).face };
}

/* -------------------------------- ルーター ------------------------------- */

/** 指導者以上でないと触れないパス。①蓄積の一式 */
const GATED_TRAINER = /^\/api\/(cases|questions)(\/|$)/;


function match(method, pathname) {
  const parts = pathname.replace(/\/$/, '').split('/').filter(Boolean);
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const segs = pattern.split('/').filter(Boolean);
    if (segs.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].startsWith(':')) params[segs[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (segs[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const label = `${request.method} ${url.pathname}`;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const route = match(request.method, url.pathname);
    if (!route) return json({ error: 'Not found', path: url.pathname }, request, env, 404);

    try {
      const auth =
        url.pathname === '/api/health' || url.pathname === '/api/login'
          ? legacyAuth('anon', false)
          : await authenticate(request, env);
      // ①蓄積は指導者以上。実際の接客の中身なので受講者には開かない。
      // 個々のルートに散らすと足し忘れるため、ここで一度だけ判定する
      if (GATED_TRAINER.test(url.pathname)) requireRole(auth, 'trainer');
      const body = request.method === 'GET' || request.method === 'DELETE' ? {} : await readBody(request);
      const result = await route.handler({ env, auth, body, params: route.params, url, request });
      return json(result, request, env);
    } catch (err) {
      if (err instanceof ApiError) {
        console.warn(`[${label}] ${err.status} ${err.message}`, err.detail || '');
        return json({ error: err.message, detail: err.detail }, request, env, err.status);
      }
      console.error(`[${label}] unhandled`, err?.stack || err);
      return json({ error: 'サーバー内部エラー' }, request, env, 500);
    }
  },
};
