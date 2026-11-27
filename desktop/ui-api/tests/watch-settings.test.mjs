import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../playwright-runtime.mjs';

test('软件统一分类中自动生效静默和评论，失败保留草稿，日报与更新操作保持独立', { timeout: 60_000 }, async t => {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const calls = [], errors = [];
  let offline = false, commentsUnavailable = false, failConfigure = false;
  let mode = { protocol: 'watch-mode-v1', silent: false, note: '合成静默状态。' };
  let browserMode = { protocol: 'browser-mode-v1', mode: 'visible', recordedMode: 'visible', running: true, restartRequired: false };
  let replyState = { friend: { canPrepare: true, preparing: false, lastErrorCode: 'BROWSER_NOT_RUNNING' } };
  let schedule={policy:{enabled:false,maxRequests:30},note:'合成时段只运行一轮。'};
  let watch = { running: false, updatedAt: '2026-10-23T03:00:00Z' };
  let watchingAllowed = true;
  let comments = { protocol: 'autonomous-comments-v1', enabled: false, busy: false, paused: false, policy: { enabled: false, dailyLimit: 3, perSessionLimit: 1 }, daily: { attempts: 0 }, needsReview: [] };
  const markdown = '# 合成观看日报\n\n实际观察 3 条作品，已核实观看 42 秒。';
  const catalog = () => ({ available: true, date: '2026-10-23', reports: [{ date: '2026-10-23' }] });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const reply = (data, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
    try {
      if (url.pathname.startsWith('/api/')) {
        let raw = ''; for await (const chunk of request) raw += chunk;
        calls.push({ route: url.pathname, body: raw ? JSON.parse(raw) : undefined, method: request.method });
        if (offline) return reply({ error: '合成本机服务断开' }, 503);
        if (url.pathname === '/api/bootstrap') return reply({ service: 'douyin-api-local', token: 'synthetic-watch-settings', config: { configured: true }, videoTime: { enabled: true }, mode: { available: true }, browserMode: { available: true }, comments: { available: true }, reports: { available: true }, watch: { available: true } });
        assert.equal(request.headers['x-session-token'], 'synthetic-watch-settings');
        if (url.pathname === '/api/state') return reply({ running: false, revision: 0, events: [] });
        if (url.pathname === '/api/watch/schedule') { if(request.method==='POST')schedule={...schedule,policy:JSON.parse(raw)};return reply(schedule); }
        if (url.pathname === '/api/watch/state') return reply(watch);
        if (url.pathname === '/api/interactions/state') return reply(replyState);
        if (url.pathname === '/api/chat/prepare') {
          assert.equal(request.method, 'POST');
          assert.deepEqual(JSON.parse(raw), {});
          browserMode = { ...browserMode, running: true, recordedMode: 'background' };
          replyState = { friend: { canPrepare: false, preparing: false, replyRunning: true, lastErrorCode: '' } };
          return reply(replyState);
        }
        if (url.pathname === '/api/video/status') return reply({ allowed: watchingAllowed, reason: watchingAllowed ? '' : '当前不在允许时段。', window: {}, policy: { windows: ['00:00-24:00'], sessionMinutes: 10 }, daily: { usedSeconds: 42, privateVideoSeconds: 9, requests: 2 } });
        if (url.pathname === '/api/usage') return reply({date:'2026-10-23',today:{},total:{},groups:[],days:[]});
        if (url.pathname === '/api/diagnostics') return reply({reportId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',checks:[{id:'window',label:'静默窗口实际状态',status:'fail',code:'SILENT_WINDOW_VISIBLE',message:'合成窗口仍显示',resolution:{steps:['合成修复建议']}}],repairableActions:[{id:'reapply_silent',label:'重新应用静默设置'}]});
        if (url.pathname === '/api/diagnostics/repair') { assert.deepEqual(JSON.parse(raw),{reportId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',action:'reapply_silent'});return reply({message:'合成修复已回读',after:{checks:[{id:'window',label:'静默窗口实际状态',status:'pass',code:'SILENT_WINDOW_MINIMIZED',message:'合成窗口已隐藏'}],repairableActions:[]}}); }
        if (url.pathname === '/api/task/limits') return reply({ policy: { maxSteps: 20, maxToolCalls: 20, timeoutSeconds: 180 } });
        if (url.pathname === '/api/chat/state') return reply({ running: false, policy: { allowlist: [] } });
        if (url.pathname === '/api/mode/state') return reply(mode);
        if (url.pathname === '/api/mode/configure') { mode = { ...mode, ...JSON.parse(raw) }; return reply(mode); }
        if (url.pathname === '/api/browser/mode') {
          if (request.method === 'POST') {
            const { mode: next } = JSON.parse(raw);
            await new Promise(resolve => setTimeout(resolve, 250));
            browserMode = { ...browserMode, mode: next, recordedMode: next, opened: next === 'visible', restartRequired: false };
          }
          return reply(browserMode);
        }
        if (url.pathname === '/api/comments/state') return commentsUnavailable ? reply({ error: '合成评论暂不可读' }, 503) : reply(comments);
        if (url.pathname === '/api/comments/configure') {
          if (failConfigure) return reply({ error: '合成保存冲突，请核对' }, 409);
          comments = { ...comments, enabled: JSON.parse(raw).enabled, policy: JSON.parse(raw) }; return reply(comments);
        }
        if (url.pathname === '/api/comments/resolve') return reply(comments);
        if (url.pathname === '/api/reports/state') return reply(catalog());
        if (url.pathname === '/api/reports/generate') return reply({ available: true, date: '2026-10-23', markdown });
        if (url.pathname === '/api/reports/read') { assert.equal(url.searchParams.get('date'), '2026-10-23'); return reply({ available: true, date: '2026-10-23', markdown }); }
        return reply({ error: '合成接口未定义' }, 404);
      }
      const file = path.resolve(dist, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      assert.ok(file.startsWith(path.resolve(dist) + path.sep));
      const types = { '.png':'image/png', '.svg':'image/svg+xml', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
      response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); response.end(await fs.readFile(file));
    } catch (error) { if (!response.headersSent) return reply({ error: error.message }, 500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__updateCalls = [];
    window.__verification = { required: false, automaticallyOpened: 0, holdNext: false };
    window.douyinDesktop = {
      getSettings: async () => ({ configured: true, baseUrl: 'https://example.invalid', model: '合成模型', remember: false, memoryFolder: '合成共享记忆' }),
      openBrowserVerification: async () => { window.__verification.automaticallyOpened++; return { status: 'opened', verificationRequired: true }; },
      checkBrowserVerification: async () => ({ status: 'ready', verificationRequired: false }),
      readBrowserVerificationStatus: async () => {
        const verification = window.__verification;
        const result = { required: verification.required, status: verification.required ? 'required' : 'ready' };
        if (verification.holdNext) {
          verification.holdNext = false;
          await new Promise(resolve => { verification.releaseRead = resolve; });
        }
        return result;
      },
      checkUpdates: async () => { window.__updateCalls.push('check'); return { currentVersion:'1.4.1', latestVersion:'1.4.2', status:'available', message:'合成发现新版' }; },
      downloadUpdate: async () => { window.__updateCalls.push('download'); return { status:'downloaded', message:'合成下载已核对' }; },
      installUpdate: async () => { window.__updateCalls.push('install'); return { status:'restarting', message:'合成重启' }; },
    };
  });
  browserMode = { ...browserMode, mode: 'background', recordedMode: null, running: false };
  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  await page.getByRole('heading', { name: '模型设置', exact: true }).waitFor();
  const verificationNotice = page.locator('.verification-status');
  await verificationNotice.getByText('专用浏览器尚未连接。', { exact: true }).waitFor();
  assert.equal(await verificationNotice.getByRole('button', { name: '检查验证', exact: true }).count(), 0);
  assert.equal(calls.filter(item => item.route === '/api/chat/prepare').length, 0);
  await verificationNotice.getByRole('button', { name: '准备回复通道', exact: true }).click();
  await verificationNotice.getByText('当前抖音页面已就绪。', { exact: true }).waitFor();
  assert.deepEqual(calls.filter(item => item.route === '/api/chat/prepare').map(item => item.body), [{}]);
  assert.equal(calls.filter(item => item.route === '/api/browser/open' || item.route === '/api/browser/mode' && item.method === 'POST').length, 0);
  assert.equal(browserMode.mode, 'background');
  browserMode = { ...browserMode, mode: 'visible', recordedMode: 'visible' };
  const verificationButton = page.locator('.verification-button');
  const verificationDot = verificationButton.locator('.verification-dot');
  assert.equal(await verificationDot.count(), 0);
  await page.evaluate(() => { window.__verification.required = true; });
  await verificationDot.waitFor({ state: 'visible', timeout: 12000 });
  assert.equal(await verificationButton.getAttribute('title'), '抖音需要安全验证');
  assert.equal(await verificationDot.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(250, 106, 114)');
  assert.equal(await page.evaluate(() => window.__verification.automaticallyOpened), 0);
  await page.evaluate(() => { window.__verification.holdNext = true; });
  await page.waitForFunction(() => typeof window.__verification.releaseRead === 'function', undefined, { timeout: 12000 });
  await verificationButton.click();
  await verificationNotice.getByRole('button', { name: '检查验证' }).click();
  await page.getByText('当前抖音页面已就绪。', { exact: true }).waitFor();
  await verificationDot.waitFor({ state: 'detached', timeout: 12000 });
  await page.evaluate(async () => {
    window.__verification.required = false;
    window.__verification.releaseRead();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.equal(await verificationDot.count(), 0);
  assert.equal(await verificationNotice.getByRole('button', { name: '检查验证' }).count(), 0);
  assert.equal(await page.evaluate(() => window.__verification.automaticallyOpened), 1);
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['基础设置','视频观看','好友互动','公开评论','音频与密钥','观看日报','自检与用量']);
  assert.equal(await page.locator('.business-sidebar').count(), 0);
  assert.deepEqual(await page.getByRole('navigation',{name:'主导航'}).getByRole('button').allTextContents(),['◌ 对话与视频','☷ 业务设置','◉ 自主观看记录']);
  await page.waitForFunction(()=>document.querySelector('.brand-icon img')?.naturalWidth>0);
  await page.getByRole('button',{name:'检查更新',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'软件更新',exact:true});await dialog.waitFor({state:'visible'});
  const dialogBox=await dialog.boundingBox(),viewport=page.viewportSize();assert.ok(dialogBox.x>=0&&dialogBox.y>=0&&dialogBox.x+dialogBox.width<=viewport.width&&dialogBox.y+dialogBox.height<=viewport.height,'更新弹窗必须完整位于窗口内');
  await page.screenshot({path:path.join(dist,'../.test-temp/software-update-dialog.png')});
  await page.getByRole('button',{name:'下载新版',exact:true}).click();
  await page.getByRole('button',{name:'更新并重启',exact:true}).click();
  await page.getByText('合成重启',{exact:true}).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.__updateCalls),['check','download','install']);
  await page.getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByRole('tab', { name: '视频观看', exact: true }).click();
  const beforeFailure = schedule;
  schedule = { ...schedule, lastError: '合成旧验证失败', last: { status: 'failed', error: '合成旧验证失败', completedAt: '2026-10-23T02:00:00Z' } };
  watch = { ...watch, status: 'failed', lastError: '合成新换片失败' };
  await page.getByText('合成新换片失败', { exact: true }).waitFor();
  assert.equal(await page.getByText('合成旧验证失败', { exact: true }).count(), 0);
  schedule = { ...schedule, lastError: '合成当前设置锁冲突' };
  await page.getByText('合成当前设置锁冲突', { exact: true }).waitFor();
  assert.equal(await page.getByText('合成新换片失败', { exact: true }).count(), 0);
  const recovery = page.getByRole('region', { name: '恢复自主观看', exact: true });
  await recovery.getByRole('button', { name: '打开自检', exact: true }).click();
  await page.getByRole('button', { name: '一键自检', exact: true }).waitFor();
  await page.getByRole('tab', { name: '视频观看', exact: true }).click();
  schedule = { ...beforeFailure, lastError: '合成视频暂停' };
  watch = { ...watch, status: 'needs_user', lastError: '合成视频暂停', recovery: { action: 'resume', message: '播放状态发生变化，观看已暂停。' } };
  await recovery.getByText('播放状态发生变化，观看已暂停。', { exact: true }).waitFor();
  watchingAllowed = false;
  await page.getByText('当前不在允许时段。', { exact: true }).waitFor();
  assert.equal(await recovery.getByRole('button', { name: '继续观看', exact: true }).isDisabled(), true);
  watchingAllowed = true;

  await page.evaluate(() => { window.__verification.required = true; });
  await verificationDot.waitFor({ state: 'visible', timeout: 12000 });
  schedule = { ...beforeFailure, lastError: '观看页需要抖音安全验证。' };
  watch = { ...watch, lastError: schedule.lastError, recovery: { action: 'verify', message: schedule.lastError } };
  await recovery.getByText(schedule.lastError, { exact: true }).waitFor();
  assert.equal(await recovery.getByRole('button', { name: '继续观看', exact: true }).count(), 0);
  const resumes = calls.filter(item => item.route === '/api/watch/schedule' && item.method === 'POST').length;
  await recovery.getByRole('button', { name: '辅助验证', exact: true }).click();
  await page.evaluate(() => { window.__verification.required = false; });
  await recovery.getByRole('button', { name: '检查验证', exact: true }).click();
  await verificationDot.waitFor({ state: 'detached', timeout: 12000 });
  assert.equal(calls.filter(item => item.route === '/api/watch/schedule' && item.method === 'POST').length, resumes);
  const resumed = page.waitForResponse(response => response.url().endsWith('/api/watch/schedule') && response.request().method() === 'POST');
  await recovery.getByRole('button', { name: '继续观看', exact: true }).click();
  await resumed;
  assert.deepEqual(calls.filter(item => item.route === '/api/watch/schedule' && item.method === 'POST').slice(resumes).map(item => item.body), [{ enabled: true }]);
  schedule = beforeFailure;
  watch = { running: false, updatedAt: '2026-10-23T03:00:00Z' };
  await recovery.waitFor({ state: 'hidden' });
  const usage = page.getByLabel('今日视频用量');
  await usage.getByText('今日自主观看', { exact: true }).locator('..').getByText('42 秒', { exact: true }).waitFor();
  await usage.getByText('今日私信视频', { exact: true }).locator('..').getByText('9 秒', { exact: true }).waitFor();
  await usage.getByText('模型请求', { exact: true }).locator('..').getByText('2 次', { exact: true }).waitFor();
  await page.getByRole('switch', { name: '允许自动观看', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[aria-label="允许自动观看"]').getAttribute('aria-checked') === 'true');
  assert.deepEqual(schedule.policy, { enabled: true });
  const background = page.getByRole('switch', { name: '后台观看', exact: true });
  const silent = page.getByRole('switch', { name: '静默观看', exact: true });
  await background.click();
  const changing = page.getByText('正在切换到后台…', { exact: true });
  await changing.waitFor();
  await changing.waitFor({ state: 'hidden' });
  assert.equal(browserMode.mode, 'background');
  assert.equal(mode.silent, false);
  assert.equal(browserMode.recordedMode, 'background');
  await silent.click();
  await page.waitForTimeout(300);
  assert.equal(mode.silent, true);
  assert.equal(browserMode.mode, 'background');
  await background.click();
  await page.getByText('正在打开专用浏览器并恢复回复…', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const control = document.querySelector('[aria-label="后台观看"]');
    return control.getAttribute('aria-checked') === 'false' && !control.disabled;
  });
  assert.equal(await page.getByRole('button', { name: '应用当前设置' }).count(), 0);
  assert.equal(browserMode.mode, 'visible');
  assert.equal(browserMode.opened, true);
  assert.equal(mode.silent, true);
  assert.deepEqual(calls.filter(item => item.route === '/api/browser/mode' && item.method === 'POST').map(item => item.body),
    [{ mode: 'background' }, { mode: 'visible' }]);
  assert.deepEqual(calls.filter(item => item.route === '/api/mode/configure').map(item => item.body), [{ silent: true }]);
  assert.equal(await page.getByRole('button', { name: '保存静默设置', exact: true }).count(), 0);
  await page.getByRole('tab', { name: '公开评论', exact: true }).click(); failConfigure = true;
  await page.getByRole('switch', { name: '允许自主发布评论', exact: true }).click(); await page.getByRole('spinbutton', { name: '评论每日尝试上限' }).fill('5'); await page.getByRole('spinbutton', { name: '评论每轮尝试上限' }).fill('2');
  await page.getByRole('alert').filter({ hasText: '合成保存冲突' }).waitFor(); await page.waitForTimeout(800);
  const failedWrites = calls.filter(item => item.route === '/api/comments/configure').length;
  await page.waitForTimeout(1700); assert.equal(calls.filter(item => item.route === '/api/comments/configure').length, failedWrites);
  assert.equal(await page.getByRole('spinbutton', { name: '评论每日尝试上限' }).inputValue(), '5'); assert.equal(await page.getByRole('button', { name: '保存评论许可', exact: true }).count(), 0);
  failConfigure = false; await page.getByRole('spinbutton', { name: '评论每日尝试上限' }).fill('6'); await page.waitForTimeout(850); assert.deepEqual(comments.policy, { enabled: true, dailyLimit: 6, perSessionLimit: 2 });
  commentsUnavailable = true; await page.getByText('评论状态尚未核实', { exact: false }).waitFor(); commentsUnavailable = false; await page.waitForFunction(() => document.querySelector('[aria-label="评论每日尝试上限"]')?.disabled === false);
  comments.needsReview = [{ operationId: 'synthetic-comment-1', videoId: '1234567890123' }]; comments.paused = true; await page.getByRole('button', { name: '已核对评论未发布' }).click(); await page.getByText('核对结果已提交，等待回读。', { exact: true }).waitFor();
  await page.waitForTimeout(1700); assert.equal(calls.filter(item => item.route === '/api/comments/resolve').length, 1);
  await page.getByRole('tab', { name: '观看日报', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[aria-label="日报日期"]')?.value === '2026-10-23'); await page.getByRole('button', { name: '生成今天日报' }).click(); await page.getByRole('heading', { name: '合成观看日报' }).waitFor(); await page.getByRole('button', { name: '读取所选日报' }).click(); await page.getByText('实际观察 3 条作品，已核实观看 42 秒。', { exact: true }).waitFor();
  offline = true; await page.getByRole('alert').filter({ hasText: '合成本机服务断开' }).waitFor(); offline = false; await page.getByRole('button', { name: '刷新连接', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '合成本机服务断开' }).waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: '自检与用量', exact: true }).click(); await page.getByRole('button', { name: '一键自检', exact: true }).click(); await page.getByText('合成修复建议', { exact: true }).waitFor(); await page.getByRole('button', { name: '修复：重新应用静默设置', exact: true }).click(); await page.getByText('合成修复已回读', { exact: true }).waitFor();
  assert.equal(calls.filter(item => item.method === 'POST').every(item => ['/api/chat/prepare', '/api/watch/schedule', '/api/mode/configure', '/api/browser/mode', '/api/comments/configure', '/api/comments/resolve', '/api/reports/generate', '/api/diagnostics', '/api/diagnostics/repair'].includes(item.route)), true);
  assert.deepEqual(errors, []);
});
