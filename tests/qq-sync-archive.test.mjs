import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../memory.mjs';
import { openCentralDatabase, syncQQToCentral } from '../qq-sync.mjs';

const config = () => ({ ownerQQ: '654321', memory: { shared: true }, deny: { groups: [], private: [] } });
function fixture(t, withArchive = true) {
  const directory = mkdtempSync(path.join(tmpdir(), 'qq-sync-archive-'));
  const qqPath = path.join(directory, 'qq.sqlite'), centralPath = path.join(directory, 'central.sqlite');
  const qq = new DatabaseSync(qqPath), central = openCentralDatabase(centralPath);
  qq.exec(`CREATE TABLE conversations(key TEXT PRIMARY KEY);
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_key TEXT NOT NULL,sender_id TEXT,sender_name TEXT,role TEXT NOT NULL,content_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE memories(id INTEGER PRIMARY KEY,conversation_key TEXT,subject TEXT,content TEXT,confidence REAL,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE runtime_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL);
    INSERT INTO conversations VALUES ('private:654321'),('group:223344');`);
  if (withArchive) qq.exec(`CREATE TABLE conversation_originals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_key TEXT NOT NULL,source_message_id INTEGER NOT NULL,source_revision TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,original_order INTEGER NOT NULL,live_message_id INTEGER,role TEXT NOT NULL,content_json TEXT NOT NULL,created_at INTEGER NOT NULL,
    sender_id TEXT,sender_name TEXT,record_kind TEXT NOT NULL,archived_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'active',revoked_at INTEGER,
    UNIQUE(conversation_key,source_message_id,source_revision));
    CREATE INDEX archive_order ON conversation_originals(conversation_key,original_order);`);
  const store = new MemoryStore(centralPath, { qqMemoryPath: qqPath, qqConfig: config(), trackRecallSources: false });
  t.after(() => {
    store.close(); central.close(); qq.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.match(path.basename(directory), /^qq-sync-archive-/);
    rmSync(directory, { recursive: true, force: true });
  });
  const message = (content, { key = 'private:654321', role = 'user', senderName = '合成旧昵称', senderId = '654321', time = 100, item } = {}) => Number(qq.prepare('INSERT INTO messages(conversation_key,sender_id,sender_name,role,content_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(key, senderId, senderName, role, JSON.stringify(item || { role, content }), time).lastInsertRowid);
  function archive(sourceId, { row, state = 'active', detached = true, order = sourceId, archivedAt = 999999, content } = {}) {
    row ||= qq.prepare('SELECT * FROM messages WHERE id=?').get(sourceId);
    const json = content === undefined ? row.content_json : JSON.stringify({ role: row.role, content });
    const revision = createHash('sha256').update(JSON.stringify([row.role, json, row.created_at, row.sender_id, row.sender_name])).digest('hex');
    qq.prepare('INSERT INTO conversation_originals(conversation_key,source_message_id,source_revision,content_sha256,original_order,live_message_id,role,content_json,created_at,sender_id,sender_name,record_kind,archived_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.conversation_key, sourceId, revision, createHash('sha256').update(json).digest('hex'), order, detached ? null : sourceId,
        row.role, json, row.created_at, row.sender_id, row.sender_name, ['user', 'assistant'].includes(row.role) ? 'raw' : 'tool', archivedAt, state);
  }
  const sync = options => syncQQToCentral({ qqDb: qq, qqPath, centralDb: central, config: config(), ...options });
  const mirror = sourceId => central.prepare("SELECT * FROM memory_entries WHERE external_key LIKE ?").get(`%:message:${sourceId}`);
  const byId = rowId => central.prepare('SELECT * FROM memory_entries WHERE id=?').get(rowId);
  function chain(sourceId, label = '合成两层派生') {
    const source = mirror(sourceId), ref = { id: Number(source.id), updatedAt: Number(source.updated_at) };
    const first = store.remember({ content: `${label}一。`, metadata: { sourceMemoryRefs: [ref] } });
    const second = store.remember({ content: `${label}二。`, metadata: { sourceMemoryRefs: [{ id: first.id, updatedAt: first.updatedAt }] } });
    return { ref, first, second };
  }
  return { qq, central, qqPath, message, archive, sync, mirror, byId, chain };
}

test('压缩detached原文保留既有镜像和两级私有派生，ID/时间/版本不因迁移改变', t => {
  const f = fixture(t), id = f.message('合成合法原文。'); f.sync();
  const before = f.mirror(id), chain = f.chain(id);
  f.archive(id, { order: 17, archivedAt: 999999999 }); f.qq.exec('DELETE FROM messages');
  const result = f.sync();
  assert.equal(result.updated, 0); assert.equal(result.imported, 0); assert.equal(result.removed, 0);
  const after = f.mirror(id); assert.ok(after);
  for (const key of ['id', 'created_at', 'updated_at', 'content', 'metadata_json']) assert.equal(after[key], before[key], key);
  assert.equal(f.central.prepare('SELECT source_updated_at FROM memory_source_times WHERE entry_id=?').get(after.id).source_updated_at, 100);
  assert.ok(f.byId(chain.first.id)); assert.ok(f.byId(chain.second.id));
  assert.equal(JSON.parse(f.byId(chain.second.id).metadata_json).privacy, 'internal-reference');
});

test('只保留已有镜像，不从archive新导出记录；共享关闭再打开不恢复旧档案', t => {
  const f = fixture(t), id = f.message('已有合成原文。'); f.sync();
  f.archive(id); f.qq.exec('DELETE FROM messages');
  f.archive(9000, { row: { conversation_key: 'group:223344', role: 'user', sender_id: '999888', sender_name: '从未共享的旧名', created_at: 80, content_json: JSON.stringify({ role: 'user', content: '从未导出的归档私密标记。' }) }, order: 9000 });
  f.sync(); assert.ok(f.mirror(id)); assert.equal(f.mirror(9000), undefined);
  f.sync({ config: { ...config(), memory: { shared: false } } }); assert.equal(f.mirror(id), undefined);
  f.sync(); assert.equal(f.mirror(id), undefined); assert.equal(f.mirror(9000), undefined);
});

test('真正撤销、superseded、clear或SQL直接delete但live_id非空仍清理来源及派生', t => {
  for (const state of ['revoked', 'superseded', 'live-pointer']) {
    const f = fixture(t), id = f.message(`合成撤销边界${state}。`); f.sync(); const chain = f.chain(id);
    f.archive(id, { state: state === 'live-pointer' ? 'active' : state, detached: state !== 'live-pointer' });
    f.qq.exec('DELETE FROM messages'); f.sync();
    assert.equal(f.mirror(id), undefined, state); assert.equal(f.byId(chain.first.id), undefined, state); assert.equal(f.byId(chain.second.id), undefined, state);
  }
  const f = fixture(t), id = f.message('合成clear边界。'); f.sync(); const chain = f.chain(id);
  f.archive(id); f.qq.exec("UPDATE conversation_originals SET state='revoked'; DELETE FROM messages"); f.sync();
  assert.equal(f.mirror(id), undefined); assert.equal(f.byId(chain.second.id), undefined);
});

test('部分合法compaction与真正删除共存时，低水位不把其余合法来源一起重建删除', t => {
  const f = fixture(t), kept = f.message('应保留原文。'), deleted = f.message('真正删除原文。', { time: 200 });
  f.sync(); const a = f.chain(kept, '保留派生'), b = f.chain(deleted, '删除派生');
  f.archive(kept); f.archive(deleted, { detached: false }); f.qq.exec('DELETE FROM messages'); f.sync();
  assert.ok(f.mirror(kept)); assert.ok(f.byId(a.second.id));
  assert.equal(f.mirror(deleted), undefined); assert.equal(f.byId(b.second.id), undefined);
});

test('archive按original_order识别旧敏感turn，缺当前工具记录也不回流，下一turn保留', t => {
  const f = fixture(t), first = f.message('曾访问本机资料的合成原文。'), next = f.message('下一回合合法原文。', { time: 200 });
  f.sync(); const chain = f.chain(first);
  f.archive(first, { order: 20 });
  f.archive(8000, { row: { conversation_key: 'private:654321', sender_id: null, sender_name: null, role: 'assistant', created_at: 100,
    content_json: JSON.stringify({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_workspace_file' } }] }) }, order: 21, state: 'revoked' });
  f.archive(next, { order: 22 }); f.qq.exec('DELETE FROM messages'); f.sync();
  assert.equal(f.mirror(first), undefined); assert.equal(f.byId(chain.second.id), undefined); assert.ok(f.mirror(next));
});

test('重启后的身份catalog包含archive sender与header，不泄露旧昵称或群旁听称呼', async t => {
  const f = fixture(t), id = f.message('发送者：合成旧昵称（QQ 654321）\n消息：合成旧昵称与合成旧旁听名都提过花茶。');
  const other = f.message('群聊旁听消息，发送者 合成旧旁听名：花茶不错。', { key: 'group:223344', senderName: null, senderId: null });
  f.sync(); const before = f.mirror(id); f.archive(id); f.archive(other); f.qq.exec('DELETE FROM messages');
  const fresh = await import(`../qq-sync.mjs?archive-test-fresh=${Date.now()}`);
  fresh.syncQQToCentral({ qqDb: f.qq, qqPath: f.qqPath, centralDb: f.central, config: config() });
  const after = f.mirror(id); assert.equal(after.content, before.content); assert.equal(after.updated_at, before.updated_at);
  assert.doesNotMatch(JSON.stringify(f.central.prepare('SELECT * FROM memory_entries').all()), /合成旧昵称|合成旧旁听名|654321|223344/);
});

test('deny及关闭共享继续级联，已有工作缓存优先且空档案模式兼容', t => {
  const f = fixture(t), id = f.message('旧缓存合成原文。', { key: 'group:223344' }); f.sync(); const chain = f.chain(id);
  f.archive(id, { content: '档案中不能覆盖现有缓存的另一版本。' }); f.sync();
  assert.match(f.mirror(id).content, /旧缓存合成原文/);
  f.qq.exec('DELETE FROM messages'); f.sync({ config: { ...config(), deny: { groups: ['223344'], private: [] } } });
  assert.equal(f.mirror(id), undefined); assert.equal(f.byId(chain.second.id), undefined);
  const old = fixture(t, false), oldId = old.message('没有档案表的合成原文。'); old.sync(); assert.ok(old.mirror(oldId));
  old.qq.exec('DELETE FROM messages'); old.sync(); assert.equal(old.mirror(oldId), undefined);
});
