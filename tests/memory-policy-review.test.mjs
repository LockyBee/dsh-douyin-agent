import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createAccessView } from '../memory-policy.mjs';
import { recallHybrid } from '../memory-retrieval.mjs';

const group = { platform: 'qq', conversationId: 'group-a', isGroup: true };
const local = { ...group, subjectId: 'subject-a', sharedEnabled: true };
const record = (id, options = {}) => ({ id, origin: 'qq', kind: 'note', status: 'confirmed', content: '花生吃了会过敏。',
  createdAt: 10, updatedAt: id * 100, scope: { ...group }, metadata: { sourceType: 'group' }, ...options });
const context = (options = {}) => ({ ...local, ...options });
const ids = rows => rows.map(row => row.id);

test('私有来源仅限原平台原会话，可信同人映射也不扩大私聊范围', () => {
  const scope = { platform: 'qq', conversationId: 'private-a', isGroup: false };
  const privateRow = record(1, { scope, metadata: { sourceType: 'private', privacy: 'internal-reference' }, content: '合成私聊原文' });
  const home = context(scope);
  assert.deepEqual(ids(createAccessView([privateRow], home).records), [1]);
  for (const destination of [
    context({ conversationId: 'private-b', isGroup: false }),
    context({ platform: 'douyin', conversationId: 'private-a', isGroup: false }),
    context({ platform: 'dsh', conversationId: 'private-dsh', isGroup: false,
      verifiedLinks: [{ ...scope, subjectId: 'subject-a', verified: true, proofId: 'host-verified' }] }),
  ]) assert.deepEqual(createAccessView([privateRow], destination).records, []);
});

test('公开派生摘要不能借同人映射转述私聊根来源', () => {
  const source = record(1, { scope: { platform: 'qq', conversationId: 'private-a', isGroup: false },
    content: '合成私聊原文', metadata: { sourceType: 'private', privacy: 'internal-reference' } });
  const derived = record(2, { content: '合成私聊摘要', metadata: { sourceType: 'group', sourceMemoryRefs: [{ id: 1, updatedAt: 100 }] } });
  const target = context({ platform: 'douyin', conversationId: 'public-target', verifiedLinks: [{ ...group,
    subjectId: 'subject-a', verified: true, proofId: 'host-verified' }] });
  assert.deepEqual(createAccessView([source, derived], target).records, []);
});

test('姓名和昵称不构成映射，映射主体、凭据与共享开关逐项核对', () => {
  const source = record(1, { subjectId: 'subject-a', factKey: 'food-allergy' });
  const target = context({ platform: 'douyin', conversationId: 'public-target', displayName: '同名',
    verifiedLinks: [{ ...group, subjectId: 'subject-a', verified: true, proofId: 'host-verified' }] });
  assert.deepEqual(ids(createAccessView([source], target).records), [1]);
  for (const blocked of [
    { ...target, verifiedLinks: [] },
    { ...target, subjectId: 'subject-b' },
    { ...target, sharedEnabled: false },
    { ...target, verifiedLinks: [{ ...target.verifiedLinks[0], verified: false }] },
    { ...target, verifiedLinks: [{ ...target.verifiedLinks[0], proofId: '' }] },
  ]) assert.deepEqual(createAccessView([source], blocked).records, []);
});

test('根来源撤销、删除、版本变化后，所有派生层都即时失效', () => {
  const source = record(1), child = record(2, { metadata: { sourceType: 'group', sourceMemoryRefs: [{ id: 1, updatedAt: 100 }] } });
  const grandchild = record(3, { metadata: { sourceType: 'group', sourceMemoryRefs: [{ id: 2, updatedAt: 200 }] } });
  for (const replacement of [{ ...source, revoked: true }, { ...source, metadata: { sourceType: 'group', deleted: true } }, { ...source, updatedAt: 101 }, null]) {
    const rows = [replacement, child, grandchild].filter(Boolean);
    assert.ok(!ids(createAccessView(rows, local).records).includes(2));
    assert.ok(!ids(createAccessView(rows, local).records).includes(3));
  }
});

test('明确纠正旧事实后，引用旧版本的摘要不能让旧事实重新进入召回', () => {
  const old = record(1, { subjectId: 'subject-a', factKey: 'home-city', content: '我住在天津。' });
  const correction = record(2, { subjectId: 'subject-a', factKey: 'home-city', content: '已经搬到苏州了。',
    supersedes: [{ id: 1, updatedAt: 100 }] });
  const summary = record(3, { content: '住在天津的那条旧记录。', metadata: { sourceType: 'group', sourceMemoryRefs: [{ id: 1, updatedAt: 100 }] } });
  const result = recallHybrid({ records: [old, correction, summary], context: local, query: '住在哪儿', now: 10000 });
  assert.ok(!ids(result.entries).includes(1));
  assert.ok(!ids(result.entries).includes(3));
  assert.ok(ids(result.entries).includes(2));
});

test('来源深度门槛不受输入行顺序及缓存预热影响', () => {
  const rows = Array.from({ length: 11 }, (_, index) => record(index + 1, { metadata: { sourceType: 'group',
    ...(index ? { sourceMemoryRefs: [{ id: index, updatedAt: index * 100 }] } : {}) } }));
  const forwards = ids(createAccessView(rows, local).records).sort((a, b) => a - b);
  const backwards = ids(createAccessView([...rows].reverse(), local).records).sort((a, b) => a - b);
  assert.deepEqual(forwards, backwards);
  assert.ok(!forwards.includes(10)); assert.ok(!forwards.includes(11));
});

test('本地可选评分器只收到已授权、未撤销记录，私聊与错人事实不交评分器', () => {
  const source = record(1), revoked = record(2, { revoked: true }), other = record(3, { subjectId: 'someone-else', factKey: 'food-allergy' });
  const secret = record(4, { scope: { platform: 'qq', conversationId: 'private-a', isGroup: false }, metadata: { sourceType: 'private' } });
  let scored;
  const result = recallHybrid({ records: [source, revoked, other, secret], context: local, query: '花生', now: 10000,
    semanticProvider: { localOnly: true, score(value) { scored = value; return []; } } });
  assert.deepEqual(ids(scored.records), [1]); assert.deepEqual(ids(result.entries), [1]);
});

test('误配的异步评分器失败后降级，不产生未处理拒绝或结束进程', () => {
  const moduleUrl = new URL('../memory-retrieval.mjs', import.meta.url).href;
  const script = `import { recallHybrid } from ${JSON.stringify(moduleUrl)};
    const result = recallHybrid({records:${JSON.stringify([record(1)])},context:${JSON.stringify(local)},query:'花生',now:10000,
      semanticProvider:{localOnly:true,score:async()=>{throw new Error('合成异步失败')}}});
    if (!result.metrics.semanticFallback) process.exitCode = 2;
    await new Promise(resolve=>setTimeout(resolve,10));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
});

test('总字数包含引用与元数据，超长首条不阻挡后续可容纳记录', () => {
  const long = record(1, { content: `花生${'合成'.repeat(1000)}` });
  const short = record(2, { content: '花生过敏。' });
  const result = recallHybrid({ records: [long, short], context: local, query: '花生', maxChars: 500, now: 10000 });
  assert.deepEqual(ids(result.entries), [2]);
  assert.ok(JSON.stringify(result.entries).length <= 500); assert.equal(result.metrics.droppedForBudget, 1);
});

test('多层摘要命中能定位到原文，定位结果不受摘要输入顺序影响', () => {
  const original = record(1, { kind: 'history', origin: 'qq-history', status: 'observed-history', content: '那件物品是生日礼物。', metadata: { sourceType: 'group', role: 'user' } });
  const middle = record(2, { kind: 'summary', content: '礼物记录的中间索引。', metadata: { sourceType: 'group', sourceMemoryRefs: [{ id: 1, updatedAt: 100 }] } });
  const outer = record(3, { kind: 'diary', content: '青铜镂空徽章的事件索引。', metadata: { sourceType: 'group', sourceMemoryRefs: [{ id: 2, updatedAt: 200 }] } });
  for (const records of [[original, middle, outer], [outer, middle, original]]) {
    const result = recallHybrid({ records, context: local, query: '青铜镂空徽章', now: 10000 });
    assert.deepEqual(ids(result.entries), [1]);
    assert.equal(result.entries[0].content, original.content);
  }
});

test('JSON中的畸形隐私字段按行拒绝，不通过对象转字符串使整次召回崩溃', () => {
  const good = record(1);
  const bad = record(2, { metadata: JSON.parse('{"sourceType":"group","visibility":{"toString":"bad"}}') });
  const result = createAccessView([good, bad], local);
  assert.deepEqual(ids(result.records), [1]); assert.equal(result.rejected, 1);
});

test('撤销删除与用户事实标志出现错误类型时按行拒绝，不能把字符串当未撤销', () => {
  const fields = ['revoked', 'deleted', 'denied', 'isUserFact', 'derivedFromQQ'];
  for (const field of fields) {
    const bad = record(2, { metadata: { sourceType: 'group', [field]: 'true' } });
    assert.deepEqual(ids(createAccessView([record(1), bad], local).records), [1], field);
  }
});
