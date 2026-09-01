// Workerのルーティング/認証/整形を、外部APIをスタブして検証する
import worker from '../src/index.js';

const env = {
  ANTHROPIC_API_KEY: 'test',
  OPENAI_API_KEY: 'test',
  NIJIVOICE_API_KEY: 'test',
  NIJIVOICE_VOICE_ACTOR_ID: 'actor-1',
  ACCESS_TOKENS: 'clientA:secret-token',
  ALLOWED_ORIGINS: 'https://example.github.io',
};

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push(String(url));
  const u = String(url);
  if (u.includes('anthropic')) {
    const body = JSON.parse(init.body);
    if (body.tools) {
      const name = body.tools[0].name;
      const payload = {
        record_turning_points: { turning_points: [{ quote: 'q', label: 'l', why: 'w', questions: ['a', 'b'] }] },
        record_criteria: { title: 'T', summary: 'S', axes: [{ name: 'A', principle: 'P', signals: ['s'], actions: ['a'], ng: ['n'], quotes: ['「原文」'] }], gaps: ['g'] },
        record_score: { total: 80, headline: 'h', per_axis: [], good: [], next: [] },
        record_follow_up: { enough: true, reason: 'r', questions: [] },
      }[name];
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', name, input: payload }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ちょっと見てるだけです。' }] }), { status: 200 });
  }
  if (u.includes('openai')) return new Response(JSON.stringify({ text: 'こんにちは' }), { status: 200 });
  if (u.includes('nijivoice') && u.includes('generate-voice')) {
    return new Response(JSON.stringify({ generatedVoice: { audioFileDownloadUrl: 'https://cdn.example/a.mp3' } }), { status: 200 });
  }
  if (u.includes('nijivoice')) return new Response(JSON.stringify({ voiceActors: [{ id: 'v1', name: 'あかり' }] }), { status: 200 });
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
check('config: 客タイプと声', cfg.customerTypes.length > 0 && cfg.voiceActors.length === 1);

const q = await (await call('/api/questions', { method: 'POST', body: JSON.stringify({ transcript: '店員：…' }) })).json();
check('questions: 転換点', q.turningPoints?.[0]?.questions.length === 2, JSON.stringify(q));

const empty = await call('/api/questions', { method: 'POST', body: JSON.stringify({}) });
check('questions: 空は400', empty.status === 400);

const c = await (await call('/api/criteria', { method: 'POST', body: JSON.stringify({ qa: [{ question: 'q', answer: 'a' }] }) })).json();
check('criteria: markdown生成', c.markdown.includes('## 1. A') && c.markdown.includes('> 「原文」'), c.markdown);

const t = await (await call('/api/roleplay/turn', { method: 'POST', body: JSON.stringify({ text: 'いらっしゃいませ', history: [], customerType: 'kaitori' }) })).json();
check('turn: 返答とTTS URL', t.replyText.length > 0 && t.audioUrl === 'https://cdn.example/a.mp3', JSON.stringify(t));

const form = new FormData();
form.append('audio', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mp4' }), 'turn.mp4');
form.append('payload', JSON.stringify({ history: [], customerType: 'silent' }));
const audioTurn = await (await worker.fetch(new Request('https://w.dev/api/roleplay/turn', { method: 'POST', headers: { 'x-clarion-token': 'secret-token' }, body: form }), env)).json();
check('turn: 音声→書き起こし→返答', audioTurn.transcript === 'こんにちは' && audioTurn.replyText.length > 0, JSON.stringify(audioTurn));

const s = await (await call('/api/roleplay/score', { method: 'POST', body: JSON.stringify({ criteria: '# 基準', history: [{ role: 'trainee', text: 'a' }] }) })).json();
check('score: 集計', s.total === 80);

check('404', (await call('/api/nope')).status === 404);

// TTS失敗時も会話は続く
const prev = globalThis.fetch;
globalThis.fetch = async (url, init) => (String(url).includes('nijivoice') ? new Response('err', { status: 500 }) : prev(url, init));
const degraded = await (await call('/api/roleplay/turn', { method: 'POST', body: JSON.stringify({ text: 'テスト', history: [] }) })).json();
check('TTS失敗でもreplyTextは返る', degraded.replyText.length > 0 && degraded.audioUrl === null, JSON.stringify(degraded));
globalThis.fetch = prev;

// Claude障害
globalThis.fetch = async () => new Response('overloaded', { status: 529 });
const down = await call('/api/questions', { method: 'POST', body: JSON.stringify({ transcript: 'x' }) });
check('Claude障害は502で返す', down.status === 502, String(down.status));

console.log(failed ? `\n${failed} 件失敗` : '\nすべて通過');
process.exit(failed ? 1 : 0);
