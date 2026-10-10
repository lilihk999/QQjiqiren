import { createInterface } from 'node:readline';
import type { BotSettings, LogEntry, SidecarState } from '../../shared/types.ts';

type LogLevel = LogEntry['level'];

export interface ChildLike {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface SidecarManagerDeps {
  settings: () => BotSettings;
  /** 侧车工程目录：开发时是仓库里的 sidecar/，打包后是 resources/sidecar/ */
  sidecarDir: () => string;
  exists: (p: string) => boolean;
  spawn: (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => ChildLike;
  log: (level: LogLevel, text: string) => void;
  platform: NodeJS.Platform;
}

const MAX_FAST_CRASHES = 3;
/** 存活不足这么久就算"启动即崩"，连崩三次就不再重试，避免刷屏烧 CPU */
const FAST_CRASH_MS = 3_000;

function backoffDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.min(attempt, 4), 30_000);
}

/** venv 在 Windows 和 POSIX 下的布局不同，装完插件和启动侧车都要用它 */
export function venvPythonPath(venvPath: string, platform: NodeJS.Platform): string {
  const trimmed = venvPath.trim().replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return '';
  return platform === 'win32' ? `${trimmed}\\Scripts\\python.exe` : `${trimmed}/bin/python`;
}

export function venvPipPath(venvPath: string, platform: NodeJS.Platform): string {
  const trimmed = venvPath.trim().replace(/[\\/]+$/, '');
  if (trimmed.length === 0) return '';
  return platform === 'win32' ? `${trimmed}\\Scripts\\pip.exe` : `${trimmed}/bin/pip`;
}

/**
 * NoneBot2 侧车进程的生命周期。
 *
 * 侧车只吃环境变量：API 密钥不进 argv（Windows 上同机其他用户能读到进程列表），
 * 也不写 .env 文件（会残留在磁盘上）。主进程通过 SidecarBridge 与它通信。
 */
export class SidecarManager {
  private child: ChildLike | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private fastCrashes = 0;
  private stopping = false;
  private lastError = '';
  private current: SidecarState = 'stopped';

  constructor(private readonly deps: SidecarManagerDeps) {}

  get state(): SidecarState {
    return this.current;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** GUI 上要显示"为什么起不来"，光有个 failed 状态没用 */
  get error(): string {
    return this.lastError;
  }

  /** 解释器优先级：venv > 手选的 pythonPath > 系统 python */
  resolveInterpreter(): string {
    const { settings, exists, platform } = this.deps;
    const sidecar = settings().sidecar;
    const fromVenv = venvPythonPath(sidecar.venvPath, platform);
    if (fromVenv.length > 0 && exists(fromVenv)) return fromVenv;
    const chosen = sidecar.pythonPath.trim();
    if (chosen.length > 0 && exists(chosen)) return chosen;
    return '';
  }

  envFor(): Record<string, string> {
    const sidecar = this.deps.settings().sidecar;
    return {
      QQBOT_SIDECAR_PORT: String(sidecar.port),
      QQBOT_SIDECAR_TOKEN: sidecar.accessToken,
      QQBOT_GATEWAY_URL: `http://127.0.0.1:${String(sidecar.gatewayPort)}/v1`,
      QQBOT_GATEWAY_TOKEN: sidecar.gatewayToken,
      PYTHONUNBUFFERED: '1',
      // 不设的话 Python 按控制台代码页(GBK)写管道，主进程按 UTF-8 读会得到乱码
      PYTHONIOENCODING: 'utf-8',
      NO_COLOR: '1',
    };
  }

  /** 桥接层握手成功才算就绪：进程还活着不代表 NoneBot 已把反向 WS 端点挂起来 */
  markRunning(): void {
    if (this.current === 'starting') this.setState('running');
  }

  start(): void {
    if (this.current === 'running' || this.current === 'starting') return;
    // 手动点「启动」就要接管退避计时器，否则旧定时器会再拉起一个进程
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const interpreter = this.resolveInterpreter();
    if (interpreter.length === 0) {
      this.fail('未找到 Python 解释器：请在「插件」页选择 Python 或先创建虚拟环境');
      return;
    }
    const dir = this.deps.sidecarDir();
    if (!this.deps.exists(`${dir}${this.deps.platform === 'win32' ? '\\' : '/'}bot.py`)) {
      this.fail(`侧车工程缺失：${dir}/bot.py`);
      return;
    }

    this.stopping = false;
    this.setState('starting');
    this.deps.log('info', `启动插件侧车：${interpreter} bot.py`);

    let child: ChildLike;
    try {
      child = this.deps.spawn(interpreter, ['bot.py'], { cwd: dir, env: this.envFor() });
    } catch (err) {
      this.fail(`侧车启动失败：${String(err)}`);
      return;
    }
    this.child = child;
    this.startedAt = Date.now();

    this.pipe(child.stdout, 'info');
    this.pipe(child.stderr, 'warn');

    child.on('error', (err) => {
      // ENOENT 之类在这里到，exit 事件不一定还会来
      this.child = null;
      this.fail(`侧车进程错误：${String(err)}`);
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      if (this.stopping) {
        this.setState('stopped');
        this.stopping = false;
        return;
      }
      const uptime = Date.now() - this.startedAt;
      const detail = `退出码 ${String(code)}${signal === null || signal === undefined ? '' : `，信号 ${signal}`}`;
      if (uptime < FAST_CRASH_MS) this.fastCrashes += 1;
      else this.fastCrashes = 0;

      if (this.fastCrashes >= MAX_FAST_CRASHES) {
        this.fail(`侧车连续 ${String(MAX_FAST_CRASHES)} 次启动即崩（${detail}），已停止重试。请检查 Python 环境与插件报错`);
        return;
      }
      const delay = backoffDelay(this.fastCrashes);
      this.deps.log('warn', `侧车${detail}，${String(delay)}ms 后重启`);
      this.setState('backoff');
      this.timer = setTimeout(() => {
        this.timer = null;
        this.start();
      }, delay);
    });
  }

  private pipe(stream: NodeJS.ReadableStream | null, level: LogLevel): void {
    if (stream === null) return;
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    lines.on('line', (line) => {
      const text = line.trimEnd();
      if (text.length > 0) this.deps.log(level, text);
    });
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const child = this.child;
    if (child === null) {
      this.fastCrashes = 0;
      this.setState('stopped');
      return;
    }
    this.stopping = true;
    this.fastCrashes = 0;
    child.kill('SIGTERM');
  }

  restart(): void {
    this.stop();
    // stop 走的是 SIGTERM + exit 回调，这里等状态落定再拉起
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, 600);
  }

  private fail(reason: string): void {
    this.lastError = reason;
    this.deps.log('error', reason);
    this.setState('failed');
  }

  private setState(next: SidecarState): void {
    if (next !== 'failed') this.lastError = '';
    this.current = next;
  }
}
