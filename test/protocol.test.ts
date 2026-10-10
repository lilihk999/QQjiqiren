import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMessage,
  parseCqCode,
  replySegments,
  sessionKey,
  unescapeCq,
} from '../src/main/onebot/protocol.ts';
import type { GroupMessageEvent, PrivateMessageEvent } from '../src/main/onebot/types.ts';

function groupEvent(overrides: Partial<GroupMessageEvent> = {}): GroupMessageEvent {
  return {
    time: 1_700_000_000,
    self_id: 10001,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    group_id: 555,
    user_id: 20002,
    message_id: 9001,
    message_seq: 1,
    sender: { user_id: 20002, nickname: '阿明', card: '小明', role: 'member' },
    message: [{ type: 'text', data: { text: '你好' } }],
    raw_message: '你好',
    font: 0,
    ...overrides,
  };
}

test('CQ 码解析：文本与多种段混排', () => {
  const segs = parseCqCode('看看这个[CQ:image,file=abc.jpg]还有[CQ:at,qq=10001,name=机器人]结束');
  assert.deepEqual(segs.map((s) => s.type), ['text', 'image', 'text', 'at', 'text']);
  assert.equal(segs[0]?.data['text'], '看看这个');
  assert.equal(segs[1]?.data['file'], 'abc.jpg');
  assert.equal(segs[2]?.data['text'], '还有');
  assert.equal(segs[3]?.data['qq'], '10001');
  assert.equal(segs[4]?.data['text'], '结束');
});

test('CQ 码转义还原', () => {
  assert.equal(unescapeCq('a&#91;b&#93;c&#44;d&#38;e'), 'a[b]c,d&e');
  assert.equal(parseCqCode('含&#91;方括号&#93;的文本')[0]?.data['text'], '含[方括号]的文本');
});

test('被 @ 判定是响应闸门，qq 字段缺失不得误判为 @我', () => {
  const atMe = normalizeMessage(
    groupEvent({ message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 在吗' } }] }),
    10001,
  );
  assert.equal(atMe.atMe, true);
  assert.equal(atMe.text, '在吗');

  const brokenAt = normalizeMessage(groupEvent({ message: [{ type: 'at', data: {} }] }), 10001);
  assert.equal(brokenAt.atMe, false);

  const atAll = normalizeMessage(groupEvent({ message: [{ type: 'at', data: { qq: '0' } }] }), 10001);
  assert.equal(atAll.atAll, true);
});

test('reply 段解析出被引用消息 id，媒体不进正文', () => {
  const n = normalizeMessage(
    groupEvent({
      message: [
        { type: 'reply', data: { id: '8899' } },
        { type: 'text', data: { text: '这张图啥意思' } },
        { type: 'image', data: { file: 'x.png' } },
        { type: 'record', data: { file: 'y.amr' } },
      ],
    }),
    10001,
  );
  assert.equal(n.replyToMessageId, 8899);
  assert.equal(n.text, '这张图啥意思');
  assert.deepEqual(n.nonText.map((m) => m.type), ['image', 'record']);
});

test('message 数组为空时回落到 raw_message 解析', () => {
  const n = normalizeMessage(groupEvent({ message: [], raw_message: '[CQ:at,qq=10001]帮忙看下' }), 10001);
  assert.equal(n.atMe, true);
  assert.equal(n.text, '帮忙看下');
});

test('会话隔离：群按群、私聊按用户', () => {
  assert.equal(sessionKey(groupEvent()), 'group:555');
  const priv: PrivateMessageEvent = {
    time: 1,
    self_id: 10001,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    user_id: 777,
    message_id: 1,
    message_seq: 1,
    sender: { user_id: 777, nickname: '甲' },
    message: [],
    raw_message: '',
    font: 0,
  };
  assert.equal(sessionKey(priv), 'private:777');
});

test('引用段优先于文本段，保证回复带上下文', () => {
  const segs = replySegments('收到', 1234);
  assert.deepEqual(segs.map((s) => s.type), ['reply', 'text']);
  assert.equal(segs[0]?.data['id'], '1234');
  assert.equal(replySegments('收到', null).length, 1);
});
