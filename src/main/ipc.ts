import type {
  ModelTestRequest,
  OperationResult,
  PluginSearchRequest,
  ProviderEdit,
  SendRequest,
  SettingsEdit,
  SidecarAction,
} from '../shared/ipc.ts';
import { Channel } from '../shared/ipc.ts';
import type { ModelProvider, PromptSettings } from '../shared/types.ts';
import type { PluginRef } from './plugins/registry.ts';
import type { Backend } from './app.ts';

export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/**
 * IPC 是渲染进程能碰到主进程的唯一入口，而渲染进程里显示的是群聊原文，
 * 属于不可信输入能到达的最外层边界，因此每个字段都在这里重新校验：
 * 界面上填错最多是保存不生效，不能让 chunkSize=0 这类值进到主进程把发送循环卡死。
 */

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9_.+!-]{0,63}$/;
const MODULE_RE = /^[A-Za-z0-9][A-Za-z0-9_.]{0,127}$/;

class Reject extends Error {}

function str(value: unknown, field: string, max = 4000): string {
  if (typeof value !== 'string') throw new Reject(`${field} 类型不对`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Reject(`${field} 过长`);
  return trimmed;
}

function optionalStr(value: unknown, field: string, max = 4000): string {
  if (value === undefined || value === null) return '';
  return str(value, field, max);
}

function num(value: unknown, field: string, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new Reject(`${field} 不是数字`);
  if (n < min || n > max) throw new Reject(`${field} 需在 ${String(min)}~${String(max)} 之间`);
  return Math.round(n);
}

function float(value: unknown, field: string, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Reject(`${field} 需在 ${String(min)}~${String(max)} 之间`);
  return n;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Reject(`${field} 必须是布尔值`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Reject('配置格式不对');
  return value as Record<string, unknown>;
}

function httpUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Reject(`${field} 不是合法地址`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Reject(`${field} 只支持 http/https`);
  return url.toString();
}

function port(value: unknown, field: string): number {
  const p = num(value, field, 0, 65_535);
  if (p < 1_024) throw new Reject(`${field} 不能占用系统保留端口`);
  return p;
}

function providerBase(raw: unknown): Omit<ModelProvider, 'apiKey'> {
  const p = record(raw);
  const id = str(p['id'], '模型 ID', 40);
  if (!ID_RE.test(id)) throw new Reject('模型 ID 只能用小写字母、数字、下划线和短横线');
  const style = str(p['pathStyle'], '路径风格', 10);
  return {
    id,
    label: str(p['label'], '显示名', 60),
    baseUrl: httpUrl(str(p['baseUrl'], 'API 基址', 500), 'API 基址'),
    model: str(p['model'], '模型名', 120),
    temperature: float(p['temperature'], '温度', 0, 2),
    maxTokens: num(p['maxTokens'], '最大输出', 16, 32_000),
    contextWindow: num(p['contextWindow'], '上下文窗口', 1_024, 10_000_000),
    supportsVision: bool(p['supportsVision'], '视觉能力'),
    pathStyle: style === 'bare' ? 'bare' : 'openai',
    enabled: bool(p['enabled'], '启用'),
  };
}

/** apiKey 传字符串就覆盖，传 null/不传就保留主进程里已存的密钥 */
function normalizeProviderEdit(raw: unknown): ProviderEdit {
  return { ...providerBase(raw), apiKey: typeof record(raw)['apiKey'] === 'string' ? str(record(raw)['apiKey'], 'API 密钥', 500) : null };
}

function normalizePrompt(raw: unknown): PromptSettings {
  const p = record(raw);
  const words = Array.isArray(p['triggerWords'])
    ? p['triggerWords'].map((w) => str(w, '触发词', 40)).filter((w) => w.length > 0).slice(0, 20)
    : [];
  return {
    personaName: str(p['personaName'], '机器人昵称', 40),
    personaDescription: str(p['personaDescription'], '人设描述', 4_000),
    requireAtInGroup: bool(p['requireAtInGroup'], '群内需 @ 触发'),
    triggerWords: words,
    historyTurns: num(p['historyTurns'], '历史轮数', 0, 50),
    maxInputChars: num(p['maxInputChars'], '最长输入', 50, 200_000),
    maxOutputChars: num(p['maxOutputChars'], '最长输出', 20, 20_000),
    chunkSize: num(p['chunkSize'], '分段长度', 50, 4_000),
    idleResetMs: num(p['idleResetMs'], '静默重置', 10_000, 86_400_000),
  };
}

function normalizeEdit(raw: unknown): SettingsEdit {
  const root = record(raw);
  const onebot = record(root['onebot']);
  const mode = str(onebot['mode'], '接入模式', 10);
  const forwardUrl = str(onebot['forwardUrl'], '协议端地址', 500);
  if (forwardUrl.length > 0 && !/^wss?:\/\//i.test(forwardUrl)) throw new Reject('协议端地址需以 ws:// 或 wss:// 开头');
  const httpApiBase = str(onebot['httpApiBase'], 'HTTP API 基址', 500);

  const providersRaw = Array.isArray(root['providers']) ? root['providers'] : [];
  if (providersRaw.length === 0) throw new Reject('至少要配置一个模型');
  const providers = providersRaw.map(normalizeProviderEdit);
  if (new Set(providers.map((p) => p.id)).size !== providers.length) throw new Reject('模型 ID 不能重复');
  const defaultProviderId = str(root['defaultProviderId'], '默认模型', 40);
  if (!providers.some((p) => p.id === defaultProviderId)) throw new Reject('默认模型必须在模型列表里');

  const groupProviderOverrides: Record<string, string> = {};
  for (const [group, providerId] of Object.entries(record(root['groupProviderOverrides']))) {
    if (!/^\d{1,20}$/.test(group)) throw new Reject(`群号格式不对：${group}`);
    if (typeof providerId !== 'string' || !providers.some((p) => p.id === providerId)) continue;
    groupProviderOverrides[group] = providerId;
  }

  const sidecar = record(root['sidecar']);
  return {
    onebot: {
      mode: mode === 'forward' ? 'forward' : 'reverse',
      listenHost: str(onebot['listenHost'], '监听地址', 60),
      listenPort: port(onebot['listenPort'], '监听端口'),
      forwardUrl,
      accessToken: str(onebot['accessToken'], 'access_token', 300),
      httpApiBase: httpApiBase.length === 0 ? '' : httpUrl(httpApiBase, 'HTTP API 基址'),
      actionTimeoutMs: num(onebot['actionTimeoutMs'], '动作超时', 1_000, 120_000),
    },
    providers,
    defaultProviderId,
    groupProviderOverrides,
    prompt: normalizePrompt(root['prompt']),
    sidecar: {
      pythonPath: str(sidecar['pythonPath'], 'Python 路径', 500),
      venvPath: str(sidecar['venvPath'], '虚拟环境路径', 500),
      port: port(sidecar['port'], '侧车端口'),
      accessToken: str(sidecar['accessToken'], '侧车令牌', 300),
      gatewayPort: port(sidecar['gatewayPort'], '网关端口'),
      gatewayToken: str(sidecar['gatewayToken'], '网关令牌', 300),
      autostart: bool(sidecar['autostart'], '随程序启动侧车'),
    },
  };
}

function normalizeRef(raw: unknown): PluginRef {
  const p = record(raw);
  const moduleName = str(p['module_name'], '插件模块名', 128);
  const projectLink = str(p['project_link'], '分发包名', 128);
  const version = str(p['version'], '版本', 64);
  // 这三个字段会直接拼进 pip 命令参数，放开就等于允许装任意包
  if (!NAME_RE.test(moduleName)) throw new Reject(`插件模块名不合法：${moduleName}`);
  if (!NAME_RE.test(projectLink)) throw new Reject(`分发包名不合法：${projectLink}`);
  if (!VERSION_RE.test(version)) throw new Reject(`版本号不合法：${version}`);
  return { module_name: moduleName, project_link: projectLink, version };
}

function normalizeSearch(raw: unknown): PluginSearchRequest {
  const p = record(raw);
  const type = str(p['type'], '类型', 12);
  return {
    query: str(p['query'], '关键词', 120),
    tag: optionalStr(p['tag'], '标签', 60),
    type: type === 'application' || type === 'library' ? type : 'all',
    onebotOnly: bool(p['onebotOnly'], '仅 OneBot'),
    hideInvalid: bool(p['hideInvalid'], '隐藏不兼容'),
    limit: num(p['limit'], '每页数量', 1, 50),
    offset: num(p['offset'], '偏移', 0, 1_000_000),
  };
}

function normalizeSend(raw: unknown): SendRequest {
  const p = record(raw);
  const kind = str(p['kind'], '会话类型', 10);
  if (kind !== 'group' && kind !== 'private') throw new Reject('会话类型不对');
  const targetId = num(p['targetId'], '目标号码', 1, 4_294_967_295);
  const text = str(p['text'], '内容', 4_500);
  if (text.length === 0) throw new Reject('发送内容不能为空');
  return { kind, targetId, text };
}

function normalizeModelTest(raw: unknown): ModelTestRequest {
  const p = record(raw);
  return { providerId: str(p['providerId'], '模型 ID', 40), prompt: str(p['prompt'], '试跑内容', 2_000) };
}

function normalizeSidecarAction(raw: unknown): SidecarAction {
  const action = str(raw, '侧车动作', 10);
  if (action !== 'start' && action !== 'stop' && action !== 'restart') throw new Reject('未知的侧车动作');
  return action;
}

function messageOf(err: unknown): string {
  return err instanceof Reject ? err.message : String(err);
}

/**
 * 统一把异常转成结构化返回值：Electron 会把 handler 抛出的错误变成渲染进程里的
 * "Error invoking remote method"，那样用户看不到我们写好的中文原因。
 */
function invoke<T>(build: (args: unknown[]) => Promise<T> | T, onError: (message: string) => T) {
  return async (_event: unknown, ...args: unknown[]): Promise<T> => {
    try {
      return await build(args);
    } catch (err) {
      return onError(messageOf(err));
    }
  };
}

export function registerIpc(ipcMain: IpcMainLike, backend: Backend): void {
  const badRequest = (message: string): OperationResult => ({ ok: false, error: message });

  ipcMain.handle(Channel.status, () => backend.status());
  ipcMain.handle(Channel.settingsGet, () => backend.viewSettings());
  ipcMain.handle(Channel.settingsSave, invoke((a) => backend.saveSettings(normalizeEdit(a[0])), badRequest));
  ipcMain.handle(Channel.connect, invoke(() => backend.connect(), badRequest));
  ipcMain.handle(Channel.disconnect, invoke(() => backend.disconnect(), badRequest));
  ipcMain.handle(Channel.send, invoke((a) => backend.send(normalizeSend(a[0])), badRequest));
  ipcMain.handle(Channel.modelTest, invoke((a) => backend.testModel(normalizeModelTest(a[0])), (message) => ({
    ok: false,
    reply: '',
    ms: 0,
    error: message,
  })));
  ipcMain.handle(Channel.sessionsReset, () => backend.resetSessions());
  ipcMain.handle(Channel.sidecar, invoke((a) => backend.runSidecar(normalizeSidecarAction(a[0])), () => backend.status()));
  ipcMain.handle(Channel.pluginSearch, invoke((a) => backend.searchPlugins(normalizeSearch(a[0])), (message) => ({
    ok: false,
    error: message,
    total: 0,
    items: [],
    tags: [],
  })));
  ipcMain.handle(Channel.pluginInstalled, invoke(() => backend.installedPlugins(), (message) => ({
    modules: [],
    env: { ok: false, detail: message },
  })));
  ipcMain.handle(Channel.pluginInstall, invoke((a) => backend.installPlugin(normalizeRef(a[0])), (message) => ({
    ok: false,
    steps: [message],
  })));
  ipcMain.handle(Channel.pluginUninstall, invoke((a) => {
    const module = str(a[0], '插件模块名', 128);
    if (!MODULE_RE.test(module)) throw new Reject('插件模块名不合法');
    return backend.uninstallPlugin(module);
  }, (message) => ({ ok: false, steps: [message] })));
  ipcMain.handle(Channel.envPrepare, invoke(() => backend.prepareEnv(), (message) => ({ ok: false, steps: [message] })));
  ipcMain.handle(Channel.logsRecent, () => backend.recentLogs());
  ipcMain.handle(Channel.feedRecent, () => backend.recentFeed());
}
