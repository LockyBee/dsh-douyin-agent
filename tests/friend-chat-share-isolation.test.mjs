import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FriendInteractions } from '../friend-interactions.mjs';
import { ChatService } from '../chat-service.mjs';
import { AutonomousShare } from '../autonomous-share.mjs';
import { interactionPresence } from '../interaction-status.mjs';

const config = { apiKey: 'synthetic-local-only', baseUrl: 'https://api.deepseek.com', model: 'synthetic-model' };
const direct = { id: `conv:${'1'.repeat(64)}`, name: '合成许可好友', followed: true, isGroup: false, identityVerified: true, identityBinding: `binding:${'2'.repeat(64)}`, identityVersion: 2, identityKind: 'rendered-user', identityHash: '1'.repeat(64) };
const group = { id: `conv:${'3'.repeat(64)}`, name: '合成许可群', followed: null, isGroup: true, identityVerified: true, identityBinding: `binding:${'4'.repeat(64)}`, identityVersion: 2, identityKind: 'rendered-group', identityHash: '3'.repeat(64) };
const incoming = (id, text, extra = {}) => ({ id, text, sender: 'incoming', eligibleForReply: true, ...extra });
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

async function fixture(t, { enabled = true, recovery = false, isGroup = false } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chat-share-isolation-'));
  const contact = structuredClone(isGroup ? group : direct), rows = [incoming('old-baseline', '启动前的合成旧消息')], calls = { share: 0, model: 0, videoLimits: 0, prepares: 0, sent: [] };
  let current = structuredClone(contact), listed = true;
  const browser = {
    listContacts: async () => ({ contacts: listed ? [structuredClone(current)] : [] }),
    prepareChat: async () => { calls.prepares++; return { prepared: true, count: 1 }; },
    readConversation: async (id, controls) => { assert.equal(id, contact.id); assert.equal(controls.allowed, true); controls.signal?.throwIfAborted(); return { conversation: { id }, contact: structuredClone(current), messages: structuredClone(rows) }; },
    sendMessage: async (id, text, controls) => { assert.equal(id, contact.id); assert.equal(controls.allowed, true); controls.signal?.throwIfAborted(); calls.sent.push({ id, text }); return { confirmed: true, messageId: `synthetic-reply-${calls.sent.length}` }; },
  };
  const agent = { replyTokens: 512, reply: async () => { calls.model++; return { text: '合成测试回复' }; } };
  const createChat = () => new ChatService({ browser, agent, config, stateDir });
  const initial = createChat();
  await initial.configure({ recipientIds: [contact.id], allowConversationOnly: isGroup, groupMentionNames: ['大肥鱼'] });
  await initial.start({ schedule: false });
  const originalAllowlist = structuredClone(initial.state().policy.allowlist);
  await initial.close();
  const chat = createChat();
  const share = new AutonomousShare({ stateDir, personaMemory: { snapshot: () => ({ recentObservations: [] }) }, videoLimits: { state: () => { calls.videoLimits++; throw new Error('普通聊天不应读取视频预算。'); } }, send: async () => { calls.share++; throw new Error('未确认分享不得重发。'); } });
  write(share.files.policy, { version: 1, enabled, dailyLimit: null });
  const date = share.state().daily.date;
  write(share.files.ledger, { version: 1, days: { [date]: 1 }, operations: [{ operationId: 'synthetic-uncertain-operation', recipientId: contact.id, videoId: '1234567890123456789', evidenceId: `video:${'5'.repeat(64)}`, day: date, source: 'api', pid: process.pid, status: 'uncertain', startedAt: new Date().toISOString(), forwardOperationId: 'synthetic-forward-operation' }] });
  if (recovery) write(share.files.send, { pid: 2147483647, token: 'synthetic-dead-owner', operationId: 'synthetic-uncertain-operation' });
  const protectedFiles = [share.files.policy, share.files.ledger, ...(recovery ? [share.files.send] : [])], original = new Map(protectedFiles.map(file => [file, fs.readFileSync(file)]));
  const coordinators = [];
  const createCoordinator = () => { const coordinator = new FriendInteractions({ stateDir, getChat: () => chat, getShare: () => share, modelReady: () => true, startChat: (service, { signal }) => service.start({ schedule: false, signal }) }); coordinators.push(coordinator); return coordinator; };
  const unchanged = () => { for (const [file, bytes] of original) assert.deepEqual(fs.readFileSync(file), bytes, path.basename(file)); assert.deepEqual(chat.state().policy.allowlist, originalAllowlist); assert.equal(calls.share, 0); assert.equal(calls.videoLimits, 0); assert.equal(share.state().paused, true); assert.equal(share.state().enabled, enabled); assert.equal(share.state().daily.attempts, 1); assert.equal(share.state().recoveryRequired, recovery); };
  t.after(async () => { for (const coordinator of coordinators) await coordinator.close(); await chat.close(); await share.close(); assert.equal(path.dirname(path.resolve(stateDir)), path.resolve(os.tmpdir())); assert.match(path.basename(stateDir), /^douyin-chat-share-isolation-/); fs.rmSync(stateDir, { recursive: true, force: true }); });
  return { stateDir, contact, rows, calls, browser, agent, chat, share, createCoordinator, unchanged, originalAllowlist, setCurrent: value => { current = value; }, setListed: value => { listed = value; } };
}

for (const enabled of [true, false]) for (const recovery of [false, true]) test(`真实服务重开：分享开关${enabled}、恢复锁${recovery}时许可新私信仍只回复一次，分享零重发`, async t => {
  const f = await fixture(t, { enabled, recovery }), coordinator = f.createCoordinator();
  const state = await coordinator.reconcile();
  assert.equal(state.status, 'running'); assert.equal(f.chat.state().running, true);
  const presence = interactionPresence({ chat: f.chat.state(), share: f.share.state(), friend: state, modelReady: true });
  assert.equal(presence.reply.online, true); assert.equal(presence.review.shareReviewCount, 1); assert.match(presence.review.reason, /分享送达未确认/);
  f.rows.push(incoming('new-after-restart', '合成重开后的新消息'));
  await f.chat.poll(); await f.chat.poll();
  assert.equal(f.calls.model, 1); assert.equal(f.calls.sent.length, 1); assert.equal(f.chat.state().daily.requests, 1);
  const reply = f.chat.outbound.history(f.contact.id).filter(item => item.kind === 'reply'); assert.equal(reply.length, 1); assert.equal(reply[0].messageId, 'synthetic-reply-1');
  f.unchanged();
  await assert.rejects(f.share.share({ recipientId: f.contact.id, videoId: '1234567890123456789', evidenceId: `video:${'5'.repeat(64)}` }), enabled ? /未确认/ : /尚未启用/);
  f.unchanged();
  await coordinator.close(); await f.chat.close();
  const again = new ChatService({ browser: f.browser, agent: f.agent, config, stateDir: f.stateDir });
  const next = new FriendInteractions({ stateDir: f.stateDir, getChat: () => again, getShare: () => f.share, modelReady: () => true, startChat: (service, { signal }) => service.start({ schedule: false, signal }) });
  try { assert.equal((await next.reconcile()).status, 'running'); await again.poll(); assert.equal(f.calls.sent.length, 1); assert.equal(again.state().daily.requests, 1); assert.deepEqual(again.state().policy.allowlist, f.originalAllowlist); f.unchanged(); }
  finally { await next.close(); await again.close(); }
});

test('显式准备回复通道也可跨过分享 uncertain，但不重新启用或重发分享', async t => {
  const f = await fixture(t, { enabled: false }), coordinator = f.createCoordinator();
  assert.equal((await coordinator.prepareChat()).status, 'running'); assert.equal(f.calls.prepares, 1);
  f.rows.push(incoming('new-after-prepare', '合成准备后的新问题')); await f.chat.poll(); await f.chat.poll();
  assert.equal(f.calls.sent.length, 1); f.unchanged();
});

test('读取分享状态后才出现 uncertain 时不跨功能阻断，仍由原服务拒绝启用分享', async t => {
  const f = await fixture(t, { enabled: false }), originalLedger = fs.readFileSync(f.share.files.ledger);
  write(f.share.files.ledger, { version: 1, days: {}, operations: [] });
  const configure = f.share.configure.bind(f.share); let attempts = 0;
  f.share.configure = (...args) => { attempts++; fs.writeFileSync(f.share.files.ledger, originalLedger); return configure(...args); };
  assert.equal((await f.createCoordinator().reconcile()).status, 'running'); assert.equal(attempts, 1);
  f.rows.push(incoming('race-new', '合成并发后新消息')); await f.chat.poll(); await f.chat.poll();
  assert.equal(f.calls.sent.length, 1); f.unchanged();
});

test('没有分享恢复状态的其他配置错误继续报错，不吞掉损坏或未知故障', async t => {
  const f = await fixture(t, { enabled: false }); write(f.share.files.ledger, { version: 1, days: {}, operations: [] });
  f.share.configure = () => { throw new Error('合成其他配置故障'); };
  const state = await f.createCoordinator().reconcile(); assert.equal(state.status, 'blocked'); assert.match(state.lastError, /合成其他配置故障/); assert.equal(f.chat.state().running, false); assert.equal(f.calls.sent.length, 0); assert.equal(f.calls.model, 0);
});

test('分享暂停不扩展名单，原许可群普通发言不答，昵称和被@各答一次', async t => {
  const f = await fixture(t, { isGroup: true }), coordinator = f.createCoordinator();
  assert.equal((await coordinator.reconcile()).status, 'running');
  f.rows.push(incoming('ordinary', '合成群里普通闲聊')); await f.chat.poll(); assert.equal(f.calls.sent.length, 0); assert.equal(f.calls.model, 0);
  f.rows.push(incoming('nickname', '大肥鱼，今天好吗')); await f.chat.poll(); await f.chat.poll(); assert.equal(f.calls.sent.length, 1);
  f.rows.push(incoming('mention', '来看看这个', { mentionedSelf: true })); await f.chat.poll(); await f.chat.poll(); assert.equal(f.calls.sent.length, 2); assert.equal(f.calls.model, 2);
  assert.equal(f.chat.notifyIncoming(`conv:${'9'.repeat(64)}`), false); f.unchanged();
});

test('真实稳定身份不符仍阻止重启，分享暂停不能绕过聊天身份核对', async t => {
  const f = await fixture(t), coordinator = f.createCoordinator(); f.setCurrent({ ...f.contact, identityBinding: `binding:${'8'.repeat(64)}` });
  const state = await coordinator.reconcile(); assert.equal(state.replyRunning, false); assert.equal(state.status, 'waiting'); assert.ok(state.waitReason);
  assert.equal(f.calls.model, 0); assert.equal(f.calls.sent.length, 0); f.unchanged();
});

test('已有会话身份待核对只保留自动核对，不向错误会话输入', async t => {
  const f = await fixture(t), mark = f.chat.watermarks.contacts[f.contact.id]; mark.identityReviewRequired = true; mark.status = 'paused'; f.chat.persist();
  f.setCurrent({ ...f.contact, identityBinding: `binding:${'8'.repeat(64)}` }); const state = await f.createCoordinator().reconcile();
  assert.equal(state.replyRunning, false); assert.equal(f.calls.model, 0); assert.equal(f.calls.sent.length, 0); assert.equal(f.chat.watermarks.contacts[f.contact.id].identityReviewRequired, true); f.unchanged();
});

test('聊天自身 inflight 和 delivery-uncertain 原始门禁仍保留，不因分享隔离而启动', async t => {
  for (const status of ['inflight', 'delivery-uncertain']) {
    const f = await fixture(t), original = f.chat.state.bind(f.chat); f.chat.state = () => ({ ...original(), contacts: [{ id: f.contact.id, status }] });
    const state = await f.createCoordinator().reconcile(); assert.equal(state.replyRunning, false); assert.equal(state.status, 'blocked'); assert.match(state.lastError, /未确认/); assert.equal(f.calls.model, 0); assert.equal(f.calls.sent.length, 0); f.unchanged();
  }
});

test('设置维护锁仍阻止聊天启动，不删除其他入口的锁或分享收据', async t => {
  const f = await fixture(t), coordinator = f.createCoordinator(); fs.writeFileSync(coordinator.settingsGuard, 'synthetic-maintenance-owner');
  const state = await coordinator.reconcile(); assert.equal(state.status, 'waiting-settings'); assert.equal(f.chat.state().running, false); assert.equal(fs.readFileSync(coordinator.settingsGuard, 'utf8'), 'synthetic-maintenance-owner'); assert.equal(f.calls.sent.length, 0); f.unchanged();
});

test('总开关关闭时仍不启动聊天，分享 uncertain 不能使原总开关失效', async t => {
  const f = await fixture(t, { enabled: false }), coordinator = f.createCoordinator(); write(coordinator.policyFile, { version: 1, enabled: false });
  const state = await coordinator.reconcile(); assert.equal(state.status, 'disabled'); assert.equal(state.enabled, false); assert.equal(f.chat.state().running, false); assert.equal(f.calls.sent.length, 0); f.unchanged();
});

test('准备时遇登录或验证码仍立即返回，不因分享隔离继续模型或发送', async t => {
  for (const property of ['loginRequired', 'verificationRequired']) {
    const f = await fixture(t), coordinator = f.createCoordinator(); f.browser.prepareChat = async () => ({ [property]: true });
    await assert.rejects(coordinator.prepareChat(), /登录或验证/); assert.equal(f.chat.state().running, false); assert.equal(f.calls.model, 0); assert.equal(f.calls.sent.length, 0); f.unchanged();
  }
});
