import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatAgent } from '../chat-agent.mjs';
import { ChatService } from '../chat-service.mjs';

const contact = id => ({ id, name: `合成联系人${id}`, followed: true, isGroup: false });
const incoming = (id, text) => ({ id, text, sender: 'incoming', eligibleForReply: true });
const config = { apiKey: '', model: 'synthetic-native-model' };
function fixture(t, replyProvider) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-native-reply-')), contacts = [contact('synthetic-one'), contact('synthetic-two')], sent = [], reads = [];
  const conversations = Object.fromEntries(contacts.map(item => [item.id, [incoming(`old-${item.id}`, `OLD_BASELINE_${item.id}`)]]));
  const browser = { controller: { source: 'dsh-chat' }, listContacts: async () => ({ contacts }), readConversation: async (id, { allowed }) => { assert.equal(allowed, true); assert.ok(conversations[id]); reads.push(id); return { conversation: { id }, messages: structuredClone(conversations[id]) }; }, sendMessage: async (id, text, { allowed, signal }) => { signal.throwIfAborted(); assert.equal(allowed, true); sent.push({ id, text }); return { confirmed: true, messageId: `sent-${sent.length}` }; }, close: async () => {} };
  const agent = new ChatAgent({ config, replyProvider, fetchImpl: async () => assert.fail('原生提供器不能走外部API请求'), personaMemory: { snapshot: () => ({ manualText: '合成手编人格：简洁。', personaText: 'PRIVATE_AUTO_PERSONA', interests: [{ topic: 'PRIVATE_INTEREST' }], recentObservations: [{ title: 'PRIVATE_VIDEO' }] }) } });
  const service = new ChatService({ config, agent, browser, stateDir });
  t.after(async () => { await service.close(); assert.equal(path.dirname(path.resolve(stateDir)), path.resolve(os.tmpdir())); assert.match(path.basename(stateDir), /^douyin-native-reply-/); fs.rmSync(stateDir, { recursive: true, force: true }); });
  return { stateDir, contacts, sent, reads, conversations, browser, agent, service };
}

test('原生回复提供器可在无APIKey时启动，旧消息只建基线且只把当前联系人新消息交给模型', async t => {
  const requests = [], f = fixture(t, async request => { requests.push(request); return { text: '收到合成新消息。', usage: { promptTokens: 5, completionTokens: 4 } }; });
  await f.service.configure({ recipientIds: f.contacts.map(item => item.id) }); const started = await f.service.start({ schedule: false }); assert.equal(started.running, true);
  await f.service.poll(); assert.equal(requests.length, 0); assert.equal(f.sent.length, 0);
  f.conversations['synthetic-one'].push(incoming('new-one', 'NEW_ONLY_ONE')); f.conversations['synthetic-two'].push(incoming('new-two', 'NEW_ONLY_TWO')); await f.service.poll(); await f.service.poll();
  assert.equal(requests.length, 2); assert.equal(f.sent.length, 2);
  for (let index = 0; index < requests.length; index++) { const request = requests[index]; assert.equal(request.maxTokens, 512); assert.equal(typeof request.signal.throwIfAborted, 'function'); assert.match(request.system, /合成手编人格：简洁/); assert.doesNotMatch(JSON.stringify(request), /PRIVATE_AUTO_PERSONA|PRIVATE_INTEREST|PRIVATE_VIDEO|OLD_BASELINE/); assert.deepEqual(request.messages, [{ role: 'user', content: index === 0 ? 'NEW_ONLY_ONE' : 'NEW_ONLY_TWO' }]); }
  assert.deepEqual(f.sent, [{ id: 'synthetic-one', text: '[自动回复] 收到合成新消息。' }, { id: 'synthetic-two', text: '[自动回复] 收到合成新消息。' }]);
});

test('提供器复用普通回复校验与标记，无密钥不会把空字符串误判为凭据', async () => {
  const messages = [incoming('new', '合成新消息')];
  const agent = new ChatAgent({ config, replyTokens: 64, replyProvider: async ({ maxTokens }) => { assert.equal(maxTokens, 64); return { text: ' [自动回复] 合成回复 ', usage: { prompt_tokens: 2, completion_tokens: 1 } }; }, fetchImpl: async () => assert.fail('不能请求API') });
  assert.deepEqual(await agent.reply({ messages }), { text: '[自动回复] 合成回复', usage: { promptTokens: 2, completionTokens: 1 } });
  for (const result of [{ text: '' }, { text: '鱼'.repeat(991) }, { text: '我是用户本人' }, { text: '我会帮你转账。' }, { text: '合成回复', tool_calls: [{}] }, { text: '合成回复', toolCalls: [{}] }]) await assert.rejects(new ChatAgent({ config, replyProvider: async () => result }).reply({ messages }));
  await assert.rejects(new ChatAgent({ config: { apiKey: 'synthetic-secret' }, replyProvider: async () => ({ text: 'synthetic-secret' }) }).reply({ messages }), /凭据/);
});

test('提供器忽略signal时仍有有限超时，不会等待迟到文本或调用API兜底', async () => {
  const late = Promise.withResolvers(); let calls = 0;
  const agent = new ChatAgent({ config, timeoutMs: 20, replyProvider: async () => { calls++; return late.promise; }, fetchImpl: async () => assert.fail('超时不能调用API兜底') });
  await assert.rejects(agent.reply({ messages: [incoming('new', '合成消息')] }), /超时/); assert.equal(calls, 1); late.resolve({ text: '迟到的合成回复' });
});

test('停止原生回复在提供器忽略取消时也立即结束poll，迟到结果不发送且待答保留', { timeout: 2500 }, async t => {
  const entered = Promise.withResolvers(), late = Promise.withResolvers(); const f = fixture(t, async () => { entered.resolve(); return late.promise; });
  await f.service.configure({ recipientIds: ['synthetic-one'] }); await f.service.start({ schedule: false }); f.conversations['synthetic-one'].push(incoming('new-one', '需要保留的合成待答'));
  const polling = f.service.poll(); await entered.promise; f.service.stop(); await polling;
  assert.equal(f.sent.length, 0); assert.equal(f.service.state().running, false); assert.equal(f.service.state().contacts[0].pending.phase, 'stopped-before-send'); assert.equal(f.service.state().contacts[0].pending.incoming[0].text, '需要保留的合成待答');
  late.resolve({ text: '不应发送的迟到回复' }); await Promise.resolve(); assert.equal(f.sent.length, 0);
});

test('回复提供器只能由本机函数设置，运行、启动及忙碌时不能更换', async t => {
  const f = fixture(t); await f.service.configure({ recipientIds: ['synthetic-one'] }); await assert.rejects(f.service.start({ schedule: false }), /API Key/);
  const provider = async () => ({ text: '合成回复' });
  assert.throws(() => f.service.setReplyProvider({ text: '不能注入JSON' }), /本机函数/); assert.throws(() => new ChatAgent({ config, replyProvider: true }), /本机函数/);
  f.service.setReplyProvider(provider); assert.equal(f.agent.replyProvider, provider); await f.service.start({ schedule: false }); assert.throws(() => f.service.setReplyProvider(undefined), /先停止/); f.service.stop();
  for (const key of ['starting', 'busy']) { f.service[key] = true; assert.throws(() => f.service.setReplyProvider(provider), /先停止/); f.service[key] = null; }
  f.service.setReplyProvider(undefined); assert.equal(f.agent.replyProvider, undefined); await assert.rejects(f.service.start({ schedule: false }), /API Key/);
});

test('提供器仍只接受当前incoming与所属媒体，预先取消时根本不调用提供器', async () => {
  let calls = 0; const agent = new ChatAgent({ config, replyProvider: async () => { calls++; return { text: '合成回复' }; } });
  await assert.rejects(agent.reply({ messages: [{ id: 'out', sender: 'outgoing', text: '合成旧回复' }] }), /新收到/);
  await assert.rejects(agent.reply({ messages: [incoming('one', '合成消息')], mediaObservations: [{ messageId: 'another', frames: [] }] }), /不属于/);
  const abort = new AbortController(); abort.abort(new Error('合成预先取消')); await assert.rejects(agent.reply({ messages: [incoming('one', '合成消息')], signal: abort.signal }), /合成预先取消/); assert.equal(calls, 0);
});
