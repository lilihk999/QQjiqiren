import type { BotSettings, LogEntry } from '../../shared/types.ts';
import { venvPipPath, venvPythonPath } from '../sidecar/manager.ts';
import type { PluginRef } from "./registry.ts";
import { distributionName, importPath, pipRequirement } from './registry.ts';

type LogLevel = LogEntry['level'];

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface InstallerDeps {
  settings: () => BotSettings;
  exists: (p: string) => boolean;
  /** pip/venv 都是慢命令，注入后进程细节，测试里换成假实现 */
  run: (command: string, args: string[], opts: { cwd: string }) => Promise<RunResult>;
  log: (level: LogLevel, text: string) => void;
  platform: NodeJS.Platform;
  /** 侧车目录下的 plugins.json，bot.py 靠它决定加载哪些插件 */
  readManifest: () => string[];
  writeManifest: (names: string[]) => void;
  /** 侧车工程目录，requirements.txt 就在这里 */
  sidecarDir: () => string;
}

export interface StepResult {
  ok: boolean;
  /** 逐步回报给 GUI，否则装依赖时界面看起来像卡死了 */
  steps: string[];
}

/**
 * 清华 PyPI 镜像在国内会直接 403，腾讯这个可用；换环境请改这里而不是让用户手敲命令。
 */
const PIP_INDEX = 'https://mirrors.cloud.tencent.com/pypi/simple/';

/**
 * NoneBot2 插件市场的安装器。
 *
 * 装进独立 venv 而不是系统 Python：市场插件的依赖互相冲突很常见，
 * 炸了也只影响侧车环境，不会把用户的 Python 搞坏。
 */
export class PluginInstaller {
  constructor(private readonly deps: InstallerDeps) {}

  get venvPath(): string {
    return this.deps.settings().sidecar.venvPath.trim();
  }

  interpreter(): string {
    return venvPythonPath(this.venvPath, this.deps.platform);
  }

  /** 刚建好的 venv 里可能还没有 pip.exe，这时必须退回 python -m pip */
  private pip(): { command: string; prefix: string[] } {
    const exe = venvPipPath(this.venvPath, this.deps.platform);
    if (this.deps.exists(exe)) return { command: exe, prefix: [] };
    return { command: this.interpreter(), prefix: ['-m', 'pip'] };
  }

  /** 侧车能不能跑：venv 里有 python，且 nonebot 可导入 */
  async probe(): Promise<{ ok: boolean; detail: string }> {
    const python = this.interpreter();
    if (python.length === 0) return { ok: false, detail: '未设置虚拟环境路径' };
    if (!this.deps.exists(python)) return { ok: false, detail: `虚拟环境不存在：${python}` };
    const result = await this.deps.run(python, ['-c', 'import nonebot, nonebot.adapters.onebot.v11; print(nonebot.__version__)'], {
      cwd: this.deps.sidecarDir(),
    });
    if (result.code !== 0) {
      return { ok: false, detail: `依赖不完整：${(result.stderr || result.stdout).trim().slice(0, 200)}` };
    }
    return { ok: true, detail: `NoneBot ${result.stdout.trim()}` };
  }

  /**
   * 建 venv 需要的基础解释器。
   *
   * 没填路径时不能直接失败：第一次用的用户多半不知道要填什么，先探一下 PATH。
   * Windows 的 `python` 可能是应用商店的占位符，它会非零退出，所以必须看 `--version` 的输出。
   */
  private async resolveBaseInterpreter(): Promise<string | null> {
    const configured = this.deps.settings().sidecar.pythonPath.trim();
    if (configured.length > 0) return configured;
    const candidates = this.deps.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
    for (const candidate of candidates) {
      try {
        const probe = await this.deps.run(candidate, ['--version'], { cwd: this.deps.sidecarDir() });
        if (probe.code === 0 && probe.stdout.trim().startsWith('Python ')) return candidate;
      } catch {
        // 这个候选不在 PATH 上，接着试下一个
      }
    }
    return null;
  }

  async ensureVenv(): Promise<StepResult> {
    const steps: string[] = [];
    const python = this.interpreter();
    if (python.length === 0) {
      this.deps.log('error', '请先在「插件」页设置虚拟环境路径');
      return { ok: false, steps: ['未设置虚拟环境路径'] };
    }

    if (!this.deps.exists(python)) {
      const base = await this.resolveBaseInterpreter();
      if (base === null) {
        this.deps.log('error', 'PATH 上找不到可用的 Python 解释器');
        return { ok: false, steps: ['未找到可用的 Python，请在「插件」页填写基础解释器路径'] };
      }
      steps.push(`创建虚拟环境 ${this.venvPath}`);
      this.deps.log('info', steps[steps.length - 1] as string);
      const created = await this.deps.run(base, ['-m', 'venv', this.venvPath.replace(/\\/g, '/')], { cwd: this.deps.sidecarDir() });
      if (created.code !== 0) {
        steps.push(`失败：${(created.stderr || created.stdout).trim().slice(0, 200)}`);
        this.deps.log('error', steps[steps.length - 1] as string);
        return { ok: false, steps };
      }
    }

    steps.push('安装侧车依赖');
    this.deps.log('info', steps[steps.length - 1] as string);
    const { command, prefix } = this.pip();
    const installed = await this.deps.run(command, [...prefix, 'install', '-r', 'requirements.txt', '-i', PIP_INDEX], {
      cwd: this.deps.sidecarDir(),
    });
    if (installed.code !== 0) {
      steps.push(`失败：${(installed.stderr || installed.stdout).trim().slice(0, 300)}`);
      this.deps.log('error', steps[steps.length - 1] as string);
      return { ok: false, steps };
    }
    steps.push('完成');
    return { ok: true, steps };
  }

  /** 装 pip 包并写进侧车清单；重启侧车后 bot.py 才会真正加载它 */
  async install(plugin: PluginRef): Promise<StepResult> {
    const requirement = pipRequirement(plugin);
    const module = importPath(plugin);
    const steps: string[] = [`pip install ${requirement}`];
    this.deps.log('info', steps[0] as string);

    const { command, prefix } = this.pip();
    const result = await this.deps.run(command, [...prefix, 'install', requirement, '-i', PIP_INDEX], {
      cwd: this.deps.sidecarDir(),
    });
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(0, 300);
      steps.push(`失败：${detail}`);
      this.deps.log('error', `${module} 安装失败：${detail}`);
      return { ok: false, steps };
    }

    const names = this.deps.readManifest();
    if (!names.includes(module)) names.push(module);
    this.deps.writeManifest(names);
    steps.push(`已写入插件清单：${module}`);
    this.deps.log('info', `插件 ${module} 安装完成，重启侧车后生效`);
    return { ok: true, steps };
  }

  async uninstall(module: string): Promise<StepResult> {
    const steps: string[] = [];
    const builtin = module.startsWith('plugins.');
    if (builtin) {
      steps.push(`内置插件，无 pip 分发包：${module}`);
    } else {
      const { command, prefix } = this.pip();
      const distribution = distributionName(module);
      steps.push(`pip uninstall ${distribution}`);
      this.deps.log('info', steps[0] as string);
      const result = await this.deps.run(command, [...prefix, 'uninstall', '-y', distribution], {
        cwd: this.deps.sidecarDir(),
      });
      // 包名是从导入名反推的，对不上时 pip 会报错；清单移除才是用户真正要的效果
      if (result.code !== 0) {
        steps.push(`pip 未卸载成功（${(result.stderr || result.stdout).trim().slice(0, 200)}）`);
        this.deps.log('warn', `${module} 的 pip 卸载未成功：${distribution}`);
      }
    }
    this.deps.writeManifest(this.deps.readManifest().filter((n) => n !== module));
    steps.push(`清单已移除：${module}`);
    return { ok: true, steps };
  }

  installed(): string[] {
    return this.deps.readManifest();
  }
}
