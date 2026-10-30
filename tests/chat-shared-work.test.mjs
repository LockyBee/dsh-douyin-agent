import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatService } from '../chat-service.mjs';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPEkAAAAASUVORK5CYII=';
const videoId = '1234567890123456789';
const memberId = `member:${'4'.repeat(64)}`;
const card = (id = 'shared') => ({ id, sender: 'incoming', memberId, text: '', eligibleForReply: true, kind: 'video', media: { type: 'shared-work', videoId, url: `https://www.douyin.com/video/${videoId}`, title: '合成分享作品' } });
const text = (id, value, extra = {}) => ({ id, sender: 'incoming', memberId, text: value, eligibleForReply: true, ...extra });
const sample = () => ({ state: { video: { id: videoId, time: 5, paused: false } }, observation: { videoId, beforeTime: 2, afterTime: 5, beforePaused: false, paused: false, seconds: 3 }, frames: [2, 3.5, 5].map(time => ({ mimeType: 'image/png', data: pixel, videoId, time })) });

function fixture(t, { group = false, allowed = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-shared-work-test-'));
  const contact = { id: `conv:${'1'.repeat(64)}`, name: '合成许可会话', isGroup: group, followed: !group, identityVerified: true, identityBinding: `binding:${'2'.repeat(64)}`, identityVersion: 2, identityKind: group ? 'rendered-group' : 'rendered-user', identityHash: '1'.repeat(64) };
  const messages = [], sent = [], requests = [], actions = [], captures = [];
  fs.writeFileSync(path.join(directory, 'chat-policy.json'), JSON.stringify({ version: 1, enabled: false, allowlist: [{ ...contact, authorizationKind: group ? 'existing-group' : 'following', verifiedAt: new Date().toISOString() }], dailyReplyLimit: null }));
  const browser = {
    listContacts: async () => ({ contacts: [structuredClone(contact)] }),
    readConversation: async () => ({ contact: structuredClone(contact), conversation: { id: contact.id, isGroup: group }, messages: structuredClone(messages) }),
    sendMessage: async (id, value) => { sent.push(value); return { confirmed: true, messageId: `sent-${sent.length}` }; },
    captureMessage: async (id, messageId) => { captures.push(messageId); return { messageId, frames: [{ mimeType: 'image/png', data: pixel }], media: { type: 'shared-work' }, understandingScope: 'card-cover-and-dom-metadata' }; },
    openSharedVideo: async () => ({ opened: false, videoId, url: `https://www.douyin.com/video/${videoId}`, source: 'rendered-message-item-id' }),
  };
  const inspector = { limits: () => ({ state: () => ({ allowed, reason: '合成观看时段外' }) }), execute: async (name) => { actions.push(name); return name === 'douyin_observe' ? sample() : {}; }, pauseForLimits: async () => { actions.push('pauseForLimits'); } };
  const service = new ChatService({ browser, videoLimits: inspector.limits(), config: { apiKey: 'synthetic-test-key' }, agent: { reply: async request => { requests.push(structuredClone({ messages: request.messages, mediaObservations: request.mediaObservations })); return { text: '合成回复' }; } }, stateDir: directory });
  service.videoInspector = async () => inspector;
  t.after(async () => { await service.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-shared-work-test-/); fs.rmSync(directory, { force: true, recursive: true }); });
  return { service, contact, messages, sent, requests, actions, captures, browser, inspector };
}
async function start(f) { await f.service.configure({ recipientIds: [f.contact.id], allowConversationOnly: f.contact.isGroup }); await f.service.start({ schedule: false }); }

test('分享作品通过本机协调观察器采样，并要求真实作品身份、帧和时间推进', async t => {
  const f = fixture(t); f.messages.push(card()); let calls = 0;
  f.service.videoInspector = async () => assert.fail('已绑定共享用量与协调观察器，不应额外创建控制器');
  f.service.observeSharedWork = async value => { calls++; assert.equal(value.videoId, videoId); assert.equal(value.url, `https://www.douyin.com/video/${videoId}`); return sample(); };
  const result = await f.service.observeMessage(f.contact.id, 'shared');
  assert.equal(calls, 1); assert.equal(result.understandingScope, 'card-cover-and-three-second-video-sampling'); assert.equal(result.frames.length, 4); assert.deepEqual(f.actions, []);
});

test('只有封面、暂停画面、身份不符或没有推进时不能声称已经看过视频', async t => {
  for (const mutate of [value => value.frames = [], value => value.state.video.id = '999', value => value.observation.beforePaused = true, value => value.observation.afterTime = 2, value => value.frames.forEach(frame => frame.time = 2), value => value.frames.forEach(frame => frame.time += 100), value => value.frameProof = { issuer: 'dafeiyu-shared-video-capture-v1', version: 1 }]) {
    const f = fixture(t); f.messages.push(card()); f.service.observeSharedWork = async () => { const value = sample(); mutate(value); return value; };
    const result = await f.service.observeMessage(f.contact.id, 'shared');
    assert.notEqual(result.understandingScope, 'card-cover-and-three-second-video-sampling'); assert.equal(result.frames.length, 1); assert.match(result.note, /未完成|未确认/); assert.deepEqual(f.actions, []);
  }
});

test('自主观看占用时不能因为打开分享失败而暂停原观看进程', async t => {
  const f = fixture(t); f.messages.push(card()); f.inspector.execute = async name => { f.actions.push(name); throw Object.assign(new Error('合成自主观看正在运行'), { status: 409 }); };
  const result = await f.service.observeMessage(f.contact.id, 'shared');
  assert.match(result.note, /作品观察未完成/); assert.deepEqual(f.actions, ['douyin_open_video']);
});

test('默认观察路径先播放、再核对三秒采样，最终只暂停已成功打开的作品', async t => {
  const f = fixture(t); f.messages.push(card()); const result = await f.service.observeMessage(f.contact.id, 'shared');
  assert.equal(result.understandingScope, 'card-cover-and-three-second-video-sampling'); assert.deepEqual(f.actions, ['douyin_open_video', 'douyin_play', 'douyin_observe', 'douyin_pause']);
});

test('观看时段不允许时保留卡片解释，不调用观察器或改变预算', async t => {
  const f = fixture(t, { allowed: false }); f.messages.push(card()); f.service.observeSharedWork = async () => assert.fail('不应绕过原视频时段');
  const result = await f.service.observeMessage(f.contact.id, 'shared'); assert.equal(result.frames.length, 1); assert.match(result.note, /未播放作品/); assert.deepEqual(f.actions, []);
});

test('许可群先分享再由同一成员艾特时会理解最近卡片，单独分享仍不回复', async t => {
  const f = fixture(t, { group: true }); await start(f); f.messages.push(card()); await f.service.poll(); assert.equal(f.requests.length, 0); assert.deepEqual(f.captures, []);
  f.messages.push(text('ask', '大肥鱼，看看刚才的视频')); await f.service.poll(); await f.service.poll();
  assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 1); assert.deepEqual(f.captures, ['shared']); assert.equal(f.requests[0].mediaObservations[0].messageId, 'shared'); assert.ok(f.requests[0].messages.some(message => message.id === 'shared'));
});

test('群里其他成员艾特、没有可靠成员身份或已经回复后的旧卡片不自动关联', async t => {
  for (const extra of [{ memberId: `member:${'5'.repeat(64)}` }, { memberId: null }, { replied: true }]) {
    const f = fixture(t, { group: true }); await start(f); f.messages.push(card()); await f.service.poll();
    if (extra.replied) { f.messages.push({ id: 'manual-outgoing', sender: 'outgoing', text: '合成已回复' }); await f.service.poll(); }
    f.messages.push(text('ask', extra.memberId ? '大肥鱼，想看视频吗' : '大肥鱼，看看刚才的视频', extra)); await f.service.poll(); assert.equal(f.requests.length, 1); assert.deepEqual(f.captures, []);
  }
});

test('群里问候不会读取旧分享；卡片回读内容变化时不采集旧作品', async t => {
  for (const changed of [false, true]) {
    const f = fixture(t, { group: true }); await start(f); f.messages.push(card()); await f.service.poll();
    if (changed) f.messages[0].media.videoId = '999';
    f.messages.push(text('ask', changed ? '大肥鱼，看一下刚才的作品' : '大肥鱼，晚上好')); await f.service.poll(); assert.equal(f.requests.length, 1); assert.deepEqual(f.captures, []);
  }
});

test('重启前的最近卡片只有新的明确提问才进入本轮上下文，不获得旧消息回复资格', async t => {
  for (const group of [false, true]) {
    const f = fixture(t, { group }); f.messages.push(card()); await start(f);
    assert.equal(f.requests.length, 0); assert.deepEqual(f.captures, []);
    f.messages.push(text('new-after-restart', '大肥鱼，看一下上面的视频')); await f.service.poll(); await f.service.poll();
    assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 1); assert.deepEqual(f.captures, ['shared']); assert.equal(f.requests[0].mediaObservations[0].messageId, 'shared');
    assert.deepEqual(f.requests[0].messages.map(message => message.id), ['shared', 'new-after-restart']);
    assert.equal(f.service.watermarks.contacts[f.contact.id].context.some(message => message.id === 'shared'), false, '只添加本轮临时参考，不把旧卡片改成新消息');
  }
});

test('重启前卡片不能因其他成员泛问、普通问候或较远的旧历史进入模型', async t => {
  for (const options of [{ foreign: true }, { greeting: true }, { distant: true }]) {
    const f = fixture(t, { group: true }); f.messages.push(card());
    if (options.distant) for (let i = 0; i < 8; i++) f.messages.push(text(`old-${i}`, '合成旧聊天'));
    await start(f); f.messages.push(text('ask', options.greeting ? '大肥鱼，今天怎么样' : options.foreign ? '大肥鱼，你喜欢什么视频' : '大肥鱼，看一下上面的视频', options.foreign ? { memberId: `member:${'9'.repeat(64)}` } : {}));
    await f.service.poll(); assert.equal(f.requests.length, 1); assert.deepEqual(f.captures, []); assert.equal(f.requests[0].messages.some(message => message.id === 'shared'), false);
  }
});

test('同一许可群甲分享、乙明确艾特引用上面的视频时可观察，各成员身份仍分别保留', async t => {
  const f = fixture(t, { group: true }); f.messages.push({ ...card(), memberName: '合成分享者甲' }); await start(f);
  f.messages.push(text('ask-other', '大肥鱼，看看上面别人发的视频', { memberId: `member:${'9'.repeat(64)}`, memberName: '合成提问者乙' }));
  await f.service.poll(); await f.service.poll(); assert.equal(f.requests.length, 1); assert.equal(f.sent.length, 1); assert.deepEqual(f.captures, ['shared']);
  const context = f.requests[0].messages; assert.equal(context.find(message => message.id === 'shared').memberId, memberId); assert.equal(context.find(message => message.id === 'ask-other').memberId, `member:${'9'.repeat(64)}`); assert.equal(context.find(message => message.id === 'shared').memberName, '合成分享者甲'); assert.equal(context.find(message => message.id === 'ask-other').memberName, '合成提问者乙');
});

test('许可群泛聊喜好或观看历史，即使同成员也不主动读取最近分享', async t => {
  for (const member of [memberId, `member:${'9'.repeat(64)}`]) {
    const f = fixture(t, { group: true }); await start(f); f.messages.push(card()); await f.service.poll();
    f.messages.push(text('ask-generic', '大肥鱼，你喜欢什么视频、看过什么作品', { memberId: member })); await f.service.poll(); assert.equal(f.requests.length, 1); assert.deepEqual(f.captures, []);
  }
});
