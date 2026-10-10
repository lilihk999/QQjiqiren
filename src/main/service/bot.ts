import type { BotSettings, ChatMessage, ConversationTurn, FeedMessage, ModelProvider } from '../../shared/types.ts';
import type { MessageEvent, MessageSegment, OneBotEvent } from '../onebot/types.ts';
import { isGroupMessage, isMessageEvent, normalizeMessage, replyTarget, sessionKey, type NormalizedMessage } from '../onebot/protocol.ts';
import { findProvider, resolveProviderId } from '../../shared/defaults.ts';
import { assembleMessages, shanghaiNow } from '../prompt/assemble.ts';
import { chunkForSend, decideRespond, postProcessReply, sanitizeIncoming, withinCooldown } from '../prompt/guardrails.ts';

interface Session {
  turns: ConversationTurn[];
  lastActivityMs: number;
  lastCallMs: number;
  /** 群名需要额外一次动作调用，缓存起来避免每条消息都问一遍 */
  groupName?: string;
  busy: boolean;
}

export interface BotDeps {
  settings: () => BotSettings;
  /** 由 OneBot 传输层注入，便于单测替换 */
  call: (action: string, params: Record<string, unknown>) => Promise<unknown>;
  chat: (provider: ModelProvider, messages: ChatMessage[]) => Promise<string>;
  selfId: () => number;
  log: (level: 'info' | 'warn' | 'error', text: string) => void;
  onMessage: (msg: FeedMessage) => void;
}

const MAX_STORED_TURNS = 200;
const CALL_COOLDOWN_MS = 1_500;

function displayName(event: MessageEvent): string {
  const card = event.sender.card?.trim() ?? '';
  return card.length > 0 ? card : event.sender.nickname;
}

/**
 * 会话引擎：OneBot 事件 → 响应闸门 → 上下文装配 → 模型调用 → 分段发送。
 *
 * 关键取舍：
 * - 群内他人发言一律记入上下文（哪怕没回复），否则机器人对群聊脉络是瞎的；
 * - 只有过了 decideRespond 闸门的消息才产生模型调用，这是 token 成本的主闸门；
 * - 同一会话同一时刻只允许一次在途调用，刷屏时宁可跳过也不要打爆上游。
 */
export class BotService {
  private sessions = new Map<string, Session>();

  constructor(private readonly deps: BotDeps) {}

  resetSessions(): void {
    this.sessions = new Map();
  }

  historyOf(key: string): ConversationTurn[] {
    return this.session(key).turns;
  }

  private session(key: string): Session {
    const existing = this.sessions.get(key);
    if (existing !== undefined) return existing;
    const created: Session = { turns: [], lastActivityMs: 0, lastCallMs: 0, busy: false };
    this.sessions.set(key, created);
    return created;
  }

  /** 长时间没人说话后清掉历史，避免几小时前的话题污染当前回复 */
  private prune(session: Session, nowMs: number, idleResetMs: number): void {
    if (session.lastActivityMs > 0 && nowMs - session.lastActivityMs > idleResetMs) {
      session.turns = [];
      session.lastCallMs = 0;
    }
  }

  private emitFeed(turn: ConversationTurn, key: string, aiHandled: boolean): void {
    const msg: FeedMessage = {
      id: `${key}:${String(turn.time)}:${String(turn.speakerId)}`,
      time: turn.time,
      kind: key.startsWith('group:') ? 'group' : 'private',
      groupId: key.startsWith('group:') ? Number(key.slice('group:'.length)) : 0,
      userId: turn.speakerId,
      speaker: turn.speaker,
      text: turn.text,
      direction: turn.role === 'user' ? 'in' : 'out',
      aiHandled,
    };
    this.deps.onMessage(msg);
  }

  async handle(event: OneBotEvent): Promise<void> {
    if (!isMessageEvent(event)) return;
    const settings = this.deps.settings();
    const kind = isGroupMessage(event) ? 'group' : 'private';
    const key = sessionKey(event);
    const session = this.session(key);
    this.prune(session, Date.now(), settings.prompt.idleResetMs);

    // 自己的发言不入上下文：机器人的回复已经作为 assistant 轮记录过了
    if (event.user_id === this.deps.selfId()) return;

    const normalized = normalizeMessage(event, this.deps.selfId());
    const text = normalized.textWithMentions.length > 0 ? normalized.textWithMentions : normalized.nonText.map((m) => m.hint).join(' ');
    if (text.trim().length === 0) return;

    const turn: ConversationTurn = {
      role: 'user',
      speaker: displayName(event),
      speakerId: event.user_id,
      text,
      atMe: normalized.atMe,
      time: event.time * 1000,
    };
    session.turns.push(turn);
    if (session.turns.length > MAX_STORED_TURNS) session.turns = session.turns.slice(-MAX_STORED_TURNS);
    session.lastActivityMs = turn.time;
    this.emitFeed(turn, key, false);

    const decision = decideRespond(event, normalized, kind, settings.prompt, this.deps.selfId());
    if (!decision.respond) {
      this.deps.log('info', `不响应（${decision.reason}）：${text.slice(0, 40)}`);
      return;
    }
    if (session.busy) {
      this.deps.log('warn', `同一会话在处理中，跳过：${key}`);
      return;
    }
    if (withinCooldown(session.lastCallMs, Date.now(), CALL_COOLDOWN_MS)) {
      this.deps.log('warn', '命中调用冷却，跳过');
      return;
    }

    session.busy = true;
    session.lastCallMs = Date.now();
    try {
      await this.answer(event, normalized, session, key, kind, settings);
    } catch (err) {
      this.deps.log('error', `处理失败：${String(err)}`);
    } finally {
      session.busy = false;
    }
  }

  private async answer(
    event: MessageEvent,
    normalized: NormalizedMessage,
    session: Session,
    key: string,
    kind: 'group' | 'private',
    settings: BotSettings,
  ): Promise<void> {
    const provider = findProvider(settings, resolveProviderId(settings, key));
    if (provider === null) {
      this.deps.log('warn', '没有可用的模型配置，请先在「模型」页添加');
      return;
    }

    const { nowText, weekday } = shanghaiNow();
    const sanitized = sanitizeIncoming(normalized.text, settings.prompt);
    const quote = await this.quotedText(event, normalized);
    const group = kind === 'group' ? await this.groupName(session, key) : undefined;
    const role = isGroupMessage(event) ? event.sender.role : undefined;

    const assembled = assembleMessages({
      promptSettings: settings.prompt,
      promptContext: {
        kind,
        senderName: displayName(event),
        selfName: settings.prompt.personaName,
        nowText,
        weekday,
        visionAvailable: provider.supportsVision,
        ...(group !== undefined ? { groupName: group } : {}),
        ...(role !== undefined ? { senderRole: role } : {}),
      },
      // 当前轮会被单独装配成最后一条 user 消息，历史里必须排除它
      history: session.turns.slice(0, -1),
      sanitized,
      normalized,
      meta: {
        speaker: displayName(event),
        ...(quote !== null ? { replyQuote: quote } : {}),
        mediaHints: normalized.nonText.map((m) => m.hint),
      },
      contextWindow: provider.contextWindow,
    });

    this.deps.log('info', `调用 ${provider.label}，装配 ${String(assembled.messages.length)} 条消息，约 ${String(assembled.totalTokens)} token${assembled.droppedTurns > 0 ? `（丢历史 ${String(assembled.droppedTurns)} 条）` : ''}`);

    const reply = postProcessReply(await this.deps.chat(provider, assembled.messages), settings.prompt);
    if (reply.length === 0) {
      this.deps.log('warn', '模型返回空内容，不发送');
      return;
    }

    const chunks = chunkForSend(reply, settings.prompt.chunkSize);
    const target = replyTarget(event);
    for (let i = 0; i < chunks.length; i += 1) {
      const text = chunks[i] as string;
      const message: MessageSegment[] =
        i === 0 ? this.firstSegments(text, event, normalized, kind) : [{ type: 'text', data: { text } }];
      await this.send(target, message);
    }

    const outTurn: ConversationTurn = {
      role: 'assistant',
      speaker: settings.prompt.personaName,
      speakerId: this.deps.selfId(),
      text: reply,
      atMe: false,
      time: Date.now(),
    };
    session.turns.push(outTurn);
    this.emitFeed(outTurn, key, true);
  }

  /** 群内首条 @ 回提问者；私聊首条带引用。后续分片都不加，否则刷屏式引用 */
  private firstSegments(text: string, event: MessageEvent, normalized: NormalizedMessage, kind: 'group' | 'private'): MessageSegment[] {
    const segs: MessageSegment[] = [];
    if (kind === 'group') {
      segs.push({ type: 'at', data: { qq: String(event.user_id) } });
    } else if (normalized.replyToMessageId !== null) {
      segs.push({ type: 'reply', data: { id: String(normalized.replyToMessageId) } });
    }
    segs.push({ type: 'text', data: { text } });
    return segs;
  }

  private async send(
    target: { endpoint: 'group'; id: number } | { endpoint: 'private'; id: number },
    message: MessageSegment[],
  ): Promise<void> {
    const action = target.endpoint === 'group' ? 'send_group_msg' : 'send_private_msg';
    const base = target.endpoint === 'group' ? { group_id: target.id } : { user_id: target.id };
    try {
      await this.deps.call(action, { ...base, message });
    } catch (err) {
      // 部分协议端不接受 at/reply 段，降级纯文本重试，别让整条回复丢掉
      const plain = message.filter((s) => s.type === 'text');
      if (plain.length !== message.length) {
        this.deps.log('warn', `带段发送失败，降级纯文本：${String(err)}`);
        await this.deps.call(action, { ...base, message: plain });
        return;
      }
      throw err;
    }
  }

  /** 引用的原话要额外查询；取不到就留空——绝不能让模型编造被引用内容 */
  private async quotedText(event: MessageEvent, normalized: NormalizedMessage): Promise<string | null> {
    if (normalized.replyToMessageId === null) return null;
    try {
      const data = (await this.deps.call('get_msg', { message_id: normalized.replyToMessageId })) as
        | { message?: unknown }
        | undefined;
      const raw = data?.['message'];
      if (typeof raw === 'string') return raw;
      if (Array.isArray(raw)) {
        return normalizeMessage({ ...event, message: raw as MessageSegment[] }, this.deps.selfId()).text;
      }
      return null;
    } catch (err) {
      this.deps.log('warn', `取引用消息失败：${String(err)}`);
      return null;
    }
  }

  /** 群名每个群只拉一次；失败也不阻塞回复，模型失去的只是一个上下文字段 */
  private async groupName(session: Session, key: string): Promise<string | undefined> {
    if (session.groupName !== undefined) return session.groupName;
    const id = Number(key.slice('group:'.length));
    try {
      const data = (await this.deps.call('get_group_info', { group_id: id })) as { group_name?: string };
      const name = data.group_name?.trim() ?? '';
      if (name.length > 0) session.groupName = name;
      return name.length > 0 ? name : undefined;
    } catch (err) {
      this.deps.log('warn', `取群名失败：${String(err)}`);
      return undefined;
    }
  }
}
