import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveRuntimePaths, resolveNodeExecutable } from '../runtime-paths.mjs';
import { MediaAdapter, loadMediaConfig } from '../media/index.mjs';

const run = promisify(execFile);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, location: path.join(root, 'runtime-location.json'), sourceRoot: path.join(root, 'source'), home: path.join(root, 'home') };
}
function location(f) {
  return { version: 1, stateDir: path.join(f.root, 'shared-state'), mediaEnvFile: path.join(f.root, 'audio.env'), mediaSettingsFile: path.join(f.root, 'media-settings.json'), mediaRuntimeRoot: path.join(f.root, 'media-runtime'), mediaModelsDir: path.join(f.root, 'models') };
}
test('缺少位置记录时保留旧默认值，解析过程不创建目录', t => {
  const f = fixture(t), before = fs.readdirSync(f.root);
  const resolved = resolveRuntimePaths({ env: { DOUYIN_RUNTIME_LOCATION_FILE: f.location, DSH_HOME: path.join(f.root, 'independent-app') }, sourceRoot: f.sourceRoot, home: f.home });
  assert.equal(resolved.stateDir, path.join(f.sourceRoot, 'state'));
  assert.equal(resolved.mediaEnvFile, path.join(f.sourceRoot, 'media', '.env'));
  assert.equal(resolved.mediaSettingsFile, path.join(f.sourceRoot, 'media', 'settings.local.json'));
  assert.equal(resolved.mediaModelsDir, path.join(f.sourceRoot, 'media', '.models'));
  assert.equal(resolved.browserProfileDir, path.join(f.home, '.dsh', 'douyin-browser', 'cli-profile'));
  assert.deepEqual(fs.readdirSync(f.root), before);
});
test('全用户位置记录不跟随独立 DSH_HOME，环境变量按字段优先覆盖', t => {
  const f = fixture(t), stored = location(f), override = path.join(f.root, 'explicit-state');
  fs.mkdirSync(path.join(f.home, '.dsh', 'douyin-browser'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.dsh', 'douyin-browser', 'runtime-location.json'), JSON.stringify(stored));
  const resolved = resolveRuntimePaths({ env: { DSH_HOME: path.join(f.root, 'app-home'), DOUYIN_STATE_DIR: override }, sourceRoot: f.sourceRoot, home: f.home });
  assert.equal(resolved.stateDir, override);
  for (const field of ['mediaEnvFile', 'mediaSettingsFile', 'mediaRuntimeRoot', 'mediaModelsDir']) assert.equal(resolved[field], stored[field]);
  assert.equal(resolved.mediaCaptureDir, path.join(override, 'media-captures'));
});
test('损坏、未知版本和相对路径拒绝，不能静默退回另一套 worker 或时钟', t => {
  const f = fixture(t), options = { env: { DOUYIN_RUNTIME_LOCATION_FILE: f.location }, sourceRoot: f.sourceRoot, home: f.home };
  for (const stored of ['坏记录', JSON.stringify({ ...location(f), version: 2 }), JSON.stringify({ ...location(f), stateDir: 'relative' }), JSON.stringify({ ...location(f), mediaSettingsFile: '../settings' })]) {
    fs.writeFileSync(f.location, stored); assert.throws(() => resolveRuntimePaths(options), /运行位置记录/);
  }
  fs.unlinkSync(f.location);
  assert.throws(() => resolveRuntimePaths({ ...options, env: { ...options.env, DOUYIN_STATE_DIR: 'relative' } }), /绝对路径/);
  assert.throws(() => resolveRuntimePaths({ ...options, env: { DOUYIN_RUNTIME_LOCATION_FILE: 'relative' } }), /绝对路径/);
});
test('可信 Node 入口只接收绝对路径，显式无效配置不会误启动桌面 EXE', t => {
  const f = fixture(t);
  assert.equal(resolveNodeExecutable({ env: {}, executable: process.execPath, versions: {} }), process.execPath);
  assert.equal(resolveNodeExecutable({ env: { DOUYIN_NODE_EXECUTABLE: process.execPath }, executable: 'desktop.exe', versions: { electron: 'synthetic' } }), process.execPath);
  assert.throws(() => resolveNodeExecutable({ env: {}, sourceRoot: f.sourceRoot, resourcesPath: f.root, versions: { electron: 'synthetic' } }), /DOUYIN_NODE_EXECUTABLE/);
  assert.throws(() => resolveNodeExecutable({ env: { DOUYIN_NODE_EXECUTABLE: 'node.exe' } }), /绝对路径/);
  assert.throws(() => resolveNodeExecutable({ env: { DOUYIN_NODE_EXECUTABLE: process.execPath }, executable: process.execPath, versions: { electron: 'synthetic' } }), /独立 Node/);
  assert.throws(() => resolveNodeExecutable({ env: { DOUYIN_NODE_EXECUTABLE: path.join(f.root, 'missing-node.exe') } }), /独立 Node/);
});

function linkNodeDirectory(destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.symlinkSync(path.dirname(process.execPath), destination, process.platform === 'win32' ? 'junction' : 'dir');
  return path.join(destination, path.basename(process.execPath));
}
test('DSH Electron 自动复用源码已有独立 Node，不要求用户配置环境变量', t => {
  const f = fixture(t), cached = linkNodeDirectory(path.join(f.sourceRoot, 'desktop', '.cache', 'generated', 'node'));
  const result = resolveNodeExecutable({ env: { NODE_OPTIONS: '--invalid-inherited-options' }, executable: path.join(f.root, 'DSH Desktop.exe'), versions: { electron: 'synthetic' }, sourceRoot: f.sourceRoot, resourcesPath: f.root });
  assert.equal(result, cached);
  assert.equal(fs.existsSync(path.join(f.root, 'DSH Desktop.exe')), false);
});
test('Electron 优先使用软件随包 Node，也可回落到 PATH 的现有 Node', t => {
  const f = fixture(t), packaged = linkNodeDirectory(path.join(f.root, 'resources', 'runtime', 'node'));
  const options = { env: { Path: path.dirname(process.execPath) }, executable: path.join(f.root, 'DSH Desktop.exe'), versions: { electron: 'synthetic' }, sourceRoot: f.sourceRoot };
  assert.equal(resolveNodeExecutable({ ...options, resourcesPath: path.join(f.root, 'resources') }), packaged);
  assert.equal(resolveNodeExecutable({ ...options, resourcesPath: undefined }), process.execPath);
});
test('PATH 中相对目录不会成为桌面浏览器的 Node 程序来源', t => {
  const f = fixture(t);
  assert.throws(() => resolveNodeExecutable({ env: { PATH: '.' }, executable: path.join(f.root, 'DSH Desktop.exe'), versions: { electron: 'synthetic' }, sourceRoot: f.sourceRoot, resourcesPath: f.root }), /未找到独立 Node/);
});

test('共享记忆按显式数据库、全用户定位器、已有旧库、同一用户默认目录选择', t => {
  const f = fixture(t), legacy = path.join(f.root, 'existing-memory', 'shared.sqlite');
  const options = { env: { DOUYIN_RUNTIME_LOCATION_FILE: f.location, DSH_HOME: path.join(f.root, 'isolated-host') }, sourceRoot: f.sourceRoot, home: f.home, legacyMemoryDbPath: legacy };
  const fallback = path.join(f.home, '.dsh', 'douyin-browser', 'memory', 'shared.sqlite');
  assert.equal(resolveRuntimePaths(options).memoryDbPath, fallback);
  assert.equal(fs.existsSync(path.dirname(fallback)), false);
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '合成旧库占位，不会被解析器打开或修改');
  assert.equal(resolveRuntimePaths(options).memoryDbPath, legacy);
  const stored = { ...location(f), memoryDir: path.join(f.root, 'canonical-memory') };
  fs.writeFileSync(f.location, JSON.stringify(stored));
  assert.equal(resolveRuntimePaths(options).memoryDbPath, path.join(stored.memoryDir, 'shared.sqlite'));
  const explicit = path.join(f.root, 'explicit', 'central.sqlite');
  const selected = resolveRuntimePaths({ ...options, env: { ...options.env, DEEPSEEK_SHARED_MEMORY_DB: explicit } });
  assert.equal(selected.memoryDbPath, explicit);
  assert.equal(selected.memoryDir, path.dirname(explicit));
  assert.equal(fs.readFileSync(legacy, 'utf8'), '合成旧库占位，不会被解析器打开或修改');
  assert.equal(fs.existsSync(stored.memoryDir), false);
  assert.equal(fs.existsSync(path.dirname(explicit)), false);
});

test('旧版定位器仍可读，共享记忆的非法定位拒绝回落到另一套库', t => {
  const f = fixture(t), legacy = path.join(f.root, 'missing.sqlite');
  const options = { env: { DOUYIN_RUNTIME_LOCATION_FILE: f.location }, home: f.home, sourceRoot: f.sourceRoot, legacyMemoryDbPath: legacy };
  fs.writeFileSync(f.location, JSON.stringify(location(f)));
  assert.equal(resolveRuntimePaths(options).memoryDir, path.join(f.home, '.dsh', 'douyin-browser', 'memory'));
  for (const memoryDir of ['relative', `${f.root}\ninvalid`, null]) {
    fs.writeFileSync(f.location, JSON.stringify({ ...location(f), memoryDir }));
    assert.throws(() => resolveRuntimePaths(options), /运行位置记录/);
  }
  fs.writeFileSync(f.location, JSON.stringify(location(f)));
  assert.throws(() => resolveRuntimePaths({ ...options, env: { ...options.env, DEEPSEEK_SHARED_MEMORY_DB: 'relative.sqlite' } }), /共享记忆数据库.*绝对路径/);
  fs.mkdirSync(legacy);
  assert.throws(() => resolveRuntimePaths(options), /已有共享记忆路径不是文件/);
});

test('定位器精确保留自定义数据库文件名，并拒绝目录与文件位置不一致', t => {
  const f = fixture(t), memoryDir = path.join(f.root, 'shared'), memoryDbPath = path.join(memoryDir, 'custom-central.sqlite');
  const options = { env: { DOUYIN_RUNTIME_LOCATION_FILE: f.location }, home: f.home, sourceRoot: f.sourceRoot, legacyMemoryDbPath: path.join(f.root, 'missing.sqlite') };
  fs.writeFileSync(f.location, JSON.stringify({ ...location(f), memoryDir, memoryDbPath }));
  assert.equal(resolveRuntimePaths(options).memoryDbPath, memoryDbPath);
  const explicit = path.join(f.root, 'override.sqlite');
  assert.equal(resolveRuntimePaths({ ...options, env: { ...options.env, DEEPSEEK_SHARED_MEMORY_DB: explicit } }).memoryDbPath, explicit);
  fs.writeFileSync(f.location, JSON.stringify({ ...location(f), memoryDbPath }));
  assert.equal(resolveRuntimePaths(options).memoryDir, memoryDir);
  for (const invalid of ['relative.sqlite', `${memoryDbPath}\ninvalid`, null]) {
    fs.writeFileSync(f.location, JSON.stringify({ ...location(f), memoryDbPath: invalid }));
    assert.throws(() => resolveRuntimePaths(options), /运行位置记录/);
  }
  fs.writeFileSync(f.location, JSON.stringify({ ...location(f), memoryDir: path.join(f.root, 'another'), memoryDbPath }));
  assert.throws(() => resolveRuntimePaths(options), /运行位置记录/);
  assert.equal(fs.existsSync(memoryDir), false);
});
test('媒体环境、设置和模型目录跟随定位器，源码资源保持原位且音频默认关闭', async t => {
  const f = fixture(t), stored = location(f);
  fs.writeFileSync(f.location, JSON.stringify(stored));
  fs.writeFileSync(stored.mediaEnvFile, 'DOUYIN_MEDIA_WHISPER_MODEL=tiny.en\n');
  const config = await loadMediaConfig({ env: { DOUYIN_RUNTIME_LOCATION_FILE: f.location } });
  assert.equal(config.DOUYIN_MEDIA_WHISPER_MODEL, 'tiny.en');
  const oldLocation = process.env.DOUYIN_RUNTIME_LOCATION_FILE;
  process.env.DOUYIN_RUNTIME_LOCATION_FILE = f.location;
  try {
    const adapter = new MediaAdapter({ config });
    assert.equal(adapter.settingsFile, stored.mediaSettingsFile);
    assert.equal((await adapter.settings()).enabled, false);
    assert.equal((await adapter.runtime()).modelsDir, stored.mediaModelsDir);
    await adapter.saveSettings({ enabled: false, backend: 'local-whisper' }, { explicit: true });
    assert.equal(JSON.parse(fs.readFileSync(stored.mediaSettingsFile, 'utf8')).enabled, false);
    assert.equal(fs.existsSync(path.join(f.sourceRoot, 'media')), false);
  } finally {
    if (oldLocation === undefined) delete process.env.DOUYIN_RUNTIME_LOCATION_FILE;
    else process.env.DOUYIN_RUNTIME_LOCATION_FILE = oldLocation;
  }
});
test('独立 Node 入口以同一位置记录打开 API 和 DSH 时限、许可名单及转发收据', async t => {
  const f = fixture(t), stored = location(f);
  fs.writeFileSync(f.location, JSON.stringify(stored));
  const modules = Object.fromEntries(['video-limits', 'chat-service', 'video-forward'].map(name => [name, new URL(`../${name}.mjs`, import.meta.url).href]));
  const script = `
    import {VideoLimits} from ${JSON.stringify(modules['video-limits'])};
    import {ChatService} from ${JSON.stringify(modules['chat-service'])};
    import {VideoForwarder} from ${JSON.stringify(modules['video-forward'])};
    const api=new VideoLimits(), dsh=new VideoLimits();
    const session=api.markSession('api',{explicit:true});
    const browser={listContacts:async()=>({contacts:[]}),readConversation:async()=>({messages:[]}),sendMessage:async()=>{throw new Error('测试禁止发送')}};
    const chat=new ChatService({browser,config:{apiKey:'',model:'synthetic'}});
    const forward=new VideoForwarder({controller:{source:'dsh'},chatBrowser:browser});
    console.log(JSON.stringify({sameClock:dsh.state().session.id===session.session.id,apiDir:api.stateDir,chatDir:chat.stateDir,forwardDir:forward.stateDir,policyShared:chat.policyFile===forward.policyFile}));
    await chat.close();
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, DOUYIN_RUNTIME_LOCATION_FILE: f.location, DOUYIN_STATE_DIR: '', DSH_HOME: path.join(f.root, 'app-home') }, timeout: 15_000 });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.sameClock, true); assert.equal(result.policyShared, true);
  for (const field of ['apiDir', 'chatDir', 'forwardDir']) assert.equal(result[field], stored.stateDir);
  assert.equal(fs.existsSync(path.join(f.sourceRoot, 'state')), false);
});
