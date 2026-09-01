// Clarion backend — Cloudflare Worker
// フロント（GitHub Pages）からのリクエストを受け、Claude / Whisper / にじボイス を叩く。
// 目的：APIキーの隠蔽と、STT→LLM→TTSの直列処理を1リクエストに集約すること。

import { ApiError, MODELS, generateStructured, generateText } from './llm.js';
import { listVoiceActors, synthesize, transcribe } from './audio.js';
import {
  CUSTOMER_TYPES,
  criteriaRequest,
  followUpRequest,
  roleplaySystemPrompt,
  scoringRequest,
  turningPointsRequest,
} from './prompts.js';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Whisper APIの上限
const MAX_TRANSCRIPT_CHARS = 60000;

function corsHeaders(request, env) {
  const origin = request.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowOrigin = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : '';
  return {
    'access-control-allow-origin': allowOrigin || 'null',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
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

/**
 * クライアント別トークン認証。
 * ACCESS_TOKENS 未設定なら誰でも通す（ローカル開発用）。
 * 設定形式: "clientA:xxxxx,clientB:yyyyy" もしくはトークンのカンマ区切り。
 */
function authenticate(request, env) {
  const raw = (env.ACCESS_TOKENS || '').trim();
  if (!raw) return { client: 'dev' };
  const supplied = request.headers.get('x-clarion-token') || '';
  if (!supplied) throw new ApiError(401, 'アクセストークンが必要です');

  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    const name = idx === -1 ? 'client' : entry.slice(0, idx);
    const token = idx === -1 ? entry : entry.slice(idx + 1);
    if (token && timingSafeEqual(token, supplied)) return { client: name };
  }
  throw new ApiError(401, 'アクセストークンが違います');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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

const routes = {
  'GET /api/health': async (_body, request, env) => json({ ok: true, service: 'clarion' }, request, env),

  'GET /api/config': async (_body, request, env) =>
    json(
      {
        customerTypes: CUSTOMER_TYPES,
        voiceActors: await listVoiceActors(env),
        stt: Boolean(env.OPENAI_API_KEY),
        tts: Boolean(env.NIJIVOICE_API_KEY),
        models: MODELS,
      },
      request,
      env,
    ),

  // ① 音声 → 書き起こし（監視カメラ映像からffmpegで抜いた音声を想定）
  'POST /api/stt': async (body, request, env) => {
    if (!body.__audio) throw new ApiError(400, '音声ファイルが必要です');
    const transcript = await transcribe(env, body.__audio, {
      prompt: body.vocabulary,
      filename: body.__filename,
    });
    return json({ transcript }, request, env);
  },

  // ② 「なぜ」を聞く — 転換点抽出と質問生成
  'POST /api/questions': async (body, request, env) => {
    const transcript = requireString(body.transcript, 'transcript');
    const req = turningPointsRequest({ transcript, context: body.context });
    const out = await generateStructured(env, { ...req, model: MODELS.analysis });
    return json({ turningPoints: out.turning_points || [] }, request, env);
  },

  // ② 追加で掘る質問
  'POST /api/follow-up': async (body, request, env) => {
    const question = requireString(body.question, 'question', 4000);
    const answer = requireString(body.answer, 'answer', 8000);
    const req = followUpRequest({ question, answer, quote: body.quote });
    const out = await generateStructured(env, { ...req, model: MODELS.analysis, maxTokens: 1000 });
    return json(out, request, env);
  },

  // ③ 判断基準ドキュメント化
  'POST /api/criteria': async (body, request, env) => {
    const qa = Array.isArray(body.qa) ? body.qa.filter((x) => x && x.question && x.answer) : [];
    if (qa.length === 0) throw new ApiError(400, '回答済みのQ&Aが1件以上必要です');
    const req = criteriaRequest({ qa, notes: body.notes });
    const doc = await generateStructured(env, { ...req, model: MODELS.analysis, maxTokens: 8000 });
    return json({ document: doc, markdown: criteriaToMarkdown(doc) }, request, env);
  },

  // ④ ロープレ1ターン：音声 → Whisper → Claude → にじボイス を直列で処理
  'POST /api/roleplay/turn': async (body, request, env) => {
    let transcript = typeof body.text === 'string' ? body.text.trim() : '';
    if (!transcript && body.__audio) {
      transcript = await transcribe(env, body.__audio, {
        prompt: body.vocabulary,
        filename: body.__filename,
      });
    }
    if (!transcript && !body.opening) throw new ApiError(400, '発話（音声またはテキスト）が必要です');

    const history = Array.isArray(body.history) ? body.history.slice(-40) : [];
    const messages = history.map((m) => ({
      role: m.role === 'trainee' ? 'user' : 'assistant',
      content: String(m.text || '').slice(0, 4000),
    }));

    if (body.opening && !transcript) {
      // 客側から口火を切らせる（来店直後の想定）
      messages.push({ role: 'user', content: '（お客様が来店しました。あなたから最初の一言をどうぞ）' });
    } else {
      messages.push({ role: 'user', content: transcript });
    }

    const replyText = await generateText(env, {
      model: MODELS.chat,
      system: roleplaySystemPrompt({
        customerType: body.customerType,
        scenario: body.scenario,
        criteria: body.criteria,
      }),
      messages,
      maxTokens: 300,
      temperature: 1,
    });

    const audioUrl = await synthesize(env, replyText, {
      voiceActorId: body.voiceActorId,
      speed: body.speed,
    });

    return json({ transcript, replyText, audioUrl }, request, env);
  },

  // ④ 採点
  'POST /api/roleplay/score': async (body, request, env) => {
    const criteria = requireString(body.criteria, 'criteria');
    const history = Array.isArray(body.history) ? body.history : [];
    if (history.length === 0) throw new ApiError(400, '会話履歴が必要です');
    const req = scoringRequest({ history, criteria });
    const out = await generateStructured(env, { ...req, model: MODELS.analysis, maxTokens: 4000 });
    return json(out, request, env);
  },

  // 単体TTS（読み上げのやり直し用）
  'POST /api/tts': async (body, request, env) => {
    const text = requireString(body.text, 'text', 3000);
    const audioUrl = await synthesize(env, text, { voiceActorId: body.voiceActorId, speed: body.speed });
    return json({ audioUrl }, request, env);
  },
};

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname.replace(/\/$/, '') || '/'}`;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const handler = routes[key];
    if (!handler) return json({ error: 'Not found', path: url.pathname }, request, env, 404);

    try {
      if (key !== 'GET /api/health') authenticate(request, env);
      const body = request.method === 'POST' ? await readBody(request) : {};
      return await handler(body, request, env);
    } catch (err) {
      if (err instanceof ApiError) {
        console.warn(`[${key}] ${err.status} ${err.message}`, err.detail || '');
        return json({ error: err.message, detail: err.detail }, request, env, err.status);
      }
      console.error(`[${key}] unhandled`, err?.stack || err);
      return json({ error: 'サーバー内部エラー' }, request, env, 500);
    }
  },
};
