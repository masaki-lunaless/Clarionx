// Workerのルーティング・認証・LLM連携を、外部APIとD1をスタブして検証する。
// SQLの正しさはここでは見ない（本番D1に対する疎通で確認する）。
import worker, { SCORING, computeTotal, parseProducts, stateOf, stripPreamble, stripStageDirections, visibleHistory, visibleItems, withFlagLabels } from '../src/index.js';
import { drawItem, drawItems, priceFor, pricePenalty, totalOf, CONDITIONS, ACCESSORIES } from '../src/items.js';
import { hashPassword, hasRole, normalizeCode, sha256 } from '../src/auth.js';
import { SEED_PRODUCTS } from '../src/seed-products.js';
import { cleanTranscript } from '../src/audio.js';
import { parseGlossary } from '../src/db.js';
import { CUSTOMER_TYPES, DIFFICULTIES, MOODS, SCENES, conversationText, flagsNeeded, typeOf, glossaryBlock, roleplaySystemPrompt, scoringRequest, voiceDirection } from '../src/prompts.js';

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
    item: null,
    staff_id: 'staff-admin',
  },
  product: {
    id: 'prod1', client: 'clientA', category: '腕時計', brand: 'ロレックス',
    model: '126610LN', name: 'サブマリーナ デイト', new_price: 1450000, retention: 105,
    notes: '研磨歴を見る', active: 1,
  },
};

// ログイン系。パスワードのハッシュはテスト開始時に本物を計算して入れる
const auth = { company: null, staff: null, session: null };
let productCount = 1;
let attachedProducts = []; // シナリオにひも付いた商品

let sqlLog = [];
let missingRow = null; // '案件が見つかりません' 等を再現したいときにテーブル名を入れる

function stubDB() {
  const answer = (sql, kind) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    sqlLog.push(flat.slice(0, 300));
    const has = (s) => flat.includes(s); // SQLは改行で折り返してあるので正規化してから照合する
    if (kind === 'first') {
      if (has('FROM cases WHERE id')) return missingRow === 'cases' ? null : rows.case;
      if (has('FROM criteria WHERE id')) return missingRow === 'criteria' ? null : rows.criteria;
      if (has('FROM modes m JOIN criteria')) return missingRow === 'modes' ? null : rows.mode;
      if (has('FROM questions WHERE id')) return { id: 'q1', case_id: 'case1', turning_point_id: 'tp1', seq: 0 };
      if (has('FROM glossary WHERE client')) return { text: 'ヴァンドーム青山 = バンドーム', dialect: '関西弁。ほんま、なんぼ、〜やねん、おおきに' };
      if (has('FROM products WHERE id')) return rows.product;
      if (has('FROM companies WHERE code')) return auth.company;
      if (has('FROM staff WHERE company = ? AND code')) return auth.staff;
      if (has('FROM staff WHERE id')) return auth.staff;
      if (has('FROM sessions se JOIN staff')) return auth.session;
      if (has('COUNT(*) AS n')) return { n: productCount };
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
      if (has('FROM products WHERE')) return productCount ? [rows.product] : [];
      if (has('FROM mode_products mp JOIN products p')) return attachedProducts;
      if (has('FROM staff s WHERE s.company')) return [{ ...auth.staff, run_count: 0 }];
      if (has('FROM companies c ORDER BY')) return [{ code: 'clientA', name: 'A社', knowledge_space: 'shared' }];
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
// systemはキャッシュを効かせるため配列で送ることがある
const systemText = (body) => (Array.isArray(body?.system) ? body.system.map((b) => b.text).join('') : body?.system || '');
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
        record_score: { closed: true, closed_evidence: '「お願いします」', headline: 'h',
          per_axis: [{ axis: 'A', deduction: 2, evidence: 'e', advice: 'a' }],
          flags: [{ id: 'heard_out', met: true, evidence: '「最後まで聞きました」' }], good: [], next: [] },
        record_follow_up: { enough: false, reason: 'まだ浅い', questions: ['もう一段の質問'] },
        say: { reply: 'ちょっと見てるだけです。', mood: 'guarded', flags_met: [] },
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
check('管理者を絞ると案件削除も止まる', (await call('/api/cases/case1', { method: 'DELETE' }, adminEnv)).status === 403);
check('管理者を絞るとモード削除も止まる', (await call('/api/modes/mode1', { method: 'DELETE' }, adminEnv)).status === 403);
check('未設定なら削除できる', (await call('/api/cases/case1', { method: 'DELETE' })).status === 200);

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

// 期待値は配点の定数から導く（SCORINGを変えてもテストが壊れないように）
const { unclosedPenalty: UP, maxAxisPenalty: AP } = SCORING;
const expect = (closed, ratio) => 100 - (closed ? 0 : UP) - Math.round(ratio * AP);

const scored = await (await post('/api/runs/run1/score', {})).json();
check('score: 成約かつ減点2割', scored.score.total === expect(true, 0.2), JSON.stringify(scored.score.breakdown));

// --- 採点の計算（減点法） ---
check('採点: 型が完璧かつ成約で満点', computeTotal({ closed: true, per_axis: [{ deduction: 0 }, { deduction: 0 }] }).total === 100);
check(`採点: 不成約は固定${UP}点減`, computeTotal({ closed: false, per_axis: [{ deduction: 0 }] }).total === 100 - UP);
check(`採点: 型が全滅なら${AP}点減`, computeTotal({ closed: true, per_axis: [{ deduction: 10 }, { deduction: 10 }] }).total === 100 - AP);
check('採点: 最悪でも0で止まる', computeTotal({ closed: false, per_axis: [{ deduction: 10 }] }).total === Math.max(0, 100 - UP - AP));
check('採点: 軸数が違っても上限は同じ', computeTotal({ closed: true, per_axis: Array(9).fill({ deduction: 10 }) }).total === 100 - AP);
check('採点: 成約していれば成約分の減点はない', computeTotal({ closed: true, per_axis: [{ deduction: 10 }] }).breakdown.closePenalty === 0);
check('採点: 範囲外の減点は丸める', computeTotal({ closed: true, per_axis: [{ deduction: 99 }, { deduction: -5 }] }).total === expect(true, 0.5));

check('feedback: 保存できる', (await call('/api/runs/run1/feedback', { method: 'PATCH', body: JSON.stringify({ realism: 'off', scoring: 'agree', note: '客が素直すぎる' }) })).status === 200);
check('feedback: 不正な値は400', (await call('/api/runs/run1/feedback', { method: 'PATCH', body: JSON.stringify({ realism: 'とても良い' }) })).status === 400);

// --- 方言 ---
const dialectCfg = await (await call('/api/glossary')).json();
check('方言: マスタと一緒に返る', dialectCfg.dialect.includes('関西弁'), JSON.stringify(dialectCfg));
await post('/api/cases/case1/format', {});
check('方言: 整形プロンプトに載る', lastClaude.messages[0].content.includes('標準語に直さないでください'), lastClaude.messages[0].content.slice(-200));
check('方言: 整形の指示に方言保持がある', systemText(lastClaude).includes('方言を標準語に直さない'));
await post('/api/runs', { modeId: 'mode1' });
check('方言: 客も同じ言葉づかいで話す', systemText(lastClaude).includes('この地域の言葉で話す'), systemText(lastClaude).slice(0, 200));

// --- ブランド・用語マスタ ---
const gl = parseGlossary(`
# コメント行は無視される
ヴァンドーム青山 = バンドーム, バンドーム青山
スタージュエリー ＝ チェスタージュエリー、スタージュエリ
グッチ
`);
check('マスタ: 行数', gl.length === 3, JSON.stringify(gl));
check('マスタ: 誤りの一覧', gl[0].variants.join('/') === 'バンドーム/バンドーム青山', JSON.stringify(gl[0]));
check('マスタ: 全角の記号も受ける', gl[1].variants.length === 2, JSON.stringify(gl[1]));
check('マスタ: 誤りなしの行も登録できる', gl[2].canonical === 'グッチ' && gl[2].variants.length === 0);
check('マスタ: コメントと空行は無視', !JSON.stringify(gl).includes('コメント'));
const block = glossaryBlock(gl);
check('マスタ: プロンプトに正式表記が並ぶ', block.includes('ヴァンドーム青山、スタージュエリー、グッチ'), block.slice(0, 120));
check('マスタ: 誤り→正式の対応が載る', block.includes('バンドーム、バンドーム青山 → ヴァンドーム青山'));
check('マスタ: 空なら何も足さない', glossaryBlock([]) === '');

// --- 整形結果の前置き除去 ---
check('前置き: 説明行を落とす',
  stripPreamble('以下、整理しました。\n\n---\n\n店員：いらっしゃいませ\n客：どうも') === '店員：いらっしゃいませ\n客：どうも',
  JSON.stringify(stripPreamble('以下、整理しました。\n\n---\n\n店員：いらっしゃいませ\n客：どうも')));
check('前置き: 本文だけなら変えない', stripPreamble('店員：はい\n客：どうも') === '店員：はい\n客：どうも');
check('前置き: ?ラベルでも先頭と認識する', stripPreamble('整えました\n?：あの\n店員：はい') === '?：あの\n店員：はい');
check('前置き: ラベルが無ければそのまま返す', stripPreamble('ラベルなしの本文') === 'ラベルなしの本文');

// --- Whisperの誤出力の除去 ---
const 幻聴 = '本日はご覧いただきありがとうございます。 ご視聴ありがとうございました。 ご視聴ありがとうございました。 ご視聴ありがとうございました。';
check('幻聴: 定型文をすべて落とす', cleanTranscript(幻聴) === '', JSON.stringify(cleanTranscript(幻聴)));
check('幻聴: 接客の「ありがとうございました」は残す',
  cleanTranscript('本日はありがとうございました。またお越しください。') === '本日はありがとうございました。 またお越しください。',
  cleanTranscript('本日はありがとうございました。またお越しください。'));
check('幻聴: 連続する同一文は1つにまとめる',
  cleanTranscript('はい。はい。はい。いらっしゃいませ。') === 'はい。 いらっしゃいませ。',
  cleanTranscript('はい。はい。はい。いらっしゃいませ。'));
check('幻聴: 文の塊ごとの繰り返しをまとめる',
  cleanTranscript('いらっしゃいませ。本日はどうされましたか。お荷物拝見しますね。本日はどうされましたか。お荷物拝見しますね。')
    === 'いらっしゃいませ。 本日はどうされましたか。 お荷物拝見しますね。',
  cleanTranscript('いらっしゃいませ。本日はどうされましたか。お荷物拝見しますね。本日はどうされましたか。お荷物拝見しますね。'));
check('幻聴: 3回以上の塊の繰り返しもまとめる',
  cleanTranscript('あ。い。あ。い。あ。い。') === 'あ。 い。',
  cleanTranscript('あ。い。あ。い。あ。い。'));
check('幻聴: 似ているが違う塊は残す',
  cleanTranscript('はい、どうぞ。ありがとうございます。はい、どうも。ありがとうございます。')
    === 'はい、どうぞ。 ありがとうございます。 はい、どうも。 ありがとうございます。');
check('幻聴: 通常の会話は変えない',
  cleanTranscript('いらっしゃいませ。買取のご相談でしょうか。') === 'いらっしゃいませ。 買取のご相談でしょうか。');

// --- ト書き除去（音声で読み上げられてしまうため） ---
check('ト書き: アスタリスクを落とす', stripStageDirections('*時計を置きながら*\n\nこれ、どう思います？') === 'これ、どう思います？', stripStageDirections('*時計を置きながら*\n\nこれ、どう思います？'));
check('ト書き: 全角カッコを落とす', stripStageDirections('（うなずいて）そうなんですよ。') === 'そうなんですよ。');
check('ト書き: 全部がト書きなら元文を返す', stripStageDirections('（沈黙）') === '（沈黙）');
check('ト書き: 通常文は変えない', stripStageDirections('これ、いくらになりますか。') === 'これ、いくらになりますか。');

/* ============================ 商品マスタ ============================== */

check('商品: 初期データは100点以上', SEED_PRODUCTS.length >= 100, SEED_PRODUCTS.length);
check('商品: 初期データの列がそろっている',
  SEED_PRODUCTS.every((r) => r.length === 7 && r[3] && r[4] > 0 && r[5] > 0));

// 貼り付けの解釈。Excelはタブ、手打ちはカンマで来る
const parsedOut = parseProducts(
  'カテゴリ\tブランド\t型番\t商品名\t新品価格\t買取率\t備考\n' +
  '腕時計\tロレックス\t126610LN\tサブマリーナ\t1,450,000円\t105%\t風防を見る\n' +
  'バッグ,エルメス,,バーキン30,2300000,140,\n' +
  '# コメント行\n\n名前だけの行',
);
const parsed = parsedOut.rows;
// 画面で貼られたのはスペース区切りだった。黙って0件になると原因が分からない
check('商品: 読めなかった行を返す', parsedOut.bad.includes('名前だけの行'), JSON.stringify(parsedOut.bad));
const spaced = parseProducts('ハンドバッグ LOUIS VUITTON M60017 ジッピーウォレット ¥84,000 50%');
check('商品: スペース区切りは読めない行として返す',
  spaced.rows.length === 0 && spaced.bad.length === 1, JSON.stringify(spaced));
check('商品: タブ区切りの金額をカンマで割らない', parsed[0]?.newPrice === 1450000, JSON.stringify(parsed[0]));
check('商品: 買取率の%を外す', parsed[0]?.retention === 105);
check('商品: カンマ区切りも読む', parsed[1]?.name === 'バーキン30' && parsed[1]?.newPrice === 2300000);
check('商品: 見出し・コメント・不正行を捨てる', parsed.length === 2, parsed.length);

// 正解額。新品価格 × 買取率 × 状態 × 付属品
const good = CONDITIONS.find((c) => c.id === 'A');
const worst = CONDITIONS.find((c) => c.id === 'C');
const full = ACCESSORIES.find((a) => a.id === 'full');
const bare = ACCESSORIES.find((a) => a.id === 'none');
const pGood = priceFor(rows.product, good, full);
const pWorst = priceFor(rows.product, worst, bare);
check('相場: 状態が悪いほど安くなる', pWorst.fair < pGood.fair, `${pWorst.fair} < ${pGood.fair}`);
check('相場: 正解は幅で持つ', pGood.low < pGood.fair && pGood.fair < pGood.high);
check('相場: 買取率が高い商材は新品価格を超えうる', pGood.fair > rows.product.new_price, pGood.fair);

const item = drawItem(rows.product);
check('相場: 引いた品物に状態と正解額が入る',
  Boolean(item.condition_label && item.accessory_label && item.history && item.low && item.high));

check('査定: 範囲内なら減点なし', pricePenalty(item, item.fair).penalty === 0);
check('査定: 範囲の端も減点なし', pricePenalty(item, item.low).penalty === 0 && pricePenalty(item, item.high).penalty === 0);
check('査定: 少し外すと軽い減点', pricePenalty(item, item.fair * 0.82).penalty === 6, pricePenalty(item, item.fair * 0.82).penalty);
check('査定: 大きく外すと満額の減点', pricePenalty(item, item.fair * 0.4).penalty === 20);
check('査定: 高すぎも減点', pricePenalty(item, item.fair * 2).verdict === 'high');
// 「見せに来ただけ」の客では、額を出さないほうが正しい場面がある。出さなかったこと自体は罰さない
check('査定: 金額を出さなかった回は減点しない', pricePenalty(item, null).penalty === 0);

const withItem = computeTotal({ closed: true, per_axis: [{ deduction: 0 }], offered_price: item.fair }, [item]);
check('採点: 品物ありで満点', withItem.total === 100, withItem.total);
const missed = computeTotal({ closed: true, per_axis: [{ deduction: 0 }], offered_price: item.fair * 0.3 }, [item]);
check('採点: 査定額を大きく外すと20点引く', missed.total === 80, missed.total);
check('採点: 査定額の内訳を返す', missed.price?.verdict === 'low' && missed.breakdown.pricePenalty === 20);
// 品物のない従来の記録は、配点の意味を変えない
const noItem = computeTotal({ closed: false, per_axis: [{ deduction: 10 }] });
check('採点: 品物なしなら従来どおり型で70点', noItem.total === 0 && noItem.breakdown.maxAxisPenalty === 70);
check('採点: 品物ありなら型は50点に割る',
  computeTotal({ closed: true, per_axis: [{ deduction: 10 }], offered_price: null }, [item]).breakdown.maxAxisPenalty === 50);

/* --------- 複数点の持ち込み --------- */

const twoItems = drawItems([rows.product, { ...rows.product, id: 'p2', name: 'ジッピーウォレット', new_price: 84000, retention: 50 }]);
const sum = totalOf(twoItems);
check('複数点: 合計は各点の足し算', sum.fair === twoItems[0].fair + twoItems[1].fair, JSON.stringify(sum));
check('複数点: 合計の幅も足し算', sum.low === twoItems[0].low + twoItems[1].low);
// 店員は点ごとに言うこともまとめて言うこともある。採点は合計で見る
const twoFair = computeTotal({ closed: true, per_axis: [{ deduction: 0 }], offered_price: sum.fair }, twoItems);
check('複数点: 合計ど真ん中なら減点なし', twoFair.total === 100, twoFair.total);
const twoOff = computeTotal({ closed: true, per_axis: [{ deduction: 0 }], offered_price: sum.fair * 0.3 }, twoItems);
check('複数点: 合計を大きく外すと減点', twoOff.breakdown.pricePenalty === 20);
// 同じくらいの値段の2点なら、片方を飛ばせば合計から外れる
const evenPair = drawItems([rows.product, { ...rows.product, id: 'p3', name: 'GMTマスター' }]);
check('複数点: 同程度の2点で片方しか出さなければ外れる',
  computeTotal({ closed: true, per_axis: [{ deduction: 0 }], offered_price: evenPair[0].fair }, evenPair)
    .breakdown.pricePenalty > 0);
// 逆に、150万の時計に1万の財布なら、財布を忘れても合計の幅には収まる。
// 「片方を見落とした」は金額ではなく判断基準の軸で見るべきもの
const lopsided = drawItems([rows.product, { ...rows.product, id: 'p4', name: '財布', new_price: 13000, retention: 50 }]);
check('複数点: 金額差が大きければ小さい方の漏れは金額に出ない',
  computeTotal({ closed: true, per_axis: [{ deduction: 0 }], offered_price: lopsided[0].fair }, lopsided)
    .breakdown.pricePenalty === 0);
check('複数点: 空配列なら品物なし扱い',
  computeTotal({ closed: true, per_axis: [{ deduction: 0 }] }, []).breakdown.maxAxisPenalty === 70);

/* --------- シナリオに付けた品物をそのまま持ってくる --------- */

// 現場では1人が「バッグと財布」のように複数点を持ってくる。
// 付いていればそれを全部、付いていなければカテゴリから1点。
attachedProducts = [
  rows.product,
  { ...rows.product, id: 'p9', category: 'バッグ', brand: 'ルイ・ヴィトン', name: 'ジッピーウォレット', new_price: 84000, retention: 50 },
];
sqlLog = [];
const twoRun = await (await post('/api/runs', { modeId: 'mode1' })).json();
check('持ち込み: 付けた点数ぶん引く', twoRun.itemCount === 2, twoRun.itemCount);
check('持ち込み: ひも付けを見に行く', sqlLog.some((q) => q.includes('FROM mode_products mp')));
// 付いているならカテゴリからの抽選はしない
check('持ち込み: 付いていれば抽選しない', !sqlLog.some((q) => q.includes('FROM products WHERE client = ? AND category')));
check('持ち込み: 客役に2点とも渡る',
  systemText(lastClaude).includes('持ち込んだ品物（2点）') && systemText(lastClaude).includes('ジッピーウォレット'),
  systemText(lastClaude).slice(0, 60));
check('持ち込み: 2点すべてを持ってきていると伝える',
  systemText(lastClaude).includes('2点すべてを持ってきています'));

attachedProducts = [];
const oneRun = await (await post('/api/runs', { modeId: 'mode1' })).json();
check('持ち込み: 付いていなければ1点を引く', oneRun.itemCount === 1, oneRun.itemCount);

productCount = 0;
const noneRun = await (await post('/api/runs', { modeId: 'mode1' })).json();
check('持ち込み: マスタが空なら品物なしで動く', noneRun.itemCount === 0 && noneRun.replyText.length > 0);
productCount = 1;

/* --------- 難易度 --------- */

// 「3つ揃ったときだけ」は、もともと大逆転型のために現場から出してもらった条件。
// それを全型に被せた結果、普通の迷い客が大逆転と同じ硬さになっていた。
check('難易度: ふつうは2つで折れる', flagsNeeded(typeOf('undecided'), 'normal') === 2);
check('難易度: 本番は3つとも要る', flagsNeeded(typeOf('undecided'), 'hard') === 3);
check('難易度: 大逆転はやさしくしても3つ揃い',
  DIFFICULTIES.every((d) => flagsNeeded(typeOf('showoff'), d.id) === 3));
check('難易度: 知らない指定はふつうに落ちる', flagsNeeded(typeOf('undecided'), 'nosuch') === 2);

const easyPrompt = roleplaySystemPrompt({ customerType: 'undecided', difficulty: 'easy' });
check('難易度: 必要数をプロンプトに書く', easyPrompt.includes('3つのうち**2つ**が揃ったとき'), easyPrompt.slice(easyPrompt.indexOf('【あなたが折れる条件】'), easyPrompt.indexOf('【あなたが折れる条件】') + 90));
check('難易度: 本番は3つと書く',
  roleplaySystemPrompt({ customerType: 'undecided', difficulty: 'hard' }).includes('3つのうち**3つ**'));
// やさしいときは出だしから硬い客に当てない
check('難易度: やさしいと出だしが硬くない', easyPrompt.includes('【いまのあなたの心境】\nふつう'), easyPrompt.slice(easyPrompt.indexOf('【いまのあなたの心境】'), easyPrompt.indexOf('【いまのあなたの心境】') + 30));
check('難易度: ふつう以上は型の既定のまま',
  roleplaySystemPrompt({ customerType: 'undecided', difficulty: 'normal' }).includes('【いまのあなたの心境】\n硬い'));

// 金額を出すこと自体を禁じ手にしていた。買取では必ず出すので、毎回リセットされていた
check('禁じ手: 査定額を出すこと自体は禁じ手にしない',
  easyPrompt.includes('査定額を出されること自体は禁じ手ではありません'));
check('禁じ手: 迷い客の禁じ手から金額を外した',
  !typeOf('undecided').breaker.includes('金額'), typeOf('undecided').breaker);

// 査定額の許容幅も難易度で変わる
const wide = priceFor(rows.product, CONDITIONS[1], ACCESSORIES[1], 0.25);
const tight = priceFor(rows.product, CONDITIONS[1], ACCESSORIES[1], 0.12);
check('難易度: やさしいほど査定額の幅が広い', wide.high - wide.low > tight.high - tight.low);
check('難易度: 中心は変わらない', wide.fair === tight.fair);

/* --------- カテゴリをまたいだ持ち込み --------- */

// 現場では「バッグと指輪」のように、ジャンルの違うものをまとめて持ってくる
attachedProducts = [];
sqlLog = [];
const multi = await (await post('/api/runs', { modeId: 'mode1', itemCount: 3 })).json();
check('持ち込み: 点数を指定して引ける', multi.itemCount >= 1, multi.itemCount);
check('持ち込み: カテゴリを絞らなければ全体から引く',
  !sqlLog.some((q) => q.includes('FROM products') && q.includes('category = ?')),
  sqlLog.filter((q) => q.includes('FROM products')).join(' | ').slice(0, 140));
check('持ち込み: 点数は3点まで',
  (await (await post('/api/runs', { modeId: 'mode1', itemCount: 99 })).json()).itemCount <= 3);
check('持ち込み: 0や負数は1点に丸める',
  (await (await post('/api/runs', { modeId: 'mode1', itemCount: 0 })).json()).itemCount === 1);

/* --------- 商品マスタは全社共通 --------- */

// 会社ごとに100点ずつ入れ直すのは、導入のたびに効いてくる手間になる。
// ナレッジ空間が違っても同じマスタを見る。
sqlLog = [];
await call('/api/products');
const productSql = sqlLog.filter((q) => q.includes('FROM products'));
check('商品: ナレッジ空間ではなく共通キーで引く',
  productSql.length > 0 && !sqlLog.some((q) => q.includes("FROM products") && q.includes('clientA')),
  productSql.join(' | ').slice(0, 120));
// 別のナレッジ空間で入っても、見える商品は同じ
auth.session = {
  token_hash: 'x', company: 'other', staff_id: 'staff-9', staff_code: '9', staff_name: '別会社',
  role: 'admin', store: '', staff_active: 1, company_active: 1, company_name: 'B社', knowledge_space: 'another-space',
};
const otherProducts = await (
  await worker.fetch(new Request('https://w.dev/api/products', { headers: { ...H, 'x-clarion-token': 'a'.repeat(64) } }), env)
).json();
check('商品: 別のナレッジ空間でも同じマスタが見える', otherProducts.products.length === 1, otherProducts.products.length);
auth.session = null;

/* --------- 開始前にシチュエーションを変える --------- */

// モードの既定を、その回だけ差し替える。モードそのものは変えない。
attachedProducts = [];
const swapped = await (await post('/api/runs', {
  modeId: 'mode1', customerType: 'showoff', scenario: '閉店まぎわ', productIds: ['prod1'],
})).json();
check('差し替え: 変えた客タイプで始まる', swapped.mode.customer_type === 'showoff', swapped.mode.customer_type);
check('差し替え: 変えた場面設定が返る', swapped.mode.scenario === '閉店まぎわ');
check('差し替え: 変えた客タイプで客役が動く',
  systemText(lastClaude).includes('見せに来ただけ'), systemText(lastClaude).slice(0, 80));
check('差し替え: 選んだ品物を引く', swapped.itemCount === 1);
// 保存されるのは回のほう。モードは元のまま
check('差し替え: モード自体は変えない',
  (await (await call('/api/modes')).json()).modes[0].customer_type === 'complaint');

// 知らない客タイプは無視して、モードの既定に落ちる
const bogus = await (await post('/api/runs', { modeId: 'mode1', customerType: 'nosuch' })).json();
check('差し替え: 不正な客タイプは既定に落ちる', bogus.mode.customer_type === 'complaint', bogus.mode.customer_type);

/* --------- 受講者に正解を見せない --------- */

check('秘匿: 採点前の品物は伏せる', visibleItems({ items: [item], score: null })[0]?.hidden === true);
check('秘匿: 採点後は開示する', visibleItems({ items: [item], score: { total: 80 } })[0]?.brand === 'ロレックス');
check('秘匿: 品物なしなら空', visibleItems({ score: null }).length === 0);
// item は1点しか持てなかった頃の列。古い記録でも開ける
check('秘匿: 旧形式の1点記録も読める', visibleItems({ item, score: { total: 1 } })[0]?.brand === 'ロレックス');

const startedWithItem = await (await post('/api/runs', { modeId: 'mode1' })).json();
check('秘匿: 開始レスポンスに品物を含めない',
  startedWithItem.items === undefined && startedWithItem.item === undefined,
  JSON.stringify(Object.keys(startedWithItem)));
check('秘匿: 何点あるかだけ返す', typeof startedWithItem.itemCount === 'number', startedWithItem.itemCount);
const modesForItem = await (await call('/api/modes')).json();
check('秘匿: モードはカテゴリと点数だけ返す（品物名は出さない）',
  modesForItem.modes.every((m) => 'product_category' in m && 'attached_count' in m
    && m.product_name === undefined && m.product_id === undefined),
  JSON.stringify(modesForItem.modes[0]));
// 一覧に出す実施回数。落とすと画面が「実施undefined回」になる
check('モード: 実施回数を返す', modesForItem.modes.every((m) => typeof m.run_count === 'number'),
  JSON.stringify(modesForItem.modes[0]));

// 客役には品物が渡るが、正解額は渡らない
const customerPrompt = systemText(lastClaude);
check('客役: 品物が渡る', customerPrompt.includes('あなたが今日持ち込んだ品物'), customerPrompt.slice(0, 80));
check('客役: 相場を知らないと伝える', customerPrompt.includes('適正な買取額をあなたは知りません'));
check('客役: 正解額そのものは渡さない', !customerPrompt.includes('適正買取額は'));

const scoredRun = await (await post('/api/runs/run1/score', {})).json();
check('採点: 総合点が返る', typeof scoredRun.score?.total === 'number', JSON.stringify(scoredRun).slice(0, 120));

/* ============================== 権限 ================================= */

check('権限: 会社コードは英数字に正規化する', normalizeCode('Clarisse', 'x') === 'clarisse');
check('権限: 記号は弾く', (() => { try { normalizeCode('あ社', 'x'); return false; } catch { return true; } })());
check('権限: 1文字は弾く', (() => { try { normalizeCode('a', 'x'); return false; } catch { return true; } })());

const { hash, salt } = await hashPassword('correct-horse');
check('権限: 同じ塩なら同じハッシュ', (await hashPassword('correct-horse', salt)).hash === hash);
check('権限: 違うパスワードは違うハッシュ', (await hashPassword('wrong-horse', salt)).hash !== hash);
check('権限: 塩が違えばハッシュも違う', (await hashPassword('correct-horse')).hash !== hash);

check('権限: 管理者は指導者を兼ねる', hasRole({ role: 'admin' }, 'trainer') && hasRole({ role: 'admin' }, 'admin'));
check('権限: 指導者は統合できない', !hasRole({ role: 'trainer' }, 'admin') && hasRole({ role: 'trainer' }, 'trainer'));
check('権限: 受講者はロープレだけ', !hasRole({ role: 'trainee' }, 'trainer'));

/* --------- ログイン --------- */

auth.company = { code: 'clarisse', name: 'A社', pass_hash: hash, pass_salt: salt, knowledge_space: 'shared', active: 1 };
auth.staff = { id: 'staff-1', company: 'clarisse', code: '1001', name: '田中', role: 'trainee', store: '千葉店', active: 1 };

const login = (payload) => post('/api/login', payload);
const okLogin = await (await login({ company: 'clarisse', password: 'correct-horse', staffCode: '1001' })).json();
check('ログイン: 3つ揃えば通る', okLogin.token?.length === 64 && okLogin.staff.role === 'trainee', JSON.stringify(okLogin).slice(0, 120));
check('ログイン: 会社名と店舗を返す', okLogin.company.name === 'A社' && okLogin.staff.store === '千葉店');

const badPass = await login({ company: 'clarisse', password: 'wrong', staffCode: '1001' });
check('ログイン: パスワード違いは401', badPass.status === 401);
check('ログイン: どれが違うかは教えない',
  (await badPass.json()).error === '会社コード・パスワード・個人コードのいずれかが違います');

auth.staff = null;
check('ログイン: 個人コードが無ければ401',
  (await login({ company: 'clarisse', password: 'correct-horse', staffCode: '9999' })).status === 401);
auth.staff = { id: 'staff-1', company: 'clarisse', code: '1001', name: '田中', role: 'trainee', store: '千葉店', active: 1 };

auth.company = null;
check('ログイン: 会社が無ければ401',
  (await login({ company: 'nosuch', password: 'correct-horse', staffCode: '1001' })).status === 401);
auth.company = { code: 'clarisse', name: 'A社', pass_hash: hash, pass_salt: salt, knowledge_space: 'shared', active: 1 };

/* --------- セッションで入ったときの見え方 --------- */

const sessionToken = 'a'.repeat(64);
const asStaff = (role, extra = {}) => {
  auth.session = {
    token_hash: 'x', company: 'clarisse', staff_id: 'staff-1', staff_code: '1001', staff_name: '田中',
    role, store: '千葉店', staff_active: 1, company_active: 1, company_name: 'A社', knowledge_space: 'shared',
    ...extra,
  };
  return { ...H, 'x-clarion-token': sessionToken };
};

const asGet = (path, headers) => worker.fetch(new Request(`https://w.dev${path}`, { headers }), env);

check('受講者: ①蓄積は開かない', (await asGet('/api/cases', asStaff('trainee'))).status === 403);
check('指導者: ①蓄積は開く', (await asGet('/api/cases', asStaff('trainer'))).status === 200);
check('受講者: スタッフ管理は開かない', (await asGet('/api/staff', asStaff('trainee'))).status === 403);
check('指導者: スタッフ管理は開かない', (await asGet('/api/staff', asStaff('trainer'))).status === 403);
check('管理者: スタッフ管理が開く', (await asGet('/api/staff', asStaff('admin'))).status === 200);

const meTrainee = await (await asGet('/api/me', asStaff('trainee'))).json();
check('受講者: できることの一覧が正しい',
  meTrainee.me.can.capture === false && meTrainee.me.can.merge === false && meTrainee.me.can.allRecords === false,
  JSON.stringify(meTrainee.me.can));
check('受講者: 所属が返る', meTrainee.me.company === 'clarisse' && meTrainee.me.store === '千葉店');

const meTrainer = await (await asGet('/api/me', asStaff('trainer'))).json();
check('指導者: 蓄積と全記録は見られるが統合はできない',
  meTrainer.me.can.capture && meTrainer.me.can.allRecords && !meTrainer.me.can.merge);

// 記録の絞り込み。受講者は自分の staff_id で絞ったSQLになる
sqlLog = [];
const traineeRuns = await (await asGet('/api/runs', asStaff('trainee'))).json();
check('記録: 受講者は自分の分だけ', traineeRuns.scope === 'self');
check('記録: 受講者の問い合わせは staff_id で絞る',
  sqlLog.some((q) => q.includes('r.staff_id = ?')), sqlLog.join(' | ').slice(0, 200));
sqlLog = [];
const trainerRuns = await (await asGet('/api/runs', asStaff('trainer'))).json();
check('記録: 指導者は会社の全員分', trainerRuns.scope === 'company');
check('記録: 会社コードで必ず絞る', sqlLog.some((q) => q.includes('r.client = ?')));

// 期限切れセッション。共有トークンとして照合し直したりはしない
auth.session = null;
check('セッション: 切れていれば401',
  (await asGet('/api/me', { ...H, 'x-clarion-token': sessionToken })).status === 401);

// 停止したスタッフ
auth.session = {
  token_hash: 'x', company: 'clarisse', staff_id: 'staff-1', staff_code: '1001', staff_name: '田中',
  role: 'admin', store: '', staff_active: 0, company_active: 1, company_name: 'A社', knowledge_space: 'shared',
};
check('セッション: 停止したスタッフは弾く', (await asGet('/api/me', { ...H, 'x-clarion-token': sessionToken })).status === 401);
auth.session = null;

// 共有トークンはこれまでどおり管理者として通る
check('移行: 共有トークンは今までどおり通る', (await call('/api/health')).status === 200);
const legacyMe = await (await call('/api/me')).json();
check('移行: 共有トークンは管理者扱い', legacyMe.me.role === 'admin' && legacyMe.me.via === 'token');
check('移行: 共有トークンは会社＝ナレッジ空間', legacyMe.me.company === legacyMe.me.knowledge_space);

/* ======================= 2つのトラックと心境 ========================= */

const tracks = CUSTOMER_TYPES.reduce((acc, t) => ({ ...acc, [t.track]: (acc[t.track] || 0) + 1 }), {});
check('トラック: 通常と大逆転の2本', tracks.standard === 7 && tracks.reversal === 1, JSON.stringify(tracks));
check('トラック: 全型に折れる条件が3つある', CUSTOMER_TYPES.every((t) => t.flags?.length === 3));
check('トラック: 全型に禁じ手がある', CUSTOMER_TYPES.every((t) => t.breaker?.length > 5));
check('トラック: 条件のidが型の中で重複しない',
  CUSTOMER_TYPES.every((t) => new Set(t.flags.map((f) => f.id)).size === 3));
check('トラック: 全型に開始時の心境がある',
  CUSTOMER_TYPES.every((t) => MOODS.some((m) => m.id === t.opening)));
check('トラック: 不満客は苛立ちから始まる', CUSTOMER_TYPES.find((t) => t.id === 'complaint').opening === 'irritated');
check('トラック: 見せに来ただけは乗り気から始まる', CUSTOMER_TYPES.find((t) => t.id === 'showoff').opening === 'engaged');

/* ============================== 間の計測 ============================== */

// 「黙って待つ」は判断基準によく出るが、書き起こしだけでは跡形もなく消える。
// 画面には出さず、採点にだけ秒数を渡す。
const timed = [
  { role: 'customer', text: 'これ、いくらになりますか。' },
  { role: 'trainee', text: 'まずお品物を拝見しますね。', at: 4.2, gap: 4.2 },
  { role: 'customer', text: 'はい。' },
  { role: 'trainee', text: '50万円でいかがでしょうか。', at: 31, gap: 1.1 },
  { role: 'trainee', text: 'あ、もちろんご相談も…', at: 32.1, gap: 0.4 },
];
const convoText = conversationText(timed);
check('間: 沈黙を秒数で差し込む', convoText.includes('（4.2秒 沈黙）'), convoText);
check('間: 1秒未満は書かない', !convoText.includes('0.4秒'));
check('間: 金額提示前の短い間も出る', convoText.includes('（1.1秒 沈黙）'));
check('間: 発話は落とさない', timed.every((m) => convoText.includes(m.text)));
check('間: 計測なしの回は素のまま',
  conversationText([{ role: 'trainee', text: 'はい' }]) === '店員：はい');

const timedReq = scoringRequest({ history: timed, criteria: '# 基準', customerType: 'kaitori' });
const timedUser = timedReq.messages[0].content;
check('間: 秒数そのもので減点させない', timedUser.includes('この秒数そのもので加点・減点はしないでください'));
const plainReq = scoringRequest({ history: [{ role: 'trainee', text: 'はい' }], criteria: '# 基準', customerType: 'kaitori' });
check('間: 計測のない回はそう伝える', plainReq.messages[0].content.includes('間の計測がありません'));

// 秒数は履歴に残す（採点と、あとから見直すため）。画面に出さないのは app.js 側の判断
const timedVisible = visibleHistory(timed);
check('間: 伏せるのは条件だけで、秒数は履歴に残る',
  timedVisible[1].gap === 4.2 && timedVisible.every((m) => m.flags === undefined),
  JSON.stringify(timedVisible[1]));

/* --------- 場面：買取であって販売ではない --------- */

// 最初に8つの型を「一般的な接客」として書いたせいで、買取の判断基準に
// 販売の客（店の商品を見せてほしい客）が立つ事故が起きた。その再発を止める。
check('場面: 全型に来店の目的がある', CUSTOMER_TYPES.every((t) => SCENES[t.scene]),
  CUSTOMER_TYPES.filter((t) => !SCENES[t.scene]).map((t) => t.label).join(','));
check('場面: いまはすべて買取', CUSTOMER_TYPES.every((t) => t.scene === 'kaitori'));

const sellerPrompt = roleplaySystemPrompt({ customerType: 'undecided' });
check('場面: 買取カウンターだと先に言う', sellerPrompt.includes('ここは買取カウンターです'));
check('場面: 買う側の言い方を禁じる', sellerPrompt.includes('店の商品を買う側の言い方は絶対にしない'));
check('場面: 役柄より前に場面が来る',
  sellerPrompt.indexOf('【場面】') < sellerPrompt.indexOf('【あなたの役柄】'));

// 型の文面そのものに販売の語が残っていないか。
// 「欲しい」「お決まりですか」「値引き」は買い手側の言葉で、これが残っていると
// 客役が店の商品を選びに来てしまう
const SELLING_WORDS = ['欲しい', 'お決まり', '値引き', '購入', '見ているだけ'];
for (const t of CUSTOMER_TYPES) {
  const text = [t.hint, t.goal, t.breaker, ...t.flags.map((f) => `${f.label}${f.hint}`)].join(' ');
  const hit = SELLING_WORDS.filter((w) => text.includes(w));
  check(`場面: ${t.label} に販売の言葉が残っていない`, hit.length === 0, hit.join(','));
}

/* --------- 声が心境で変わる --------- */

const vGuarded = voiceDirection('complaint', 'guarded');
const vWarm = voiceDirection('complaint', 'warm');
const vIrritated = voiceDirection('complaint', 'irritated');
check('声: 心境で読み上げの指示が変わる', vGuarded.instructions !== vWarm.instructions,
  `${vGuarded.instructions} / ${vWarm.instructions}`);
check('声: 型の地声は残る',
  vGuarded.instructions.includes('納得していない客') && vWarm.instructions.includes('納得していない客'));
check('声: 苛立ちのほうが強く出る', vIrritated.intensity > vWarm.intensity, `${vIrritated.intensity} vs ${vWarm.intensity}`);
check('声: 強さは0〜2に収める', CUSTOMER_TYPES.every((t) => MOODS.every((m) => {
  const v = voiceDirection(t.id, m.id);
  return v.intensity >= 0 && v.intensity <= 2;
})));
check('声: 速さも心境で変わる', voiceDirection('silent', 'irritated').speed > voiceDirection('silent', 'guarded').speed);
check('声: 心境を渡さなければ既定に落ちる', voiceDirection('price').instructions.includes('前のめり'));

/* --------- 状態の持ち回り --------- */

const convo = [
  { role: 'customer', text: 'a', mood: 'guarded', flags: [] },
  { role: 'trainee', text: 'b' },
  { role: 'customer', text: 'c', mood: 'engaged', flags: ['heard_out'] },
  { role: 'trainee', text: 'd' },
  { role: 'customer', text: 'e', mood: 'irritated', flags: [] }, // 禁じ手で条件が外れた
];
const st = stateOf(convo);
check('状態: いまの心境は最後の客の発話から取る', st.mood === 'irritated');
check('状態: いまの条件は最後の状態（外れたら外れたまま）', st.flagsMet.length === 0);
check('状態: 一度でも立った条件は別に数える', st.everMet.includes('heard_out'), JSON.stringify(st));
check('状態: 空の履歴でも落ちない', stateOf([]).mood === null && stateOf().everMet.length === 0);

/* --------- 受講者に条件を見せない --------- */

const vis = visibleHistory(convo);
check('秘匿: 条件の達成状況は返さない', vis.every((m) => m.flags === undefined));
check('秘匿: 表情は返す（対面なら見えているもの）', vis[2].mood === 'engaged');
check('秘匿: 発話は落とさない', vis.length === convo.length && vis[4].text === 'e');

const startedTurn = await (await post('/api/runs', { modeId: 'mode1' })).json();
check('秘匿: 開始レスポンスに条件を含めない',
  startedTurn.flags === undefined && startedTurn.history.every((m) => m.flags === undefined),
  JSON.stringify(startedTurn).slice(0, 160));
check('秘匿: 表情は返る', Boolean(startedTurn.mood && startedTurn.face), JSON.stringify(startedTurn.face));
// 客役は毎回同じ発話だと練習にならない。temperature が握り潰されていないこと
check('客役: temperature が Claude まで届く', lastClaude.temperature === 1, JSON.stringify(lastClaude.temperature));

/* --------- 客役プロンプト --------- */

const guardedPrompt = roleplaySystemPrompt({ customerType: 'complaint', mood: 'irritated' });
check('客役: いまの心境が載る', guardedPrompt.includes('【いまのあなたの心境】') && guardedPrompt.includes('苛立ち'));
check('客役: 折れる条件が載る', guardedPrompt.includes('【あなたが折れる条件】'));
check('客役: 未達の条件は未と出る', guardedPrompt.includes('[未] 遮られずに最後まで言えた'));
const partway = roleplaySystemPrompt({ customerType: 'complaint', mood: 'neutral', flagsMet: ['heard_out'] });
check('客役: 達成済みは済と出る', partway.includes('[済] 遮られずに最後まで言えた'));
check('客役: 禁じ手が載る', partway.includes('早々に謝って済ませる'));
check('客役: 条件を口に出させない', partway.includes('口に出して数えない'));
check('客役: 大逆転型は売る気がないと明示する',
  roleplaySystemPrompt({ customerType: 'showoff' }).includes('今日売るつもりがありません'));
check('客役: 通常型にはその文言を出さない',
  !roleplaySystemPrompt({ customerType: 'undecided' }).includes('今日売るつもりがありません'));

/* --------- 採点に到達状況が出る --------- */

const labelled = withFlagLabels({ flags: [{ id: 'heard_out', met: true, evidence: '「最後まで」' }] }, 'complaint');
check('採点: 条件に読める名前が付く', labelled.flags[0].label === '遮られずに最後まで言えた');
check('採点: 未達の条件も並ぶ（どこで止まったか分かるように）', labelled.flags.length === 3);
check('採点: 未報告の条件は未達扱い', labelled.flags[1].met === false);
check('採点: 禁じ手とトラックも返す', labelled.breaker.length > 5 && labelled.track === 'standard');
check('採点: 条件の無い型でも落ちない', withFlagLabels({}, 'nosuch').flags.length === 0);

const scoredFlags = await (await post('/api/runs/run1/score', {})).json();
check('採点: 到達状況が返る', Array.isArray(scoredFlags.score?.flags), JSON.stringify(scoredFlags.score?.flags));
check('採点: 採点プロンプトに到達状況を渡す',
  JSON.stringify(lastClaude).includes('この客が折れる条件と、会話中の到達状況'));

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
