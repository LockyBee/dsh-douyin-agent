import test from 'node:test';
import assert from 'node:assert/strict';
import { recallConversationHistory } from '../memory-history.mjs';

const context = { platform: 'qq', conversationId: 'group:test-a', isGroup: true, sharedEnabled: true, subjectId: 'person:a' };
const record = (id, overrides = {}) => ({ id, kind: 'history', content: `合成原话 ${id}\n换行保留。`, origin: 'qq-history', status: 'observed-history', createdAt: id * 10, updatedAt: id * 10,
  scope: { platform: 'qq', conversationId: 'group:test-a', isGroup: true }, metadata: { role: id % 2 ? 'user' : 'assistant', sourceType: 'group' }, ...overrides });
const recall = (records, options = {}) => recallConversationHistory({ records, context, maxChars: 20000, ...options });

test('原文按可信会话读取近期和更早记录，引用与换行完整', () => {
  const records = [1, 2, 3, 4, 5].map(id => record(id));
  const recent = recall(records, { limit: 2 });
  assert.deepEqual(recent.entries.map(row => row.id), [5, 4]);
  assert.equal(recent.entries[0].content, records[4].content);
  assert.deepEqual(recent.entries[0].source, records[4].scope);
  assert.equal(recent.entries[0].updatedAt, 50);
  assert.equal(recent.hasMore, true); assert.ok(recent.nextCursor);
  const older = recall(records, { cursor: recent.nextCursor, limit: 2 });
  assert.deepEqual(older.entries.map(row => row.id), [3, 2]);
  const end = recall(records, { cursor: older.nextCursor, limit: 2 });
  assert.deepEqual(end.entries.map(row => row.id), [1]); assert.equal(end.nextCursor, null); assert.equal(end.hasMore, false);
  assert.deepEqual(recall(records, { before: 30 }).entries.map(row => row.id), [2, 1]);
});

test('同名、缺失会话标识和不同群都不能混入原文回溯', () => {
  const records = [record(1), record(2, { scope: { platform: 'qq', conversationId: 'group:test-b', isGroup: true }, displayName: '同名' }),
    record(3, { scope: undefined }), record(4, { scope: { platform: 'qq', conversationId: 'group:test-a', isGroup: false } }),
    record(5, { kind: 'summary', origin: 'qq-history', metadata: { sourceType: 'group', role: 'user' } }), record(6, { metadata: { sourceType: 'group', role: 'tool' } })];
  assert.deepEqual(recall(records).entries.map(row => row.id), [1]);
});

test('可信跨端映射必须绑定当前主体和明确的公开源会话', () => {
  const records = [record(1, { scope: { platform: 'douyin', conversationId: 'group:linked', isGroup: true } })];
  const link = { platform: 'douyin', conversationId: 'group:linked', subjectId: 'person:a', verified: true, proofId: 'host-proof:a' };
  assert.equal(recall(records).entries.length, 0);
  assert.equal(recall(records, { context: { ...context, verifiedLinks: [link] } }).entries.length, 1);
  for (const patch of [{ verified: false }, { proofId: '' }, { subjectId: 'person:b' }, { conversationId: 'group:other' }]) {
    assert.equal(recall(records, { context: { ...context, verifiedLinks: [{ ...link, ...patch }] } }).entries.length, 0);
  }
  assert.equal(recall(records, { context: { ...context, sharedEnabled: false, verifiedLinks: [link] } }).entries.length, 0);
});

test('私聊只对精确同端同会话可见，可信同人映射也不扩散私聊', () => {
  const privateContext = { platform: 'qq', conversationId: 'private:a', isGroup: false, sharedEnabled: true, subjectId: 'person:a' };
  const privateRow = record(1, { scope: { platform: 'qq', conversationId: 'private:a', isGroup: false }, metadata: { role: 'user', sourceType: 'private', privacy: 'internal-reference' } });
  assert.equal(recall([privateRow], { context: privateContext }).entries.length, 1);
  assert.equal(recall([privateRow], { context }).entries.length, 0);
  const elsewhere = { ...privateContext, platform: 'douyin', conversationId: 'private:b', verifiedLinks: [{ platform: 'qq', conversationId: 'private:a', subjectId: 'person:a', verified: true, proofId: 'host-proof:a' }] };
  assert.equal(recall([privateRow], { context: elsewhere }).entries.length, 0);
});

test('分页重读权限与记录，不从游标缓存取已删除或撤销的原文', () => {
  const records = [1, 2, 3, 4].map(id => record(id));
  const first = recall(records, { limit: 1 });
  const changed = records.filter(row => row.id !== 3).map(row => row.id === 2 ? { ...row, status: 'revoked' } : row);
  assert.deepEqual(recall(changed, { cursor: first.nextCursor }).entries.map(row => row.id), [1]);
  assert.throws(() => recall(changed, { cursor: first.nextCursor, context: { ...context, conversationId: 'group:other' } }), /游标/);
  assert.throws(() => recall(changed, { cursor: first.nextCursor, context: { ...context, sharedEnabled: false } }), /游标/);
});

test('派生来源失效即停止引用，摘要不代替原文', () => {
  const parent = record(1);
  const derived = record(2, { metadata: { role: 'assistant', sourceType: 'group', sourceMemoryRefs: [{ id: 1, updatedAt: 10 }] } });
  assert.equal(recall([parent, derived]).entries.length, 2);
  assert.equal(recall([derived]).entries.length, 0);
  assert.deepEqual(recall([{ ...parent, updatedAt: 11 }, derived]).entries.map(row => row.id), [1]);
});

test('完整返回JSON遵守字符预算，不截断原文，超长消息能向前翻页', () => {
  const records = [1, 2, 3, 4, 5].map(id => record(id, { content: '合成完整原文。'.repeat(id * 24) }));
  const page = recall(records, { maxChars: 1100, limit: 50 });
  assert.ok(JSON.stringify(page).length <= 1100); assert.equal(page.truncated, true); assert.ok(page.omitted > 0);
  for (const row of page.entries) assert.equal(row.content, records.find(source => source.id === row.id).content);
  if (page.nextCursor) {
    const next = recall(records, { maxChars: 1100, limit: 50, cursor: page.nextCursor });
    assert.ok(JSON.stringify(next).length <= 1100);
    assert.equal(next.entries.some(row => page.entries.some(previous => previous.id === row.id)), false);
  }
  const long = Array.from({ length: 201 }, (_, i) => record(i + 1, { content: '超长合成原话'.repeat(1000) }));
  const skipped = recall(long, { maxChars: 512 });
  assert.equal(skipped.entries.length, 0); assert.equal(skipped.omitted, 200); assert.equal(skipped.hasMore, true); assert.ok(skipped.nextCursor);
  const end = recall(long, { maxChars: 512, cursor: skipped.nextCursor });
  assert.equal(end.omitted, 1); assert.equal(end.hasMore, false); assert.ok(JSON.stringify(skipped).length <= 512);
});

test('同时间消息分页稳定，重复输入不重复引用', () => {
  const records = [1, 2, 3, 4].map(id => record(id, { createdAt: 100 }));
  const first = recall([...records, records[0]], { limit: 2 });
  const second = recall(records, { limit: 2, cursor: first.nextCursor });
  assert.equal(new Set([...first.entries, ...second.entries].map(row => row.id)).size, 4);
  assert.equal(second.hasMore, false);
});

test('参数与游标边界有明确错误，未使用源路径或昵称授权', () => {
  for (const options of [{ limit: 0 }, { limit: 51 }, { maxChars: 511 }, { maxChars: 20001 }, { before: -1 }, { cursor: 'wrong%' }, { before: 10, cursor: 'x' }, { context: { displayName: '同名' } }]) {
    assert.throws(() => recall([record(1)], options));
  }
  const first = recall([record(1), record(2)], { limit: 1 });
  const altered = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8')); altered.c = '0'.repeat(64);
  assert.throws(() => recall([record(1)], { cursor: Buffer.from(JSON.stringify(altered)).toString('base64url') }), /游标/);
});
