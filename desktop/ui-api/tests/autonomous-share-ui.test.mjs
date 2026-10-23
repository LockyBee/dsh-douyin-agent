import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../playwright-runtime.mjs';
import { TASK_LIMIT_BOUNDS } from '../../../task-limits.mjs';

test('生产自主分享入口只保存总许可，观看中可关闭，异常核对与任务预算按实际合同接线', { timeout: 60_000 }, async t => {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url)), shots = fileURLToPath(new URL('../.test-temp/', import.meta.url)); await fs.mkdir(shots, { recursive: true });
  const calls = [], errors = []; let failedReview = false;
  const recipients = [{ id: 'synthetic-friend-a', name: '合成许可好友甲' }, { id: 'synthetic-friend-b', name: '合成许可好友乙' }];
  const share = { protocol: 'autonomous-share-v1', enabled: false, dailyLimit: 3, recipients, daily: { attempts: 0, remaining: 3 }, paused: false, busy: false, recent: [], needsReview: [], receiptsFile: 'C:\\合成分享收据.json' };
  const watch = { running: false, status: 'stopped', owned: false, worker: null, lastError: '合成停止原因：本轮请求预算已用完。', counts: { requests: 2, maxRequests: 30, dailyRequests: 2, dailyLimit: 200 }, lastDecision: { action: 'share', reason: '合成选择理由：准备向许可好友分享当前观察作品。' } };
  const limits = { protocol: 'task-limits-v1', policy: { maxSteps: 20, maxToolCalls: 20, timeoutSeconds: 180 }, hardLimits: TASK_LIMIT_BOUNDS, configured: false };
  const persona = { revision: 'synthetic-behavior', manualText: '合成手编人格', personaText: '合成生效人格', interests: [
    { key: 'pixel-topic', topic: '合成像素识别主题', signal: 'neutral', counts: { like: 0, dislike: 0, neutral: 1 }, basis: '合成依据：只有主题识别，尚不足以判断喜欢。', evidence: [{ evidenceId: 'synthetic-pixel', reflection: '识别出猫咪不等于喜欢。', source: 'api', watchedSeconds: 0, watchRatio: 0, actions: { stay: 0, skip: 0, share: 0 }, basis: '合成依据：只有主题识别。' }] },
    { key: 'behavior-topic', topic: '合成观看行为主题', signal: 'like', counts: { like: 1, dislike: 0, neutral: 0 }, basis: '合成依据：实际观看并确认继续停留。', evidence: [{ evidenceId: 'synthetic-behavior', reflection: '继续看这类内容。', source: 'dsh', watchedSeconds: 10, watchRatio: 0.5, actions: { stay: 1, skip: 0, share: 0 }, basis: '合成依据：实际观看10秒，继续停留1次。' }] },
  ], recentObservations: [{ id: 'synthetic-observation', title: '合成行为观察作品', kind: 'visual', frameCount: 1, playback: { time: 12, duration: 20, paused: true }, watchedSeconds: 10, watchRatio: 0.5, actions: { stay: 1, skip: 0, share: 0 }, basis: '合成依据：实际观看10秒，继续停留1次。' }] };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let raw = ''; for await (const chunk of request) raw += chunk;
        calls.push({ route: url.pathname, method: request.method, body: raw, token: request.headers['x-session-token'] });
        const reply = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (url.pathname === '/api/bootstrap') return reply({ service: 'douyin-api-local', token: 'synthetic-share-session', config: { configured: true }, videoTime: { enabled: true }, watch: { available: true }, share: { available: true }, forward: { available: true }, persona: { available: true }, limits: { maxSteps: limits.policy.maxSteps, maxToolCalls: limits.policy.maxToolCalls, taskTimeoutSeconds: limits.policy.timeoutSeconds } });
        if (request.headers['x-session-token'] !== 'synthetic-share-session') { response.writeHead(403); response.end('{"error":"合成鉴权失败"}'); return; }
        if (url.pathname === '/api/state') return reply({ running: false, task: null, revision: 0, events: [], browser: { video: { title: '合成当前作品', paused: true, url: 'https://www.douyin.com/video/1234567890123' } } });
        if (url.pathname === '/api/video/status') return reply({ allowed: true, window: {}, remainingSeconds: 120, session: { status: 'active' }, policy: { windows: ['00:00-24:00'], sessionMinutes: 10 } });
        if (url.pathname === '/api/task/limits') { if (request.method === 'POST') { limits.policy = JSON.parse(raw); limits.configured = true; } return reply(limits); }
        if (url.pathname === '/api/watch/state') return reply(watch);
        if (url.pathname === '/api/share/state') return reply(share);
        if (url.pathname === '/api/share/configure') { const body = JSON.parse(raw); share.enabled = body.enabled; share.dailyLimit = body.dailyLimit; share.daily.remaining = Math.max(0, body.dailyLimit - share.daily.attempts); return reply(share); }
        if (url.pathname === '/api/share/resolve') {
          const body = JSON.parse(raw), item = share.needsReview.find(item => item.operationId === body.operationId);
          if (body.operationId === 'synthetic-review-a' && !failedReview) { failedReview = true; response.writeHead(409, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: '合成核对暂时冲突，请稍后重试。' })); return; }
          if (body.operationId !== 'synthetic-review-a') share.needsReview = share.needsReview.filter(item => item.operationId !== body.operationId);
          share.recent.push({ ...item, status: body.outcome === 'confirmed' ? 'resolved-confirmed' : 'resolved-not-sent' }); share.paused = share.needsReview.length > 0; return reply(share);
        }
        if (url.pathname === '/api/persona') return reply(persona);
        if (url.pathname === '/api/chat/state') return reply({ running: false, policy: { allowlist: [], dailyReplyLimit: 40 } });
        return reply({ ok: true });
      }
      const file = path.resolve(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1)); if (!file.startsWith(path.resolve(dist) + path.sep)) throw new Error('合成路径越界');
      const contents = await fs.readFile(file), types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
      response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); response.end(contents);
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const profile = await fs.mkdtemp(path.join(tmpdir(), 'douyin-autonomous-share-ui-'));
  const browser = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport: { width: 1440, height: 1050 } });
  t.after(async () => { await browser.close(); assert.equal(path.dirname(path.resolve(profile)), path.resolve(tmpdir())); await fs.rm(profile, { recursive: true, force: true }); });
  const page = browser.pages()[0]; page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('__getSyntheticSettings', () => ({ configured: true, model: '合成分享模型', baseUrl: 'https://api.example.invalid', memoryFolder: 'C:\\合成共享记忆' }));
  await page.addInitScript(() => { window.douyinDesktop = { getSettings: () => window.__getSyntheticSettings(), saveSettings: async () => ({}), clearApiKey: async () => ({}), openMemoryFolder: async () => {}, openPersonaFolder: async () => {} }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);

  await page.getByRole('button', { name: /◌ 对话与视频/ }).click();
  await page.getByRole('button', { name: '展开快捷控制', exact: true }).click();
  const panel = page.locator('[aria-labelledby="auto-share-title"]'), toggle = panel.getByRole('switch', { name: '允许大肥鱼自主分享' }), limit = panel.getByRole('spinbutton', { name: '自主分享每日次数上限' }), save = panel.getByRole('button', { name: '保存自主分享设置', exact: true });
  await page.waitForFunction(() => document.querySelector('[aria-label="自主分享每日次数上限"]')?.disabled === false);
  await page.getByRole('status').filter({ hasText: '上次自主观看停止原因：合成停止原因：本轮请求预算已用完。' }).waitFor();
  await panel.getByText('名单在“业务设置 → 好友互动 → 好友私信”中维护。读取联系人、勾选并保存许可名单即可，不需要启用自动回复；不会自动加入其他联系人。', { exact: true }).waitFor();
  assert.equal(await limit.inputValue(), '3'); assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.equal(await page.getByLabel('转发收件人', { exact: true }).count(), 0); assert.equal(await page.getByLabel('转发作品链接', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '选择此作品转发', exact: true }).count(), 0);
  const steps = page.getByRole('spinbutton', { name: '手动任务步数上限' }), toolCalls = page.getByRole('spinbutton', { name: '手动任务工具调用上限' }), seconds = page.getByRole('spinbutton', { name: '手动任务超时秒数' });
  await steps.fill('40'); await toolCalls.fill('45'); await seconds.fill('600'); await toggle.click(); await limit.fill('5'); await page.waitForTimeout(1700);
  assert.equal(await limit.inputValue(), '5'); assert.equal(await toggle.getAttribute('aria-checked'), 'true'); assert.equal(await steps.inputValue(), '40');
  Object.assign(watch, { running: true, status: 'running', worker: { source: 'dsh', alive: true }, owned: false });
  await page.getByRole('button', { name: '停止当前自主观看', exact: true }).waitFor();
  assert.equal(await steps.isDisabled(), true); assert.equal(await save.isDisabled(), false); assert.equal(await toggle.isDisabled(), false);
  await save.click(); await panel.getByText('已允许大肥鱼在许可好友中自主选择分享；这次保存不会立即发送。', { exact: true }).waitFor();
  await toggle.click(); await save.click(); await panel.getByText('已关闭自主分享，停止后续发送。', { exact: true }).waitFor();
  assert.deepEqual(calls.filter(call => call.route === '/api/share/configure').map(call => JSON.parse(call.body)), [{ enabled: true, dailyLimit: 5 }, { enabled: false, dailyLimit: 5 }]);
  await limit.fill('21'); await save.click(); assert.equal(await limit.evaluate(input => input.validity.rangeOverflow), true); assert.equal(calls.filter(call => call.route === '/api/share/configure').length, 2);
  await limit.fill('4'); share.dailyLimit = 9; await page.waitForTimeout(1700); assert.equal(await limit.inputValue(), '4');
  share.paused = true; share.needsReview = [{ operationId: 'synthetic-review-a', recipientId: recipients[0].id, videoId: '1111111111111', status: 'uncertain' }, { operationId: 'synthetic-review-b', recipientId: recipients[1].id, videoId: '2222222222222', status: 'uncertain' }];
  await panel.getByRole('button', { name: '已人工核对送达', exact: true }).first().waitFor();
  const firstReview = panel.locator('.paused-contact').filter({ hasText: '合成许可好友甲' });
  await firstReview.getByRole('button', { name: '已人工核对送达', exact: true }).click();
  await page.getByText('合成核对暂时冲突，请稍后重试。', { exact: true }).waitFor();
  assert.equal(calls.filter(call => call.route === '/api/share/resolve').length, 1);
  await firstReview.getByRole('button', { name: '已人工核对送达', exact: true }).click();
  await firstReview.getByText('核对结果已提交，等待状态回读；不会重复提交。', { exact: true }).waitFor();
  await page.waitForTimeout(1700);
  assert.equal(await firstReview.getByRole('button', { name: '已人工核对送达', exact: true }).count(), 0);
  assert.equal(calls.filter(call => call.route === '/api/share/resolve').length, 2);
  share.needsReview = share.needsReview.filter(item => item.operationId !== 'synthetic-review-a');
  await panel.locator('.paused-contact').filter({ hasText: '合成许可好友乙' }).getByRole('button', { name: '已人工核对未送达', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[aria-labelledby="auto-share-title"] .paused-contact').length === 0);
  assert.deepEqual(calls.filter(call => call.route === '/api/share/resolve').map(call => JSON.parse(call.body)), [{ operationId: 'synthetic-review-a', outcome: 'confirmed' }, { operationId: 'synthetic-review-a', outcome: 'confirmed' }, { operationId: 'synthetic-review-b', outcome: 'not-sent' }]);
  await save.click(); await panel.getByText('已关闭自主分享，停止后续发送。', { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(calls.filter(call => call.route === '/api/share/configure').at(-1).body), { enabled: false, dailyLimit: 4 });
  await panel.locator('summary').filter({ hasText: '最近分享记录' }).click(); await page.screenshot({ path: path.join(shots, 'synthetic-autonomous-share.png'), fullPage: true });
  await panel.screenshot({ path: path.join(shots, 'synthetic-autonomous-share-panel.png') });
  await page.getByRole('button', { name: /◉ 自主观看/ }).click(); await page.getByText('分享当前作品', { exact: true }).waitFor();
  const neutral = page.locator('.interest-card').filter({ hasText: '合成像素识别主题' }); assert.equal(await neutral.getByText('待观察', { exact: true }).isVisible(), true); assert.equal(await neutral.getByText('感兴趣', { exact: true }).count(), 0);
  const observed = page.locator('.observation-entry').filter({ hasText: '合成行为观察作品' });
  await observed.getByText('已核实观看 10 秒', { exact: true }).waitFor(); await observed.getByText('观看比例 50%', { exact: true }).waitFor(); await observed.getByText('继续停留 1 次', { exact: true }).waitFor();
  assert.match(await page.locator('.interest-card').filter({ hasText: '合成观看行为主题' }).innerText(), /正向 1.*负向 0.*待观察 0/);
  await page.locator('.watch-view').screenshot({ path: path.join(shots, 'synthetic-behavior-evidence.png') });
  Object.assign(watch, { running: false, status: 'stopped', worker: null });
  await page.waitForFunction(() => document.querySelector('[aria-label="手动任务步数上限"]').disabled === false);
  await page.getByRole('button', { name: '保存手动任务预算', exact: true }).click(); await page.getByText('手动任务预算已保存，将用于之后启动的任务。', { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(calls.find(call => call.route === '/api/task/limits' && call.method === 'POST').body), { maxSteps: 40, maxToolCalls: 45, timeoutSeconds: 600 });
  await page.getByRole('button', { name: /对话与视频/ }).click(); await page.getByText('最多 40 步 · 45 次工具 · 600 秒', { exact: true }).waitFor();
  const writes = calls.filter(call => call.method === 'POST');
  assert.equal(writes.every(call => ['/api/share/configure', '/api/share/resolve', '/api/task/limits'].includes(call.route)), true);
  assert.equal(writes.every(call => call.token === 'synthetic-share-session'), true); assert.deepEqual(errors, []);
});
