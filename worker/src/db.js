// D1へのアクセスをまとめる。SQLはここ以外に書かない。
// 全クエリが client でスコープされる。将来クライアントごとにデータを分けるとき、
// 絞り込みの漏れが起きないようにするため。

import { ApiError } from './llm.js';

export const uid = () =>
  crypto.randomUUID?.().replace(/-/g, '').slice(0, 16) ||
  Math.random().toString(36).slice(2, 12) + Date.now().toString(36);

const now = () => new Date().toISOString();

function db(env) {
  if (!env.DB) throw new ApiError(500, 'D1（DBバインディング）が設定されていません');
  return env.DB;
}

const parse = (raw, fallback) => {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

/* --------------------------------- 蓄積 ---------------------------------- */

export async function listCases(env, client) {
  const { results } = await db(env)
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM questions q WHERE q.case_id = c.id) AS q_total,
              (SELECT COUNT(*) FROM questions q WHERE q.case_id = c.id AND q.answer <> '') AS q_answered
         FROM cases c
        WHERE c.client = ?
        ORDER BY c.created_at DESC`,
    )
    .bind(client)
    .all();
  return results || [];
}

export async function getCase(env, client, id) {
  const row = await db(env).prepare('SELECT * FROM cases WHERE id = ? AND client = ?').bind(id, client).first();
  if (!row) throw new ApiError(404, '案件が見つかりません');

  const { results: tps } = await db(env)
    .prepare('SELECT * FROM turning_points WHERE case_id = ? ORDER BY seq')
    .bind(id)
    .all();
  const { results: qs } = await db(env)
    .prepare('SELECT * FROM questions WHERE case_id = ? ORDER BY seq')
    .bind(id)
    .all();

  return {
    ...row,
    turningPoints: (tps || []).map((tp) => ({
      ...tp,
      questions: (qs || []).filter((q) => q.turning_point_id === tp.id),
    })),
  };
}

export async function createCase(env, client, data) {
  const id = uid();
  const t = now();
  await db(env)
    .prepare(
      `INSERT INTO cases (id, client, title, ace_name, context, transcript, source, occurred_on, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      client,
      data.title || '無題の案件',
      data.aceName || '',
      data.context || '',
      data.transcript || '',
      data.source || 'text',
      data.occurredOn || '',
      t,
      t,
    )
    .run();
  return getCase(env, client, id);
}

export async function updateCase(env, client, id, data) {
  const fields = { title: 'title', aceName: 'ace_name', context: 'context', transcript: 'transcript', occurredOn: 'occurred_on', assessment: 'assessment' };
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(fields)) {
    if (data[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(String(data[key]));
    }
  }
  if (!sets.length) return getCase(env, client, id);
  sets.push('updated_at = ?');
  values.push(now(), id, client);
  const res = await db(env)
    .prepare(`UPDATE cases SET ${sets.join(', ')} WHERE id = ? AND client = ?`)
    .bind(...values)
    .run();
  if (!res.meta?.changes) throw new ApiError(404, '案件が見つかりません');
  return getCase(env, client, id);
}

export async function deleteCase(env, client, id) {
  // D1では外部キーのCASCADEが有効でないことがあるため、明示的に消す
  await db(env).prepare('DELETE FROM questions WHERE case_id = ?').bind(id).run();
  await db(env).prepare('DELETE FROM turning_points WHERE case_id = ?').bind(id).run();
  const res = await db(env).prepare('DELETE FROM cases WHERE id = ? AND client = ?').bind(id, client).run();
  if (!res.meta?.changes) throw new ApiError(404, '案件が見つかりません');
}

/** 検出した転換点と質問を追記する（既存の回答は消さない） */
export async function addTurningPoints(env, caseId, points) {
  const existing = await db(env)
    .prepare('SELECT COUNT(*) AS n FROM turning_points WHERE case_id = ?')
    .bind(caseId)
    .first();
  let seq = existing?.n || 0;
  let qSeq =
    (await db(env).prepare('SELECT COUNT(*) AS n FROM questions WHERE case_id = ?').bind(caseId).first())?.n || 0;

  const statements = [];
  for (const p of points) {
    const tpId = uid();
    statements.push(
      db(env)
        .prepare('INSERT INTO turning_points (id, case_id, seq, label, quote, why) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(tpId, caseId, seq++, p.label || '', p.quote || '', p.why || ''),
    );
    for (const q of p.questions || []) {
      statements.push(
        db(env)
          .prepare('INSERT INTO questions (id, turning_point_id, case_id, seq, question) VALUES (?, ?, ?, ?, ?)')
          .bind(uid(), tpId, caseId, qSeq++, q),
      );
    }
  }
  if (statements.length) await db(env).batch(statements);
}

export async function saveAnswer(env, client, questionId, answer) {
  const res = await db(env)
    .prepare(
      `UPDATE questions SET answer = ?, answered_at = ?
        WHERE id = ? AND case_id IN (SELECT id FROM cases WHERE client = ?)`,
    )
    .bind(answer, answer ? now() : null, questionId, client)
    .run();
  if (!res.meta?.changes) throw new ApiError(404, '質問が見つかりません');
}

/** 追加で掘った質問を、元の質問の直後に挿し込む */
export async function insertFollowUps(env, questionId, texts) {
  const parent = await db(env).prepare('SELECT * FROM questions WHERE id = ?').bind(questionId).first();
  if (!parent) throw new ApiError(404, '質問が見つかりません');
  await db(env)
    .prepare('UPDATE questions SET seq = seq + ? WHERE case_id = ? AND seq > ?')
    .bind(texts.length, parent.case_id, parent.seq)
    .run();
  await db(env).batch(
    texts.map((text, i) =>
      db(env)
        .prepare('INSERT INTO questions (id, turning_point_id, case_id, seq, question) VALUES (?, ?, ?, ?, ?)')
        .bind(uid(), parent.turning_point_id, parent.case_id, parent.seq + 1 + i, text),
    ),
  );
}

/** 統合の材料。指定した案件の回答済みQ&Aを取り出す */
export async function answeredQA(env, client, caseIds) {
  if (!caseIds.length) return [];
  const marks = caseIds.map(() => '?').join(',');
  const { results } = await db(env)
    .prepare(
      `SELECT q.question, q.answer, tp.quote, c.title AS case_title, c.ace_name
         FROM questions q
         JOIN turning_points tp ON tp.id = q.turning_point_id
         JOIN cases c ON c.id = q.case_id
        WHERE q.answer <> '' AND c.client = ? AND c.id IN (${marks})
        ORDER BY c.created_at, q.seq`,
    )
    .bind(client, ...caseIds)
    .all();
  return results || [];
}

/* --------------------------------- 統合 ---------------------------------- */

export async function listCriteria(env, client) {
  const { results } = await db(env)
    .prepare(
      `SELECT cr.id, cr.title, cr.summary, cr.qa_count, cr.source_case_ids, cr.created_at,
              (SELECT COUNT(*) FROM runs r WHERE r.criteria_id = cr.id) AS run_count
         FROM criteria cr
        WHERE cr.client = ?
        ORDER BY cr.created_at DESC`,
    )
    .bind(client)
    .all();
  return (results || []).map((r) => ({ ...r, source_case_ids: parse(r.source_case_ids, []) }));
}

export async function getCriteria(env, client, id) {
  const row = await db(env).prepare('SELECT * FROM criteria WHERE id = ? AND client = ?').bind(id, client).first();
  if (!row) throw new ApiError(404, '判断基準が見つかりません');
  return { ...row, source_case_ids: parse(row.source_case_ids, []) };
}

export async function createCriteria(env, client, data) {
  const id = uid();
  const t = now();
  await db(env)
    .prepare(
      `INSERT INTO criteria (id, client, title, summary, markdown, source_case_ids, qa_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, client, data.title, data.summary || '', data.markdown, JSON.stringify(data.caseIds || []), data.qaCount || 0, t, t)
    .run();
  return getCriteria(env, client, id);
}

export async function updateCriteria(env, client, id, markdown) {
  const res = await db(env)
    .prepare('UPDATE criteria SET markdown = ?, updated_at = ? WHERE id = ? AND client = ?')
    .bind(markdown, now(), id, client)
    .run();
  if (!res.meta?.changes) throw new ApiError(404, '判断基準が見つかりません');
}

export async function deleteCriteria(env, client, id) {
  await db(env).prepare('DELETE FROM modes WHERE criteria_id = ? AND client = ?').bind(id, client).run();
  const res = await db(env).prepare('DELETE FROM criteria WHERE id = ? AND client = ?').bind(id, client).run();
  if (!res.meta?.changes) throw new ApiError(404, '判断基準が見つかりません');
}

/* ------------------------------- ロープレ -------------------------------- */

export async function listModes(env, client) {
  const { results } = await db(env)
    .prepare(
      `SELECT m.*, cr.title AS criteria_title,
              (SELECT COUNT(*) FROM runs r WHERE r.mode_id = m.id) AS run_count
         FROM modes m
         JOIN criteria cr ON cr.id = m.criteria_id
        WHERE m.client = ?
        ORDER BY m.created_at DESC`,
    )
    .bind(client)
    .all();
  return results || [];
}

export async function getMode(env, client, id) {
  const row = await db(env)
    .prepare(
      `SELECT m.*, cr.markdown AS criteria_markdown, cr.title AS criteria_title
         FROM modes m JOIN criteria cr ON cr.id = m.criteria_id
        WHERE m.id = ? AND m.client = ?`,
    )
    .bind(id, client)
    .first();
  if (!row) throw new ApiError(404, 'モードが見つかりません');
  return row;
}

export async function createMode(env, client, data) {
  const id = uid();
  await db(env)
    .prepare(
      `INSERT INTO modes (id, client, name, criteria_id, customer_type, scenario, voice, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, client, data.name, data.criteriaId, data.customerType, data.scenario || '', data.voice || '', now())
    .run();
  return getMode(env, client, id);
}

export async function deleteMode(env, client, id) {
  const res = await db(env).prepare('DELETE FROM modes WHERE id = ? AND client = ?').bind(id, client).run();
  if (!res.meta?.changes) throw new ApiError(404, 'モードが見つかりません');
}

export async function createRun(env, client, data) {
  const id = uid();
  const t = now();
  await db(env)
    .prepare(
      `INSERT INTO runs (id, client, mode_id, criteria_id, trainee, history, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
    )
    .bind(id, client, data.modeId || null, data.criteriaId || null, data.trainee || '', t, t)
    .run();
  return id;
}

export async function saveRun(env, client, id, { history, score }) {
  const sets = ['updated_at = ?'];
  const values = [now()];
  if (history !== undefined) {
    sets.unshift('history = ?');
    values.unshift(JSON.stringify(history));
  }
  if (score !== undefined) {
    sets.push('score = ?');
    values.push(JSON.stringify(score));
  }
  values.push(id, client);
  const res = await db(env)
    .prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ? AND client = ?`)
    .bind(...values)
    .run();
  if (!res.meta?.changes) throw new ApiError(404, '実施記録が見つかりません');
}

const REALISM = ['real', 'mostly', 'off', 'wrong'];
const SCORING = ['agree', 'mostly', 'off', 'wrong'];

export async function saveFeedback(env, client, id, { realism, scoring, note }) {
  if (realism && !REALISM.includes(realism)) throw new ApiError(400, '客の再現度の値が不正です');
  if (scoring && !SCORING.includes(scoring)) throw new ApiError(400, '採点の納得感の値が不正です');
  const res = await db(env)
    .prepare('UPDATE runs SET fb_realism = ?, fb_scoring = ?, fb_note = ?, updated_at = ? WHERE id = ? AND client = ?')
    .bind(realism || null, scoring || null, String(note || '').slice(0, 4000), now(), id, client)
    .run();
  if (!res.meta?.changes) throw new ApiError(404, '実施記録が見つかりません');
}

export async function listRuns(env, client, { criteriaId, limit = 100 } = {}) {
  const cols = `r.*, m.name AS mode_name, m.customer_type, cr.title AS criteria_title`;
  const joins = `FROM runs r LEFT JOIN modes m ON m.id = r.mode_id LEFT JOIN criteria cr ON cr.id = r.criteria_id`;
  const sql = criteriaId
    ? `SELECT ${cols} ${joins} WHERE r.client = ? AND r.criteria_id = ? ORDER BY r.created_at DESC LIMIT ?`
    : `SELECT ${cols} ${joins} WHERE r.client = ? ORDER BY r.created_at DESC LIMIT ?`;
  const stmt = criteriaId
    ? db(env).prepare(sql).bind(client, criteriaId, limit)
    : db(env).prepare(sql).bind(client, limit);
  const { results } = await stmt.all();
  return (results || []).map((r) => ({
    ...r,
    history: parse(r.history, []),
    score: parse(r.score, null),
  }));
}

/**
 * 統合の材料になるフィードバック。
 * 「的外れ」と評価された回や、自由記述のある回を拾う。
 */
export async function feedbackForCriteria(env, client, criteriaIds) {
  if (!criteriaIds.length) return [];
  const marks = criteriaIds.map(() => '?').join(',');
  const { results } = await db(env)
    .prepare(
      `SELECT r.id, r.trainee, r.fb_realism, r.fb_scoring, r.fb_note, m.name AS mode_name
         FROM runs r LEFT JOIN modes m ON m.id = r.mode_id
        WHERE r.client = ? AND r.criteria_id IN (${marks})
          AND (r.fb_note <> '' OR r.fb_realism IN ('off','wrong') OR r.fb_scoring IN ('off','wrong'))
        ORDER BY r.created_at DESC`,
    )
    .bind(client, ...criteriaIds)
    .all();
  return results || [];
}
