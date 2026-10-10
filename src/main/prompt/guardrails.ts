import type { NormalizedMessage } from '../onebot/protocol.ts';
import type { ConversationKind, PromptSettings } from '../../shared/types.ts';
import type { MessageEvent } from '../onebot/types.ts';

/**
 * 零宽字符与控制字符常被用来绕过关键词检测（如"忽​略上文"），先规整再判定。
 */
const INVISIBLE = /[\u200B-\u200F\u2028\u2029\u2060\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

const INJECTION_PATTERNS: readonly RegExp[] = [
  /忽略(之前|上面|以上|所有)(的)?(指令|规则|设定|提示)/,
  /无视(之前|上面|以上)(的)?(指令|规则|设定)/,
  /(扮演|假装|现在你是|从现在起你是|你可以是任何)/,
  /系统(提示词|prompt)|system\s*prompt/i,
  /(输出|打印|复述|重复|告诉我)(你的|完整|全部).{0,6}(指令|提示|设定)/,
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+(a|an|in|free)/i,
  /(开发者|developer|debug)\s*模式\s*激活/i,
  /jailbreak|dan\s*mode/i,
];

export interface SanitizedInput {
  text: string;
  truncated: boolean;
  /** 命中注入特征时，装配层会把这条标注为"不可信内容"而不是丢弃，避免破坏正常转述场景 */
  suspicious: boolean;
  matchedPatterns: number;
}

export function sanitizeIncoming(raw: string, settings: PromptSettings): SanitizedInput {
  const cleaned = raw.replace(INVISIBLE, '').replace(/\r/g, '');
  const truncated = cleaned.length > settings.maxInputChars;
  const text = truncated ? cleaned.slice(0, settings.maxInputChars) : cleaned;
  let matched = 0;
  for (const re of INJECTION_PATTERNS) if (re.test(text)) matched += 1;
  return { text, truncated, suspicious: matched > 0, matchedPatterns: matched };
}

export interface RespondDecision {
  respond: boolean;
  reason: string;
}

/** 是否值得为这条消息花一次模型调用，是最直接的 token 费控闸门 */
export function decideRespond(
  event: MessageEvent,
  normalized: NormalizedMessage,
  kind: ConversationKind,
  settings: PromptSettings,
  selfId: number,
): RespondDecision {
  if (event.user_id === selfId) return { respond: false, reason: '自己发的消息' };
  if (normalized.text.length === 0 && normalized.nonText.length === 0) {
    return { respond: false, reason: '空消息' };
  }

  if (kind === 'private') return { respond: true, reason: '私聊默认响应' };

  if (normalized.atAll && normalized.mentionedUserIds.length === 0 && !normalized.atMe) {
    // @全体 通常是广播行为，不应触发模型
    return { respond: false, reason: '@全体 不响应' };
  }
  if (normalized.atMe) return { respond: true, reason: '被 @' };

  const triggered = settings.triggerWords.find((w) => w.trim().length > 0 && normalized.text.includes(w.trim()));
  if (triggered !== undefined) return { respond: true, reason: `命中触发词「${triggered}」` };

  if (settings.requireAtInGroup) return { respond: false, reason: '群内需 @ 才响应' };
  return { respond: true, reason: '群内自由响应' };
}

/** 去掉模型可能残留的 Markdown 痕迹；QQ 会把它们原样显示成噪音 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, ''))
    .replace(/^[ \t]*[-*+][ \t]/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}[ \t]/gm, '')
    .replace(/^>[ \t]?/gm, '');
}

export function postProcessReply(text: string, settings: PromptSettings): string {
  const stripped = stripMarkdown(sanitizeOutboundLeaks(text));
  const collapsed = stripped.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return collapsed.length > settings.maxOutputChars
    ? collapsed.slice(0, settings.maxOutputChars - 1) + '…'
    : collapsed;
}

/** 兜底防泄漏：即便模型不听话，也不把密钥/本地路径/网关地址发进群 */
function sanitizeOutboundLeaks(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[已隐藏密钥]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/g, '[已隐藏令牌]')
    .replace(/[A-Z]:\\Users\\[^\s，。]+/gi, '[已隐藏本地路径]')
    .replace(/(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):\d+[^\s，。]*/gi, '[已隐藏网关地址]');
}

/**
 * QQ 单条消息有长度上限，且长消息折叠影响阅读。按段落→句子优先级切分，
 * 保证每段都不超过 chunkSize，同时不把单词或 surrogate 表情从中间截断。
 */
export function chunkForSend(text: string, chunkSize: number): string[] {
  if (text.length === 0) return [];
  const limit = Math.max(chunkSize, 20);
  const out: string[] = [];
  let buffer = '';

  const flush = (): void => {
    if (buffer.trim().length > 0) out.push(buffer.trim());
    buffer = '';
  };

  for (const para of text.split(/\n{1,}/)) {
    const pieces = para.length <= limit ? [para] : splitLong(para, limit);
    for (const piece of pieces) {
      if (buffer.length > 0 && buffer.length + piece.length + 1 > limit) flush();
      buffer = buffer.length === 0 ? piece : `${buffer}\n${piece}`;
      if (buffer.length >= limit) flush();
    }
  }
  flush();
  return out;
}

function splitLong(paragraph: string, limit: number): string[] {
  const sentences = paragraph.match(/[^。！？?!\n]+[。！？?!\n]?/g) ?? [paragraph];
  const out: string[] = [];
  let current = '';
  for (const s of sentences) {
    // 单句本身就超长时，先冲掉缓冲再按码点硬切，保证每个产物都不越过 limit
    if (s.length > limit) {
      if (current.length > 0) {
        out.push(current);
        current = '';
      }
      out.push(...hardCut(s, limit));
      continue;
    }
    if (current.length + s.length > limit) {
      out.push(current);
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

/** 按码点累积而非按 length 切片，避免劈开代理对，且每段 UTF-16 长度不超过 limit */
function hardCut(s: string, limit: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of s) {
    if (current.length + ch.length > limit) {
      out.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** 同一会话的调用冷却，防止与群内其他机器人互相触发形成死循环 */
export function withinCooldown(lastCallMs: number, nowMs: number, cooldownMs: number): boolean {
  return nowMs - lastCallMs < cooldownMs;
}
