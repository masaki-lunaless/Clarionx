// 音声入出力：Whisper API（STT）と、差し替え可能なTTSプロバイダ。
//
// 当初はにじボイスAPIを使っていたが、2026年2月4日にサービス終了したため差し替えた。
// 同じことが起きても1ファイルの差し替えで済むよう、TTSはプロバイダ層として分離してある。
// 追加するときは PROVIDERS に {synthesize, voices} を持つエントリを足すだけ。
import { ApiError } from './llm.js';

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';
const AIVIS_TTS_URL = 'https://api.aivis-project.com/v1/tts/synthesize';

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
  return cleanTranscript(data.text || '');
}

// Whisperが音声のない音を渡されたときに出す定型文。学習データの動画由来で、接客には現れない。
// 「ありがとうございました」のような接客で実際に使う言い回しは対象にしない。
const HALLUCINATIONS = [
  /ご(視|清)聴(いただき)?(まことに|誠に)?ありがとうございま(した|す)/,
  /本日はご覧いただきありがとうございま(した|す)/,
  /最後まで(ご視聴|ご覧)いただきありがとうございま(した|す)/,
  /チャンネル登録(と高評価)?(を)?(よろしく|お願い)/,
  /この動画/,
  /次回(の動画)?も(お楽しみに|よろしく)/,
];

/**
 * 書き起こしからWhisperの誤出力を取り除く。
 * 無音や環境音だけの区間に対して、同じ定型文を何十回も返してくることがある。
 * あわせて、同じ文の連続も1つにまとめる（雑音の多い音声で起きる）。
 */
export function cleanTranscript(text) {
  // Whisperは日本語で句読点を付けないことがあるため、空白区切りも文の切れ目として扱う
  const sentences = String(text)
    .split(/(?<=[。！？])\s*|\n+|\s{1,}/)
    .map((t) => t.trim())
    .filter(Boolean);

  const kept = [];
  for (const sentence of sentences) {
    if (HALLUCINATIONS.some((re) => re.test(sentence))) continue;
    if (kept.length && kept[kept.length - 1] === sentence) continue; // 直前と同じ文は落とす
    kept.push(sentence);
  }
  return collapseRepeats(kept).join(' ').trim();
}

/**
 * 直後に繰り返される文の塊を1つにまとめる。
 * 音量の小さい音声では、Whisperが1文ではなく数文まとめて繰り返すことがある
 * （A B A B のような形）。1文ずつの比較では取り逃がすため、塊で見る。
 */
function collapseRepeats(sentences, maxBlock = 4) {
  const out = [...sentences];
  for (let size = maxBlock; size >= 2; size--) {
    for (let i = 0; i + size * 2 <= out.length; ) {
      const a = out.slice(i, i + size).join('\u0000');
      const b = out.slice(i + size, i + size * 2).join('\u0000');
      if (a === b) out.splice(i + size, size);
      else i++;
    }
  }
  return out;
}

/* ------------------------------ TTSプロバイダ ------------------------------ */

// OpenAIの声（gpt-4o-mini-ttsの組み込みボイス）
const OPENAI_VOICES = [
  { id: 'alloy', name: 'alloy（中性・落ち着き）' },
  { id: 'ash', name: 'ash（男性・低め）' },
  { id: 'ballad', name: 'ballad（男性・穏やか）' },
  { id: 'coral', name: 'coral（女性・明るい）' },
  { id: 'echo', name: 'echo（男性・硬め）' },
  { id: 'fable', name: 'fable（中性・語り口）' },
  { id: 'nova', name: 'nova（女性・快活）' },
  { id: 'onyx', name: 'onyx（男性・重い）' },
  { id: 'sage', name: 'sage（女性・静か）' },
  { id: 'shimmer', name: 'shimmer（女性・柔らかい）' },
  { id: 'verse', name: 'verse（中性・抑揚あり）' },
];

const PROVIDERS = {
  // 日本語ネイティブ。感情表現パラメータあり、ACMLライセンスのモデルはクレジット表記不要。
  // 声は「モデルUUID」で指定するため、一覧はダッシュボードで選んで環境変数に入れる運用。
  aivis: {
    enabled: (env) => Boolean(env.AIVIS_API_KEY),
    voices: (env) => parseVoiceList(env.AIVIS_VOICES),
    async synthesize(env, text, { voice, speed, intensity }) {
      const model = voice || env.AIVIS_MODEL_UUID;
      if (!model) {
        console.warn('aivis: AIVIS_MODEL_UUID が未設定');
        return null;
      }
      const res = await fetch(AIVIS_TTS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AIVIS_API_KEY}` },
        body: JSON.stringify({
          model_uuid: model,
          text: text.slice(0, 3000),
          output_format: 'mp3',
          language: 'ja',
          speaking_rate: clamp(Number(speed || env.TTS_SPEED || 1), 0.5, 2),
          emotional_intensity: clamp(Number(intensity ?? 1), 0, 2),
        }),
      });
      if (!res.ok) {
        console.warn('aivis error', res.status, (await res.text()).slice(0, 400));
        return null;
      }
      return toDataUri(await res.arrayBuffer(), 'audio/mpeg');
    },
  },

  // Whisperと同じキーで動くので追加の契約が要らない。instructionsで演技を指示できる。
  openai: {
    enabled: (env) => Boolean(env.OPENAI_API_KEY),
    voices: () => OPENAI_VOICES,
    async synthesize(env, text, { voice, speed, instructions }) {
      const res = await fetch(OPENAI_TTS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
          voice: voice || env.OPENAI_TTS_VOICE || 'nova',
          input: text.slice(0, 3000),
          response_format: 'mp3',
          speed: clamp(Number(speed || env.TTS_SPEED || 1), 0.25, 4),
          ...(instructions ? { instructions } : {}),
        }),
      });
      if (!res.ok) {
        console.warn('openai tts error', res.status, (await res.text()).slice(0, 400));
        return null;
      }
      return toDataUri(await res.arrayBuffer(), 'audio/mpeg');
    },
  },
};

const clamp = (n, min, max, fallback = 1) => (Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback);

/** "uuid:表示名,uuid:表示名" 形式を声の一覧に開く */
function parseVoiceList(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      return idx === -1 ? { id: entry, name: entry } : { id: entry.slice(0, idx), name: entry.slice(idx + 1) };
    });
}

/**
 * 音声バイト列をdata URIにする。
 * にじボイスは一時URLを返す仕様だったが、現行プロバイダはどちらも生バイトを返すため、
 * フロントに1レスポンスで渡しきれるdata URIに変換している（1ターン1リクエストの設計を維持）。
 */
function toDataUri(buffer, mime) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** 実際に使うプロバイダを決める。明示指定 > 鍵のある方（openai優先） > なし */
export function activeProvider(env) {
  const named = (env.TTS_PROVIDER || '').trim().toLowerCase();
  if (named === 'none') return null;
  if (named) return PROVIDERS[named]?.enabled(env) ? named : null;
  return ['openai', 'aivis'].find((name) => PROVIDERS[name].enabled(env)) || null;
}

/**
 * テキスト→音声のdata URI。
 * 未設定・失敗時は null を返し、フロント側で speechSynthesis にフォールバックする。
 * 会話そのものは止めない（TTSが落ちても練習は続けられる）。
 */
export async function synthesize(env, text, options = {}) {
  const name = activeProvider(env);
  if (!name || !text) return null;
  try {
    return await PROVIDERS[name].synthesize(env, text, options);
  } catch (err) {
    console.warn(`tts(${name}) failed`, err?.message || err);
    return null;
  }
}

/** 声の一覧（フロントの選択用） */
export function listVoices(env) {
  const name = activeProvider(env);
  return name ? PROVIDERS[name].voices(env) : [];
}
