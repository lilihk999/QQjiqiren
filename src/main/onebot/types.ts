/** OneBot v11 实现端（NapCat / LLOneBot）与本协议存在字段差异，按可选处理 */

export type SegmentType =
  | 'text'
  | 'image'
  | 'record'
  | 'video'
  | 'at'
  | 'reply'
  | 'face'
  | 'location'
  | 'json'
  | 'xml'
  | 'poker';

export interface MessageSegment {
  type: string;
  data: Record<string, string | number>;
}

export interface GroupMessageEvent {
  time: number;
  self_id: number;
  post_type: 'message';
  message_type: 'group';
  sub_type: 'group' | 'normal';
  group_id: number;
  user_id: number;
  message_id: number;
  message_seq: number;
  sender: {
    user_id: number;
    nickname: string;
    card?: string;
    role: 'owner' | 'admin' | 'member';
    title?: string;
  };
  message: MessageSegment[];
  raw_message: string;
  font: number;
}

export interface PrivateMessageEvent {
  time: number;
  self_id: number;
  post_type: 'message';
  message_type: 'private';
  sub_type: 'friend' | 'group_tmp' | 'discuss_tmp' | 'other';
  user_id: number;
  group_id?: number;
  message_id: number;
  message_seq: number;
  sender: {
    user_id: number;
    nickname: string;
    card?: string;
    sex?: 'male' | 'female' | 'unknown';
    age?: number;
  };
  message: MessageSegment[];
  raw_message: string;
  font: number;
}

export type MessageEvent = GroupMessageEvent | PrivateMessageEvent;

export interface LifecycleEvent {
  time: number;
  self_id: number;
  post_type: 'meta_event';
  meta_event_type: 'lifecycle';
  /** NapCat 通常只发 connect；NoneBot adapter 会发 enable */
  meta_event_sub_type: 'connect' | 'enable' | 'disable' | 'hot_reload';
}

export interface HeartbeatEvent {
  time: number;
  self_id: number;
  post_type: 'meta_event';
  meta_event_type: 'heartbeat';
  status: {
    online: boolean;
    good: boolean;
  };
  interval: number;
}

export interface RequestEvent {
  time: number;
  self_id: number;
  post_type: 'request';
  request_type: 'friend' | 'group';
  user_id: number;
  group_id?: number;
  comment?: string;
  flag?: string;
}

export interface NoticeEvent {
  time: number;
  self_id: number;
  post_type: 'notice';
  notice_type: string;
  user_id?: number;
  group_id?: number;
}

export type OneBotEvent =
  | MessageEvent
  | LifecycleEvent
  | HeartbeatEvent
  | RequestEvent
  | NoticeEvent;

export interface OneBotResponse<T = unknown> {
  status: 'ok' | 'failed' | 'async';
  retcode: number;
  data: T;
  /** 部分实现端字段名为 message */
  message?: string;
  wording?: string;
}

export interface SendGroupMsgParams {
  group_id: number;
  message: MessageSegment[] | string;
  auto_escape?: boolean;
}

export interface SendPrivateMsgParams {
  user_id: number;
  message: MessageSegment[] | string;
  auto_escape?: boolean;
}

export interface GetGroupMemberInfoResult {
  user_id: number;
  nickname: string;
  card: string;
  title?: string;
  join_time?: number;
  role?: 'owner' | 'admin' | 'member';
}

export interface GetStatusResult {
  online: boolean;
  good: boolean;
  app_name?: string;
  app_version?: string;
  protocol_version?: string;
  self_id?: number;
}
