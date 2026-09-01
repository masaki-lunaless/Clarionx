// 端末内（localStorage）に全データを保持する。
// 顧客ごとにデータを分ける段階になったらWorker側にKV/D1を足して移す想定。
const KEY = 'clarion.v1';

const empty = () => ({
  settings: { workerUrl: '', token: '', voiceActorId: '', vocabulary: '' },
  sessions: [],
  criteria: [],
  activeCriteriaId: null,
  runs: [],
});

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    return { ...empty(), ...JSON.parse(raw) };
  } catch {
    return empty();
  }
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const store = {
  state: load(),
  listeners: new Set(),
  save() {
    localStorage.setItem(KEY, JSON.stringify(this.state));
    this.listeners.forEach((fn) => fn(this.state));
  },
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  reset() {
    this.state = empty();
    this.save();
  },
  export() {
    return JSON.stringify(this.state, null, 2);
  },
  import(json) {
    const data = JSON.parse(json);
    this.state = { ...empty(), ...data };
    this.save();
  },
};

/** 回答済みQ&Aだけを平坦化して取り出す（判断基準の統合に渡す形） */
export function answeredQA(sessions) {
  const out = [];
  for (const s of sessions) {
    for (const tp of s.turningPoints || []) {
      for (const q of tp.questions || []) {
        if ((q.answer || '').trim()) {
          out.push({
            sessionId: s.id,
            sessionTitle: s.title,
            tpId: tp.id,
            id: q.id,
            quote: tp.quote,
            question: q.question,
            answer: q.answer,
          });
        }
      }
    }
  }
  return out;
}
