// 手工 GUI 校验：用 CDP 驱动真实 Electron 窗口，检查桥接是否可用并截图。
// 用法：node scratch/gui-check.mjs
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PORT = 9333;
const electron = new URL('../node_modules/electron/cli.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

const child = spawn(process.execPath, [electron, '.', '--no-sandbox', `--remote-debugging-port=${String(PORT)}`], {
  cwd: new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(PORT)}/json`);
      const targets = (await res.json());
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
function send(method, params = {}) {
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
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate 异常');
  return r.result.value;
}

await send('Runtime.enable');
await send('Page.enable');

const checks = {
  title: await evaluate('document.title'),
  apiKeys: await evaluate('Object.keys(window.qqbot ?? {}).length'),
  status: await evaluate('window.qqbot.getStatus().then(s => JSON.stringify(s))'),
  providers: await evaluate('window.qqbot.getSettings().then(v => v.providers.length)'),
  tabs: await evaluate("document.querySelectorAll('.tab').length"),
  rendered: await evaluate("document.querySelector('.topbar h1')?.textContent ?? '(没渲染)'"),
  sidecar: await evaluate('window.qqbot.getStatus().then(s => JSON.stringify(s.sidecar))'),
  venvPath: await evaluate('window.qqbot.getSettings().then(v => v.sidecar.venvPath)'),
};

const search = await evaluate(
  "window.qqbot.searchPlugins({query:'天气',tag:'',type:'all',onebotOnly:true,hideInvalid:true,limit:5,offset:0}).then(r => JSON.stringify({ok:r.ok,error:r.error.slice(0,120),total:r.total,names:r.items.map(p=>p.module_name)}))",
);

const shots = {};
const layout = {};

// 布局回归：字段/提示互相压位是纯 CSS 问题，用真实渲染出来的矩形判定，不靠肉眼
const LAYOUT_PROBE = `(() => {
  const vis = (e) => e.offsetParent !== null;
  const R = (e) => e.getBoundingClientRect();
  const hit = (a, b) => a.right > b.left && b.right > a.left && a.bottom > b.top && b.bottom > a.top;
  const cut = (e) => (e.textContent ?? '').trim().slice(0, 18);
  const problems = [];
  const fields = [...document.querySelectorAll('.field, .toggle')].filter(vis);
  for (let i = 0; i < fields.length; i += 1) {
    for (let j = i + 1; j < fields.length; j += 1) {
      if (hit(R(fields[i]), R(fields[j]))) problems.push('字段重叠: ' + cut(fields[i]) + ' × ' + cut(fields[j]));
    }
  }
  for (const hint of [...document.querySelectorAll('.hint')].filter(vis)) {
    const owner = hint.closest('.field, .toggle');
    if (owner === null) { problems.push('提示不在字段内: ' + cut(hint)); continue; }
    const hr = R(hint);
    for (const f of fields) if (f !== owner && hit(hr, R(f))) problems.push('提示压住字段: ' + cut(hint) + ' × ' + cut(f));
  }
  return problems.slice(0, 8);
})()`;

async function shot(name) {
  layout[name] = await evaluate(LAYOUT_PROBE);
  const img = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL(`./${name}.png`, import.meta.url), Buffer.from(img.data, 'base64'));
  shots[name] = true;
}

await shot('gui-connect');
await evaluate("document.querySelectorAll('.tab')[1].click(); 'ok'");
await sleep(400);
await shot('gui-models');
await evaluate("document.querySelectorAll('.tab')[2].click(); 'ok'");
await sleep(400);
await shot('gui-prompt');
await evaluate("document.querySelectorAll('.tab')[3].click(); 'ok'");
await sleep(1500);
await shot('gui-plugins');
await evaluate("document.querySelectorAll('.tab')[4].click(); 'ok'");
await sleep(400);
await shot('gui-logs');

const overlaps = Object.entries(layout).filter(([, problems]) => problems.length > 0);
console.log(JSON.stringify({ ...checks, search, shots, layout }, null, 2));
ws.close();
child.kill('SIGTERM');
await sleep(500);
child.kill('SIGKILL');
process.exit(overlaps.length > 0 ? 1 : 0);
