// MP4などの動画ファイルから、ブラウザ内で音声だけを取り出す。
//
// 映像込みのファイルをそのまま送ると、Whisperの25MB上限にもWorkerの
// リクエスト上限にも当たる。送る前にここで 16kHz・モノラルのWAVに落とし、
// 上限に収まる長さへ分割する。ffmpegもサーバ側の変換処理も要らない。

const SAMPLE_RATE = 16000;
const BYTES_PER_SEC = SAMPLE_RATE * 2; // 16bit モノラル
// Whisperの上限は25MB。ヘッダと余裕を見て10分（約19MB）で切る。
export const CHUNK_SECONDS = 600;

/** 全チャンネルを平均して1本にし、16kHzへ線形補間で落とす */
function toMono16k(audioBuffer) {
  const { numberOfChannels, length, sampleRate } = audioBuffer;
  const channels = [];
  for (let c = 0; c < numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));

  const ratio = sampleRate / SAMPLE_RATE;
  const outLength = Math.floor(length / ratio);
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    let sum = 0;
    for (const ch of channels) {
      const a = ch[idx] || 0;
      const b = ch[idx + 1] !== undefined ? ch[idx + 1] : a;
      sum += a + (b - a) * frac;
    }
    out[i] = sum / numberOfChannels;
  }
  return out;
}

/**
 * 長い無音を詰める。監視カメラの通し録画は大半が無音のため、
 * ここで落とすと書き起こしの時間も費用も大きく減る。
 * 発話を切らないよう、無音の前後は少し残す。
 */
function trimSilence(samples, { threshold = 0.012, keepMs = 400 } = {}) {
  const win = Math.floor(SAMPLE_RATE * 0.05); // 50msごとに判定
  const keep = Math.floor((SAMPLE_RATE * keepMs) / 1000);
  const loud = [];

  for (let i = 0; i < samples.length; i += win) {
    let peak = 0;
    for (let j = i; j < Math.min(i + win, samples.length); j++) {
      const v = Math.abs(samples[j]);
      if (v > peak) peak = v;
    }
    loud.push(peak >= threshold);
  }

  // 音のある区間の前後を keep 分だけ残す
  const keepWindows = Math.ceil(keep / win);
  const mark = new Array(loud.length).fill(false);
  for (let i = 0; i < loud.length; i++) {
    if (!loud[i]) continue;
    for (let j = Math.max(0, i - keepWindows); j <= Math.min(loud.length - 1, i + keepWindows); j++) mark[j] = true;
  }

  const parts = [];
  let total = 0;
  for (let i = 0; i < mark.length; i++) {
    if (!mark[i]) continue;
    const start = i * win;
    const end = Math.min(start + win, samples.length);
    parts.push(samples.subarray(start, end));
    total += end - start;
  }
  if (!parts.length) return samples; // 全部無音と判定されたら元に戻す

  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Float32のPCMを16bitのWAVにする */
function toWav(samples) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const str = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));

  str(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // モノラル
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, BYTES_PER_SEC, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export const canExtract = () => Boolean(window.AudioContext || window.webkitAudioContext);

/**
 * 動画・音声ファイル → 送信できる大きさのWAVチャンクに分割する。
 * onProgress(段階の説明) で進捗を返す。
 */
export async function extractChunks(file, { onProgress = () => {}, trim = true } = {}) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('このブラウザは音声の取り出しに対応していません');

  onProgress('ファイルを読み込み中…');
  const bytes = await file.arrayBuffer();

  onProgress('音声を取り出し中…（長い動画は数分かかります）');
  const ctx = new Ctx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error('このファイルから音声を取り出せませんでした。形式を確認してください');
  } finally {
    ctx.close?.();
  }

  onProgress('16kHzに変換中…');
  let samples = toMono16k(decoded);
  const originalSeconds = samples.length / SAMPLE_RATE;

  if (trim) {
    onProgress('無音を詰めています…');
    samples = trimSilence(samples);
  }
  const seconds = samples.length / SAMPLE_RATE;

  const chunks = [];
  const per = CHUNK_SECONDS * SAMPLE_RATE;
  for (let i = 0; i < samples.length; i += per) {
    chunks.push(toWav(samples.subarray(i, Math.min(i + per, samples.length))));
  }
  return { chunks, seconds, originalSeconds };
}

export const fmtDuration = (s) => `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, '0')}秒`;
