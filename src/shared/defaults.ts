import type { BotSettings } from './types.ts';

/** 首次运行时写入用户数据目录的基线配置 */
export const DEFAULT_SETTINGS: BotSettings = {
  onebot: {
    mode: 'reverse',
    listenHost: '127.0.0.1',
    listenPort: 3001,
    forwardUrl: 'ws://127.0.0.1:3000',
    accessToken: '',
    httpApiBase: 'http://127.0.0.1:3000',
    actionTimeoutMs: 15_000,
  },
  providers: [
    {
      id: 'default',
      label: '默认模型',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0.7,
      maxTokens: 800,
      contextWindow: 65_536,
      supportsVision: false,
      pathStyle: 'openai',
      enabled: true,
    },
  ],
  defaultProviderId: 'default',
  groupProviderOverrides: {},
  prompt: {
    personaName: '小Q',
    personaDescription: '友好、简洁、不油腻的群聊助手。不确定就说不确定。',
    requireAtInGroup: true,
    triggerWords: [],
    historyTurns: 6,
    maxInputChars: 2_000,
    maxOutputChars: 1_200,
    chunkSize: 500,
    idleResetMs: 600_000,
  },
  sidecar: {
    pythonPath: '',
    venvPath: '',
    port: 3100,
    accessToken: '',
    gatewayPort: 3127,
    gatewayToken: '',
    autostart: false,
  },
};

/** 老版本配置文件缺字段时补齐，避免升级后启动崩溃 */
export function mergeDefaults(saved: Partial<BotSettings> | null): BotSettings {
  if (saved === null || typeof saved !== 'object') return structuredClone(DEFAULT_SETTINGS);
  const base = structuredClone(DEFAULT_SETTINGS);
  return {
    onebot: { ...base.onebot, ...(saved.onebot ?? {}) },
    providers: saved.providers !== undefined && saved.providers.length > 0 ? saved.providers : base.providers,
    defaultProviderId: saved.defaultProviderId ?? base.defaultProviderId,
    groupProviderOverrides: saved.groupProviderOverrides ?? base.groupProviderOverrides,
    prompt: { ...base.prompt, ...(saved.prompt ?? {}) },
    sidecar: { ...base.sidecar, ...(saved.sidecar ?? {}) },
  };
}

export function resolveProviderId(settings: BotSettings, sessionKey: string): string {
  if (sessionKey.startsWith('group:')) {
    const groupId = sessionKey.slice('group:'.length);
    const override = settings.groupProviderOverrides[groupId];
    if (override !== undefined) return override;
  }
  return settings.defaultProviderId;
}

export function findProvider(settings: BotSettings, id: string): BotSettings['providers'][number] | null {
  const enabled = settings.providers.filter((p) => p.enabled);
  return enabled.find((p) => p.id === id) ?? enabled[0] ?? null;
}
