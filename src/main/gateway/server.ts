import http from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { ChatMessage, ModelProvider } from '../../shared/types.ts';
import { buildHeaders, resolveEndpoint } from './upstream.ts';

export interface GatewayUsage {
  calls: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  totalMs: number;
}

export interface GatewayDeps {
  token: string;
  /** 按 provider.id 解析；调用方在 model 字段里传 provider id */
  resolveProvider: (requestedModel: string) => ModelProvider | null;
  listProviders: () => ModelProvider[];
  onUsage: (usage: { ok: boolean; ms: number; caller: string }) => void;
}

const MAX_BODY = 4 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  const expected = token.trim();
  if (expected.length === 0) return true;
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  return header.replace(/^Bearer\s+/i, '').trim() === expected;
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

/**
 * 本地 OpenAI 兼容网关。
 *
 * 存在意义：模型密钥只驻留在 Electron 主进程，Python sidecar 与各 nsb 插件
 * 只需指向 http://127.0.0.1:<port>/v1 并使用一次性本地令牌，
 * 因此插件永远接触不到真实供应商密钥，换模型也不用改插件代码。
 */
export class AiGateway {
  private server: http.Server | null = null;
  usage: GatewayUsage = { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, totalMs: 0 };

  constructor(private readonly deps: GatewayDeps) {}

  async listen(port: number): Promise<void> {
    if (this.server !== null) return;
    const server = http.createServer((req, res) => {
      void this.route(req, res).catch((err: unknown) => {
        this.usage.failures += 1;
        json(res, 500, { error: { message: String(err), type: 'gateway_error' } });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }

  boundPort(): number {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr !== null ? addr.port : 0;
  }

  baseUrl(): string {
    return `http://127.0.0.1:${String(this.boundPort())}`;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      if (!authorized(req, this.deps.token)) return json(res, 401, { error: { message: '令牌无效' } });
      const now = Math.floor(Date.now() / 1000);
      return json(res, 200, {
        object: 'list',
        data: this.deps.listProviders().map((p) => ({ id: p.id, object: 'model', created: now, owned_by: p.label })),
      });
    }

    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
      return json(res, 404, { error: { message: '未知路径' } });
    }
    if (!authorized(req, this.deps.token)) {
      return json(res, 401, { error: { message: '令牌无效' } });
    }

    const body = JSON.parse(await readBody(req)) as {
      model?: string;
      messages?: ChatMessage[];
      stream?: boolean;
      temperature?: number;
      max_tokens?: number;
    };
    const provider = this.deps.resolveProvider(body.model ?? 'default');
    if (provider === null) {
      return json(res, 404, { error: { message: `未找到模型配置：${body.model ?? 'default'}` } });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return json(res, 400, { error: { message: 'messages 不能为空' } });
    }

    const started = Date.now();
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const upstreamRes = await fetch(resolveEndpoint(provider), {
      method: 'POST',
      headers: buildHeaders(provider),
      body: JSON.stringify({
        model: provider.model,
        messages: body.messages,
        temperature: body.temperature ?? provider.temperature,
        max_tokens: body.max_tokens ?? provider.maxTokens,
        stream: body.stream === true,
      }),
      signal: controller.signal,
    });

    if (!upstreamRes.ok || upstreamRes.body === null) {
      this.usage.failures += 1;
      this.deps.onUsage({ ok: false, ms: Date.now() - started, caller: 'openai-compat' });
      const text = await upstreamRes.text().catch(() => '');
      return json(res, 502, {
        error: { message: `上游 ${provider.label} 返回 ${String(upstreamRes.status)}`, detail: text.slice(0, 500) },
      });
    }

    if (body.stream !== true) {
      const payload = (await upstreamRes.json()) as Record<string, unknown>;
      this.usage.calls += 1;
      this.deps.onUsage({ ok: true, ms: Date.now() - started, caller: 'openai-compat' });
      return json(res, 200, payload);
    }

    // 流式按原始字节透传：不重新编码就不会破坏上游的 SSE 分帧，
    // 也避免为了拿文本而二次请求上游（那会让第一个响应体泄漏）。
    res.writeHead(200, {
      'content-type': upstreamRes.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    try {
      const incoming = upstreamRes.body as unknown as WebReadableStream<Uint8Array>;
      for await (const chunk of Readable.fromWeb(incoming)) {
        res.write(chunk as Buffer);
      }
      this.usage.calls += 1;
      this.deps.onUsage({ ok: true, ms: Date.now() - started, caller: 'openai-compat' });
    } catch (err) {
      this.usage.failures += 1;
      this.deps.onUsage({ ok: false, ms: Date.now() - started, caller: 'openai-compat' });
      res.write(`data: ${JSON.stringify({ error: { message: String(err) } })}\n\n`);
    }
    res.end();
  }
}
