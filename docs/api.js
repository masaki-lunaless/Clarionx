// Worker（clarion-proxy）との通信。APIキーはここには存在しない。
import { store } from './store.js';

class ClarionError extends Error {}

function base() {
  const url = (store.state.settings.workerUrl || '').trim().replace(/\/$/, '');
  if (!url) throw new ClarionError('設定タブでWorkerのURLを入れてください');
  return url;
}

function headers(extra = {}) {
  const token = (store.state.settings.token || '').trim();
  return { ...(token ? { 'x-clarion-token': token } : {}), ...extra };
}

async function handle(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail ? `\n${String(data.detail).slice(0, 300)}` : '';
    throw new ClarionError(`${data.error || `HTTP ${res.status}`}${detail}`);
  }
  return data;
}

async function postJSON(path, body) {
  const res = await fetch(base() + path, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
  return handle(res);
}

async function postForm(path, { audio, payload, filename }) {
  const form = new FormData();
  if (audio) form.append('audio', audio, filename || 'audio.webm');
  form.append('payload', JSON.stringify(payload || {}));
  const res = await fetch(base() + path, { method: 'POST', headers: headers(), body: form });
  return handle(res);
}

export const api = {
  ClarionError,
  config: async () => handle(await fetch(base() + '/api/config', { headers: headers() })),
  health: async () => handle(await fetch(base() + '/api/health')),
  stt: (audio, payload, filename) => postForm('/api/stt', { audio, payload, filename }),
  questions: (transcript, context) => postJSON('/api/questions', { transcript, context }),
  followUp: (question, answer, quote) => postJSON('/api/follow-up', { question, answer, quote }),
  criteria: (qa, notes) => postJSON('/api/criteria', { qa, notes }),
  turn: (payload, audio, filename) =>
    audio ? postForm('/api/roleplay/turn', { audio, payload, filename }) : postJSON('/api/roleplay/turn', payload),
  score: (history, criteria) => postJSON('/api/roleplay/score', { history, criteria }),
  tts: (text, voiceActorId) => postJSON('/api/tts', { text, voiceActorId }),
};
