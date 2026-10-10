import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { OneBotBridge } from '../src/main/onebot/client.ts';
import { DEFAULT_SETTINGS } from '../src/shared/defaults.ts';
import type { OneBotSettings, OnebotStatus } from '../src/shared/types.ts';

/** listenPort=0 让内核分配空闲端口，测试之间不会因固定端口冲突而级联失败 */
function settings(overrides: Partial<OneBotSettings> = {}): OneBotSettings {
  return {
    ...DEFAULT_SETTINGS.onebot,
    mode: 'reverse',
    listenHost: '127.0.0.1',
    listenPort: 0,
    accessToken: 'unit-secret',
    actionTimeoutMs: 1_500,
    ...overrides,
  };
}

function handshake(port: number, token: string | null): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${String(port)}/`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    });
    const timer = setTimeout(() => {
      sock.removeAllListeners();
      sock.close();
      reject(new Error('握手超时'));
    }, 3_000);
    sock.on('open', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function nextEvent(bridge: OneBotBridge): Promise<Record<string, unknown>> {
  return new Promise((resolve) => bridge.once('event', (e) => resolve(e as unknown as Record<string, unknown>)));
}

/**
 * 状态是序列（listening → connected），不能用 once + 条件过滤：
 * 第一次发射就会被 once 摘掉监听，之后再也等不到目标状态。
 */
function waitForStatus(bridge: OneBotBridge, wanted: OnebotStatus): Promise<OnebotStatus> {
  return new Promise((resolve) => {
    const onStatus = (s: OnebotStatus): void => {
      if (s !== wanted) return;
      bridge.off('status', onStatus);
      resolve(s);
    };
    bridge.on('status', onStatus);
  });
}

async function withBridge<T>(opts: Partial<OneBotSettings>, fn: (b: OneBotBridge, port: number) => Promise<T>): Promise<T> {
  const bridge = new OneBotBridge(settings(opts));
  await bridge.start();
  try {
    return await fn(bridge, bridge.boundPort());
  } finally {
    bridge.stop();
  }
}

test('reverse 模式：带正确令牌的协议端可以接入并推送事件', async () => {
  await withBridge({}, async (bridge, port) => {
    const statuses: OnebotStatus[] = [];
    bridge.on('status', (s) => statuses.push(s));
    assert.ok(port > 0);
    assert.deepEqual(statuses, []);

    const connected = waitForStatus(bridge, 'connected');
    const sock = await handshake(port, 'unit-secret');
    const pending = nextEvent(bridge);
    sock.send(JSON.stringify({ time: 1, self_id: 1, post_type: 'meta_event', meta_event_type: 'lifecycle', meta_event_sub_type: 'connect' }));

    const evt = await pending;
    assert.equal(evt['post_type'], 'meta_event');
    assert.equal(evt['meta_event_sub_type'], 'connect');
    assert.equal(await connected, 'connected');
    sock.close();
  });
});

test('令牌不匹配时拒绝握手', async () => {
  await withBridge({}, async (_bridge, port) => {
    await assert.rejects(handshake(port, 'wrong-token'), /401|Unauthorized|invalid status|socket hang up/i);
  });
});

test('access_token 未配置时放行（本机默认部署）', async () => {
  await withBridge({ accessToken: '' }, async (_bridge, port) => {
    const sock = await handshake(port, null);
    sock.close();
  });
});

test('动作调用通过 echo 关联，成功与失败都回传到调用方', async () => {
  await withBridge({}, async (bridge, port) => {
    const sock = await handshake(port, 'unit-secret');
    const received: Array<{ action: string; params: Record<string, unknown> }> = [];
    sock.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { action?: string; params?: Record<string, unknown>; echo?: string };
      if (msg.action === undefined || msg.echo === undefined) return;
      received.push({ action: msg.action, params: msg.params ?? {} });
      if (msg.action === 'send_group_msg') {
        sock.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 4321 }, echo: msg.echo }));
      } else if (msg.action === 'set_group_ban') {
        sock.send(JSON.stringify({ status: 'failed', retcode: 3001, message: 'bot 不是管理员', echo: msg.echo }));
      }
    });

    const ok = await bridge.call<{ message_id: number }>('send_group_msg', { group_id: 5, message: '你好' });
    assert.equal(ok.message_id, 4321);
    assert.deepEqual(received[0], { action: 'send_group_msg', params: { group_id: 5, message: '你好' } });

    await assert.rejects(bridge.call('set_group_ban', { group_id: 5, user_id: 1 }), /不是管理员/);
    sock.close();
  });
});

test('协议端不应答 echo 时按超时失败，不悬挂 Promise', async () => {
  await withBridge({ actionTimeoutMs: 300 }, async (bridge, port) => {
    const sock = await handshake(port, 'unit-secret');
    sock.on('message', () => undefined);
    await assert.rejects(bridge.call('get_group_member_info', { group_id: 1, user_id: 2 }), /超时/);
    sock.close();
  });
});

test('HTTP 上报模式（NapCat HTTP 服务器）也能收到事件', async () => {
  await withBridge({}, async (bridge, port) => {
    const pending = nextEvent(bridge);
    const res = await fetch(`http://127.0.0.1:${String(port)}/`, {
      method: 'POST',
      headers: { authorization: 'Bearer unit-secret', 'content-type': 'application/json' },
      body: JSON.stringify({
        time: 2,
        self_id: 1,
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        user_id: 9,
        message_id: 1,
        message_seq: 1,
        sender: { user_id: 9, nickname: '乙' },
        message: [{ type: 'text', data: { text: '私聊来的' } }],
        raw_message: '私聊来的',
        font: 0,
      }),
    });
    assert.equal(res.status, 200);
    assert.equal((await pending)['message_type'], 'private');
  });
});

test('HTTP 上报缺令牌被拒，且不会污染事件流', async () => {
  await withBridge({}, async (bridge, port) => {
    let fired = false;
    bridge.once('event', () => {
      fired = true;
    });
    const res = await fetch(`http://127.0.0.1:${String(port)}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ post_type: 'message' }),
    });
    assert.equal(res.status, 401);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(fired, false);
  });
});

test('未连接时调用动作直接失败', async () => {
  const bridge = new OneBotBridge(settings());
  await assert.rejects(bridge.call('get_login_info', {}), /未连接/);
});
