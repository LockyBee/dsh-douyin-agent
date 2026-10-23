import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../playwright-runtime.mjs';

async function focusedInputStyle(locator) {
  await locator.focus();
  return locator.evaluate(input => {
    const wrapper = input.parentElement, caption = wrapper.parentElement.firstElementChild;
    const style = getComputedStyle(input), outer = getComputedStyle(wrapper), label = getComputedStyle(caption);
    const inputRect = input.getBoundingClientRect(), wrapperRect = wrapper.getBoundingClientRect();
    return {
      type: input.type, active: document.activeElement === input,
      inner: { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, borderWidth: style.borderWidth, background: style.backgroundColor, boxShadow: style.boxShadow, appearance: style.appearance, textSecurity: style.webkitTextSecurity },
      wrapper: { tag: wrapper.tagName, display: outer.display, outlineStyle: outer.outlineStyle, outlineWidth: outer.outlineWidth, outlineOffset: outer.outlineOffset, borderRadius: outer.borderRadius, marginBottom: outer.marginBottom },
      caption: { text: caption.textContent, display: label.display, marginBottom: label.marginBottom },
      contained: inputRect.left >= wrapperRect.left && inputRect.right <= wrapperRect.right && inputRect.top >= wrapperRect.top && inputRect.bottom <= wrapperRect.bottom,
    };
  });
}

function assertSingleFocusRing(style, type, caption) {
  assert.equal(style.type, type); assert.equal(style.active, true);
  assert.equal(style.inner.outlineStyle, 'none');
  assert.equal(style.inner.borderWidth, '0px', JSON.stringify(style)); assert.equal(style.inner.background, 'rgba(0, 0, 0, 0)'); assert.equal(style.inner.boxShadow, 'none');
  assert.equal(style.wrapper.tag, 'SPAN'); assert.equal(style.wrapper.display, 'flex');
  assert.equal(style.wrapper.outlineStyle, 'solid'); assert.equal(style.wrapper.outlineWidth, '2px'); assert.equal(style.wrapper.outlineOffset, '-1px');
  assert.equal(style.wrapper.borderRadius, '8px'); assert.equal(style.wrapper.marginBottom, '0px'); assert.equal(style.contained, true);
  assert.equal(style.caption.text, caption); assert.equal(style.caption.display, 'block'); assert.equal(style.caption.marginBottom, '6px');
}

test('官方Input包装层只保留一个焦点环，密码遮挡与数字步进在临时Edge中可用', { timeout: 40_000 }, async t => {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const screenshots = fileURLToPath(new URL('../.test-temp/input-appearance/', import.meta.url)); await fs.mkdir(screenshots, { recursive: true });
  const profile = await fs.mkdtemp(path.join(tmpdir(), 'douyin-input-appearance-'));
  const requests = [], errors = [], native = [];
  let configured = false;
  const settings = () => ({ configured, baseUrl: 'https://api.example.invalid', model: '合成界面模型', remember: false, memoryFolder: 'C:\\合成共享记忆' });
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let body = ''; for await (const chunk of request) body += chunk;
        requests.push({ method: request.method, route: url.pathname, body });
        response.writeHead(200, { 'content-type': 'application/json' });
        const value = url.pathname === '/api/bootstrap' ? { service: 'douyin-api-local', token: 'synthetic-input-session', config: { configured }, videoTime: { enabled: true } }
          : url.pathname === '/api/state' ? { running: false, task: null, revision: 0, events: [] }
          : url.pathname === '/api/video/status' ? { allowed: false, window: {}, remainingSeconds: 0, session: { status: 'ended' }, policy: { windows: ['00:00-24:00'], sessionMinutes: 10 } }
          : url.pathname === '/api/chat/state' ? { running: false, policy: { allowlist: [], dailyReplyLimit: 40 } } : {};
        response.end(JSON.stringify(value)); return;
      }
      const file = path.resolve(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (!file.startsWith(path.resolve(dist) + path.sep)) throw new Error('合成静态路径越界');
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
      const contents = await fs.readFile(file);
      response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" }); response.end(contents);
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport: { width: 1440, height: 980 } });
  t.after(async () => { await context.close(); assert.equal(path.dirname(path.resolve(profile)), path.resolve(tmpdir())); assert.match(profile, /douyin-input-appearance-[^\\/]+$/); await fs.rm(profile, { recursive: true, force: true }); });
  const page = context.pages()[0]; page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('__syntheticSettings', settings);
  await page.exposeFunction('__syntheticSave', input => { native.push(input); configured = true; return settings(); });
  await page.addInitScript(() => { window.douyinDesktop = { getSettings: () => window.__syntheticSettings(), saveSettings: input => window.__syntheticSave(input), clearApiKey: async () => ({}), openMemoryFolder: async () => {}, openPersonaFolder: async () => {} }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const password = page.getByRole('textbox', { name: 'API Key', exact: true });
  await password.fill('synthetic-input-only');
  const passwordStyle = await focusedInputStyle(password); assertSingleFocusRing(passwordStyle, 'password', 'API Key');
  assert.equal(passwordStyle.inner.textSecurity, 'disc'); assert.equal(await password.inputValue(), 'synthetic-input-only');
  await page.getByRole('dialog').screenshot({ path: path.join(screenshots, 'password-focus.png') });
  await page.getByRole('button', { name: '保存并连接', exact: true }).click(); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /◌ 对话与视频/ }).click();
  await page.getByRole('button', { name: '展开快捷控制', exact: true }).click();
  assert.equal(native.length, 1); assert.equal(native[0].apiKey, 'synthetic-input-only');
  const minutes = page.getByRole('spinbutton', { name: '单轮上限', exact: true });
  await minutes.fill('10'); await minutes.press('ArrowUp'); assert.equal(await minutes.inputValue(), '11');
  await minutes.press('ArrowDown'); assert.equal(await minutes.inputValue(), '10');
  const numberStyle = await focusedInputStyle(minutes); assertSingleFocusRing(numberStyle, 'number', '单轮上限（分钟）');
  assert.notEqual(numberStyle.inner.appearance, 'none');
  assert.deepEqual(await minutes.evaluate(input => ({ min: input.min, max: input.max, step: input.step })), { min: '1', max: '1000000', step: '1' });
  await minutes.hover();
  await page.locator('.panel').filter({ has: page.getByRole('heading', { name: '刷视频时间', exact: true }) }).screenshot({ path: path.join(screenshots, 'number-focus.png') });
  await fs.writeFile(path.join(screenshots, 'computed-styles.json'), JSON.stringify({ password: passwordStyle, number: numberStyle }, null, 2) + '\n');
  assert.equal(requests.every(request => request.method === 'GET'), true, '合成测试不提交业务动作');
  assert.equal(JSON.stringify(requests).includes('synthetic-input-only'), false); assert.deepEqual(errors, []);
});
