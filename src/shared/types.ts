export type ConversationKind = 'private' | 'group';

/** 协议端接入状态（主进程 OneBotBridge 上报） */
export type OnebotStatus = 'stopped' | 'listening' | 'connected' | 'reconnecting';

/** 主进程→NoneBot 侧车的桥状态 */
export type SidecarStatus = 'stopped' | 'connecting' | 'ready' | 'retrying';

/** 侧车子进程状态 */
export type SidecarState = 'stopped' | 'starting' | 'running' | 'backoff' | 'failed';

export interface OneBotSettings {
  /**
   * reverse —— NapCat/LLOneBot 作为 WS 客户端主动连入本程序监听的端口（推荐，桌面端无需公网）
   * forward —— 本程序作为 WS 客户端连出到协议端提供的地址
   */
  mode: 'reverse' | 'forward';
  /** reverse 模式下本程序监听地址 */
  listenHost: string;
  listenPort: number;
  /** forward 模式下协议端 WS 地址 */
  forwardUrl: string;
  accessToken: string;
  /** 协议端 HTTP API 基址，仅在需要额外调用 HTTP 动作时使用 */
  httpApiBase: string;
  actionTimeoutMs: number;
}

export interface ModelProvider {
  id: string;
  label: string;
  /** OpenAI 兼容基址，必须以 /v1 或可拼接 /chat/completions 的形式给出 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  contextWindow: number;
  supportsVision: boolean;
  /** 有些自建端点（vLLM/Ollama）不遵守 /v1 前缀约定 */
  pathStyle: 'openai' | 'bare';
  enabled: boolean;
}

export interface PromptSettings {
  personaName: string;
  personaDescription: string;
  /** 群内是否只有被 @ 才响应；私聊始终响应 */
  requireAtInGroup: boolean;
  /** 额外触发词（命中任一即响应） */
  triggerWords: string[];
  historyTurns: number;
  maxInputChars: number;
  maxOutputChars: number;
  /** QQ 无法渲染 Markdown，长回复按此长度分段发送 */
  chunkSize: number;
  /** 连续对话的静默超时，超过则丢弃历史 */
  idleResetMs: number;
}

export interface SidecarSettings {
  pythonPath: string;
  venvPath: string;
  /** 侧车（NoneBot）ASGI 监听端口，主进程以 OneBot v11 反向 WS 客户端接入它的 /onebot/v11/ws */
  port: number;
  /** 主进程↔侧车之间的本机令牌，对应 nonebot 的 onebot_v11_access_token */
  accessToken: string;
  /** 本地 AI 网关监听端口，NoneBot 插件通过它调用模型 */
  gatewayPort: number;
  gatewayToken: string;
  autostart: boolean;
}

export interface BotSettings {
  onebot: OneBotSettings;
  providers: ModelProvider[];
  /** 会话类型到 providerId 的默认路由 */
  defaultProviderId: string;
  /** 指定群使用特定模型 */
  groupProviderOverrides: Record<string, string>;
  prompt: PromptSettings;
  sidecar: SidecarSettings;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  speaker: string;
  speakerId: number;
  text: string;
  atMe: boolean;
  time: number;
}

export interface LogEntry {
  time: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: 'onebot' | 'gateway' | 'sidecar' | 'plugin' | 'prompt';
  text: string;
}

export interface FeedMessage {
  id: string;
  time: number;
  kind: ConversationKind;
  groupId: number;
  userId: number;
  speaker: string;
  text: string;
  direction: 'in' | 'out';
  /** 本条是否触发了模型调用 */
  aiHandled: boolean;
  note?: string;
}
