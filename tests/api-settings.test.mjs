import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createApiServer } from '../app.mjs';
import { VideoLimits } from '../video-limits.mjs';
import { ApiAgent } from '../api-agent.mjs';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-api-settings-'));
  let clock = Date.parse('2026-10-14T02:00:00Z');
  const videoLimits = new VideoLimits({ stateDir: directory, now: () => clock });
  const contacts = [{ id: 'synthetic-friend', name: '合成好友', followed: true, isGroup: false }, { id: 'synthetic-other', name: '名单外合成好友', followed: true, isGroup: false }, { id: 'synthetic-group', name: '合成群聊', followed: true, isGroup: true }];
  let allowlist = [contacts[0]]; let settings = { enabled: false, backend: 'local-whisper' }; const settingsCalls = []; const executes = []; let executor = async () => ({ confirmed: true }); let contactsHook = async () => {};
  const chatService = { state: () => ({ policy: { allowlist, dailyReplyLimit: 40 }, daily: { requests: 0, limit: 40 }, running: false, contacts: [], events: [], pollSeconds: 15, replyTokens: 512 }), listContacts: async () => { await contactsHook(); return { contacts }; }, close: async () => {} };
  const mediaAdapter = { status: async () => ({ ...settings, backends: { 'local-whisper': { available: true }, minimax: { available: false }, mimo: { available: false } } }), saveSettings: async (value, options) => { settingsCalls.push({ value, options }); settings = { ...value }; } };
  const controller = { execute: async (name, args, options) => { executes.push({ name, args, options }); return executor(name, args, options); } };
  const config = { apiKey: 'synthetic-api-key', model: 'deepseek-flash' };
  const server = createApiServer({ controller, config, chatService, videoLimits, mediaAdapter, port: 0, pauseVideoSources: async () => ({ paused: true }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); const target = path.resolve(directory); if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界。'); fs.rmSync(target, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`; const bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const headers = { 'x-session-token': bootstrap.token, 'content-type': 'application/json' };
  const request = async (route, body) => { const response = await fetch(base + route, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; };
  return { base, server, headers, bootstrap, request, videoLimits, executes, settingsCalls, config, advance: value => { clock += value; }, settings: () => settings, allow: value => { allowlist = value; }, setExecutor: value => { executor = value; }, setContactsHook: value => { contactsHook = value; } };
}

test('音频默认关闭，只有本机会话按钮请求可保存有效后端，不接受凭据或隐含启用', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/media/state')).status, 403);
  assert.deepEqual(f.settings(), { enabled: false, backend: 'local-whisper' });
  assert.equal((await f.request('/api/media/configure', { enabled: true, backend: 'other' })).status, 400);
  assert.equal((await f.request('/api/media/configure', { backend: 'mimo' })).status, 400);
  assert.equal((await f.request('/api/media/configure', { enabled: true, backend: 'mimo', apiKey: 'never-store-this' })).status, 400);
  assert.equal(f.settingsCalls.length, 0);
  const changed = await f.request('/api/media/configure', { enabled: true, backend: 'mimo' });
  assert.equal(changed.status, 200); assert.equal(changed.body.enabled, true); assert.equal(changed.body.backends.mimo.available, false);
  assert.deepEqual(f.settingsCalls[0], { value: { enabled: true, backend: 'mimo' }, options: { explicit: true } });
  assert.equal(JSON.stringify(changed.body).includes(f.config.apiKey), false);
  await f.request('/api/media/configure', { enabled: false, backend: 'local-whisper' }); assert.equal(f.settings().enabled, false);
});

test('转发列表只含已许可的个人好友；未开始、名单外和非法链接都不执行发送', async t => {
  const f = await fixture(t); const list = await f.request('/api/forward/contacts');
  assert.deepEqual(list.body.contacts.map(item => item.id), ['synthetic-friend']);
  assert.equal((await f.request('/api/forward', { recipientId: 'synthetic-friend' })).status, 409);
  f.videoLimits.markSession('api', { explicit: true });
  assert.equal((await f.request('/api/forward', { recipientId: 'synthetic-other' })).status, 403);
  for (const url of ['http://www.douyin.com/video/1234567890123', 'https://evil.example/video/1234567890123', 'https://www.douyin.com@evil.example/video/1234567890123', 'https://www.douyin.com/video/123', 'https://www.douyin.com:444/video/1234567890123', 'https://user@www.douyin.com/video/1234567890123']) assert.equal((await f.request('/api/forward', { recipientId: 'synthetic-friend', url })).status, 400);
  assert.equal((await f.request('/api/forward', { recipientId: 'synthetic-friend', humanAuthorized: true })).status, 400);
  assert.equal(f.executes.length, 0);
});

test('明确按钮转发传可信 humanAuthorized；链接去掉查询串，当前作品不附 URL，视频模型没有此工具', async t => {
  const f = await fixture(t); f.videoLimits.markSession('api', { explicit: true });
  assert.equal((await f.request('/api/forward', { recipientId: 'synthetic-friend', url: 'https://douyin.com/video/1234567890123/?tracking=x#t' })).body.confirmed, true);
  assert.equal(f.executes[0].name, 'douyin_forward_video'); assert.equal(f.executes[0].args.url, 'https://www.douyin.com/video/1234567890123'); assert.equal(f.executes[0].options.humanAuthorized, true); assert.ok(f.executes[0].options.signal instanceof AbortSignal);
  await f.request('/api/forward', { recipientId: 'synthetic-friend', url: '' }); assert.deepEqual(f.executes[1].args, { recipientId: 'synthetic-friend' });
  const agent = new ApiAgent({ controller: { execute: async () => ({}) }, config: f.config }); assert.equal(agent.toolDefinitions.some(tool => tool.name === 'douyin_forward_video'), false);
});

test('关系核对期间撤销许可会拒绝；到点取消进行中转发，单次未确认不盲目重试', async t => {
  const f = await fixture(t); f.videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 1 }, { explicit: true }); f.videoLimits.markSession('api', { explicit: true });
  f.setContactsHook(async () => f.allow([])); assert.equal((await f.request('/api/forward', { recipientId: 'synthetic-friend' })).status, 403); assert.equal(f.executes.length, 0);
  f.allow([{ id: 'synthetic-friend', followed: true, isGroup: false }]); f.setContactsHook(async () => {});
  const entered = Promise.withResolvers(); f.setExecutor(async (_name, _args, { signal }) => { entered.resolve(); return new Promise(resolve => signal.addEventListener('abort', () => resolve({ confirmed: false, deliveryUncertain: true }), { once: true })); });
  const request = f.request('/api/forward', { recipientId: 'synthetic-friend' }); await entered.promise;
  assert.equal((await f.request('/api/forward', { recipientId: 'synthetic-friend' })).status, 409);
  f.advance(60_000); await f.server.enforceVideoLimits(); const result = await request; assert.equal(result.body.confirmed, false); assert.equal(result.body.deliveryUncertain, true); assert.equal(f.executes.length, 1);
});

test('临时真 Edge 页面可以开关音频并用合成好友明确点一次转发，不接触真人联系人', { skip: process.env.DOUYIN_UI_TEST !== '1' }, async t => {
  const f = await fixture(t); f.videoLimits.markSession('api', { explicit: true }); const require = createRequire(import.meta.url); const { chromium } = createRequire(require.resolve('@playwright/mcp'))('playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close()); const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(f.base); await page.locator('#mediaPanel').waitFor(); await page.locator('#mediaSave').waitFor({ state: 'visible' }); await page.waitForFunction(() => !document.getElementById('mediaSave').disabled); assert.equal(await page.locator('#mediaEnabled').isChecked(), false);
  await page.locator('#mediaEnabled').check(); await page.locator('#mediaBackend').selectOption('mimo'); await page.getByRole('button', { name: '保存音频设置', exact: true }).click(); await page.locator('#mediaStatus').filter({ hasText: '音频理解已开启' }).waitFor(); assert.equal(f.settings().backend, 'mimo');
  await page.getByRole('button', { name: '读取可转发好友', exact: true }).click(); await page.locator('#forwardRecipient').selectOption('synthetic-friend'); await page.locator('#forwardUrl').fill('https://www.douyin.com/video/1234567890123'); await page.getByRole('button', { name: '转发这条作品', exact: true }).click(); await page.locator('#forwardStatus').filter({ hasText: '已确认转发成功' }).waitFor(); assert.equal(f.executes.length, 1); assert.equal(f.executes[0].options.humanAuthorized, true); assert.deepEqual(errors, []);
});
