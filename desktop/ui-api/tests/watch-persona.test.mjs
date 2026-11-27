import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../playwright-runtime.mjs';

test('按时段自动观看与共用人格在主界面可用，运行状态未知时仍阻止手动任务', { timeout: 65_000 }, async t => {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const shots = fileURLToPath(new URL('../.test-temp/', import.meta.url)); await fs.mkdir(shots, { recursive: true });
  const calls = [], errors = [], nativeCalls = [];
  let taskRunning = false, task = null, rejectSave = false, personaOpened = 0, watchReadFails = false;
  const video = { allowed: false, window: { expiresAt: Date.now() + 600_000 }, remainingSeconds: 0, session: { status: 'ended' }, policy: { windows: ['00:00-24:00'], sessionMinutes: 10 } };
  const schedule = { policy: { enabled: false } };
  const watch = { protocol: 'autonomous-watch-v1', running: false, owned: false, worker: null, status: 'stopped', sessionId: 'synthetic-session-1', counts: { requests: 1, maxRequests: 30, dailyRequests: 2, dailyLimit: 200 }, remainingSeconds: 0, lastDecision: { action: 'search', reason: '合成选择理由：对轻松动物题材感兴趣。', query: '合成猫咪', topics: ['动物'] } };
  const sample = {
    watchedSeconds: 2, watchRatio: 0.2, actions: { stay: 1, skip: 0, share: 0 },
    basis: '已核对观看 2 秒（20%），现有行为不足以判断喜好，待观察。', basisCode: 'insufficient-behavior'
  };
  let persona = {
    personaFolder: 'C:\\合成共享记忆\\persona', roleCardFile: 'C:\\合成共享记忆\\persona\\role-card.md',
    revision: 'r1', manualText: '合成手编人格原文', personaText: '合成当前生效人格，包含持续观察。',
    interests: [{
      topic: '合成动物兴趣', key: 'synthetic-topic', signal: 'neutral', counts: { like: 0, dislike: 0, neutral: 1 },
      basis: '按不同作品汇总：0 条正向、0 条负向、1 条待观察；每条作品只计一次。', updatedAt: 1792058400000,
      evidence: [{ evidenceId: 'synthetic-evidence', videoId: '1234567890123', reflection: '合成反思：识别到动物互动主题，尚不代表喜欢。', ...sample, source: 'api', at: 1792058400000 }]
    }],
    recentObservations: [{
      id: 'synthetic-observation', videoId: '1234567890123', title: '合成观察：小猫正在玩球。', author: '合成公开作者', kind: 'visual',
      playback: { time: 3, duration: 10, paused: true }, ...sample, frameCount: 1, source: 'api', observedAt: 1792058400000
    }]
  };
  const prefs = () => ({ configured: true, baseUrl: 'https://api.example.invalid', model: '合成模型', remember: false, memoryFolder: 'C:\\合成共享记忆' });
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        let body = ''; for await (const chunk of request) body += chunk;
        calls.push({ route: url.pathname, method: request.method, body, token: request.headers['x-session-token'] });
        const reply = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
        if (url.pathname === '/api/bootstrap') return reply({ service: 'douyin-api-local', token: 'synthetic-autonomous-token', config: { configured: true }, videoTime: { enabled: true }, watch: { available: true }, persona: { available: true }, forward: { available: true } });
        if (request.headers['x-session-token'] !== 'synthetic-autonomous-token') return reply({ error: '合成鉴权失败' }, 403);
        if (url.pathname === '/api/state') return reply({ running: taskRunning, task, revision: 0, events: [], browser: { video: { title: '合成当前作品', paused: true } } });
        if (url.pathname === '/api/watch/schedule') { if (request.method === 'POST') { schedule.policy = JSON.parse(body); Object.assign(watch, { running: schedule.policy.enabled, status: schedule.policy.enabled ? 'running' : 'stopped', worker: schedule.policy.enabled ? { source: 'dsh', alive: true } : null }); video.allowed = true; } return reply(schedule); }
        if (url.pathname === '/api/video/status') return reply(video);
        if (url.pathname === '/api/video/start') { Object.assign(video, { allowed: true, remainingSeconds: 120, session: { status: 'active' } }); return reply(video); }
        if (url.pathname === '/api/watch/state') return watchReadFails ? reply({ error: '合成状态暂不可读' }, 503) : reply(watch);
        if (url.pathname === '/api/watch/start') { const input = JSON.parse(body); Object.assign(watch, { running: true, status: 'running', owned: false, worker: { source: 'dsh', alive: true, status: 'running' } }); watch.counts.maxRequests = input.maxRequests; return reply(watch); }
        if (url.pathname === '/api/watch/stop') { Object.assign(watch, { running: false, status: 'stopped', worker: null }); return reply(watch); }
        if (url.pathname === '/api/persona') return reply(persona);
        if (url.pathname === '/api/persona/card') {
          const input = JSON.parse(body);
          if (rejectSave) { rejectSave = false; persona = { ...persona, revision: 'r3', manualText: '合成外部更新三' }; return reply({ error: '人格版本发生变化，草稿未保存' }, 409); }
          if (input.expectedRevision !== persona.revision) return reply({ error: '人格版本冲突' }, 409);
          persona = { ...persona, manualText: input.text, revision: 'r4' }; return reply(persona);
        }
        if (url.pathname === '/api/chat/state') return reply({ running: false, policy: { allowlist: [], dailyReplyLimit: 40 } });
        if (url.pathname === '/api/forward/contacts') return reply({ contacts: [{ id: 'synthetic-friend', name: '合成许可好友' }] });
        if (url.pathname === '/api/task') { taskRunning = true; task = { id: 'synthetic-manual-task', instruction: JSON.parse(body).instruction, status: 'running' }; return reply(task); }
        if (url.pathname === '/api/stop') { taskRunning = false; task.status = 'stopped'; return reply({ stopping: true }); }
        return reply({ ok: true });
      }
      const file = path.resolve(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (!file.startsWith(path.resolve(dist) + path.sep)) throw new Error('合成静态路径越界');
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
      const content = await fs.readFile(file); response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); response.end(content);
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('__getSettings', prefs);
  await page.exposeFunction('__openPersona', () => { personaOpened++; });
  await page.exposeFunction('__nativeMutation', payload => { nativeCalls.push(payload); return prefs(); });
  await page.addInitScript(() => { window.douyinDesktop = { getSettings: () => window.__getSettings(), openMemoryFolder: async () => {}, openPersonaFolder: () => window.__openPersona(), saveSettings: value => window.__nativeMutation(value), clearApiKey: () => window.__nativeMutation({ clear: true }) }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);

  await page.getByRole('button', { name: /◌ 对话与视频/ }).click();
  await page.getByRole('button', { name: /☷ 业务设置/ }).click(); await page.getByRole('tab', { name: '视频观看', exact: true }).click();
  await page.waitForTimeout(1700); assert.equal(calls.some(call => call.method === 'POST'), false);
  assert.equal(await page.getByRole('button', { name: /开始新一轮|停止自主观看/ }).count(), 0);
  assert.equal(await page.getByRole('button',{name:'开始自主观看',exact:true}).isEnabled(),true); assert.equal(await page.getByRole('button',{name:'暂停观看',exact:true}).isDisabled(),true);
  const automatic = page.getByRole('switch', { name: '允许自动观看', exact: true }); await automatic.click(); await page.getByText(/自主观看进行中/).waitFor();
  await page.getByRole('tab', { name: '基础设置', exact: true }).click(); await page.getByRole('button', { name: '配置模型与 API Key', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: 'API Key', exact: true }).isDisabled(), true); await page.getByRole('dialog').getByRole('button', { name: '返回', exact: true }).click();
  const personaSummary = page.locator('.effective-persona > summary');
  const effectiveText = page.getByText('合成当前生效人格，包含持续观察。', { exact: true });
  assert.equal(await effectiveText.isVisible(), false);
  assert.equal(await page.getByText('合成手编人格原文', { exact: true }).isVisible(), false);
  await personaSummary.click(); await effectiveText.waitFor();
  assert.equal(await page.locator('.persona-section .persona-card').count(), 1);
  assert.equal(await page.getByRole('button', { name: '编辑人格', exact: true }).isDisabled(), true);
  await page.getByRole('tab', { name: '视频观看', exact: true }).click(); await automatic.click(); await page.waitForFunction(() => document.querySelector('[aria-label="允许自动观看"]').getAttribute('aria-checked') === 'false');
  await page.getByRole('tab', { name: '基础设置', exact: true }).click(); await personaSummary.click(); await page.getByRole('button', { name: '编辑人格', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '人格正文', exact: true }); await editor.fill('合成保留草稿，不夹带自动兴趣'); persona = { ...persona, revision: 'r2', manualText: '合成外部更新二' };
  await page.getByText('人格文件已有新版本，未保存的草稿已保留。', { exact: true }).waitFor(); assert.equal(await editor.inputValue(), '合成保留草稿，不夹带自动兴趣');
  assert.equal(await page.getByRole('button', { name: '保存人格', exact: true }).count(), 0);
  await page.getByRole('button', { name: '打开人格文件夹', exact: true }).click(); assert.equal(personaOpened, 1);
  await page.getByText('合成观察：小猫正在玩球。', { exact: true }).waitFor();
  const interest = page.locator('.interest-details').filter({ hasText: '合成动物兴趣' });
  const interestSummary = interest.locator('summary');
  const reflection = interest.locator('.interest-reflection').filter({ hasText: '合成反思：识别到动物互动主题，尚不代表喜欢。' });
  await page.setViewportSize({ width: 920, height: 640 });
  await interestSummary.waitFor();
  assert.deepEqual(await interestSummary.locator(':scope > *').allTextContents(), ['合成动物兴趣', '待观察', '1 条依据']);
  assert.equal(await reflection.isVisible(), false);
  const collapsedHeight = (await interest.boundingBox()).height;
  assert.ok(collapsedHeight <= 48, '收起后占一行');
  await interestSummary.press('Enter'); await reflection.waitFor();
  assert.ok((await interest.boundingBox()).height > collapsedHeight);
  assert.equal(await interest.getByText('正向 0 · 负向 0 · 待观察 1', { exact: true }).count(), 1);
  assert.equal(await interest.getByText(/按不同作品汇总/).count(), 0);
  assert.equal(await reflection.getByText('观看 2 秒（20%） · 继续停留 1 次 · 待观察', { exact: true }).count(), 1);
  assert.doesNotMatch(await reflection.innerText(), /跳过 0 次|分享 0 次|已核对观看/);
  await reflection.getByText(/独立软件/).waitFor();
  await interestSummary.click(); await reflection.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /◉ 自主观看/ }).click(); await page.getByText('合成选择理由：对轻松动物题材感兴趣。', { exact: true }).waitFor();
  await interestSummary.waitFor(); assert.equal(await reflection.isVisible(), false);
  await page.getByRole('button', { name: /对话与视频/ }).click(); await page.getByRole('textbox', { name: '视频任务' }).fill('合成手动任务'); watchReadFails = true; await page.getByText('自主观看状态尚未核实，请等待本机服务回读后再开始操作。', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: '开始任务 ↑', exact: true }).isDisabled(), true);
  watchReadFails = false; await page.getByText('自主观看状态尚未核实，请等待本机服务回读后再开始操作。', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '开始任务 ↑', exact: true }).click(); await page.getByRole('button', { name: '■ 停止任务', exact: true }).waitFor(); await page.getByRole('button', { name: '■ 停止任务', exact: true }).click();
  await page.reload(); await page.getByRole('tab', { name: '视频观看', exact: true }).click(); await page.waitForTimeout(1700);
  assert.equal(calls.filter(call => ['/api/watch/start', '/api/watch/stop', '/api/video/start'].includes(call.route)).length, 0); assert.equal(calls.filter(call => call.route === '/api/watch/schedule' && call.method === 'POST').length, 2);
  assert.equal(calls.filter(call => call.method === 'POST').every(call => call.token === 'synthetic-autonomous-token'), true); assert.deepEqual(errors, []);
});
