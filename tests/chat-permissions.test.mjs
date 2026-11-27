import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ChatService } from '../chat-service.mjs';
import { MAX_AUTHORIZED_CONTACTS, canAuthorizeConversation, hasVerifiedConversationIdentity, hasStableConversationIdentity, isStoredContactAuthorized, matchesAuthorizedContact, upgradeAuthorizedContact } from '../contact-authorization.mjs';
import { groupMessageAddressesFish, normalizeMentionNames } from '../group-reply-trigger.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const verifiedAt = '2026-10-24T00:00:00.000Z';
const contact = (name, extra = {}) => ({ id: `conv:${hash(name)}`, name, displayName: name, followed: null, relationshipStatus: 'unavailable', identityVerified: true, identityVersion: 2, identityKind: extra.isGroup === true ? 'rendered-group' : 'rendered-user', identityHash: (extra.id || `conv:${hash(name)}`).slice(5), identityBinding: `binding:${hash(`${name}:头像与会话`)}`, isGroup: false, ...extra });
const stored = value => ({ ...value, verifiedAt, authorizationKind: value.isGroup === true ? 'existing-group' : value.followed === true ? 'following' : 'existing-conversation' });
const incoming = (id, text, extra = {}) => ({ id, text, sender: 'incoming', eligibleForReply: true, arrivalClassification: 'new-tail', ...extra });

function fixture(t, values = [contact('合成个人')]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chat-permissions-'));
  const contacts = structuredClone(values), messages = new Map(contacts.map(value => [value.id, [incoming('baseline-old', '旧消息里提到大肥鱼也不能补发')]]));
  const inputs = [], sent = [], reads = [];
  const browser = {
    async listContacts() { return { contacts: structuredClone(contacts) }; },
    async readConversation(id, { allowed, signal } = {}) {
      assert.equal(allowed, true); signal?.throwIfAborted(); reads.push(id);
      const current = contacts.find(value => value.id === id);
      return { conversation: { id, displayName: current?.name, isGroup: current?.isGroup }, contact: structuredClone(current), messages: structuredClone(messages.get(id) || []) };
    },
    async sendMessage(id, text, { allowed, signal } = {}) { assert.equal(allowed, true); signal?.throwIfAborted(); sent.push({ id, text }); return { confirmed: true, messageId: `synthetic-sent-${sent.length}` }; },
  };
  const agent = { replyTokens: 512, async reply(value) { inputs.push(value); return { text: '合成授权测试回复' }; } };
  const service = new ChatService({ browser, agent, config: { apiKey: 'synthetic-permissions-key', model: 'synthetic' }, stateDir: directory });
  t.after(async () => { await service.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-chat-permissions-/); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, contacts, messages, inputs, sent, reads, browser, agent, service };
}
async function start(f, extra = {}) { await f.service.configure({ recipientIds: f.contacts.map(value => value.id), allowConversationOnly: true, ...extra }); await f.service.start({ schedule: false }); }

test('许可通知优先检查对应会话，不被名单前面的无消息会话拖后', async t => {
  const f = fixture(t, [contact('合成排前会话'), contact('合成收到通知会话')]); await start(f);
  f.reads.length = 0; const target = f.contacts[1].id;
  f.messages.get(target).push(incoming('priority-new', '合成及时回复测试'));
  assert.equal(f.service.notifyIncoming(target), true);
  const deadline = Date.now() + 2000;
  while (!f.sent.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.sent.length, 1); assert.equal(f.reads[0], target); assert.equal(f.sent[0].id, target);
});

test('会话授权只接受稳定绑定、明确类型和可核对的昵称', () => {
  const personal = contact('合成核对个人'), group = contact('合成核对群', { isGroup: true });
  for (const value of [personal, group]) { assert.equal(hasVerifiedConversationIdentity(value), true); assert.equal(canAuthorizeConversation(value), true); assert.equal(isStoredContactAuthorized(stored(value)), true); }
  for (const extra of [{ id: 'unknown' }, { isGroup: null }, { isGroup: undefined }, { name: '', displayName: '' }, { identityVerified: false }, { identityBinding: null }]) {
    const value = { ...personal, ...extra }; assert.equal(hasVerifiedConversationIdentity(value), false); assert.equal(canAuthorizeConversation(value), false); assert.equal(isStoredContactAuthorized(stored(value)), false);
  }
  assert.equal(canAuthorizeConversation({ ...personal, relationshipStatus: 'not-followed' }), false);
  assert.equal(isStoredContactAuthorized({ ...stored(personal), verifiedAt: '不是日期' }), false);
  assert.equal(isStoredContactAuthorized({ ...stored(group), authorizationKind: 'following', followed: true }), false);
});

test('保存后的授权绑定检查会话、类型与身份指纹，显示名变化不改变许可', () => {
  for (const value of [contact('合成绑定个人'), contact('合成绑定群', { isGroup: true }), contact('合成已关注', { followed: true, relationshipStatus: 'confirmed' })]) {
    const saved = stored(value); assert.equal(matchesAuthorizedContact(saved, value), true); assert.equal(matchesAuthorizedContact(saved, { ...value, name: '新的显示名', displayName: '新的显示名' }), true);
    for (const extra of [{ id: `conv:${hash('别的会话')}` }, { isGroup: !value.isGroup }, { identityBinding: `binding:${hash('另一张头像')}` }, { identityVerified: false }]) assert.equal(matchesAuthorizedContact(saved, { ...value, ...extra }), false);
  }
});

test('v2许可依据稳定ID和类型，改昵称或头像仍匹配，同名异ID拒绝', () => {
  const value = contact('合成稳定许可', { identityVersion: 2, identityKind: 'rendered-user' }); value.identityHash = value.id.slice(5);
  const saved = stored(value), renamed = { ...value, name: '更新后的昵称', displayName: '更新后的昵称', avatar: '更新后的头像' };
  assert.equal(hasStableConversationIdentity(value), true); assert.equal(matchesAuthorizedContact(saved, renamed), true);
  for (const extra of [{ id: `conv:${hash('同名其他账号')}`, identityHash: hash('同名其他账号') }, { identityKind: 'rendered-group' }, { identityHash: hash('不一致') }, { identityVersion: 3 }, { identityBinding: `binding:${hash('其他绑定')}` }, { isGroup: true }]) assert.equal(matchesAuthorizedContact(saved, { ...value, ...extra }), false);
  for (const extra of [{ identityKind: undefined }, { identityHash: undefined }, { identityVersion: 3 }]) { assert.equal(canAuthorizeConversation({ ...value, ...extra }), false); assert.equal(isStoredContactAuthorized({ ...saved, ...extra }), false); }
});

test('旧已核对会话只按原不透明ID和类型升级，不按同名头像迁移或升级弱following', () => {
  for (const isGroup of [false, true]) {
    const old = stored(contact('合成旧许可', { isGroup, relationshipEvidence: { source: '本人核对' } })); delete old.identityVersion; delete old.identityKind; delete old.identityHash;
    const current = { ...old, name: '同账号的新昵称', displayName: '同账号的新昵称', identityVersion: 2, identityKind: isGroup ? 'rendered-group' : 'rendered-user', identityHash: old.id.slice(5), identityBinding: `binding:${hash('新稳定绑定')}` };
    assert.equal(matchesAuthorizedContact(old, current), true);
    const upgraded = upgradeAuthorizedContact(old, current); assert.equal(upgraded.name, current.name); assert.equal(upgraded.identityVersion, 2); assert.equal(upgraded.verifiedAt, old.verifiedAt); assert.equal(upgraded.authorizationKind, old.authorizationKind); assert.deepEqual(upgraded.relationshipEvidence, old.relationshipEvidence);
    assert.equal(upgradeAuthorizedContact(old, { ...current, id: `conv:${hash('同名其他会话')}`, identityHash: hash('同名其他会话') }), null);
    assert.equal(upgradeAuthorizedContact(old, { ...current, isGroup: !isGroup }), null);
    assert.equal(upgradeAuthorizedContact({ ...old, identityVerified: false }, current), null);
    assert.equal(upgradeAuthorizedContact({ ...old, followed: true, authorizationKind: 'following', isGroup: false }, { ...current, isGroup: false, followed: true }), null);
  }
});

test('网页未提供关注关系时，必须本人明确核对后才能保存个人会话', async t => {
  const f = fixture(t); const id = f.contacts[0].id;
  await assert.rejects(f.service.configure({ recipientIds: [id] }), /核对/);
  await assert.rejects(f.service.configure({ recipientIds: [id], allowConversationOnly: 'true' }), /明确勾选/);
  const result = await f.service.configure({ recipientIds: [id], allowConversationOnly: true });
  assert.equal(result.policy.allowlist[0].authorizationKind, 'existing-conversation');
  assert.equal(result.policy.allowlist[0].identityBinding, f.contacts[0].identityBinding);
  assert.equal(result.running, false); assert.equal(f.inputs.length, 0); assert.equal(f.reads.length, 0);
});

test('关注关系未查询的个人会话以稳定身份授权，核对前及身份丢失后拒绝保存', async t => {
  const f = fixture(t, [contact('合成未查询关注关系', { relationshipStatus: 'unverified' })]);
  const [current] = f.contacts;
  const { id } = current;
  assert.equal(canAuthorizeConversation(current), true);
  const list = await f.service.listContacts();
  assert.equal(list.contacts[0].manualAuthorizationEligible, true);
  assert.equal(list.contacts[0].followed, null);
  await assert.rejects(f.service.configure({ recipientIds: [id] }), /核对/);
  const saved = await f.service.configure({ recipientIds: [id], allowConversationOnly: true });
  assert.equal(saved.policy.allowlist[0].authorizationKind, 'existing-conversation');
  assert.equal(saved.policy.allowlist[0].followed, null);
  assert.equal(matchesAuthorizedContact(saved.policy.allowlist[0], current), true);
  assert.equal(matchesAuthorizedContact(saved.policy.allowlist[0], { ...current, identityBinding: `binding:${hash('合成不同绑定')}` }), false);
  assert.equal(canAuthorizeConversation({ ...current, followed: false }), false);
  await f.service.start({ schedule: false });
  assert.equal(f.service.state().contacts[0].status, 'ready');
  f.service.stop();
  const policy = fs.readFileSync(f.service.policyFile, 'utf8');
  for (const key of ['identityVersion', 'identityKind', 'identityHash']) delete current[key];
  assert.equal((await f.service.listContacts()).contacts[0].manualAuthorizationEligible, false);
  await assert.rejects(f.service.configure({ recipientIds: [id], allowConversationOnly: true }), /核对/);
  assert.equal(fs.readFileSync(f.service.policyFile, 'utf8'), policy);
  assert.deepEqual(f.sent, []);
});

test('群聊单独取得明确授权，群类型或身份未知的会话始终拒绝', async t => {
  const f = fixture(t, [contact('合成已关注群', { isGroup: true, followed: true })]);
  await assert.rejects(f.service.configure({ recipientIds: [f.contacts[0].id] }), /核对/);
  await f.service.configure({ recipientIds: [f.contacts[0].id], allowConversationOnly: true });
  assert.equal(f.service.state().policy.allowlist[0].authorizationKind, 'existing-group');
  const saved = fs.readFileSync(f.service.policyFile, 'utf8');
  f.contacts[0].isGroup = null;
  await assert.rejects(f.service.configure({ recipientIds: [f.contacts[0].id], allowConversationOnly: true }), /身份不明|核对|稳定身份字段不完整/);
  assert.equal(fs.readFileSync(f.service.policyFile, 'utf8'), saved);
});

test('许可名单超过50个会话仍可保存，重复会话不覆盖原许可', async t => {
  const f = fixture(t, Array.from({ length: 251 }, (_, i) => contact(`合成许可好友${i}`, { followed: true })));
  assert.equal(MAX_AUTHORIZED_CONTACTS, null);
  await f.service.configure({ recipientIds: f.contacts.map(value => value.id),dailyReplyLimit:1 });
  assert.equal(f.service.state().policy.allowlist.length, 251);assert.equal(f.service.state().policy.dailyReplyLimit,null);
  const saved = fs.readFileSync(f.service.policyFile, 'utf8');
  await assert.rejects(f.service.configure({ recipientIds: [f.contacts[0].id, f.contacts[0].id] }), /重复|不同/);
  assert.equal(fs.readFileSync(f.service.policyFile, 'utf8'), saved);
});

test('群昵称支持全角和零宽归一化，也接受已核实的@自己标记', () => {
  assert.deepEqual(normalizeMentionNames([' 大肥鱼 ', '@大肥鱼', 'ＦＩＳＨ', 'FI\u200bSH']), ['大肥鱼', 'FISH']);
  for (const text of ['大肥鱼你看这个', '@大肥鱼 看看', '你好ＦＩＳＨ', 'fi\u200bsh在吗']) assert.equal(groupMessageAddressesFish({ text }, ['大肥鱼', 'fish']), true);
  assert.equal(groupMessageAddressesFish({ text: '有人知道今天吃什么吗', mentionedSelf: true }), true);
  assert.equal(groupMessageAddressesFish({ text: '@其他人 看看', mentionedSelf: false }), false);
  for (const names of [[], ['@'], ['@@'], ['\n大肥鱼'], Array(11).fill('大肥鱼')]) assert.throws(() => normalizeMentionNames(names), /昵称|40|10|不能为空/);
});

test('群普通消息只更新水位，昵称或@触发才调用模型；重复轮询不重发', async t => {
  const f = fixture(t, [contact('合成讨论群', { isGroup: true })]); await start(f, { groupMentionNames: ['大肥鱼', '小鱼'] });
  const id = f.contacts[0].id; await f.service.poll(); assert.equal(f.inputs.length, 0);
  f.messages.get(id).push(incoming('ordinary', '大家今天吃什么')); await f.service.poll();
  assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.service.state().daily.requests, 0);
  f.messages.get(id).push(incoming('nickname', '小鱼，能帮忙看看吗')); await f.service.poll(); await f.service.poll();
  assert.equal(f.inputs.length, 1); assert.equal(f.sent.length, 1);
  f.messages.get(id).push(incoming('mention', '来看看这个', { mentionedSelf: true })); await f.service.poll(); await f.service.poll();
  assert.equal(f.inputs.length, 2); assert.equal(f.sent.length, 2); assert.equal(f.service.state().daily.requests, 2);
});

test('本人或其他成员普通发言、历史窗口中的昵称/@均不补发', async t => {
  const f = fixture(t, [contact('合成历史讨论群', { isGroup: true })]); await start(f); const id = f.contacts[0].id;
  f.messages.get(id).push(incoming('history-mention', '@大肥鱼 旧消息', { arrivalClassification: 'old-history', eligibleForReply: false, mentionedSelf: true }), incoming('history-window', '大肥鱼，旧窗口', { arrivalClassification: 'known-old-window', eligibleForReply: false }), incoming('ordinary-at-other', '@别人 帮我一下'), incoming('own-message', '大肥鱼，测试本人消息', { sender: 'outgoing' }));
  await f.service.poll(); assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.service.state().contacts[0].status, 'ready');
  f.service.stop(); f.messages.get(id).push(incoming('while-stopped', '大肥鱼，停用期间的消息'));
  await f.service.start({ schedule: false }); await f.service.poll(); assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0);
});

test('保存后绑定变化时启动拒绝，旧消息不建立成可回复任务', async t => {
  const f = fixture(t); await f.service.configure({ recipientIds: [f.contacts[0].id], allowConversationOnly: true });
  f.contacts[0].identityBinding = `binding:${hash('合成身份变动')}`;
  await assert.rejects(f.service.start({ schedule: false }), /身份|关系/); assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.reads.length, 0);
});

test('适配器只返回会话ID而没有完整联系人身份时拒绝启动', async t => {
  const f = fixture(t); await f.service.configure({ recipientIds: [f.contacts[0].id], allowConversationOnly: true });
  const original = f.browser.readConversation;
  f.browser.readConversation = async (...args) => { const value = await original(...args); delete value.contact; return value; };
  await assert.rejects(f.service.start({ schedule: false }), /身份|绑定/); assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0);
});

test('运行中绑定变化时暂停而不调用模型或发送', async t => {
  const f = fixture(t); await start(f); const id = f.contacts[0].id;
  f.contacts[0].identityBinding = `binding:${hash('合成运行中换身份')}`; f.messages.get(id).push(incoming('changed-person', '新的问题'));
  await f.service.poll(); assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.service.state().contacts[0].status, 'paused');
});

test('生成期间个人会话变为群聊时不发送，避免绕过群触发条件', async t => {
  const f = fixture(t); await start(f); const id = f.contacts[0].id;
  f.agent.reply = async value => { f.inputs.push(value); f.contacts[0].isGroup = true; return { text: '合成结果，不应发出' }; };
  f.messages.get(id).push(incoming('before-change', '你好')); await f.service.poll();
  assert.equal(f.inputs.length, 1); assert.equal(f.sent.length, 0); assert.equal(f.service.state().contacts[0].status, 'paused');
});

test('已生成回复但进入共同发送锁后绑定变动，最终核对仍拒绝发送', async t => {
  const f = fixture(t); await start(f); const id = f.contacts[0].id, original = f.browser.readConversation; let reads = 0;
  f.browser.readConversation = async (...args) => {
    const value = await original(...args);
    reads++;
    if (fs.existsSync(f.service.outbound.guardFile)) value.contact.identityBinding = `binding:${hash('合成最后发送关口身份变化')}`;
    return value;
  };
  f.messages.get(id).push(incoming('before-final-check', '需要回复的新问题')); await f.service.poll();
  assert.equal(reads, 2); assert.equal(f.inputs.length, 1); assert.equal(f.sent.length, 0); assert.equal(f.service.state().contacts[0].status, 'paused');
});
