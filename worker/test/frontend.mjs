// 画面側の静的チェック。
//
// ブロック単位でコードを差し替えるときに、間にあった関数ごと消してしまう事故が
// 3回起きた（flagBlock / meSummary / renderFlags）。どれも構文は通るので
// node --check では気づけず、採点ボタンを押した人の画面が白くなって初めて分かった。
// 「呼んでいるのに定義が無い」をここで止める。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = ['docs/app.js', 'docs/admin/admin.js', 'docs/api.js', 'docs/ui.js', 'docs/store.js'];

// 言語とブラウザが元から持っているもの
const GLOBALS = new Set([
  'if','for','while','switch','catch','return','typeof','function','await','new','do','else','of','in',
  'Number','String','Boolean','Array','Object','Math','JSON','Set','Map','Date','Promise','Error','RegExp','Blob','File',
  'FormData','Response','Request','Headers','URL','URLSearchParams','Event','CustomEvent','AbortController','Intl',
  'parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent','atob','btoa',
  'setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame','queueMicrotask',
  'alert','confirm','prompt','fetch','import','require','console','document','window','navigator','localStorage',
  'MediaRecorder','SpeechSynthesisUtterance','AudioContext','Uint8Array','Float32Array','DataView','ArrayBuffer',
  'async','class','super','this','void','delete','yield','throw',
]);

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : ` :: ${extra}`}`);
  if (!ok) failed++;
};

for (const rel of FILES) {
  const src = readFileSync(join(root, rel), 'utf8');

  // 定義されているもの：関数宣言・const/let への代入・分割代入・import・引数は拾いきれないので緩めに
  const defined = new Set(GLOBALS);
  for (const m of src.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of src.matchAll(/(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  // オブジェクト・クラスのメソッド短縮記法（set(key, value) { ... }）
  for (const m of src.matchAll(/^\s{2,}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm)) defined.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) defined.add(part.split(':').pop().trim().replace(/\s*=.*/, ''));
  }
  for (const m of src.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) defined.add(part.trim().split(/\s+as\s+/).pop());
  }
  // 引数名（(a, b) => / function f(a, b)）
  for (const m of src.matchAll(/(?:function\s*[\w$]*\s*|=>\s*|\()\s*\(([^)]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) defined.add(part.trim().split(/[:=]/)[0].replace(/^\.\.\./, '').trim());
  }
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(',')) defined.add(part.trim().split(/[:=]/)[0].replace(/^\.\.\./, '').trim());
  }
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) defined.add(m[1]);

  // 呼び出されているもの。`.foo(` のようなメソッド呼び出しは除く
  const missing = new Set();
  for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (!defined.has(name)) missing.add(name);
  }
  check(`${rel}: 呼んでいる関数がすべて定義されている`, missing.size === 0, [...missing].join(', '));

  // 同じ名前を2回 const すると、読み込んだ瞬間にファイルごと死ぬ。
  // ブロックを移し替えるときに起きやすい
  const tops = [...src.matchAll(/^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const dup = tops.filter((n, i) => tops.indexOf(n) !== i);
  check(`${rel}: 同じ名前を2回宣言していない`, dup.length === 0, [...new Set(dup)].join(', '));
}

/* ---- 画面のidと、JSが触るidが合っているか ---- */

for (const [html, js] of [['docs/index.html', 'docs/app.js'], ['docs/admin/index.html', 'docs/admin/admin.js']]) {
  const page = readFileSync(join(root, html), 'utf8');
  const code = readFileSync(join(root, js), 'utf8');
  const ids = new Set([...page.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // 動的に差し込む要素は除外する
  const dynamic = new Set(['chunk-players', 'dl-chunks']);
  const used = [...code.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
  const gone = [...new Set(used)].filter((id) => !ids.has(id) && !dynamic.has(id));
  check(`${html}: JSが触るidがすべて存在する`, gone.length === 0, gone.join(', '));
}

/* ---- HTMLのタグが閉じているか ---- */

for (const html of ['docs/index.html', 'docs/admin/index.html']) {
  const page = readFileSync(join(root, html), 'utf8');
  for (const tag of ['section', 'details', 'table']) {
    const open = (page.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    const close = (page.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    check(`${html}: <${tag}> の開閉が合っている`, open === close, `開${open} 閉${close}`);
  }
}

/* ---- 版ずれの検知に使う印が、Workerと画面で揃っているか ---- */

// 揃っていないと、配信直後に全員へ「新しい版が出ています」が出続ける。
// 逆に更新し忘れると、古いJSが黙って動き続ける。
const buildOf = (rel) => readFileSync(join(root, rel), 'utf8').match(/const BUILD = '([^']+)'/)?.[1];
const builds = ['worker/src/index.js', 'docs/app.js', 'docs/admin/admin.js'].map((f) => [f, buildOf(f)]);
check(
  'BUILD の印がWorkerと画面で揃っている',
  builds.every(([, v]) => v && v === builds[0][1]),
  builds.map(([f, v]) => `${f}=${v}`).join(' / '),
);

console.log(failed ? `\n${failed} 件失敗` : '\n画面側も通過');
process.exit(failed ? 1 : 0);
