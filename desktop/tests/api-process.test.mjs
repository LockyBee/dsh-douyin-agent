import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiProcess } from '../src/api-process.mjs';
import { ensureSharedLocation } from '../src/prepare-api-runtime.mjs';
import { DOMAIN_FILES } from '../scripts/stage-api-runtime.mjs';
import { resolveRuntimePaths } from '../../runtime-paths.mjs';

const DOMAIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-api-process-'));
  const runtime = path.join(temporary, 'runtime'), home = path.join(temporary, 'home'), ui = path.join(runtime, 'public');
  await fs.mkdir(ui, { recursive: true }); await fs.mkdir(home);
  await fs.writeFile(path.join(ui, 'index.html'), '<html>合成软件界面</html>');
  await fs.writeFile(path.join(runtime, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const relative of [...DOMAIN_FILES, 'media/index.mjs', 'media/key-store.mjs', 'media/vendor/voice/lib/providers.js', 'media/vendor/voice/lib/provider-http.js']) {
    const target = path.join(runtime, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(DOMAIN_ROOT, relative), target);
  }
  await fs.copyFile(fileURLToPath(new URL('../src/api-worker.mjs', import.meta.url)), path.join(runtime, 'api-worker.mjs'));
  await fs.symlink(path.join(DOMAIN_ROOT, 'node_modules'), path.join(runtime, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const locationFile = path.join(temporary, 'location.json');
  const record = { version: 1, stateDir: path.join(temporary, 'shared-state'), memoryDir: path.join(temporary, 'shared-memory'), mediaEnvFile: path.join(temporary, 'audio.env'), mediaSettingsFile: path.join(temporary, 'audio-settings.json'), mediaRuntimeRoot: path.join(temporary, 'audio-runtime'), mediaModelsDir: path.join(temporary, 'audio-models') };
  await fs.writeFile(locationFile, JSON.stringify(record));
  const shared = await ensureSharedLocation({ home, env: { DOUYIN_RUNTIME_LOCATION_FILE: locationFile }, resolve: resolveRuntimePaths });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|comspec|pathext|programfiles|programfiles\(x86\)|programdata)$/i.test(key)));
  Object.assign(env, shared.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: home, APPDATA: home, DOUYIN_NODE_EXECUTABLE: process.execPath, DEEPSEEK_API_KEY: 'synthetic-parent-env-key', DEEPSEEK_BASE_URL: 'http://invalid-untrusted.example', NODE_OPTIONS: '--invalid-parent-node-options' });
  const backend = new ApiProcess(process.execPath, runtime, { env, timeoutMs: 10_000 });
  t.after(async () => {
    await backend.stop();
    const target = path.resolve(temporary); if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界。');
    await fs.rm(target, { recursive: true, force: true });
  });
  return { backend, temporary, runtime, home, shared, record, locationFile };
}

test('软件调用器真实启动独立后台，设置不回读 Key，两个入口解析同一记忆库，退出释放端口', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const started = await f.backend.start({}); assert.equal(started.pid, f.backend.child.pid);
  assert.deepEqual(started.config, { configured: false, model: 'deepseek-flash', keySource: '未配置' });
  assert.equal(f.backend.origin, `http://127.0.0.1:${started.port}`);
  assert.equal(f.backend.child.spawnargs.join('\n').includes('synthetic-parent-env-key'), false);
  const changed = await f.backend.configure({ apiKey: 'synthetic-process-secret', model: 'synthetic-model', baseUrl: 'https://synthetic.example/v1' });
  assert.deepEqual(changed, { configured: true, model: 'synthetic-model', keySource: '本机 API 设置' }); assert.deepEqual(await f.backend.getConfig(), changed);
  await assert.rejects(f.backend.configure({ apiKey: 'bad whitespace' }), /空白/); assert.deepEqual(await f.backend.getConfig(), changed);
  const bootstrap = await (await fetch(`${f.backend.origin}/api/bootstrap`)).json(); assert.deepEqual(bootstrap.config, changed);
  const pluginPaths = resolveRuntimePaths({ env: { DOUYIN_RUNTIME_LOCATION_FILE: f.locationFile }, home: f.home });
  assert.equal(bootstrap.memory.folder, pluginPaths.memoryDir); assert.equal(bootstrap.memory.database, pluginPaths.memoryDbPath); assert.equal(pluginPaths.memoryDir, f.record.memoryDir);
  const headers = { 'x-session-token': bootstrap.token };
  const recall = await fetch(`${f.backend.origin}/api/memory?query=${encodeURIComponent('不存在的合成笔记')}`, { headers }); assert.equal(recall.status, 200);
  const result = await recall.json(); assert.equal((await fs.stat(pluginPaths.memoryDbPath)).isFile(), true);
  const state = await (await fetch(`${f.backend.origin}/api/state`, { headers })).json();
  const publicValues = JSON.stringify({ started, changed, bootstrap, result, state, stderr: f.backend.stderr, spawnargs: f.backend.child.spawnargs });
  for (const key of ['synthetic-process-secret', 'synthetic-parent-env-key']) assert.equal(publicValues.includes(key), false);
  const stopped = f.backend.stop(); assert.equal(stopped, f.backend.stop()); await stopped;
  assert.equal(f.backend.exitCode, 0); assert.equal(f.backend.pending.size, 0); assert.equal(f.backend.secrets.size, 0);
  await assert.rejects(fetch(f.backend.origin)); await assert.rejects(f.backend.getConfig(), /没有连接/);
});

test('调用器启动错误时会让真实后台退出，不遗留 IPC 请求或监听端口', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const outside = path.join(f.temporary, 'outside.html'); await fs.writeFile(outside, '合成越界首页');
  await assert.rejects(f.backend.start({}, { htmlFile: outside }), /资源目录内/);
  assert.equal(f.backend.exitCode, 0); assert.equal(f.backend.pending.size, 0); assert.equal(f.backend.child.connected, false);
  assert.equal(f.backend.origin, undefined); await f.backend.stop();
});
