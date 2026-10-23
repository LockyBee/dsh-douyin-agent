import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../playwright-runtime.mjs';

test('软件设置显式保存静默和评论许可，日报可读，断连恢复不抹掉业务错误', { timeout: 60_000 }, async t => {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const calls = [], errors = [];
  let offline = false, commentsUnavailable = false, failConfigure = false;
  let mode = { protocol: 'watch-mode-v1', silent: false, note: '合成静默状态。' };
  let schedule={policy:{enabled:false,maxRequests:30},note:'合成时段只运行一轮。'};
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
        if (url.pathname === '/api/bootstrap') return reply({ service: 'douyin-api-local', token: 'synthetic-watch-settings', config: { configured: true }, videoTime: { enabled: true }, mode: { available: true }, comments: { available: true }, reports: { available: true } });
        assert.equal(request.headers['x-session-token'], 'synthetic-watch-settings');
        if (url.pathname === '/api/state') return reply({ running: false, revision: 0, events: [] });
        if (url.pathname === '/api/watch/schedule') { if(request.method==='POST')schedule={...schedule,policy:JSON.parse(raw)};return reply(schedule); }
        if (url.pathname === '/api/interactions/state') return reply({rows:[{id:'chat',label:'好友新私信自动回复',running:false,message:'合成回复服务未启动。'}]});
        if (url.pathname === '/api/video/status') return reply({ allowed: true, window: {}, policy: { windows: ['00:00-24:00'], sessionMinutes: 10 } });
        if (url.pathname === '/api/usage') return reply({date:'2026-10-23',today:{},total:{},groups:[],days:[]});
        if (url.pathname === '/api/diagnostics') return reply({reportId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',checks:[{id:'window',label:'静默窗口实际状态',status:'fail',code:'SILENT_WINDOW_VISIBLE',message:'合成窗口仍显示',resolution:{steps:['合成修复建议']}}],repairableActions:[{id:'reapply_silent',label:'重新应用静默设置'}]});
        if (url.pathname === '/api/diagnostics/repair') { assert.deepEqual(JSON.parse(raw),{reportId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',action:'reapply_silent'});return reply({message:'合成修复已回读',after:{checks:[{id:'window',label:'静默窗口实际状态',status:'pass',code:'SILENT_WINDOW_MINIMIZED',message:'合成窗口已隐藏'}],repairableActions:[]}}); }
        if (url.pathname === '/api/task/limits') return reply({ policy: { maxSteps: 20, maxToolCalls: 20, timeoutSeconds: 180 } });
        if (url.pathname === '/api/chat/state') return reply({ running: false, policy: { allowlist: [] } });
        if (url.pathname === '/api/mode/state') return reply(mode);
        if (url.pathname === '/api/mode/configure') { mode = { ...mode, ...JSON.parse(raw) }; return reply(mode); }
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
  await page.addInitScript(() => { window.__updateCalls=[];window.douyinDesktop = { getSettings: async () => ({ configured: true, baseUrl: 'https://example.invalid', model: '合成模型', remember: false, memoryFolder: '合成共享记忆' }),checkUpdates:async()=>{window.__updateCalls.push('check');return{currentVersion:'1.4.1',latestVersion:'1.4.2',status:'available',message:'合成发现新版'};},downloadUpdate:async()=>{window.__updateCalls.push('download');return{status:'downloaded',message:'合成下载已核对'};},installUpdate:async()=>{window.__updateCalls.push('install');return{status:'restarting',message:'合成重启'};} }; });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);

  await page.getByRole('heading', { name: '大肥鱼抖音助手', exact: true }).waitFor();
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['基础设置','视频观看','好友互动','公开评论','音频与密钥','观看日报','自检与用量']);
  assert.equal(await page.locator('.business-sidebar').count(), 0);
  assert.deepEqual(await page.getByRole('navigation',{name:'主导航'}).getByRole('button').allTextContents(),['◌ 对话与视频','☷ 业务设置']);
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
  await page.getByRole('tab', {name:'视频观看',exact:true}).click();
  await page.getByRole('switch',{name:'按时段自动开始',exact:true}).click();
  await page.getByRole('spinbutton',{name:'自动观看模型请求上限',exact:true}).fill('99');
  await page.getByRole('button',{name:'保存自动启动设置',exact:true}).click();
  await page.getByText('自动启动已开启，应用需保持运行。',{exact:true}).waitFor();
  assert.deepEqual(schedule.policy,{enabled:true,maxRequests:99});
  await page.getByRole('button', {name:'谷时段（DeepSeek）',exact:true}).waitFor();
  await page.getByRole('combobox', {name:'观看方式',exact:true}).waitFor();
  const unifiedOutput = path.join(dist, '..', '.test-temp', 'unified-settings'); await fs.mkdir(unifiedOutput, {recursive:true});
  await page.screenshot({path:path.join(unifiedOutput,'software-video-settings.png'),fullPage:true});
  await page.getByRole('tab', {name:'基础设置',exact:true}).click();
  await page.getByRole('button', { name: /◌ 对话与视频/ }).click();
  await page.getByRole('button', { name: '展开快捷控制', exact: true }).click();
  const save = page.getByRole('button', { name: '保存评论许可', exact: true });
  await page.waitForFunction(() => document.querySelector('[aria-label="评论每日尝试上限"]')?.disabled === false);
  assert.deepEqual(calls.filter(item=>item.method==='POST').map(item=>item.route),['/api/watch/schedule']);
  await page.getByText('独立 API 版 · ' + JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8')).version, { exact: true }).waitFor();
  await page.getByRole('switch', { name: '静默观看', exact: true }).click();
  await page.getByRole('switch', { name: '允许自主发布评论' }).click();
  await page.getByRole('spinbutton', { name: '评论每日尝试上限' }).fill('5');
  await page.getByRole('spinbutton', { name: '评论每轮尝试上限' }).fill('2');
  await page.waitForTimeout(1700);
  assert.equal(await page.getByRole('switch', { name: '静默观看', exact: true }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByRole('spinbutton', { name: '评论每日尝试上限' }).inputValue(), '5');
  await page.getByRole('button', { name: '保存静默设置', exact: true }).click();
  failConfigure = true; await save.click();
  await page.getByRole('alert').filter({ hasText: '合成保存冲突' }).waitFor();
  await page.waitForTimeout(1700);
  assert.equal(await page.getByRole('spinbutton', { name: '评论每日尝试上限' }).inputValue(), '5');
  await page.getByRole('alert').filter({ hasText: '合成保存冲突' }).waitFor();
  failConfigure = false; await save.click();
  await page.waitForTimeout(250);
  assert.deepEqual(comments.policy, { enabled: true, dailyLimit: 5, perSessionLimit: 2 });
  commentsUnavailable = true;
  await page.getByText('评论状态尚未核实', { exact: false }).waitFor(); assert.equal(await save.isDisabled(), true);
  commentsUnavailable = false;
  await page.waitForFunction(() => document.querySelector('[aria-label="评论每日尝试上限"]')?.disabled === false);
  comments.needsReview = [{ operationId: 'synthetic-comment-1', videoId: '1234567890123' }]; comments.paused = true;
  await page.getByRole('button', { name: '已核对评论未发布' }).click();
  await page.getByText('核对结果已提交，等待回读。', { exact: true }).waitFor();
  await page.waitForTimeout(1700);
  assert.equal(calls.filter(item => item.route === '/api/comments/resolve').length, 1);
  await page.getByRole('button', { name: /☷ 业务设置/ }).click();
  await page.getByRole('tab', { name: '观看日报', exact: true }).click();
  await page.getByLabel('日报日期').waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="日报日期"]')?.value === '2026-10-23');
  await page.getByRole('button', { name: '生成今天日报' }).click();
  await page.getByRole('heading', { name: '合成观看日报' }).waitFor();
  await page.getByRole('button', { name: '读取所选日报' }).click();
  await page.getByText('实际观察 3 条作品，已核实观看 42 秒。', { exact: true }).waitFor();
  offline = true; await page.getByRole('alert').filter({ hasText: '合成本机服务断开' }).waitFor();
  const refresh = page.getByRole('button', { name: '刷新连接', exact: true }); assert.equal(await refresh.isDisabled(), false);
  offline = false; await refresh.click();
  await page.getByRole('alert').filter({ hasText: '合成本机服务断开' }).waitFor({ state: 'hidden' });
  await page.getByRole('tab',{name:'自检与用量',exact:true}).click();
  await page.getByRole('button',{name:'一键自检',exact:true}).click();
  await page.getByText('合成修复建议',{exact:true}).waitFor();
  await page.getByRole('button',{name:'修复：重新应用静默设置',exact:true}).click();
  await page.getByText('合成修复已回读',{exact:true}).waitFor();
  await page.getByText('查看或复制诊断报告',{exact:true}).click();
  assert.match(await page.getByRole('textbox',{name:'诊断报告',exact:true}).inputValue(), /SILENT_WINDOW_MINIMIZED/);
  const writes = calls.filter(item => item.method === 'POST');
  assert.deepEqual(writes.map(item => item.route), ['/api/watch/schedule','/api/mode/configure', '/api/comments/configure', '/api/comments/configure', '/api/comments/resolve', '/api/reports/generate','/api/diagnostics','/api/diagnostics/repair']);
  assert.deepEqual(writes[1].body, { silent: true });
  assert.deepEqual(writes[4].body, { operationId: 'synthetic-comment-1', outcome: 'not-sent' });
  assert.deepEqual(writes[5].body, {}); assert.deepEqual(errors, []);
  const output = path.join(dist, '..', '.test-temp', 'watch-settings'); await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'reports.png'), fullPage: true });
});
