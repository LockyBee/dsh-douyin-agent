import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatService } from '../chat-service.mjs';
import { MessageIdentityTracker } from '../message-tracker.mjs';
import { messageFingerprint, messageWatermark, compareMessageWatermark } from '../chat-message.mjs';
import { OutboundCoordinator } from '../outbound-send.mjs';

const row = (id, text = id, sender = 'incoming', extra = {}) => ({ id, text, sender, direction: sender, kind: 'text', latestEndVerified: true, eligibleForReply: false, arrivalClassification: 'known-old-window', ...extra });
const evidence = { chronology: 'oldest-first', latestEndVerified: true };
const old = row('old'), middle = row('middle'), target = row('target', '大肥鱼你好', 'incoming', { eligibleForReply: true, arrivalClassification: 'new-tail' });
const baseline = [old, middle, target];

test('共享水位允许确证旧前缀补载、移除和重编号，保持完整原尾后缀', () => {
  const expected = messageWatermark(baseline, evidence);
  for (const current of [baseline, [middle, target], [target], [row('older', '历史'), ...baseline], [row('rotating-old-1'), row('rotating-old-2'), middle, target]]) assert.equal(compareMessageWatermark(expected, current, evidence).matches, true);
  assert.deepEqual(expected.content, baseline.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) })));
});

test('共享水位拒绝新尾、人工发出、未知方向、撤回、改内容、内部缺口和重复ID', () => {
  const expected = messageWatermark(baseline, evidence);
  const cases = [[], [old, middle], [...baseline, row('new-tail', '新话', 'incoming', { eligibleForReply: true, arrivalClassification: 'new-tail' })], [...baseline, row('human', '人工已回复', 'outgoing')], [old, { ...middle, sender: 'unknown', direction: 'unknown' }, target], [old, { ...middle, direction: 'outgoing' }, target], [old, target], [middle, old, target], [old, { ...middle, text: '改写' }, target], [old, middle, { ...target, kind: 'recalled' }], [old, middle, target, target]];
  for (const current of cases) assert.equal(compareMessageWatermark(expected, current, evidence).matches, false);
});

test('历史兼容缺最新端、次序、旧分类或原始资格证据时拒绝', () => {
  const expected = messageWatermark(baseline, evidence), prefix = row('prefix');
  for (const classification of ['new-tail', 'ambiguous-new', 'baseline', undefined]) assert.equal(compareMessageWatermark(expected, [{ ...prefix, arrivalClassification: classification }, ...baseline], evidence).matches, false);
  assert.equal(compareMessageWatermark(expected, [{ ...prefix, eligibleForReply: true }, ...baseline], evidence).matches, false);
  assert.equal(compareMessageWatermark({ ...expected, chronology: 'unknown' }, [prefix, ...baseline], evidence).matches, false);
  assert.equal(compareMessageWatermark({ ...expected, latestEndVerified: false }, [prefix, ...baseline], evidence).matches, false);
  assert.equal(compareMessageWatermark(expected, [prefix, ...baseline], { chronology: 'unknown' }).matches, false);
  assert.equal(compareMessageWatermark(expected, [prefix, ...baseline], { ...evidence, latestEndVerified: false }).matches, false);
  assert.equal(compareMessageWatermark(expected, [prefix, ...baseline.map(item => ({ ...item, latestEndVerified: false }))], evidence).matches, false);
  assert.equal(compareMessageWatermark({ ...expected, content: [expected.content[0], expected.content[0]] }, baseline, evidence).matches, false);
});

function fixture(t, { phase = 'model', mutation = 'history' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-group-history-proposal-'));
  const contact = { id: 'conv:' + '4'.repeat(64), name: '合成许可群', isGroup: true, followed: null, identityVersion: 2, identityKind: 'rendered-conversation', identityHash: '4'.repeat(64), identityBinding: 'binding:' + '5'.repeat(64), identityVerified: true };
  const tracker = new MessageIdentityTracker(), sent = [], inputs = []; let stage = 'baseline', afterModelReads = 0, service;
  const browser = { listContacts: async () => ({ contacts: [contact] }), readConversation: async () => {
    const change = inputs.length > 0 && (phase === 'model' || phase === 'delivery' && ++afterModelReads >= 2 || phase === 'wait' && stage === 'full');
    let texts = stage === 'baseline' ? ['历史乙', '历史丙'] : change && mutation === 'history' ? ['更早的历史甲', '历史乙', '历史丙', '大肥鱼现在能回话吗'] : ['历史乙', '历史丙', '大肥鱼现在能回话吗'];
    const rows = texts.map((text, order) => ({ text, kind: 'text', sender: 'incoming', direction: 'incoming', order, orderMode: 'relative', latestEndVerified: true }));
    if (change && mutation === 'new-tail') rows.push({ ...rows.at(-1), text: '新追加问题', order: rows.length });
    if (change && mutation === 'outgoing') rows.push({ ...rows.at(-1), text: '本人已处理', sender: 'outgoing', direction: 'outgoing', order: rows.length });
    if (change && mutation === 'unknown') rows.at(-1).sender = rows.at(-1).direction = 'unknown';
    if (change && mutation === 'edited') rows.at(-1).text = '待答原文已经被改写';
    if (change && mutation === 'withdrawn') rows.pop();
    const messages = tracker.identify(contact.id, rows);
    return { conversation: { id: contact.id, isGroup: true }, contact: { ...contact, ...(change && mutation === 'identity' ? { identityBinding: 'binding:' + '6'.repeat(64) } : {}) }, messages, dayEvidence: { ...evidence }, chronology: 'oldest-first' };
  }, sendMessage: async (id, text, options) => { options.signal.throwIfAborted(); options.authorize({ recipientId: id, phase: 'prepare' }); sent.push({ id, text, evidence: options.expectedMessageEvidence }); return { confirmed: true, messageId: 'synthetic-outgoing-' + sent.length }; } };
  const agent = { replyTokens: 512, reply: async input => { inputs.push({ ...input, messages: structuredClone(input.messages) }); if (mutation === 'cancel') service.stop(); if (mutation === 'permission') { const policy = JSON.parse(fs.readFileSync(service.policyFile)); policy.enabled = false; fs.writeFileSync(service.policyFile, JSON.stringify(policy)); } return { text: '小鱼听见啦。' }; } };
  service = new ChatService({ browser, agent, stateDir: directory, config: { apiKey: 'synthetic-key', baseUrl: 'https://synthetic.invalid', model: 'synthetic' } });
  t.after(async () => { await service.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-group-history-proposal-/); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, contact, browser, service, inputs, sent, setStage: value => { stage = value; }, start: async () => { await service.configure({ recipientIds: [contact.id], allowConversationOnly: true, groupMentionNames: ['大肥鱼'] }); await service.start({ schedule: false }); stage = 'short'; } };
}

test('许可群模型后补载可信旧历史前缀只生成并回复一次', async t => {
  const f = fixture(t); await f.start();
  for (let i = 0; i < 3; i++) { f.setStage('short'); await f.service.poll(); }
  assert.equal(f.inputs.length, 1); assert.equal(f.sent.length, 1); assert.equal(f.service.state().contacts[0].pending, null);
  assert.deepEqual(f.inputs[0].messages.map(item => item.text), ['大肥鱼现在能回话吗']);
  assert.deepEqual(f.sent[0].evidence, { chronology: 'oldest-first', latestEndVerified: true });
});

test('最终 outbound 核对时才补载旧前缀仍复用一次生成结果', async t => {
  const f = fixture(t, { phase: 'delivery' }); await f.start(); await f.service.poll();
  assert.equal(f.inputs.length, 1); assert.equal(f.sent.length, 1);
});

test('共同发送锁等待后仅旧前缀变化不重新生成模型', async t => {
  const f = fixture(t, { phase: 'wait' }); await f.start(); f.service.outbound = new OutboundCoordinator({ stateDir: f.directory, waitMs: 15 });
  const guard = path.join(f.directory, 'outbound-send.guard'); fs.writeFileSync(guard, JSON.stringify({ pid: process.pid, token: 'synthetic-history-lock' }));
  await f.service.poll(); assert.equal(f.sent.length, 0); assert.equal(f.inputs.length, 1); assert.equal(f.service.state().contacts[0].pending.phase, 'outbound-wait');
  fs.unlinkSync(guard); f.setStage('full'); await f.service.poll(); await f.service.poll(); assert.equal(f.sent.length, 1); assert.equal(f.inputs.length, 1);
});

for (const mutation of ['new-tail', 'outgoing', 'unknown', 'edited', 'withdrawn', 'identity', 'permission', 'cancel']) test(`模型后${mutation}仍不得发送旧回复`, async t => {
  const f = fixture(t, { mutation }); await f.start(); await f.service.poll(); assert.equal(f.sent.length, 0); assert.equal(f.inputs.length, 1);
});

for (const mutation of ['new-tail', 'outgoing', 'unknown', 'edited', 'withdrawn', 'identity']) test(`最终outbound核对时${mutation}仍不得发送旧回复`, async t => {
  const f = fixture(t, { phase: 'delivery', mutation }); await f.start(); await f.service.poll(); assert.equal(f.sent.length, 0); assert.equal(f.inputs.length, 1);
});

test('未叫到响应昵称的群消息不因历史兼容取得回复资格', async t => {
  const f = fixture(t); await f.start();
  const read = f.browser.readConversation; f.browser.readConversation = async () => { const value = await read(); value.messages.at(-1).text = '只跟其他群友说话'; return value; };
  await f.service.poll(); assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0);
});
