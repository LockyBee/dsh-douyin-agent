import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../playwright-runtime.mjs';

test('独立React界面完成IPC配置、共享目录、任务结果与显式转发的合成浏览器验收', { timeout: 60_000 }, async t => {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const root = fileURLToPath(new URL('../.test-temp/', import.meta.url)); await fs.mkdir(root, { recursive: true });
  const calls = [], nativeCalls = [], errors = [];
  let configured = false, task = null, taskRunning = false, revision = 0, forwardCount = 0, opened = 0;
  const prefs = () => ({ configured, baseUrl: 'https://api.example.invalid', model: '合成模型', remember: false, memoryFolder: 'C:\\合成共享记忆' });
  const video = { allowed: true, now: Date.now(), window: { expiresAt: Date.now() + 600_000 }, remainingSeconds: 300, session: { status: 'active' }, policy: { windows: ['00:00-24:00'], sessionMinutes: 10 }, reason: '' };
  const chat = { running: false, policy: { allowlist: [{ id: 'synthetic-friend', name: '合成好友', followed: true, isGroup: false }], dailyReplyLimit: 40 }, daily: { requests: 0, limit: 40 }, contacts: [], events: [] };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let raw = ''; for await (const chunk of request) raw += chunk;
        calls.push({ route: request.url, method: request.method, body: raw, token: request.headers['x-session-token'] });
        const reply = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (url.pathname === '/api/bootstrap') return reply({ service: 'douyin-api-local', token: 'synthetic-session', config: { configured, model: '合成模型' }, videoTime: { enabled: true }, media: { available: true }, forward: { available: true }, limits: { maxToolCalls: 20, taskTimeoutSeconds: 180 } });
        if (request.headers['x-session-token'] !== 'synthetic-session') { response.writeHead(403); response.end('{"error":"合成鉴权失败"}'); return; }
        if (url.pathname === '/api/state') return reply({ running: taskRunning, task, events: Number(url.searchParams.get('since')) < revision ? [{ revision, type: 'tool.result', tool: 'douyin_observe', result: { ok: true, synthetic: true } }] : [], revision, browser: null });
        if (url.pathname === '/api/video/status') return reply(video);
        if (url.pathname === '/api/chat/state') return reply(chat);
        if (url.pathname === '/api/chat/contacts') return reply({ contacts: [...chat.policy.allowlist, { id: 'synthetic-friend-b', name: '合成好友乙', followed: true, isGroup: false }] });
        if (url.pathname === '/api/chat/configure') { const input = JSON.parse(raw); chat.policy.dailyReplyLimit = input.dailyReplyLimit; return reply(chat); }
        if (url.pathname === '/api/chat/start') { chat.running = true; return reply(chat); }
        if (url.pathname === '/api/chat/stop') { chat.running = false; return reply(chat); }
        if (url.pathname === '/api/media/state') return reply({ enabled: false, backend: 'local-whisper', backends: { 'local-whisper': { available: false } } });
        if (url.pathname === '/api/memory') return reply({ result: { entries: [{ id: 'synthetic-memory', origin: 'video', content: '合成视频笔记内容' }] } });
        if (url.pathname === '/api/task') { const instruction = JSON.parse(raw).instruction; taskRunning = instruction.includes('停止'); task = { id: `synthetic-task-${revision + 1}`, instruction, ...(taskRunning ? {} : { message: '**合成结果**：已读取测试画面。' }), status: taskRunning ? 'running' : 'completed' }; revision++; return reply({ id: task.id, status: 'running' }); }
        if (url.pathname === '/api/stop') { taskRunning = false; task.status = 'stopped'; task.message = '合成任务已停止'; return reply({ stopping: true }); }
        if (url.pathname === '/api/video/policy') { video.policy = JSON.parse(raw); return reply(video); }
        if (url.pathname === '/api/forward/contacts') return reply({ contacts: chat.policy.allowlist });
        if (url.pathname === '/api/forward') { forwardCount++; return reply({ confirmed: false, deliveryUncertain: true }); }
        return reply({ ok: true });
      }
      const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, ''));
      if (!path.resolve(file).startsWith(path.resolve(dist) + path.sep)) throw new Error('合成静态路径越界');
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
      const contents = await fs.readFile(file);
      response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); response.end(contents);
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('__nativeGet', prefs);
  await page.exposeFunction('__nativeSave', input => { nativeCalls.push(input); configured = true; return prefs(); });
  await page.exposeFunction('__nativeClear', () => { configured = false; return prefs(); });
  await page.exposeFunction('__nativeOpen', () => { opened++; });
  await page.addInitScript(() => { window.douyinDesktop = { getSettings: () => window.__nativeGet(), saveSettings: input => window.__nativeSave(input), clearApiKey: () => window.__nativeClear(), openMemoryFolder: () => window.__nativeOpen() }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading', { name: '先连接你的 DeepSeek' }).waitFor();
  await page.getByText('合成模型', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('synthetic-only-secret');
  await page.getByRole('button', { name: '保存并连接' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /◌ 对话与视频/ }).click();
  await page.getByRole('button', { name: '展开快捷控制', exact: true }).click();
  assert.equal(nativeCalls.length, 1); assert.equal(nativeCalls[0].apiKey, 'synthetic-only-secret'); assert.equal(nativeCalls[0].model, '合成模型');
  await page.getByRole('button', { name: /☷ 业务设置/ }).click();
  await page.getByRole('tab', { name: '基础设置', exact: true }).click();
  await page.locator('summary').filter({hasText:'检索共享记忆'}).click();
  await page.getByRole('button', { name: '打开记忆文件夹' }).click(); assert.equal(opened, 1);
  await page.getByRole('textbox', { name: '检索共享记忆' }).fill('合成偏好'); await page.getByRole('button', { name: '检索记忆', exact: true }).click();
  await page.getByText('合成视频笔记内容', { exact: true }).waitFor();
  await page.getByRole('button', { name: /新任务/ }).click();
  await page.getByRole('textbox', { name: '视频任务' }).fill('读取合成猫咪视频');
  await page.getByRole('button', { name: '开始任务 ↑' }).click();
  await page.getByText('合成结果', { exact: true }).waitFor();
  await page.locator('summary').filter({ hasText: '运行过程' }).click();
  await page.getByText('douyin_observe', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: '视频任务' }).fill('合成停止任务'); await page.getByRole('button', { name: '开始任务 ↑' }).click();
  await page.getByRole('button', { name: '■ 停止任务' }).click(); await page.getByText('合成任务已停止', { exact: true }).waitFor();
  await page.getByLabel('每日允许时段', { exact: true }).fill('23:00-01:00');
  await page.getByRole('spinbutton', { name: '单轮上限' }).fill('5'); await page.waitForTimeout(1700);
  assert.equal(await page.getByRole('spinbutton', { name: '单轮上限' }).inputValue(), '5');
  await page.getByRole('button', { name: '保存时间设置' }).click();
  assert.deepEqual(JSON.parse(calls.find(call => call.route === '/api/video/policy').body), { windows: ['23:00-01:00'], weekendWindows: null, sessionMinutes: 5 });
  const minutes = page.getByRole('spinbutton', { name: '单轮上限', exact: true }), unlimited = page.getByRole('switch', { name: '不限单轮时长', exact: true });
  await unlimited.click(); await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/video/policy') && response.request().method() === 'POST'), page.getByRole('button', { name: '保存时间设置' }).click()]);
  await page.waitForFunction(() => document.querySelector('[aria-label="单轮上限"]')?.placeholder === '不限；输入分钟数可设置上限');
  assert.equal(await minutes.isEnabled(), true); assert.equal(await minutes.inputValue(), '');
  assert.equal(video.policy.sessionMinutes, null);
  const savesBeforeTyping = calls.filter(call => call.route === '/api/video/policy').length;
  await minutes.fill('25'); await page.waitForTimeout(1700);
  assert.equal(await minutes.inputValue(), '25'); assert.equal(await unlimited.getAttribute('aria-checked'), 'false');
  assert.equal(calls.filter(call => call.route === '/api/video/policy').length, savesBeforeTyping); assert.equal(video.policy.sessionMinutes, null);
  await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/video/policy') && response.request().method() === 'POST'), page.getByRole('button', { name: '保存时间设置' }).click()]);
  assert.deepEqual(JSON.parse(calls.filter(call => call.route === '/api/video/policy').at(-1).body), { windows: ['23:00-01:00'], weekendWindows: null, sessionMinutes: 25 });
  await page.getByRole('button', { name: '读取联系人', exact: true }).click();
  await page.getByRole('checkbox', { name: /合成好友乙/ }).check();
  await page.getByRole('spinbutton', { name: '每日模型请求上限' }).fill('8');
  await page.getByRole('button', { name: '保存许可名单' }).click();
  assert.deepEqual(JSON.parse(calls.find(call => call.route === '/api/chat/configure').body), { recipientIds: ['synthetic-friend', 'synthetic-friend-b'], dailyReplyLimit: 8 });
  await page.getByRole('button', { name: '启用自动回复' }).click();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  const audioSwitch = page.getByRole('switch', { name: '读取视频声音' });
  await audioSwitch.click(); await page.waitForTimeout(1800); assert.equal(await audioSwitch.getAttribute('aria-checked'), 'true');
  await page.getByRole('button', { name: '读取许可好友' }).click();
  await page.getByLabel('转发收件人', { exact: true }).selectOption('synthetic-friend');
  await page.getByRole('textbox', { name: '转发作品链接' }).fill('https://www.douyin.com/video/1234567890123');
  await page.getByRole('button', { name: '确认转发给所选好友' }).click();
  await page.getByText('尚未确认送达，请在抖音人工核对；本次不会自动重发。', { exact: true }).waitFor();
  assert.equal(forwardCount, 1); assert.equal(await page.getByRole('button', { name: '确认转发给所选好友' }).isDisabled(), true);
  assert.equal(calls.some(call => call.body.includes('synthetic-only-secret') || call.route.includes('synthetic-only-secret')), false);
  assert.equal(calls.filter(call => call.route === '/api/task').length, 2); assert.equal(calls.filter(call => call.route === '/api/stop').length, 1);
  assert.equal(calls.filter(call => call.route === '/api/chat/start').length, 1); assert.equal(calls.filter(call => call.route === '/api/chat/stop').length, 1); assert.deepEqual(errors, []);
  await page.locator('.business-sidebar').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: path.join(root, 'synthetic-ui.png'), fullPage: true });
  await page.getByRole('button', { name: /新任务/ }).click();
  await page.screenshot({ path: path.join(root, 'synthetic-welcome.png'), fullPage: true });
  await page.getByRole('button', { name: /☷ 业务设置/ }).click();
  await page.getByRole('tab', { name: '基础设置', exact: true }).click();
  await page.getByRole('button', { name: '配置模型与 API Key', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'API Key', exact: true }).inputValue(), '');
  await page.getByRole('switch', { name: '记住 API Key' }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(nativeCalls.length, 2); assert.equal(nativeCalls[1].apiKey, ''); assert.equal(nativeCalls[1].remember, true);
});
