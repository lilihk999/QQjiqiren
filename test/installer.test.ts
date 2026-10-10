import test from 'node:test';
import assert from 'node:assert/strict';
import type { BotSettings, LogEntry, SidecarSettings } from '../src/shared/types.ts';
import { DEFAULT_SETTINGS } from '../src/shared/defaults.ts';
import { PluginInstaller, type RunResult } from '../src/main/plugins/installer.ts';
import { venvPipPath, venvPythonPath } from '../src/main/sidecar/manager.ts';
import type { NsbPlugin } from '../src/main/plugins/registry.ts';

const SIDECAR_DIR = '/sidecar';
const VENV = '/venv';
const VENV_PY = venvPythonPath(VENV, 'win32');
const VENV_PIP = venvPipPath(VENV, 'win32');
const MIRROR = 'https://mirrors.cloud.tencent.com/pypi/simple/';

function plugin(overrides: Partial<NsbPlugin> = {}): NsbPlugin {
  return {
    module_name: 'nonebot_plugin_status',
    project_link: 'nonebot-plugin-status',
    name: '服务状态监控',
    desc: '查看机器人运行状态',
    author: 'nonebot',
    homepage: 'https://github.com/nonebot/plugin-status',
    tags: [{ label: 'tool', color: '#fff' }],
    is_official: true,
    type: 'application',
    supported_adapters: null,
    valid: true,
    version: '0.9.0',
    time: '2026-01-01T00:00:00Z',
    skip_test: false,
    ...overrides,
  };
}

interface RunCall {
  command: string;
  args: string[];
  cwd: string;
}

function harness(options: {
  exists?: (p: string) => boolean;
  sidecar?: Partial<SidecarSettings>;
  /** 按调用顺序返回结果，超出部分一律成功 */
  results?: RunResult[];
  /** 这些命令直接 ENOENT，模拟 PATH 上没有 Python */
  missing?: string[];
  manifest?: string[];
} = {}) {
  const calls: RunCall[] = [];
  const logs: Array<{ level: LogEntry['level']; text: string }> = [];
  let manifest = [...(options.manifest ?? [])];
  const queue = [...(options.results ?? [])];
  const missing = new Set(options.missing ?? []);
  const settings: BotSettings = {
    ...DEFAULT_SETTINGS,
    sidecar: { ...DEFAULT_SETTINGS.sidecar, venvPath: VENV, ...options.sidecar },
  };

  const installer = new PluginInstaller({
    settings: () => settings,
    exists: options.exists ?? ((p) => p === VENV_PY || p === VENV_PIP),
    run: async (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd });
      if (missing.has(command)) throw new Error(`spawn ${command} ENOENT`);
      return queue.shift() ?? { code: 0, stdout: 'ok\n', stderr: '' };
    },
    log: (level, text) => logs.push({ level, text }),
    platform: 'win32',
    readManifest: () => [...manifest],
    writeManifest: (names) => {
      manifest = [...names];
    },
    sidecarDir: () => SIDECAR_DIR,
  });

  return { installer, calls, logs, manifest: () => manifest };
}

test('探针：venv 缺失、依赖缺失、依赖完整三种结果都要能区分', async () => {
  const noVenv = harness({ exists: () => false });
  assert.deepEqual(await noVenv.installer.probe(), { ok: false, detail: `虚拟环境不存在：${VENV_PY}` });

  const notSet = harness({ sidecar: { venvPath: '' } });
  assert.equal((await notSet.installer.probe()).detail, '未设置虚拟环境路径');

  const broken = harness({ results: [{ code: 1, stdout: '', stderr: "ModuleNotFoundError: No module named 'nonebot'" }] });
  const r = await broken.installer.probe();
  assert.equal(r.ok, false);
  assert.match(r.detail, /依赖不完整：ModuleNotFoundError/);

  const good = harness({ results: [{ code: 0, stdout: '2.5.0\n', stderr: '' }] });
  assert.deepEqual(await good.installer.probe(), { ok: true, detail: 'NoneBot 2.5.0' });
  const call = good.calls[0] as RunCall;
  assert.equal(call.command, VENV_PY);
  assert.equal(call.cwd, SIDECAR_DIR);
  assert.match(call.args[1] ?? '', /nonebot\.adapters\.onebot\.v11/, '探针必须真的导入适配器');
});

test('首次准备环境：先建 venv 再装 requirements.txt，并走国内可用镜像', async () => {
  const h = harness({
    exists: (p) => p === VENV_PIP,
    sidecar: { pythonPath: 'C:\\Python312\\python.exe' },
  });
  const r = await h.installer.ensureVenv();
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls.map((c) => c.command), ['C:\\Python312\\python.exe', VENV_PIP], '建 venv 用基础解释器，装依赖用 venv 的 pip');
  assert.deepEqual(h.calls[0]?.args, ['-m', 'venv', VENV]);
  assert.deepEqual(h.calls[1]?.args, ['install', '-r', 'requirements.txt', '-i', MIRROR]);
  assert.ok(r.steps.some((s) => s.includes('创建虚拟环境')));
  assert.ok(r.steps.some((s) => s.includes('安装侧车依赖')));
});

test('venv 已就绪时不重复创建，只做依赖安装', async () => {
  const h = harness();
  const r = await h.installer.ensureVenv();
  assert.equal(r.ok, true);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0]?.args, ['install', '-r', 'requirements.txt', '-i', MIRROR]);
});

test('刚建好的 venv 里没有 pip.exe，必须退回 python -m pip', async () => {
  const h = harness({ exists: (p) => p === VENV_PY });
  const r = await h.installer.ensureVenv();
  assert.equal(r.ok, true);
  const pip = h.calls.at(-1) as RunCall;
  assert.equal(pip.command, VENV_PY);
  assert.deepEqual(pip.args.slice(0, 2), ['-m', 'pip'], '直接调 pip.exe 会 ENOENT');
});

test('建 venv 失败时把 stderr 交给 GUI，不再继续装依赖', async () => {
  const h = harness({
    exists: () => false,
    sidecar: { pythonPath: 'C:\\Python312\\python.exe' },
    results: [{ code: 2, stdout: '', stderr: 'ensurepip is not available' }],
  });
  const r = await h.installer.ensureVenv();
  assert.equal(r.ok, false);
  assert.match(r.steps.join('\n'), /ensurepip is not available/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.logs.at(-1)?.level, 'error');
});

test('虚拟环境目录为空时不调 pip，直接提示去设置', async () => {
  const h = harness({ exists: () => false, sidecar: { venvPath: '' } });
  const r = await h.installer.ensureVenv();
  assert.deepEqual(r.steps, ['未设置虚拟环境路径']);
  assert.equal(h.calls.length, 0);
});

test('没填基础解释器时先探 PATH，探测成功就用它建 venv', async () => {
  const h = harness({
    exists: () => false,
    sidecar: { pythonPath: '' },
    results: [
      { code: 1, stdout: 'Python was not found', stderr: '' },
      { code: 0, stdout: 'Python 3.12.7\n', stderr: '' },
    ],
  });
  const r = await h.installer.ensureVenv();
  assert.equal(r.ok, true);
  assert.deepEqual(
    h.calls.map((c) => c.command),
    ['python', 'py', 'py', VENV_PY],
    '商店占位符退出码非 0，必须换下一个候选；建完 venv 用 venv 里的解释器装依赖',
  );
  assert.deepEqual(h.calls[1]?.args, ['--version'], '先用 --version 判断解释器真的可用');
  assert.deepEqual(h.calls[2]?.args, ['-m', 'venv', VENV]);
});

test('PATH 上没有 Python 时给出可操作的提示，不去 spawn 一个不存在的命令', async () => {
  const h = harness({ exists: () => false, sidecar: { pythonPath: '' }, missing: ['python', 'py'] });
  const r = await h.installer.ensureVenv();
  assert.equal(r.ok, false);
  assert.match(r.steps.join('\n'), /未找到可用的 Python/);
  assert.deepEqual(h.calls.map((c) => c.args), [['--version'], ['--version']]);
  assert.equal(h.logs.at(-1)?.level, 'error');
});

test('安装插件：pip 用 project_link，清单写导入名', async () => {
  const h = harness({ manifest: ['plugins.ai_gateway_demo'] });
  const r = await h.installer.install(plugin());
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls[0]?.args, ['install', 'nonebot-plugin-status==0.9.0', '-i', MIRROR]);
  assert.equal(h.calls[0]?.cwd, SIDECAR_DIR);
  assert.deepEqual(h.manifest(), ['plugins.ai_gateway_demo', 'nonebot_plugin_status']);
  assert.ok(r.steps.some((s) => s.includes('重启侧车') || s.includes('插件清单')));
  assert.match(h.logs.at(-1)?.text ?? '', /重启侧车后生效/);
});

test('安装失败不改清单，报错截断但不丢关键信息', async () => {
  const h = harness({
    manifest: ['plugins.ai_gateway_demo'],
    results: [{ code: 1, stdout: '', stderr: 'ERROR: No matching distribution found for nonebot-plugin-status==0.9.0' }],
  });
  const r = await h.installer.install(plugin());
  assert.equal(r.ok, false);
  assert.match(r.steps.join('\n'), /No matching distribution/);
  assert.deepEqual(h.manifest(), ['plugins.ai_gateway_demo'], '装失败不能把插件写进清单，否则侧车启动即崩');
});

test('重复安装同一个插件不会把清单写出两份', async () => {
  const h = harness({ manifest: ['nonebot_plugin_status'] });
  await h.installer.install(plugin());
  assert.deepEqual(h.manifest(), ['nonebot_plugin_status']);
});

test('卸载：第三方包按导入名反推分发包，内置插件跳过 pip', async () => {
  const h = harness({ manifest: ['nonebot_plugin_status', 'plugins.ai_gateway_demo'] });
  const r = await h.installer.uninstall('nonebot_plugin_status');
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls[0]?.args, ['uninstall', '-y', 'nonebot-plugin-status']);
  assert.deepEqual(h.manifest(), ['plugins.ai_gateway_demo']);

  const builtin = harness({ manifest: ['nonebot_plugin_status', 'plugins.ai_gateway_demo'] });
  const r2 = await builtin.installer.uninstall('plugins.ai_gateway_demo');
  assert.equal(r2.ok, true);
  assert.equal(builtin.calls.length, 0, '内置插件没有分发包，不该去麻烦 pip');
  assert.deepEqual(builtin.manifest(), ['nonebot_plugin_status']);
});

test('pip 卸载失败不影响从清单摘掉，只是把原因留在步骤里', async () => {
  const h = harness({
    manifest: ['nonebot_plugin_status'],
    results: [{ code: 1, stdout: '', stderr: 'WARNING: Skipping nonebot-plugin-status as it is not installed.' }],
  });
  const r = await h.installer.uninstall('nonebot_plugin_status');
  assert.equal(r.ok, true);
  assert.deepEqual(h.manifest(), []);
  assert.match(r.steps.join('\n'), /pip 未卸载成功/);
  assert.equal(h.logs.at(-1)?.level, 'warn');
});

test('installed() 直接反映清单', () => {
  const h = harness({ manifest: ['plugins.ai_gateway_demo'] });
  assert.deepEqual(h.installer.installed(), ['plugins.ai_gateway_demo']);
});
