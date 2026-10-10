import type {
  BotSettings,
  ConversationKind,
  FeedMessage,
  LogEntry,
  ModelProvider,
  OnebotStatus,
  SidecarState,
  SidecarStatus,
} from './types.ts';
import type { NsbPlugin, PluginRef } from '../main/plugins/registry.ts';
import type { StepResult } from '../main/plugins/installer.ts';

/**
 * 主进程 ↔ 渲染进程的唯一契约。
 *
 * 渲染进程是纯 DOM 环境：所有能力都经 preload 的 contextBridge 暴露，
 * 因此这里只放可序列化的数据形状，不放函数、不依赖 Electron 类型。
 */
export const Channel = {
  status: 'app:status',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  connect: 'onebot:connect',
  disconnect: 'onebot:disconnect',
  send: 'onebot:send',
  modelTest: 'model:test',
  sessionsReset: 'sessions:reset',
  sidecar: 'sidecar:action',
  pluginSearch: 'plugins:search',
  pluginInstalled: 'plugins:installed',
  pluginInstall: 'plugins:install',
  pluginUninstall: 'plugins:uninstall',
  envPrepare: 'env:prepare',
  logsRecent: 'logs:recent',
  feedRecent: 'feed:recent',
  feedPush: 'push:feed',
  logPush: 'push:log',
  statusPush: 'push:status',
} as const;

export interface OperationResult {
  ok: boolean;
  /** 空字符串代表没有错误，避免 IPC 里出现 undefined 字段 */
  error: string;
}

/** API 密钥永远不进渲染进程：只回是否已配置 + 末 4 位 */
export type ProviderView = Omit<ModelProvider, 'apiKey'> & {
  apiKeySet: boolean;
  apiKeyMasked: string;
};

export interface SettingsView {
  onebot: BotSettings['onebot'];
  providers: ProviderView[];
  defaultProviderId: string;
  groupProviderOverrides: BotSettings['groupProviderOverrides'];
  prompt: BotSettings['prompt'];
  sidecar: BotSettings['sidecar'];
}

/** apiKey 传 null 表示"沿用已保存的密钥"，界面不需要把它读回来再写回去 */
export type ProviderEdit = Omit<ModelProvider, 'apiKey'> & { apiKey: string | null };

export interface SettingsEdit {
  onebot: BotSettings['onebot'];
  providers: ProviderEdit[];
  defaultProviderId: string;
  groupProviderOverrides: BotSettings['groupProviderOverrides'];
  prompt: BotSettings['prompt'];
  sidecar: BotSettings['sidecar'];
}

export interface AppStatus {
  version: string;
  dataDir: string;
  onebot: OnebotStatus;
  /** 协议端告知的机器人 QQ 号，未接入时为 0 */
  selfId: number;
  /** reverse 模式下本进程实际监听端口（配 0 时由系统分配） */
  listenPort: number;
  sidecar: {
    state: SidecarState;
    bridge: SidecarStatus;
    pid: number;
    error: string;
    port: number;
    url: string;
  };
  gateway: { port: number; calls: number; failures: number };
  registry: { loaded: boolean; total: number; error: string };
}

export interface SendRequest {
  kind: ConversationKind;
  targetId: number;
  text: string;
}

export interface ModelTestRequest {
  providerId: string;
  prompt: string;
}

export interface ModelTestResult {
  ok: boolean;
  reply: string;
  ms: number;
  error: string;
}

/** IPC 里不用可选字段：一律用空串/'all' 表达"无限制"，省掉 exactOptionalPropertyTypes 的分支 */
export interface PluginSearchRequest {
  query: string;
  tag: string;
  type: 'application' | 'library' | 'all';
  onebotOnly: boolean;
  hideInvalid: boolean;
  limit: number;
  offset: number;
}

export interface PluginSearchResult {
  ok: boolean;
  error: string;
  total: number;
  items: NsbPlugin[];
  tags: Array<{ label: string; count: number }>;
}

export interface InstalledPlugins {
  modules: string[];
  env: { ok: boolean; detail: string };
}

export type SidecarAction = 'start' | 'stop' | 'restart';

export interface RendererApi {
  getStatus(): Promise<AppStatus>;
  getSettings(): Promise<SettingsView>;
  saveSettings(edit: SettingsEdit): Promise<OperationResult>;
  connect(): Promise<OperationResult>;
  disconnect(): Promise<OperationResult>;
  send(request: SendRequest): Promise<OperationResult>;
  testModel(request: ModelTestRequest): Promise<ModelTestResult>;
  resetSessions(): Promise<OperationResult>;
  sidecarAction(action: SidecarAction): Promise<AppStatus>;
  searchPlugins(request: PluginSearchRequest): Promise<PluginSearchResult>;
  installedPlugins(): Promise<InstalledPlugins>;
  installPlugin(ref: PluginRef): Promise<StepResult>;
  uninstallPlugin(module: string): Promise<StepResult>;
  prepareEnv(): Promise<StepResult>;
  recentLogs(): Promise<LogEntry[]>;
  recentFeed(): Promise<FeedMessage[]>;
  onFeed(listener: (message: FeedMessage) => void): () => void;
  onLog(listener: (entry: LogEntry) => void): () => void;
  onStatus(listener: (status: AppStatus) => void): () => void;
}
