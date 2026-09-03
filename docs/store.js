// 端末に残すのは接続設定と実施者名だけ。
// 案件・判断基準・モード・実施記録はすべてWorker側のD1にある。
const KEY = 'clarion.settings.v2';

const defaults = {
  workerUrl: '', token: '', voice: '', vocabulary: '', trainee: '',
  // 取り込みの調整（既定は media.js の DEFAULTS と揃える）
  hpCutoff: 100, maxGain: 20, silenceFactor: 4, trim: true,
};

function load() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

const state = load();

export const settings = {
  get: (key) => state[key],
  all: () => ({ ...state }),
  set(key, value) {
    state[key] = value;
    localStorage.setItem(KEY, JSON.stringify(state));
  },
};

export const uid = () => Math.random().toString(36).slice(2, 10);
