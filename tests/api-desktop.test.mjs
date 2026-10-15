import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { normalizeApiConfig, publicApiConfig } from '../api-agent.mjs';
import { createApiServer } from '../app.mjs';

async function fixture(t, overrides = {}) {
  const config = normalizeApiConfig({ apiKey: 'synthetic-original-key' });
  const agent = { config, runTask: async () => ({ status: 'completed', message: '合成任务已完成。' }) };
  const chatService = { config, agent: { config }, close: async () => {}, worker: () => null };
  const server = createApiServer({ config, agent, chatService, controller: { execute: async () => ({}), close: async () => {} }, port: 0, ...overrides });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  return { server, config, agent, chatService, base, bootstrap, headers: { 'content-type': 'application/json', 'x-session-token': bootstrap.token } };
}

test('软件设置是纯输入配置，空设置不借用环境凭据，地址和模型有明确校验', () => {
  assert.deepEqual(normalizeApiConfig({}), { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', keySource: '未配置' });
  const value = normalizeApiConfig({ apiKey: '  synthetic-key  ', baseUrl: ' https://api.example.com/v1/ ', model: ' vendor/model:1 ' });
  assert.equal(value.apiKey, 'synthetic-key'); assert.equal(value.baseUrl, 'https://api.example.com/v1'); assert.equal(value.model, 'vendor/model:1');
  assert.deepEqual(Object.keys(publicApiConfig(value)).sort(), ['configured', 'keySource', 'model']);
  for (const input of [null, [], { extra: true }, { apiKey: 1 }, { apiKey: 'has whitespace' }, { apiKey: 'x'.repeat(4097) }, { baseUrl: 'http://example.com' }, { baseUrl: 'https://user:password@example.com' }, { baseUrl: 'https://example.com?secret=1' }, { baseUrl: 'file:///tmp/api' }, { model: 'bad model' }, { model: 'a'.repeat(129) }]) assert.throws(() => normalizeApiConfig(input));
  assert.equal(normalizeApiConfig({ baseUrl: 'http://127.0.0.1:43210/v1' }).baseUrl, 'http://127.0.0.1:43210/v1');
});

test('进程内切换设置原位同步三个服务，HTTP 只回公开信息且不接受写入密钥', async t => {
  const f = await fixture(t); const original = f.config;
  const publicValue = f.server.configureApi({ apiKey: 'synthetic-replacement-key', model: 'custom-model', baseUrl: 'https://api.example.com/v1' });
  assert.equal(f.agent.config, original); assert.equal(f.chatService.config, original); assert.equal(f.chatService.agent.config, original);
  assert.equal(original.apiKey, 'synthetic-replacement-key'); assert.equal(original.baseUrl, 'https://api.example.com/v1');
  assert.deepEqual(publicValue, { configured: true, model: 'custom-model', keySource: '本机 API 设置' });
  const beforeInvalid = { ...original }; assert.throws(() => f.server.configureApi({ apiKey: 'bad whitespace' })); assert.deepEqual(original, beforeInvalid);
  const bootstrap = await (await fetch(`${f.base}/api/bootstrap`)).json();
  assert.deepEqual(bootstrap.config, publicValue); assert.equal(typeof bootstrap.memory.folder, 'string'); assert.equal(typeof bootstrap.memory.database, 'string');
  assert.equal(JSON.stringify(bootstrap).includes(original.apiKey), false); assert.equal(JSON.stringify(bootstrap).includes(original.baseUrl), false);
  const httpConfig = await fetch(`${f.base}/api/configure`, { method: 'POST', headers: f.headers, body: JSON.stringify({ apiKey: 'http-key-not-accepted' }) });
  assert.equal(httpConfig.status, 404); assert.equal(original.apiKey, beforeInvalid.apiKey);
  assert.deepEqual(f.server.configureApi({}), { configured: false, model: 'deepseek-flash', keySource: '未配置' }); assert.equal(original.apiKey, '');
});

test('视频任务和私信进程忙碌时拒绝换密钥，停止后才接受；任务回读也会隐藏密钥', async t => {
  const entered = Promise.withResolvers();
  const f = await fixture(t);
  f.agent.runTask = async ({ signal }) => {
    entered.resolve(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { status: 'stopped', message: `已停止 ${f.config.apiKey}` };
  };
  const response = await fetch(`${f.base}/api/task`, { method: 'POST', headers: f.headers, body: JSON.stringify({ instruction: `合成任务 ${f.config.apiKey}` }) });
  assert.equal(response.status, 202); await response.json(); await entered.promise;
  assert.throws(() => f.server.configureApi({ apiKey: 'synthetic-next' }), /先停止/);
  await (await fetch(`${f.base}/api/stop`, { method: 'POST', headers: f.headers, body: '{}' })).json();
  let state;
  for (let attempt = 0; attempt < 50; attempt++) {
    state = await (await fetch(`${f.base}/api/state`, { headers: f.headers })).json();
    if (!state.running) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(state.running, false); assert.equal(JSON.stringify(state).includes(f.config.apiKey), false);
  for (const field of ['running', 'starting', 'busy']) { f.chatService[field] = true; assert.throws(() => f.server.configureApi({}), /先停止/); f.chatService[field] = false; }
  f.chatService.worker = () => ({ alive: true }); assert.throws(() => f.server.configureApi({}), /先停止/);
  f.chatService.worker = () => null; assert.equal(f.server.configureApi({ apiKey: 'synthetic-next' }).configured, true);
});

test('转发正在核对联系人时也不能切换 API 设置，合成确认结束后解除占用', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const contact = { id: 'synthetic-friend', followed: true, isGroup: false };
  const chatService = { state: () => ({ policy: { allowlist: [contact] } }), listContacts: async () => { entered.resolve(); await release.promise; return { contacts: [contact] }; }, close: async () => {} };
  const videoLimits = { watch: () => () => {}, beforeAction: () => ({ allowed: true }), enforce: async () => {} };
  const f = await fixture(t, { chatService, videoLimits });
  const pending = fetch(`${f.base}/api/forward`, { method: 'POST', headers: f.headers, body: JSON.stringify({ recipientId: contact.id }) });
  await entered.promise;
  try { assert.throws(() => f.server.configureApi({ apiKey: 'synthetic-next' }), /先停止/); }
  finally { release.resolve(); }
  const response = await pending; assert.equal(response.status, 200); await response.json();
  assert.equal(f.server.configureApi({ apiKey: 'synthetic-next' }).configured, true);
});

test('独立界面资源同源读取，目录穿越、越界链接、未列明类型和跨来源均被拒绝', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-static-')); const root = path.join(temporary, 'ui');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true }); fs.mkdirSync(path.join(temporary, 'outside'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>合成软件界面</html>'); fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'globalThis.synthetic = true;');
  fs.writeFileSync(path.join(root, '.env'), 'SYNTHETIC_PRIVATE_VALUE=hidden'); fs.writeFileSync(path.join(temporary, 'outside', 'private.js'), 'outside-value');
  fs.symlinkSync(path.join(temporary, 'outside'), path.join(root, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const f = await fixture(t, { htmlFile: path.join(root, 'index.html'), staticRoot: root });
  t.after(() => { if (!path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界。'); fs.rmSync(temporary, { recursive: true, force: true }); });
  const html = await fetch(f.base); assert.match(await html.text(), /合成软件界面/);
  const script = await fetch(`${f.base}/assets/app.js`); assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/); assert.match(script.headers.get('content-security-policy'), /connect-src 'self'/);
  for (const route of ['/assets/missing.js', '/.env', '/%2e%2e%2foutside%2fprivate.js', '/outside-link/private.js', '/assets/%00app.js']) assert.equal((await fetch(f.base + route)).status, 404, route);
  assert.equal((await fetch(`${f.base}/assets/app.js`, { headers: { origin: 'https://example.com' } })).status, 403);
});
