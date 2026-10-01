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

/**
 * 判断基準の一覧。
 * 実施回数は「自分の会社の分」だけ数える。教材は会社をまたいで共有されるが、
 * 他社が何回練習したかは、回数であっても見せない。
 */
export async function listCriteria(env, client, company = client) {
  const { results } = await db(env)
    .prepare(
      `SELECT cr.id, cr.title, cr.summary, cr.qa_count, cr.source_case_ids, cr.created_at,
              (SELECT COUNT(*) FROM runs r WHERE r.criteria_id = cr.id AND r.client = ?) AS run_count
         FROM criteria cr
        WHERE cr.client = ?
        ORDER BY cr.created_at DESC`,
    )
    .bind(company, client)
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

/** モード一覧。実施回数は判断基準と同じく、自分の会社の分だけ数える */
export async function listModes(env, client, company = client) {
  const { results } = await db(env)
    .prepare(
      `SELECT m.*, cr.title AS criteria_title, p.name AS product_name,
              (SELECT COUNT(*) FROM runs r WHERE r.mode_id = m.id AND r.client = ?) AS run_count,
              (SELECT COUNT(*) FROM mode_products mp WHERE mp.mode_id = m.id) AS attached_count
         FROM modes m
         JOIN criteria cr ON cr.id = m.criteria_id
         LEFT JOIN products p ON p.id = m.product_id
        WHERE m.client = ?
        ORDER BY m.created_at DESC`,
    )
    .bind(company, client)
    .all();
  return results || [];
}

export async function getMode(env, client, id) {
  const row = await db(env)
    .prepare(
      `SELECT m.*, cr.markdown AS criteria_markdown, cr.title AS criteria_title, p.name AS product_name
         FROM modes m
         JOIN criteria cr ON cr.id = m.criteria_id
         LEFT JOIN products p ON p.id = m.product_id
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
      `INSERT INTO modes (id, client, name, criteria_id, customer_type, scenario, voice, product_id, product_category, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, client, data.name, data.criteriaId, data.customerType,
      data.scenario || '', data.voice || '',
      data.productId || null, data.productCategory || '', now(),
    )
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
      `INSERT INTO runs (id, client, mode_id, criteria_id, trainee, history, items, staff_id, store,
                         customer_type, scenario, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, client, data.modeId || null, data.criteriaId || null, data.trainee || '',
      data.items?.length ? JSON.stringify(data.items) : null, data.staffId || '', data.store || '',
      data.customerType || null, data.scenario || null, t, t,
    )
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

/**
 * 実施記録。client には会社コードが入るので、会社をまたいで見えることはない。
 * staffId を渡すとさらにその人の分だけになる（受講者向け）。
 */
export async function listRuns(env, client, { criteriaId, staffId, limit = 100 } = {}) {
  // その回で上書きされていればそちらを使う（開始前にシチュエーションを変えられるため）
  const cols = `r.*, m.name AS mode_name, COALESCE(r.customer_type, m.customer_type) AS customer_type,
                cr.title AS criteria_title`;
  const joins = `FROM runs r LEFT JOIN modes m ON m.id = r.mode_id LEFT JOIN criteria cr ON cr.id = r.criteria_id`;
  const where = ['r.client = ?'];
  const values = [client];
  if (criteriaId) {
    where.push('r.criteria_id = ?');
    values.push(criteriaId);
  }
  if (staffId) {
    where.push('r.staff_id = ?');
    values.push(staffId);
  }
  values.push(limit);
  const { results } = await db(env)
    .prepare(`SELECT ${cols} ${joins} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT ?`)
    .bind(...values)
    .all();
  return (results || []).map((r) => ({
    ...r,
    history: parse(r.history, []),
    score: parse(r.score, null),
    // item は1点しか持てなかった頃の列。古い記録のために読み続ける
    items: parse(r.items, null) || [].concat(parse(r.item, null) || []).filter(Boolean),
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

/* ------------------------- ブランド・用語マスタ --------------------------- */

export async function getGlossary(env, client) {
  const row = await db(env).prepare('SELECT text, dialect FROM glossary WHERE client = ?').bind(client).first();
  return { text: row?.text || '', dialect: row?.dialect || '' };
}

export async function saveGlossary(env, client, { text, dialect }) {
  const cur = await getGlossary(env, client);
  await db(env)
    .prepare(
      `INSERT INTO glossary (client, text, dialect, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(client) DO UPDATE SET text = excluded.text, dialect = excluded.dialect, updated_at = excluded.updated_at`,
    )
    .bind(
      client,
      String(text ?? cur.text).slice(0, 100000),
      String(dialect ?? cur.dialect).slice(0, 2000),
      now(),
    )
    .run();
}

/**
 * 「正式表記 = 誤り1, 誤り2」の行を解釈する。
 * 「=」が無い行は正式表記だけの登録として扱う。
 * Excelからの貼り付けを想定し、全角の記号も受ける。
 */
export function parseGlossary(text) {
  const entries = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [head, tail] = line.split(/\s*[=＝]\s*/, 2);
    const canonical = (head || '').trim();
    if (!canonical) continue;
    const variants = (tail || '')
      .split(/[,、，]/)
      .map((v) => v.trim())
      .filter((v) => v && v !== canonical);
    entries.push({ canonical, variants });
  }
  return entries;
}

/* ------------------------------- 商品マスタ ------------------------------ */

export async function listProducts(env, client, { category, activeOnly = false } = {}) {
  const where = ['client = ?'];
  const values = [client];
  if (category) {
    where.push('category = ?');
    values.push(category);
  }
  if (activeOnly) where.push('active = 1');
  const { results } = await db(env)
    .prepare(`SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY category, brand, name`)
    .bind(...values)
    .all();
  return results || [];
}

export async function getProduct(env, client, id) {
  const row = await db(env).prepare('SELECT * FROM products WHERE id = ? AND client = ?').bind(id, client).first();
  if (!row) throw new ApiError(404, '商品が見つかりません');
  return row;
}

/** モードの指定に合う品物を1点引く。指定が無ければマスタ全体から */
export async function drawProduct(env, client, { productId, category } = {}) {
  if (productId) return getProduct(env, client, productId);
  const pool = await listProducts(env, client, { category, activeOnly: true });
  if (!pool.length) {
    throw new ApiError(
      400,
      category
        ? `商品マスタに「${category}」の品物がありません。設定タブで登録してください`
        : '商品マスタが空です。設定タブでサンプルを読み込むか、商品を登録してください',
    );
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

/** 1件ずつ足す。総入れ替えはしない（消したくないものまで消えるため） */
export async function createProduct(env, client, r) {
  const id = uid();
  const t = now();
  await db(env)
    .prepare(
      `INSERT INTO products (id, client, category, brand, model, name, new_price, retention, notes, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, client, r.category || '', r.brand || '', r.model || '', r.name, r.newPrice, r.retention, r.notes || '', t, t)
    .run();
  return getProduct(env, client, id);
}

export async function updateProduct(env, client, id, fields) {
  const cols = {
    category: 'category', brand: 'brand', model: 'model', name: 'name',
    newPrice: 'new_price', retention: 'retention', notes: 'notes', active: 'active',
  };
  const sets = [];
  const values = [];
  for (const [key, col] of Object.entries(cols)) {
    if (fields[key] === undefined) continue;
    sets.push(`${col} = ?`);
    values.push(key === 'active' ? (fields[key] ? 1 : 0) : fields[key]);
  }
  if (!sets.length) return getProduct(env, client, id);
  sets.push('updated_at = ?');
  values.push(now(), id, client);
  const res = await db(env)
    .prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ? AND client = ?`)
    .bind(...values)
    .run();
  if (!res.meta?.changes) throw new ApiError(404, '商品が見つかりません');
  return getProduct(env, client, id);
}

export async function deleteProduct(env, client, id) {
  await db(env).prepare('DELETE FROM mode_products WHERE product_id = ?').bind(id).run();
  const res = await db(env).prepare('DELETE FROM products WHERE id = ? AND client = ?').bind(id, client).run();
  if (!res.meta?.changes) throw new ApiError(404, '商品が見つかりません');
}

/**
 * まとめて足す。すでにある商品（ブランド＋型番＋商品名が同じ）は飛ばす。
 * 取り込みで既存が消えると、手で直した買取率まで巻き戻るため。
 */
export async function addProducts(env, client, rows) {
  const existing = new Set(
    (await listProducts(env, client)).map((p) => `${p.brand}\u0000${p.model}\u0000${p.name}`),
  );
  const t = now();
  const stmts = [];
  let skipped = 0;
  for (const r of rows) {
    const key = `${r.brand || ''}\u0000${r.model || ''}\u0000${r.name}`;
    if (existing.has(key)) {
      skipped++;
      continue;
    }
    existing.add(key);
    stmts.push(
      db(env)
        .prepare(
          `INSERT INTO products (id, client, category, brand, model, name, new_price, retention, notes, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(uid(), client, r.category || '', r.brand || '', r.model || '', r.name, r.newPrice, r.retention, r.notes || '', t, t),
    );
  }
  if (stmts.length) await db(env).batch(stmts);
  return { added: stmts.length, skipped };
}

/* ------------------------ シナリオに紐づく商品 --------------------------- */

export async function listModeProducts(env, modeId) {
  const { results } = await db(env)
    .prepare(
      `SELECT p.* FROM mode_products mp JOIN products p ON p.id = mp.product_id
        WHERE mp.mode_id = ? ORDER BY mp.seq`,
    )
    .bind(modeId)
    .all();
  return results || [];
}

/** シナリオに付ける商品を入れ替える。付け外しはここでまとめて行う */
export async function setModeProducts(env, client, modeId, productIds) {
  const stmts = [db(env).prepare('DELETE FROM mode_products WHERE mode_id = ?').bind(modeId)];
  productIds.forEach((pid, i) => {
    stmts.push(
      db(env)
        .prepare(
          `INSERT INTO mode_products (mode_id, product_id, seq)
           SELECT ?, id, ? FROM products WHERE id = ? AND client = ?`,
        )
        .bind(modeId, i, pid, client),
    );
  });
  await db(env).batch(stmts);
  return listModeProducts(env, modeId);
}

export async function countProducts(env, client) {
  const row = await db(env).prepare('SELECT COUNT(*) AS n FROM products WHERE client = ?').bind(client).first();
  return row?.n || 0;
}

/* --------------------------------- 権限 ---------------------------------- */

export async function getCompany(env, code) {
  return db(env).prepare('SELECT * FROM companies WHERE code = ? AND active = 1').bind(code).first();
}

export async function listCompanies(env) {
  const { results } = await db(env)
    .prepare(
      `SELECT c.code, c.name, c.knowledge_space, c.active, c.created_at,
              (SELECT COUNT(*) FROM staff s WHERE s.company = c.code AND s.active = 1) AS staff_count,
              (SELECT COUNT(*) FROM runs r WHERE r.client = c.code) AS run_count
         FROM companies c ORDER BY c.created_at`,
    )
    .all();
  return results || [];
}

export async function upsertCompany(env, { code, name, hash, salt, knowledgeSpace }) {
  const t = now();
  await db(env)
    .prepare(
      `INSERT INTO companies (code, name, pass_hash, pass_salt, knowledge_space, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         name = excluded.name, pass_hash = excluded.pass_hash, pass_salt = excluded.pass_salt,
         knowledge_space = excluded.knowledge_space, active = 1, updated_at = excluded.updated_at`,
    )
    .bind(code, name, hash, salt, knowledgeSpace, t, t)
    .run();
}

export async function deleteCompany(env, code) {
  await db(env).prepare('DELETE FROM sessions WHERE company = ?').bind(code).run();
  await db(env).prepare('DELETE FROM staff WHERE company = ?').bind(code).run();
  const res = await db(env).prepare('DELETE FROM companies WHERE code = ?').bind(code).run();
  if (!res.meta?.changes) throw new ApiError(404, '会社が見つかりません');
}

export async function getStaffByCode(env, company, code) {
  return db(env)
    .prepare('SELECT * FROM staff WHERE company = ? AND code = ? AND active = 1')
    .bind(company, code)
    .first();
}

export async function listStaff(env, company) {
  const { results } = await db(env)
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM runs r WHERE r.staff_id = s.id) AS run_count
         FROM staff s WHERE s.company = ? ORDER BY s.active DESC, s.code`,
    )
    .bind(company)
    .all();
  return results || [];
}

export async function createStaff(env, company, { code, name, role, store }) {
  const existing = await db(env)
    .prepare('SELECT id FROM staff WHERE company = ? AND code = ?')
    .bind(company, code)
    .first();
  if (existing) throw new ApiError(409, `個人コード「${code}」はすでに使われています`);
  const id = uid();
  await db(env)
    .prepare(
      `INSERT INTO staff (id, company, code, name, role, store, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(id, company, code, name, role, store || '', now())
    .run();
  return db(env).prepare('SELECT * FROM staff WHERE id = ?').bind(id).first();
}

export async function updateStaff(env, company, id, fields) {
  const allowed = { name: 'name', role: 'role', store: 'store', active: 'active' };
  const sets = [];
  const values = [];
  for (const [key, col] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    sets.push(`${col} = ?`);
    values.push(key === 'active' ? (fields[key] ? 1 : 0) : fields[key]);
  }
  if (!sets.length) return;
  values.push(id, company);
  const res = await db(env)
    .prepare(`UPDATE staff SET ${sets.join(', ')} WHERE id = ? AND company = ?`)
    .bind(...values)
    .run();
  if (!res.meta?.changes) throw new ApiError(404, 'スタッフが見つかりません');
  // 権限を落としたり停止したりしたら、いま開いているセッションも切る
  if (fields.role !== undefined || fields.active !== undefined) {
    await db(env).prepare('DELETE FROM sessions WHERE staff_id = ?').bind(id).run();
  }
}

export async function deleteStaff(env, company, id) {
  await db(env).prepare('DELETE FROM sessions WHERE staff_id = ?').bind(id).run();
  const res = await db(env).prepare('DELETE FROM staff WHERE id = ? AND company = ?').bind(id, company).run();
  if (!res.meta?.changes) throw new ApiError(404, 'スタッフが見つかりません');
}

export async function createSession(env, { tokenHash, company, staffId, expiresAt }) {
  await db(env)
    .prepare('INSERT INTO sessions (token_hash, company, staff_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(tokenHash, company, staffId, now(), expiresAt)
    .run();
  // 期限切れはここで掃除する。cronを足さずに済ませるため
  await db(env).prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now()).run();
}

export async function findSession(env, tokenHash) {
  return db(env)
    .prepare(
      `SELECT se.*, s.code AS staff_code, s.name AS staff_name, s.role, s.store, s.active AS staff_active,
              c.name AS company_name, c.knowledge_space, c.active AS company_active
         FROM sessions se
         JOIN staff s ON s.id = se.staff_id
         JOIN companies c ON c.code = se.company
        WHERE se.token_hash = ? AND se.expires_at > ?`,
    )
    .bind(tokenHash, now())
    .first();
}

export async function deleteSession(env, tokenHash) {
  await db(env).prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}
