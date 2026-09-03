// MP4などの動画ファイルから、ブラウザ内で音声だけを取り出す。
//
// 映像込みのファイルをそのまま送ると、Whisperの25MB上限にもWorkerの
// リクエスト上限にも当たる。送る前にここで 16kHz・モノラルのWAVに落とし、
// 上限に収まる長さへ分割する。ffmpegもサーバ側の変換処理も要らない。

const SAMPLE_RATE = 16000;
const BYTES_PER_SEC = SAMPLE_RATE * 2; // 16bit モノラル
// Whisperの上限は25MB。ヘッダと余裕を見て10分（約19MB）で切る。
export const CHUNK_SECONDS = 600;

/**
 * 全チャンネルを平均して1本にし、16kHzへ線形補間で落とす。
 *
 * ただし左右が逆相の素材は、平均を取ると声が打ち消し合って消える。
 * 相関を見て、逆相なら平均せず片チャンネルだけを使う。
 */
function toMono16k(audioBuffer) {
  const { numberOfChannels, length, sampleRate } = audioBuffer;
  let channels = [];
  for (let c = 0; c < numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));

  let correlation = null;
  if (channels.length === 2) {
    const step = Math.max(1, Math.floor(length / 100000));
    let dot = 0;
    let la = 0;
    let lb = 0;
    for (let i = 0; i < length; i += step) {
      const a = channels[0][i];
      const b = channels[1][i];
      dot += a * b;
      la += a * a;
      lb += b * b;
    }
    correlation = la && lb ? dot / Math.sqrt(la * lb) : 0;
    if (correlation < -0.3) channels = [channels[0]]; // 逆相：平均すると消えるので片側だけ使う
  }

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
  return { samples: out, correlation, channels: numberOfChannels };
}

/**
 * 低い周波数のうなりを落とす（一次IIRハイパス）。
 * 監視カメラや店内の録音には空調・冷蔵ケース・振動の音が常に乗っており、
 * これが無音判定の基準を押し上げて、話し声との差を潰してしまう。
 * 話し声はおおむね100Hz以上なので、そこから下を削る。
 */
function highPass(samples, cutoff) {
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / SAMPLE_RATE;
  const a = rc / (rc + dt);
  const out = new Float32Array(samples.length);
  let prevIn = 0;
  let prevOut = 0;
  for (let i = 0; i < samples.length; i++) {
    prevOut = a * (prevOut + samples[i] - prevIn);
    prevIn = samples[i];
    out[i] = prevOut;
  }
  return out;
}

/**
 * 音量を持ち上げる。マイクが遠い録音はそのままだとWhisperが話し声を拾えない。
 * 単発のノイズに引っ張られないよう、上位1%の大きさを基準にする。
 * 無音を増幅して雑音だけにしないよう、持ち上げ幅に上限を設ける。
 */
function normalize(samples, { target = 0.7, maxGain } = {}) {
  const step = Math.max(1, Math.floor(samples.length / 200000));
  const mags = [];
  for (let i = 0; i < samples.length; i += step) mags.push(Math.abs(samples[i]));
  mags.sort((a, b) => a - b);
  const loud = mags[Math.floor(mags.length * 0.99)] || 0;
  if (!loud) return { samples, gain: 1 };

  const gain = Math.min(target / loud, maxGain);
  if (gain <= 1.05) return { samples, gain: 1 };

  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] * gain;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return { samples: out, gain };
}

/**
 * 長い無音を詰める。監視カメラの通し録画は大半が無音のため、
 * ここで落とすと書き起こしの時間も費用も大きく減る。
 *
 * しきい値は録音ごとに変える。固定値だと、マイクが遠く全体が小さい録音では
 * 全区間が無音と判定され、結果として無音のままWhisperへ送ることになる。
 * Whisperは音声のない音を渡されると「ご視聴ありがとうございました」のような
 * 学習データの断片を延々と出力するため、それが混入してしまう。
 */
function trimSilence(samples, { keepMs = 400, factor = 4 } = {}) {
  const win = Math.floor(SAMPLE_RATE * 0.05); // 50msごとに判定
  const keep = Math.floor((SAMPLE_RATE * keepMs) / 1000);

  const peaks = [];
  for (let i = 0; i < samples.length; i += win) {
    let peak = 0;
    for (let j = i; j < Math.min(i + win, samples.length); j++) {
      const v = Math.abs(samples[j]);
      if (v > peak) peak = v;
    }
    peaks.push(peak);
  }

  // 下位20%を「その録音の暗騒音」とみなし、その数倍を超えたところを音声とする
  const sorted = [...peaks].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const loudest = sorted[sorted.length - 1] || 0;
  const threshold = Math.min(Math.max(floor * factor, 0.004), loudest * 0.5);

  const keepWindows = Math.ceil(keep / win);
  const mark = new Array(peaks.length).fill(false);
  for (let i = 0; i < peaks.length; i++) {
    if (peaks[i] < threshold) continue;
    for (let j = Math.max(0, i - keepWindows); j <= Math.min(peaks.length - 1, i + keepWindows); j++) mark[j] = true;
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

  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return { samples: out, threshold, floor, loudest };
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
// 取り込みの調整値。素材によって最適が変わるので、設定から上書きできる。
export const DEFAULTS = { hpCutoff: 100, maxGain: 20, silenceFactor: 4, trim: true };

export async function extractChunks(file, { onProgress = () => {}, ...opts } = {}) {
  const { hpCutoff, maxGain, silenceFactor, trim } = { ...DEFAULTS, ...opts };
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
  const mono = toMono16k(decoded);
  let samples = mono.samples;
  const originalSeconds = samples.length / SAMPLE_RATE;

  onProgress('音量を整えています…');
  samples = highPass(samples, hpCutoff);
  const norm = normalize(samples, { maxGain });
  samples = norm.samples;

  let level = null;
  if (trim) {
    onProgress('無音を詰めています…');
    const res = trimSilence(samples);
    samples = res.samples;
    level = res;
  }
  const seconds = samples.length / SAMPLE_RATE;

  // 音声がほとんど無いまま送ると、Whisperが無関係な定型文を延々と返してくる。
  // 送る前にここで止めて、利用者に理由を伝える。
  if (seconds < 1) {
    throw new Error(
      `このファイルからは音声が検出できませんでした（${fmtDuration(originalSeconds)}中0秒）。` +
        '録音の音量が小さすぎるか、話し声が入っていない可能性があります。',
    );
  }

  const chunks = [];
  const per = CHUNK_SECONDS * SAMPLE_RATE;
  for (let i = 0; i < samples.length; i += per) {
    chunks.push(toWav(samples.subarray(i, Math.min(i + per, samples.length))));
  }
  return {
    chunks,
    seconds,
    originalSeconds,
    gain: norm.gain,
    // 耳と数値で原因を判断できるようにする
    diagnostics: {
      チャンネル数: mono.channels,
      左右の相関: mono.correlation === null ? '—' : mono.correlation.toFixed(2),
      増幅率: `${norm.gain.toFixed(1)}倍`,
      暗騒音: level ? level.floor.toFixed(4) : '—',
      判定しきい値: level ? level.threshold.toFixed(4) : '—',
      最大振幅: level ? level.loudest.toFixed(3) : '—',
      元の長さ: fmtDuration(originalSeconds),
      音声として残った長さ: fmtDuration(seconds),
    },
  };
}

export const fmtDuration = (s) => `${Math.floor(s / 60)}分${String(Math.round(s % 60)).padStart(2, '0')}秒`;
