import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ensureSharedLocation } from '../src/prepare-api-runtime.mjs';
import { resolveRuntimePaths } from '../../runtime-paths.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-prepare-api-'));
  const home = path.join(root, 'home'), sourceRoot = path.join(root, 'source'), file = path.join(root, 'runtime-location.json'), legacyMemoryDbPath = path.join(root, 'old-memory', 'shared.sqlite');
  await fs.mkdir(home); await fs.mkdir(path.dirname(legacyMemoryDbPath));
  const db = new DatabaseSync(legacyMemoryDbPath);
  try { db.exec('CREATE TABLE verification (note TEXT NOT NULL); INSERT INTO verification VALUES (\'原有刷视频记忆\');'); } finally { db.close(); }
  const hash = async target => createHash('sha256').update(await fs.readFile(target)).digest('hex');
  const originalHash = await hash(legacyMemoryDbPath);
  const resolve = options => resolveRuntimePaths({ ...options, sourceRoot, legacyMemoryDbPath });
  const env = { DOUYIN_RUNTIME_LOCATION_FILE: file };
  const run = extraEnv => ensureSharedLocation({ home, env: { ...env, ...extraEnv }, resolve });
  t.after(async () => {
    const target = path.resolve(root); if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界。');
    await fs.rm(target, { recursive: true, force: true });
  });
  return { root, home, sourceRoot, file, legacyMemoryDbPath, hash, originalHash, resolve, env, run };
}

test('登记已有视频记忆的原位置，只补目录及精确数据库路径，不复制或改写原库', async t => {
  const f = await fixture(t), stateDir = path.join(f.sourceRoot, 'state');
  const original = { version: 1, stateDir, mediaSettingsFile: path.join(f.root, 'existing-audio-settings.json') };
  await fs.writeFile(f.file, JSON.stringify(original));
  const first = await f.run(); const registered = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.deepEqual(registered, { ...original, memoryDir: path.dirname(f.legacyMemoryDbPath), memoryDbPath: f.legacyMemoryDbPath });
  assert.equal(first.paths.memoryDbPath, f.legacyMemoryDbPath); assert.equal(first.env.DEEPSEEK_SHARED_MEMORY_DB, f.legacyMemoryDbPath); assert.equal(first.env.DOUYIN_STATE_DIR, stateDir);
  const plugin = f.resolve({ home: f.home, env: f.env }); assert.equal(plugin.memoryDbPath, first.paths.memoryDbPath);
  assert.equal(await f.hash(f.legacyMemoryDbPath), f.originalHash);
  const db = new DatabaseSync(f.legacyMemoryDbPath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT note FROM verification').get().note, '原有刷视频记忆'); } finally { db.close(); }
  await assert.rejects(fs.access(path.join(f.home, '.dsh', 'douyin-browser', 'memory')), { code: 'ENOENT' });
  const beforeSecond = await fs.readFile(f.file, 'utf8'); await f.run(); assert.equal(await fs.readFile(f.file, 'utf8'), beforeSecond);
  assert.equal(await f.hash(f.legacyMemoryDbPath), f.originalHash);
});

test('首次显式选择非标准数据库文件名后，插件与软件无需相同环境也解析同一个文件', async t => {
  const f = await fixture(t), custom = path.join(f.root, 'custom', 'video-notes.sqlite3');
  await fs.mkdir(path.dirname(custom)); await fs.copyFile(f.legacyMemoryDbPath, custom);
  await fs.writeFile(f.file, JSON.stringify({ version: 1, stateDir: path.join(f.root, 'shared-state') }));
  const selected = await f.run({ DEEPSEEK_SHARED_MEMORY_DB: custom });
  const registered = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.equal(registered.memoryDir, path.dirname(custom)); assert.equal(registered.memoryDbPath, custom); assert.equal(selected.paths.memoryDbPath, custom);
  const plugin = f.resolve({ home: f.home, env: f.env }); assert.equal(plugin.memoryDbPath, custom); assert.equal(plugin.memoryDir, selected.paths.memoryDir);
  assert.equal((await f.run()).env.DEEPSEEK_SHARED_MEMORY_DB, custom);
  assert.equal((await f.run({ DEEPSEEK_SHARED_MEMORY_DB: custom })).paths.memoryDbPath, custom);
  assert.equal(await f.hash(custom), f.originalHash); assert.equal(await f.hash(f.legacyMemoryDbPath), f.originalHash);
});

test('显式环境与已登记数据库冲突时拒绝启动，保留原记录且不创建另一套记忆', async t => {
  const f = await fixture(t), alternate = path.join(f.root, 'alternate-memory', 'different.db');
  const record = { version: 1, stateDir: path.join(f.root, 'shared-state'), memoryDir: path.dirname(f.legacyMemoryDbPath), memoryDbPath: f.legacyMemoryDbPath };
  const original = JSON.stringify(record, null, 2) + '\n'; await fs.writeFile(f.file, original);
  await assert.rejects(f.run({ DEEPSEEK_SHARED_MEMORY_DB: alternate }), /不一致/);
  assert.equal(await fs.readFile(f.file, 'utf8'), original); assert.equal(await f.hash(f.legacyMemoryDbPath), f.originalHash);
  await assert.rejects(fs.access(path.dirname(alternate)), { code: 'ENOENT' });
  await assert.rejects(f.run({ DEEPSEEK_SHARED_MEMORY_DB: 'relative.db' }), /绝对路径/);
  assert.equal(await fs.readFile(f.file, 'utf8'), original);
});

test('损坏记录、相对路径和目录数据库不一致均失败，不修写记录或改选默认库', async t => {
  const f = await fixture(t), valid = { version: 1, stateDir: path.join(f.root, 'state') };
  const cases = ['{broken', 'null', '[]', JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, stateDir: 'relative' }), JSON.stringify({ ...valid, memoryDir: 'relative' }), JSON.stringify({ ...valid, memoryDbPath: 'relative.db' }), JSON.stringify({ ...valid, memoryDir: path.join(f.root, 'other'), memoryDbPath: f.legacyMemoryDbPath })];
  for (const stored of cases) {
    await fs.writeFile(f.file, stored); await assert.rejects(f.run()); assert.equal(await fs.readFile(f.file, 'utf8'), stored);
    assert.equal(await f.hash(f.legacyMemoryDbPath), f.originalHash);
  }
  const files = await fs.readdir(f.root); assert.equal(files.some(file => file.endsWith('.tmp')), false);
});

test('新机器首次使用登记用户目录中的同一记忆位置，登记过程不提前创建空数据库', async t => {
  const f = await fixture(t); await fs.unlink(f.legacyMemoryDbPath);
  const selected = await ensureSharedLocation({ home: f.home, env: {}, resolve: f.resolve });
  const expectedDir = path.join(f.home, '.dsh', 'douyin-browser', 'memory'), expectedDb = path.join(expectedDir, 'shared.sqlite');
  const location = path.join(f.home, '.dsh', 'douyin-browser', 'runtime-location.json');
  const registered = JSON.parse(await fs.readFile(location, 'utf8'));
  assert.equal(registered.memoryDir, expectedDir); assert.equal(registered.memoryDbPath, expectedDb); assert.equal(selected.paths.memoryDbPath, expectedDb);
  assert.equal(f.resolve({ home: f.home, env: {} }).memoryDbPath, expectedDb);
  await assert.rejects(fs.access(expectedDb), { code: 'ENOENT' });
});
