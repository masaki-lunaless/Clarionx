// 端末に残すのは接続設定と実施者名だけ。
// 案件・判断基準・モード・実施記録はすべてWorker側のD1にある。
const KEY = 'clarion.settings.v2';

// 配布先はこの1つなので、接続先は既定で入れておく。
// 初見の人に URL を打たせるのは、それだけで入口の障害になる。
const defaults = {
  workerUrl: 'https://clarion-proxy.lunaless.workers.dev',
  token: '', voice: '', vocabulary: '', trainee: '',
  // 次に開いたときに会社コードと個人コードを出すため（パスワードは保存しない）
  lastCompany: '', lastStaff: '',
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
