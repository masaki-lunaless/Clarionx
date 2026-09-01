// Workerのルーティング・認証・LLM連携を、外部APIとD1をスタブして検証する。
// SQLの正しさはここでは見ない（本番D1に対する疎通で確認する）。
import worker, { stripStageDirections } from '../src/index.js';

/* ------------------------------- D1スタブ -------------------------------- */

// SQLの断片で分岐して固定の行を返す。DBの中身ではなく、Workerの分岐を検証するため。
const rows = {
  case: {
    id: 'case1',
    client: 'clientA',
    title: 'テスト案件',
    ace_name: '田中',
    context: '買取カウンター',
    transcript: '店員：いらっしゃいませ。\n客：これ、いくらですか。',
    created_at: '2026-09-01',
  },
  criteria: {
    id: 'crit1',
    client: 'clientA',
    title: '判断基準',
    markdown: '# 判断基準\n価格は聞かれてから。',
    source_case_ids: '["case1"]',
  },
  mode: {
    id: 'mode1',
    client: 'clientA',
    name: '迷い客モード',
    criteria_id: 'crit1',
    criteria_markdown: '# 判断基準',
    criteria_title: '判断基準',
    customer_type: 'complaint',
    scenario: '閉店前',
    voice: '',
  },
  run: {
    id: 'run1',
    client: 'clientA',
    mode_id: 'mode1',
    criteria_id: 'crit1',
    history: '[{"role":"customer","text":"すみません"},{"role":"trainee","text":"いらっしゃいませ"}]',
    score: null,
    fb_note: '',
  },
};

let sqlLog = [];
let missingRow = null; // '案件が見つかりません' 等を再現したいときにテーブル名を入れる

function stubDB() {
  const answer = (sql, kind) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    sqlLog.push(flat.slice(0, 80));
    const has = (s) => flat.includes(s); // SQLは改行で折り返してあるので正規化してから照合する
    if (kind === 'first') {
      if (has('FROM cases WHERE id')) return missingRow === 'cases' ? null : rows.case;
      if (has('FROM criteria WHERE id')) return missingRow === 'criteria' ? null : rows.criteria;
      if (has('FROM modes m JOIN criteria')) return missingRow === 'modes' ? null : rows.mode;
      if (has('FROM questions WHERE id')) return { id: 'q1', case_id: 'case1', turning_point_id: 'tp1', seq: 0 };
      if (has('COUNT(*) AS n')) return { n: 0 };
      return null;
    }
    if (kind === 'all') {
      if (has('FROM turning_points WHERE case_id')) return [];
      if (has('FROM questions WHERE case_id')) return [];
      if (has('FROM cases c')) return [rows.case];
      if (has('FROM criteria cr')) return [rows.criteria];
      if (has('FROM modes m JOIN')) return [rows.mode];
      if (has('FROM runs r LEFT JOIN modes')) {
        return has('fb_note') ? [{ id: 'run1', mode_name: '迷い客モード', fb_realism: 'wrong', fb_scoring: 'off', fb_note: '客がやけに素直すぎる' }] : [rows.run];
      }
      if (has('FROM questions q')) return [{ question: 'なぜですか', answer: '客の手元を見ていたので', quote: '引用' }];
      return [];
    }
    return { meta: { changes: 1 } };
  };

  const stmt = (sql) => ({
    bind: () => ({
      first: async () => answer(sql, 'first'),
      all: async () => ({ results: answer(sql, 'all') }),
      run: async () => answer(sql, 'run'),
    }),
    first: async () => answer(sql, 'first'),
    all: async () => ({ results: answer(sql, 'all') }),
    run: async () => answer(sql, 'run'),
  });
  return { prepare: stmt, batch: async (s) => s };
}

/* ------------------------------ 外部APIスタブ ----------------------------- */

const env = {
  DB: stubDB(),
  ANTHROPIC_API_KEY: 'test',
  OPENAI_API_KEY: 'test',
  AIVIS_API_KEY: 'test',
  AIVIS_MODEL_UUID: 'model-uuid-1',
  AIVIS_VOICES: 'model-uuid-1:あかり,model-uuid-2:健一',
  ACCESS_TOKENS: 'clientA:secret-token,clientB:other-token',
  ALLOWED_ORIGINS: 'https://example.github.io',
};

let lastTts = null;
let lastClaude = null;
let brokenTurningPoints = false;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('anthropic')) {
    const body = JSON.parse(init.body);
    lastClaude = body;
    if (body.tools) {
      const name = body.tools[0].name;
      const payload = {
        record_turning_points: brokenTurningPoints
          ? { turning_points: [{ quote: 'q1', label: 'l1', why: 'w1' }, { quote: 'q2', label: 'l2', why: 'w2', questions: ['x', 'y'] }] }
          : { turning_points: [{ quote: 'q', label: 'l', why: 'w', questions: ['a', 'b'] }] },
        record_questions: { items: [{ index: 0, questions: ['修復質問1', '修復質問2'] }] },
        record_criteria: {
          title: 'T',
          summary: 'S',
          axes: [{ name: 'A', principle: 'P', signals: ['s'], actions: ['a'], ng: ['n'], quotes: ['「原文」'] }],
          gaps: ['g'],
        },
        record_score: { total: 80, headline: 'h', per_axis: [], good: [], next: [] },
        record_follow_up: { enough: false, reason: 'まだ浅い', questions: ['もう一段の質問'] },
      }[name];
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', name, input: payload }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ちょっと見てるだけです。' }] }), { status: 200 });
  }
  if (u.includes('openai') && u.includes('/audio/speech')) {
    lastTts = { url: u, body: JSON.parse(init.body) };
    return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { status: 200 });
  }
  if (u.includes('openai')) return new Response(JSON.stringify({ text: 'こんにちは' }), { status: 200 });
  if (u.includes('aivis-project')) {
    lastTts = { url: u, body: JSON.parse(init.body), auth: init.headers.authorization };
    return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

/* --------------------------------- 実行 ---------------------------------- */

const H = { 'content-type': 'application/json', 'x-clarion-token': 'secret-token', origin: 'https://example.github.io' };
const call = (path, opts = {}, e = env) =>
  worker.fetch(new Request(`https://w.dev${path}`, { headers: H, ...opts }), e);
const post = (path, payload, e) => call(path, { method: 'POST', body: JSON.stringify(payload) }, e);

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' :: ' + extra}`);
  if (!cond) failed++;
};

// --- 認証・CORS ---
check('トークンなしは401', (await worker.fetch(new Request('https://w.dev/api/cases'), env)).status === 401);
check('誤トークンは401', (await worker.fetch(new Request('https://w.dev/api/cases', { headers: { 'x-clarion-token': 'wrong-token!!' } }), env)).status === 401);
check('healthは認証なしで200', (await worker.fetch(new Request('https://w.dev/api/health'), env)).status === 200);
const pre = await worker.fetch(new Request('https://w.dev/api/cases', { method: 'OPTIONS', headers: { origin: 'https://example.github.io' } }), env);
check('OPTIONSは204で許可オリジンを返す', pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://example.github.io');
const evil = await worker.fetch(new Request('https://w.dev/api/health', { headers: { origin: 'https://evil.example' } }), env);
check('未許可オリジンは弾く', evil.headers.get('access-control-allow-origin') === 'null');
check('未定義パスは404', (await call('/api/nope')).status === 404);

// --- config ---
const cfg = await (await call('/api/config')).json();
check('config: クライアント名を返す', cfg.client === 'clientA', cfg.client);
check('config: フィードバック選択肢を返す', cfg.feedbackOptions.realism.length === 4 && cfg.feedbackOptions.scoring.length === 4);
check('config: 既定はopenai', cfg.tts === 'openai', String(cfg.tts));
check('config: 演技指示は外に出さない', !JSON.stringify(cfg.customerTypes).includes('voice'));

// --- 1. 蓄積 ---
check('cases: 一覧', (await (await call('/api/cases')).json()).cases.length === 1);
const created = await (await post('/api/cases', { title: '新規', transcript: 'あ' })).json();
check('cases: 作成', created.case?.id === 'case1', JSON.stringify(created).slice(0, 120));

const detected = await (await post('/api/cases/case1/detect', {})).json();
check('detect: 転換点を追記', detected.added === 1, JSON.stringify(detected).slice(0, 150));
check('detect: 対象者を前提として渡す', lastClaude.messages[0].content.includes('対象者：田中'), lastClaude.messages[0].content.slice(0, 80));

brokenTurningPoints = true;
const repaired = await (await post('/api/cases/case1/detect', {})).json();
brokenTurningPoints = false;
check('detect: questions欠落を修復する', repaired.added === 2, JSON.stringify(repaired).slice(0, 150));

missingRow = 'cases';
check('detect: 無い案件は404', (await post('/api/cases/nope/detect', {})).status === 404);
missingRow = null;

check('answer: 保存できる', (await call('/api/questions/q1', { method: 'PATCH', body: JSON.stringify({ answer: 'そう思ったからです' }) })).status === 200);
const dug = await (await post('/api/questions/q1/follow-up', { question: 'なぜ', answer: 'なんとなく' })).json();
check('follow-up: 追加質問を返す', dug.added.length === 1 && dug.enough === false, JSON.stringify(dug));

// --- 3. 統合 ---
const merged = await (await post('/api/criteria', { caseIds: ['case1'] })).json();
check('criteria: 統合してmarkdown化', merged.criteria?.markdown?.includes('# '), JSON.stringify(merged).slice(0, 150));
check('criteria: 案件未選択は400', (await post('/api/criteria', { caseIds: [] })).status === 400);

// フィードバックを統合プロンプトに差し込む
const withFb = await (await post('/api/criteria', { caseIds: ['case1'], feedbackCriteriaIds: ['crit1'] })).json();
check('criteria: フィードバックを使う', withFb.usedFeedback === 1, String(withFb.usedFeedback));
check('criteria: 現場コメントがプロンプトに入る', lastClaude.messages[0].content.includes('客がやけに素直すぎる'), lastClaude.messages[0].content.slice(-200));

// 管理者限定（ADMIN_TOKENS を設定したとき）
const adminEnv = { ...env, ADMIN_TOKENS: 'admin-only-token' };
check('統合は管理者限定にできる', (await post('/api/criteria', { caseIds: ['case1'] }, adminEnv)).status === 403);
check('管理者トークンなら通る', (await worker.fetch(new Request('https://w.dev/api/criteria', { method: 'POST', headers: { ...H, 'x-clarion-token': 'admin-only-token' }, body: JSON.stringify({ caseIds: ['case1'] }) }), { ...adminEnv, ACCESS_TOKENS: 'clientA:admin-only-token' })).status === 200);
check('未設定ならフルオープン', (await (await call('/api/config')).json()).admin === true);

// --- 2. ロープレ ---
const modeList = await (await call('/api/modes')).json();
check('modes: 一覧', modeList.modes.length === 1, JSON.stringify(modeList).slice(0, 200));
const mode = await (await post('/api/modes', { name: 'm', criteriaId: 'crit1', customerType: 'complaint' })).json();
check('modes: 作成', mode.mode?.id === 'mode1', JSON.stringify(mode).slice(0, 120));
check('modes: 名前必須', (await post('/api/modes', { criteriaId: 'crit1', customerType: 'x' })).status === 400);

const started = await (await post('/api/runs', { modeId: 'mode1', trainee: '佐藤' })).json();
check('runs: 開始で客が第一声を言う', started.history?.[0]?.role === 'customer' && started.replyText.length > 0, JSON.stringify(started).slice(0, 150));
check('runs: 音声も返る', started.audioUrl?.startsWith('data:audio/mpeg;base64,'));
check('runs: 客タイプの演技指示を渡す', lastTts.body.instructions.includes('語気を強めて'), lastTts.body.instructions);

const turn = await (await post('/api/runs/run1/turn', { text: 'いらっしゃいませ' })).json();
check('turn: 履歴が伸びる', turn.history.length === 4 && turn.history[2].text === 'いらっしゃいませ', JSON.stringify(turn.history));
const form = new FormData();
form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' }), 'turn.mp4');
form.append('payload', JSON.stringify({}));
const audioTurn = await (await worker.fetch(new Request('https://w.dev/api/runs/run1/turn', { method: 'POST', headers: { 'x-clarion-token': 'secret-token' }, body: form }), env)).json();
check('turn: 音声からも受け付ける', audioTurn.transcript === 'こんにちは', JSON.stringify(audioTurn).slice(0, 120));

const scored = await (await post('/api/runs/run1/score', {})).json();
check('score: 採点結果を返す', scored.score.total === 80);

check('feedback: 保存できる', (await call('/api/runs/run1/feedback', { method: 'PATCH', body: JSON.stringify({ realism: 'off', scoring: 'agree', note: '客が素直すぎる' }) })).status === 200);
check('feedback: 不正な値は400', (await call('/api/runs/run1/feedback', { method: 'PATCH', body: JSON.stringify({ realism: 'とても良い' }) })).status === 400);

// --- ト書き除去（音声で読み上げられてしまうため） ---
check('ト書き: アスタリスクを落とす', stripStageDirections('*時計を置きながら*\n\nこれ、どう思います？') === 'これ、どう思います？', stripStageDirections('*時計を置きながら*\n\nこれ、どう思います？'));
check('ト書き: 全角カッコを落とす', stripStageDirections('（うなずいて）そうなんですよ。') === 'そうなんですよ。');
check('ト書き: 全部がト書きなら元文を返す', stripStageDirections('（沈黙）') === '（沈黙）');
check('ト書き: 通常文は変えない', stripStageDirections('これ、いくらになりますか。') === 'これ、いくらになりますか。');

// --- 障害時 ---
const prev = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).includes('/audio/speech') ? new Response('err', { status: 500 }) : prev(url, init));
const degraded = await (await post('/api/runs', { modeId: 'mode1' })).json();
check('TTS失敗でも会話は返る', degraded.replyText.length > 0 && degraded.audioUrl === null);
globalThis.fetch = prev;

globalThis.fetch = async () => new Response('overloaded', { status: 529 });
check('Claude障害は502で返す', (await post('/api/cases/case1/detect', {})).status === 502);
globalThis.fetch = prev;

console.log(failed ? `\n${failed} 件失敗` : '\nすべて通過');
process.exit(failed ? 1 : 0);
