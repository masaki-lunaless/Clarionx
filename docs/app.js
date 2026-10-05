import { api } from './api.js';
import { $, $$, debounce, esc, run, status } from './ui.js';
import { settings } from './store.js';

/* -------------------------------- 全体状態 ------------------------------- */

// 練習画面。接客を集める・判断基準を作るといった制作側は admin/ に置いてある。
// ここに出すのは「練習する・採点を見る・フィードバックを返す」だけ。
let config = { customerTypes: [], voices: [], feedbackOptions: { realism: [], scoring: [] }, admin: true };
let criteriaList = []; // 記録の絞り込みに使うだけ（本文は持たない）
let modes = [];
let current = { modeId: null, run: null };

/* ---------------------------------- タブ --------------------------------- */

async function activateTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${name}`));
  if (name === 'practice') await refreshModes();
  if (name === 'records') await refreshRecords();
}

$$('.tab').forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));

/* ------------------------------ 版ずれの検知 ----------------------------- */

// GitHub Pages は max-age=600 なので、配信し直した直後の10分は古いJSが動き続ける。
// 画面とAPIの形が変わった直後だと黙って壊れるため、Workerが返す印と見比べて promptする。
const BUILD = '2026-10-05a';

function checkBuild(cfg) {
  if (!cfg?.build || cfg.build === BUILD) return;
  const bar = document.createElement('div');
  bar.className = 'banner';
  bar.innerHTML = '<span>新しい版が出ています。このままだと正しく動かないことがあります。</span>';
  const btn = document.createElement('button');
  btn.className = 'btn btn-sm';
  btn.textContent = '再読み込み';
  btn.onclick = () => location.reload();
  bar.appendChild(btn);
  document.body.prepend(bar);
}

/* ------------------------------ 入口と権限 ------------------------------- */

// ログインするまではログイン画面だけを出し、入ったらタブを出す。
// 以前は「設定タブを開いて4つ入れる」形で、初見では何をすればよいか分からなかった。
let me = null;

function showGate(message) {
  $('#gate').hidden = false;
  $('#topbar').hidden = true;
  $('#main').hidden = true;
  if (message) status($('#login-status'), message, 'error');
}

function showApp() {
  $('#gate').hidden = true;
  $('#topbar').hidden = false;
  $('#main').hidden = false;
}

// 14日でセッションが切れる。黙って操作が効かなくなるより、入口へ戻す
window.addEventListener('clarion:unauthorized', () => {
  if (!me) return;
  settings.set('token', '');
  me = null;
  showGate('ログインの有効期限が切れました。もう一度ログインしてください。');
});

/**
 * 権限で出し分けるのはこの画面では1つだけ。制作画面への導線。
 * ①接客を集める・③基準をつくるは、この画面にはもう無い（admin/ にある）。
 */
function applyPermissions() {
  const roleLabel = (config.roles || []).find((r) => r.id === me?.role)?.label || '';
  $('#who-name').textContent = !me
    ? ''
    : me.staff_name
      ? `${me.company_name}／${me.staff_name}（${roleLabel}${me.store ? `・${me.store}` : ''}）`
      : `${me.company_name}（共有トークン）`;

  // 制作画面は指導者以上。受講者には導線ごと出さない
  $('#to-studio').hidden = !me?.can?.capture;

  // 共有トークンで入ったときだけ、実施者を手で入れてもらう。
  // ログインしていれば個人コードから決まるので、欄そのものを出さない
  const wrap = $('#trainee-wrap');
  if (wrap) wrap.hidden = me?.via !== 'token';
}

/* --------------------------------- 接続 ---------------------------------- */

for (const [key, sel] of Object.entries({ workerUrl: '#worker-url', token: '#access-token', trainee: '#trainee' })) {
  const input = $(sel);
  if (!input) continue;
  input.value = settings.get(key) || '';
  input.addEventListener('input', () => settings.set(key, input.value));
}

async function afterConnect(cfg) {
  checkBuild(cfg);
  applyConfig(cfg);
  me = cfg.me;
  applyPermissions();
  showApp();
  await refreshAll();
  await activateTab('practice');
}

$('#login-btn')?.addEventListener('click', async (e) => {
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
  settings.set('lastCompany', $('#login-company').value.trim());
  settings.set('lastStaff', $('#login-staff').value.trim());
  $('#login-password').value = '';
  const cfg = await run(null, el, '読み込み中…', () => api.config());
  if (cfg) await afterConnect(cfg);
});

// Enterでも入れるように。店頭でタブレットから使うことを想定
for (const sel of ['#login-company', '#login-staff', '#login-password']) {
  $(sel)?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#login-btn').click();
  });
}

$('#test-connection')?.addEventListener('click', async (e) => {
  const cfg = await run(e.target, $('#settings-status'), '接続中…', () => api.config());
  if (cfg) await afterConnect(cfg);
});

$('#logout')?.addEventListener('click', async () => {
  await api.logout().catch(() => {});
  settings.set('token', '');
  me = null;
  showGate('ログアウトしました。');
});

function applyConfig(cfg) {
  config = { ...config, ...cfg };
  const fill = (el, options, selected) => {
    if (!el) return;
    el.innerHTML = options
      .map((o) => `<option value="${esc(o.value ?? o.id)}" ${(o.value ?? o.id) === selected ? 'selected' : ''}>${esc(o.label ?? o.name)}</option>`)
      .join('');
  };
  fill($('#fb-realism'), [{ value: '', label: '（未評価）' }, ...config.feedbackOptions.realism]);
  fill($('#fb-scoring'), [{ value: '', label: '（未評価）' }, ...config.feedbackOptions.scoring]);
}

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
            <span class="item-meta">${esc(m.criteria_title)}・実施${m.run_count}回${m.attached_count ? `・持ち込み${m.attached_count}点` : ''}</span>
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
  resetSituation(mode);
  setPractice(false);
});

/* ------------------------- シチュエーションの差し替え --------------------- */

// 開始前にその回だけ設定を変える。モードそのものには触らない。
// 品物は受講者にも選ばせるが、相場はWorker側で落として返している
// （現場でも品物は目の前にあり、分からないのは「いくらで買うか」のほう）。
let situationProducts = [];
let pickedForRun = new Set();

function resetSituation(mode) {
  pickedForRun = new Set();
  const typeSel = $('#run-customer');
  if (typeSel) {
    typeSel.innerHTML = (config.customerTypes || [])
      .map((t) => `<option value="${esc(t.id)}" ${t.id === mode.customer_type ? 'selected' : ''}>${esc(t.label)}</option>`)
      .join('');
  }
  const scen = $('#run-scenario');
  if (scen) scen.value = mode.scenario || '';
  const cat = $('#run-category');
  if (cat) cat.value = mode.product_category || '';
  const diff = $('#run-difficulty');
  if (diff) {
    diff.innerHTML = (config.difficulties || [])
      .map((d) => `<option value="${esc(d.id)}" ${d.id === 'normal' ? 'selected' : ''}>${esc(d.label)}｜${esc(d.hint)}</option>`)
      .join('');
  }
  renderRunProducts();
  $('#situation').open = false;
}

async function loadSituationProducts() {
  const data = await api.listProducts().catch(() => null);
  situationProducts = data?.products || [];
  const cat = $('#run-category');
  if (cat) {
    const keep = cat.value;
    cat.innerHTML = ['<option value="">すべてのカテゴリ</option>',
      ...(data?.categories || []).map((c) => `<option value="${esc(c)}">${esc(c)}</option>`)].join('');
    cat.value = keep;
  }
  renderRunProducts();
}

// 現場では「バッグと指輪」のようにカテゴリをまたいで持ってくる。
// カテゴリは絞り込みにしか使わず、選んだものは常に上に出す。
function renderRunProducts() {
  const box = $('#run-products');
  if (!box) return;
  const chosen = situationProducts.filter((p) => pickedForRun.has(p.id));
  const picked = $('#run-picked');
  if (picked) {
    picked.innerHTML = chosen.length
      ? `<div class="chips">${chosen
          .map(
            (p) => `<span class="chip">${esc([p.brand, p.name].filter(Boolean).join(' '))}
              <button type="button" class="chip-x" data-unpick="${esc(p.id)}" aria-label="外す">×</button></span>`,
          )
          .join('')}</div>
         <p class="hint">${chosen.length}点をまとめて持ってきます</p>`
      : '';
  }
  const cat = $('#run-category')?.value || '';
  const pool = cat ? situationProducts.filter((p) => p.category === cat) : situationProducts;
  box.innerHTML = pool.length
    ? pool
        .map(
          (p) => `<label class="check">
            <input type="checkbox" value="${esc(p.id)}" ${pickedForRun.has(p.id) ? 'checked' : ''}>
            <span>${esc([p.brand, p.name].filter(Boolean).join(' '))}<em class="item-meta">${esc(p.category)}</em></span>
          </label>`,
        )
        .join('')
    : '<p class="hint">このカテゴリに品物がありません。</p>';
}

$('#run-picked')?.addEventListener('click', (e) => {
  const id = e.target.dataset.unpick;
  if (!id) return;
  pickedForRun.delete(id);
  renderRunProducts();
});

$('#run-category')?.addEventListener('change', renderRunProducts);
$('#run-products')?.addEventListener('change', (e) => {
  const cb = e.target.closest('input[type=checkbox]');
  if (!cb) return;
  if (cb.checked) pickedForRun.add(cb.value);
  else pickedForRun.delete(cb.value);
  renderRunProducts();
});
$('#situation-reset')?.addEventListener('click', () => {
  const mode = modes.find((m) => m.id === current.modeId);
  if (mode) resetSituation(mode);
});

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
    api.startRun(current.modeId, settings.get('trainee'), {
      customerType: $('#run-customer')?.value || undefined,
      scenario: $('#run-scenario')?.value,
      category: $('#run-category')?.value || undefined,
      difficulty: $('#run-difficulty')?.value || undefined,
      itemCount: Number($('#run-item-count')?.value) || undefined,
      productIds: [...pickedForRun],
    }),
  );
  if (!out) return;
  current.run = out.runId;
  startTiming();
  renderConvo(out.history);
  play(out.replyText, out.audioUrl);
  if (!out.audioUrl) markCustomerDone(false);
  setPractice(true);
});

const faceOf = (id) => (config.moods || []).find((m) => m.id === id)?.face || '';

/**
 * 表情を発話のそばに出す。
 * 対面なら相手の顔で分かることが、音声だけのロープレでは落ちてしまう。
 * 声の演技にも同じ心境を載せているが、それだけでは読み取れない人もいる。
 * 「どこまで折れたか」は出さない。そちらは答えそのもの。
 */
function renderConvo(history) {
  $('#convo').innerHTML = history
    .map((m) => {
      const face = m.role === 'customer' ? faceOf(m.mood) : '';
      return `<div class="bubble ${m.role}">
        <span class="who">${m.role === 'trainee' ? 'あなた' : 'お客様'}${face ? `<em class="face">${esc(face)}</em>` : ''}</span>
        <p>${esc(m.text)}</p>
      </div>`;
    })
    .join('');
  $('#convo').scrollTop = $('#convo').scrollHeight;
}

async function sendTurn(payload) {
  const statusEl = $('#practice-status');
  status(statusEl, payload.audio ? '聞き取り中…お客様が考えています' : 'お客様が考えています…');
  try {
    const out = await api.turn(current.run, { ...payload, timing: payload.timing || takeTiming() });
    renderConvo(out.history);
    play(out.replyText, out.audioUrl);
    if (!out.audioUrl) markCustomerDone(false);
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
  renderScore(out.score, out.items);
  $('#feedback-box').hidden = false;
  $('#fb-note').value = '';
  $('#fb-realism').value = '';
  $('#fb-scoring').value = '';
  status($('#fb-status'), '');
});

const yen = (v) => `${Math.round(Number(v) || 0).toLocaleString('ja-JP')}円`;

/**
 * 品物と正解額は、練習中は伏せてあってここで初めて出る。
 * 「何を、どの状態で、いくらが正解だったか」を並べて見せないと、
 * 提示額の当たり外れが振り返れない。複数点なら合計も出す。
 */
function renderItems(items, price) {
  const list = (items || []).filter((i) => i && !i.hidden);
  if (!list.length) return '';
  const total = list.reduce(
    (a, b) => ({ low: a.low + b.low, fair: a.fair + b.fair, high: a.high + b.high }),
    { low: 0, fair: 0, high: 0 },
  );
  const verdict = { fair: 'ok', low: 'ng', high: 'ng', none: '' }[price?.verdict] || '';
  return `
    <div class="card item-card">
      <h4>この回の品物${list.length > 1 ? `（${list.length}点）` : ''}（練習中は伏せていました）</h4>
      ${list
        .map(
          (item) => `<div class="axis">
            <p class="item-name"><strong>${esc([item.brand, item.name].filter(Boolean).join(' '))}</strong>${item.model ? `<span class="item-meta">型番 ${esc(item.model)}</span>` : ''}</p>
            <div class="breakdown">
              <span>状態：${esc(item.condition_label)}</span>
              <span>付属品：${esc(item.accessory_label)}</span>
              <span>新品 ${esc(yen(item.new_price))}</span>
              <span>適正 ${esc(yen(item.low))}〜${esc(yen(item.high))}</span>
            </div>
            ${item.notes ? `<p class="advice">→ 見どころ：${esc(item.notes)}</p>` : ''}
          </div>`,
        )
        .join('')}
      <div class="breakdown">
        <span class="outcome ${verdict === 'ok' ? 'closed' : verdict === 'ng' ? 'unclosed' : ''}">
          ${list.length > 1 ? '合計の' : ''}適正 ${esc(yen(total.low))}〜${esc(yen(total.high))}
        </span>
        <span>${esc(price?.message || '')}</span>
      </div>
      ${price?.quote ? `<p class="evidence">${esc(price.quote)}</p>` : ''}
    </div>`;
}

/**
 * 折れる条件の到達状況。
 * 成約したかの二値だけだと、不成約の回がすべて同じ顔になる。
 * 「2つまでは立っていた」が見えると、次に何をすればよいかが残る。
 */
function renderFlags(score) {
  const flags = score.flags || [];
  if (!flags.length) return '';
  const met = flags.filter((f) => f.met).length;
  return `
    <div class="card flags-card">
      <h4>お客様が折れる条件（${met}／${flags.length} 到達）${score.track === 'reversal' ? '<span class="pill">大逆転</span>' : ''}</h4>
      ${flags
        .map(
          (f) => `<div class="axis">
            <div class="axis-head">
              <strong>${esc(f.label)}</strong>
              <span class="deduction ${f.met ? 'zero' : ''}">${f.met ? '到達' : '未到達'}</span>
            </div>
            ${f.evidence ? `<p class="evidence">${esc(f.evidence)}</p>` : ''}
          </div>`,
        )
        .join('')}
      ${score.breaker ? `<p class="advice">やってはいけないこと：${esc(score.breaker)}</p>` : ''}
    </div>`;
}

function renderScore(s, items) {
  const b = s.breakdown || {};
  $('#score-result').innerHTML = `
    <div class="card score">
      <header class="card-head"><span class="total">${esc(s.total)}<small>/100</small></span><h3>${esc(s.headline)}</h3></header>
      <div class="breakdown">
        <span class="outcome ${b.closed ? 'closed' : 'unclosed'}">${b.closed ? '成約' : '不成約'} ${b.closePenalty ? `−${b.closePenalty}` : '±0'}</span>
        <span>型の不一致 −${esc(b.axisPenalty ?? 0)}（上限−${esc(b.maxAxisPenalty ?? 90)}）</span>
        ${b.maxPricePenalty ? `<span>査定額 −${esc(b.pricePenalty ?? 0)}（上限−${esc(b.maxPricePenalty)}）</span>` : ''}
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
    </div>
    ${renderFlags(s)}
    ${renderItems(items, s.price)}`;
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

/* --------------------------------- 記録 ---------------------------------- */

let records = [];
let recordScope = 'company';

const OUTCOME = (r) => (r.score ? (r.score.breakdown?.closed ? '成約' : '不成約') : '—');
const fbLabel = (kind, v) => config.feedbackOptions[kind]?.find((o) => o.value === v)?.label || '';
const typeLabel = (id) => config.customerTypes.find((t) => t.id === id)?.label || id || '';
const when = (iso) => (iso || '').replace('T', ' ').slice(0, 16);

// 採点が済むまで品物は伏せたまま返ってくる（Worker側の visibleItems）
const itemLabel = (items) => {
  const list = items || [];
  if (!list.length) return '—';
  if (list[0].hidden) return '採点後に開示';
  const names = list.map((i) => [i.brand, i.name].filter(Boolean).join(' '));
  return names.length > 1 ? `${names[0]} ほか${names.length - 1}点` : names[0];
};

/** 記録の絞り込みに使う判断基準の一覧。本文は取らない（一覧は全員が見てよい） */
async function refreshCriteria() {
  const data = await api.listCriteria().catch(() => null);
  if (data) criteriaList = data.criteria;
}

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
  recordScope = data.scope || 'company';
  renderRecords();
}

$('#records-filter').addEventListener('change', refreshRecords);
$('#records-reload').addEventListener('click', refreshRecords);

function renderRecords() {
  const scored = records.filter((r) => r.score);
  const closed = scored.filter((r) => r.score.breakdown?.closed).length;
  const avg = scored.length ? Math.round(scored.reduce((n, r) => n + r.score.total, 0) / scored.length) : 0;
  $('#records-summary').innerHTML = records.length
    ? `<span>${recordScope === 'self' ? '自分の記録 ' : ''}${records.length}件（採点済み${scored.length}件）</span>
       <span>成約 ${closed}／${scored.length}${scored.length ? `（${Math.round((closed / scored.length) * 100)}%）` : ''}</span>
       <span>平均 ${avg}点</span>`
    : '';

  const head = ['日時', '実施者', 'モード', '客タイプ', '品物', '成約', '総合', '型の減点', '査定額', '発話', '客の再現度', '採点の納得感', 'コメント'];
  $('#records-table').innerHTML = `
    <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${records
      .map(
        (r) => `<tr data-id="${r.id}">
          <td>${esc(when(r.created_at))}</td>
          <td>${esc(r.trainee || '—')}</td>
          <td>${esc(r.mode_name || '—')}</td>
          <td>${esc(typeLabel(r.customer_type))}</td>
          <td>${esc(itemLabel(r.items))}</td>
          <td>${r.score ? `<span class="pill ${r.score.breakdown?.closed ? 'yes' : 'no'}">${OUTCOME(r)}</span>` : '—'}</td>
          <td class="num">${r.score ? esc(r.score.total) : '—'}</td>
          <td class="num">${r.score ? `−${esc(r.score.breakdown?.axisPenalty ?? 0)}` : '—'}</td>
          <td class="num">${r.score?.breakdown?.maxPricePenalty ? `−${esc(r.score.breakdown.pricePenalty ?? 0)}` : '—'}</td>
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
  detail.innerHTML = `<td colspan="13">
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
    ${r.score ? renderFlags(r.score) : ''}
    ${renderItems(r.items, r.score?.price)}
    ${r.fb_note ? `<p class="hint">フィードバック：${esc(r.fb_note)}</p>` : ''}
  </td>`;
  tr.after(detail);
});

$('#records-csv').addEventListener('click', () => {
  const head = ['日時', '実施者', '店舗', 'モード', '判断基準', '客タイプ', '品物', '状態', '適正下限', '適正上限', '提示額', '成約', '総合点', '型の減点', '査定額の減点', '発話数', '客の再現度', '採点の納得感', 'コメント', '総評'];
  const rows = records.map((r) => {
    const list = (r.items || []).filter((i) => i && !i.hidden);
    const sum = list.reduce((a, b) => ({ low: a.low + b.low, high: a.high + b.high }), { low: 0, high: 0 });
    return [
      when(r.created_at), r.trainee, r.store, r.mode_name, r.criteria_title, typeLabel(r.customer_type),
      itemLabel(r.items), list.map((i) => i.condition_label).join('／'),
      list.length ? sum.low : '', list.length ? sum.high : '', r.score?.price?.offered ?? '',
      r.score ? OUTCOME(r) : '', r.score?.total ?? '', r.score?.breakdown?.axisPenalty ?? '',
      r.score?.breakdown?.pricePenalty ?? '',
      r.history.length, fbLabel('realism', r.fb_realism), fbLabel('scoring', r.fb_scoring),
      r.fb_note, r.score?.headline ?? '',
    ];
  });
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

/* -------------------------------- 間の計測 ------------------------------- */

// 「黙って待つ」を後から評価できるようにするため、時刻だけ裏で取る。
// 画面には出さない。出すと受講者が時計を見ながら喋ることになる。
//
// 客の声が鳴り終わってから店員が口を開くまでが「間」。
// サーバの応答時刻で測ると、ClaudeとTTSの待ち時間がそのまま間に化けるので、
// ブラウザ側で、実際に音が止まった瞬間を起点にする。
const timing = {
  runStartedAt: 0,      // 開始を押した時刻
  customerEndedAt: 0,   // 客の音声が鳴り終わった時刻
  measurable: false,    // 音声で練習しているか（テキスト練習では間を測らない）
  playingCustomer: false, // いま鳴っているのが客のセリフか
};

const nowMs = () => (window.performance?.now?.() ?? Date.now());

function startTiming() {
  timing.runStartedAt = nowMs();
  timing.customerEndedAt = 0;
  timing.measurable = false;
}

/** 客が喋り終わった。ここから店員が口を開くまでを数える */
function markCustomerDone(hadAudio) {
  timing.customerEndedAt = nowMs();
  timing.measurable = Boolean(hadAudio);
  timing.playingCustomer = false;
}

/**
 * 店員がターンを取った時点の計測値。
 * at … 開始からの経過秒。gap … 客が黙ってから口を開くまでの秒。
 * 音声で鳴っていない回は gap を測らない（読み上げが無いと起点が無い）。
 */
function takeTiming() {
  const t = nowMs();
  const at = timing.runStartedAt ? (t - timing.runStartedAt) / 1000 : null;
  const gap = timing.measurable && timing.customerEndedAt ? (t - timing.customerEndedAt) / 1000 : null;
  return {
    at: at === null ? null : Math.round(at * 10) / 10,
    gap: gap === null ? null : Math.round(gap * 10) / 10,
  };
}

// 読み上げが終わった瞬間を起点にする。
// iOS対策の無音WAVも同じ要素で鳴らしているので、客のセリフのときだけ拾う
player.addEventListener('ended', () => {
  if (timing.playingCustomer) markCustomerDone(true);
});


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
    timing.playingCustomer = false;
    speak(text);
    return;
  }
  timing.playingCustomer = true;
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
    // 間は「ボタンを押した瞬間」で確定させる。送信時に測ると、
    // 喋っていた時間まで沈黙に足されてしまう
    const taken = takeTiming();
    mediaRecorder.onstop = () => {
      setRecordingUI(false);
      const type = mediaRecorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type });
      if (blob.size) {
        sendTurn({
          audio: blob,
          filename: `turn.${type.includes('mp4') || type.includes('aac') ? 'mp4' : 'webm'}`,
          payload: { vocabulary: settings.get('vocabulary'), timing: taken },
          timing: taken,
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
  await Promise.all([refreshCriteria(), refreshModes(), loadSituationProducts()]);
  renderModeList();
}

(async function start() {
  $('#login-company').value = settings.get('lastCompany') || '';
  $('#login-staff').value = settings.get('lastStaff') || '';
  if (!settings.get('workerUrl') || !settings.get('token')) {
    showGate();
    return;
  }
  try {
    await afterConnect(await api.config());
  } catch (err) {
    showGate(`サーバーに接続できません：${err.message}`);
  }
})();
