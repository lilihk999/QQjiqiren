import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AiGateway } from '../src/main/gateway/server.ts';
import { buildHeaders, chatOnce, resolveEndpoint, streamText } from '../src/main/gateway/upstream.ts';
import { DEFAULT_SETTINGS } from '../src/shared/defaults.ts';
import type { ModelProvider } from '../src/shared/types.ts';

const REPLY_TEXT = '收到，我在的。';

/** 假上游：一个最小可用的 OpenAI 兼容服务，用来验证网关的透传与鉴权，不需要真实密钥 */
function startFakeUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const auth = req.headers['authorization'] ?? '';
      if (auth !== 'Bearer upstream-key') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '上游鉴权失败' } }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string; stream?: boolean };

      if (body.model === 'boom') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '上游过载' } }));
        return;
      }

      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const pieces = Array.from(REPLY_TEXT);
        for (let i = 0; i < pieces.length; i += 2) {
          const payload = JSON.stringify({ choices: [{ delta: { content: pieces.slice(i, i + 2).join('') }, index: 0 }] });
          // 在一行中间断开，且不补换行：这才是真实 TCP 分包的样子
          res.write(`data: ${payload.slice(0, 20)}`);
          res.write(`${payload.slice(20)}\n\n`);
        }
        res.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'up-1',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: REPLY_TEXT }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${String(port)}/v1`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function providerOf(baseUrl: string, model: string, id = 'default'): ModelProvider {
  return { ...(DEFAULT_SETTINGS.providers[0] as ModelProvider), id, baseUrl, model, apiKey: 'upstream-key', pathStyle: 'openai' };
}

async function withGateway(
  fn: (base: string) => Promise<void>,
  upstreamUrl: string,
): Promise<void> {
  const providers: Record<string, ModelProvider> = {
    default: providerOf(upstreamUrl, 'mock-model', 'default'),
    boom: providerOf(upstreamUrl, 'boom', 'boom'),
  };
  const gateway = new AiGateway({
    token: 'gw-token',
    resolveProvider: (id) => providers[id] ?? null,
    listProviders: () => Object.values(providers),
    onUsage: () => undefined,
  });
  await gateway.listen(0);
  try {
    await fn(`http://127.0.0.1:${String(gateway.boundPort())}`);
  } finally {
    gateway.close();
  }
}

const authHeaders = { authorization: 'Bearer gw-token', 'content-type': 'application/json' };

test('端点拼接遵守 /v1 约定，bare 模式可不带前缀', () => {
  assert.equal(resolveEndpoint(providerOf('https://api.deepseek.com/v1', 'm')), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(resolveEndpoint(providerOf('https://api.deepseek.com/', 'm')), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(resolveEndpoint(providerOf('http://127.0.0.1:8000', 'm')), 'http://127.0.0.1:8000/v1/chat/completions');
  assert.equal(resolveEndpoint({ ...providerOf('http://127.0.0.1:8000', 'm'), pathStyle: 'bare' }), 'http://127.0.0.1:8000/chat/completions');
  assert.deepEqual(buildHeaders(providerOf('http://x/v1', 'm'))['authorization'], 'Bearer upstream-key');
  assert.equal(buildHeaders({ ...providerOf('http://x/v1', 'm'), apiKey: '' })['authorization'], undefined);
});

test('非流式补全透传上游响应', async () => {
  const up = await startFakeUpstream();
  try {
    await withGateway(async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ model: 'default', messages: [{ role: 'user', content: '在吗' }] }),
      });
      assert.equal(res.status, 200);
      const json = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number } };
      assert.equal(json.choices[0]?.message.content, REPLY_TEXT);
      assert.equal(json.usage.prompt_tokens, 11);
    }, up.url);
  } finally {
    await up.close();
  }
});

test('流式响应逐块透传，分包不丢内容', async () => {
  const up = await startFakeUpstream();
  try {
    await withGateway(async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ model: 'default', stream: true, messages: [{ role: 'user', content: '在吗' }] }),
      });
      assert.equal(res.headers.get('content-type')?.includes('text/event-stream'), true);
      const text = await res.text();
      const pieces: string[] = [];
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        const j = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
        pieces.push(j.choices?.[0]?.delta?.content ?? '');
      }
      assert.equal(pieces.join(''), REPLY_TEXT);
      assert.ok(text.includes('[DONE]'));
    }, up.url);
  } finally {
    await up.close();
  }
});

test('缺令牌 401、未知模型 404、空 messages 400', async () => {
  const up = await startFakeUpstream();
  try {
    await withGateway(async (base) => {
      const noAuth = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'default', messages: [{ role: 'user', content: 'x' }] }),
      });
      assert.equal(noAuth.status, 401);

      const unknown = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'x' }] }),
      });
      assert.equal(unknown.status, 404);

      const empty = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ model: 'default', messages: [] }),
      });
      assert.equal(empty.status, 400);

      const badPath = await fetch(`${base}/v1/completions`, { headers: authHeaders });
      assert.equal(badPath.status, 404);
    }, up.url);
  } finally {
    await up.close();
  }
});

test('上游报错转成 502 并保留细节，方便 GUI 里定位配置问题', async () => {
  const up = await startFakeUpstream();
  try {
    await withGateway(async (base) => {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ model: 'boom', messages: [{ role: 'user', content: 'x' }] }),
      });
      assert.equal(res.status, 502);
      const json = (await res.json()) as { error: { message: string; detail: string } };
      assert.match(json.error.message, /返回 500/);
      assert.match(json.error.detail, /上游过载/);
    }, up.url);
  } finally {
    await up.close();
  }
});

test('/v1/models 让插件可以枚举已配置模型', async () => {
  const up = await startFakeUpstream();
  try {
    await withGateway(async (base) => {
      const res = await fetch(`${base}/v1/models`, { headers: authHeaders });
      assert.equal(res.status, 200);
      const json = (await res.json()) as { data: Array<{ id: string; owned_by: string }> };
      assert.deepEqual(json.data.map((d) => d.id).sort(), ['boom', 'default']);
    }, up.url);
  } finally {
    await up.close();
  }
});

/**
 * streamText 供内部回复链路使用（拿到增量文本才能做流式分段发送）。
 * 假上游故意把一条 SSE 事件拆成两次 write，这里验证跨 TCP 包的分帧重组。
 */
test('streamText 跨包重组 SSE 增量', async () => {
  const up = await startFakeUpstream();
  try {
    const provider = providerOf(up.url, 'mock-model');
    let text = '';
    for await (const delta of streamText(provider, { model: provider.model, messages: [{ role: 'user', content: '在吗' }], temperature: 0.7, max_tokens: 100, stream: true }, new AbortController().signal)) {
      assert.ok(delta.length > 0, '不应产出空增量');
      text += delta;
    }
    assert.equal(text, REPLY_TEXT);
  } finally {
    await up.close();
  }
});

test('chatOnce 读取 usage 与 finish_reason，供配额统计', async () => {
  const up = await startFakeUpstream();
  try {
    const provider = providerOf(up.url, 'mock-model');
    const r = await chatOnce(provider, { model: provider.model, messages: [{ role: 'user', content: 'x' }], temperature: 0.7, max_tokens: 100, stream: false }, new AbortController().signal);
    assert.equal(r.text, REPLY_TEXT);
    assert.equal(r.promptTokens, 11);
    assert.equal(r.finishReason, 'stop');
    await assert.rejects(
      chatOnce(providerOf(up.url, 'boom'), { model: 'boom', messages: [{ role: 'user', content: 'x' }], temperature: 0.7, max_tokens: 100, stream: false }, new AbortController().signal),
      /返回 500/,
    );
  } finally {
    await up.close();
  }
});
