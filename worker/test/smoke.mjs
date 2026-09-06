// Workerのルーティング・認証・LLM連携を、外部APIとD1をスタブして検証する。
// SQLの正しさはここでは見ない（本番D1に対する疎通で確認する）。
import worker, { SCORING, computeTotal, parseProducts, stripPreamble, stripStageDirections, visibleItem } from '../src/index.js';
import { drawItem, priceFor, pricePenalty, CONDITIONS, ACCESSORIES } from '../src/items.js';
import { hashPassword, hasRole, normalizeCode, sha256 } from '../src/auth.js';
import { SEED_PRODUCTS } from '../src/seed-products.js';
import { cleanTranscript } from '../src/audio.js';
import { parseGlossary } from '../src/db.js';
import { glossaryBlock } from '../src/prompts.js';

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
          per_axis: [{ axis: 'A', deduction: 2, evidence: 'e', advice: 'a' }], good: [], next: [] },
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
const parsed = parseProducts(
  'カテゴリ\tブランド\t型番\t商品名\t新品価格\t買取率\t備考\n' +
  '腕時計\tロレックス\t126610LN\tサブマリーナ\t1,450,000円\t105%\t風防を見る\n' +
  'バッグ,エルメス,,バーキン30,2300000,140,\n' +
  '# コメント行\n\n名前だけの行',
);
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

const withItem = computeTotal({ closed: true, per_axis: [{ deduction: 0 }], offered_price: item.fair }, item);
check('採点: 品物ありで満点', withItem.total === 100, withItem.total);
const missed = computeTotal({ closed: true, per_axis: [{ deduction: 0 }], offered_price: item.fair * 0.3 }, item);
check('採点: 査定額を大きく外すと20点引く', missed.total === 80, missed.total);
check('採点: 査定額の内訳を返す', missed.price?.verdict === 'low' && missed.breakdown.pricePenalty === 20);
// 品物のない従来の記録は、配点の意味を変えない
const noItem = computeTotal({ closed: false, per_axis: [{ deduction: 10 }] });
check('採点: 品物なしなら従来どおり型で70点', noItem.total === 0 && noItem.breakdown.maxAxisPenalty === 70);
check('採点: 品物ありなら型は50点に割る',
  computeTotal({ closed: true, per_axis: [{ deduction: 10 }], offered_price: null }, item).breakdown.maxAxisPenalty === 50);

/* --------- 受講者に正解を見せない --------- */

check('秘匿: 採点前の品物は伏せる', visibleItem({ item, score: null })?.hidden === true);
check('秘匿: 採点後は開示する', visibleItem({ item, score: { total: 80 } })?.brand === 'ロレックス');

const startedWithItem = await (await post('/api/runs', { modeId: 'mode1' })).json();
check('秘匿: 開始レスポンスに品物を含めない',
  startedWithItem.item === undefined && startedWithItem.hasItem === true,
  JSON.stringify(Object.keys(startedWithItem)));
const modesForItem = await (await call('/api/modes')).json();
check('秘匿: モードはカテゴリだけ返す（品物名は出さない）',
  modesForItem.modes.every((m) => 'product_category' in m && 'has_fixed_product' in m));

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
