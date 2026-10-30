import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatService } from '../chat-service.mjs';
import { interactionPresence } from '../interaction-status.mjs';

const contact = () => ({
  id: `conv:${'a'.repeat(64)}`, name: '合成许可好友', followed: true, isGroup: false,
  identityVersion: 2, identityKind: 'rendered-user', identityHash: 'a'.repeat(64),
  identityVerified: true, identityBinding: `binding:${'b'.repeat(64)}`,
  verifiedAt: '2026-10-26T00:00:00.000Z', authorizationKind: 'following',
});
const record = (id, at, text = `合成待核对内容 ${id}`) => ({
  phase: 'unqualified', incoming: [{ id, text, sender: 'incoming' }], at,
  skippedAt: at, archiveKey: JSON.stringify(['unqualified', [{ id, text }]]),
  reason: '新消息尚未取得可靠的新到达资格，未自动回复。',
});
function fixture(t, records = [record('old-1', '2026-10-26T12:28:21.601Z'), record('old-2', '2026-10-26T12:50:58.112Z')]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chat-unanswered-'));
  const saved = contact(); const browserCalls = [];
  const browser = {
    listContacts: () => { browserCalls.push('listContacts'); throw new Error('不应读取浏览器'); },
    readConversation: () => { browserCalls.push('readConversation'); throw new Error('不应读取会话'); },
    sendMessage: () => { browserCalls.push('sendMessage'); throw new Error('不应发送'); },
  };
  fs.writeFileSync(path.join(directory, 'chat-policy.json'), JSON.stringify({ version: 1, enabled: false, allowlist: [saved] }));
  fs.writeFileSync(path.join(directory, 'chat-watermarks.json'), JSON.stringify({ version: 1, contacts: { [saved.id]: { status: 'ready', seen: ['old'], context: [], unanswered: structuredClone(records), lastCheckedAt: '2026-10-26T12:55:00.000Z' } }, days: { '2026-10-26': 7 } }));
  const service = new ChatService({ browser, agent: { replyTokens: 512, reply: () => { throw new Error('不应调用模型'); } }, config: { apiKey: 'synthetic-only' }, stateDir: directory });
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, contact: saved, service, browserCalls };
}
const storedMark = (f) => JSON.parse(fs.readFileSync(path.join(f.directory, 'chat-watermarks.json'), 'utf8')).contacts[f.contact.id];

test('ready 联系人的两条遗留记录可列出，含稳定标识、会话、时间、原因、类型和本地预览', t => {
  const f = fixture(t), list = f.service.unanswered();
  assert.equal(list.protocol, 'chat-unanswered-v1'); assert.equal(list.count, 2);
  assert.equal(list.items.length, 2); assert.equal(new Set(list.items.map(item => item.recordId)).size, 2);
  assert.ok(list.items.every(item => /^[a-f0-9]{64}$/.test(item.recordId)));
  assert.equal(list.items[0].contactName, '合成许可好友'); assert.equal(list.items[0].phase, 'unqualified');
  assert.deepEqual(list.items[0].types, ['文字']); assert.match(list.items[0].preview, /合成待核对内容/);
  assert.ok(list.items[0].at.startsWith('2026-10-26T12:28:21'));
  assert.match(list.items[0].reason, /未自动回复/); assert.deepEqual(f.browserCalls, []);
  const top = interactionPresence({ chat: { policy: { allowlist: [f.contact] }, contacts: [{ id: f.contact.id, status: 'ready', unanswered: [record('old-1', '2026-10-26T12:28:21.601Z')] }], recovery: { pendingManualCount: 2 }, running: true, worker: { alive: true, heartbeatAt: Date.now() } }, friend: { policy: { enabled: true }, status: 'running' }, modelReady: true });
  assert.equal(JSON.stringify(top).includes('合成待核对内容'), false);
  assert.equal(top.review.manualCount, 2, '内部历史数量保留');
  assert.equal(top.review.active, false, '旧历史不生成顶栏待核对提示');
  assert.doesNotMatch(top.reply.label + top.review.reason, /未答消息|人工核对/);
});

test('重复归档使用不可复用的 archiveId，旧确认重试不会命中后来生成的同内容记录', t => {
  const base = record('same-id', '2026-10-26T12:28:21.601Z');
  const first = { ...base, archiveId: undefined }, second = { ...base, archiveId: 'archive-new' };
  const f = fixture(t, [first, second]);
  const opened = f.service.unanswered();
  assert.equal(opened.count, 2); assert.equal(new Set(opened.items.map(item => item.recordId)).size, 2);
  const oldId = opened.items[0].recordId;
  assert.equal(f.service.markUnansweredHandled({ recordIds: [oldId] }).resolved, 1);
  const mark = storedMark(f); mark.unanswered.push({ ...base, archiveId: 'archive-later', skippedAt: '2026-10-27T00:00:00.000Z', at: '2026-10-27T00:00:00.000Z' }); fs.writeFileSync(path.join(f.directory, 'chat-watermarks.json'), JSON.stringify({ version: 1, contacts: { [f.contact.id]: mark }, days: { '2026-10-26': 7 } }));
  const retry = f.service.markUnansweredHandled({ recordIds: [oldId] });
  assert.equal(retry.alreadyHandled, true); assert.equal(f.service.unanswered().count, 2);
  assert.equal(storedMark(f).unanswered.find(item => item.archiveId === 'archive-later').handledByUserAt, undefined);
});

test('归档时为新记录分配唯一 archiveId，重复归档不会复用旧身份', t => {
  const f = fixture(t, []), mark = storedMark(f);
  const pending = () => ({ phase: 'unqualified', incoming: [{ id: 'same-archive', text: '同一合成内容', sender: 'incoming' }], at: '2026-10-26T12:28:21.601Z' });
  mark.pending = pending(); fs.writeFileSync(path.join(f.directory, 'chat-watermarks.json'), JSON.stringify({ version: 1, contacts: { [f.contact.id]: mark }, days: { '2026-10-26': 7 } }));
  f.service.resumeContact(f.contact.id);
  const second = storedMark(f); second.pending = pending(); fs.writeFileSync(path.join(f.directory, 'chat-watermarks.json'), JSON.stringify({ version: 1, contacts: { [f.contact.id]: second }, days: { '2026-10-26': 7 } }));
  f.service.resumeContact(f.contact.id);
  const ids = storedMark(f).unanswered.map(item => item.archiveId); assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 2); assert.ok(ids.every(id => typeof id === 'string' && id.length > 20));
});

test('显式准备回复通道只执行一次普通会话读取，后台检查不请求新建页', t => {
  const f = fixture(t), calls = [];
  f.service.browser.listContacts = async options => { calls.push(options); return { contacts: [{ ...f.contact }] }; };
  return f.service.prepareChat().then(result => {
    assert.equal(result.prepared, true); assert.equal(result.count, 1);
    assert.equal(calls.length, 1); assert.equal(calls[0].backgroundOnly, false); assert.equal(calls[0].verifyFollowing, false);
    assert.deepEqual(f.browserCalls, []);
  });
});

test('缺少可显示正文或不支持的媒体按实际元数据提示，不编造识别结果', t => {
  const f = fixture(t, [{ phase: 'unsupported-media', incoming: [{ id: 'voice-1', unsupported: true, media: { type: 'voice' } }], at: '2026-10-27T00:00:00.000Z', skippedAt: '2026-10-27T00:00:00.000Z', archiveKey: 'synthetic-voice', reason: '新消息包含尚未可靠采集的附件，未编造内容或假装已理解，请人工查看。' }]);
  const item = f.service.unanswered().items[0];
  assert.equal(item.preview, null); assert.deepEqual(item.types, ['语音']); assert.match(item.previewNote, /没有可显示的文字正文/); assert.match(item.previewNote, /未做识别/);
  assert.match(item.reason, /未编造内容/);
});

test('单条标记保留原记录与审计，服务回读归零，刷新后不反弹，重复确认幂等', t => {
  const f = fixture(t), first = f.service.unanswered(), id = first.items[0].recordId;
  const result = f.service.markUnansweredHandled({ recordIds: [id] });
  assert.equal(result.resolved, 1); assert.equal(result.alreadyHandled, false);
  assert.equal(f.service.unanswered().count, 1);
  const item = storedMark(f).unanswered.find(entry => entry.incoming[0].id === 'old-1');
  assert.ok(item.handledByUserAt); assert.equal(item.handledMethod, 'mark-handled-no-resend');
  assert.equal(item.phase, 'unqualified'); assert.match(item.reason, /未自动回复/);
  const reload = new ChatService({ browser: { listContacts() {}, readConversation() {}, sendMessage() {} }, agent: {}, config: {}, stateDir: f.directory });
  assert.equal(reload.unanswered().count, 1);
  const repeat = f.service.markUnansweredHandled({ recordIds: [id] });
  assert.equal(repeat.alreadyHandled, true); assert.equal(f.service.unanswered().count, 1);
  assert.deepEqual(f.browserCalls, []);
});

test('快照批量只标记当前列表；确认期间新增记录时拒绝旧快照，新记录不会被误处理', t => {
  const f = fixture(t), first = f.service.unanswered(), ids = first.items.map(item => item.recordId);
  assert.equal(f.service.markUnansweredHandled({ recordIds: ids, snapshot: first.snapshot }).resolved, 2);
  assert.equal(f.service.unanswered().count, 0);
  assert.ok(storedMark(f).unanswered.every(item => item.handledByUserAt));
  const repeat = f.service.markUnansweredHandled({ recordIds: ids, snapshot: first.snapshot });
  assert.equal(repeat.alreadyHandled, true); assert.equal(f.service.unanswered().count, 0);
  const changed = fixture(t, [record('old-1', '2026-10-26T12:28:21.601Z'), record('old-2', '2026-10-26T12:50:58.112Z')]);
  const opened = changed.service.unanswered();
  const mark = storedMark(changed); mark.unanswered.push(record('new-arrival', '2026-10-27T00:00:00.000Z')); fs.writeFileSync(path.join(changed.directory, 'chat-watermarks.json'), JSON.stringify({ version: 1, contacts: { [changed.contact.id]: mark }, days: { '2026-10-26': 7 } }));
  assert.throws(() => changed.service.markUnansweredHandled({ recordIds: opened.items.map(item => item.recordId), snapshot: opened.snapshot }), error => error.status === 409 && /列表已变化/.test(error.message));
  assert.equal(changed.service.unanswered().count, 3);
  assert.equal(storedMark(changed).unanswered.find(item => item.incoming[0].id === 'new-arrival').handledByUserAt, undefined);
  assert.deepEqual(changed.browserCalls, []);
});

test('未知或篡改标识拒绝且不先修改记录；运行中标记被拒绝；不改变 seen、context 和预算', t => {
  const f = fixture(t), before = structuredClone(storedMark(f)), beforeFile = JSON.parse(fs.readFileSync(path.join(f.directory, 'chat-watermarks.json'), 'utf8'));
  assert.throws(() => f.service.markUnansweredHandled({ recordIds: ['f'.repeat(64)] }), error => error.status === 404);
  assert.deepEqual(storedMark(f), before);
  f.service.running = true;
  assert.throws(() => f.service.markUnansweredHandled({ recordIds: [f.service.unanswered().items[0].recordId] }), error => error.status === 409);
  f.service.running = false;
  const afterFile = JSON.parse(fs.readFileSync(path.join(f.directory, 'chat-watermarks.json'), 'utf8'));
  assert.deepEqual(afterFile.contacts[f.contact.id].seen, before.seen); assert.deepEqual(afterFile.contacts[f.contact.id].context, before.context);
  assert.deepEqual(afterFile.days, beforeFile.days);
  assert.deepEqual(f.browserCalls, []);
});
