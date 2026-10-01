// 管理コンソール。会社・スタッフ・商品マスタ・用語マスタを扱う。
//
// 練習画面（../app.js）と分けてあるのは、運用する人と現場で練習する人で
// 見るものがまったく違うため。設定タブに全部を積むと、受講者が触る画面に
// 相場表とスタッフ一覧のコードが載ることになる。
//
// 接続設定とセッションは localStorage 経由で練習画面と共有している。
// 片方でログインすれば、もう片方も入れる。

import { api } from '../api.js';
import { DEFAULTS, canExtract, extractChunks, fmtDuration } from '../media.js';
import { settings } from '../store.js';
import { $, $$, debounce, esc, run, status } from '../ui.js';

// 制作画面。教材をつくる側（①接客を集める／②基準をつくる）と、
// 運用（商品・用語・スタッフ・会社）をここに集めてある。
// 練習する人が見るのは ../ のほうで、この画面の中身は出ない。
let config = { roles: [], conditions: [], accessories: [], customerTypes: [], voices: [], feedbackOptions: { realism: [], scoring: [] } };
let me = null;
let products = [];
let staffList = [];
let staffCompany = '';
let cases = [];
let criteriaList = [];
let modes = [];
let current = { caseId: null, case: null, criteriaId: null };
let pickedProducts = new Set(); // モード作成で選んだ持ち込み品

/* ---------------------------------- タブ --------------------------------- */

async function activateTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${name}`));
  if (name === 'merge') await refreshMerge();
}
$$('.tab').forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
$('#go-account').addEventListener('click', () => activateTab('account'));

function setConnected(ok, message) {
  $('#connect-banner').hidden = ok;
  if (!ok && message) $('#connect-message').textContent = message;
}

/* --------------------------------- 接続 ---------------------------------- */

for (const [key, sel] of Object.entries({ workerUrl: '#worker-url', token: '#access-token' })) {
  const input = $(sel);
  input.value = settings.get(key) || '';
  input.addEventListener('input', () => settings.set(key, input.value));
}

async function afterConnect(cfg, el) {
  config = { ...config, ...cfg };
  me = cfg.me;
  setConnected(true);

  // 指導者以上でないとこの画面に用がない。何も読まずに理由だけ出す
  const denied = !me?.can?.capture;
  $('#denied-banner').hidden = !denied;
  $('#who').hidden = false;
  const roleLabel = (config.roles || []).find((r) => r.id === me?.role)?.label || '';
  $('#who-name').textContent = me?.staff_name
    ? `${me.company_name}／${me.staff_name}（${roleLabel}）`
    : `${me.company_name}（共有トークン）`;
  if (denied) {
    status(el, `${roleLabel}では制作画面を使えません`, 'error');
    for (const t of $$('.tab[data-requires]')) t.hidden = true;
    return;
  }

  // 権限で触れないタブは出さない。実際の制限はWorker側でかけている
  for (const t of $$('[data-requires]')) t.hidden = !me.can[t.dataset.requires];

  status(el, `接続OK — ${me.company_name} / ナレッジ空間 ${me.knowledge_space}`, 'ok');
  fillSelect($('#staff-role'), (config.roles || []).map((r) => ({ value: r.id, label: r.label })));
  fillSelect($('#calc-condition'), (config.conditions || []).map((c) => ({ value: c.id, label: `${c.label}（${c.desc}）` })));
  fillSelect($('#calc-accessory'), (config.accessories || []).map((a) => ({ value: a.id, label: a.label })));
  fillTypeGroups($('#mode-customer'), config.customerTypes, config.tracks);
  fillSelect($('#mode-voice'), [{ value: '', label: 'Worker既定の声' }, ...(config.voices || []).map((v) => ({ value: v.id, label: v.name }))]);

  await Promise.all([refreshCases(), refreshCriteria(), refreshModes()]);
  if (me.can.masters) {
    await loadGlossary();
    await loadProducts();
    await loadCompanies();
    await loadStaff();
  }
  // 触れる一番手前のタブを開く
  const first = $$('.tab').find((t) => !t.hidden);
  if (first) await activateTab(first.dataset.tab);
}

const fillSelect = (el, options, selected) => {
  if (!el) return;
  el.innerHTML = options
    .map((o) => `<option value="${esc(o.value)}" ${o.value === selected ? 'selected' : ''}>${esc(o.label)}</option>`)
    .join('');
};

$('#login-btn').addEventListener('click', async (e) => {
  const el = $('#login-status');
  const out = await run(e.target, el, 'ログイン中…', () =>
    api.login({
      company: $('#login-company').value,
      password: $('#login-password').value,
      staffCode: $('#login-staff').value,
    }),
  );
  if (!out) return;
  settings.set('token', out.token);
  settings.set('trainee', out.staff.name);
  $('#login-password').value = '';
  const cfg = await api.config().catch(() => null);
  if (cfg) await afterConnect(cfg, el);
});

$('#test-connection').addEventListener('click', async (e) => {
  const el = $('#settings-status');
  const cfg = await run(e.target, el, '接続中…', () => api.config());
  if (cfg) await afterConnect(cfg, el);
});

$('#logout').addEventListener('click', async () => {
  await api.logout().catch(() => {});
  settings.set('token', '');
  me = null;
  $('#who').hidden = true;
  setConnected(false, 'ログアウトしました。もう一度ログインしてください。');
  activateTab('account');
});

/* -------------------------------- ① 蓄積 -------------------------------- */

async function refreshCases() {
  const data = await api.listCases().catch(() => null);
  if (!data) return;
  cases = data.cases;
  renderCaseList();
  renderMergeCaseList();
}

const DENSITY = { high: '濃い', medium: 'ふつう', low: '薄い' };

/** 素材の濃さ。50時間の録画から、聞く価値のある回を選ぶための目印 */
function densityBadge(raw) {
  try {
    const a = JSON.parse(raw || 'null');
    if (!a?.density) return '';
    return `<span class="density ${a.density}">${DENSITY[a.density]}</span> `;
  } catch {
    return '';
  }
}

function renderCaseList() {
  $('#case-list').innerHTML = cases
    .map(
      (c) => `<li><button class="item ${c.id === current.caseId ? 'is-active' : ''}" data-id="${c.id}">
        <span class="item-name">${esc(c.title)}</span>
        <span class="item-meta">${densityBadge(c.assessment)}${esc(c.ace_name || '担当者未記入')}・${c.q_total ? `${c.q_answered}/${c.q_total} 回答` : '未検出'}</span>
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

function renderAssessment(raw) {
  const box = $('#assessment');
  if (!box) return;
  let a = null;
  try { a = JSON.parse(raw || 'null'); } catch { a = null; }
  if (!a?.density) {
    box.innerHTML = '';
    return;
  }
  const list = (items) => (items || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li>—</li>';
  box.innerHTML = `<div class="card">
    <div class="card-head"><span class="density ${a.density}">素材の濃さ：${DENSITY[a.density]}</span></div>
    <p class="why">${esc(a.reason)}</p>
    <div class="assess-cols">
      <div><h4>含まれている場面</h4><ul>${list(a.covered)}</ul></div>
      <div><h4>欠けている場面</h4><ul>${list(a.missing)}</ul></div>
    </div>
  </div>`;
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
  renderAssessment(c.assessment);
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

let lastExtract = null;

/** 取り込んだ音声の測定値と、処理後の音声そのものを出す。耳で原因を判断できるように */
function renderExtractReport(file, extracted, note) {
  const box = $('#extract-report');
  if (!box) return;
  const d = extracted?.diagnostics || {};
  box.insertAdjacentHTML('beforeend', `<div class="card">
    <div class="card-head"><h3>取り込みの結果：${esc(file.name)}</h3></div>
    ${note ? `<p class="why">${esc(note)}</p>` : ''}
    <div class="diag">${Object.entries(d)
      .map(([k, v]) => `<div><span>${esc(k)}</span><span>${esc(v)}</span></div>`)
      .join('')}</div>
    <p class="hint">下がWhisperに送っている音声そのものです。聞こえ方を確認してください。</p>
    <div class="chunk-players" id="chunk-players"></div>
    ${extracted ? '<div class="row row-end"><button class="btn btn-ghost btn-sm" id="dl-chunks">処理後の音声を保存</button></div>' : ''}
  </div>`);
  if (!extracted) return;
  const players = $('#chunk-players');
  extracted.chunks.slice(0, 3).forEach((c, i) => {
    const el = document.createElement('audio');
    el.controls = true;
    el.src = URL.createObjectURL(c);
    el.title = `${i + 1}個目`;
    players.append(el);
  });
  $('#dl-chunks').addEventListener('click', () => {
    extracted.chunks.forEach((c, i) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(c);
      a.download = `${file.name.replace(/\.[^.]+$/, '')}_part${i + 1}.wav`;
      a.click();
    });
  });
}

/**
 * 1ファイルを取り込む。抽出 → 分割 → 順に書き起こして案件へ追記。
 * 分割録音を複数まとめて入れられるよう、1ファイル分を関数にしてある。
 */
async function importOneFile(file, el, prefix) {
  let extracted;
  try {
    extracted = await extractChunks(file, {
      onProgress: (msg) => status(el, `${prefix}${file.name}：${msg}`),
      ...extractOptions(),
    });
  } catch (err) {
    renderExtractReport(file, null, err.message);
    return { ok: false, error: err.message };
  }

  renderExtractReport(file, extracted);
  const { chunks, seconds, originalSeconds, gain } = extracted;
  const trimmed = originalSeconds - seconds;
  const note =
    (trimmed > 30 ? `（無音 ${fmtDuration(trimmed)} を除去` : '（') +
    (gain > 1.05 ? `${trimmed > 30 ? '／' : ''}音量を${gain.toFixed(1)}倍に調整` : '') +
    '）';

  for (const [i, chunk] of chunks.entries()) {
    status(el, `${prefix}${file.name}：書き起こし中… ${i + 1}/${chunks.length} 個目 ${note}`);
    try {
      const data = await api.transcribe(current.caseId, chunk, { vocabulary: settings.get('vocabulary') }, `part${i + 1}.wav`);
      current.case = data.case;
      $('#case-transcript').value = data.case.transcript;
    } catch (err) {
      renderExtractReport(file, extracted, '送った音声は下で再生できます。話し声が聞き取れない場合は、録音そのものに声が入っていないか、音量が足りていません。');
      return { ok: false, error: `${i + 1}個目で失敗：${err.message}`, partial: i };
    }
  }
  return { ok: true, seconds, chunks: chunks.length };
}

$('#audio-file').addEventListener('change', async (e) => {
  // 録音が分割されている場合に備え、複数まとめて受ける。
  // 順番が狂うと会話が入れ替わるので、ファイル名を自然順（part2 < part10）に並べる。
  const files = [...(e.target.files || [])].sort((a, b) =>
    a.name.localeCompare(b.name, 'ja', { numeric: true, sensitivity: 'base' }),
  );
  e.target.value = '';
  if (!files.length || !current.caseId) return;
  const el = $('#capture-status');

  if (!canExtract()) {
    status(el, 'このブラウザでは動画から音声を取り出せません。tools/extract-audio.sh で変換してから読み込んでください', 'error');
    return;
  }

  $('#extract-report').innerHTML = '';
  if (files.length > 1) {
    status(el, `${files.length}ファイルを順に取り込みます：${files.map((f) => f.name).join(' → ')}`);
  }

  const done = [];
  const failed = [];
  for (const [i, file] of files.entries()) {
    const prefix = files.length > 1 ? `${i + 1}/${files.length} ` : '';
    const res = await importOneFile(file, el, prefix);
    (res.ok ? done : failed).push({ file, res });
    // 分割録音は順番に意味があるため、途中で失敗したら止めて知らせる
    if (!res.ok) break;
  }

  if (failed.length) {
    const f = failed[0];
    status(el, `${f.file.name} で中断しました：${f.res.error}（${done.length}ファイル分は保存済み）`, 'error');
    return;
  }
  const total = done.reduce((n, d) => n + d.res.seconds, 0);
  status(
    el,
    `完了：${done.length}ファイル・合計${fmtDuration(total)}を書き起こしました`,
    'ok',
  );
});

$('#format-btn').addEventListener('click', async (e) => {
  const el = $('#capture-status');
  if (!$('#case-transcript').value.trim()) {
    status(el, '書き起こしを入れてください', 'error');
    return;
  }
  await api.updateCase(current.caseId, { transcript: $('#case-transcript').value }).catch(() => {});
  const data = await run(e.target, el, '話者を判定して整えています…（30秒ほどかかります）', () => api.format(current.caseId));
  if (!data) return;
  current.case = data.case;
  $('#case-transcript').value = data.case.transcript;
  status(el, '整えました。内容を確認してから転換点を検出してください', 'ok');
});

$('#assess-btn')?.addEventListener('click', async (e) => {
  const el = $('#capture-status');
  if (!$('#case-transcript').value.trim()) {
    status(el, '書き起こしを入れてください', 'error');
    return;
  }
  await api.updateCase(current.caseId, { transcript: $('#case-transcript').value }).catch(() => {});
  const data = await run(e.target, el, '素材として使えるか見ています…', () => api.assess(current.caseId));
  if (!data) return;
  current.case.assessment = JSON.stringify(data.assessment);
  renderAssessment(current.case.assessment);
  await refreshCases();
  if (data.assessment.density === 'low') {
    status(el, '判断の場面が薄い録音です。転換点を検出しても浅い結果になります', 'error');
  }
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

async function openModeDialog(criteriaId) {
  if (!criteriaList.length) {
    alert('先に③で判断基準を統合してください。');
    return;
  }
  if (criteriaId) $('#mode-criteria').value = criteriaId;
  $('#mode-name').value = '';
  $('#mode-scenario').value = '';
  pickedProducts = new Set();
  await fillProductPickers();
  renderTypeDetail();
  $('#mode-dialog').showModal();
}

/**
 * 持ち込む品物の選び方。
 *
 * 選んだ品物は**全部まとめて**客が持ってくる（「バッグと財布」のような持ち込み）。
 * 何も選ばなければ、カテゴリから実施ごとに1点を引く。
 */
async function fillProductPickers() {
  const catSel = $('#mode-category');
  const box = $('#mode-products');
  if (!catSel || !box) return;
  const data = await api.listProducts().catch(() => null);
  const all = data?.products || [];
  const categories = data?.categories || [];

  catSel.innerHTML = ['<option value="">すべてのカテゴリから</option>', ...categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`)].join('');

  const renderPicker = () => {
    const cat = catSel.value;
    const pool = cat ? all.filter((p) => p.category === cat) : all;
    box.innerHTML = pool.length
      ? pool
          .map(
            (p) => `<label class="check">
              <input type="checkbox" value="${esc(p.id)}" ${pickedProducts.has(p.id) ? 'checked' : ''}>
              <span>${esc([p.brand, p.name].filter(Boolean).join(' '))}<em class="item-meta">${esc(yen(p.new_price))}／${esc(p.retention)}%</em></span>
            </label>`,
          )
          .join('')
      : '<p class="hint">このカテゴリに商品がありません。商品マスタで登録してください。</p>';
  };
  renderPicker();
  catSel.onchange = renderPicker;

  // 選んだものはカテゴリを切り替えても覚えておく
  box.onchange = (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    if (cb.checked) pickedProducts.add(cb.value);
    else pickedProducts.delete(cb.value);
  };

  if (!all.length) {
    catSel.innerHTML = '<option value="">商品マスタが空です</option>';
    box.innerHTML = '<p class="hint">商品マスタが空です。先に商品を登録してください。</p>';
  }
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
      productCategory: $('#mode-category')?.value || '',
      productIds: [...pickedProducts],
    })
    .catch((err) => {
      alert(`作成できませんでした：${err.message}`);
      return null;
    });
  if (out) await refreshModes();
});

/* ---------------------------- 取り込みの調整 ------------------------------ */

// 音声の取り出しは制作側の作業なので、調整値もこの画面に置く
for (const [key, sel] of Object.entries({ hpCutoff: '#hp-cutoff', maxGain: '#max-gain', silenceFactor: '#silence-factor' })) {
  const input = $(sel);
  if (!input) continue;
  input.value = settings.get(key) ?? DEFAULTS[key];
  input.addEventListener('input', () => settings.set(key, Number(input.value) || DEFAULTS[key]));
}
const trimBox = $('#trim-enabled');
if (trimBox) {
  trimBox.checked = settings.get('trim') !== false;
  trimBox.addEventListener('change', () => settings.set('trim', trimBox.checked));
}
const vocabBox = $('#vocabulary');
if (vocabBox) {
  vocabBox.value = settings.get('vocabulary') || '';
  vocabBox.addEventListener('input', () => settings.set('vocabulary', vocabBox.value));
}

const extractOptions = () => ({
  hpCutoff: Number(settings.get('hpCutoff')) || DEFAULTS.hpCutoff,
  maxGain: Number(settings.get('maxGain')) || DEFAULTS.maxGain,
  silenceFactor: Number(settings.get('silenceFactor')) || DEFAULTS.silenceFactor,
  trim: settings.get('trim') !== false,
});

/* --------------------------- モードの客タイプ ----------------------------- */

async function refreshModes() {
  const data = await api.listModes().catch(() => null);
  if (data) modes = data.modes;
}

/**
 * 客タイプを2トラックに分けて並べる。
 * 通常と大逆転は作る目的が違うので、同じ平たい一覧に混ぜない。
 */
function fillTypeGroups(el, types, tracks) {
  if (!el) return;
  el.innerHTML = (tracks || [{ id: 'standard', label: 'すべて' }])
    .map((tr) => {
      const inTrack = (types || []).filter((t) => (t.track || 'standard') === tr.id);
      if (!inTrack.length) return '';
      return `<optgroup label="${esc(tr.label)}｜${esc(tr.hint || '')}">
        ${inTrack.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('')}
      </optgroup>`;
    })
    .join('');
}

/** 選んだ客タイプが何を試す型なのかを、モードを作る前に見せる */
function renderTypeDetail() {
  const box = $('#mode-type-detail');
  if (!box) return;
  const t = (config.customerTypes || []).find((x) => x.id === $('#mode-customer').value);
  if (!t) {
    box.innerHTML = '';
    return;
  }
  const sceneLabel = (config.scenes || []).find((x) => x.id === t.scene)?.label || '';
  box.innerHTML = `
    ${sceneLabel ? `<span class="pill yes">${esc(sceneLabel)}</span>` : ''}
    <span class="pill ${t.track === 'reversal' ? '' : 'yes'}">${t.track === 'reversal' ? '大逆転' : '通常'}</span>
    <span>${esc(t.hint.split('\n')[0])}</span>
    <span><strong>折れる条件：</strong>${(t.flags || []).map((f) => esc(f.label)).join(' ／ ')}</span>
    <span><strong>禁じ手：</strong>${esc(t.breaker || '')}</span>`;
}

$('#mode-customer')?.addEventListener('change', renderTypeDetail);

/* ------------------------------- 商品マスタ ------------------------------ */

const yen = (v) => `${Math.round(Number(v) || 0).toLocaleString('ja-JP')}円`;
const productLine = (p) =>
  [p.category, p.brand, p.model, p.name, p.new_price, p.retention, p.notes].join('\t');

// 1件ずつ直せる表にしてある。以前は貼り付け欄しか無く、
// 1項目を直すのにも全件を貼り直す必要があった（しかも総入れ替えだった）。
const COLUMNS = [
  { key: 'category', label: 'カテゴリ', width: '9%' },
  { key: 'brand', label: 'ブランド', width: '13%' },
  { key: 'model', label: '型番', width: '13%' },
  { key: 'name', label: '商品名', width: '21%' },
  { key: 'new_price', label: '新品価格', width: '11%', num: true },
  { key: 'retention', label: '買取率%', width: '7%', num: true },
  { key: 'notes', label: '備考', width: '20%' },
];

async function loadProducts() {
  const data = await api.listProducts().catch(() => null);
  if (!data) return;
  products = data.products;
  $('#products').value = products.map(productLine).join('\n');
  fillSelect(
    $('#calc-product'),
    products.map((p) => ({ value: p.id, label: `${[p.brand, p.name].filter(Boolean).join(' ')}（${yen(p.new_price)}／${p.retention}%）` })),
  );
  renderProducts();
  renderCalc();
}

function renderProducts() {
  const q = $('#product-filter').value.trim().toLowerCase();
  const shown = q
    ? products.filter((p) => [p.category, p.brand, p.model, p.name].join(' ').toLowerCase().includes(q))
    : products;
  status($('#products-status'), `${shown.length}件${q ? `（全${products.length}件中）` : ''}`);
  $('#product-table').innerHTML = `
    <thead><tr>${COLUMNS.map((c) => `<th style="width:${c.width}">${esc(c.label)}</th>`).join('')}<th></th></tr></thead>
    <tbody>${shown
      .map(
        (p) => `<tr data-id="${esc(p.id)}">
          ${COLUMNS.map(
            (c) => `<td class="${c.num ? 'num' : ''}">
              <input class="cell ${c.num ? 'num' : ''}" data-field="${c.key}" value="${esc(p[c.key] ?? '')}"
                     ${c.num ? 'type="number" min="0"' : ''}>
            </td>`,
          ).join('')}
          <td><button class="btn btn-ghost btn-sm danger" data-del="${esc(p.id)}">削除</button></td>
        </tr>`,
      )
      .join('')}</tbody>`;
  if (!products.length) {
    status($('#products-status'), 'まだ空です。「商品を追加」か「サンプル100点を足す」から始めてください');
  }
}
$('#product-filter').addEventListener('input', renderProducts);

// 欄を離れたら保存する。変わっていなければ何もしない
$('#product-table').addEventListener('change', async (e) => {
  const input = e.target.closest('.cell');
  if (!input) return;
  const id = input.closest('tr')?.dataset.id;
  const field = input.dataset.field;
  const key = field === 'new_price' ? 'newPrice' : field;
  const value = input.type === 'number' ? Number(input.value) : input.value;
  const before = products.find((p) => p.id === id);
  if (!before || String(before[field] ?? '') === String(value)) return;

  const out = await run(null, $('#products-status'), '保存中…', () => api.updateProduct(id, { [key]: value }));
  if (!out) {
    input.value = before[field] ?? ''; // 失敗したら元に戻す
    return;
  }
  Object.assign(before, out.product);
  // 価格や率が変わると正解額も変わるので、試算を引き直す
  if (field === 'new_price' || field === 'retention') await loadProducts();
  else status($('#products-status'), `${out.product.name} を保存しました`, 'ok');
});

$('#product-table').addEventListener('click', async (e) => {
  const id = e.target.dataset.del;
  if (!id) return;
  const target = products.find((p) => p.id === id);
  if (!confirm(`「${[target?.brand, target?.name].filter(Boolean).join(' ')}」を削除します。シナリオに付けている場合は外れます。よろしいですか。`)) return;
  if (await run(null, $('#products-status'), '削除中…', () => api.deleteProduct(id))) {
    await loadProducts();
    status($('#products-status'), '削除しました', 'ok');
  }
});

$('#add-product').addEventListener('click', async (e) => {
  const out = await run(e.target, $('#products-status'), '追加中…', () =>
    api.createProduct({ category: '', brand: '', model: '', name: '新しい商品', newPrice: 10000, retention: 30 }),
  );
  if (!out) return;
  $('#product-filter').value = '';
  await loadProducts();
  // 追加した行の商品名にそのままカーソルを置く
  const row = $(`#product-table tr[data-id="${out.product.id}"]`);
  row?.scrollIntoView({ block: 'center' });
  const cell = row?.querySelector('[data-field="name"]');
  cell?.focus();
  cell?.select();
});

/* --------- まとめて取り込む（足すだけ） --------- */

$('#import-products').addEventListener('click', async (e) => {
  const el = $('#import-status');
  const out = await run(e.target, el, '取り込み中…', () => api.importProducts($('#products').value));
  const report = $('#import-report');
  if (!out) {
    report.innerHTML = '';
    return;
  }
  await loadProducts();
  status(el, `${out.added}件を足しました${out.skipped ? `（すでにある${out.skipped}件は飛ばしました）` : ''}`, 'ok');
  // 読めなかった行はそのまま見せる。黙って減っていると原因が分からない
  report.innerHTML = out.bad?.length
    ? `<p class="hint error">読み取れなかった行（${out.bad.length}）：区切りが違うか、商品名か新品価格が空です</p>
       <ul class="list">${out.bad.map((b) => `<li class="item">${esc(b)}</li>`).join('')}</ul>`
    : '';
});

$('#seed-products').addEventListener('click', async (e) => {
  const el = $('#import-status');
  const out = await run(e.target, el, '読み込み中…', () => api.seedProducts());
  if (!out) return;
  await loadProducts();
  status(el, `${out.added}件を足しました${out.skipped ? `（すでにある${out.skipped}件は飛ばしました）` : ''}。買取率は現場の相場に合わせて直してください`, 'ok');
});

// Excelへ持っていくため。クリップボードが使えない環境では選択状態にするだけにする
$('#copy-products').addEventListener('click', async () => {
  const box = $('#products');
  box.value = products.map(productLine).join('\n');
  box.select();
  const ok = await navigator.clipboard?.writeText(box.value).then(() => true, () => false);
  status($('#import-status'), ok ? 'クリップボードにコピーしました' : '欄を選択しました。コピーしてください', 'ok');
});

/**
 * 正解額の試算。
 * 計算はWorker側（items.js）に投げる。ここに式を写すと、本番の採点とずれる。
 */
async function renderCalc() {
  const box = $('#calc-result');
  const id = $('#calc-product').value;
  if (!id) {
    box.innerHTML = '';
    return;
  }
  const q = await api.quote(id, $('#calc-condition').value, $('#calc-accessory').value).catch(() => null);
  if (!q) {
    box.innerHTML = '<span>試算できませんでした</span>';
    return;
  }
  box.innerHTML = `
    <span class="outcome closed">適正 ${esc(yen(q.low))}〜${esc(yen(q.high))}</span>
    <span>中心 ${esc(yen(q.fair))}</span>
    <span>新品 ${esc(yen(q.product.new_price))} × 買取率 ${esc(q.product.retention)}% × ${esc(q.condition.label)} ${q.condition.ratio} × ${esc(q.accessory.label)} ${q.accessory.ratio}</span>`;
}
['#calc-product', '#calc-condition', '#calc-accessory'].forEach((sel) =>
  $(sel).addEventListener('change', renderCalc),
);

/* ---------------------------- ブランド・用語 ----------------------------- */

async function loadGlossary() {
  const data = await api.getGlossary().catch(() => null);
  if (!data) return;
  $('#glossary').value = data.text || '';
  $('#dialect').value = data.dialect || '';
}

$('#save-glossary').addEventListener('click', async (e) => {
  const el = $('#glossary-status');
  const out = await run(e.target, el, '保存中…', () => api.saveGlossary($('#glossary').value, $('#dialect').value));
  if (out) status(el, `保存しました（${out.count}件、うち誤りの登録${out.variants}件）`, 'ok');
});

/* -------------------------------- スタッフ ------------------------------- */

async function loadStaff() {
  const data = await api.listStaff(staffCompany || undefined).catch(() => null);
  if (!data) return;
  staffCompany = data.company;
  staffList = data.staff;
  $('#staff-table').innerHTML = `
    <thead><tr><th>個人コード</th><th>氏名</th><th>店舗</th><th>権限</th><th>実施</th><th></th></tr></thead>
    <tbody>${staffList
      .map(
        (st) => `<tr class="${st.active ? '' : 'is-off'}">
          <td>${esc(st.code)}</td><td>${esc(st.name)}</td><td>${esc(st.store || '')}</td>
          <td>
            <select class="input input-sm" data-staff-role="${esc(st.id)}">
              ${(config.roles || []).map((r) => `<option value="${esc(r.id)}" ${r.id === st.role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
            </select>
          </td>
          <td class="num">${esc(st.run_count ?? 0)}回</td>
          <td>
            <button class="btn btn-ghost btn-sm" data-staff-toggle="${esc(st.id)}">${st.active ? '停止' : '再開'}</button>
            <button class="btn btn-ghost btn-sm danger" data-staff-del="${esc(st.id)}">削除</button>
          </td>
        </tr>`,
      )
      .join('')}</tbody>`;
  if (!staffList.length) status($('#staff-status'), `${staffCompany} にはまだ誰も登録されていません`);
}

$('#staff-table').addEventListener('change', async (e) => {
  const id = e.target.dataset.staffRole;
  if (!id) return;
  const el = $('#staff-status');
  const ok = await run(null, el, '変更中…', () =>
    api.updateStaff(id, { role: e.target.value, company: staffCompany || undefined }),
  );
  if (ok) status(el, '権限を変えました。その人は一度ログアウトされます', 'ok');
});

$('#staff-table').addEventListener('click', async (e) => {
  const el = $('#staff-status');
  const toggle = e.target.dataset.staffToggle;
  if (toggle) {
    const target = staffList.find((st) => st.id === toggle);
    const ok = await run(null, el, '変更中…', () =>
      api.updateStaff(toggle, { active: !target.active, company: staffCompany || undefined }),
    );
    if (ok) {
      await loadStaff();
      status(el, target.active ? '停止しました' : '再開しました', 'ok');
    }
    return;
  }
  const del = e.target.dataset.staffDel;
  if (!del) return;
  const target = staffList.find((st) => st.id === del);
  if (!confirm(`${target?.name || ''}（${target?.code || ''}）を削除します。実施記録は残ります。よろしいですか。`)) return;
  if (await run(null, el, '削除中…', () => api.deleteStaff(del, staffCompany))) {
    await loadStaff();
    status(el, '削除しました', 'ok');
  }
});

$('#add-staff').addEventListener('click', async (e) => {
  const el = $('#staff-status');
  const out = await run(e.target, el, '追加中…', () =>
    api.createStaff({
      code: $('#staff-code').value,
      name: $('#staff-name').value,
      store: $('#staff-store').value,
      role: $('#staff-role').value,
      company: staffCompany || undefined,
    }),
  );
  if (!out) return;
  $('#staff-code').value = '';
  $('#staff-name').value = '';
  await loadStaff();
  status(el, `${out.staff.name} を追加しました`, 'ok');
});

$('#staff-company').addEventListener('change', async (e) => {
  staffCompany = e.target.value;
  await loadStaff();
});

/* --------------------------------- 会社 ---------------------------------- */

async function loadCompanies() {
  const data = await api.listCompanies().catch(() => null);
  if (!data) return;
  $('#company-table').innerHTML = `
    <thead><tr><th>会社コード</th><th>会社名</th><th>ナレッジ空間</th><th>人数</th><th>実施</th></tr></thead>
    <tbody>${data.companies
      .map(
        (c) => `<tr>
          <td>${esc(c.code)}</td><td>${esc(c.name)}</td><td>${esc(c.knowledge_space)}</td>
          <td class="num">${esc(c.staff_count ?? 0)}人</td><td class="num">${esc(c.run_count ?? 0)}回</td>
        </tr>`,
      )
      .join('')}</tbody>`;

  // 共有トークンで入った管理者は会社をまたいで面倒を見るので、対象を選ばせる
  if (me?.via === 'token' && data.companies.length) {
    $('#staff-company-wrap').hidden = false;
    fillSelect(
      $('#staff-company'),
      data.companies.map((c) => ({ value: c.code, label: `${c.name}（${c.code}）` })),
      staffCompany,
    );
    if (!data.companies.some((c) => c.code === staffCompany)) staffCompany = data.companies[0].code;
    $('#staff-company').value = staffCompany;
  }
  if (!data.companies.length) {
    status($('#company-status'), 'まだ会社がありません。まずここで1つ作ってください');
    activateTab('companies');
  }
}

$('#save-company').addEventListener('click', async (e) => {
  const el = $('#company-status');
  const out = await run(e.target, el, '登録中…', () =>
    api.saveCompany({
      code: $('#company-code').value,
      name: $('#company-name').value,
      password: $('#company-password').value,
      knowledgeSpace: $('#company-space').value,
    }),
  );
  if (!out) return;
  $('#company-password').value = '';
  await loadCompanies();
  await loadStaff();
  status(el, `${out.code} を登録しました`, 'ok');
});

/* -------------------------------- 初期化 -------------------------------- */

(async function start() {
  if (!settings.get('workerUrl') || !settings.get('token')) {
    setConnected(false);
    activateTab('account');
    return;
  }
  try {
    await afterConnect(await api.config(), $('#settings-status'));
  } catch (err) {
    setConnected(false, `サーバーに接続できません：${err.message}`);
    activateTab('account');
  }
})();
