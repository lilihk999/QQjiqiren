import type {
  GroupMessageEvent,
  MessageEvent,
  MessageSegment,
  OneBotEvent,
  PrivateMessageEvent,
} from './types.ts';

/** CQ 码转义表：& # ; 与方括号在 raw_message 中是被转义的 */
const CQ_UNESCAPE: ReadonlyArray<readonly [string, string]> = [
  ['&#44;', ','],
  ['&#91;', '['],
  ['&#93;', ']'],
  ['&#38;', '&'],
  ['&amp;', '&'],
  ['&#58;', ':'],
  ['&#47;', '/'],
  ['&#92;', '\\'],
];

export function unescapeCq(input: string): string {
  let out = input;
  for (const [from, to] of CQ_UNESCAPE) out = out.split(from).join(to);
  return out;
}

/**
 * 把 raw_message 还原成消息段。实现端一般直接给 message 数组，
 * 但 NapCat 在某些转发/合并转发场景只给 raw_message，必须能兜底解析。
 */
export function parseCqCode(raw: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^=,\[\]]+=[^,\[\]]*)*)\]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const pushText = (chunk: string): void => {
    const text = unescapeCq(chunk);
    if (text.length > 0) segments.push({ type: 'text', data: { text } });
  };

  while ((match = re.exec(raw)) !== null) {
    pushText(raw.slice(cursor, match.index));
    const type = match[1] as string;
    const data: Record<string, string> = {};
    const pairs = (match[2] ?? '').replace(/^,/, '');
    if (pairs.length > 0) {
      for (const pair of pairs.split(',')) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        data[pair.slice(0, eq)] = unescapeCq(pair.slice(eq + 1));
      }
    }
    segments.push({ type, data });
    cursor = match.index + match[0].length;
  }
  pushText(raw.slice(cursor));
  return segments;
}

export function isMessageEvent(event: OneBotEvent): event is MessageEvent {
  return event.post_type === 'message';
}

export function isGroupMessage(event: MessageEvent): event is GroupMessageEvent {
  return event.message_type === 'group';
}

export function isPrivateMessage(event: MessageEvent): event is PrivateMessageEvent {
  return event.message_type === 'private';
}

export interface NonTextSegment {
  type: string;
  hint: string;
}

export interface NormalizedMessage {
  /** 已剔除 @ 与媒体占位的纯文本 */
  text: string;
  /** 原始文本，保留 @ 的可读形式 */
  textWithMentions: string;
  atMe: boolean;
  atAll: boolean;
  mentionedUserIds: number[];
  replyToMessageId: number | null;
  nonText: NonTextSegment[];
}

function describeNonText(type: string, data: Record<string, string | number>): NonTextSegment {
  switch (type) {
    case 'image':
      return { type, hint: `[图片 file=${String(data['file'] ?? '')}]` };
    case 'record':
      return { type, hint: `[语音 file=${String(data['file'] ?? '')}]` };
    case 'video':
      return { type, hint: `[视频 file=${String(data['file'] ?? '')}]` };
    case 'location':
      return { type, hint: '[位置消息]' };
    case 'json':
      return { type, hint: '[卡片 JSON 消息]' };
    case 'xml':
      return { type, hint: '[卡片 XML 消息]' };
    case 'face':
      return { type, hint: `[表情 id=${String(data['id'] ?? '')}]` };
    default:
      return { type, hint: `[${type} 消息]` };
  }
}

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 归一化一条消息。selfId 用于判断是否被 @，这是"是否调用模型"的第一道闸门，
 * 因此 at 段的 qq 字段缺失时必须保守地当作不是 @ 我。
 */
export function normalizeMessage(event: MessageEvent, selfId: number): NormalizedMessage {
  const segments =
    Array.isArray(event.message) && event.message.length > 0
      ? event.message
      : parseCqCode(event.raw_message ?? '');

  const parts: string[] = [];
  const mentionParts: string[] = [];
  const nonText: NonTextSegment[] = [];
  const mentionedUserIds: number[] = [];
  let atMe = false;
  let atAll = false;
  let replyToMessageId: number | null = null;

  for (const seg of segments) {
    const data = seg.data ?? {};
    switch (seg.type) {
      case 'text': {
        const t = String(data['text'] ?? '');
        parts.push(t);
        mentionParts.push(t);
        break;
      }
      case 'at': {
        const qq = toNumber(data['qq'] as string | number | undefined);
        if (qq === null) break;
        if (qq === 0) {
          atAll = true;
          mentionParts.push('@全体成员');
        } else {
          mentionedUserIds.push(qq);
          if (qq === selfId) atMe = true;
          mentionParts.push(`@[${data['name'] ?? '用户'}:${qq}]`);
        }
        break;
      }
      case 'reply': {
        replyToMessageId = toNumber(data['id'] as string | number | undefined);
        break;
      }
      default:
        nonText.push(describeNonText(seg.type, data));
    }
  }

  return {
    text: parts.join('').trim(),
    textWithMentions: mentionParts.join('').trim(),
    atMe,
    atAll,
    mentionedUserIds,
    replyToMessageId,
    nonText,
  };
}

/** 私聊按用户隔离，群聊按群隔离——群内多人同时插话时共享上下文是符合 QQ 直觉的 */
export function sessionKey(event: MessageEvent): string {
  return event.message_type === 'group'
    ? `group:${event.group_id}`
    : `private:${event.user_id}`;
}

export function replyTarget(
  event: MessageEvent,
): { endpoint: 'group'; id: number } | { endpoint: 'private'; id: number } {
  if (event.message_type === 'group') return { endpoint: 'group', id: event.group_id };
  return { endpoint: 'private', id: event.user_id };
}

export function textSegments(text: string): MessageSegment[] {
  return [{ type: 'text', data: { text } }];
}

/** 回复引用段：QQ 里带上下文的机器人体验明显更好，但引用失败会整体失败，需降级 */
export function replySegments(text: string, messageId: number | null): MessageSegment[] {
  const segs: MessageSegment[] = [];
  if (messageId !== null) segs.push({ type: 'reply', data: { id: String(messageId) } });
  segs.push({ type: 'text', data: { text } });
  return segs;
}
