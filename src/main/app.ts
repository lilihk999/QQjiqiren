import { randomBytes } from 'node:crypto';
import type {
  AppStatus,
  InstalledPlugins,
  ModelTestRequest,
  ModelTestResult,
  OperationResult,
  PluginSearchRequest,
  PluginSearchResult,
  ProviderEdit,
  SendRequest,
  SettingsEdit,
  SettingsView,
  SidecarAction,
} from '../shared/ipc.ts';
import { Channel } from '../shared/ipc.ts';
import type { BotSettings, ChatMessage, FeedMessage, LogEntry, ModelProvider, OnebotStatus } from '../shared/types.ts';
import { findProvider } from '../shared/defaults.ts';
import type { GatewayDeps } from './gateway/server.ts';
import { AiGateway } from './gateway/server.ts';
import { chatOnce } from './gateway/upstream.ts';
import type { OneBotEvent } from './onebot/types.ts';
import { OneBotBridge } from './onebot/client.ts';
import { BotService } from './service/bot.ts';
import type { NsbPlugin, PluginRef } from './plugins/registry.ts';
import { fetchRegistry, queryPlugins, topTags } from './plugins/registry.ts';
import type { RunResult, StepResult } from './plugins/installer.ts';
import { PluginInstaller } from './plugins/installer.ts';
import type { SidecarManagerDeps } from './sidecar/manager.ts';
import { SidecarManager } from './sidecar/manager.ts';
import { SidecarBridge } from './sidecar/bridge.ts';
import type { SettingsStore } from './store.ts';

export interface BackendDeps {
  store: SettingsStore;
  version: string;
  dataDir: () => string;
  sidecarDir: () => string;
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
  readText: (path: string) => string;
  writeText: (path: string, text: string) => void;
  spawn: SidecarManagerDeps['spawn'];
  run: (command: string, args: string[], options: { cwd: string }) => Promise<RunResult>;
  /** 推给渲染进程；窗口没建好时可以是空实现 */
  send: (channel: string, payload: unknown) => void;
  readRegistryCache: () => NsbPlugin[];
  writeRegistryCache: (list: NsbPlugin[]) => void;
}

const MAX_LOGS = 500;
const MAX_FEED = 200;
const MODEL_TEST_TIMEOUT_MS = 30_000;

function maskKey(key: string): string {
  if (key.length === 0) return '';
  return `••••${key.slice(-4)}`;
}

/**
 * 主进程装配层：把协议端、AI 网关、侧车、插件安装器接在一起。
 *
 * 不 import electron，所有外部能力（spawn/文件系统/推送）都从 deps 注入，
 * 所以这条最关键的接线能被单测覆盖。
 */
export class Backend {
  private settings: BotSettings;
  private onebot: OneBotBridge | null = null;
  private onebotStatus: OnebotStatus = 'stopped';
  private selfId = 0;
  private logs: LogEntry[] = [];
  private feed: FeedMessage[] = [];
  private registry: NsbPlugin[] | null = null;
  private registryError = '';
  private registryLoading: Promise<NsbPlugin[]> | null = null;
  private gatewayDeps: GatewayDeps;
  private gateway: AiGateway;
  private manager: SidecarManager;
  private bridge: SidecarBridge;
  private installer: PluginInstaller;
  private bot: BotService;

  constructor(private readonly deps: BackendDeps) {
    this.settings = deps.store.load();
    const sidecar = this.settings.sidecar;
    let seeded = false;
    if (sidecar.gatewayToken.length === 0) {
      sidecar.gatewayToken = randomBytes(24).toString('hex');
      seeded = true;
      // 令牌只存在于主进程与侧车环境，不写进 GUI 可见的日志
      this.log('info', 'plugin', '已生成本机 AI 网关令牌');
    }
    if (sidecar.venvPath.trim().length === 0) {
      const sep = deps.platform === 'win32' ? '\\' : '/';
      sidecar.venvPath = `${deps.dataDir().replace(/[\\/]+$/, '')}${sep}plugin-env`;
      seeded = true;
    }
    if (seeded) deps.store.save(this.settings);

    this.gatewayDeps = {
      token: this.settings.sidecar.gatewayToken,
      resolveProvider: (requested: string) =>
        findProvider(this.settings, requested === 'default' ? this.settings.defaultProviderId : requested),
      listProviders: () => this.settings.providers.filter((p) => p.enabled),
      onUsage: ({ ok, ms, caller }) => {
        this.log(ok ? 'info' : 'warn', 'gateway', `${caller} 调用${ok ? '完成' : '失败'}，用时 ${String(ms)}ms`);
        this.pushStatus();
      },
    };
    this.gateway = new AiGateway(this.gatewayDeps);

    this.manager = new SidecarManager({
      settings: () => this.settings,
      sidecarDir: deps.sidecarDir,
      exists: deps.exists,
      spawn: deps.spawn,
      log: (level, text) => {
        this.log(level, 'sidecar', text);
        if (level === 'warn' || level === 'error') this.pushStatus();
      },
      platform: deps.platform,
    });

    this.bridge = new SidecarBridge({
      url: () => `ws://127.0.0.1:${String(this.settings.sidecar.port)}/onebot/v11/ws`,
      selfId: () => (this.selfId > 0 ? String(this.selfId) : null),
      accessToken: () => this.settings.sidecar.accessToken,
      call: (action, params) => this.callAction(action, params),
      log: (level, text) => this.log(level, 'sidecar', text),
    });
    this.bridge.on('status', (status) => {
      if (status === 'ready') this.manager.markRunning();
      this.pushStatus();
    });

    this.installer = new PluginInstaller({
      settings: () => this.settings,
      exists: deps.exists,
      run: deps.run,
      log: (level, text) => this.log(level, 'plugin', text),
      platform: deps.platform,
      sidecarDir: deps.sidecarDir,
      readManifest: () => this.readManifest(),
      writeManifest: (names) => this.writeManifest(names),
    });

    this.bot = new BotService({
      settings: () => this.settings,
      call: (action, params) => this.callAction(action, params),
      chat: (provider, messages) => this.chatWith(provider, messages),
      selfId: () => this.selfId,
      log: (level, text) => this.log(level, 'prompt', text),
      onMessage: (message) => this.pushFeed(message),
    });
  }

  // ---------- 日志与推送 ----------

  private log(level: LogEntry['level'], source: LogEntry['source'], text: string): void {
    const entry: LogEntry = { time: Date.now(), level, source, text };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    this.deps.send(Channel.logPush, entry);
  }

  private pushFeed(message: FeedMessage): void {
    this.feed.push(message);
    if (this.feed.length > MAX_FEED) this.feed.splice(0, this.feed.length - MAX_FEED);
    this.deps.send(Channel.feedPush, message);
  }

  private pushStatus(): void {
    this.deps.send(Channel.statusPush, this.status());
  }

  recentLogs(): LogEntry[] {
    return [...this.logs];
  }

  recentFeed(): FeedMessage[] {
    return [...this.feed];
  }

  // ---------- 状态 ----------

  status(): AppStatus {
    return {
      version: this.deps.version,
      dataDir: this.deps.dataDir(),
      onebot: this.onebotStatus,
      selfId: this.selfId,
      listenPort: this.onebot?.boundPort() ?? 0,
      sidecar: {
        state: this.manager.state,
        bridge: this.bridge.status,
        pid: this.manager.pid ?? 0,
        error: this.manager.error,
        port: this.settings.sidecar.port,
        url: `ws://127.0.0.1:${String(this.settings.sidecar.port)}/onebot/v11/ws`,
      },
      gateway: {
        port: this.gateway.boundPort(),
        calls: this.gateway.usage.calls,
        failures: this.gateway.usage.failures,
      },
      registry: {
        loaded: this.registry !== null,
        total: this.registry?.length ?? 0,
        error: this.registryError,
      },
    };
  }

  // ---------- 配置 ----------

  viewSettings(): SettingsView {
    return {
      onebot: this.settings.onebot,
      providers: this.settings.providers.map((p) => ({
        id: p.id,
        label: p.label,
        baseUrl: p.baseUrl,
        model: p.model,
        temperature: p.temperature,
        maxTokens: p.maxTokens,
        contextWindow: p.contextWindow,
        supportsVision: p.supportsVision,
        pathStyle: p.pathStyle,
        enabled: p.enabled,
        apiKeySet: p.apiKey.trim().length > 0,
        apiKeyMasked: maskKey(p.apiKey),
      })),
      defaultProviderId: this.settings.defaultProviderId,
      groupProviderOverrides: this.settings.groupProviderOverrides,
      prompt: this.settings.prompt,
      sidecar: this.settings.sidecar,
    };
  }

  async saveSettings(edit: SettingsEdit): Promise<OperationResult> {
    const previous = this.settings;
    const providers = edit.providers.map((p): ModelProvider => {
      const stored = previous.providers.find((x) => x.id === p.id);
      return {
        id: p.id,
        label: p.label,
        baseUrl: p.baseUrl,
        model: p.model,
        temperature: p.temperature,
        maxTokens: p.maxTokens,
        contextWindow: p.contextWindow,
        supportsVision: p.supportsVision,
        pathStyle: p.pathStyle,
        enabled: p.enabled,
        apiKey: p.apiKey === null ? (stored?.apiKey ?? '') : p.apiKey,
      };
    });

    this.settings = {
      onebot: edit.onebot,
      providers,
      defaultProviderId: edit.defaultProviderId,
      groupProviderOverrides: edit.groupProviderOverrides,
      prompt: edit.prompt,
      sidecar: edit.sidecar,
    };
    this.deps.store.save(this.settings);
    this.log('info', 'prompt', '配置已保存');

    this.gatewayDeps.token = this.settings.sidecar.gatewayToken;
    if (previous.onebot.listenPort !== this.settings.onebot.listenPort || previous.onebot.mode !== this.settings.onebot.mode) {
      await this.restartProtocolBridge();
    }
    if (previous.sidecar.gatewayPort !== this.settings.sidecar.gatewayPort) {
      await this.listenGateway();
    }
    if (
      previous.sidecar.port !== this.settings.sidecar.port ||
      previous.sidecar.accessToken !== this.settings.sidecar.accessToken
    ) {
      // 侧车的端口和令牌只在启动时读一次环境变量
      if (this.manager.state === 'running' || this.manager.state === 'starting') {
        this.log('warn', 'sidecar', '侧车端口或令牌已变更，正在重启侧车');
        await this.runSidecar('restart');
      }
      this.bridge.retrySoon();
    }
    this.pushStatus();
    return { ok: true, error: '' };
  }

  // ---------- 协议端 ----------

  async connect(): Promise<OperationResult> {
    if (this.onebot !== null) return { ok: true, error: '已在运行' };
    try {
      await this.listenGateway();
      const bridge = new OneBotBridge(this.settings.onebot);
      bridge.on('event', (event) => this.onEvent(event));
      bridge.on('status', (status) => {
        this.onebotStatus = status;
        if (status === 'connected') void this.discoverSelfId(bridge);
        this.pushStatus();
      });
      bridge.on('log', (level, text) => this.log(level, 'onebot', text));
      this.onebot = bridge;
      this.onebotStatus = 'listening';
      await bridge.start();
      this.onebotStatus = this.settings.onebot.mode === 'forward' ? 'reconnecting' : 'listening';
      if (this.settings.sidecar.autostart) await this.runSidecar('start');
      this.pushStatus();
      this.log(
        'info',
        'onebot',
        this.settings.onebot.mode === 'reverse'
          ? `等待协议端接入：ws://127.0.0.1:${String(this.onebot.boundPort())}（NapCat 里填 HTTP/WS 服务器地址）`
          : `正在连出到 ${this.settings.onebot.forwardUrl}`,
      );
      return { ok: true, error: '' };
    } catch (err) {
      this.onebot = null;
      this.onebotStatus = 'stopped';
      this.pushStatus();
      const text = String(err);
      return { ok: false, error: text.includes('EADDRINUSE') ? `端口 ${String(this.settings.onebot.listenPort)} 已被占用，请换一个` : text };
    }
  }

  async disconnect(): Promise<OperationResult> {
    await this.teardownProtocol();
    await this.runSidecar('stop');
    this.gateway.close();
    this.pushStatus();
    return { ok: true, error: '' };
  }

  private async teardownProtocol(): Promise<void> {
    const bridge = this.onebot;
    this.onebot = null;
    this.onebotStatus = 'stopped';
    bridge?.stop();
  }

  private async restartProtocolBridge(): Promise<void> {
    if (this.onebot === null) return;
    this.log('info', 'onebot', '接入配置有变，重新监听');
    await this.teardownProtocol();
    await this.connect();
  }

  private async discoverSelfId(bridge: OneBotBridge): Promise<void> {
    try {
      const data = (await bridge.call('get_login_info', {})) as { user_id?: number };
      const id = typeof data.user_id === 'number' ? data.user_id : 0;
      if (id > 0) this.applySelfId(id);
    } catch (err) {
      this.log('warn', 'onebot', `get_login_info 失败：${String(err)}，改从事件里识别机器人 QQ 号`);
    }
  }

  private applySelfId(id: number): void {
    if (id === this.selfId) return;
    this.selfId = id;
    this.log('info', 'onebot', `机器人 QQ 号：${String(id)}`);
    // NoneBot 适配器要求 X-Self-ID，拿到之后才可能完成侧车握手
    this.bridge.retrySoon();
    this.pushStatus();
  }

  private onEvent(event: OneBotEvent): void {
    const meta = event as { self_id?: number };
    if (typeof meta.self_id === 'number' && meta.self_id > 0) this.applySelfId(meta.self_id);
    this.bridge.publish(event);
    void this.bot.handle(event).catch((err: unknown) => this.log('error', 'prompt', `事件处理异常：${String(err)}`));
  }

  /** 动作调用：WS 在就用 WS，没连上才走 HTTP API；已在途的失败绝不重发，避免消息翻倍 */
  private async callAction(action: string, params: Record<string, unknown>): Promise<unknown> {
    const bridge = this.onebot;
    if (bridge === null) throw new Error('协议端未接入');
    if (bridge.activeSocket() !== null) return bridge.call(action, params);
    if (this.settings.onebot.httpApiBase.trim().length === 0) throw new Error('协议端未连接，且未配置 HTTP API 地址');
    return bridge.callHttp(action, params);
  }

  private async chatWith(provider: ModelProvider, messages: ChatMessage[]): Promise<string> {
    const result = await chatOnce(
      provider,
      { model: provider.model, messages, temperature: provider.temperature, max_tokens: provider.maxTokens, stream: false },
      AbortSignal.timeout(120_000),
    );
    return result.text;
  }

  async send(request: SendRequest): Promise<OperationResult> {
    const segment = [{ type: 'text', data: { text: request.text } }];
    const params = request.kind === 'group' ? { group_id: request.targetId, message: segment } : { user_id: request.targetId, message: segment };
    try {
      await this.callAction(request.kind === 'group' ? 'send_group_msg' : 'send_private_msg', params);
      this.pushFeed({
        id: `manual:${String(Date.now())}`,
        time: Date.now(),
        kind: request.kind,
        groupId: request.kind === 'group' ? request.targetId : 0,
        userId: 0,
        speaker: '我',
        text: request.text,
        direction: 'out',
        aiHandled: false,
        note: '手动发送',
      });
      return { ok: true, error: '' };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // ---------- 模型试跑 ----------

  async testModel(request: ModelTestRequest): Promise<ModelTestResult> {
    const provider = this.settings.providers.find((p) => p.id === request.providerId);
    if (provider === undefined) return { ok: false, reply: '', ms: 0, error: '未找到该模型配置' };
    if (provider.baseUrl.trim().length === 0) return { ok: false, reply: '', ms: 0, error: '请先填写 API 基址' };
    const started = Date.now();
    try {
      const result = await chatOnce(
        provider,
        { model: provider.model, messages: [{ role: 'user', content: request.prompt }], temperature: provider.temperature, max_tokens: provider.maxTokens, stream: false },
        AbortSignal.timeout(MODEL_TEST_TIMEOUT_MS),
      );
      return { ok: true, reply: result.text, ms: Date.now() - started, error: '' };
    } catch (err) {
      return { ok: false, reply: '', ms: Date.now() - started, error: String(err) };
    }
  }

  resetSessions(): OperationResult {
    this.bot.resetSessions();
    this.log('info', 'prompt', '已清空所有会话历史');
    return { ok: true, error: '' };
  }

  // ---------- 侧车 ----------

  async listenGateway(): Promise<void> {
    const port = this.settings.sidecar.gatewayPort;
    try {
      this.gateway.close();
      await this.gateway.listen(port);
      this.log('info', 'gateway', `本地 AI 网关：http://127.0.0.1:${String(this.gateway.boundPort())}/v1`);
    } catch (err) {
      this.log('error', 'gateway', `AI 网关监听 ${String(port)} 失败：${String(err)}`);
    }
  }

  async runSidecar(action: SidecarAction): Promise<AppStatus> {
    if (action === 'start') {
      this.manager.start();
      this.bridge.start();
    } else if (action === 'stop') {
      this.bridge.stop().catch(() => undefined);
      this.manager.stop();
    } else {
      this.bridge.stop().catch(() => undefined);
      this.manager.restart();
      this.bridge.start();
    }
    const status = this.status();
    this.pushStatus();
    return status;
  }

  // ---------- 插件市场 ----------

  private async loadRegistry(): Promise<NsbPlugin[]> {
    if (this.registry !== null) return this.registry;
    if (this.registryLoading !== null) return this.registryLoading;
    this.registryLoading = (async () => {
      try {
        const list = await fetchRegistry();
        this.registry = list;
        this.registryError = '';
        this.deps.writeRegistryCache(list);
        this.log('info', 'plugin', `插件索引已更新：${String(list.length)} 条`);
        return list;
      } catch (err) {
        const cached = this.deps.readRegistryCache();
        this.registryError = String(err);
        if (cached.length > 0) {
          this.registry = cached;
          this.log('warn', 'plugin', `索引拉取失败，使用本地缓存的 ${String(cached.length)} 条`);
          return cached;
        }
        this.log('error', 'plugin', `插件索引拉取失败：${String(err)}`);
        throw err;
      } finally {
        this.registryLoading = null;
      }
    })();
    return this.registryLoading;
  }

  async searchPlugins(request: PluginSearchRequest): Promise<PluginSearchResult> {
    let list: NsbPlugin[];
    try {
      list = await this.loadRegistry();
    } catch (err) {
      return { ok: false, error: String(err), total: 0, items: [], tags: [] };
    }
    const filtered = queryPlugins(list, {
      onebotOnly: request.onebotOnly,
      hideInvalid: request.hideInvalid,
      ...(request.query.length > 0 ? { query: request.query } : {}),
      ...(request.tag.length > 0 ? { tag: request.tag } : {}),
      ...(request.type === 'all' ? {} : { type: request.type }),
    });
    const limit = Math.max(1, Math.min(request.limit, 50));
    const offset = Math.max(0, request.offset);
    this.pushStatus();
    return {
      ok: true,
      error: '',
      total: filtered.length,
      items: filtered.slice(offset, offset + limit),
      tags: topTags(list, 20),
    };
  }

  async installedPlugins(): Promise<InstalledPlugins> {
    const env = await this.installer.probe();
    return { modules: this.installer.installed(), env };
  }

  installPlugin(ref: PluginRef): Promise<StepResult> {
    return this.installer.install(ref);
  }

  uninstallPlugin(module: string): Promise<StepResult> {
    return this.installer.uninstall(module);
  }

  prepareEnv(): Promise<StepResult> {
    return this.installer.ensureVenv();
  }

  private manifestPath(): string {
    const sep = this.deps.platform === 'win32' ? '\\' : '/';
    return `${this.deps.sidecarDir()}${sep}plugins.json`;
  }

  private readManifest(): string[] {
    try {
      const parsed = JSON.parse(this.deps.readText(this.manifestPath())) as unknown;
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeManifest(names: string[]): void {
    this.deps.writeText(this.manifestPath(), `${JSON.stringify(names, null, 2)}\n`);
  }

  // ---------- 退出 ----------

  async shutdown(): Promise<void> {
    await this.bridge.stop().catch(() => undefined);
    this.manager.stop();
    await this.teardownProtocol();
    this.gateway.close();
  }
}
