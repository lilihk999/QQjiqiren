import type { ChatMessage, ModelProvider } from '../../shared/types.ts';

export interface UpstreamRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  stream: boolean;
}

/**
 * 各家端点的路径约定不统一：OpenAI/DeepSeek 走 /v1，Ollama 走 /v1，
 * 而部分 vLLM 与自建网关直接挂在根路径。pathStyle 让用户能显式纠正。
 */
export function resolveEndpoint(p: ModelProvider): string {
  const base = p.baseUrl.trim().replace(/\/+$/, '');
  if (p.pathStyle === 'bare') return `${base}/chat/completions`;
  if (/\/v1$/.test(base) || /\/v1\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function buildHeaders(p: ModelProvider): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = p.apiKey.trim();
  if (key.length > 0) headers['authorization'] = `Bearer ${key}`;
  return headers;
}

export interface ChatResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string;
}

function extractDelta(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const payload = trimmed.slice(5).trim();
  if (payload.length === 0 || payload === '[DONE]') return null;
  try {
    const json = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
    };
    const choice = json.choices?.[0];
    return choice?.delta?.content ?? choice?.message?.content ?? null;
  } catch {
    return null;
  }
}

/**
 * 流式转发。按 SSE 事件边界（空行）切分而不是按行，
 * 因为一个 JSON 分片可能被 TCP 拆到多个包里，逐行 parse 会丢内容。
 */
export async function* streamText(
  p: ModelProvider,
  req: UpstreamRequest,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const res = await fetch(resolveEndpoint(p), {
    method: 'POST',
    headers: buildHeaders(p),
    body: JSON.stringify({ ...req, stream: true }),
    signal,
  });
  if (!res.ok || res.body === null) {
    throw new Error(`上游 ${p.label} 返回 ${String(res.status)}：${await readErrorBody(res)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf8');
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of event.split('\n')) {
        const delta = extractDelta(line);
        if (delta !== null) yield delta;
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  for (const line of buffer.split('\n')) {
    const delta = extractDelta(line);
    if (delta !== null) yield delta;
  }
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return '(无响应体)';
  }
}

export async function chatOnce(p: ModelProvider, req: UpstreamRequest, signal: AbortSignal): Promise<ChatResult> {
  const res = await fetch(resolveEndpoint(p), {
    method: 'POST',
    headers: buildHeaders(p),
    body: JSON.stringify({ ...req, stream: false }),
    signal,
  });
  if (!res.ok) throw new Error(`上游 ${p.label} 返回 ${String(res.status)}：${await readErrorBody(res)}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = json.choices?.[0];
  return {
    text: choice?.message?.content ?? '',
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
    finishReason: choice?.finish_reason ?? 'unknown',
  };
}

export async function chatOnceByStreaming(
  p: ModelProvider,
  req: UpstreamRequest,
  signal: AbortSignal,
): Promise<ChatResult> {
  let text = '';
  for await (const delta of streamText(p, req, signal)) text += delta;
  return { text, promptTokens: 0, completionTokens: estimate(text), finishReason: 'stream' };
}

function estimate(text: string): number {
  return Math.ceil(Array.from(text).length / 2);
}
