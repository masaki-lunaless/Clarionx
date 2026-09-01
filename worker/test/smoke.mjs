// Workerのルーティング/認証/整形を、外部APIをスタブして検証する
import worker from '../src/index.js';

const env = {
  ANTHROPIC_API_KEY: 'test',
  OPENAI_API_KEY: 'test',
  AIVIS_API_KEY: 'test',
  AIVIS_MODEL_UUID: 'model-uuid-1',
  AIVIS_VOICES: 'model-uuid-1:あかり,model-uuid-2:健一',
  ACCESS_TOKENS: 'clientA:secret-token',
  ALLOWED_ORIGINS: 'https://example.github.io',
};

const calls = [];
let lastTts = null;
let brokenTurningPoints = false;
globalThis.fetch = async (url, init = {}) => {
  calls.push(String(url));
  const u = String(url);
  if (u.includes('anthropic')) {
    const body = JSON.parse(init.body);
    if (body.tools) {
      const name = body.tools[0].name;
      const payload = {
        record_turning_points: brokenTurningPoints
          ? { turning_points: [{ quote: 'q1', label: 'l1', why: 'w1' }, { quote: 'q2', label: 'l2', why: 'w2', questions: ['x', 'y'] }] }
          : { turning_points: [{ quote: 'q', label: 'l', why: 'w', questions: ['a', 'b'] }] },
        record_questions: { items: [{ index: 0, questions: ['修復質問1', '修復質問2'] }] },
        record_criteria: { title: 'T', summary: 'S', axes: [{ name: 'A', principle: 'P', signals: ['s'], actions: ['a'], ng: ['n'], quotes: ['「原文」'] }], gaps: ['g'] },
        record_score: { total: 80, headline: 'h', per_axis: [], good: [], next: [] },
        record_follow_up: { enough: true, reason: 'r', questions: [] },
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

const H = { 'content-type': 'application/json', 'x-clarion-token': 'secret-token', origin: 'https://example.github.io' };
const call = async (path, opts = {}) =>
  worker.fetch(new Request(`https://w.dev${path}`, { headers: H, ...opts }), env);

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' :: ' + extra}`);
  if (!cond) failed++;
};

// 認証
const noToken = await worker.fetch(new Request('https://w.dev/api/config'), env);
check('トークンなしは401', noToken.status === 401);
const badToken = await worker.fetch(new Request('https://w.dev/api/config', { headers: { 'x-clarion-token': 'wrong-token!!' } }), env);
check('誤トークンは401', badToken.status === 401);
check('healthは認証なしで200', (await worker.fetch(new Request('https://w.dev/api/health'), env)).status === 200);

// CORS
const pre = await worker.fetch(new Request('https://w.dev/api/questions', { method: 'OPTIONS', headers: { origin: 'https://example.github.io' } }), env);
check('OPTIONSは204', pre.status === 204);
check('許可オリジンを返す', pre.headers.get('access-control-allow-origin') === 'https://example.github.io', pre.headers.get('access-control-allow-origin'));
const bad = await worker.fetch(new Request('https://w.dev/api/health', { headers: { origin: 'https://evil.example' } }), env);
check('未許可オリジンは弾く', bad.headers.get('access-control-allow-origin') === 'null');

// 各ルート
const cfg = await (await call('/api/config')).json();
check('config: 客タイプを返す', cfg.customerTypes.length > 0);
check('config: 既定はopenai', cfg.tts === 'openai', String(cfg.tts));
check('config: openaiの組み込みボイス一覧', cfg.voices.length === 11, String(cfg.voices.length));
check('config: 演技指示は外に出さない', !JSON.stringify(cfg.customerTypes).includes('voice'), JSON.stringify(cfg.customerTypes[0]));

const q = await (await call('/api/questions', { method: 'POST', body: JSON.stringify({ transcript: '店員：…' }) })).json();
check('questions: 転換点', q.turningPoints?.[0]?.questions.length === 2, JSON.stringify(q));

const empty = await call('/api/questions', { method: 'POST', body: JSON.stringify({}) });
check('questions: 空は400', empty.status === 400);

// モデルがquestionsを省略した場合、欠けた分だけ埋め直せること
brokenTurningPoints = true;
const repaired = await (await call('/api/questions', { method: 'POST', body: JSON.stringify({ transcript: '店員：…' }) })).json();
brokenTurningPoints = false;
check('questions: 欠落分を修復する', repaired.turningPoints.length === 2, JSON.stringify(repaired));
check('questions: 修復した質問が入る', repaired.turningPoints[0].questions?.[0] === '修復質問1', JSON.stringify(repaired.turningPoints[0]));
check('questions: 元からある分は保持', repaired.turningPoints[1].questions?.[0] === 'x', JSON.stringify(repaired.turningPoints[1]));

const c = await (await call('/api/criteria', { method: 'POST', body: JSON.stringify({ qa: [{ question: 'q', answer: 'a' }] }) })).json();
check('criteria: markdown生成', c.markdown.includes('## 1. A') && c.markdown.includes('> 「原文」'), c.markdown);

const t = await (await call('/api/roleplay/turn', { method: 'POST', body: JSON.stringify({ text: 'いらっしゃいませ', history: [], customerType: 'complaint' }) })).json();
check('turn: 返答と音声(data URI)', t.replyText.length > 0 && t.audioUrl?.startsWith('data:audio/mpeg;base64,'), JSON.stringify(t).slice(0, 200));
check('turn: openaiの/audio/speechを叩く', lastTts.url.includes('/audio/speech'), lastTts.url);
check('turn: 客タイプの演技指示を渡す', lastTts.body.instructions.includes('語気を強めて'), lastTts.body.instructions);

const form = new FormData();
form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' }), 'turn.mp4');
form.append('payload', JSON.stringify({ history: [], customerType: 'silent' }));
const audioTurn = await (await worker.fetch(new Request('https://w.dev/api/roleplay/turn', { method: 'POST', headers: { 'x-clarion-token': 'secret-token' }, body: form }), env)).json();
check('turn: 音声→書き起こし→返答', audioTurn.transcript === 'こんにちは' && audioTurn.replyText.length > 0, JSON.stringify(audioTurn));

const s = await (await call('/api/roleplay/score', { method: 'POST', body: JSON.stringify({ criteria: '# 基準', history: [{ role: 'trainee', text: 'a' }] }) })).json();
check('score: 集計', s.total === 80);

check('404', (await call('/api/nope')).status === 404);

// プロバイダ切り替え：aivisを明示するとそちらに向く
const aivisEnv = { ...env, TTS_PROVIDER: 'aivis' };
const av = await (await worker.fetch(new Request('https://w.dev/api/roleplay/turn', { method: 'POST', headers: H, body: JSON.stringify({ text: 'テスト', history: [], customerType: 'price' }) }), aivisEnv)).json();
check('aivis: Bearerとモデルuuidを渡す', lastTts.auth === 'Bearer test' && lastTts.body.model_uuid === 'model-uuid-1', JSON.stringify(lastTts));
check('aivis: 客タイプの感情強度が乗る', lastTts.body.emotional_intensity === 1.1, String(lastTts.body.emotional_intensity));
check('aivis: 音声が返る', av.audioUrl?.startsWith('data:audio/mpeg;base64,'));
const avCfg = await (await worker.fetch(new Request('https://w.dev/api/config', { headers: H }), aivisEnv)).json();
check('aivis: 設定した声の一覧を返す', avCfg.voices.length === 2 && avCfg.tts === 'aivis', JSON.stringify(avCfg.voices));

// TTSを止める設定
const muted = await (await worker.fetch(new Request('https://w.dev/api/roleplay/turn', { method: 'POST', headers: H, body: JSON.stringify({ text: 'テスト', history: [] }) }), { ...env, TTS_PROVIDER: 'none' })).json();
check('TTS_PROVIDER=none なら音声なしで返す', muted.replyText.length > 0 && muted.audioUrl === null, JSON.stringify(muted));

// TTS失敗時も会話は続く
const prev = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).includes('/audio/speech') ? new Response('err', { status: 500 }) : prev(url, init));
const degraded = await (await call('/api/roleplay/turn', { method: 'POST', body: JSON.stringify({ text: 'テスト', history: [] }) })).json();
check('TTS失敗でもreplyTextは返る', degraded.replyText.length > 0 && degraded.audioUrl === null, JSON.stringify(degraded));
globalThis.fetch = prev;

// Claude障害
globalThis.fetch = async () => new Response('overloaded', { status: 529 });
const down = await call('/api/questions', { method: 'POST', body: JSON.stringify({ transcript: 'x' }) });
check('Claude障害は502で返す', down.status === 502, String(down.status));

console.log(failed ? `\n${failed} 件失敗` : '\nすべて通過');
process.exit(failed ? 1 : 0);
