// Claude API (Anthropic Messages API) wrapper.
// APIキーはWorker側のsecretにのみ存在し、フロントには出さない。

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

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

async function callClaude(env, body) {
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
  return res.json();
}

/** プレーンテキストを1回生成する */
export async function generateText(env, { model, system, messages, maxTokens = 2000, temperature }) {
  const data = await callClaude(env, {
    model: model || MODELS.chat,
    max_tokens: maxTokens,
    ...(temperature === undefined ? {} : { temperature }),
    ...(system ? { system } : {}),
    messages,
  });
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
export async function generateStructured(env, { model, system, messages, schema, toolName, toolDescription, maxTokens = 4000 }) {
  const data = await callClaude(env, {
    model: model || MODELS.analysis,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages,
    tools: [
      {
        name: toolName,
        description: toolDescription,
        input_schema: schema,
      },
    ],
    tool_choice: { type: 'tool', name: toolName },
  });

  const block = (data.content || []).find((b) => b.type === 'tool_use' && b.name === toolName);
  if (!block) throw new ApiError(502, 'Claudeが構造化出力を返しませんでした');
  return block.input;
}
