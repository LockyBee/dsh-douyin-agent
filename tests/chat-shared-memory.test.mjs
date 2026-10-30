import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChatAgent } from '../chat-agent.mjs';
import { MemoryStore, resolveQQMemoryPath } from '../memory.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chat-shared-'));
  const qqRoot = path.join(root, '聊天机器人'), qqFile = path.join(qqRoot, 'state', 'bridge.db');
  fs.mkdirSync(path.dirname(qqFile), { recursive: true }); fs.mkdirSync(path.join(qqRoot, 'roles'));
  fs.writeFileSync(path.join(qqRoot, 'package.json'), JSON.stringify({ name: 'gpt-qq-bridge' }));
  fs.writeFileSync(path.join(qqRoot, 'config.yaml'), 'memory:\n  shared: true\n');
  fs.writeFileSync(path.join(qqRoot, 'roles', 'deepseek娘.md'), '合成共同角色：短句接话。');
  const qq = new DatabaseSync(qqFile);
  qq.exec(`CREATE TABLE conversations(key TEXT PRIMARY KEY);
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_key TEXT NOT NULL,sender_id TEXT,sender_name TEXT,role TEXT NOT NULL,content_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE memories(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_key TEXT NOT NULL,subject TEXT NOT NULL,content TEXT NOT NULL,confidence REAL NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE runtime_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL);`);
  for (const key of ['group:10101', 'private:20202']) qq.prepare('INSERT INTO conversations VALUES (?)').run(key);
  const config = { ownerQQ: '20202', memory: { shared: true }, deny: { groups: [], private: [] } };
  const memory = new MemoryStore(path.join(root, '大肥鱼', 'memory', 'shared.sqlite'), { qqMemoryPath: qqFile, qqConfig: config });
  t.after(() => { memory.close(); qq.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^douyin-chat-shared-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, qqRoot, qqFile, qq, memory, config,
    remember(content, key = 'group:10101') { qq.prepare('INSERT INTO memories(conversation_key,subject,content,confidence,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(key, '合成蓝鲸', content, 0.9, 'active', 10, 20); },
    chat(content, key = 'group:10101') { qq.prepare('INSERT INTO messages(conversation_key,role,content_json,created_at) VALUES (?,?,?,?)').run(key, 'user', JSON.stringify({ role: 'user', content }), 30); } };
}

test('抖音群回复实际检索同一SQLite的QQ群历史、确认记忆和视频笔记，私聊及私有派生不进模型', async t => {
  const f = fixture(t);
  f.remember('蓝鲸公开确认记忆PUBLIC_FACT'); f.chat('蓝鲸群聊记录PUBLIC_HISTORY');
  f.remember('蓝鲸私聊机密PRIVATE_FACT', 'private:20202'); f.chat('蓝鲸私聊原话PRIVATE_HISTORY', 'private:20202');
  f.memory.remember({ content: '蓝鲸视频笔记PUBLIC_VIDEO' });
  const privateRef = f.memory.recall({ query: 'PRIVATE_FACT' }).entries.find(row => row.origin === 'qq');
  assert.ok(privateRef);
  f.memory.remember({ content: '蓝鲸私有派生PRIVATE_DERIVED', metadata: { sourceMemoryRefs: [{ id: privateRef.id, updatedAt: privateRef.updatedAt }] } });
  let request, reads = 0;
  const agent = new ChatAgent({ config: { apiKey: '' }, getMemoryStore: () => { reads++; return f.memory; },
    personaMemory: { snapshot: () => ({ manualText: '合成手编角色：温柔。' }) },
    replyProvider: async value => { request = value; return { text: '蓝鲸那个，我记着呢。' }; } });
  await agent.reply({ messages: [{ id: 'new', sender: 'incoming', text: '@大肥鱼 还记得蓝鲸吗' }], conversation: { displayName: '合成许可群', isGroup: true } });
  assert.equal(reads, 1); assert.equal(agent.lastMemoryContext.recalledCount, 3);
  assert.match(request.system, /PUBLIC_FACT/); assert.match(request.system, /PUBLIC_HISTORY/); assert.match(request.system, /PUBLIC_VIDEO/);
  assert.match(request.system, /合成共同角色：短句接话/); assert.match(request.system, /合成手编角色：温柔/);
  assert.match(request.system, /日常接话沿用 QQ 大肥鱼的节奏/); assert.match(request.system, /不把群名当作发消息的人/);
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE_FACT|PRIVATE_HISTORY|PRIVATE_DERIVED|10101|20202|bridge\.db/);
  assert.equal(request.tools, undefined);
});

test('共享开关撤销立即停止QQ人格和历史引用，不关闭当前聊天', async t => {
  const f = fixture(t); f.remember('蓝鲸公开事实PUBLIC_FACT');
  const requests = [];
  const agent = new ChatAgent({ config: { apiKey: '' }, memoryStore: f.memory, replyProvider: async value => { requests.push(value); return { text: '合成回复。' }; } });
  const messages = [{ id: 'new', sender: 'incoming', text: '蓝鲸' }];
  await agent.reply({ messages });
  f.qq.prepare('INSERT INTO runtime_settings VALUES (?,?)').run('console-overrides', JSON.stringify({ memory: { shared: false } }));
  await agent.reply({ messages });
  assert.match(requests[0].system, /PUBLIC_FACT|合成共同角色/);
  assert.doesNotMatch(requests[1].system, /PUBLIC_FACT|合成共同角色/);
  assert.equal(agent.lastMemoryContext.recalledCount, 0);
});

test('大量更近私聊命中不会挤掉可引用群记忆，派生链不能伪装公开', t => {
  const f = fixture(t); f.remember('蓝鲸较早群记忆PUBLIC_OLDER');
  for (let index = 0; index < 120; index++) f.remember(`蓝鲸私聊PRIVATE_${index}`, 'private:20202');
  const all = f.memory.recall({ query: '蓝鲸', limit: 100 }).entries;
  const privateRef = all.find(row => row.metadata.sourceType === 'private'); assert.ok(privateRef);
  f.memory.db.prepare(`INSERT INTO memory_entries(kind,content,source,sources_json,metadata_json,created_at,updated_at,origin,status)
    VALUES ('note','蓝鲸伪装公开的私聊派生PRIVATE_DISGUISED','api','["api"]',?,40,40,'video','recorded-note')`)
    .run(JSON.stringify({ sourceMemoryRefs: [{ id: privateRef.id, updatedAt: privateRef.updatedAt }] }));
  const result = f.memory.recallForChat({ query: '蓝鲸', limit: 8 });
  assert.equal(result.entries.length, 1); assert.match(result.entries[0].content, /PUBLIC_OLDER/);
  assert.doesNotMatch(JSON.stringify(result.entries), /PRIVATE_/);
});

test('读取器失败和未命中不会伪造记忆，预取消不读取共享库', async () => {
  let calls = 0, request;
  const agent = new ChatAgent({ config: { apiKey: '' }, getMemoryStore: () => { calls++; throw new Error('合成库暂不可用'); }, replyProvider: async value => { request = value; return { text: '这次没查到。' }; } });
  const messages = [{ id: 'new', sender: 'incoming', text: '合成旧事' }];
  await agent.reply({ messages }); assert.match(request.system, /本轮没有命中可引用的共享记忆/); assert.equal(agent.lastMemoryContext.available, false);
  const controller = new AbortController(); controller.abort(new Error('合成取消'));
  await assert.rejects(agent.reply({ messages, signal: controller.signal }), /合成取消/); assert.equal(calls, 1);
});

test('打包后按共享库旁的已核对QQ项目定位，显式地址优先且不递归寻找其他数据库', t => {
  const f = fixture(t), absentPackageRoot = path.join(f.root, 'packaged-runtime', '聊天机器人');
  const central = path.join(f.root, '大肥鱼', 'memory', 'shared.sqlite');
  assert.equal(resolveQQMemoryPath(central, { env: {}, sourceRoot: absentPackageRoot }), f.qqFile);
  const explicit = path.join(f.root, 'explicit.sqlite');
  assert.equal(resolveQQMemoryPath(central, { env: { DOUYIN_QQ_MEMORY_DB: explicit }, sourceRoot: absentPackageRoot }), explicit);
  assert.throws(() => resolveQQMemoryPath(central, { env: { DOUYIN_QQ_MEMORY_DB: 'relative.sqlite' } }), /绝对路径/);
  fs.writeFileSync(path.join(f.qqRoot, 'package.json'), JSON.stringify({ name: 'other-project' }));
  assert.equal(resolveQQMemoryPath(central, { env: {}, sourceRoot: absentPackageRoot }), path.join(absentPackageRoot, 'state', 'bridge.db'));
});

test('回复侧再次过滤提供器给出的私有条目，兴趣仅使用已有真实行为依据的抽象主题', async () => {
  let request;
  const agent = new ChatAgent({ config: { apiKey: 'synthetic-key' }, memoryStore: { recallForChat: () => ({ entries: [
    { id: 1, origin: 'qq', status: 'confirmed', content: 'PRIVATE_FACT', metadata: { sourceType: 'private' } },
    { id: 2, origin: 'video', status: 'observed-video', content: 'PRIVATE_DERIVED', metadata: { privacy: 'internal-reference' } },
    { id: 3, origin: 'qq-history', status: 'observed-history', content: 'PUBLIC_HISTORY token=synthetic-secret', metadata: { sourceType: 'group', role: 'assistant' } }
  ] }) }, personaMemory: { snapshot: () => ({ manualText: '', interests: [
    { topic: '合成真正兴趣', signal: 'like', evidenceCount: 1, evidence: [{ basisCode: 'sustained-watch', url: 'PRIVATE_OBSERVATION_URL' }] },
    { topic: 'PRIVATE_UNVERIFIED_INTEREST', signal: 'like', evidenceCount: 1, evidence: [{ basisCode: 'observation-only' }] }
  ] }) }, replyProvider: async value => { request = value; return { text: '合成回复。' }; } });
  await agent.reply({ messages: [{ id: 'new', sender: 'incoming', text: '合成问题' }] });
  assert.match(request.system, /PUBLIC_HISTORY|合成真正兴趣/); assert.match(request.system, /assistant 是过去的回复/);
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE_FACT|PRIVATE_DERIVED|PRIVATE_OBSERVATION_URL|PRIVATE_UNVERIFIED_INTEREST|synthetic-secret/);
});

test('群里同名不同成员分开、改昵称仍是同成员，原生标识不交模型且缺少标识时不猜人', async () => {
  let request;
  const agent = new ChatAgent({ config: { apiKey: '' }, replyProvider: async value => { request = value; return { text: '合成群回复。' }; } });
  const first = `member:${'a'.repeat(64)}`, second = `member:${'b'.repeat(64)}`;
  await agent.reply({ conversation: { displayName: '合成群', isGroup: true }, messages: [
    { id: 'one', sender: 'incoming', text: '合成成员甲的话', memberId: first, memberName: '同名' },
    { id: 'two', sender: 'incoming', text: '合成成员乙的话', memberId: second, memberName: '同名' },
    { id: 'three', sender: 'incoming', text: '合成改名后的话', memberId: first, memberName: '新昵称' },
    { id: 'four', sender: 'incoming', text: '合成无标识的话', memberName: '不可信猜测名字' }
  ] });
  assert.match(request.messages[0].content, /"member":"成员1","displayName":"同名"/);
  assert.match(request.messages[1].content, /"member":"成员2","displayName":"同名"/);
  assert.match(request.messages[2].content, /"member":"成员1","displayName":"新昵称"/);
  assert.equal(request.messages[3].content, '合成无标识的话');
  assert.doesNotMatch(JSON.stringify(request), /member:[ab]{64}|不可信猜测名字/);
});
