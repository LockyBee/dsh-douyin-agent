import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../playwright-runtime.mjs';

test('自主观看与人格使用合成服务验证有限启动、跨入口互斥、草稿冲突和共用目录', { timeout: 65_000 }, async t => {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const shots = fileURLToPath(new URL('../.test-temp/', import.meta.url)); await fs.mkdir(shots, { recursive: true });
  const calls = [], errors = [], nativeCalls = [];
  let taskRunning = false, task = null, rejectSave = false, personaOpened = 0, watchReadFails = false;
  const video = { allowed: false, window: { expiresAt: Date.now() + 600_000 }, remainingSeconds: 0, session: { status: 'ended' }, policy: { windows: ['00:00-24:00'], sessionMinutes: 10 } };
  const watch = { protocol: 'autonomous-watch-v1', running: false, owned: false, worker: null, status: 'stopped', sessionId: 'synthetic-session-1', counts: { requests: 1, maxRequests: 30, dailyRequests: 2, dailyLimit: 200 }, remainingSeconds: 0, lastDecision: { action: 'search', reason: '合成选择理由：对轻松动物题材感兴趣。', query: '合成猫咪', topics: ['动物'] } };
  let persona = { personaFolder: 'C:\\合成共享记忆\\persona', roleCardFile: 'C:\\合成共享记忆\\persona\\role-card.md', revision: 'r1', manualText: '合成手编人格原文', personaText: '合成当前生效人格，包含持续观察。', interests: [{ topic: '合成动物兴趣', key: 'synthetic-topic', signal: 'neutral', counts: { like: 0, dislike: 0, neutral: 1 }, basis: '合成依据：仅有画面，待实际观看行为核实。', updatedAt: 1792058400000, evidence: [{ evidenceId: 'synthetic-evidence', videoId: '1234567890123', reflection: '合成反思：识别到动物互动主题，尚不代表喜欢。', watchedSeconds: 2, watchRatio: 0.2, actions: { stay: 0, skip: 0, share: 0 }, basis: '合成依据：观看不足以判断喜好。', source: 'api', at: 1792058400000 }] }], recentObservations: [{ id: 'synthetic-observation', videoId: '1234567890123', title: '合成观察：小猫正在玩球。', author: '合成公开作者', kind: 'visual', playback: { time: 3, duration: 10, paused: true }, watchedSeconds: 2, watchRatio: 0.2, actions: { stay: 0, skip: 0, share: 0 }, basis: '合成依据：观看不足以判断喜好。', frameCount: 1, source: 'api', observedAt: 1792058400000 }] };
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
  await page.getByRole('button', { name: '展开快捷控制', exact: true }).click();
  await page.getByRole('button', { name: '开始自主观看', exact: true }).waitFor();
  await page.waitForTimeout(1700);
  assert.equal(calls.some(call => call.method === 'POST'), false, '页面初始化与轮询不会启动新轮或自主观看');
  assert.equal(await page.getByRole('button', { name: '开始自主观看', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '开始新一轮', exact: true }).click();
  await page.getByRole('spinbutton', { name: '自主观看请求上限' }).fill('10001');
  await page.getByRole('button', { name: '开始自主观看', exact: true }).click();
  await page.getByText('本轮请求上限须为 1 至 10000 的整数。', { exact: true }).waitFor();
  assert.equal(calls.filter(call => call.route === '/api/watch/start').length, 0);
  await page.getByRole('spinbutton', { name: '自主观看请求上限' }).fill('4'); await page.waitForTimeout(1600);
  assert.equal(await page.getByRole('spinbutton', { name: '自主观看请求上限' }).inputValue(), '4');
  await page.getByRole('button', { name: '开始自主观看', exact: true }).click();
  await page.getByText('当前由另一个入口运行，停止按钮仍可请求停止。', { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(calls.find(call => call.route === '/api/watch/start').body), { startSession: false, maxRequests: 4 });
  await page.getByRole('textbox', { name: '视频任务' }).fill('合成手动任务');
  assert.equal(await page.getByRole('button', { name: '开始任务 ↑', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '读取许可好友', exact: true }).click(); await page.getByLabel('转发收件人', { exact: true }).selectOption('synthetic-friend');
  assert.equal(await page.getByRole('button', { name: '确认转发给所选好友', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: /☷ 业务设置/ }).click();
  await page.getByRole('tab', { name: '基础设置', exact: true }).click();
  await page.getByRole('button', { name: '配置模型与 API Key', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '清除已保存的 API Key', exact: true }).isDisabled(), true);
  await page.getByRole('dialog').getByRole('button', { name: '返回', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '编辑人格', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '停止当前自主观看', exact: true }).click();
  await page.getByRole('button', { name: '编辑人格', exact: true }).click();
  await page.getByRole('textbox', { name: '人格正文', exact: true }).fill('合成保留草稿，不夹带自动兴趣');
  persona = { ...persona, revision: 'r2', manualText: '合成外部更新二' };
  await page.getByText('人格文件已有新版本，未保存的草稿已保留。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '人格正文', exact: true }).inputValue(), '合成保留草稿，不夹带自动兴趣');
  assert.equal(await page.getByRole('button', { name: '保存人格', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '保留草稿，采用最新版本号', exact: true }).click();
  rejectSave = true;
  await page.getByRole('button', { name: '保存人格', exact: true }).click();
  await page.getByText('保存前文件已更新，草稿已保留。请比较后选择使用哪个版本。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '人格正文', exact: true }).inputValue(), '合成保留草稿，不夹带自动兴趣');
  assert.equal(calls.filter(call => call.route === '/api/persona/card').length, 1, '冲突不自动重试');
  await page.getByRole('button', { name: '保留草稿，采用最新版本号', exact: true }).click();
  await page.getByRole('button', { name: '保存人格', exact: true }).click();
  await page.getByText('人格正文已保存，两个入口会读取同一份文件。', { exact: true }).waitFor();
  assert.deepEqual(JSON.parse(calls.filter(call => call.route === '/api/persona/card').at(-1).body), { text: '合成保留草稿，不夹带自动兴趣', expectedRevision: 'r3' });
  await page.getByRole('button', { name: '打开人格文件夹', exact: true }).click(); assert.equal(personaOpened, 1);
  await page.getByText('合成观察：小猫正在玩球。', { exact: true }).waitFor();
  await page.locator('.interest-reflection').filter({ hasText: '合成反思：识别到动物互动主题，尚不代表喜欢。' }).waitFor();
  assert.match(await page.locator('.interest-card').innerText(), /1 条作品依据.*更新于/);
  assert.equal(await page.getByText('待观察', { exact: true }).isVisible(), true);
  assert.equal(await page.getByText('感兴趣', { exact: true }).count(), 0);
  await page.screenshot({ path: path.join(shots, 'synthetic-persona.png'), fullPage: true });
  await page.getByRole('button', { name: /◉ 自主观看/ }).click();
  await page.getByText('合成选择理由：对轻松动物题材感兴趣。', { exact: true }).waitFor();
  assert.equal(await page.getByText('本轮剩余 2分0秒', { exact: true }).isVisible(), true);
  assert.equal(watch.counts.requests, 1, '停止不会清零本轮预算');
  await page.screenshot({ path: path.join(shots, 'synthetic-watch.png'), fullPage: true });
  await page.getByRole('button', { name: /对话与视频/ }).click();
  watchReadFails = true;
  await page.getByText('自主观看状态尚未核实，请等待本机服务回读后再开始操作。', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '开始任务 ↑', exact: true }).isDisabled(), true, '已停止的旧快照不能在新状态读取失败时放行');
  watchReadFails = false;
  await page.getByText('自主观看状态尚未核实，请等待本机服务回读后再开始操作。', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '开始任务 ↑', exact: true }).click();
  await page.getByRole('button', { name: '■ 停止任务', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '开始自主观看', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: '■ 停止任务', exact: true }).click();
  Object.assign(video, { allowed: false, remainingSeconds: 0, session: { status: 'ended' } });
  Object.assign(watch, { status: 'limited', remainingSeconds: 0 });
  await page.getByText('达到限制', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '开始自主观看', exact: true }).isDisabled(), true);
  await page.reload(); await page.getByRole('tab', { name: '视频观看', exact: true }).click(); await page.getByRole('button', { name: '开始自主观看', exact: true }).waitFor(); await page.waitForTimeout(1700);
  assert.equal(calls.filter(call => call.route === '/api/watch/start').length, 1, '重连与重载不自动恢复自主观看');
  assert.equal(calls.filter(call => call.route === '/api/watch/stop').length, 1);
  assert.equal(calls.filter(call => call.route === '/api/video/start').length, 1);
  assert.equal(calls.filter(call => call.route === '/api/forward').length, 0);
  assert.equal(calls.filter(call => call.method === 'POST').every(call => call.token === 'synthetic-autonomous-token'), true);
  assert.deepEqual(nativeCalls, []); assert.deepEqual(errors, []);
});
