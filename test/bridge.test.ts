import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { SidecarBridge } from '../src/main/sidecar/bridge.ts';
import type { OneBotEvent } from '../src/main/onebot/types.ts';

const SELF_ID = '10001';
const TOKEN = 'bridge-token';

async function waitFor(pred: () => boolean, label: string, ms = 6_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`等待${label}超时`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function bearer(header: string | string[] | undefined): string | undefined {
  const text = Array.isArray(header) ? header[0] : header;
  return typeof text === 'string' && text.startsWith('Bearer ') ? text.slice('Bearer '.length) : undefined;
}

interface Sidecar {
  url: string;
  port: number;
  headers: Record<string, string | string[] | undefined>;
  /** 桥发过来的一切：事件带 post_type，动作应答带 echo */
  frames: Array<Record<string, unknown>>;
  closes: number[];
  send: (payload: unknown) => void;
  dropClient: () => void;
  close: () => Promise<void>;
}

/** 假侧车：照搬 nonebot onebot.v11 反向 WS 服务端的握手校验与帧格式 */
async function startSidecar(expectedToken: string, wantedPort = 0): Promise<Sidecar> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: wantedPort });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const sidecar: Sidecar = {
    url: `ws://127.0.0.1:${String(port)}/onebot/v11/ws`,
    port,
    headers: {},
    frames: [],
    closes: [],
    send: () => undefined,
    dropClient: () => {
      for (const c of server.clients) c.close();
    },
    close: async () => {
      for (const c of server.clients) c.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  server.on('connection', (socket, req) => {
    sidecar.headers = req.headers;
    socket.on('message', (raw) => {
      sidecar.frames.push(JSON.parse(String(raw)) as Record<string, unknown>);
    });
    socket.on('close', (code) => sidecar.closes.push(code));
    sidecar.send = (payload: unknown): void => {
      // 字符串原样发出，才能测到「非 JSON 帧」这条分支
      socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    };
    // 与 nonebot 一致：access_token 未配置时不做校验
    if (expectedToken.length > 0 && bearer(req.headers.authorization) !== expectedToken) {
      socket.close(1008, 'Authorization Header is invalid');
      return;
    }
    if (req.headers['x-self-id'] === undefined) socket.close(1008, 'Missing X-Self-ID Header');
  });
  return sidecar;
}

/** 注册清理：中途抛错的测试若漏掉 close，残留的监听与重试定时器会挂住测试进程 */
async function useSidecar(t: TestContext, expectedToken = TOKEN, port = 0): Promise<Sidecar> {
  const sidecar = await startSidecar(expectedToken, port);
  t.after(() => sidecar.close());
  return sidecar;
}

interface Harness {
  bridge: SidecarBridge;
  statuses: string[];
  logs: Array<{ level: string; text: string }>;
  calls: Array<{ action: string; params: Record<string, unknown> }>;
}

function makeBridge(sidecarUrl: () => string, selfId: () => string | null, opts: { fail?: boolean; token?: string } = {}): Harness {
  const statuses: string[] = [];
  const logs: Array<{ level: string; text: string }> = [];
  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
  const bridge = new SidecarBridge({
    url: sidecarUrl,
    selfId,
    accessToken: () => opts.token ?? TOKEN,
    call: async (action, params) => {
      calls.push({ action, params });
      if (opts.fail === true) throw new Error('协议端返回 retcode=200：群号不存在');
      if (action === 'get_group_info') return { group_name: '研发大群', group_id: params['group_id'] };
      return { message_id: 42 };
    },
    log: (level, text) => logs.push({ level, text }),
  });
  bridge.on('status', (s) => statuses.push(s));
  return { bridge, statuses, logs, calls };
}

function useBridge(t: TestContext, sidecar: Sidecar, opts: { fail?: boolean; token?: string; selfId?: () => string | null } = {}): Harness {
  const h = makeBridge(() => sidecar.url, opts.selfId ?? (() => SELF_ID), opts);
  t.after(() => h.bridge.stop());
  return h;
}

const groupEvent = {
  time: 1_700_000_000,
  self_id: 10_001,
  post_type: 'message',
  message_type: 'group',
  group_id: 500,
  user_id: 200,
  message_id: 1,
  message: [{ type: 'text', data: { text: '你好' } }],
} as unknown as OneBotEvent;

test('握手带上 X-Self-ID 与 Bearer，事件原样转发给侧车', async (t) => {
  const sidecar = await useSidecar(t);
  const h = useBridge(t, sidecar);
  h.bridge.start();
  await waitFor(() => h.bridge.status === 'ready', '侧车接入');

  assert.equal(sidecar.headers['x-self-id'], SELF_ID, '缺失 X-Self-ID 会被 NoneBot 直接关闭');
  assert.equal(bearer(sidecar.headers.authorization), TOKEN);

  h.bridge.publish(groupEvent);
  await waitFor(() => sidecar.frames.length === 1, '事件转发');
  assert.deepEqual(sidecar.frames[0], groupEvent);
  assert.ok(h.statuses.includes('connecting'), 'GUI 需要区分“正在连”和“重连中”');
  assert.equal(h.statuses.at(-1), 'ready');
});

test('侧车动作请求转交协议端，并按 echo 回 ok', async (t) => {
  const sidecar = await useSidecar(t);
  const h = useBridge(t, sidecar);
  h.bridge.start();
  await waitFor(() => h.bridge.status === 'ready', '侧车接入');

  sidecar.send({ action: 'get_group_info', params: { group_id: 500 }, echo: '7' });
  await waitFor(() => sidecar.frames.length === 1, '动作应答');
  assert.deepEqual(h.calls, [{ action: 'get_group_info', params: { group_id: 500 } }]);
  assert.deepEqual(sidecar.frames[0], {
    status: 'ok',
    retcode: 0,
    data: { group_name: '研发大群', group_id: 500 },
    echo: '7',
  });
});

test('协议端报错时原样回 failed，绝不让侧车挂到超时', async (t) => {
  const sidecar = await useSidecar(t);
  const h = useBridge(t, sidecar, { fail: true });
  h.bridge.start();
  await waitFor(() => h.bridge.status === 'ready', '侧车接入');

  sidecar.send({ action: 'set_group_ban', params: { group_id: 500 }, echo: '9' });
  await waitFor(() => sidecar.frames.length === 1, '失败应答');
  const reply = sidecar.frames[0];
  assert.equal(reply?.['status'], 'failed');
  assert.equal(reply?.['echo'], '9');
  assert.match(String(reply?.['message']), /群号不存在/);
});

test('未知 QQ 号时暂缓握手，拿到号后 retrySoon 立刻接入', async (t) => {
  const sidecar = await useSidecar(t);
  let selfId: string | null = null;
  const h = useBridge(t, sidecar, { selfId: () => selfId });
  h.bridge.start();
  await waitFor(() => h.bridge.status === 'retrying', '进入等待');
  assert.ok(h.logs.some((l) => l.text.includes('还不知道机器人 QQ 号')));

  selfId = SELF_ID;
  h.bridge.retrySoon();
  await waitFor(() => h.bridge.status === 'ready', '补上 QQ 号后接入');
  assert.equal(sidecar.headers['x-self-id'], SELF_ID);
});

test('令牌不匹配时给出可操作的错误，而不是无声重试', async (t) => {
  const sidecar = await useSidecar(t, 'a-token-owned-by-sidecar');
  const h = useBridge(t, sidecar, { token: 'a-wrong-ascii-token' });
  h.bridge.start();
  await waitFor(() => h.logs.some((l) => l.level === 'error'), '拒绝日志');
  assert.ok(h.logs.some((l) => l.text.includes('access_token')));
  assert.equal(h.bridge.status, 'retrying');
});

test('含空格或中文的令牌不会打崩主进程', async (t) => {
  const sidecar = await useSidecar(t);
  const h = useBridge(t, sidecar, { token: '中文 令牌' });
  h.bridge.start();
  await waitFor(() => h.logs.some((l) => l.level === 'error'), '配置错误日志');
  assert.ok(h.logs.some((l) => l.text.includes('ASCII')));
  assert.equal(h.bridge.status, 'retrying');
});

test('未配置令牌时不带 Authorization，交给侧车自己判断', async (t) => {
  const sidecar = await useSidecar(t, '');
  const h = useBridge(t, sidecar, { token: '' });
  h.bridge.start();
  await waitFor(() => h.bridge.status === 'ready', '侧车接入');
  assert.equal(sidecar.headers.authorization, undefined);
});

test('侧车还没起来时退避重试，起来后自动接上', async (t) => {
  const first = await useSidecar(t);
  const port = first.port;
  await first.close();

  const h = makeBridge(() => `ws://127.0.0.1:${String(port)}/onebot/v11/ws`, () => SELF_ID);
  t.after(() => h.bridge.stop());
  h.bridge.start();
  await waitFor(() => h.bridge.status === 'retrying', '退避重试');

  const revived = await startSidecar(TOKEN, port);
  t.after(() => revived.close());
  await waitFor(() => h.bridge.status === 'ready', '侧车启动后自动接入');
  h.bridge.publish(groupEvent);
  await waitFor(() => revived.frames.length === 1, '补连后事件可达');
});

test('侧车重启后自动接回，断连期间的事件丢弃而不崩', async (t) => {
  const sidecar = await useSidecar(t);
  const h = useBridge(t, sidecar);
  h.bridge.start();
  await waitFor(() => h.bridge.status === 'ready', '侧车接入');

  sidecar.dropClient();
  await waitFor(() => h.bridge.status === 'retrying', '断连后进入重连');
  h.bridge.publish(groupEvent);

  await waitFor(() => h.bridge.status === 'ready', '自动重连');
  const before = sidecar.frames.length;
  h.bridge.publish(groupEvent);
  await waitFor(() => sidecar.frames.length === before + 1, '重连后事件可达');
});

test('stop 之后不再重连，publish 静默丢弃', async (t) => {
  const sidecar = await useSidecar(t);
  const h = makeBridge(() => sidecar.url, () => SELF_ID);
  h.bridge.start();
  await waitFor(() => h.bridge.status === 'ready', '侧车接入');

  await h.bridge.stop();
  assert.equal(h.bridge.status, 'stopped');
  h.bridge.publish(groupEvent);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sidecar.frames.length, 0);
  assert.equal(sidecar.closes.at(-1), 1000, '正常关闭而非崩溃');

  sidecar.dropClient();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.bridge.status, 'stopped', '已停止的桥不应再拉起连接');
});

test('非 JSON、无 echo、以及事件样式的帧都不触发动作', async (t) => {
  const sidecar = await useSidecar(t);
  const h = useBridge(t, sidecar);
  h.bridge.start();
  await waitFor(() => h.bridge.status === 'ready', '侧车接入');

  sidecar.send('这不是 json');
  sidecar.send({ action: 'get_group_info', params: {} });
  sidecar.send({ post_type: 'message', message_type: 'private', message_id: 2 });
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(h.logs.some((l) => l.text.includes('非 JSON')));
  assert.equal(h.calls.length, 0);
  assert.equal(sidecar.frames.length, 0);
});
