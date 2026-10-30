import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserController, observeChatSharedWork } from '../core.mjs';

test('显式聊天观察不排在自己正在等待退出的观看队列后面', async () => {
  const controller = Object.create(BrowserController.prototype), queued = new Promise(() => {});
  controller.queue = queued;
  controller.getChatService = async () => ({ async observeMessage(recipientId, messageId) { return { recipientId, messageId }; } });
  const args = { recipientId: 'conv:' + 'a'.repeat(64), messageId: 'msg:' + 'b'.repeat(64) };
  const signal = AbortSignal.timeout(500);
  const result = await controller.execute('douyin_chat_observe', args, { signal });
  assert.deepEqual(result, args); assert.equal(controller.queue, queued);
});

function fixture() {
  const events = [], result = { frames: [], state: { video: { id: '12345' } } };
  let running = true;
  const inspector = { async execute(name) { events.push(name); return result; }, async close() { events.push('disconnect'); } };
  const watch = { state: () => ({ running }), async stop() { events.push('yield'); running = false; }, claimManual(kind) { events.push(kind); return async () => events.push('release'); }, async close() { events.push('reader-close'); } };
  return { events, inspector, watch, result, options: { url: 'https://www.douyin.com/video/12345', videoId: '12345', videoLimits: { state: () => ({ allowed: true }) }, createInspector: () => inspector, createWatch: () => watch } };
}

test('聊天作品采样先让自主观看退出，再持有手动锁采样并释放', async () => {
  const f = fixture();
  assert.equal(await observeChatSharedWork(f.options), f.result);
  assert.deepEqual(f.events, ['yield', 'chat-shared-video', 'douyin_open_video', 'douyin_play', 'douyin_observe', 'douyin_pause', 'disconnect', 'reader-close', 'release']);
});

test('时段或预算拒绝时不创建页面、不停止自主观看、不改原预算', async () => {
  const f = fixture();
  f.options.videoLimits.state = () => ({ allowed: false, reason: '合成每日预算已用完' });
  await assert.rejects(observeChatSharedWork(f.options), /每日预算/);
  assert.deepEqual(f.events, []);
});

test('链接与作品不符时不接触浏览器', async () => {
  const f = fixture();
  await assert.rejects(observeChatSharedWork({ ...f.options, url: 'https://example.invalid/video/12345' }), /公开地址/);
  assert.deepEqual(f.events, []);
});

test('打开前被占用不暂停其他视频，仍释放自己持有的锁', async () => {
  const f = fixture();
  f.inspector.execute = async name => { f.events.push(name); throw new Error('合成打开前被占用'); };
  await assert.rejects(observeChatSharedWork(f.options), /被占用/);
  assert.equal(f.events.includes('douyin_pause'), false);
  assert.equal(f.events.at(-1), 'release');
});

test('观察取消后正常暂停自己的作品并释放锁', async () => {
  const f = fixture(), abort = new AbortController();
  f.inspector.execute = async name => { f.events.push(name); if (name === 'douyin_observe') { abort.abort(new Error('合成取消')); throw abort.signal.reason; } };
  await assert.rejects(observeChatSharedWork({ ...f.options, signal: abort.signal }), /合成取消/);
  assert.equal(f.events.includes('douyin_pause'), true);
  assert.equal(f.events.at(-1), 'release');
});
