import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../playwright-runtime.mjs';

test('未配置主 Key 也可点击打开抖音；MiMo Key 只走桌面接口且不启用音频', { timeout: 50_000 }, async t => {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url)), calls = [], native = [], errors = [];
  let configured = false, mimoConfigured = false, rejectOpen = true;
  const settings = () => ({ configured, model: '合成模型', baseUrl: 'https://example.invalid', remember: false, memoryFolder: 'C:\\合成共享记忆' });
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let body = ''; for await (const chunk of request) body += chunk;
        calls.push({ route: url.pathname, method: request.method, body });
        const reply = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (url.pathname === '/api/bootstrap') return reply({ service: 'douyin-api-local', token: 'synthetic-browser-key-session', config: { configured }, videoTime: { enabled: true }, media: { available: true } });
        if (request.headers['x-session-token'] !== 'synthetic-browser-key-session') { response.writeHead(403); return response.end('{}'); }
        if (url.pathname === '/api/state') return reply({ running: false, revision: 0, events: [], browser: null });
        if (url.pathname === '/api/video/status') return reply({ allowed: false, policy: { windows: ['00:00-24:00'], sessionMinutes: 21 }, reason: '合成未开始轮次' });
        if (url.pathname === '/api/chat/state') return reply({ running: false, policy: { allowlist: [], dailyReplyLimit: 40 } });
        if (url.pathname === '/api/media/state') return reply({ enabled: false, backend: 'local-whisper', backends: { mimo: { available: mimoConfigured } } });
        if (url.pathname === '/api/browser/open') {
          if (rejectOpen) { rejectOpen = false; response.writeHead(503, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ error: '合成连接未就绪，请重试。' })); }
          return reply({ opened: true, mode: 'prepare', paused: true, sessionChanged: false });
        }
        throw new Error('合成测试未授权此接口');
      }
      const file = path.resolve(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (!file.startsWith(path.resolve(dist) + path.sep)) throw new Error('合成静态路径越界');
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
      response.writeHead(200, { 'content-type': type[path.extname(file)] || 'application/octet-stream' }); response.end(await fs.readFile(file));
    } catch { if (!response.headersSent) response.writeHead(404); response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('__settings', settings);
  await page.exposeFunction('__saveMain', input => { native.push({ kind: 'main', input }); configured = true; return settings(); });
  await page.exposeFunction('__saveMedia', input => { native.push({ kind: 'media', input }); mimoConfigured = true; return { backend: input.backend, configured: true }; });
  await page.addInitScript(() => { window.douyinDesktop = { getSettings: () => window.__settings(), saveSettings: input => window.__saveMain(input), saveMediaKey: input => window.__saveMedia(input) }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const dialog = page.getByRole('dialog');
  const open = dialog.getByRole('button', { name: '打开抖音', exact: true });
  await open.waitFor(); await page.waitForFunction(() => !document.querySelector('[role="dialog"] button')?.disabled);
  await open.click(); await dialog.getByRole('alert').filter({ hasText: '合成连接未就绪，请重试。' }).waitFor();
  await open.click(); await page.waitForTimeout(200);
  assert.equal(calls.filter(call => call.route === '/api/browser/open').length, 2);
  assert.equal(calls.find(call => call.route === '/api/browser/open').body, '{}');
  assert.equal(configured, false); assert.deepEqual(native, []);
  await dialog.getByRole('textbox', { name: 'API Key', exact: true }).fill('synthetic-main-key');
  await dialog.getByRole('button', { name: '保存并连接', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /◌ 对话与视频/ }).click();
  await page.getByRole('button', { name: '展开快捷控制', exact: true }).click();
  await page.getByLabel('音频后端', { exact: true }).selectOption('mimo');
  const key = page.getByRole('textbox', { name: 'MiMo API Key', exact: true });
  assert.equal(await key.getAttribute('type'), 'password');
  await key.fill('synthetic-mimo-key'); await page.getByRole('button', { name: '保存音频 Key', exact: true }).click();
  await page.getByText('已保存共享音频 Key。保存不会开启音频或发起云端请求。', { exact: true }).waitFor();
  assert.equal(await key.inputValue(), '');
  assert.deepEqual(native.find(value => value.kind === 'media').input, { backend: 'mimo', apiKey: 'synthetic-mimo-key' });
  assert.equal(calls.filter(call => call.method === 'POST').every(call => call.route === '/api/browser/open'), true);
  assert.doesNotMatch(JSON.stringify(calls), /synthetic-main-key|synthetic-mimo-key/);
  assert.equal(await page.getByRole('switch', { name: '读取视频声音', exact: true }).getAttribute('aria-checked'), 'false');
  const screenshots = fileURLToPath(new URL('../.test-temp/browser-audio/', import.meta.url)); await fs.mkdir(screenshots, { recursive: true });
  await page.locator('.panel').filter({ has: page.getByRole('heading', { name: '音频理解', exact: true }) }).screenshot({ path: path.join(screenshots, 'mimo-key-field.png') });
  assert.deepEqual(errors, []);
});
