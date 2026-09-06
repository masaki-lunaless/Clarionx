// 管理コンソール。会社・スタッフ・商品マスタ・用語マスタを扱う。
//
// 練習画面（../app.js）と分けてあるのは、運用する人と現場で練習する人で
// 見るものがまったく違うため。設定タブに全部を積むと、受講者が触る画面に
// 相場表とスタッフ一覧のコードが載ることになる。
//
// 接続設定とセッションは localStorage 経由で練習画面と共有している。
// 片方でログインすれば、もう片方も入れる。

import { api } from '../api.js';
import { settings } from '../store.js';
import { $, $$, esc, run, status } from '../ui.js';

let config = { roles: [], conditions: [], accessories: [] };
let me = null;
let products = [];
let staffList = [];
let staffCompany = '';

/* ---------------------------------- タブ --------------------------------- */

function activateTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${name}`));
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

  // 管理者以外はここに用がない。何も読まずに理由だけ出す
  const denied = !me?.can?.masters;
  $('#denied-banner').hidden = !denied;
  $('#who').hidden = false;
  const roleLabel = (config.roles || []).find((r) => r.id === me?.role)?.label || '';
  $('#who-name').textContent = me?.staff_name
    ? `${me.company_name}／${me.staff_name}（${roleLabel}）`
    : `${me.company_name}（共有トークン）`;
  if (denied) {
    status(el, `${roleLabel}では管理コンソールを使えません`, 'error');
    return;
  }

  status(el, `接続OK — ${me.company_name} / ナレッジ空間 ${me.knowledge_space}`, 'ok');
  fillSelect($('#staff-role'), config.roles.map((r) => ({ value: r.id, label: r.label })));
  fillSelect($('#calc-condition'), config.conditions.map((c) => ({ value: c.id, label: `${c.label}（${c.desc}）` })));
  fillSelect($('#calc-accessory'), config.accessories.map((a) => ({ value: a.id, label: a.label })));
  await loadGlossary();
  await loadProducts();
  await loadCompanies();
  await loadStaff();
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

/* ------------------------------- 商品マスタ ------------------------------ */

const yen = (v) => `${Math.round(Number(v) || 0).toLocaleString('ja-JP')}円`;
const productLine = (p) => [p.category, p.brand, p.model, p.name, p.new_price, p.retention, p.notes].join('\t');

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
  status($('#product-count'), `${shown.length}件${q ? `（全${products.length}件中）` : ''}`);
  $('#product-table').innerHTML = `
    <thead><tr><th>カテゴリ</th><th>ブランド</th><th>型番</th><th>商品名</th><th>新品価格</th><th>買取率</th><th>備考</th></tr></thead>
    <tbody>${shown
      .map(
        (p) => `<tr>
          <td>${esc(p.category)}</td><td>${esc(p.brand)}</td><td>${esc(p.model)}</td><td>${esc(p.name)}</td>
          <td class="num">${esc(yen(p.new_price))}</td><td class="num">${esc(p.retention)}%</td>
          <td>${esc(p.notes)}</td>
        </tr>`,
      )
      .join('')}</tbody>`;
}
$('#product-filter').addEventListener('input', renderProducts);

$('#save-products').addEventListener('click', async (e) => {
  if (!confirm('いま登録されている商品をすべて消して、貼り付けた内容に入れ替えます。よろしいですか。')) return;
  const el = $('#products-status');
  const out = await run(e.target, el, '保存中…', () => api.saveProducts($('#products').value));
  if (!out) return;
  await loadProducts();
  status(el, `${out.count}件に入れ替えました`, 'ok');
});

$('#seed-products').addEventListener('click', async (e) => {
  if (!confirm('いま登録されている商品をすべて消して、サンプル100点に入れ替えます。よろしいですか。')) return;
  const el = $('#products-status');
  const out = await run(e.target, el, '読み込み中…', () => api.seedProducts());
  if (!out) return;
  await loadProducts();
  status(el, `${out.count}件を読み込みました。買取率は現場の相場に合わせて直してください`, 'ok');
});

// Excelへ持っていくため。クリップボードが使えない環境では選択状態にするだけにする
$('#copy-products').addEventListener('click', async () => {
  const box = $('#products');
  box.value = products.map(productLine).join('\n');
  box.select();
  const ok = await navigator.clipboard?.writeText(box.value).then(() => true, () => false);
  status($('#products-status'), ok ? 'クリップボードにコピーしました' : '欄を選択しました。コピーしてください', 'ok');
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
