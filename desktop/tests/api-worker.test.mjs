import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('../src/api-worker.mjs', import.meta.url));
const DOMAIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

async function workerFixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-worker-'));
  const ui = path.join(temporary, 'ui'), home = path.join(temporary, 'home'), qq = path.join(temporary, 'qq');
  for (const directory of [ui, home, qq]) fs.mkdirSync(directory);
  fs.writeFileSync(path.join(ui, 'index.html'), '<html>合成独立软件</html>'); fs.writeFileSync(path.join(ui, 'app.js'), 'globalThis.synthetic = true;');
  fs.writeFileSync(path.join(qq, '.env'), 'DEEPSEEK_API_KEY=synthetic-qq-key\nDEEPSEEK_BASE_URL=http://invalid-untrusted.example');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|comspec|pathext|programfiles|programfiles\(x86\)|programdata)$/i.test(key)));
  Object.assign(env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: home, APPDATA: home, DEEPSEEK_API_KEY: 'synthetic-environment-key', DEEPSEEK_BASE_URL: 'http://invalid-untrusted.example', DOUYIN_QQ_ROOT: qq, DOUYIN_RUNTIME_LOCATION_FILE: path.join(temporary, 'absent-location.json'), DOUYIN_STATE_DIR: path.join(temporary, 'state'), DEEPSEEK_SHARED_MEMORY_DB: path.join(temporary, 'memory', 'shared.sqlite'), DOUYIN_MEDIA_ENV_FILE: path.join(temporary, 'absent-media.env'), DOUYIN_MEDIA_SETTINGS_FILE: path.join(temporary, 'media-settings.json'), DOUYIN_MEDIA_RUNTIME_ROOT: path.join(temporary, 'media-runtime'), DOUYIN_MEDIA_MODELS_DIR: path.join(temporary, 'models'), DOUYIN_NODE_EXECUTABLE: process.execPath });
  const child = fork(WORKER, [], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = once(child, 'exit'); let output = ''; const messages = [], requests = new Map(); let sequence = 0;
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.on('message', message => { messages.push(message); const request = requests.get(message.requestId); if (message.type === 'response' && request) { requests.delete(message.requestId); clearTimeout(request.timer); request.resolve(message); } });
  child.on('exit', code => { for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error(`合成后台提前退出：${code}`)); } requests.clear(); });
  const request = (type, payload = {}) => new Promise((resolve, reject) => {
    const requestId = `test:${++sequence}`;
    const timer = setTimeout(() => { requests.delete(requestId); reject(new Error('合成后台 IPC 超时。')); }, 10_000);
    requests.set(requestId, { resolve, reject, timer }); child.send({ type, requestId, ...payload });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { if (child.connected) { await request('stop').catch(() => {}); } else child.kill(); await exited; }
    const target = path.resolve(temporary), parent = path.resolve(os.tmpdir()); if (!target.startsWith(parent + path.sep)) throw new Error('测试目录越界。');
    fs.rmSync(target, { recursive: true, force: true });
  });
  const options = { config: {}, htmlFile: path.join(ui, 'index.html'), staticRoot: ui, domainRoot: DOMAIN_ROOT };
  return { child, exited, messages, request, options, temporary, home, env, output: () => output };
}

test('真实独立 Node 后台用临时端口启动，忽略环境和 QQ 凭据，换密钥只走 IPC', { timeout: 20_000 }, async t => {
  const f = await workerFixture(t);
  const startup = await f.request('start', { options: f.options }); assert.equal(startup.ok, true, startup.error);
  const { port, pid, config } = startup.result; assert.ok(port >= 1024 && port <= 65535); assert.equal(pid, f.child.pid);
  assert.deepEqual(config, { configured: false, model: 'deepseek-flash', keySource: '未配置' }); assert.ok(f.messages.some(message => message.type === 'ready' && message.port === port));
  const base = `http://127.0.0.1:${port}`;
  const html = await fetch(base); assert.match(await html.text(), /合成独立软件/); assert.equal((await fetch(`${base}/app.js`)).status, 200);
  let bootstrap = await (await fetch(`${base}/api/bootstrap`)).json(); assert.equal(bootstrap.config.configured, false);
  assert.equal(bootstrap.memory.folder, path.join(f.temporary, 'memory')); assert.equal(bootstrap.memory.database, path.join(f.temporary, 'memory', 'shared.sqlite'));
  assert.equal((await fetch(`${base}/api/state`)).status, 403);
  const changed = await f.request('configure', { config: { apiKey: 'synthetic-ipc-key', model: 'synthetic-model', baseUrl: 'https://synthetic.example/v1' } });
  assert.deepEqual(changed.result, { configured: true, model: 'synthetic-model', keySource: '本机 API 设置' });
  assert.deepEqual((await f.request('get-config')).result, changed.result);
  const invalid = await f.request('configure', { config: { apiKey: 'invalid whitespace' } }); assert.equal(invalid.ok, false); assert.equal((await f.request('get-config')).result.configured, true);
  bootstrap = await (await fetch(`${base}/api/bootstrap`)).json(); assert.deepEqual(bootstrap.config, changed.result);
  const headers = { 'content-type': 'application/json', 'x-session-token': bootstrap.token };
  const body = await (await fetch(`${base}/api/state`, { headers })).json(); assert.equal(body.running, false);
  const allPublic = JSON.stringify({ messages: f.messages, bootstrap, body, output: f.output() });
  for (const secret of ['synthetic-qq-key', 'synthetic-environment-key', 'synthetic-ipc-key']) assert.equal(allPublic.includes(secret), false);
  assert.equal(fs.existsSync(path.join(f.home, '.dsh', 'douyin-browser', 'control', 'browser.json')), false);
  assert.equal((await f.request('stop')).ok, true); assert.deepEqual(await f.exited, [0, null]);
  await assert.rejects(fetch(base));
});

test('主软件断开 IPC 后独立后台自动关闭，未启动或首页越界也能结束', { timeout: 20_000 }, async t => {
  const f = await workerFixture(t);
  const notReady = await f.request('get-config'); assert.equal(notReady.ok, false);
  const outside = path.join(f.temporary, 'outside.html'); fs.writeFileSync(outside, '合成越界首页');
  const invalid = await f.request('start', { options: { ...f.options, htmlFile: outside } }); assert.equal(invalid.ok, false); assert.match(invalid.error, /资源目录内/);
  const startup = await f.request('start', { options: f.options }); assert.equal(startup.ok, true, startup.error);
  const base = `http://127.0.0.1:${startup.result.port}`; assert.equal((await fetch(base)).status, 200);
  f.child.disconnect(); assert.deepEqual(await f.exited, [0, null]); await assert.rejects(fetch(base));
});
