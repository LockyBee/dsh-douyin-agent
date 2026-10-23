import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from '../../../playwright-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const recipients = [{ id: 'conv:' + 'a'.repeat(64), name: '合成问候好友甲', status: 'already-interacted', reason: '合成记录：今日已有发出作品卡片。' }, { id: 'conv:' + 'b'.repeat(64), name: '合成问候好友乙', status: 'date-unknown', reason: '合成记录：最新消息未提供可靠日期。' }];
function state() { return { protocol: 'spark-v1', enabled: false, running: false, starting: false, busy: false, worker: null, timeZone: 'Asia/Shanghai', policy: { enabled: false, windows: ['09:00-22:00'], dailyLimit: 2 }, daily: { date: '2026-10-15', attempts: 0, confirmed: 0, remaining: 2 }, recipients: structuredClone(recipients), needsReview: [], recent: [] }; }

async function fixture(t, { assets, component = false } = {}) {
  const fixture = { spark: state(), configured: true, connected: true, failState: false, stateHold: false, failConfigure: false, failResolve: false, holdReview: false, calls: [], errors: [], native: [] };
  const token = 'synthetic-spark-session';
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const reply = (value, code = 200) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (url.pathname === '/synthetic-state') return reply({ spark: fixture.spark, connected: fixture.connected, configured: fixture.configured });
      if (url.pathname.startsWith('/api/')) {
        let raw = ''; for await (const chunk of request) raw += chunk;
        fixture.calls.push({ route: url.pathname, method: request.method, body: raw ? JSON.parse(raw) : undefined, token: request.headers['x-session-token'] });
        if (url.pathname === '/api/bootstrap') return reply({ service: 'douyin-api-local', token, config: { configured: fixture.configured }, spark: { available: true }, videoTime: { enabled: true }, limits: { maxSteps: 20, maxToolCalls: 20, taskTimeoutSeconds: 180 } });
        if (request.headers['x-session-token'] !== token) return reply({ error: '合成会话校验失败。' }, 403);
        if (url.pathname === '/api/state') return reply({ running: false, revision: 0, events: [] });
        if (url.pathname === '/api/video/status') return reply({ allowed: true, window: {}, remainingSeconds: 120, session: { status: 'active' }, policy: { windows: ['00:00-24:00'], sessionMinutes: 10 } });
        if (url.pathname === '/api/task/limits') return reply({ policy: { maxSteps: 20, maxToolCalls: 20, timeoutSeconds: 180 }, hardLimits: {} });
        if (url.pathname === '/api/chat/state') return reply({ running: false, policy: { allowlist: recipients, dailyReplyLimit: 40 }, daily: { requests: 0, limit: 40 } });
        if (url.pathname === '/api/spark/state') {
          if (fixture.failState) return reply({ error: '合成问候状态暂时不可读。' }, 503);
          if (fixture.stateHold) return reply({ protocol: 'unknown' });
          return reply(fixture.spark);
        }
        if (url.pathname === '/api/spark/configure') {
          if (fixture.failConfigure) return reply({ error: '合成设置忙，请稍后保存。' }, 409);
          fixture.spark.enabled = JSON.parse(raw).enabled; fixture.spark.policy = JSON.parse(raw); return reply(fixture.spark);
        }
        if (url.pathname === '/api/spark/start') { fixture.spark.running = true; fixture.spark.worker = { alive: true, owned: true, source: 'api' }; return reply(fixture.spark); }
        if (url.pathname === '/api/spark/stop') { fixture.spark.running = false; fixture.spark.worker = null; fixture.spark.busy = false; fixture.spark.starting = false; return reply(fixture.spark); }
        if (url.pathname === '/api/spark/resolve') {
          if (fixture.failResolve) return reply({ error: '合成核对冲突，未记入结果。' }, 409);
          if (!fixture.holdReview) fixture.spark.needsReview = fixture.spark.needsReview.filter(item => item.operationId !== JSON.parse(raw).operationId);
          return reply(fixture.spark);
        }
        if (url.pathname === '/api/task') return reply({ id: 'synthetic-task', status: 'running' });
        return reply({ ok: true });
      }
      if (component && url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html lang="zh-CN"><link rel="stylesheet" href="/app.css"><body data-ds-dark-theme><div id="root"></div><script type="module" src="/app.js"></script></body></html>'); return; }
      const file = path.resolve(assets, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (!file.startsWith(path.resolve(assets) + path.sep)) throw new Error('合成资源路径越界。');
      const content = await fs.readFile(file), types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
      response.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); response.end(content);
    } catch (error) { if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const profile = await fs.mkdtemp(path.join(tmpdir(), 'douyin-spark-ui-'));
  const browser = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport: { width: component ? 480 : 1440, height: component ? 1050 : 950 } });
  t.after(async () => { await browser.close(); assert.equal(path.dirname(path.resolve(profile)), path.resolve(tmpdir())); await fs.rm(profile, { recursive: true, force: true }); });
  const page = browser.pages()[0]; page.on('pageerror', error => fixture.errors.push(error.message));
  if (!component) {
    await page.exposeFunction('__sparkSettings', () => ({ configured: fixture.configured, model: '合成问候模型', baseUrl: 'https://api.example.invalid', memoryFolder: 'C:\\合成问候记忆' }));
    await page.exposeFunction('__sparkNative', operation => { fixture.native.push(operation); return {}; });
    await page.addInitScript(() => { window.douyinDesktop = { getSettings: () => window.__sparkSettings(), saveSettings: value => window.__sparkNative('save'), clearApiKey: () => window.__sparkNative('clear'), openMemoryFolder: async () => {} }; });
  }
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  if (!component) {
  await page.getByRole('button', { name: /◌ 对话与视频/ }).click();
  await page.getByRole('button', { name: '展开快捷控制', exact: true }).click();
  }
  return { ...fixture, data: fixture, page, panel: page.locator('[aria-labelledby="spark-title"]') };
}

async function componentAssets() {
  const desktop = createRequire(new URL('../../package.json', import.meta.url)), local = createRequire(new URL('../package.json', import.meta.url));
  const { build } = desktop('esbuild'), output = path.join(root, '.test-temp', 'spark-component'); await fs.mkdir(output, { recursive: true });
  const upstream = fileURLToPath(new URL('../../.cache/upstream/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/client/', import.meta.url));
  await build({ stdin: { sourcefile: 'spark-harness.jsx', resolveDir: root, loader: 'jsx', contents: `
import React,{useEffect,useState,useRef}from'react';import{createRoot}from'react-dom/client';import{SparkPanel}from'./src/spark-panel.jsx';import'@dsh/theme/base.css';import'./src/style.css';
function Harness(){const[data,setData]=useState({}),[busy,setBusy]=useState(new Set()),[error,setError]=useState('');const locks=useRef(new Set());
async function poll(){const response=await fetch('/synthetic-state');setData(await response.json())}
useEffect(()=>{void poll();const timer=setInterval(()=>{void poll()},100);return()=>clearInterval(timer)},[]);
async function api(route,body){const response=await fetch(route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-session-token':'synthetic-spark-session'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new Error(value.error);return value}
async function run(name,action){if(locks.current.has(name))return;locks.current.add(name);setBusy(new Set(locks.current));setError('');try{await action();await poll()}catch(error){setError(error.message)}finally{locks.current.delete(name);setBusy(new Set(locks.current))}}
return <div className="app-frame" style={{padding:28,width:430,overflow:'auto',height:'100vh'}}><SparkPanel state={data.spark} api={api} run={run} busy={busy} configured={data.configured} connected={data.connected}/>{error&&<p role="alert">{error}</p>}</div>};createRoot(document.getElementById('root')).render(<Harness/>);` }, outfile: path.join(output, 'app.js'), bundle: true, format: 'esm', platform: 'browser', target: ['chrome120'], jsx: 'automatic',
    alias: { '@dsh/primitives': path.join(upstream, 'ui-primitives/src/index.ts'), '@dsh/theme': path.join(upstream, 'ui-theme/src/styles'), ...Object.fromEntries(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => [name, local.resolve(name)])) },
    nodePaths: [path.join(root, 'node_modules')], tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } }, loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' }, assetNames: 'assets/[name]-[hash]', define: { 'process.env.NODE_ENV': '"production"' }, minify: true,
  });
  return output;
}

test('主动问候组件只显式保存和启停，保留草稿并拒绝无效时段、重复核对与未确认重发', { timeout: 40_000 }, async t => {
  const assets = await componentAssets(), { data, page, panel } = await fixture(t, { assets, component: true });
  const toggle = panel.getByRole('switch', { name: '允许自动续火花', exact: true }), windows = panel.getByRole('textbox', { name: '每日问候时段', exact: true }), limit = panel.getByRole('spinbutton', { name: '每日主动问候总上限', exact: true });
  const save = panel.getByRole('button', { name: '保存自动问候设置', exact: true }), start = panel.getByRole('button', { name: '开始自动续火花', exact: true }), stop = panel.getByRole('button', { name: '停止自动问候', exact: true });
  await page.waitForFunction(() => document.querySelector('[aria-label="每日问候时段"]')?.disabled === false);
  assert.equal(await toggle.getAttribute('aria-checked'), 'false'); assert.equal(await start.isDisabled(), true); assert.equal(data.calls.filter(item => item.method === 'POST').length, 0);
  await panel.getByText('今日已有发出互动', { exact: false }).waitFor(); await panel.getByText('消息日期尚未核实', { exact: false }).waitFor();
  assert.equal(await panel.locator('select').count(), 0); assert.doesNotMatch(await panel.innerText(), /火花\s*\+\s*1|立即发送/);
  await toggle.click(); await windows.fill('20:00-21:00\n23:00-01:00'); await limit.fill('1'); await page.waitForTimeout(250);
  assert.equal(await windows.inputValue(), '20:00-21:00\n23:00-01:00'); assert.equal(await start.isDisabled(), true);
  await windows.fill('24:30-25:00'); await save.click(); await page.getByRole('alert').filter({ hasText: '问候时段无效' }).waitFor(); assert.equal(data.calls.filter(item => item.method === 'POST').length, 0);
  await windows.fill('20:00-21:00\n23:00-01:00'); await limit.fill('3'); await save.click(); assert.equal(await limit.evaluate(input => input.validity.rangeOverflow), true); assert.equal(data.calls.filter(item => item.method === 'POST').length, 0);
  await limit.fill('1'); data.failConfigure = true; await save.click(); await page.getByRole('alert').filter({ hasText: '合成设置忙' }).waitFor(); assert.equal(await start.isDisabled(), true); assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  assert.equal(data.calls.filter(item => item.route === '/api/spark/configure').length, 1);
  data.failConfigure = false; await save.click(); await panel.getByText('自动问候设置已保存，尚未启动。点击“开始自动续火花”后才会调度发送。', { exact: true }).waitFor();
  assert.deepEqual(data.calls.filter(item => item.route === '/api/spark/configure').at(-1).body, { enabled: true, windows: ['20:00-21:00', '23:00-01:00'], dailyLimit: 1 });
  assert.equal(data.calls.some(item => item.route === '/api/spark/start'), false); await start.click(); await panel.getByText('调度中', { exact: true }).waitFor();
  await stop.click(); await panel.getByText('已许可·未运行', { exact: true }).waitFor(); assert.equal(data.spark.enabled, true);
  data.configured = false; await page.waitForTimeout(250); assert.equal(await start.isDisabled(), true); await toggle.click(); await save.click(); await panel.getByText('已关闭主动问候许可并请求停止服务；请以回读状态为准。', { exact: true }).waitFor();
  const writes = data.calls.filter(item => item.method === 'POST'); assert.deepEqual(writes.slice(-2).map(item => item.route), ['/api/spark/configure', '/api/spark/stop']); assert.equal(data.spark.enabled, false);
  data.spark.needsReview = [{ operationId: 'synthetic-review', recipientId: recipients[1].id, status: 'uncertain' }]; data.failResolve = true;
  const confirmed = panel.getByRole('button', { name: '已核对问候已发送', exact: true }); await confirmed.waitFor(); await confirmed.click(); await page.getByRole('alert').filter({ hasText: '合成核对冲突' }).waitFor();
  assert.equal(await confirmed.isDisabled(), false); data.failResolve = false; data.holdReview = true; await confirmed.click(); await panel.getByText('核对结果已提交，等待回读；不会重复提交。', { exact: true }).waitFor();
  await page.waitForTimeout(250); assert.equal(await confirmed.count(), 0); assert.equal(data.calls.filter(item => item.route === '/api/spark/resolve').length, 2);
  data.connected = false; await panel.getByText('自动问候状态尚未核实，暂不能修改或启动，请等待本机服务回读。', { exact: true }).waitFor(); assert.equal(await save.isDisabled(), true);
  await panel.screenshot({ path: path.join(assets, 'spark-panel.png') }); assert.deepEqual(data.errors, []);
  assert.equal(data.calls.filter(item => item.method === 'POST').every(item => ['/api/spark/configure', '/api/spark/start', '/api/spark/stop', '/api/spark/resolve'].includes(item.route) && item.token === 'synthetic-spark-session'), true);
});

test('主界面回读问候状态，问候运行中禁止换Key，状态失联不保留可用入口，也不阻止手动视频任务', { timeout: 40_000 }, async t => {
  const { data, page, panel } = await fixture(t, { assets: path.join(root, 'dist') });
  const save = panel.getByRole('button', { name: '保存自动问候设置', exact: true }); await page.waitForFunction(() => document.querySelector('[aria-label="每日问候时段"]')?.disabled === false);
  assert.equal(data.calls.filter(item => item.method === 'POST').length, 0);
  Object.assign(data.spark, { enabled: true, running: true, worker: { alive: true, source: 'dsh', owned: false } }); data.spark.policy.enabled = true;
  await panel.getByText('调度中', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: '视频任务', exact: true }).fill('只执行合成视频任务，不操作实际抖音。');
  const videoStart = page.getByRole('button', { name: '开始任务 ↑', exact: true }); assert.equal(await videoStart.isDisabled(), false);
  await page.getByRole('button', { name: /☷ 业务设置/ }).click();
  await page.getByRole('tab', { name: '基础设置', exact: true }).click();
  await page.getByRole('button', { name: '配置模型与 API Key', exact: true }).click(); const dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), true); assert.equal(await dialog.getByRole('button', { name: '清除已保存的 API Key', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: /◌ 对话与视频/ }).click();
  data.failState = true; await panel.getByText('自动问候状态尚未核实，暂不能修改或启动，请等待本机服务回读。', { exact: true }).waitFor(); assert.equal(await save.isDisabled(), true);
  data.failState = false; data.stateHold = true; await page.waitForTimeout(1700); assert.equal(await save.isDisabled(), true);
  data.stateHold = false; data.spark.running = false; data.spark.worker = null;
  await page.waitForFunction(() => document.querySelector('[aria-label="每日问候时段"]').disabled === false);
  await page.getByRole('button', { name: /☷ 业务设置/ }).click();
  await page.getByRole('tab', { name: '基础设置', exact: true }).click();
  await page.getByRole('button', { name: '配置模型与 API Key', exact: true }).click(); assert.equal(await dialog.getByRole('button', { name: '保存设置', exact: true }).isDisabled(), false); await dialog.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: /◌ 对话与视频/ }).click();
  await panel.getByRole('switch', { name: '允许自动续火花', exact: true }).click(); await save.click(); await panel.getByText('已关闭主动问候许可并请求停止服务；请以回读状态为准。', { exact: true }).waitFor();
  assert.deepEqual(data.calls.filter(item => item.method === 'POST').map(item => ({ route: item.route, body: item.body })), [{ route: '/api/spark/configure', body: { enabled: false, windows: ['09:00-22:00'], dailyLimit: 2 } }, { route: '/api/spark/stop', body: {} }]);
  assert.deepEqual(data.native, []); assert.deepEqual(data.errors, []);
  assert.equal(data.calls.filter(item => item.route === '/api/spark/state').every(item => item.token === 'synthetic-spark-session'), true);
});
