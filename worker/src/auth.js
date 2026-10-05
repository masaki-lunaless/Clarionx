// 会社コード＋共通パスワード＋個人コードでログインする。
//
// 分け方の考え方：
//   ナレッジ（案件・判断基準・モード・商品・用語）は knowledge_space で束ねる。
//   同じ値を持つ会社どうしは同じ教材を使う。
//   実施記録は会社コードで必ず分かれる。教材は共通でも、誰が何点だったかは混ぜない。
//
// 個人コードは本人確認ではなく「どこまで見せるか・触らせるか」の切り分け。
// パスワードは会社で共通なので、個人コードで本人を特定しているとは考えないこと。

import { ApiError } from './llm.js';

export const ROLES = {
  admin:   { label: '管理者',   rank: 3 },
  trainer: { label: '指導者',   rank: 2 },
  trainee: { label: '受講者',   rank: 1 },
};

export const ROLE_LIST = Object.entries(ROLES).map(([id, r]) => ({ id, label: r.label }));

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const PBKDF2_ITERATIONS = 100000;

export async function hashPassword(password, salt = hex(crypto.getRandomValues(new Uint8Array(16)))) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return { hash: hex(bits), salt };
}

export async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const newSessionToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));

/** セッションの有効期間。店頭で毎回入れ直させたくないので長めに取る */
export const sessionDays = (env) => Math.min(90, Math.max(1, Number(env.SESSION_DAYS) || 14));

/** role に必要な権限があるか。rank の大小で判定する */
export function hasRole(auth, needed) {
  const have = ROLES[auth.role]?.rank || 0;
  return have >= (ROLES[needed]?.rank || 99);
}

export function requireRole(auth, needed) {
  if (!hasRole(auth, needed)) {
    throw new ApiError(403, `この操作は${ROLES[needed].label}以上のみです（あなたは${ROLES[auth.role]?.label || '不明'}）`);
  }
}

/** 会社コード・個人コードの書式。大文字小文字を吸収して保存する */
export function normalizeCode(value, name) {
  const code = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(code)) {
    throw new ApiError(400, `${name}は半角英数字・ハイフン・アンダースコアの2〜32文字で入れてください`);
  }
  return code;
}

/**
 * システム管理者。会社をまたいで、会社の作成とスタッフの発行ができる人。
 *
 * 会社ごとの管理者は自分の会社しか触れない。そうしないと、A社の管理者が
 * B社のパスワードを変えて入れてしまう。一方で誰かが最初の会社と
 * スタッフを作る必要があるので、その役をここで名指しする。
 *
 * 設定形式: SUPER_ADMINS = "lunaless:masaki,other:9001"（会社コード:個人コード）
 */
export function isSystemAdmin(env, company, staffCode) {
  const raw = (env.SUPER_ADMINS || '').trim();
  if (!raw || !company || !staffCode) return false;
  const me = `${company}:${staffCode}`.toLowerCase();
  return raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => entry === me);
}
