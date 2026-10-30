import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatService } from '../chat-service.mjs';
import { FriendInteractions } from '../friend-interactions.mjs';

const contact = {
  id: `conv:${'a'.repeat(64)}`, name: '合成联合测试好友', followed: true, isGroup: false,
  identityVersion: 2, identityKind: 'rendered-user', identityHash: 'a'.repeat(64),
  identityVerified: true, identityBinding: `binding:${'b'.repeat(64)}`,
  verifiedAt: '2026-10-26T00:00:00.000Z', authorizationKind: 'following',
};
const record = (id, at) => ({ phase: 'unqualified', incoming: [{ id, text: `合成联合内容 ${id}`, sender: 'incoming' }], at, skippedAt: at, archiveId: `archive-${id}`, archiveKey: JSON.stringify(['unqualified', [{ id }]]), reason: '新消息尚未取得可靠的新到达资格，未自动回复。' });

test('实际 ChatService 与 FriendInteractions：跨入口锁拒绝；运行中处理只停发标记，不重建基线/读取会话/重置水位', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-unanswered-coordination-')), reads = [], sends = [];
  const messages = [{ id: 'old-1', text: '合成联合内容 old-1', sender: 'incoming', eligibleForReply: false, arrivalClassification: 'old-history' }];
  const browser = {
    listContacts: async () => ({ contacts: [structuredClone(contact)] }),
    readConversation: async () => { reads.push('readConversation'); return { conversation: { id: contact.id, isGroup: false }, contact: structuredClone(contact), messages: structuredClone(messages) }; },
    sendMessage: async () => { sends.push('sendMessage'); throw new Error('联合测试不允许发送'); },
  };
  fs.writeFileSync(path.join(directory, 'friend-interactions-policy.json'), JSON.stringify({ version: 1, enabled: true }));
  fs.writeFileSync(path.join(directory, 'chat-policy.json'), JSON.stringify({ version: 1, enabled: true, allowlist: [contact] }));
  fs.writeFileSync(path.join(directory, 'chat-watermarks.json'), JSON.stringify({ version: 1, contacts: { [contact.id]: { status: 'ready', seen: ['old-1'], context: [], unanswered: [record('old-1', '2026-10-26T12:28:21.601Z'), record('old-2', '2026-10-26T12:50:58.112Z')], lastCheckedAt: new Date().toISOString() } }, days: { '2026-10-26': 7 } }));
  const chat = new ChatService({ browser, config: { apiKey: 'synthetic-coordination' }, agent: { replyTokens: 512, reply: () => { throw new Error('联合测试不允许调用模型'); } }, stateDir: directory });
  const share = { state: () => ({ enabled: false }), configure: async () => {}, close: async () => {} };
  const friends = new FriendInteractions({ stateDir: directory, getChat: () => chat, getShare: () => share, modelReady: () => true });
  t.after(async () => { await friends.close(); await chat.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  await chat.start({ schedule: false });
  const seenBefore = structuredClone(chat.watermarks.contacts[contact.id].seen), contextBefore = structuredClone(chat.watermarks.contacts[contact.id].context);
  reads.length = 0;
  const opened = chat.unanswered(); assert.equal(opened.count, 2);
  const foreign = path.join(directory, 'friend-interactions-settings.guard');
  fs.writeFileSync(foreign, JSON.stringify({ pid: process.pid, token: 'foreign-entry' }));
  await assert.rejects(friends.resolveUnanswered({ recordIds: [opened.items[0].recordId], snapshot: opened.snapshot }), error => error.code === 'FRIEND_SETTINGS_BUSY');
  assert.equal(chat.state().running, true); assert.equal(chat.unanswered().count, 2); assert.deepEqual(reads, []); assert.equal(fs.existsSync(foreign), true);
  fs.unlinkSync(foreign);
  const result = await friends.resolveUnanswered({ recordIds: opened.items.map(item => item.recordId), snapshot: opened.snapshot });
  assert.equal(result.resolved, 2); assert.equal(chat.unanswered().count, 0);
  assert.equal(chat.state().running, true); assert.equal(chat.state().policy.enabled, true);
  assert.deepEqual(chat.watermarks.contacts[contact.id].seen, seenBefore);
  assert.deepEqual(chat.watermarks.contacts[contact.id].context, contextBefore);
  assert.deepEqual(reads, []); assert.deepEqual(sends, []);
  assert.equal(chat.state().recovery.pendingManualCount, 0);
  assert.ok(chat.watermarks.contacts[contact.id].unanswered.every(item => item.handledByUserAt && item.handledMethod === 'mark-handled-no-resend'));
});
