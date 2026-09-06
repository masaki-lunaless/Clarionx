// 本体（app.js）と管理コンソール（admin/admin.js）で共有する小道具。
// ここを2つに分けて持つと、片方だけ直したときに挙動がずれるのでまとめてある。

import { ClarionError } from './api.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function status(el, message, kind = '') {
  if (!el) return;
  el.textContent = message;
  el.className = `status ${kind}`;
}

export const debounce = (fn, ms = 500) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/** 実行中はボタンを止め、失敗したらstatusにだけ出す（画面は壊さない） */
export async function run(button, statusEl, message, task) {
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = '処理中…';
  }
  status(statusEl, message);
  try {
    const result = await task();
    // 途中で別のメッセージに変わっていたら、それを消さない
    if (statusEl?.textContent === message) status(statusEl, '');
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
