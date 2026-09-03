// Worker（clarion-proxy）との通信。APIキーはここには存在しない。
// データはすべてWorker側のD1にあり、この画面は状態を持たない。
import { settings } from './store.js';

export class ClarionError extends Error {}

function base() {
  const url = (settings.get('workerUrl') || '').trim().replace(/\/$/, '');
  if (!url) throw new ClarionError('設定タブでWorkerのURLを入れてください');
  return url;
}

const headers = (extra = {}) => {
  const token = (settings.get('token') || '').trim();
  return { ...(token ? { 'x-clarion-token': token } : {}), ...extra };
};

async function handle(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail ? `\n${String(data.detail).slice(0, 300)}` : '';
    throw new ClarionError(`${data.error || `HTTP ${res.status}`}${detail}`);
  }
  return data;
}

/** 通信自体が失敗したときは、そのままでは "Failed to fetch" としか出ないので言い換える */
async function send(url, init) {
  try {
    return await fetch(url, init);
  } catch {
    throw new ClarionError('サーバーに接続できません。Worker URLが正しいか、ネットワーク接続を確認してください');
  }
}

const request = async (method, path, body) =>
  handle(
    await send(base() + path, {
      method,
      headers: headers(body ? { 'content-type': 'application/json' } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );

async function upload(path, { audio, payload, filename }) {
  const form = new FormData();
  if (audio) form.append('audio', audio, filename || 'audio.webm');
  form.append('payload', JSON.stringify(payload || {}));
  return handle(await send(base() + path, { method: 'POST', headers: headers(), body: form }));
}

export const api = {
  config: () => request('GET', '/api/config'),

  // 1. 蓄積
  listCases: () => request('GET', '/api/cases'),
  getCase: (id) => request('GET', `/api/cases/${id}`),
  createCase: (data) => request('POST', '/api/cases', data),
  updateCase: (id, data) => request('PATCH', `/api/cases/${id}`, data),
  deleteCase: (id) => request('DELETE', `/api/cases/${id}`),
  transcribe: (id, audio, payload, filename) => upload(`/api/cases/${id}/transcribe`, { audio, payload, filename }),
  format: (id) => request('POST', `/api/cases/${id}/format`, {}),
  detect: (id) => request('POST', `/api/cases/${id}/detect`, {}),
  saveAnswer: (questionId, answer) => request('PATCH', `/api/questions/${questionId}`, { answer }),
  followUp: (questionId, data) => request('POST', `/api/questions/${questionId}/follow-up`, data),

  // 3. 統合
  listCriteria: () => request('GET', '/api/criteria'),
  getCriteria: (id) => request('GET', `/api/criteria/${id}`),
  mergeCriteria: (data) => request('POST', '/api/criteria', data),
  updateCriteria: (id, markdown) => request('PATCH', `/api/criteria/${id}`, { markdown }),
  deleteCriteria: (id) => request('DELETE', `/api/criteria/${id}`),
  criteriaFeedback: (id) => request('GET', `/api/criteria/${id}/feedback`),

  // 2. ロープレ
  listModes: () => request('GET', '/api/modes'),
  createMode: (data) => request('POST', '/api/modes', data),
  deleteMode: (id) => request('DELETE', `/api/modes/${id}`),
  listRuns: (criteriaId) => request('GET', `/api/runs${criteriaId ? `?criteriaId=${criteriaId}` : ''}`),
  startRun: (modeId, trainee) => request('POST', '/api/runs', { modeId, trainee }),
  turn: (runId, { text, audio, filename, payload }) =>
    audio ? upload(`/api/runs/${runId}/turn`, { audio, payload, filename }) : request('POST', `/api/runs/${runId}/turn`, { text }),
  score: (runId) => request('POST', `/api/runs/${runId}/score`, {}),
  feedback: (runId, data) => request('PATCH', `/api/runs/${runId}/feedback`, data),
};
