import { api } from './api.js';
import { answeredQA, store, uid } from './store.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function status(el, message, kind = '') {
  el.textContent = message;
  el.className = `status ${kind}`;
}

function debounce(fn, ms = 400) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

async function withBusy(button, statusEl, message, task) {
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = '処理中…';
  }
  status(statusEl, message);
  try {
    const result = await task();
    // task内で完了メッセージを出した場合は消さない
    if (statusEl.textContent === message) status(statusEl, '');
    return result;
  } catch (err) {
    status(statusEl, err.message || String(err), 'error');
    throw err;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

/* ---------------------------------- タブ --------------------------------- */

$$('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t === tab));
    $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${tab.dataset.tab}`));
    if (tab.dataset.tab === 'criteria') renderQAList();
    if (tab.dataset.tab === 'practice') renderPracticeConfig();
  }),
);

/* --------------------------------- 設定 ---------------------------------- */

const settingsFields = {
  workerUrl: $('#worker-url'),
  token: $('#access-token'),
  vocabulary: $('#vocabulary'),
};

for (const [key, input] of Object.entries(settingsFields)) {
  input.value = store.state.settings[key] || '';
  input.addEventListener('input', () => {
    store.state.settings[key] = input.value;
    store.save();
  });
}

$('#test-connection').addEventListener('click', async (e) => {
  const el = $('#settings-status');
  await withBusy(e.target, el, '接続中…', async () => {
    const cfg = await api.config();
    voiceActors = cfg.voiceActors || [];
    customerTypes = cfg.customerTypes || customerTypes;
    renderPracticeConfig();
    status(
      el,
      `接続OK — 書き起こし:${cfg.stt ? '有効' : '未設定'} / 音声合成:${cfg.tts ? '有効' : '未設定'} / 声:${voiceActors.length}種`,
      'ok',
    );
  }).catch(() => {});
});

$('#export-data').addEventListener('click', () => {
  download('clarion-backup.json', store.export(), 'application/json');
});

$('#import-data').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    store.import(await file.text());
    location.reload();
  } catch (err) {
    status($('#settings-status'), `読み込み失敗：${err.message}`, 'error');
  }
});

$('#reset-data').addEventListener('click', () => {
  if (confirm('この端末に保存されたClarionのデータをすべて消します。よろしいですか？')) {
    store.reset();
    location.reload();
  }
});

function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* --------------------------- ① 「なぜ」を聞く ---------------------------- */

let currentSessionId = store.state.sessions[0]?.id || null;

const currentSession = () => store.state.sessions.find((s) => s.id === currentSessionId) || null;

function renderSessionList() {
  const list = $('#session-list');
  list.innerHTML = store.state.sessions
    .map((s) => {
      const total = (s.turningPoints || []).reduce((n, tp) => n + tp.questions.length, 0);
      const done = (s.turningPoints || []).reduce(
        (n, tp) => n + tp.questions.filter((q) => (q.answer || '').trim()).length,
        0,
      );
      return `<li><button class="session-item ${s.id === currentSessionId ? 'is-active' : ''}" data-id="${s.id}">
        <span class="session-name">${esc(s.title || '（無題）')}</span>
        <span class="session-meta">${total ? `${done}/${total} 回答` : '未検出'}</span>
      </button></li>`;
    })
    .join('');
}

$('#session-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.session-item');
  if (!btn) return;
  currentSessionId = btn.dataset.id;
  renderSessionList();
  renderSessionDetail();
});

$('#new-session').addEventListener('click', () => {
  const session = {
    id: uid(),
    title: `セッション ${store.state.sessions.length + 1}`,
    createdAt: new Date().toISOString(),
    context: '',
    transcript: '',
    turningPoints: [],
  };
  store.state.sessions.unshift(session);
  currentSessionId = session.id;
  store.save();
  renderSessionList();
  renderSessionDetail();
  $('#session-title').focus();
});

$('#delete-session').addEventListener('click', () => {
  const s = currentSession();
  if (!s || !confirm(`「${s.title}」を削除します。よろしいですか？`)) return;
  store.state.sessions = store.state.sessions.filter((x) => x.id !== s.id);
  currentSessionId = store.state.sessions[0]?.id || null;
  store.save();
  renderSessionList();
  renderSessionDetail();
});

const saveSessionField = debounce((field, value) => {
  const s = currentSession();
  if (!s) return;
  s[field] = value;
  store.save();
  if (field === 'title') renderSessionList();
});

$('#session-title').addEventListener('input', (e) => saveSessionField('title', e.target.value));
$('#session-context').addEventListener('input', (e) => saveSessionField('context', e.target.value));
$('#session-transcript').addEventListener('input', (e) => saveSessionField('transcript', e.target.value));

function renderSessionDetail() {
  const s = currentSession();
  $('#session-empty').hidden = Boolean(s);
  $('#session-body').hidden = !s;
  if (!s) return;
  $('#session-title').value = s.title || '';
  $('#session-context').value = s.context || '';
  $('#session-transcript').value = s.transcript || '';
  renderTurningPoints();
}

function renderTurningPoints() {
  const s = currentSession();
  const root = $('#turning-points');
  if (!s || !(s.turningPoints || []).length) {
    root.innerHTML = '';
    return;
  }
  root.innerHTML = s.turningPoints
    .map(
      (tp, i) => `
    <article class="card" data-tp="${tp.id}">
      <header class="card-head">
        <span class="badge">転換点 ${i + 1}</span>
        <h3>${esc(tp.label)}</h3>
      </header>
      <blockquote>${esc(tp.quote)}</blockquote>
      <p class="why">${esc(tp.why)}</p>
      ${tp.questions
        .map(
          (q) => `
        <div class="qa" data-q="${q.id}">
          <p class="question">${esc(q.question)}</p>
          <textarea class="input answer" data-q="${q.id}" rows="3" placeholder="本人の回答をそのまま書き取る">${esc(q.answer || '')}</textarea>
          <div class="row row-end">
            <span class="status inline" data-status="${q.id}"></span>
            <button class="btn btn-ghost btn-sm dig" data-q="${q.id}">もう一段掘る</button>
          </div>
        </div>`,
        )
        .join('')}
    </article>`,
    )
    .join('');
}

function saveAnswer(e) {
  const ta = e.target.closest('textarea.answer');
  if (!ta) return;
  const s = currentSession();
  for (const tp of s.turningPoints) {
    const q = tp.questions.find((x) => x.id === ta.dataset.q);
    if (q) {
      q.answer = ta.value;
      store.save();
      renderSessionList();
      return;
    }
  }
}

$('#turning-points').addEventListener('input', debounce(saveAnswer, 500));
$('#turning-points').addEventListener('change', saveAnswer); // blur時に取りこぼさない

$('#turning-points').addEventListener('click', async (e) => {
  const btn = e.target.closest('.dig');
  if (!btn) return;
  const s = currentSession();
  const qid = btn.dataset.q;
  const tp = s.turningPoints.find((t) => t.questions.some((q) => q.id === qid));
  const q = tp.questions.find((x) => x.id === qid);
  const statusEl = $(`[data-status="${qid}"]`, $('#turning-points'));
  const answer = $(`textarea.answer[data-q="${qid}"]`).value.trim();
  if (!answer) {
    status(statusEl, '先に回答を書いてください', 'error');
    return;
  }
  await withBusy(btn, statusEl, '追加質問を作成中…', async () => {
    const out = await api.followUp(q.question, answer, tp.quote);
    if (out.enough || !(out.questions || []).length) {
      status(statusEl, `十分に言語化できています（${out.reason || ''}）`, 'ok');
      return;
    }
    q.answer = answer;
    const idx = tp.questions.indexOf(q);
    tp.questions.splice(idx + 1, 0, ...out.questions.map((text) => ({ id: uid(), question: text, answer: '' })));
    store.save();
    renderTurningPoints();
  }).catch(() => {});
});

function syncSessionFields() {
  const s = currentSession();
  if (!s) return null;
  s.title = $('#session-title').value;
  s.context = $('#session-context').value;
  s.transcript = $('#session-transcript').value;
  store.save();
  return s;
}

$('#detect-btn').addEventListener('click', async (e) => {
  const s = syncSessionFields();
  const statusEl = $('#interview-status');
  if (!s || !(s.transcript || '').trim()) {
    status(statusEl, '書き起こしを入れてください', 'error');
    return;
  }
  await withBusy(e.target, statusEl, '転換点を検出中…（30秒ほどかかります）', async () => {
    const { turningPoints } = await api.questions(s.transcript, s.context);
    const incoming = turningPoints.map((tp) => ({
      id: uid(),
      label: tp.label,
      quote: tp.quote,
      why: tp.why,
      questions: (tp.questions || []).map((text) => ({ id: uid(), question: text, answer: '' })),
    }));
    // 既存の回答は消さない。検出のたびに追記していく
    s.turningPoints = [...(s.turningPoints || []), ...incoming];
    store.save();
    renderTurningPoints();
    renderSessionList();
  }).catch(() => {});
});

$('#audio-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const s = syncSessionFields();
  const statusEl = $('#interview-status');
  if (!s) return;
  await withBusy(null, statusEl, `${file.name} を書き起こし中…（長い音声は数分かかります）`, async () => {
    const { transcript } = await api.stt(file, { vocabulary: store.state.settings.vocabulary }, file.name);
    s.transcript = [s.transcript, transcript].filter(Boolean).join('\n');
    store.save();
    $('#session-transcript').value = s.transcript;
  }).catch(() => {});
});

/* 一括インポート */
$('#bulk-import').addEventListener('click', () => $('#bulk-dialog').showModal());
$('#bulk-dialog').addEventListener('close', () => {
  if ($('#bulk-dialog').returnValue !== 'ok') return;
  const raw = $('#bulk-json').value.trim();
  if (!raw) return;
  try {
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error('配列で渡してください');
    for (const item of items) {
      store.state.sessions.unshift({
        id: uid(),
        title: item.title || `インポート ${new Date().toLocaleDateString('ja-JP')}`,
        createdAt: new Date().toISOString(),
        context: item.context || '',
        transcript: item.text || item.transcript || '',
        turningPoints: (item.qa || []).length
          ? [
              {
                id: uid(),
                label: 'インポート',
                quote: item.quote || '',
                why: '外部から取り込んだQ&A',
                questions: item.qa.map((q) => ({ id: uid(), question: q.question, answer: q.answer || '' })),
              },
            ]
          : [],
      });
    }
    store.save();
    $('#bulk-json').value = '';
    currentSessionId = store.state.sessions[0].id;
    renderSessionList();
    renderSessionDetail();
  } catch (err) {
    alert(`インポート失敗：${err.message}`);
  }
});

/* --------------------------- ② 判断基準にする ---------------------------- */

let selectedQA = new Set();

function renderQAList() {
  const items = answeredQA(store.state.sessions);
  const list = $('#qa-list');
  if (!items.length) {
    list.innerHTML = '<li class="empty-note">回答済みのQ&amp;Aがまだありません。①で質問に回答してください。</li>';
    return;
  }
  if (selectedQA.size === 0) items.forEach((i) => selectedQA.add(i.id));
  list.innerHTML = items
    .map(
      (item) => `<li><label class="qa-item">
        <input type="checkbox" data-qa="${item.id}" ${selectedQA.has(item.id) ? 'checked' : ''}>
        <span>
          <span class="qa-session">${esc(item.sessionTitle || '')}</span>
          <span class="qa-q">${esc(item.question)}</span>
        </span>
      </label></li>`,
    )
    .join('');
}

$('#qa-list').addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-qa]');
  if (!cb) return;
  cb.checked ? selectedQA.add(cb.dataset.qa) : selectedQA.delete(cb.dataset.qa);
});

$('#qa-toggle-all').addEventListener('click', () => {
  const items = answeredQA(store.state.sessions);
  const allOn = items.every((i) => selectedQA.has(i.id));
  selectedQA = allOn ? new Set() : new Set(items.map((i) => i.id));
  renderQAList();
});

$('#synthesize-btn').addEventListener('click', async (e) => {
  const statusEl = $('#criteria-status');
  const qa = answeredQA(store.state.sessions).filter((i) => selectedQA.has(i.id));
  if (!qa.length) {
    status(statusEl, 'Q&Aを1件以上選んでください', 'error');
    return;
  }
  await withBusy(e.target, statusEl, `${qa.length}件を統合中…（1分ほどかかります）`, async () => {
    const { markdown, document: doc } = await api.criteria(
      qa.map(({ question, answer, quote }) => ({ question, answer, quote })),
      $('#criteria-notes').value,
    );
    const record = {
      id: uid(),
      title: doc.title || '判断基準ドキュメント',
      createdAt: new Date().toISOString(),
      markdown,
      sourceCount: qa.length,
    };
    store.state.criteria.unshift(record);
    store.state.activeCriteriaId = record.id;
    store.save();
    renderCriteria();
  }).catch(() => {});
});

function activeCriteria() {
  return store.state.criteria.find((c) => c.id === store.state.activeCriteriaId) || null;
}

function renderCriteria() {
  const select = $('#criteria-select');
  select.innerHTML = store.state.criteria.length
    ? store.state.criteria
        .map(
          (c) =>
            `<option value="${c.id}" ${c.id === store.state.activeCriteriaId ? 'selected' : ''}>${esc(c.title)}（${new Date(c.createdAt).toLocaleDateString('ja-JP')}／${c.sourceCount || 0}件）</option>`,
        )
        .join('')
    : '<option value="">まだありません</option>';
  $('#criteria-doc').value = activeCriteria()?.markdown || '';
  renderPracticeConfig();
}

$('#criteria-select').addEventListener('change', (e) => {
  store.state.activeCriteriaId = e.target.value || null;
  store.save();
  renderCriteria();
});

function saveCriteriaDoc(e) {
  const c = activeCriteria();
  if (!c) return;
  c.markdown = e.target.value;
  store.save();
}

$('#criteria-doc').addEventListener('input', debounce(saveCriteriaDoc, 500));
$('#criteria-doc').addEventListener('change', saveCriteriaDoc);

$('#criteria-copy').addEventListener('click', async () => {
  const c = activeCriteria();
  if (!c) return;
  await navigator.clipboard.writeText(c.markdown);
  status($('#criteria-status'), 'コピーしました', 'ok');
});

$('#criteria-download').addEventListener('click', () => {
  const c = activeCriteria();
  if (c) download(`${c.title || 'criteria'}.md`, c.markdown, 'text/markdown');
});

$('#criteria-delete').addEventListener('click', () => {
  const c = activeCriteria();
  if (!c || !confirm(`「${c.title}」を削除します。よろしいですか？`)) return;
  store.state.criteria = store.state.criteria.filter((x) => x.id !== c.id);
  store.state.activeCriteriaId = store.state.criteria[0]?.id || null;
  store.save();
  renderCriteria();
});

/* ------------------------------ ③ 練習する ------------------------------- */

let customerTypes = [
  { id: 'undecided', label: '迷い客' },
  { id: 'price', label: '価格重視' },
  { id: 'silent', label: '寡黙' },
  { id: 'expert', label: '知識豊富' },
  { id: 'complaint', label: '不満・クレーム気味' },
  { id: 'kaitori', label: '買取相談' },
  { id: 'accompanied', label: '同伴者あり' },
];
let voiceActors = [];
let run = null; // { criteriaId, customerType, scenario, history: [] }

function renderPracticeConfig() {
  const cSel = $('#practice-criteria');
  cSel.innerHTML = store.state.criteria.length
    ? store.state.criteria
        .map((c) => `<option value="${c.id}" ${c.id === store.state.activeCriteriaId ? 'selected' : ''}>${esc(c.title)}</option>`)
        .join('')
    : '<option value="">②で判断基準を作ってください</option>';

  const tSel = $('#customer-type');
  const keep = tSel.value;
  tSel.innerHTML = customerTypes.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join('');
  if (keep) tSel.value = keep;

  const vSel = $('#voice-actor');
  const keepVoice = store.state.settings.voiceActorId;
  vSel.innerHTML = [
    '<option value="">Worker既定の声</option>',
    ...voiceActors.map(
      (v) => `<option value="${v.id}" ${v.id === keepVoice ? 'selected' : ''}>${esc(v.name)}${v.age ? `（${esc(v.age)}）` : ''}</option>`,
    ),
  ].join('');

  $('#practice-hint').textContent = store.state.criteria.length
    ? '録音ボタンを押して話し、もう一度押すと客が返します。'
    : '判断基準がなくても練習はできますが、採点には②のドキュメントが必要です。';
}

$('#voice-actor').addEventListener('change', (e) => {
  store.state.settings.voiceActorId = e.target.value;
  store.save();
});

function criteriaText() {
  const id = $('#practice-criteria').value;
  return store.state.criteria.find((c) => c.id === id)?.markdown || '';
}

function renderConvo() {
  const root = $('#convo');
  root.innerHTML = (run?.history || [])
    .map(
      (m) =>
        `<div class="bubble ${m.role}"><span class="who">${m.role === 'trainee' ? 'あなた' : 'お客様'}</span><p>${esc(m.text)}</p></div>`,
    )
    .join('');
  root.scrollTop = root.scrollHeight;
}

function setPracticeEnabled(on) {
  $('#record-btn').disabled = !on;
  $('#text-input').disabled = !on;
  $('#send-text').disabled = !on;
  $('#score-run').disabled = !on || !(run?.history || []).length;
}

$('#start-run').addEventListener('click', async (e) => {
  run = {
    id: uid(),
    criteriaId: $('#practice-criteria').value,
    customerType: $('#customer-type').value,
    scenario: $('#scenario').value,
    history: [],
    createdAt: new Date().toISOString(),
  };
  $('#score-result').innerHTML = '';
  renderConvo();
  setPracticeEnabled(true);
  unlockAudio();
  await withBusy(e.target, $('#practice-status'), 'お客様が来店中…', async () => {
    const out = await api.turn({
      opening: true,
      history: [],
      criteria: criteriaText(),
      customerType: run.customerType,
      scenario: run.scenario,
      voiceActorId: store.state.settings.voiceActorId || undefined,
    });
    pushCustomer(out);
  }).catch(() => {});
});

function pushCustomer(out) {
  run.history.push({ role: 'customer', text: out.replyText });
  renderConvo();
  play(out.replyText, out.audioUrl);
  $('#score-run').disabled = false;
}

async function sendTurn({ audio, filename, text }) {
  const statusEl = $('#practice-status');
  // 今回の発話はhistoryではなくtext/audioとして送るので、送信前の履歴を控えておく
  const history = run.history.map((m) => ({ role: m.role, text: m.text }));
  if (text) {
    run.history.push({ role: 'trainee', text });
    renderConvo();
  }
  status(statusEl, audio ? '聞き取り中…お客様が考えています' : 'お客様が考えています…');
  try {
    const payload = {
      text,
      history,
      criteria: criteriaText(),
      customerType: run.customerType,
      scenario: run.scenario,
      vocabulary: store.state.settings.vocabulary,
      voiceActorId: store.state.settings.voiceActorId || undefined,
    };
    const out = await api.turn(payload, audio, filename);
    if (!text && out.transcript) {
      run.history.push({ role: 'trainee', text: out.transcript });
    }
    pushCustomer(out);
    status(statusEl, '');
  } catch (err) {
    status(statusEl, err.message, 'error');
  }
}

$('#send-text').addEventListener('click', () => {
  const input = $('#text-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  unlockAudio();
  sendTurn({ text });
});

$('#text-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#send-text').click();
});

$('#score-run').addEventListener('click', async (e) => {
  const criteria = criteriaText();
  const statusEl = $('#practice-status');
  if (!criteria) {
    status(statusEl, '採点には②の判断基準ドキュメントが必要です', 'error');
    return;
  }
  await withBusy(e.target, statusEl, '採点中…', async () => {
    const score = await api.score(run.history, criteria);
    run.score = score;
    store.state.runs.unshift(run);
    store.save();
    renderScore(score);
  }).catch(() => {});
});

function renderScore(s) {
  $('#score-result').innerHTML = `
    <div class="card score">
      <header class="card-head"><span class="total">${esc(s.total)}<small>/100</small></span><h3>${esc(s.headline)}</h3></header>
      <div class="axes">
        ${(s.per_axis || [])
          .map(
            (a) => `<div class="axis">
              <div class="axis-head"><strong>${esc(a.axis)}</strong><span class="stars">${'★'.repeat(Math.round(a.score))}${'☆'.repeat(Math.max(0, 5 - Math.round(a.score)))}</span></div>
              <p class="evidence">${esc(a.evidence)}</p>
              <p class="advice">→ ${esc(a.advice)}</p>
            </div>`,
          )
          .join('')}
      </div>
      ${(s.good || []).length ? `<h4>良かった点</h4><ul>${s.good.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
      ${(s.next || []).length ? `<h4>次に意識すること</h4><ul>${s.next.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}
    </div>`;
}

/* ------------------------------ 録音・再生 ------------------------------- */

const player = $('#player');
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
let audioUnlocked = false;

// iOS Safariはユーザー操作の中でしか再生を開始できない。
// 録音ボタンを押した瞬間に無音を再生して、以降のプログラム再生を許可させる。
function unlockAudio() {
  if (audioUnlocked) return;
  player.src = SILENT_WAV;
  player.play().then(
    () => {
      audioUnlocked = true;
    },
    () => {},
  );
}

function play(text, audioUrl) {
  if (audioUrl) {
    player.src = audioUrl;
    player.play().catch(() => speak(text));
    return;
  }
  speak(text);
}

// にじボイス未設定・失敗時のフォールバック
function speak(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  speechSynthesis.speak(u);
}

let mediaRecorder = null;
let chunks = [];
let stream = null;

function pickMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
  return candidates.find((c) => window.MediaRecorder?.isTypeSupported?.(c)) || '';
}

$('#record-btn').addEventListener('click', async () => {
  unlockAudio();
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  const statusEl = $('#practice-status');
  try {
    if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMime();
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks = [];
    mediaRecorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mediaRecorder.onstop = () => {
      setRecordingUI(false);
      const type = mediaRecorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type });
      const ext = type.includes('mp4') || type.includes('aac') ? 'mp4' : 'webm';
      if (blob.size > 0) sendTurn({ audio: blob, filename: `turn.${ext}` });
    };
    mediaRecorder.start();
    setRecordingUI(true);
    status(statusEl, '録音中…もう一度押すと送信します');
  } catch (err) {
    status(statusEl, `マイクを使えません：${err.message}。テキスト入力で練習できます。`, 'error');
  }
});

function setRecordingUI(on) {
  $('#record-btn').classList.toggle('is-recording', on);
  $('#record-label').textContent = on ? '停止して送信' : '押して話す';
}

/* -------------------------------- 初期化 --------------------------------- */

renderSessionList();
renderSessionDetail();
renderCriteria();
renderQAList();
setPracticeEnabled(false);

if (store.state.settings.workerUrl) {
  api
    .config()
    .then((cfg) => {
      voiceActors = cfg.voiceActors || [];
      customerTypes = cfg.customerTypes || customerTypes;
      renderPracticeConfig();
    })
    .catch(() => {});
}
