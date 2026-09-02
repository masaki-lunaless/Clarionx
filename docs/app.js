import { api, ClarionError } from './api.js';
import { settings } from './store.js';
import { canExtract, extractChunks, fmtDuration } from './media.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function status(el, message, kind = '') {
  el.textContent = message;
  el.className = `status ${kind}`;
}

const debounce = (fn, ms = 500) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/** 実行中はボタンを止め、失敗したらstatusにだけ出す（画面は壊さない） */
async function run(button, statusEl, message, task) {
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = '処理中…';
  }
  status(statusEl, message);
  try {
    const result = await task();
    if (statusEl.textContent === message) status(statusEl, '');
    return result;
  } catch (err) {
    status(statusEl, err instanceof ClarionError ? err.message : String(err?.message || err), 'error');
    return null;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

/* -------------------------------- 全体状態 ------------------------------- */

let config = { customerTypes: [], voices: [], feedbackOptions: { realism: [], scoring: [] }, admin: true };
let cases = [];
let criteriaList = [];
let modes = [];
let current = { caseId: null, case: null, modeId: null, run: null, criteriaId: null };

/* ---------------------------------- タブ --------------------------------- */

async function activateTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${name}`));
  if (name === 'practice') await refreshModes();
  if (name === 'merge') await refreshMerge();
  if (name === 'records') await refreshRecords();
}

$$('.tab').forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));

/**
 * 接続していないことを常に画面に出す。
 * これが無いと、未接続のまま操作して「何も起きない」状態になる。
 */
function setConnected(ok, message) {
  // 配信直後は古いHTMLと新しいJSが混ざることがある（GitHub Pagesのキャッシュは10分）。
  // 要素が無い版のHTMLでも起動処理が止まらないよう、存在を確かめてから触る。
  const banner = $('#connect-banner');
  if (!banner) return;
  banner.hidden = ok;
  const msg = $('#connect-message');
  if (!ok && message && msg) msg.textContent = message;
}

$('#go-settings')?.addEventListener('click', () => activateTab('settings'));

/* --------------------------------- 設定 ---------------------------------- */

for (const [key, sel] of Object.entries({ workerUrl: '#worker-url', token: '#access-token', vocabulary: '#vocabulary', trainee: '#trainee' })) {
  const input = $(sel);
  input.value = settings.get(key) || '';
  input.addEventListener('input', () => settings.set(key, input.value));
}

$('#test-connection').addEventListener('click', async (e) => {
  const el = $('#settings-status');
  const cfg = await run(e.target, el, '接続中…', () => api.config());
  if (!cfg) return;
  applyConfig(cfg);
  setConnected(true);
  status(el, `接続OK — ${cfg.client} / 書き起こし:${cfg.stt ? '有効' : '未設定'} / 音声合成:${cfg.tts || '未設定'}${cfg.admin ? ' / 管理者' : ''}`, 'ok');
  await refreshAll();
  // 初回は練習から触ってもらうのが分かりやすい
  if (!cases.length && modes.length) await activateTab('practice');
});

function applyConfig(cfg) {
  config = { ...config, ...cfg };
  const fill = (el, options, selected) => {
    el.innerHTML = options.map((o) => `<option value="${esc(o.value ?? o.id)}" ${(o.value ?? o.id) === selected ? 'selected' : ''}>${esc(o.label ?? o.name)}</option>`).join('');
  };
  fill($('#fb-realism'), [{ value: '', label: '（未評価）' }, ...config.feedbackOptions.realism]);
  fill($('#fb-scoring'), [{ value: '', label: '（未評価）' }, ...config.feedbackOptions.scoring]);
  fill($('#mode-customer'), config.customerTypes);
  fill($('#mode-voice'), [{ value: '', label: 'Worker既定の声' }, ...config.voices]);
}

/* -------------------------------- ① 蓄積 -------------------------------- */

async function refreshCases() {
  const data = await api.listCases().catch(() => null);
  if (!data) return;
  cases = data.cases;
  renderCaseList();
  renderMergeCaseList();
}

function renderCaseList() {
  $('#case-list').innerHTML = cases
    .map(
      (c) => `<li><button class="item ${c.id === current.caseId ? 'is-active' : ''}" data-id="${c.id}">
        <span class="item-name">${esc(c.title)}</span>
        <span class="item-meta">${esc(c.ace_name || '担当者未記入')}・${c.q_total ? `${c.q_answered}/${c.q_total} 回答` : '未検出'}</span>
      </button></li>`,
    )
    .join('');
}

$('#case-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('.item');
  if (btn) await openCase(btn.dataset.id);
});

async function openCase(id) {
  const data = await api.getCase(id).catch(() => null);
  if (!data) return;
  current.caseId = id;
  current.case = data.case;
  renderCaseList();
  renderCase();
}

function renderCase() {
  const c = current.case;
  $('#case-empty').hidden = Boolean(c);
  $('#case-body').hidden = !c;
  if (!c) return;
  $('#case-title').value = c.title || '';
  $('#case-ace').value = c.ace_name || '';
  $('#case-date').value = c.occurred_on || '';
  $('#case-context').value = c.context || '';
  $('#case-transcript').value = c.transcript || '';
  renderTurningPoints();
}

async function createCase() {
  // 案件が無いときは #capture-status が隠れているので、空画面側に出す
  const statusEl = current.case ? $('#capture-status') : $('#capture-empty-status');
  const data = await run(null, statusEl, '作成中…', () =>
    api.createCase({ title: `案件 ${cases.length + 1}`, transcript: '' }),
  );
  if (!data) return;
  await refreshCases();
  await openCase(data.case.id);
  $('#case-title').select();
}

$('#new-case').addEventListener('click', createCase);
$('#new-case-empty')?.addEventListener('click', createCase);

$('#delete-case').addEventListener('click', async () => {
  if (!confirm(`「${current.case.title}」を削除します。転換点と回答も消えます。よろしいですか？`)) return;
  if (!(await run(null, $('#capture-status'), '削除中…', () => api.deleteCase(current.caseId)))) return;
  current.caseId = null;
  current.case = null;
  await refreshCases();
  renderCase();
});

const saveCaseField = debounce(async (field, value) => {
  if (!current.caseId) return;
  await api.updateCase(current.caseId, { [field]: value }).catch(() => {});
  const row = cases.find((c) => c.id === current.caseId);
  if (row) {
    if (field === 'title') row.title = value;
    if (field === 'aceName') row.ace_name = value;
    renderCaseList();
  }
});

const bindCaseField = (sel, field) => {
  const el = $(sel);
  const save = () => saveCaseField(field, el.value);
  el.addEventListener('input', save);
  el.addEventListener('change', () => {
    if (current.case) current.case[field === 'aceName' ? 'ace_name' : field === 'occurredOn' ? 'occurred_on' : field] = el.value;
    save();
  });
};
bindCaseField('#case-title', 'title');
bindCaseField('#case-ace', 'aceName');
bindCaseField('#case-date', 'occurredOn');
bindCaseField('#case-context', 'context');
bindCaseField('#case-transcript', 'transcript');

$('#audio-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !current.caseId) return;
  const el = $('#capture-status');

  // 映像込みのMP4をそのまま送ると上限に当たるので、ブラウザ内で音声だけ抜いて分割する
  if (!canExtract()) {
    status(el, 'このブラウザでは動画から音声を取り出せません。tools/extract-audio.sh で変換してから読み込んでください', 'error');
    return;
  }

  let extracted;
  try {
    extracted = await extractChunks(file, { onProgress: (msg) => status(el, `${file.name}：${msg}`) });
  } catch (err) {
    status(el, err.message, 'error');
    return;
  }

  const { chunks, seconds, originalSeconds } = extracted;
  const trimmed = originalSeconds - seconds;
  const note = trimmed > 30 ? `（無音 ${fmtDuration(trimmed)} を除去）` : '';

  const texts = [];
  for (const [i, chunk] of chunks.entries()) {
    status(el, `書き起こし中… ${i + 1}/${chunks.length} 個目 ${note}`);
    try {
      const data = await api.transcribe(current.caseId, chunk, { vocabulary: settings.get('vocabulary') }, `part${i + 1}.wav`);
      current.case = data.case;
      texts.push(data.added);
      $('#case-transcript').value = data.case.transcript;
    } catch (err) {
      // 途中で失敗しても、そこまでの書き起こしは案件に残っている
      status(el, `${i + 1}個目で失敗：${err.message}（${i}個目までは保存済み）`, 'error');
      return;
    }
  }
  status(el, `完了：${fmtDuration(seconds)} 分を ${chunks.length} 回に分けて書き起こしました ${note}`, 'ok');
});

$('#detect-btn').addEventListener('click', async (e) => {
  const el = $('#capture-status');
  if (!$('#case-transcript').value.trim()) {
    status(el, '書き起こしを入れてください', 'error');
    return;
  }
  // 未保存の編集を確定させてから検出する
  await api.updateCase(current.caseId, { transcript: $('#case-transcript').value }).catch(() => {});
  const data = await run(e.target, el, '転換点を検出中…（30秒ほどかかります）', () => api.detect(current.caseId));
  if (!data) return;
  current.case = data.case;
  renderTurningPoints();
  await refreshCases();
});

function renderTurningPoints() {
  const tps = current.case?.turningPoints || [];
  $('#turning-points').innerHTML = tps
    .map(
      (tp, i) => `
    <article class="card">
      <header class="card-head"><span class="badge">転換点 ${i + 1}</span><h3>${esc(tp.label)}</h3></header>
      <blockquote>${esc(tp.quote)}</blockquote>
      <p class="why">${esc(tp.why)}</p>
      ${tp.questions
        .map(
          (q) => `<div class="qa">
            <p class="question">${esc(q.question)}</p>
            <textarea class="input answer" data-q="${q.id}" rows="3" placeholder="本人の回答をそのまま書き取る">${esc(q.answer || '')}</textarea>
            <div class="row row-end">
              <span class="status inline" data-status="${q.id}"></span>
              <button class="btn btn-ghost btn-sm dig" data-q="${q.id}" data-quote="${esc(tp.quote)}">もう一段掘る</button>
            </div>
          </div>`,
        )
        .join('')}
    </article>`,
    )
    .join('');
}

const saveAnswer = debounce(async (id, value) => {
  await api.saveAnswer(id, value).catch(() => {});
  await refreshCases();
});

$('#turning-points').addEventListener('input', (e) => {
  const ta = e.target.closest('textarea.answer');
  if (ta) saveAnswer(ta.dataset.q, ta.value);
});

$('#turning-points').addEventListener('click', async (e) => {
  const btn = e.target.closest('.dig');
  if (!btn) return;
  const id = btn.dataset.q;
  const statusEl = $(`[data-status="${id}"]`);
  const ta = $(`textarea.answer[data-q="${id}"]`);
  const question = ta.closest('.qa').querySelector('.question').textContent;
  if (!ta.value.trim()) {
    status(statusEl, '先に回答を書いてください', 'error');
    return;
  }
  const out = await run(btn, statusEl, '追加質問を作成中…', () =>
    api.followUp(id, { question, answer: ta.value.trim(), quote: btn.dataset.quote }),
  );
  if (!out) return;
  if (out.enough) {
    status(statusEl, `十分に言語化できています（${out.reason}）`, 'ok');
    return;
  }
  await openCase(current.caseId);
});

/* ------------------------------ ② ロープレ ------------------------------ */

async function refreshModes() {
  const data = await api.listModes().catch(() => null);
  if (!data) return;
  modes = data.modes;
  renderModeList();
}

function renderModeList() {
  $('#mode-list').innerHTML = modes.length
    ? modes
        .map(
          (m) => `<li><button class="item ${m.id === current.modeId ? 'is-active' : ''}" data-id="${m.id}">
            <span class="item-name">${esc(m.name)}</span>
            <span class="item-meta">${esc(m.criteria_title)}・実施${m.run_count}回</span>
          </button></li>`,
        )
        .join('')
    : '<li class="empty-note">③でモードを作ってください</li>';
}

$('#mode-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.item');
  if (!btn) return;
  current.modeId = btn.dataset.id;
  const mode = modes.find((m) => m.id === current.modeId);
  renderModeList();
  $('#practice-empty').hidden = true;
  $('#practice-body').hidden = false;
  $('#run-mode-name').textContent = mode.name;
  $('#run-mode-detail').textContent = `${config.customerTypes.find((t) => t.id === mode.customer_type)?.label || mode.customer_type}${mode.scenario ? ` ／ ${mode.scenario}` : ''}`;
  $('#convo').innerHTML = '';
  $('#score-result').innerHTML = '';
  $('#feedback-box').hidden = true;
  setPractice(false);
});

$('#new-mode').addEventListener('click', () => openModeDialog());

function setPractice(on) {
  $('#record-btn').disabled = !on;
  $('#text-input').disabled = !on;
  $('#send-text').disabled = !on;
  $('#score-run').disabled = !on;
}

$('#start-run').addEventListener('click', async (e) => {
  unlockAudio();
  $('#convo').innerHTML = '';
  $('#score-result').innerHTML = '';
  $('#feedback-box').hidden = true;
  const out = await run(e.target, $('#practice-status'), 'お客様が来店中…', () =>
    api.startRun(current.modeId, settings.get('trainee')),
  );
  if (!out) return;
  current.run = out.runId;
  renderConvo(out.history);
  play(out.replyText, out.audioUrl);
  setPractice(true);
});

function renderConvo(history) {
  $('#convo').innerHTML = history
    .map(
      (m) => `<div class="bubble ${m.role}"><span class="who">${m.role === 'trainee' ? 'あなた' : 'お客様'}</span><p>${esc(m.text)}</p></div>`,
    )
    .join('');
  $('#convo').scrollTop = $('#convo').scrollHeight;
}

async function sendTurn(payload) {
  const statusEl = $('#practice-status');
  status(statusEl, payload.audio ? '聞き取り中…お客様が考えています' : 'お客様が考えています…');
  try {
    const out = await api.turn(current.run, payload);
    renderConvo(out.history);
    play(out.replyText, out.audioUrl);
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
$('#text-input').addEventListener('keydown', (e) => e.key === 'Enter' && $('#send-text').click());

$('#score-run').addEventListener('click', async (e) => {
  const out = await run(e.target, $('#practice-status'), '採点中…（1分ほどかかります）', () => api.score(current.run));
  if (!out) return;
  renderScore(out.score);
  $('#feedback-box').hidden = false;
  $('#fb-note').value = '';
  $('#fb-realism').value = '';
  $('#fb-scoring').value = '';
  status($('#fb-status'), '');
});

function renderScore(s) {
  const b = s.breakdown || {};
  $('#score-result').innerHTML = `
    <div class="card score">
      <header class="card-head"><span class="total">${esc(s.total)}<small>/100</small></span><h3>${esc(s.headline)}</h3></header>
      <div class="breakdown">
        <span class="outcome ${b.closed ? 'closed' : 'unclosed'}">${b.closed ? '成約' : '不成約'} ${b.closePenalty ? `−${b.closePenalty}` : '±0'}</span>
        <span>型の不一致 −${esc(b.axisPenalty ?? 0)}（上限−${esc(b.maxAxisPenalty ?? 90)}）</span>
      </div>
      ${s.closed_evidence ? `<p class="evidence">${esc(s.closed_evidence)}</p>` : ''}
      <div class="axes">
        ${(s.per_axis || [])
          .map(
            (a) => `<div class="axis">
              <div class="axis-head"><strong>${esc(a.axis)}</strong><span class="deduction ${a.deduction ? '' : 'zero'}">${a.deduction ? `−${esc(a.deduction)}` : '減点なし'}</span></div>
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

$('#fb-save').addEventListener('click', async (e) => {
  const ok = await run(e.target, $('#fb-status'), '送信中…', () =>
    api.feedback(current.run, {
      realism: $('#fb-realism').value || undefined,
      scoring: $('#fb-scoring').value || undefined,
      note: $('#fb-note').value,
    }),
  );
  if (ok) status($('#fb-status'), '送りました。③の統合で反映されます', 'ok');
});

/* -------------------------------- ③ 統合 -------------------------------- */

let mergeSelection = new Set();

async function refreshMerge() {
  await Promise.all([refreshCases(), refreshCriteria()]);
}

async function refreshCriteria() {
  const data = await api.listCriteria().catch(() => null);
  if (!data) return;
  criteriaList = data.criteria;
  renderCriteriaSelect();
}

function renderMergeCaseList() {
  const usable = cases.filter((c) => c.q_answered > 0);
  $('#merge-case-list').innerHTML = usable.length
    ? usable
        .map(
          (c) => `<li><label class="check-item">
            <input type="checkbox" data-case="${c.id}" ${mergeSelection.has(c.id) ? 'checked' : ''}>
            <span><span class="item-name">${esc(c.title)}</span>
            <span class="item-meta">${esc(c.ace_name || '担当者未記入')}・回答${c.q_answered}件</span></span>
          </label></li>`,
        )
        .join('')
    : '<li class="empty-note">①で回答を書き込んだ案件がここに出ます</li>';
}

$('#merge-case-list').addEventListener('change', (e) => {
  const cb = e.target.closest('input[data-case]');
  if (!cb) return;
  cb.checked ? mergeSelection.add(cb.dataset.case) : mergeSelection.delete(cb.dataset.case);
});

$('#merge-toggle-all').addEventListener('click', () => {
  const usable = cases.filter((c) => c.q_answered > 0);
  mergeSelection = usable.every((c) => mergeSelection.has(c.id)) ? new Set() : new Set(usable.map((c) => c.id));
  renderMergeCaseList();
});

$('#merge-btn').addEventListener('click', async (e) => {
  const el = $('#merge-status');
  if (!mergeSelection.size) {
    status(el, '案件を1件以上選んでください', 'error');
    return;
  }
  const feedbackCriteriaIds = $('#use-feedback').checked ? criteriaList.map((c) => c.id) : [];
  const out = await run(e.target, el, `${mergeSelection.size}件を統合中…（1分ほどかかります）`, () =>
    api.mergeCriteria({ caseIds: [...mergeSelection], notes: $('#merge-notes').value, feedbackCriteriaIds }),
  );
  if (!out) return;
  status(el, out.usedFeedback ? `統合しました（フィードバック${out.usedFeedback}件を反映）` : '統合しました', 'ok');
  await refreshCriteria();
  current.criteriaId = out.criteria.id;
  renderCriteriaSelect();
  await showCriteria(out.criteria.id);
});

function renderCriteriaSelect() {
  const sel = $('#criteria-select');
  sel.innerHTML = criteriaList.length
    ? criteriaList
        .map(
          (c) => `<option value="${c.id}" ${c.id === current.criteriaId ? 'selected' : ''}>${esc(c.title)}（案件${c.source_case_ids.length}件／実施${c.run_count}回）</option>`,
        )
        .join('')
    : '<option value="">まだありません</option>';
  const modeSel = $('#mode-criteria');
  modeSel.innerHTML = criteriaList.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`).join('');
}

$('#criteria-select').addEventListener('change', (e) => e.target.value && showCriteria(e.target.value));

async function showCriteria(id) {
  const data = await api.getCriteria(id).catch(() => null);
  if (!data) return;
  current.criteriaId = id;
  $('#criteria-doc').value = data.criteria.markdown;
  const fb = await api.criteriaFeedback(id).catch(() => ({ feedback: [] }));
  renderCriteriaFeedback(fb.feedback);
}

function renderCriteriaFeedback(list) {
  const box = $('#criteria-feedback');
  if (!list.length) {
    box.innerHTML = '';
    return;
  }
  const label = (kind, v) => config.feedbackOptions[kind]?.find((o) => o.value === v)?.label || '未評価';
  box.innerHTML = `<div class="card fb-list">
    <h4>この判断基準へのフィードバック（${list.length}件）</h4>
    <p class="hint">次の統合で、これらが判断基準の書き直しに反映されます。</p>
    ${list
      .map(
        (f) => `<div class="fb-row">
          <span class="item-meta">${esc(f.mode_name || 'モード不明')}・客:${esc(label('realism', f.fb_realism))}・採点:${esc(label('scoring', f.fb_scoring))}</span>
          ${f.fb_note ? `<p>${esc(f.fb_note)}</p>` : ''}
        </div>`,
      )
      .join('')}
  </div>`;
}

$('#criteria-doc').addEventListener(
  'input',
  debounce((e) => {
    if (current.criteriaId) api.updateCriteria(current.criteriaId, e.target.value).catch(() => {});
  }),
);

$('#criteria-download').addEventListener('click', () => {
  const c = criteriaList.find((x) => x.id === current.criteriaId);
  if (!c) return;
  const url = URL.createObjectURL(new Blob([$('#criteria-doc').value], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${c.title}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('#criteria-delete').addEventListener('click', async () => {
  const c = criteriaList.find((x) => x.id === current.criteriaId);
  if (!c || !confirm(`「${c.title}」を削除します。紐づくロープレモードも消えます。よろしいですか？`)) return;
  if (!(await run(null, $('#merge-status'), '削除中…', () => api.deleteCriteria(c.id)))) return;
  current.criteriaId = null;
  $('#criteria-doc').value = '';
  $('#criteria-feedback').innerHTML = '';
  await refreshCriteria();
});

$('#create-mode-from').addEventListener('click', () => openModeDialog(current.criteriaId));

/* ----------------------------- モード作成ダイアログ ---------------------- */

function openModeDialog(criteriaId) {
  if (!criteriaList.length) {
    alert('先に③で判断基準を統合してください。');
    return;
  }
  if (criteriaId) $('#mode-criteria').value = criteriaId;
  $('#mode-name').value = '';
  $('#mode-scenario').value = '';
  $('#mode-dialog').showModal();
}

$('#mode-dialog').addEventListener('close', async () => {
  if ($('#mode-dialog').returnValue !== 'ok') return;
  const name = $('#mode-name').value.trim();
  if (!name) return;
  const out = await api
    .createMode({
      name,
      criteriaId: $('#mode-criteria').value,
      customerType: $('#mode-customer').value,
      scenario: $('#mode-scenario').value,
      voice: $('#mode-voice').value,
    })
    .catch((err) => {
      alert(`作成できませんでした：${err.message}`);
      return null;
    });
  if (out) await refreshModes();
});

/* --------------------------------- 記録 ---------------------------------- */

let records = [];

const OUTCOME = (r) => (r.score ? (r.score.breakdown?.closed ? '成約' : '不成約') : '—');
const fbLabel = (kind, v) => config.feedbackOptions[kind]?.find((o) => o.value === v)?.label || '';
const typeLabel = (id) => config.customerTypes.find((t) => t.id === id)?.label || id || '';
const when = (iso) => (iso || '').replace('T', ' ').slice(0, 16);

async function refreshRecords() {
  await refreshCriteria();
  const sel = $('#records-filter');
  const keep = sel.value;
  sel.innerHTML = ['<option value="">すべての判断基準</option>',
    ...criteriaList.map((c) => `<option value="${c.id}">${esc(c.title)}</option>`)].join('');
  if (keep) sel.value = keep;

  const data = await run(null, $('#records-status'), '読み込み中…', () => api.listRuns(sel.value || undefined));
  if (!data) return;
  records = data.runs;
  renderRecords();
}

$('#records-filter').addEventListener('change', refreshRecords);
$('#records-reload').addEventListener('click', refreshRecords);

function renderRecords() {
  const scored = records.filter((r) => r.score);
  const closed = scored.filter((r) => r.score.breakdown?.closed).length;
  const avg = scored.length ? Math.round(scored.reduce((n, r) => n + r.score.total, 0) / scored.length) : 0;
  $('#records-summary').innerHTML = records.length
    ? `<span>${records.length}件（採点済み${scored.length}件）</span>
       <span>成約 ${closed}／${scored.length}${scored.length ? `（${Math.round((closed / scored.length) * 100)}%）` : ''}</span>
       <span>平均 ${avg}点</span>`
    : '';

  const head = ['日時', '実施者', 'モード', '客タイプ', '成約', '総合', '型の減点', '発話', '客の再現度', '採点の納得感', 'コメント'];
  $('#records-table').innerHTML = `
    <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${records
      .map(
        (r) => `<tr data-id="${r.id}">
          <td>${esc(when(r.created_at))}</td>
          <td>${esc(r.trainee || '—')}</td>
          <td>${esc(r.mode_name || '—')}</td>
          <td>${esc(typeLabel(r.customer_type))}</td>
          <td>${r.score ? `<span class="pill ${r.score.breakdown?.closed ? 'yes' : 'no'}">${OUTCOME(r)}</span>` : '—'}</td>
          <td class="num">${r.score ? esc(r.score.total) : '—'}</td>
          <td class="num">${r.score ? `−${esc(r.score.breakdown?.axisPenalty ?? 0)}` : '—'}</td>
          <td class="num">${r.history.length}</td>
          <td>${esc(fbLabel('realism', r.fb_realism))}</td>
          <td>${esc(fbLabel('scoring', r.fb_scoring))}</td>
          <td>${esc((r.fb_note || '').slice(0, 30))}</td>
        </tr>`,
      )
      .join('')}</tbody>`;
}

// 行をクリックしたら会話と減点の内訳を開く
$('#records-table').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  const open = tr.nextElementSibling?.classList.contains('detail-row');
  $$('.detail-row').forEach((el) => el.remove());
  if (open) return;
  const r = records.find((x) => x.id === tr.dataset.id);
  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  detail.innerHTML = `<td colspan="11">
    <div class="detail-convo">${r.history
      .map((m) => `<p><span class="who">${m.role === 'trainee' ? '店員' : '客　'}：</span>${esc(m.text)}</p>`)
      .join('')}</div>
    ${r.score ? `<p><strong>${esc(r.score.headline)}</strong></p>
      ${r.score.closed_evidence ? `<p class="evidence">${esc(r.score.closed_evidence)}</p>` : ''}
      <div class="axes">${(r.score.per_axis || [])
        .map((a) => `<div class="axis"><div class="axis-head"><strong>${esc(a.axis)}</strong>
          <span class="deduction ${a.deduction ? '' : 'zero'}">${a.deduction ? `−${esc(a.deduction)}` : '減点なし'}</span></div>
          <p class="evidence">${esc(a.evidence)}</p><p class="advice">→ ${esc(a.advice)}</p></div>`)
        .join('')}</div>` : '<p class="hint">この回は採点されていません。</p>'}
    ${r.fb_note ? `<p class="hint">フィードバック：${esc(r.fb_note)}</p>` : ''}
  </td>`;
  tr.after(detail);
});

$('#records-csv').addEventListener('click', () => {
  const head = ['日時', '実施者', 'モード', '判断基準', '客タイプ', '成約', '総合点', '型の減点', '発話数', '客の再現度', '採点の納得感', 'コメント', '総評'];
  const rows = records.map((r) => [
    when(r.created_at), r.trainee, r.mode_name, r.criteria_title, typeLabel(r.customer_type),
    r.score ? OUTCOME(r) : '', r.score?.total ?? '', r.score?.breakdown?.axisPenalty ?? '',
    r.history.length, fbLabel('realism', r.fb_realism), fbLabel('scoring', r.fb_scoring),
    r.fb_note, r.score?.headline ?? '',
  ]);
  const csv = [head, ...rows]
    .map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  // Excelで文字化けしないようBOMを付ける
  const url = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `clarion-records-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

/* ------------------------------ 録音・再生 ------------------------------ */

const player = $('#player');
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';
let audioUnlocked = false;
let lastObjectUrl = null;

// iOS Safariはユーザー操作の中でしか再生を開始できない。
// 操作の瞬間に無音を鳴らして、以降のプログラム再生を許可させる。
function unlockAudio() {
  if (audioUnlocked) return;
  player.src = SILENT_WAV;
  player.play().then(() => {
    audioUnlocked = true;
  }, () => {});
}

function play(text, audioUrl) {
  if (!audioUrl) {
    speak(text);
    return;
  }
  if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
  lastObjectUrl = audioUrl.startsWith('data:') ? dataUriToObjectUrl(audioUrl) : null;
  player.src = lastObjectUrl || audioUrl;
  player.play().catch(() => speak(text));
}

// data URIのままだとiOS Safariで再生できないことがあるのでBlobに戻す
function dataUriToObjectUrl(uri) {
  try {
    const [head, b64] = uri.split(',');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: head.slice(5).replace(';base64', '') }));
  } catch {
    return null;
  }
}

// TTS未設定・失敗時のフォールバック
function speak(text) {
  if (!window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  speechSynthesis.speak(u);
}

let mediaRecorder = null;
let chunks = [];
let stream = null;

const pickMime = () =>
  ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'].find((c) => window.MediaRecorder?.isTypeSupported?.(c)) || '';

$('#record-btn').addEventListener('click', async () => {
  unlockAudio();
  if (mediaRecorder?.state === 'recording') {
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
      if (blob.size) {
        sendTurn({
          audio: blob,
          filename: `turn.${type.includes('mp4') || type.includes('aac') ? 'mp4' : 'webm'}`,
          payload: { vocabulary: settings.get('vocabulary') },
        });
      }
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

/* -------------------------------- 初期化 -------------------------------- */

async function refreshAll() {
  await Promise.all([refreshCases(), refreshCriteria(), refreshModes()]);
  renderModeList();
}

(async function start() {
  if (!settings.get('workerUrl') || !settings.get('token')) {
    setConnected(false);
    await activateTab('settings');
    return;
  }
  try {
    applyConfig(await api.config());
    setConnected(true);
    await refreshAll();
  } catch (err) {
    setConnected(false, `サーバーに接続できません：${err.message}`);
    await activateTab('settings');
  }
})();
