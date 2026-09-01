// 音声入出力：Whisper API（STT）とにじボイスAPI（TTS）。
import { ApiError } from './llm.js';

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const NIJI_BASE = 'https://api.nijivoice.com/api/platform/v1';

const EXT_BY_MIME = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
};

function extForBlob(blob, fallbackName) {
  if (fallbackName && fallbackName.includes('.')) return fallbackName.split('.').pop();
  const mime = (blob.type || '').split(';')[0];
  return EXT_BY_MIME[mime] || 'webm';
}

/**
 * 音声Blob→テキスト。
 * prompt には店名・商品名など固有名詞を渡すと精度が上がる。
 */
export async function transcribe(env, blob, { prompt, filename } = {}) {
  const key = env.OPENAI_API_KEY;
  if (!key) throw new ApiError(500, 'OPENAI_API_KEY が未設定です');
  if (!blob || blob.size === 0) throw new ApiError(400, '音声データが空です');

  const form = new FormData();
  form.append('file', blob, `audio.${extForBlob(blob, filename)}`);
  form.append('model', env.WHISPER_MODEL || 'whisper-1');
  form.append('language', 'ja');
  form.append('response_format', 'json');
  if (prompt) form.append('prompt', prompt.slice(0, 800));

  const res = await fetch(WHISPER_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) {
    throw new ApiError(502, 'Whisper APIエラー', (await res.text()).slice(0, 800));
  }
  const data = await res.json();
  return (data.text || '').trim();
}

/**
 * テキスト→音声URL。にじボイスは音声バイナリではなく一時URLを返す仕様。
 * 未設定・失敗時は null を返し、フロント側で speechSynthesis にフォールバックする。
 */
export async function synthesize(env, text, { voiceActorId, speed, emotionalLevel } = {}) {
  const key = env.NIJIVOICE_API_KEY;
  const actor = voiceActorId || env.NIJIVOICE_VOICE_ACTOR_ID;
  if (!key || !actor || !text) return null;

  const res = await fetch(`${NIJI_BASE}/voice-actors/${encodeURIComponent(actor)}/generate-voice`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-api-key': key,
    },
    body: JSON.stringify({
      script: text.slice(0, 3000),
      speed: String(speed || env.NIJIVOICE_SPEED || '1.0'),
      format: 'mp3',
      ...(emotionalLevel === undefined ? {} : { emotionalLevel: String(emotionalLevel) }),
    }),
  });

  if (!res.ok) {
    // TTSが落ちても会話自体は続けたいので、例外にせず握って null を返す
    console.warn('nijivoice error', res.status, (await res.text()).slice(0, 400));
    return null;
  }
  const data = await res.json().catch(() => null);
  const gv = data?.generatedVoice || data;
  return gv?.audioFileDownloadUrl || gv?.audioFileUrl || null;
}

/** 話者一覧（フロントの声選択用） */
export async function listVoiceActors(env) {
  const key = env.NIJIVOICE_API_KEY;
  if (!key) return [];
  const res = await fetch(`${NIJI_BASE}/voice-actors`, {
    headers: { accept: 'application/json', 'x-api-key': key },
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const actors = data?.voiceActors || data?.voice_actors || [];
  return actors.map((a) => ({
    id: a.id,
    name: a.name,
    gender: a.gender,
    age: a.age,
  }));
}
