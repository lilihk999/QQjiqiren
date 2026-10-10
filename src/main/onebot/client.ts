import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { OneBotEvent, OneBotResponse } from './types.ts';
import type { OneBotSettings, OnebotStatus } from '../../shared/types.ts';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface WsResponseEnvelope {
  status?: string;
  retcode?: number;
  data?: unknown;
  echo?: string;
  message?: string;
  wording?: string;
  post_type?: string;
}

function isEventEnvelope(payload: WsResponseEnvelope): boolean {
  return typeof payload['post_type'] === 'string';
}

/**
 * OneBot v11 传输层。
 *
 * reverse：本进程起 HTTP 服务器，NapCat / LLOneBot 作为 HTTP 客户端或 WS 客户端主动连入。
 *          桌面端 NAT 后无需公网，这是默认推荐。
 * forward：本进程作为 WS 客户端连出到协议端。
 *
 * 动作调用优先走 WS 的 send_server_side_request（echo 关联），
 * 协议端不支持时降级到 HTTP API。
 */
export class OneBotBridge extends EventEmitter<{
  event: [OneBotEvent];
  status: [OnebotStatus];
  log: [level: 'info' | 'warn' | 'error', text: string];
}> {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private outbound: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private stopped = false;

  constructor(private readonly settings: OneBotSettings) {
    super();
  }

  private log(level: 'info' | 'warn' | 'error', text: string): void {
    this.emit('log', level, text);
  }

  private connected(): boolean {
    return (
      (this.socket !== null && this.socket.readyState === WebSocket.OPEN) ||
      (this.outbound !== null && this.outbound.readyState === WebSocket.OPEN)
    );
  }

  activeSocket(): WebSocket | null {
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) return this.socket;
    if (this.outbound !== null && this.outbound.readyState === WebSocket.OPEN) return this.outbound;
    return null;
  }

  /** listenPort 配 0 时由系统分配，GUI 与测试都需要拿到真实端口 */
  boundPort(): number {
    const addr = this.server?.address();
    if (typeof addr === 'object' && addr !== null) return addr.port;
    return this.settings.listenPort;
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.settings.mode === 'forward') {
      this.connectOutbound();
      return;
    }
    await this.startListeningServer();
  }

  private async startListeningServer(): Promise<void> {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        this.readHttpEvent(req, res);
        return;
      }
      res.writeHead(req.method === 'GET' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ app: 'qqbot-desktop', protocol: 'OneBot-V11', ok: true }));
    });
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, clientSocket, head) => {
      if (!this.authorize(req.url ?? '', req.headers['authorization'])) {
        this.log('warn', '拒绝握手：access_token 不匹配');
        clientSocket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      wss.handleUpgrade(req, clientSocket, head, (sock) => {
        wss.emit('connection', sock, req);
      });
    });

    wss.on('connection', (sock) => {
      // NapCat 重连时旧连接不一定先关闭，保留最新一条避免动作发往僵尸 socket
      if (this.socket !== null && this.socket !== sock) {
        this.socket.close();
      }
      this.socket = sock;
      this.log('info', '协议端已接入');
      this.emit('status', 'connected');
      sock.on('message', (raw) => this.handleFrame(raw.toString()));
      sock.on('close', () => {
        if (this.socket === sock) this.socket = null;
        this.emit('status', 'listening');
        this.log('warn', '协议端断开');
      });
      sock.on('error', (err) => this.log('error', `WS 错误：${err.message}`));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.settings.listenPort, this.settings.listenHost, () => {
        server.off('error', reject);
        resolve();
      });
    });

    this.server = server;
    this.wss = wss;
    this.emit('status', 'listening');
    this.log('info', `监听 ws://${this.settings.listenHost}:${this.settings.listenPort}`);
  }

  private authorize(url: string, authorizationHeader: string | undefined): boolean {
    const expected = this.settings.accessToken.trim();
    if (expected.length === 0) return true;
    if (typeof authorizationHeader === 'string') {
      const value = authorizationHeader.replace(/^Bearer\s+/i, '');
      if (value === expected) return true;
    }
    const query = new URL(url, 'http://placeholder').searchParams.get('access_token');
    return query === expected;
  }

  private readHttpEvent(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!this.authorize(req.url ?? '', req.headers['authorization'])) {
        res.writeHead(401);
        res.end();
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WsResponseEnvelope;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: null }));
        if (isEventEnvelope(parsed)) this.emit('event', parsed as unknown as OneBotEvent);
      } catch (err) {
        res.writeHead(400);
        res.end();
        this.log('error', `HTTP 事件解析失败：${String(err)}`);
      }
    });
  }

  private connectOutbound(): void {
    if (this.stopped) return;
    this.emit('status', 'reconnecting');
    const url = this.settings.forwardUrl.trim();
    if (url.length === 0) {
      this.log('error', 'forward 模式需要填写协议端 WS 地址');
      return;
    }
    const token = this.settings.accessToken.trim();
    const sock = new WebSocket(url, {
      headers: token.length > 0 ? { Authorization: `Bearer ${token}` } : {},
    });
    this.outbound = sock;

    sock.on('open', () => {
      this.reconnectDelay = 1000;
      this.emit('status', 'connected');
      this.log('info', `已连出到 ${url}`);
    });
    sock.on('message', (raw) => this.handleFrame(raw.toString()));
    sock.on('close', () => {
      if (this.outbound === sock) this.outbound = null;
      this.emit('status', 'reconnecting');
      this.scheduleReconnect();
    });
    sock.on('error', (err) => {
      this.log('warn', `连出失败：${err.message}`);
      sock.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectOutbound();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }

  private handleFrame(text: string): void {
    let payload: WsResponseEnvelope;
    try {
      payload = JSON.parse(text) as WsResponseEnvelope;
    } catch {
      this.log('warn', '收到非 JSON 帧，已忽略');
      return;
    }

    const echo = payload['echo'];
    if (typeof echo === 'string') {
      const waiting = this.pending.get(echo);
      if (waiting !== undefined) {
        this.pending.delete(echo);
        clearTimeout(waiting.timer);
        const retcode = payload['retcode'] ?? 0;
        if (retcode === 0 || payload['status'] === 'ok') {
          waiting.resolve(payload['data']);
        } else {
          waiting.reject(
            new Error(
              `协议端返回 retcode=${String(retcode)}：${payload['message'] ?? payload['wording'] ?? '未知错误'}`,
            ),
          );
        }
        return;
      }
    }

    if (isEventEnvelope(payload)) {
      this.emit('event', payload as unknown as OneBotEvent);
    }
  }

  /** WS 上行动作；协议端不支持 echo 时抛错，由调用方决定是否走 HTTP */
  call<T>(action: string, params: Record<string, unknown>): Promise<T> {
    const sock = this.activeSocket();
    if (sock === null) return Promise.reject(new Error('协议端未连接'));
    const echo = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`${action} 超时（${String(this.settings.actionTimeoutMs)}ms）`));
      }, this.settings.actionTimeoutMs);
      this.pending.set(echo, { resolve: resolve as (v: unknown) => void, reject, timer });
      sock.send(JSON.stringify({ action, params, echo }), (err) => {
        if (err === null || err === undefined) return;
        const waiting = this.pending.get(echo);
        if (waiting !== undefined) {
          this.pending.delete(echo);
          clearTimeout(waiting.timer);
          reject(err);
        }
      });
    });
  }

  async callHttp<T>(action: string, params: Record<string, unknown>): Promise<T> {
    const base = this.settings.httpApiBase.trim().replace(/\/$/, '');
    const token = this.settings.accessToken.trim();
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token.length > 0 ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(this.settings.actionTimeoutMs),
    });
    const body = (await res.json()) as OneBotResponse<T>;
    if (body.retcode !== 0 && body.status !== 'ok') {
      throw new Error(`${action} 失败 retcode=${String(body.retcode)}：${body.message ?? body.wording ?? ''}`);
    }
    return body.data;
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error('连接已关闭'));
    }
    this.pending.clear();
    this.socket?.close();
    this.outbound?.close();
    this.socket = null;
    this.outbound = null;
    this.wss?.close();
    this.server?.close();
    this.wss = null;
    this.server = null;
    this.emit('status', 'stopped');
  }
}
