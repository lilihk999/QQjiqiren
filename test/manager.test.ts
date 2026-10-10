import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type { BotSettings, LogEntry, SidecarSettings } from '../src/shared/types.ts';
import { DEFAULT_SETTINGS } from '../src/shared/defaults.ts';
import { SidecarManager, venvPipPath, venvPythonPath, type ChildLike } from '../src/main/sidecar/manager.ts';

type LogLevel = LogEntry['level'];

const SIDECAR_DIR = '/sidecar';
const BOT_PY = '/sidecar\\bot.py';
const VENV = '/venv';
const VENV_PY = venvPythonPath(VENV, 'win32');

/** 假进程：手动触发 exit/error，免得真的去 spawn Python */
class FakeChild implements ChildLike {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kills: string[] = [];
  private readonly onExit: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly onError: Array<(err: Error) => void> = [];

  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: string | null) => void) | ((err: Error) => void),
  ): void {
    if (event === 'exit') this.onExit.push(listener as (code: number | null, signal: string | null) => void);
    else this.onError.push(listener as (err: Error) => void);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal ?? 'SIGTERM');
    return true;
  }

  exit(code: number | null = 1, signal: string | null = null): void {
    for (const l of this.onExit) l(code, signal);
  }

  fail(err: Error): void {
    for (const l of this.onError) l(err);
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

function harness(options: { exists?: (p: string) => boolean; sidecar?: Partial<SidecarSettings> } = {}) {
  const children: FakeChild[] = [];
  const spawns: SpawnCall[] = [];
  const logs: Array<{ level: LogLevel; text: string }> = [];
  const settings = settingsFor({ venvPath: VENV, accessToken: 'sidecar-token', gatewayToken: 'gw-token', ...options.sidecar });

  const manager = new SidecarManager({
    settings: () => settings,
    sidecarDir: () => SIDECAR_DIR,
    exists: options.exists ?? ((p) => p === BOT_PY || p === VENV_PY),
    spawn: (command, args, opts) => {
      spawns.push({ command, args, cwd: opts.cwd, env: opts.env });
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    log: (level, text) => logs.push({ level, text }),
    platform: 'win32',
  });

  return { manager, children, spawns, logs };
}

function settingsFor(patch: Partial<SidecarSettings>): BotSettings {
  return { ...DEFAULT_SETTINGS, sidecar: { ...DEFAULT_SETTINGS.sidecar, ...patch } };
}

test('venv 路径解析跟随平台：Windows 用 Scripts，POSIX 用 bin', () => {
  assert.equal(venvPythonPath(VENV, 'win32'), '/venv\\Scripts\\python.exe');
  assert.equal(venvPythonPath(VENV, 'darwin'), '/venv/bin/python');
  assert.equal(venvPipPath(VENV + '/', 'win32'), '/venv\\Scripts\\pip.exe');
  assert.equal(venvPythonPath('   ', 'win32'), '');
});

test('启动侧车：argv 只有 bot.py，令牌只走环境变量', () => {
  const h = harness();
  h.manager.start();
  assert.equal(h.spawns.length, 1);
  const call = h.spawns[0] as SpawnCall;
  assert.equal(call.command, VENV_PY);
  assert.deepEqual(call.args, ['bot.py'], '解释器参数里不能塞任何密钥，Windows 进程列表能读到 argv');
  assert.equal(call.cwd, SIDECAR_DIR);
  assert.equal(call.env['QQBOT_SIDECAR_TOKEN'], 'sidecar-token');
  assert.equal(call.env['QQBOT_GATEWAY_TOKEN'], 'gw-token');
  assert.equal(call.env['QQBOT_SIDECAR_PORT'], '3100');
  assert.equal(call.env['QQBOT_GATEWAY_URL'], 'http://127.0.0.1:3127/v1');
  assert.equal(call.env['PYTHONIOENCODING'], 'utf-8', '不设的话 Python 按 GBK 写管道，主进程读到乱码');
  assert.equal(call.env['PYTHONUNBUFFERED'], '1');
  assert.ok(!JSON.stringify(call.args).includes('token'));
  assert.equal(h.manager.state, 'starting');
  assert.equal(h.manager.pid, 4242);

  // 桥接层握手成功才叫 running
  h.manager.markRunning();
  assert.equal(h.manager.state, 'running');
});

test('已在运行时重复 start 不会拉起第二个侧车进程', () => {
  const h = harness();
  h.manager.start();
  h.manager.markRunning();
  h.manager.start();
  h.manager.start();
  assert.equal(h.children.length, 1);
});

test('找不到解释器时给出可操作报错，并且不去 spawn', () => {
  const h = harness({ exists: (p) => p === BOT_PY });
  h.manager.start();
  assert.equal(h.manager.state, 'failed');
  assert.match(h.manager.error, /未找到 Python 解释器/);
  assert.equal(h.spawns.length, 0);

  const h2 = harness({
    exists: (p) => p === BOT_PY || p === 'C:\\python\\python.exe',
    sidecar: { venvPath: '', pythonPath: 'C:\\python\\python.exe' },
  });
  h2.manager.start();
  assert.equal(h2.spawns.length, 1, 'venv 缺失时回落到手选的 pythonPath');
  assert.equal(h2.spawns[0]?.command, 'C:\\python\\python.exe');
});

test('侧车工程文件缺失时报错带上具体路径', () => {
  const h = harness({ exists: (p) => p === VENV_PY });
  h.manager.start();
  assert.equal(h.manager.state, 'failed');
  assert.match(h.manager.error, /bot\.py/);
  assert.equal(h.spawns.length, 0);
});

test('启动即崩连续三次后放弃，不再无限重试烧 CPU', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const h = harness();
  h.manager.start();
  h.children[0]?.exit(1);

  // 指数退避：2s → 4s（第一次崩之后 fastCrashes=1）
  assert.equal(h.manager.state, 'backoff');
  t.mock.timers.tick(2_000);
  assert.equal(h.children.length, 2);
  assert.equal(h.manager.state, 'starting');
  h.children[1]?.exit(1);
  t.mock.timers.tick(2_000);
  assert.equal(h.children.length, 2, '退避还没到点就重启的话就是在抢启动');
  t.mock.timers.tick(2_000);
  assert.equal(h.children.length, 3);
  h.children[2]?.exit(1);

  assert.equal(h.manager.state, 'failed');
  assert.match(h.manager.error, /连续 3 次启动即崩/);
  t.mock.timers.tick(600_000);
  assert.equal(h.children.length, 3, '放弃之后不能再自己爬起来');
});

test('活过 3 秒的崩溃算正常故障：重置快速崩溃计数并按退避重启', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const h = harness();
  h.manager.start();
  h.manager.markRunning();
  t.mock.timers.tick(10_000);
  h.children[0]?.exit(2, 'SIGSEGV');

  assert.equal(h.manager.state, 'backoff');
  assert.match(h.logs.at(-1)?.text ?? '', /退出码 2，信号 SIGSEGV/);
  // 计数已归零，所以第一次退避是 1s 而不是接着上次翻倍
  t.mock.timers.tick(1_000);
  assert.equal(h.children.length, 2);
  assert.equal(h.manager.state, 'starting');
});

test('手动 start 会接管挂起的退避计时器', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const h = harness();
  h.manager.start();
  h.children[0]?.exit(1);
  assert.equal(h.manager.state, 'backoff');

  h.manager.start();
  assert.equal(h.children.length, 2);
  t.mock.timers.tick(60_000);
  assert.equal(h.children.length, 2, '旧定时器已被接管，不能又拉起一个');
});

test('spawn 抛错（ENOENT 等）落到 failed 而不是打崩主进程', () => {
  const h = harness();
  h.manager.start();
  h.children[0]?.fail(new Error('spawn /venv/Scripts/python.exe ENOENT'));
  assert.equal(h.manager.state, 'failed');
  assert.match(h.manager.error, /ENOENT/);
  assert.equal(h.manager.pid, undefined);
});

test('stop 之后不再自动重启', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const h = harness();
  h.manager.start();
  h.manager.markRunning();
  h.manager.stop();

  const child = h.children[0] as FakeChild;
  assert.deepEqual(child.kills, ['SIGTERM']);
  child.exit(0);
  assert.equal(h.manager.state, 'stopped');
  t.mock.timers.tick(60_000);
  assert.equal(h.children.length, 1);
});

test('restart 先停后起', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const h = harness();
  h.manager.start();
  h.manager.markRunning();
  h.manager.restart();
  assert.deepEqual((h.children[0] as FakeChild).kills, ['SIGTERM']);
  (h.children[0] as FakeChild).exit(0);
  t.mock.timers.tick(1_000);
  assert.equal(h.children.length, 2);
  assert.equal(h.manager.state, 'starting');
});

test('子进程输出按行进入日志，stderr 记为 warn', async () => {
  const h = harness();
  h.manager.start();
  const child = h.children[0] as FakeChild;
  child.stdout.write('NoneBot 启动中\n');
  child.stderr.write('[sidecar] 反向 WS 服务端就绪\n');
  child.stdout.write('\n');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    h.logs.map((l) => ({ level: l.level, text: l.text })),
    [
      { level: 'info', text: `启动插件侧车：${VENV_PY} bot.py` },
      { level: 'info', text: 'NoneBot 启动中' },
      { level: 'warn', text: '[sidecar] 反向 WS 服务端就绪' },
    ],
    '空行必须丢掉，否则 GUI 日志里全是空白',
  );
});
