import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { MemoryStore, DEFAULT_MEMORY_PATH } from '../memory.mjs';
import { DEFAULT_SHARED_MEMORY_PATH, sharedMemoryPath, openCentralDatabase, loadQQMemoryConfig, syncQQToCentral, recallCentralMemory, scrubMetadataStrings } from '../qq-sync.mjs';

const config = () => ({ ownerQQ: '654321', memory: { shared: true }, deny: { groups: [], private: [] } });

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'dafeyu-memory-test-'));
  const qqPath = path.join(directory, 'qq.sqlite'), centralPath = path.join(directory, 'central.sqlite');
  const qq = new DatabaseSync(qqPath);
  qq.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE conversations(key TEXT PRIMARY KEY);
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_key TEXT NOT NULL,sender_id TEXT,sender_name TEXT,role TEXT NOT NULL,content_json TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX messages_turn ON messages(conversation_key,id);
    CREATE TABLE memories(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_key TEXT NOT NULL,subject TEXT NOT NULL,content TEXT NOT NULL,confidence REAL NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE runtime_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL);`);
  for (const key of ['private:654321', 'group:223344', 'group:998877']) qq.prepare('INSERT INTO conversations(key) VALUES (?)').run(key);
  const handles = [qq];
  t.after(() => {
    for (const handle of handles.reverse()) { try { handle.close(); } catch {} }
    const resolved = path.resolve(directory), allowed = `${path.resolve(tmpdir())}${path.sep}`;
    if (!resolved.startsWith(allowed) || !path.basename(resolved).startsWith('dafeyu-memory-test-')) throw new Error('临时目录范围核对失败');
    rmSync(resolved, { recursive: true, force: true });
  });
  const central = openCentralDatabase(centralPath); handles.push(central);
  const message = (text, { key = 'private:654321', role = 'user', senderId = '654321', senderName = '测试甲', time = 100, item } = {}) => Number(qq.prepare('INSERT INTO messages(conversation_key,sender_id,sender_name,role,content_json,created_at) VALUES (?,?,?,?,?,?)')
    .run(key, senderId, senderName, role, JSON.stringify(item || { role, content: text }), time).lastInsertRowid);
  const memory = (content, { key = 'private:654321', status = 'active', subject = '视频偏好', created = 50, updated = 80 } = {}) => Number(qq.prepare('INSERT INTO memories(conversation_key,subject,content,confidence,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(key, subject, content, 0.9, status, created, updated).lastInsertRowid);
  const sync = (options = {}) => syncQQToCentral({ qqDb: qq, qqPath, config: config(), centralDb: central, ...options });
  const rows = () => central.prepare('SELECT * FROM memory_entries ORDER BY id').all();
  const store = (options = {}) => { const value = new MemoryStore(centralPath, { qqMemoryPath: qqPath, qqConfig: config(), ...options }); handles.push(value); return value; };
  return { directory, qqPath, centralPath, qq, central, handles, message, memory, sync, rows, store };
}

test('首次导入仅保存active确认记忆与去敏文字历史，来源与时间可核对', t => {
  const f = fixture(t);
  f.memory('测试甲喜欢猫咪视频，QQ 654321，api_key=synthetic-secret', { subject: '测试甲的视频偏好' });
  f.memory('候选不应导入', { status: 'candidate' });
  f.memory('撤销不应导入', { status: 'revoked' });
  f.message('发送者：测试甲（QQ 654321）\n消息：喜欢猫咪 [CQ:image,file=synthetic-file,url=https://gchat.qpic.cn/654321] token=synthetic-token', { time: 101 });
  f.message('群聊旁听消息，发送者 测试乙：也喜欢猫咪', { key: 'group:223344', senderId: null, senderName: null, time: 102 });
  f.message('', { role: 'assistant', senderId: null, senderName: null, time: 103, item: { role: 'assistant', content: [{ type: 'output_text', text: '测试乙提过猫咪' }, { type: 'input_image', image_url: 'https://gchat.qpic.cn/raw-attachment' }] } });
  const result = f.sync();
  assert.equal(result.imported, 4);
  assert.equal(result.pending, false);
  const rows = f.rows(), serialized = JSON.stringify(rows);
  for (const excluded of ['测试甲', '测试乙', '654321', '223344', 'synthetic-secret', 'synthetic-token', 'synthetic-file', 'raw-attachment', '候选不应导入', '撤销不应导入']) assert.equal(serialized.includes(excluded), false, `应排除测试标记 ${excluded}`);
  const confirmed = rows.find(row => row.status === 'confirmed');
  assert.equal(confirmed.source, 'qq');
  assert.equal(confirmed.origin, 'qq');
  assert.equal(confirmed.created_at, 50);
  assert.equal(confirmed.updated_at, 80);
  assert.equal(JSON.parse(confirmed.metadata_json).sourceType, 'private');
  assert.equal(JSON.parse(confirmed.metadata_json).privacy, 'internal-reference');
  for (const row of rows.filter(row => row.kind === 'qq-history')) {
    assert.equal(row.status, 'observed-history');
    assert.equal(JSON.parse(row.metadata_json).confirmed, false);
  }
  assert.equal(JSON.parse(rows.find(row => row.created_at === 102).metadata_json).sourceType, 'group');
});

test('水位按批增量推进，最后一批pending精确，重复同步幂等', t => {
  const f = fixture(t);
  for (let index = 0; index < 5; index += 1) f.message(`猫咪记录${index}`);
  assert.deepEqual(f.sync({ batchSize: 2 }), { processed: 2, imported: 2, updated: 0, removed: 0, watermark: 2, pending: true, confirmed: 0, shared: true, available: true, reconciled: 0, reconciliationPending: false });
  assert.equal(f.sync({ batchSize: 2 }).watermark, 4);
  const last = f.sync({ batchSize: 1 });
  assert.equal(last.watermark, 5);
  assert.equal(last.pending, false);
  const stable = f.sync();
  assert.equal(stable.processed, 0);
  assert.equal(stable.imported, 0);
  assert.equal(stable.updated, 0);
  f.message('新增猫咪记录');
  const increment = f.sync();
  assert.equal(increment.processed, 1);
  assert.equal(increment.imported, 1);
  assert.equal(f.rows().length, 6);
});

test('运行时console-overrides生效，deny和关闭共享撤除镜像且不保留owner私聊', t => {
  const f = fixture(t), store = f.store();
  f.memory('私聊猫咪偏好');
  f.memory('群聊猫咪偏好', { key: 'group:223344' });
  f.message('群聊猫咪历史', { key: 'group:223344' });
  f.message('私聊猫咪历史');
  store.remember({ content: '视频猫咪摘要', kind: 'summary' });
  assert.equal(f.sync().imported, 4);
  f.qq.prepare('INSERT INTO runtime_settings VALUES (?,?)').run('model_overrides', JSON.stringify({ memory: { shared: false } }));
  assert.equal(f.sync().shared, true);
  f.qq.prepare('INSERT INTO runtime_settings VALUES (?,?)').run('console-overrides', JSON.stringify({ deny: { groups: ['223344'], private: [] } }));
  f.sync();
  assert.equal(f.rows().filter(row => row.source === 'qq').length, 2);
  assert.equal(JSON.stringify(f.rows()).includes('群聊猫咪'), false);
  f.qq.prepare('UPDATE runtime_settings SET value_json=? WHERE key=?').run(JSON.stringify({ memory: { shared: false } }), 'console-overrides');
  const closed = f.sync();
  assert.equal(closed.shared, false);
  assert.equal(f.rows().filter(row => row.source === 'qq').length, 0);
  assert.equal(f.rows().filter(row => row.origin === 'video').length, 1);
  f.qq.prepare('UPDATE runtime_settings SET value_json=? WHERE key=?').run(JSON.stringify({ memory: { shared: true }, deny: { groups: [], private: [] } }), 'console-overrides');
  assert.equal(f.sync().imported, 4);
});

test('撤销确认记忆、删除源消息和原文修改在后续同步中生效', t => {
  const f = fixture(t), memoryId = f.memory('旧猫咪偏好'), messageId = f.message('旧猫咪记录');
  f.sync();
  f.qq.prepare('UPDATE memories SET content=?,updated_at=? WHERE id=?').run('新猫咪偏好', 200, memoryId);
  f.qq.prepare('UPDATE messages SET content_json=? WHERE id=?').run(JSON.stringify({ role: 'user', content: '新猫咪记录 cookie=synthetic-cookie' }), messageId);
  assert.equal(f.sync().updated, 2);
  assert.equal(JSON.stringify(f.rows()).includes('synthetic-cookie'), false);
  assert.equal(JSON.stringify(f.rows()).includes('旧猫咪'), false);
  f.qq.prepare('UPDATE memories SET status=? WHERE id=?').run('revoked', memoryId);
  f.qq.prepare('DELETE FROM messages WHERE id=?').run(messageId);
  assert.equal(f.sync().removed, 2);
  assert.equal(f.rows().length, 0);
});

test('局部运行时deny保留另一类配置限制，Cookie多字段不会残留', t => {
  const f = fixture(t);
  f.message('私聊猫咪应隔离');
  f.message('猫咪 Cookie: session=synthetic-session; auth=synthetic-auth', { key: 'group:223344' });
  f.qq.prepare('INSERT INTO runtime_settings VALUES (?,?)').run('console-overrides', JSON.stringify({ deny: { groups: ['998877'] } }));
  const effective = config(); effective.deny.private = ['654321'];
  f.sync({ config: effective });
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].content.includes('synthetic-session'), false);
  assert.equal(f.rows()[0].content.includes('synthetic-auth'), false);
  assert.equal(f.rows()[0].content.includes('私聊猫咪'), false);
});

test('晚到的本机工具调用清除该回合，并识别SDK和Chat工具协议', t => {
  const f = fixture(t);
  f.message('猫咪本机工作请求');
  f.message('猫咪处理答复', { role: 'assistant' });
  f.sync();
  assert.equal(f.rows().length, 2);
  f.message('', { role: 'tool', item: { type: 'function_call', name: 'read_workspace_file', arguments: '{}' } });
  assert.equal(f.sync().removed, 2);
  assert.equal(f.rows().length, 0);
  f.message('猫咪正常新回合');
  f.message('正常猫咪说明', { role: 'assistant' });
  f.sync();
  assert.equal(f.rows().length, 2);
  f.message('猫咪命令回合');
  f.message('准备执行', { role: 'assistant', item: { role: 'assistant', content: '准备执行', tool_calls: [{ type: 'function', function: { name: 'run_workspace_command', arguments: '{}' } }] } });
  f.sync();
  assert.equal(f.rows().length, 2);
  assert.equal(JSON.stringify(f.rows()).includes('猫咪命令回合'), false);
});

test('JSON元数据逐字符串去敏，嵌套URL有效且敏感键不入库', t => {
  const f = fixture(t), store = f.store({ qqMemoryPath: null });
  const saved = store.remember({ content: '猫咪视频笔记', metadata: {
    nested: { url: 'https://reader:synthetic-pass@example.test/watch?q=cat&token=synthetic-token', apiKey: 'synthetic-key', list: ['Bearer synthetic-secret', 'D:\\测试目录\\私密文件'] },
    quote: '有"引号"和\\反斜线', confirmed: true, isUserFact: true,
  } });
  assert.equal(saved.metadata.confirmed, false);
  assert.equal(saved.metadata.isUserFact, false);
  assert.equal(saved.status, 'recorded-note');
  assert.equal(saved.metadata.nested.apiKey, undefined);
  assert.equal(new URL(saved.metadata.nested.url).username, '');
  assert.equal(new URL(saved.metadata.nested.url).searchParams.get('token'), '***');
  assert.equal(saved.metadata.quote, '有"引号"和\\反斜线');
  const serialized = JSON.stringify(saved);
  for (const excluded of ['synthetic-pass', 'synthetic-token', 'synthetic-key', 'synthetic-secret', '私密文件']) assert.equal(serialized.includes(excluded), false);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => scrubMetadataStrings(cycle), /循环引用/);
  assert.throws(() => store.remember({ content: '猫咪', metadata: { n: Infinity } }), /有限/);
});

test('旧历史有限循环核对，敏感工具即使命中批次外回合也立即撤除', t => {
  const f = fixture(t), ids = [];
  for (let index = 0; index < 10; index += 1) {
    ids.push(f.message(`猫咪旧历史${index}`));
    f.message(`猫咪旧答复${index}`, { role: 'assistant' });
  }
  f.sync();
  const first = f.sync({ batchSize: 2 });
  assert.equal(first.reconciled, 2);
  assert.equal(first.reconciliationPending, true);
  f.qq.prepare('DELETE FROM messages WHERE id=?').run(ids[3]);
  f.message('', { role: 'tool', item: { type: 'function_call', name: 'list_workspace_files' } });
  const late = f.sync({ batchSize: 2 });
  assert.equal(late.reconciled, 2);
  assert.equal(late.removed, 2);
  assert.equal(JSON.stringify(f.rows()).includes('猫咪旧历史9'), false);
  for (let attempt = 0; attempt < 12 && f.rows().some(row => row.content === '猫咪旧历史3'); attempt += 1) {
    assert.ok(f.sync({ batchSize: 2 }).reconciled <= 2);
  }
  assert.equal(f.rows().some(row => row.content === '猫咪旧历史3'), false);
});

test('非空相关查询才返回QQ历史，视频摘要和偏好可反向按需检索', t => {
  const f = fixture(t), store = f.store();
  f.message('喜欢看猫咪扑纸箱');
  store.remember({ content: '猫咪扑纸箱的视频摘要', kind: 'summary', source: 'dsh' });
  store.remember({ content: '更喜欢猫咪实拍', kind: 'preference', source: 'api' });
  store.remember({ content: '无关咖啡内容', kind: 'note' });
  const empty = store.recall();
  assert.equal(empty.entries.some(entry => entry.origin.startsWith('qq')), false);
  assert.equal(recallCentralMemory({ centralDb: f.central, query: '' }).length, 0);
  const related = store.recall({ query: '之前在QQ说过喜欢看什么猫咪？', limit: 10 });
  assert.equal(related.connections.qq.available, true);
  assert.equal(related.entries.some(entry => entry.origin === 'qq-history'), true);
  assert.equal(related.entries.some(entry => entry.content.includes('无关咖啡')), false);
  const reverse = recallCentralMemory({ centralDb: f.central, query: '猫咪', origins: ['video'] });
  assert.equal(reverse.length, 2);
  assert.ok(reverse.every(entry => entry.origin === 'video' && entry.status === 'recorded-note'));
  assert.equal(recallCentralMemory({ centralDb: f.central, query: '海绵火星不存在zz' }).length, 0);
  assert.equal(recallCentralMemory({ centralDb: f.central, query: '%_%' }).length, 0);
  assert.equal(recallCentralMemory({ centralDb: f.central, query: '654321' }).length, 0);
  assert.equal(JSON.stringify(related.entries).includes(f.qqPath), false);
  assert.equal(related.entries.some(entry => Object.hasOwn(entry, 'external_key')), false);
});

test('源库无法核对授权时不返回已缓存QQ记录，视频记忆仍可检索', t => {
  const f = fixture(t);
  f.message('猫咪历史');
  f.sync();
  const store = f.store({ qqConfig: undefined, qqConfigPath: path.join(f.directory, 'missing.yaml') });
  store.remember({ content: '猫咪视频摘要' });
  const result = store.recall({ query: '猫咪' });
  assert.equal(result.connections.qq.available, false);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].origin, 'video');
});

test('中央默认路径与环境覆盖一致，配置读取不返回凭据', t => {
  const f = fixture(t), previous = process.env.DEEPSEEK_SHARED_MEMORY_DB;
  assert.equal(DEFAULT_MEMORY_PATH, DEFAULT_SHARED_MEMORY_PATH);
  const configPath = path.join(f.directory, 'config.yaml');
  writeFileSync(configPath, 'ownerQQ: "654321"\nmemory:\n  shared: true\ndeny:\n  groups: []\n  private: []\napiKey: synthetic-key\n');
  const safeConfig = loadQQMemoryConfig(f.qqPath, configPath);
  assert.equal(Object.hasOwn(safeConfig, 'apiKey'), false);
  process.env.DEEPSEEK_SHARED_MEMORY_DB = path.join(f.directory, 'overridden.sqlite');
  try {
    assert.equal(sharedMemoryPath(), process.env.DEEPSEEK_SHARED_MEMORY_DB);
    const store = new MemoryStore(undefined, { qqMemoryPath: null });
    f.handles.push(store);
    assert.equal(store.dbPath, process.env.DEEPSEEK_SHARED_MEMORY_DB);
  } finally { if (previous === undefined) delete process.env.DEEPSEEK_SHARED_MEMORY_DB; else process.env.DEEPSEEK_SHARED_MEMORY_DB = previous; }
});

test('同一视频多入口合并来源，关闭重开后QQ水位和视频记录仍在', t => {
  const f = fixture(t), store = f.store();
  const observation = { video: { id: '7695660015218134307', title: '猫咪测试作品', author: '公开视频作者', url: 'https://www.douyin.com/video/7695660015218134307?token=synthetic-token', time: 2, duration: 10, paused: false } };
  const first = store.recordVideo(observation, 'api'), second = store.recordVideo(observation, 'dsh');
  assert.equal(first.id, second.id);
  assert.deepEqual(second.sources.sort(), ['api', 'dsh']);
  assert.equal(second.status, 'observed-video');
  assert.equal(second.metadata.observationOnly, true);
  assert.equal(second.metadata.isUserFact, false);
  f.message('猫咪历史'); store.syncQQ(); store.close();
  const reopened = f.store();
  assert.equal(reopened.syncQQ().imported, 0);
  assert.equal(reopened.recall({ query: '猫咪' }).entries.length, 2);
  assert.equal(reopened.recall({ query: '猫咪', kind: 'video' }).entries[0].url, 'https://www.douyin.com/video/7695660015218134307');
});

test('两个并发工作线程使用WAL写同一库，写入不丢且重开可读', async t => {
  const f = fixture(t), memoryModule = new URL('../memory.mjs', import.meta.url).href;
  assert.equal(f.central.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({MemoryStore}) => {
      const store=new MemoryStore(workerData.path,{qqMemoryPath:null});
      parentPort.postMessage({ready:true});
      parentPort.once('message',()=>{try {
        for(let n=0;n<30;n++) store.remember({content:'并发猫咪笔记 '+workerData.source+' '+n,source:workerData.source});
        store.recordVideo({video:{id:'7695660015218134307',title:'并发猫咪作品'}},workerData.source);
        store.close(); parentPort.postMessage({done:true});
      } catch(error) { parentPort.postMessage({error:String(error)}); }});
    }).catch(error=>parentPort.postMessage({error:String(error)}));`;
  const workers = ['api', 'dsh'].map(source => new Worker(code, { eval: true, workerData: { module: memoryModule, path: f.centralPath, source } }));
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const ready = await Promise.all(workers.map(worker => once(worker, 'message')));
  assert.ok(ready.every(([message]) => message.ready));
  const done = workers.map(worker => once(worker, 'message'));
  for (const worker of workers) worker.postMessage('开始');
  const messages = await Promise.all(done);
  assert.ok(messages.every(([message]) => message.done), JSON.stringify(messages));
  assert.equal(f.rows().length, 61);
  const store = f.store({ qqMemoryPath: null });
  assert.deepEqual(store.recall({ query: '并发猫咪作品', kind: 'video' }).entries[0].sources.sort(), ['api', 'dsh']);
});

test('私聊回忆后的笔记继承根引用和私聊标签，模型不能降级或删来源', t => {
  const f = fixture(t), store = f.store();
  f.message('私聊猫咪偏好');
  const parent = store.recall({ query: '私聊猫咪偏好' }).entries.find(item => item.origin === 'qq-history');
  const note = store.remember({ content: '猫咪派生摘要', metadata: { sourceType: 'group', privacy: 'public', sourceMemoryRefs: [], confirmed: true } });
  assert.equal(note.origin, 'video');
  assert.equal(note.metadata.sourceType, 'private');
  assert.equal(note.metadata.privacy, 'internal-reference');
  assert.equal(note.metadata.confirmed, false);
  assert.equal(note.metadata.derivedFromQQ, true);
  assert.deepEqual(note.metadata.sourceMemoryRefs, [{ id: parent.id, updatedAt: parent.updatedAt }]);
  assert.equal(f.central.prepare('SELECT COUNT(*) AS n FROM memory_dependencies WHERE entry_id=?').get(note.id).n, 1);
  const again = store.remember({ content: '第二条摘要', metadata: { sourceType: 'video', privacy: null } });
  assert.equal(again.metadata.sourceType, 'private');
});

test('关闭实例来源累积时，显式引用仍继承私聊，其他agent普通视频保持公开', t => {
  const f = fixture(t), store = f.store({ trackRecallSources: false });
  f.memory('私聊猫咪偏好');
  const parent = store.recall({ query: '私聊猫咪偏好' }).entries.find(item => item.origin === 'qq');
  const publicNote = store.remember({ content: '纯公开视频猫咪摘要' });
  assert.equal(publicNote.metadata.sourceType, undefined);
  assert.equal(publicNote.metadata.derivedFromQQ, false);
  const privateNote = store.remember({ content: '明确引用的猫咪摘要', metadata: { sourceMemoryRefs: [{ id: parent.id, updatedAt: parent.updatedAt }], sourceType: 'group' } });
  assert.equal(privateNote.metadata.sourceType, 'private');
  assert.equal(privateNote.metadata.privacy, 'internal-reference');
  assert.throws(() => store.remember({ content: '未知来源', metadata: { sourceMemoryRefs: [{ id: 9999, updatedAt: 100 }] } }), /已失效/);
});

test('二次摘要扁平继承全部QQ根，group根撤销会清理两层派生项', t => {
  const f = fixture(t), store = f.store({ trackRecallSources: false });
  const memoryId = f.memory('群聊猫咪事实', { key: 'group:223344' });
  const root = store.recall({ query: '群聊猫咪事实' }).entries.find(item => item.origin === 'qq');
  const first = store.remember({ content: '猫咪第一层摘要', metadata: { sourceMemoryRefs: [{ id: root.id, updatedAt: root.updatedAt }] } });
  const second = store.remember({ content: '猫咪第二层摘要', metadata: { sourceMemoryRefs: [{ id: first.id, updatedAt: first.updatedAt }] } });
  assert.deepEqual(second.metadata.sourceMemoryRefs, [{ id: root.id, updatedAt: root.updatedAt }]);
  assert.equal(second.metadata.sourceType, undefined);
  f.qq.prepare('UPDATE memories SET status=? WHERE id=?').run('revoked', memoryId);
  const result = f.sync();
  assert.equal(result.removed, 3);
  assert.equal(recallCentralMemory({ centralDb: f.central, query: '猫咪', origins: ['video'] }).length, 0);
  assert.equal(f.central.prepare('SELECT COUNT(*) AS n FROM memory_dependencies').get().n, 0);
});

test('deny、关闭共享与晚到敏感工具都级联移除QQ派生笔记', t => {
  for (const reason of ['deny', 'shared', 'tool']) {
    const f = fixture(t), store = f.store({ trackRecallSources: false });
    f.message('私聊猫咪依赖');
    const parent = store.recall({ query: '私聊猫咪依赖' }).entries.find(item => item.origin === 'qq-history');
    store.remember({ content: '猫咪依赖摘要', metadata: { sourceMemoryRefs: [{ id: parent.id, updatedAt: parent.updatedAt }] } });
    store.recordVideo({ video: { id: '7695660015218134307', title: '猫咪公开视频' } });
    if (reason === 'tool') f.message('', { role: 'tool', item: { type: 'function_call', name: 'read_workspace_file' } });
    else f.qq.prepare('INSERT INTO runtime_settings VALUES (?,?)').run('console-overrides', JSON.stringify(reason === 'deny' ? { deny: { private: ['654321'] } } : { memory: { shared: false } }));
    f.sync();
    assert.equal(f.rows().filter(row => row.kind === 'note').length, 0, reason);
    assert.equal(f.rows().filter(row => row.kind === 'video').length, 1, reason);
    assert.equal(recallCentralMemory({ centralDb: f.central, query: '猫咪依赖摘要', kind: 'note' }).length, 0, reason);
  }
});

test('源删除或文本更新使旧派生失效，时间戳未变也不能复用旧ref', t => {
  const f = fixture(t), store = f.store({ trackRecallSources: false });
  const messageId = f.message('猫咪旧文本', { time: 100 });
  const parent = store.recall({ query: '猫咪旧文本' }).entries.find(item => item.origin === 'qq-history');
  store.remember({ content: '猫咪旧摘要', metadata: { sourceMemoryRefs: [{ id: parent.id, updatedAt: parent.updatedAt }] } });
  f.qq.prepare('UPDATE messages SET content_json=? WHERE id=?').run(JSON.stringify({ role: 'user', content: '猫咪新文本' }), messageId);
  f.sync();
  const source = f.rows().find(row => row.origin === 'qq-history');
  assert.ok(source.updated_at > parent.updatedAt);
  assert.equal(JSON.parse(source.metadata_json).sourceUpdatedAt, 100);
  assert.equal(f.rows().filter(row => row.kind === 'note').length, 0);
  assert.throws(() => store.remember({ content: '试图复活旧摘要', metadata: { sourceMemoryRefs: [{ id: parent.id, updatedAt: parent.updatedAt }] } }), /已失效或更新/);
  assert.equal(f.sync().updated, 0);
  const current = store.recall({ query: '猫咪新文本' }).entries.find(item => item.origin === 'qq-history');
  store.remember({ content: '猫咪新摘要', metadata: { sourceMemoryRefs: [{ id: current.id, updatedAt: current.updatedAt }] } });
  f.central.prepare('DELETE FROM memory_entries WHERE id=?').run(current.id);
  assert.equal(recallCentralMemory({ centralDb: f.central, query: '猫咪新摘要', origins: ['video'] }).length, 0);
  f.qq.prepare('DELETE FROM messages WHERE id=?').run(messageId);
  f.sync();
  assert.equal(f.rows().filter(row => row.kind === 'note').length, 0);
});

test('QQ无法核对时空查询和相关查询隐藏派生video，普通视频仍可读取', t => {
  const f = fixture(t), store = f.store({ trackRecallSources: false });
  f.message('私聊猫咪参考');
  const parent = store.recall({ query: '私聊猫咪参考' }).entries.find(item => item.origin === 'qq-history');
  store.remember({ content: '猫咪私聊派生笔记', metadata: { sourceMemoryRefs: [{ id: parent.id, updatedAt: parent.updatedAt }] } });
  store.recordVideo({ video: { id: '7695660015218134307', title: '猫咪公开视频' } });
  const isolated = f.store({ qqConfig: undefined, qqConfigPath: path.join(f.directory, 'missing.yaml') });
  for (const query of ['', '猫咪']) {
    const found = isolated.recall({ query }).entries;
    assert.equal(found.length, 1);
    assert.equal(found[0].kind, 'video');
  }
  assert.equal(recallCentralMemory({ centralDb: f.central, query: '猫咪', origins: ['video'], allowQQSources: false }).length, 1);
});

test('循环和超量来源拒写，现有视频合并不能抹掉私聊依赖', t => {
  const f = fixture(t), store = f.store({ trackRecallSources: false });
  f.message('私聊猫咪参考');
  const parent = store.recall({ query: '私聊猫咪参考' }).entries.find(item => item.origin === 'qq-history');
  const linked = store.remember({ kind: 'video', videoId: '7695660015218134307', content: '猫咪私聊笔记', metadata: { sourceMemoryRefs: [{ id: parent.id, updatedAt: parent.updatedAt }] } });
  const merged = store.recordVideo({ video: { id: '7695660015218134307', title: '猫咪公开视频' } });
  assert.equal(merged.id, linked.id);
  assert.ok(merged.updatedAt > linked.updatedAt);
  assert.equal(merged.metadata.sourceType, 'private');
  assert.deepEqual(merged.metadata.sourceMemoryRefs, linked.metadata.sourceMemoryRefs);
  const cycle = store.remember({ content: '猫咪循环测试' });
  const cycleVersion = cycle.updatedAt + 1;
  f.central.prepare('UPDATE memory_entries SET metadata_json=?,updated_at=? WHERE id=?').run(JSON.stringify({ sourceMemoryRefs: [{ id: cycle.id, updatedAt: cycleVersion }] }), cycleVersion, cycle.id);
  assert.throws(() => store.remember({ content: '不能读取循环来源', metadata: { sourceMemoryRefs: [{ id: cycle.id, updatedAt: cycleVersion }] } }), /循环引用/);
  assert.equal(recallCentralMemory({ centralDb: f.central, query: '猫咪循环测试' }).some(item => item.id === cycle.id), false);
  assert.throws(() => store.remember({ content: '超量来源', metadata: { sourceMemoryRefs: Array.from({ length: 65 }, (_, i) => ({ id: i + 1, updatedAt: 100 })) } }), /最多 64/);
});

test('旧缓存写者不能回退来源版本，数据库触发器即时撤除派生项', t => {
  const f = fixture(t), store = f.store({ trackRecallSources: false });
  const messageId = f.message('猫咪原文', { time: 100 });
  const parent = store.recall({ query: '猫咪原文' }).entries.find(item => item.origin === 'qq-history');
  store.remember({ content: '猫咪旧派生', metadata: { sourceMemoryRefs: [{ id: parent.id, updatedAt: parent.updatedAt }] } });
  f.qq.prepare('UPDATE messages SET content_json=? WHERE id=?').run(JSON.stringify({ role: 'user', content: '猫咪修改原文' }), messageId);
  // 模拟尚未刷新模块的写者：仍用原来源时间写新内容。
  f.central.prepare('UPDATE memory_entries SET content=?,updated_at=? WHERE id=?').run('猫咪修改原文', parent.updatedAt, parent.id);
  const updated = f.central.prepare('SELECT * FROM memory_entries WHERE id=?').get(parent.id);
  assert.ok(updated.updated_at > parent.updatedAt);
  assert.equal(f.rows().some(row => row.kind === 'note'), false);
  f.central.prepare('UPDATE memory_entries SET updated_at=? WHERE id=?').run(parent.updatedAt, parent.id);
  assert.equal(f.central.prepare('SELECT updated_at FROM memory_entries WHERE id=?').get(parent.id).updated_at, updated.updated_at);
  assert.equal(f.sync().updated, 0);
  assert.throws(() => store.remember({ content: '不能复用旧源', metadata: { sourceMemoryRefs: [{ id: parent.id, updatedAt: parent.updatedAt }] } }), /已失效或更新/);
  store.remember({ content: '猫咪新派生', metadata: { sourceMemoryRefs: [{ id: parent.id, updatedAt: updated.updated_at }] } });
  f.central.prepare('DELETE FROM memory_entries WHERE id=?').run(parent.id);
  assert.equal(f.rows().some(row => row.kind === 'note'), false);
});
