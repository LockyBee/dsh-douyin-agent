import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ChatService } from '../chat-service.mjs';
import { OutboundCoordinator } from '../outbound-send.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const stable = (key = '合成固定账号', extra = {}) => ({ id: `conv:${hash(key)}`, name: '合成初始昵称', displayName: '合成初始昵称', followed: null, isGroup: false, relationshipStatus: 'unavailable', identityVerified: true, identityBinding: `binding:${hash(`${key}:稳定绑定`)}`, identityVersion: 2, identityKind: 'rendered-user', identityHash: hash(key), ...extra });
const incoming = (id, text) => ({ id, text, sender: 'incoming', eligibleForReply: true, arrivalClassification: 'new-tail' });

function fixture(t, initial = stable(), { blockModel = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chat-stable-'));
  const contact = structuredClone(initial), messages = [incoming('old', '合成启动前消息')], sent = [], inputs = [], reads = [], entered = Promise.withResolvers();
  let calls = 0;
  const browser = {
    listContacts: async () => ({ contacts: [structuredClone(contact)] }),
    readConversation: async id => { reads.push(id); return { conversation: { id: contact.id, isGroup: contact.isGroup }, contact: structuredClone(contact), messages: structuredClone(messages) }; },
    sendMessage: async (id, text, { signal, expectedContact }) => { signal.throwIfAborted(); assert.equal(expectedContact.identityVersion, 2); sent.push({ id, text }); return { confirmed: true, messageId: `sent-${sent.length}` }; },
  };
  const agent = { reply: async value => { inputs.push(structuredClone(value.messages)); if (blockModel && ++calls === 1) { entered.resolve(); return new Promise((resolve, reject) => value.signal.addEventListener('abort', () => reject(value.signal.reason), { once: true })); } return { text: '合成稳定身份回复' }; } };
  const service = new ChatService({ browser, agent, config: { apiKey: 'synthetic-stable-key' }, stateDir: directory });
  t.after(async () => { await service.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-chat-stable-/); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, contact, messages, sent, inputs, reads, browser, service, entered, disk: () => JSON.parse(fs.readFileSync(service.policyFile, 'utf8')) };
}
async function configure(f) { return f.service.configure({ recipientIds: [f.contact.id], allowConversationOnly: true }); }
function seedLegacy(f) { fs.writeFileSync(f.service.policyFile, JSON.stringify({ version: 1, enabled: false, allowlist: [{ ...f.contact, verifiedAt: '2026-10-24T00:00:00.000Z', authorizationKind: f.contact.followed === true ? 'following' : f.contact.isGroup ? 'existing-group' : 'existing-conversation', relationshipEvidence: '合成历史核对记录' }], dailyReplyLimit: 40 })); }
async function start(f) { await configure(f); return f.service.start({ schedule: false }); }
function legacy(contact) { const value = structuredClone(contact); delete value.identityVersion; delete value.identityKind; delete value.identityHash; return value; }

test('新保存的个人、群聊和已关注许可保留完整稳定身份字段', async t => {
  for (const extra of [{}, { isGroup: true, identityKind: 'rendered-group' }, { followed: true, relationshipStatus: 'confirmed' }]) {
    const f = fixture(t, stable(`合成保存${JSON.stringify(extra)}`, extra)); const state = await configure(f), saved = state.policy.allowlist[0];
    for (const key of ['id', 'isGroup', 'identityVersion', 'identityKind', 'identityHash', 'identityBinding']) assert.equal(saved[key], f.contact[key]);
    assert.deepEqual(f.disk().allowlist, state.policy.allowlist); assert.equal(f.sent.length, 0); assert.equal(f.reads.length, 0);
  }
});

test('声明新身份却缺少字段、哈希不对应或版本未知时不能保存', async t => {
  for (const extra of [{ identityKind: undefined }, { identityHash: undefined }, { identityHash: hash('错误账号') }, { identityVersion: 3 }, { identityVersion: undefined }]) {
    const f = fixture(t, stable('合成不完整新身份', extra)); await assert.rejects(configure(f), /稳定身份|身份不明|核对/); assert.equal(f.disk().allowlist.length, 0);
  }
});

test('启动时同一稳定账号改昵称头像只刷新显示名，保持原许可与核对时间', async t => {
  const f = fixture(t); await configure(f); const before = f.disk().allowlist[0];
  f.contact.name = f.contact.displayName = '合成修改后的昵称'; f.contact.avatarRef = '合成新头像';
  await f.service.start({ schedule: false }); const saved = f.disk().allowlist[0];
  assert.equal(saved.name, f.contact.name); for (const key of ['id', 'isGroup', 'identityKind', 'identityHash', 'identityBinding', 'authorizationKind', 'verifiedAt', 'relationshipEvidence']) assert.equal(saved[key], before[key]);
  assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0);
});

test('运行中昵称头像变化按稳定身份继续处理真正新消息并刷新磁盘显示名', async t => {
  const f = fixture(t); await start(f); const before = f.disk().allowlist[0];
  f.contact.name = f.contact.displayName = '合成运行中改名'; f.contact.avatarRef = '合成另一个头像'; f.messages.push(incoming('new', '合成改名后新消息'));
  await f.service.poll(); await f.service.poll(); assert.equal(f.sent.length, 1); assert.equal(f.inputs.length, 1); assert.equal(f.disk().allowlist[0].name, f.contact.name); assert.equal(f.disk().allowlist[0].verifiedAt, before.verifiedAt);
});

test('旧版已明确许可的同一会话个人和群聊可升级，保持原授权范围与审计', async t => {
  for (const extra of [{}, { isGroup: true, identityKind: 'rendered-group' }]) {
    const value = stable(`合成旧版迁移${extra.isGroup}`, extra), f = fixture(t, legacy(value)); seedLegacy(f); const before = f.disk().allowlist[0]; Object.assign(f.contact, value, { name: '合成迁移后昵称' });
    await f.service.start({ schedule: false }); const after = f.disk().allowlist[0]; assert.equal(after.identityVersion, 2); assert.equal(after.identityHash, value.identityHash); assert.equal(after.identityBinding, value.identityBinding); assert.equal(after.id, before.id); assert.equal(after.isGroup, before.isGroup); assert.equal(after.verifiedAt, before.verifiedAt); assert.equal(after.relationshipEvidence, before.relationshipEvidence);
  }
});

test('旧版following许可不能因当前同名同ID返回新身份而自动升级', async t => {
  const value = stable('合成旧关注账号', { followed: true, relationshipStatus: 'confirmed' }), f = fixture(t, legacy(value)); seedLegacy(f); Object.assign(f.contact, value);
  await assert.rejects(f.service.start({ schedule: false }), /旧关注名单不能自动迁移/); assert.equal(f.reads.length, 0); assert.equal(f.disk().allowlist[0].identityVersion, undefined); assert.equal(f.sent.length, 0);
});

test('历史许可没有当前完整稳定身份时也不能按旧昵称绑定运行', async t => {
  for (const extra of [{}, { followed: true, relationshipStatus: 'confirmed' }]) {
    const f = fixture(t, legacy(stable('合成旧适配器', extra))); seedLegacy(f); await assert.rejects(f.service.start({ schedule: false }), /稳定身份/); assert.equal(f.reads.length, 0); assert.equal(f.sent.length, 0);
  }
});

test('稳定类型、会话或绑定变化拒绝启动，当前版本缺失也不能回退到旧身份', async t => {
  for (const mutate of [value => { value.id = `conv:${hash('合成其他会话')}`; value.identityHash = value.id.slice(5); }, value => { value.isGroup = true; }, value => { value.identityKind = 'native-conversation'; }, value => { value.identityBinding = `binding:${hash('合成其他绑定')}`; }, value => { delete value.identityVersion; delete value.identityKind; delete value.identityHash; }]) {
    const f = fixture(t); await configure(f); mutate(f.contact); await assert.rejects(f.service.start({ schedule: false }), /身份|关系/); assert.equal(f.sent.length, 0); assert.equal(f.inputs.length, 0);
  }
});

test('列表核对后正文会话稳定身份再变化仍拒绝启动，不能提前写入升级', async t => {
  const value = stable(), f = fixture(t, legacy(value)); seedLegacy(f); Object.assign(f.contact, value);
  const read = f.browser.readConversation; f.browser.readConversation = async (...args) => { const snapshot = await read(...args); snapshot.contact.identityBinding = `binding:${hash('合成正文换绑')}`; return snapshot; };
  await assert.rejects(f.service.start({ schedule: false }), /身份|绑定/); assert.equal(f.disk().allowlist[0].identityVersion, undefined); assert.equal(f.sent.length, 0);
});

test('刷新显示名期间名单被撤销时不重加联系人、不调用模型或发送', async t => {
  const f = fixture(t); await start(f); f.contact.name = '合成另一个显示名'; f.messages.push(incoming('new', '合成撤销许可竞态'));
  fs.writeFileSync(f.service.policyFile, JSON.stringify({ ...f.disk(), allowlist: [] })); await f.service.poll();
  assert.equal(f.disk().allowlist.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.inputs.length, 0);
});

test('旧身份维护待答不能借升级恢复，只保留自动队列并处理后续可靠新消息', async t => {
  const f = fixture(t, stable(), { blockModel: true }); await start(f); f.messages.push(incoming('known-new', '合成旧身份已合格消息'));
  const polling = f.service.poll(); await f.entered.promise; f.service.stop({ preservePending: true, reason: 'settings-update' }); await polling;
  const policy = f.disk(); policy.allowlist = policy.allowlist.map(legacy); fs.writeFileSync(f.service.policyFile, JSON.stringify(policy)); const marks = JSON.parse(fs.readFileSync(f.service.watermarkFile, 'utf8')); marks.contacts[f.contact.id].pending.recoveryEvidence.contact = legacy(marks.contacts[f.contact.id].pending.recoveryEvidence.contact); fs.writeFileSync(f.service.watermarkFile, JSON.stringify(marks)); f.messages.at(-1).eligibleForReply = false;
  await f.service.start({ schedule: false }); await f.service.poll(); assert.equal(f.sent.length, 0); assert.equal(f.service.state().recovery.autoPendingCount,1); assert.equal(f.service.state().recovery.recoverableCount, 0);
  f.messages.push(incoming('later-new', '合成新身份后续新消息')); await f.service.poll(); assert.equal(f.sent.length, 1);
});

test('运行中的旧身份发送等待队列升级后也只能等待可靠补答证据', async t => {
  const f = fixture(t); await start(f); f.service.outbound = new OutboundCoordinator({ stateDir: f.directory, waitMs: 20 });
  const guard = path.join(f.directory, 'outbound-send.guard'); fs.writeFileSync(guard, JSON.stringify({ pid: process.pid, token: '合成忙锁' })); f.messages.push(incoming('waiting', '合成旧身份待发'));
  await f.service.poll(); assert.equal(f.service.state().contacts[0].pending.phase, 'outbound-wait'); fs.unlinkSync(guard);
  f.service.policy.allowlist = f.service.policy.allowlist.map(legacy); fs.writeFileSync(f.service.policyFile, JSON.stringify(f.service.policy)); f.service.watermarks.contacts[f.contact.id].pending.recoveryEvidence.contact = legacy(f.service.watermarks.contacts[f.contact.id].pending.recoveryEvidence.contact); f.service.persist();
  await f.service.poll(); assert.equal(f.sent.length, 0); assert.equal(f.inputs.length, 1); assert.equal(f.service.state().recovery.autoPendingCount,1); assert.equal(f.disk().allowlist[0].identityVersion, 2);
});
