import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { OneBotEvent } from '../onebot/types.ts';
import type { LogEntry, SidecarStatus } from '../../shared/types.ts';

type LogLevel = LogEntry['level'];

interface ActionRequest {
  action?: unknown;
  params?: unknown;
  echo?: unknown;
}

export interface SidecarBridgeDeps {
  /** 侧车的反向 WS 服务端地址，如 ws://127.0.0.1:3100/onebot/v11/ws */
  url: () => string;
  /** NoneBot 用 X-Self-ID 区分 Bot，缺失会直接被它关闭连接 */
  selfId: () => string | null;
  accessToken: () => string;
  /** 转交给真实协议端的动作调用 */
  call: (action: string, params: Record<string, unknown>) => Promise<unknown>;
  log: (level: LogLevel, text: string) => void;
}

const MAX_RETRY_DELAY_MS = 15_000;

function backoff(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.min(attempt, 4), MAX_RETRY_DELAY_MS);
}

/**
 * 主进程 → NoneBot 侧车的桥。
 *
 * 方向是反的：侧车里的官方 onebot.v11 适配器会在 ASGI 上开 /onebot/v11/ws，
 * 本桥作为 WS 客户端连进去，把 NapCat 推来的事件原样转发，并把侧车发出的
 * 动作请求转交给真实协议端。这样 NoneBot 插件市场里的插件无需任何改动即可运行。
 *
 * 依赖全部注入，测试里可以用一个假 WS 服务端跑真实协议。
 */
export class SidecarBridge extends EventEmitter<{
  status: [SidecarStatus];
}> {
  private sock: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private running = false;

  constructor(private readonly deps: SidecarBridgeDeps) {
    super();
  }

  get status(): SidecarStatus {
    if (!this.running) return 'stopped';
    const state = this.sock?.readyState;
    if (state === WebSocket.OPEN) return 'ready';
    return state === WebSocket.CONNECTING ? 'connecting' : 'retrying';
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  /** 协议端连上之后才知道机器人 QQ 号，届时调用它唤醒一次连接 */
  retrySoon(): void {
    if (!this.running || this.sock !== null) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.attempt = 0;
    this.connect();
  }

  private connect(): void {
    if (!this.running) return;
    const url = this.deps.url();
    const selfId = this.deps.selfId();
    if (selfId === null) {
      this.deps.log('warn', '侧车桥暂缓连接：还不知道机器人 QQ 号');
      this.schedule();
      return;
    }
    const token = this.deps.accessToken();
    let sock: WebSocket;
    try {
      sock = new WebSocket(url, {
        headers: {
          'x-self-id': selfId,
          ...(token.length > 0 ? { Authorization: `Bearer ${token}` } : {}),
        },
        handshakeTimeout: 5_000,
      });
    } catch (err) {
      // 令牌和地址都是用户手填的，含空格或中文会让 ws 在构造时同步抛 ERR_INVALID_CHAR，
      // 不接住就会打崩主进程
      this.deps.log('error', `无法连接插件侧车：${String(err)}（access_token 需为不含空格的 ASCII）`);
      this.schedule();
      return;
    }
    this.sock = sock;
    this.emit('status', this.status);

    sock.on('open', () => {
      this.attempt = 0;
      this.deps.log('info', `已接入插件侧车：${url}`);
      this.emit('status', 'ready');
    });
    sock.on('message', (raw) => {
      void this.handleFrame(sock, String(raw));
    });
    sock.on('error', (err) => {
      this.deps.log('debug', `侧车连接错误：${String(err)}`);
    });
    sock.on('close', (code, reason) => {
      if (this.sock === sock) this.sock = null;
      if (!this.running) return;
      const text = String(reason);
      // 403/1008 基本都是令牌或 X-Self-ID 问题，重试没有意义，只提示一次
      if (code === 1008 || code === 403 || text.includes('token') || text.includes('Self-ID')) {
        this.deps.log('error', `侧车拒绝本桥接入（${String(code)} ${text}）：请检查「插件」页的 access_token 与机器人 QQ 号`);
      } else {
        this.deps.log('warn', `侧车连接断开（${String(code)} ${text}）`);
      }
      this.schedule();
    });
  }

  /** 侧车是按需启动的，连不上要退避重试，但不能每秒撞一次 ECONNREFUSED */
  private schedule(): void {
    if (!this.running || this.timer !== null) return;
    const delay = backoff(this.attempt);
    this.attempt += 1;
    this.emit('status', 'retrying');
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private async handleFrame(sock: WebSocket, text: string): Promise<void> {
    let payload: ActionRequest;
    try {
      payload = JSON.parse(text) as ActionRequest;
    } catch {
      this.deps.log('warn', '侧车发来非 JSON 帧，已忽略');
      return;
    }
    const action = typeof payload.action === 'string' ? payload.action : '';
    const echo = typeof payload.echo === 'string' ? payload.echo : undefined;
    if (action.length === 0 || echo === undefined) return;
    if (sock.readyState !== WebSocket.OPEN) return;

    const params = typeof payload.params === 'object' && payload.params !== null ? (payload.params as Record<string, unknown>) : {};
    this.deps.log('debug', `侧车动作请求：${action}`);
    try {
      const data = await this.deps.call(action, params);
      if (sock.readyState !== WebSocket.OPEN) return;
      sock.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo }));
    } catch (err) {
      // 必须回 failed，否则侧车里的 await 会一直等到它自己的 api_timeout
      if (sock.readyState !== WebSocket.OPEN) return;
      sock.send(
        JSON.stringify({
          status: 'failed',
          retcode: 1_400,
          message: String(err),
          wording: String(err),
          echo,
        }),
      );
    }
  }

  /** 事件转发是尽力而为：侧车没起来就丢，主进程自己的 AI 管线不依赖它 */
  publish(event: OneBotEvent): void {
    const sock = this.sock;
    if (sock === null || sock.readyState !== WebSocket.OPEN) return;
    sock.send(JSON.stringify(event));
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const sock = this.sock;
    this.sock = null;
    if (sock !== null) {
      sock.removeAllListeners();
      sock.close(1000, 'desktop app shutdown');
    }
    this.emit('status', 'stopped');
  }
}
