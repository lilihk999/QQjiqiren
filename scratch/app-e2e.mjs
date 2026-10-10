// 端到端验收：假 NapCat ←→ Electron 主进程 ←→ 真实 NoneBot 侧车 ←→ 本地 AI 网关 ←→ 假上游模型。
// 不发任何外网请求，也不碰真实 QQ。用法：node scratch/app-e2e.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const PORT = 9333;
const SELF_ID = 10001;
const NAPCAT_TOKEN = 'napcat-e2e';
const SIDECAR_TOKEN = 'sidecar-e2e';
const UPSTREAM_KEY = 'sk-upstream-e2e';
const UPSTREAM_PORT = 3999;

let upstreamHits = 0;
let upstreamAuth = '';
let upstreamModel = '';
const upstream = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    upstreamHits += 1;
    upstreamAuth = String(req.headers.authorization ?? '');
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstreamModel = String(body.model);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'cmpl-e2e',
      object: 'chat.completion',
      model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: '网关链路正常' }, finish_reason: 'stop' }],
    }));
  });
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

const electron = spawn(
  process.execPath,
  [new URL('../node_modules/electron/cli.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '.', '--no-sandbox', `--remote-debugging-port=${String(PORT)}`],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
);

async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${String(PORT)}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
      if (page !== undefined) return page;
    } catch {
      // devtools 还没起
    }
    await sleep(500);
  }
  throw new Error('找不到渲染进程目标');
}

const page = await findTarget();
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((resolve, reject) => {
  ws.on('open', resolve);
  ws.on('error', reject);
});

let nextId = 1;
function cdp(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id !== id) return;
      ws.off('message', onMessage);
      if (msg.error !== undefined) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 异常');
  return r.result.value;
}
await cdp('Runtime.enable');

const sent = [];
async function status() {
  return JSON.parse(await evaluate('window.qqbot.getStatus().then(s => JSON.stringify(s))'));
}
async function until(fn, ms, label) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) {
      const logs = await evaluate('window.qqbot.recentLogs().then(l => JSON.stringify(l.slice(-8)))');
      const reason = typeof label === 'function' ? label() : label;
      throw new Error(`超时：${reason}\n当前状态 ${JSON.stringify(await status())}\n最近日志 ${logs}`);
    }
    await sleep(500);
  }
}

// 1) 写入 e2e 配置：假上游模型 + 侧车用仓库里已建好的 venv
const view = await evaluate('window.qqbot.getSettings().then(v => JSON.stringify(v))');
const draft = JSON.parse(view);
const edit = {
  ...draft,
  onebot: { ...draft.onebot, mode: 'reverse', listenHost: '127.0.0.1', listenPort: 3001, accessToken: NAPCAT_TOKEN },
  providers: [{
    id: 'e2e',
    label: '假上游',
    baseUrl: `http://127.0.0.1:${String(UPSTREAM_PORT)}/v1`,
    model: 'fake-model',
    temperature: 0.7,
    maxTokens: 128,
    contextWindow: 4096,
    supportsVision: false,
    pathStyle: 'openai',
    enabled: true,
    apiKey: UPSTREAM_KEY,
  }],
  defaultProviderId: 'e2e',
  sidecar: {
    ...draft.sidecar,
    pythonPath: '',
    venvPath: `${ROOT}/.toolchain/venv`.replace(/\//g, '\\'),
    port: 3100,
    gatewayPort: 3127,
    accessToken: SIDECAR_TOKEN,
    autostart: false,
  },
};
const saved = await evaluate(`window.qqbot.saveSettings(${JSON.stringify(edit)}).then(r => JSON.stringify(r))`);
const savedResult = JSON.parse(saved);
if (!savedResult.ok) throw new Error(`保存配置失败：${savedResult.error}`);
// 令牌改了要让协议端重新握手，顺带验证 connect/disconnect 这层
await evaluate('window.qqbot.disconnect().then(() => window.qqbot.connect()).then(r => JSON.stringify(r))');
await until(async () => (await status()).onebot === 'listening', 15_000, '主进程没监听 3001');

// 2) 假 NapCat 接入，回答 get_login_info
const napcat = new WebSocket('ws://127.0.0.1:3001/onebot/v11/ws', { headers: { authorization: `Bearer ${NAPCAT_TOKEN}` } });
napcat.on('message', (raw) => {
  const frame = JSON.parse(String(raw));
  console.log(`[napcat] ← ${String(raw).slice(0, 240)}`);
  if (typeof frame.action !== 'string') return;
  if (frame.action === 'get_login_info') {
    napcat.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: SELF_ID, nickname: 'e2e' }, echo: frame.echo }));
    return;
  }
  sent.push(frame);
  napcat.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: sent.length }, echo: frame.echo }));
});
await new Promise((resolve, reject) => {
  napcat.once('open', resolve);
  napcat.once('error', reject);
});
await until(async () => (await status()).selfId === SELF_ID, 15_000, '没识别出机器人 QQ 号');

// 3) 启动真实 NoneBot 侧车，等主进程的桥完成握手
await evaluate("window.qqbot.sidecarAction('start').then(s => JSON.stringify(s))");
await until(async () => {
  const s = await status();
  return s.sidecar.state === 'running' && s.sidecar.bridge === 'ready';
}, 90_000, '侧车或桥没就绪');

// 4) 群消息 → 插件 → 本地网关 → 假上游 → 回复回传
const sendEvent = (message) => {
  napcat.send(JSON.stringify({
    time: Math.floor(Date.now() / 1000),
    self_id: SELF_ID,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    group_id: 500,
    message_id: 90001 + sent.length,
    user_id: 200,
    message_seq: 1,
    font: 0,
    sender: { user_id: 200, nickname: '阿明', card: '小明', role: 'member' },
    message,
    raw_message: message.map((s) => String(s?.data?.text ?? '[at]')).join(''),
  }));
};
const textOf = (frame) => {
  const segments = frame.params?.message;
  return Array.isArray(segments) ? segments.map((s) => String(s?.data?.text ?? '')).join('') : '';
};
const seen = () => JSON.stringify(sent.map((f) => `${String(f.action)}:${textOf(f)}`));
const repliedWith = (action) => sent.some((f) => f.action === action && textOf(f).includes('网关链路正常'));
// 错误信息要在超时那一刻才求值，否则打印的是发事件之前的空列表
sendEvent([{ type: 'text', data: { text: '/问问 你好' } }]);
await until(async () => repliedWith('send_msg'), 60_000, () => `市场插件没走通网关链路，已收到 ${seen()}`);

// 5) 同一条消息交给主进程自带的 AI 管线（群内需 @ 才响应），验证内置回复
sendEvent([
  { type: 'at', data: { qq: String(SELF_ID) } },
  { type: 'text', data: { text: '随便聊聊' } },
]);
await until(async () => repliedWith('send_group_msg'), 60_000, () => `内置 AI 管线没回复，已收到 ${seen()}`);

const final = await status();
const report = {
  ok: true,
  selfId: final.selfId,
  onebot: final.onebot,
  sidecar: final.sidecar,
  gateway: final.gateway,
  upstream: { hits: upstreamHits, auth: upstreamAuth, model: upstreamModel },
  pluginActions: sent.map((f) => f.action),
  replies: sent.map((f) => `${f.action}:${textOf(f)}`),
};

napcat.close();
await evaluate("window.qqbot.sidecarAction('stop').then(s => JSON.stringify(s))");
await until(async () => (await status()).sidecar.state === 'stopped', 20_000, '侧车没停干净');
upstream.close();
ws.close();
electron.kill('SIGTERM');
await sleep(500);
electron.kill('SIGKILL');
console.log(JSON.stringify(report, null, 2));
process.exit(0);
