// Clarion backend — Cloudflare Worker
//
// 3ステップ構成：
//   1. 蓄積   /api/cases …        接客を溜め、なぜを聞き、回答を貯める
//   2. ロープレ /api/modes, /api/runs … 溜めたものから作ったモードで練習し、フィードバックを返す
//   3. 統合   /api/criteria …     複数の案件とフィードバックを束ねて判断基準にする
//
// APIキーの隠蔽と、STT→LLM→TTSの直列処理の集約もここが担う。

import { ApiError, EFFORT, MODELS, generateStructured, generateText } from './llm.js';
import { activeProvider, listVoices, synthesize, transcribe } from './audio.js';
import * as db from './db.js';
import {
  CUSTOMER_TYPES,
  assessTranscriptRequest,
  criteriaRequest,
  fillQuestionsRequest,
  formatTranscriptRequest,
  followUpRequest,
  roleplaySystemPrompt,
  scoringRequest,
  turningPointsRequest,
  voiceDirection,
} from './prompts.js';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Whisper APIの上限
const MAX_TRANSCRIPT_CHARS = 60000;

// 採点の配点。成約は二値の固定ポイント、残りは判断基準に沿えなかった分の減点。
// 現場の重みに合わせて変えるのはこの2つだけでよい。
export const SCORING = {
  unclosedPenalty: 30, // 不成約なら引く点（成約していれば0）
  maxAxisPenalty: 70,  // 型の不一致で引ける上限。軸数で按分する
};

/**
 * 減点法で総合点を出す。
 * AIには軸ごとの減点幅（0〜10）と成約の二値判定だけを任せ、合計はここで決める。
 * 採点のたびに配点が揺れないようにするため。
 */
export function computeTotal(score) {
  const axes = score.per_axis || [];
  const cap = axes.length * 10;
  const raw = axes.reduce((sum, a) => sum + Math.min(10, Math.max(0, Number(a.deduction) || 0)), 0);
  const axisPenalty = cap ? Math.round((raw / cap) * SCORING.maxAxisPenalty) : 0;
  const closePenalty = score.closed ? 0 : SCORING.unclosedPenalty;
  return {
    ...score,
    total: Math.max(0, 100 - closePenalty - axisPenalty),
    breakdown: {
      closed: Boolean(score.closed),
      closePenalty,
      axisPenalty,
      maxAxisPenalty: SCORING.maxAxisPenalty,
    },
  };
}

/* -------------------------------- 共通処理 -------------------------------- */

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : '';
  return {
    'access-control-allow-origin': allowOrigin || 'null',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-clarion-token',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(data, request, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(request, env) },
  });
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * クライアント別トークン認証。
 * ACCESS_TOKENS 未設定なら誰でも通す（ローカル開発用）。
 * 設定形式: "clientA:xxxxx,clientB:yyyyy" もしくはトークンのカンマ区切り。
 */
function authenticate(request, env) {
  const raw = (env.ACCESS_TOKENS || '').trim();
  const supplied = request.headers.get('x-clarion-token') || '';
  if (!raw) return { client: 'dev', admin: true };
  if (!supplied) throw new ApiError(401, 'アクセストークンが必要です');

  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    const name = idx === -1 ? 'client' : entry.slice(0, idx);
    const token = idx === -1 ? entry : entry.slice(idx + 1);
    if (token && timingSafeEqual(token, supplied)) return { client: name, admin: isAdmin(env, supplied) };
  }
  throw new ApiError(401, 'アクセストークンが違います');
}

/**
 * 統合（ステップ3）を管理者に限定するための判定。
 * ADMIN_TOKENS 未設定のあいだは全員が管理者＝フルオープン。
 * 絞りたくなったら、この環境変数に管理者トークンを入れるだけでよい。
 */
function isAdmin(env, supplied) {
  const raw = (env.ADMIN_TOKENS || '').trim();
  if (!raw) return true;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .some((token) => timingSafeEqual(token, supplied));
}

function requireAdmin(auth) {
  if (!auth.admin) throw new ApiError(403, 'この操作は管理者のみです');
}

// 管理者を絞ると、統合（ステップ3）と削除が管理者だけになる。
// ADMIN_TOKENS に入れるトークンは、ACCESS_TOKENS にも「同じラベル」で登録すること。
// ラベルが違うとデータの持ち主が別扱いになり、管理者から他の人のデータが見えなくなる。
//   例) ACCESS_TOKENS = "clarion:みんなの共有トークン,clarion:管理者トークン"
//       ADMIN_TOKENS  = "管理者トークン"

async function readBody(request) {
  const type = request.headers.get('content-type') || '';
  if (type.includes('multipart/form-data')) {
    const form = await request.formData();
    const audio = form.get('audio');
    let payload = {};
    const raw = form.get('payload');
    if (typeof raw === 'string' && raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new ApiError(400, 'payloadのJSONが不正です');
      }
    }
    if (audio && typeof audio !== 'string') {
      if (audio.size > MAX_AUDIO_BYTES) throw new ApiError(413, '音声ファイルが大きすぎます（25MBまで）');
      payload.__audio = audio;
      payload.__filename = audio.name;
    }
    return payload;
  }
  if (!type.includes('application/json')) return {};
  return request.json().catch(() => {
    throw new ApiError(400, 'JSONが不正です');
  });
}

function requireString(value, name, max = MAX_TRANSCRIPT_CHARS) {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(400, `${name} が必要です`);
  if (value.length > max) throw new ApiError(413, `${name} が長すぎます（${max}文字まで）`);
  return value.trim();
}

/** 音声は書き起こしたら破棄する。監視カメラ録音を保持しない方針のため保存はしない。 */
async function transcribeIfAudio(env, body) {
  if (!body.__audio) return '';
  return transcribe(env, body.__audio, { prompt: body.vocabulary, filename: body.__filename });
}

function criteriaToMarkdown(doc) {
  const lines = [`# ${doc.title || '判断基準ドキュメント'}`, '', doc.summary || '', ''];
  for (const [i, axis] of (doc.axes || []).entries()) {
    lines.push(`## ${i + 1}. ${axis.name}`, '', axis.principle, '');
    if (axis.signals?.length) lines.push('**この合図が見えたら**', ...axis.signals.map((s) => `- ${s}`), '');
    if (axis.actions?.length) lines.push('**こうする**', ...axis.actions.map((s) => `- ${s}`), '');
    if (axis.ng?.length) lines.push('**やらない**', ...axis.ng.map((s) => `- ${s}`), '');
    if (axis.quotes?.length) lines.push('**本人の言葉**', ...axis.quotes.map((s) => `> ${s}`), '');
  }
  if (doc.gaps?.length) lines.push('## まだ聞けていないこと', '', ...doc.gaps.map((s) => `- ${s}`), '');
  return lines.join('\n');
}

/* --------------------------------- ルート -------------------------------- */

const routes = [
  ['GET', '/api/health', async (_c) => ({ ok: true, service: 'clarion' })],

  [
    'GET',
    '/api/config',
    async ({ env, auth }) => ({
      customerTypes: CUSTOMER_TYPES.map(({ id, label, hint }) => ({ id, label, hint })),
      voices: listVoices(env),
      stt: Boolean(env.OPENAI_API_KEY),
      tts: activeProvider(env),
      models: MODELS,
      client: auth.client,
      admin: auth.admin,
      feedbackOptions: FEEDBACK_OPTIONS,
    }),
  ],

  /* ------------------------------ 1. 蓄積 ------------------------------- */

  ['GET', '/api/cases', async ({ env, auth }) => ({ cases: await db.listCases(env, auth.client) })],

  [
    'POST',
    '/api/cases',
    async ({ env, auth, body }) => {
      const transcribed = await transcribeIfAudio(env, body);
      const transcript = [body.transcript, transcribed].filter(Boolean).join('\n').trim();
      return {
        case: await db.createCase(env, auth.client, {
          ...body,
          transcript,
          source: transcribed ? 'audio' : 'text',
        }),
      };
    },
  ],

  ['GET', '/api/cases/:id', async ({ env, auth, params }) => ({ case: await db.getCase(env, auth.client, params.id) })],

  [
    'PATCH',
    '/api/cases/:id',
    async ({ env, auth, params, body }) => ({ case: await db.updateCase(env, auth.client, params.id, body) }),
  ],

  [
    'DELETE',
    '/api/cases/:id',
    async ({ env, auth, params }) => {
      requireAdmin(auth); // 回答ごと消えるため
      await db.deleteCase(env, auth.client, params.id);
      return { ok: true };
    },
  ],

  // 音声を追記で書き起こす（既存の書き起こしの後ろに足す）
  [
    'POST',
    '/api/cases/:id/transcribe',
    async ({ env, auth, params, body }) => {
      if (!body.__audio) throw new ApiError(400, '音声ファイルが必要です');
      const text = await transcribeIfAudio(env, body);
      if (!text) {
        // Whisperの誤出力を除いた結果、何も残らなかった＝話し声が入っていない
        throw new ApiError(422, 'この音声からは話し声を検出できませんでした。録音の音量や内容を確認してください');
      }
      const current = await db.getCase(env, auth.client, params.id);
      const transcript = [current.transcript, text].filter(Boolean).join('\n');
      return { case: await db.updateCase(env, auth.client, params.id, { transcript }), added: text };
    },
  ],

  // 素材として使えるかを見立てる（50時間の録画から使える区間を選ぶため）
  [
    'POST',
    '/api/cases/:id/assess',
    async ({ env, auth, params }) => {
      const target = await db.getCase(env, auth.client, params.id);
      const transcript = requireString(target.transcript, '書き起こし');
      const out = await generateStructured(env, {
        ...assessTranscriptRequest({ transcript }),
        model: MODELS.chat,
        maxTokens: 1500,
        effort: EFFORT.scoring,
        label: 'assess',
      });
      await db.updateCase(env, auth.client, params.id, { assessment: JSON.stringify(out) });
      return { assessment: out };
    },
  ],

  // 書き起こしに話者と句読点を入れる
  [
    'POST',
    '/api/cases/:id/format',
    async ({ env, auth, params }) => {
      const target = await db.getCase(env, auth.client, params.id);
      const transcript = requireString(target.transcript, '書き起こし');
      const formatted = await generateText(env, {
        ...formatTranscriptRequest({ transcript, context: contextOf(target) }),
        model: MODELS.chat,
        maxTokens: 16000,
        effort: EFFORT.analysis,
        label: 'format',
      });
      const body = stripPreamble(formatted);
      if (!body) throw new ApiError(502, '整形できませんでした');
      return { case: await db.updateCase(env, auth.client, params.id, { transcript: body }) };
    },
  ],

  // 転換点を検出して質問を作り、案件に追記する
  [
    'POST',
    '/api/cases/:id/detect',
    async ({ env, auth, params }) => {
      const target = await db.getCase(env, auth.client, params.id);
      const transcript = requireString(target.transcript, '書き起こし');
      const req = turningPointsRequest({ transcript, context: contextOf(target) });
      const out = await generateStructured(env, { ...req, model: MODELS.analysis, maxTokens: 6000, effort: EFFORT.analysis, label: 'detect' });
      let points = (out.turning_points || []).filter((p) => p && p.quote);

      // スキーマのrequiredは厳密には強制されないため、questionsが欠けることがある。
      // 転換点自体は使えるので、欠けた分だけ埋め直す（全体をやり直すより速く安い）。
      const missing = points.filter((p) => !(p.questions || []).length);
      if (missing.length) {
        console.warn(`questions missing for ${missing.length}/${points.length} turning points; repairing`);
        try {
          const repair = await generateStructured(env, {
            ...fillQuestionsRequest({ transcript, points: missing }),
            model: MODELS.analysis,
            maxTokens: 3000,
            effort: EFFORT.analysis,
            label: 'detect-repair',
          });
          for (const item of repair.items || []) {
            const t = missing[item.index];
            if (t && (item.questions || []).length) t.questions = item.questions;
          }
        } catch (err) {
          console.warn('question repair failed', err?.message || err);
        }
      }

      points = points.filter((p) => (p.questions || []).length);
      if (!points.length) throw new ApiError(502, '転換点を抽出できませんでした。書き起こしを確認してください');
      await db.addTurningPoints(env, params.id, points);
      return { case: await db.getCase(env, auth.client, params.id), added: points.length };
    },
  ],

  [
    'PATCH',
    '/api/questions/:id',
    async ({ env, auth, params, body }) => {
      await db.saveAnswer(env, auth.client, params.id, String(body.answer ?? '').slice(0, 8000));
      return { ok: true };
    },
  ],

  // もう一段掘る
  [
    'POST',
    '/api/questions/:id/follow-up',
    async ({ env, auth, params, body }) => {
      const question = requireString(body.question, 'question', 4000);
      const answer = requireString(body.answer, 'answer', 8000);
      await db.saveAnswer(env, auth.client, params.id, answer);
      const req = followUpRequest({ question, answer, quote: body.quote });
      const out = await generateStructured(env, { ...req, model: MODELS.analysis, maxTokens: 1000, effort: EFFORT.followUp, label: 'follow-up' });
      const questions = out.enough ? [] : out.questions || [];
      if (questions.length) await db.insertFollowUps(env, params.id, questions);
      return { enough: Boolean(out.enough), reason: out.reason || '', added: questions };
    },
  ],

  /* ------------------------------ 3. 統合 ------------------------------- */

  ['GET', '/api/criteria', async ({ env, auth }) => ({ criteria: await db.listCriteria(env, auth.client) })],

  ['GET', '/api/criteria/:id', async ({ env, auth, params }) => ({ criteria: await db.getCriteria(env, auth.client, params.id) })],

  // 統合の材料になるフィードバック（次の統合に食わせる）
  [
    'GET',
    '/api/criteria/:id/feedback',
    async ({ env, auth, params }) => ({ feedback: await db.feedbackForCriteria(env, auth.client, [params.id]) }),
  ],

  [
    'POST',
    '/api/criteria',
    async ({ env, auth, body }) => {
      requireAdmin(auth);
      const caseIds = Array.isArray(body.caseIds) ? body.caseIds.filter(Boolean) : [];
      if (!caseIds.length) throw new ApiError(400, '統合する案件を1件以上選んでください');

      const qa = await db.answeredQA(env, auth.client, caseIds);
      if (!qa.length) throw new ApiError(400, '選んだ案件に回答済みのQ&Aがありません');

      // 前回までのロープレで「的外れ」と評価された点や自由記述を、統合の補足として渡す
      const fbIds = Array.isArray(body.feedbackCriteriaIds) ? body.feedbackCriteriaIds.filter(Boolean) : [];
      const feedback = fbIds.length ? await db.feedbackForCriteria(env, auth.client, fbIds) : [];
      const notes = [body.notes, formatFeedbackNotes(feedback)].filter(Boolean).join('\n\n');

      const req = criteriaRequest({
        qa: qa.map((r) => ({ question: r.question, answer: r.answer, quote: r.quote })),
        notes,
      });
      const doc = await generateStructured(env, { ...req, model: MODELS.analysis, maxTokens: 8000, effort: EFFORT.analysis, label: 'merge' });

      return {
        criteria: await db.createCriteria(env, auth.client, {
          title: doc.title || '判断基準ドキュメント',
          summary: doc.summary || '',
          markdown: criteriaToMarkdown(doc),
          caseIds,
          qaCount: qa.length,
        }),
        usedFeedback: feedback.length,
      };
    },
  ],

  [
    'PATCH',
    '/api/criteria/:id',
    async ({ env, auth, params, body }) => {
      requireAdmin(auth);
      await db.updateCriteria(env, auth.client, params.id, requireString(body.markdown, 'markdown'));
      return { ok: true };
    },
  ],

  [
    'DELETE',
    '/api/criteria/:id',
    async ({ env, auth, params }) => {
      requireAdmin(auth);
      await db.deleteCriteria(env, auth.client, params.id);
      return { ok: true };
    },
  ],

  /* ----------------------------- 2. ロープレ ---------------------------- */

  ['GET', '/api/modes', async ({ env, auth }) => ({ modes: await db.listModes(env, auth.client) })],

  [
    'POST',
    '/api/modes',
    async ({ env, auth, body }) => {
      const name = requireString(body.name, 'name', 200);
      const criteriaId = requireString(body.criteriaId, 'criteriaId', 100);
      await db.getCriteria(env, auth.client, criteriaId); // 存在確認
      const customerType = requireString(body.customerType, 'customerType', 100);
      const mode = await db.createMode(env, auth.client, {
        name,
        criteriaId,
        customerType,
        scenario: body.scenario,
        voice: body.voice,
      });
      return { mode: modeSummary(mode) };
    },
  ],

  [
    'DELETE',
    '/api/modes/:id',
    async ({ env, auth, params }) => {
      requireAdmin(auth);
      await db.deleteMode(env, auth.client, params.id);
      return { ok: true };
    },
  ],

  ['GET', '/api/runs', async ({ env, auth, url }) => ({
    runs: await db.listRuns(env, auth.client, { criteriaId: url.searchParams.get('criteriaId') || undefined }),
  })],

  // 開始：客に第一声を言わせるところまで
  [
    'POST',
    '/api/runs',
    async ({ env, auth, body }) => {
      const mode = await db.getMode(env, auth.client, requireString(body.modeId, 'modeId', 100));
      const runId = await db.createRun(env, auth.client, {
        modeId: mode.id,
        criteriaId: mode.criteria_id,
        trainee: String(body.trainee || '').slice(0, 100),
      });
      const turn = await speakAsCustomer(env, mode, [], { opening: true });
      const history = [{ role: 'customer', text: turn.replyText }];
      await db.saveRun(env, auth.client, runId, { history });
      return { runId, mode: modeSummary(mode), history, ...turn };
    },
  ],

  // 1ターン：音声 → Whisper → Claude → TTS
  [
    'POST',
    '/api/runs/:id/turn',
    async ({ env, auth, params, body }) => {
      const runs = await db.listRuns(env, auth.client, {});
      const run = runs.find((r) => r.id === params.id);
      if (!run) throw new ApiError(404, '実施記録が見つかりません');
      const mode = await db.getMode(env, auth.client, run.mode_id);

      let text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) text = await transcribeIfAudio(env, body);
      if (!text) throw new ApiError(400, '発話（音声またはテキスト）が必要です');

      const history = [...run.history, { role: 'trainee', text }];
      const turn = await speakAsCustomer(env, mode, history, {});
      history.push({ role: 'customer', text: turn.replyText });
      await db.saveRun(env, auth.client, params.id, { history });
      return { transcript: text, history, ...turn };
    },
  ],

  [
    'POST',
    '/api/runs/:id/score',
    async ({ env, auth, params }) => {
      const runs = await db.listRuns(env, auth.client, {});
      const run = runs.find((r) => r.id === params.id);
      if (!run) throw new ApiError(404, '実施記録が見つかりません');
      if (!run.history.length) throw new ApiError(400, '会話がありません');
      const criteria = await db.getCriteria(env, auth.client, run.criteria_id);
      const mode = run.mode_id ? await db.getMode(env, auth.client, run.mode_id).catch(() => null) : null;
      const req = scoringRequest({
        history: run.history,
        criteria: criteria.markdown,
        customerType: mode?.customer_type,
      });
      const raw = await generateStructured(env, { ...req, model: MODELS.analysis, maxTokens: 4000, effort: EFFORT.scoring, label: 'score' });
      const score = computeTotal(raw);
      await db.saveRun(env, auth.client, params.id, { score });
      return { score };
    },
  ],

  // フィードバック：客の再現度と採点の納得感を別々に受ける
  [
    'PATCH',
    '/api/runs/:id/feedback',
    async ({ env, auth, params, body }) => {
      await db.saveFeedback(env, auth.client, params.id, {
        realism: body.realism,
        scoring: body.scoring,
        note: body.note,
      });
      return { ok: true };
    },
  ],

  // 単体TTS（読み上げのやり直し用）
  [
    'POST',
    '/api/tts',
    async ({ env, body }) => {
      const text = requireString(body.text, 'text', 3000);
      const audioUrl = await synthesize(env, text, {
        voice: body.voice,
        speed: body.speed,
        ...voiceDirection(body.customerType),
      });
      return { audioUrl };
    },
  ],
];

export const FEEDBACK_OPTIONS = {
  realism: [
    { value: 'real', label: '現場にいそうな客だった' },
    { value: 'mostly', label: 'だいたい現実的' },
    { value: 'off', label: '少しずれている' },
    { value: 'wrong', label: '的外れ' },
  ],
  scoring: [
    { value: 'agree', label: '納得できる採点' },
    { value: 'mostly', label: 'だいたい納得' },
    { value: 'off', label: '少しずれている' },
    { value: 'wrong', label: '的外れ' },
  ],
};

const labelOf = (kind, value) => FEEDBACK_OPTIONS[kind].find((o) => o.value === value)?.label || value || '未評価';

/** ロープレのフィードバックを、統合プロンプトに渡せる文章にする */
function formatFeedbackNotes(feedback) {
  if (!feedback.length) return '';
  const lines = feedback.map((f) => {
    const head = `- [${f.mode_name || 'モード不明'}] 客の再現度:${labelOf('realism', f.fb_realism)} / 採点:${labelOf('scoring', f.fb_scoring)}`;
    return f.fb_note ? `${head}\n  現場のコメント：${f.fb_note}` : head;
  });
  return `【前回までのロープレに対する現場からのフィードバック】
以下は、この判断基準で練習した人・見た人の評価です。「少しずれている」「的外れ」と言われた点や、
現場のコメントで指摘された内容は、判断基準の書き方が実態と合っていない可能性があります。
統合の際に反映してください。
${lines.join('\n')}`;
}

const contextOf = (c) => [c.ace_name && `対象者：${c.ace_name}`, c.context].filter(Boolean).join('\n');

/** モードの公開形。criteria_markdown は客役への指示なのでクライアントには返さない。 */
const modeSummary = (m) => ({
  id: m.id,
  name: m.name,
  criteria_id: m.criteria_id,
  criteria_title: m.criteria_title,
  customer_type: m.customer_type,
  scenario: m.scenario,
  voice: m.voice,
});

/**
 * 客のセリフに混じったト書きを落とす。
 * プロンプトで禁止しているが完全には守られず、残ると音声でそのまま読み上げられてしまう。
 */
/**
 * 整形結果の前置きを落とす。
 * 「以下、整理しました」のような説明が付いてくることがあり、そのまま書き起こしに残ってしまう。
 * 最初の話者ラベルより前を捨てる。
 */
export function stripPreamble(text) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((l) => /^\s*(店員|客\d?|\?)\s*[：:]/.test(l));
  return (start === -1 ? lines : lines.slice(start)).join('\n').trim();
}

export function stripStageDirections(text) {
  const cleaned = String(text || '')
    .replace(/\*[^*]*\*/g, '')   // *両手でカウンターに置きながら*
    .replace(/（[^）]*）/g, '')    // （うなずいて）
    .replace(/\([^)]*\)/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // 全部がト書きだった場合は元の文を返す（無音になるより読み上げたほうがまし）
  return cleaned || String(text || '').trim();
}

/** 客役の1発話を作り、読み上げ音声まで用意する */
async function speakAsCustomer(env, mode, history, { opening }) {
  const messages = history.map((m) => ({
    role: m.role === 'trainee' ? 'user' : 'assistant',
    content: String(m.text || '').slice(0, 4000),
  }));
  if (opening) messages.push({ role: 'user', content: '（お客様が来店しました。あなたから最初の一言をどうぞ）' });

  const raw = await generateText(env, {
    model: MODELS.chat,
    system: roleplaySystemPrompt({
      customerType: mode.customer_type,
      scenario: mode.scenario,
      criteria: mode.criteria_markdown,
    }),
    messages: messages.slice(-40),
    maxTokens: 400,
    temperature: 1,
    effort: EFFORT.chat,
    cacheSystem: true,
    label: 'turn',
  });
  const replyText = stripStageDirections(raw);

  const audioUrl = await synthesize(env, replyText, {
    voice: mode.voice || undefined,
    ...voiceDirection(mode.customer_type),
  });
  return { replyText, audioUrl };
}

/* -------------------------------- ルーター ------------------------------- */

function match(method, pathname) {
  const parts = pathname.replace(/\/$/, '').split('/').filter(Boolean);
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const segs = pattern.split('/').filter(Boolean);
    if (segs.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].startsWith(':')) params[segs[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (segs[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const label = `${request.method} ${url.pathname}`;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const route = match(request.method, url.pathname);
    if (!route) return json({ error: 'Not found', path: url.pathname }, request, env, 404);

    try {
      const auth = url.pathname === '/api/health' ? { client: 'anon', admin: false } : authenticate(request, env);
      const body = request.method === 'GET' || request.method === 'DELETE' ? {} : await readBody(request);
      const result = await route.handler({ env, auth, body, params: route.params, url, request });
      return json(result, request, env);
    } catch (err) {
      if (err instanceof ApiError) {
        console.warn(`[${label}] ${err.status} ${err.message}`, err.detail || '');
        return json({ error: err.message, detail: err.detail }, request, env, err.status);
      }
      console.error(`[${label}] unhandled`, err?.stack || err);
      return json({ error: 'サーバー内部エラー' }, request, env, 500);
    }
  },
};
