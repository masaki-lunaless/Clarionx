// Claude API (Anthropic Messages API) wrapper.
// APIキーはWorker側のsecretにのみ存在し、フロントには出さない。

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// 処理ごとの思考の深さ。上げると精度が上がり、費用と時間も増える。
// 未指定だと既定のhighで動くため、軽い処理まで深く考えてしまう。
export const EFFORT = {
  chat: 'low',      // 客のセリフを1つ返すだけ。速さが体験に直結する
  followUp: 'low',  // 追加質問を1〜2問
  scoring: 'medium',
  analysis: 'high', // 転換点の抽出と判断基準の統合。ここは質を優先する
};

export const MODELS = {
  // 分析系（転換点抽出・判断基準統合・採点）は精度優先
  analysis: 'claude-opus-5',
  // ロープレの1ターン生成はレイテンシ優先
  chat: 'claude-sonnet-5',
};

export class ApiError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** 使ったトークンを記録する。wrangler tail で費用を追えるようにするため。 */
function logUsage(label, model, usage) {
  if (!usage) return;
  const cached = usage.cache_read_input_tokens || 0;
  const written = usage.cache_creation_input_tokens || 0;
  console.log(
    `usage ${label} ${model} in=${usage.input_tokens} out=${usage.output_tokens}` +
      (cached || written ? ` cache_read=${cached} cache_write=${written}` : ''),
  );
}

async function callClaude(env, body, label = '') {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new ApiError(500, 'ANTHROPIC_API_KEY が未設定です');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new ApiError(res.status === 429 ? 429 : 502, 'Claude APIエラー', detail.slice(0, 800));
  }
  const data = await res.json();
  logUsage(label, body.model, data.usage);
  return data;
}

/**
 * systemをキャッシュ可能な形にする。
 * ロープレでは判断基準の全文がsystemに入り、同じモードなら毎回まったく同じになる。
 * キャッシュに載せると読み出しは入力の約0.1倍で済む。
 */
const systemParam = (system, cache) =>
  cache ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;

/** プレーンテキストを1回生成する */
export async function generateText(env, { model, system, messages, maxTokens = 2000, temperature, effort, cacheSystem, label }) {
  const data = await callClaude(env, {
    model: model || MODELS.chat,
    max_tokens: maxTokens,
    ...(temperature === undefined ? {} : { temperature }),
    ...(system ? { system: systemParam(system, cacheSystem) } : {}),
    ...(effort ? { output_config: { effort } } : {}),
    messages,
  }, label);
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * tool useを強制して構造化JSONを受け取る。
 * 「JSONで返して」とお願いするより崩れにくい。
 */
export async function generateStructured(env, { model, system, messages, schema, toolName, toolDescription, maxTokens = 4000, effort, cacheSystem, label }) {
  const data = await callClaude(env, {
    model: model || MODELS.analysis,
    max_tokens: maxTokens,
    ...(system ? { system: systemParam(system, cacheSystem) } : {}),
    ...(effort ? { output_config: { effort } } : {}),
    messages,
    tools: [
      {
        name: toolName,
        description: toolDescription,
        input_schema: schema,
      },
    ],
    tool_choice: { type: 'tool', name: toolName },
  }, label);

  const block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === toolName);
  if (!block) throw new ApiError(502, 'Claudeが構造化出力を返しませんでした');
  return block.input;
}
