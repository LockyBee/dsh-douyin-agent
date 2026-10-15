import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from '../../../playwright-runtime.mjs';
import { DEFAULT_TASK_POLICY, TASK_LIMIT_BOUNDS } from '../../../task-limits.mjs';

test('手动任务预算组件保留未保存输入、运行时禁改，只显式保存三个有限上限', { timeout: 30_000 }, async t => {
  const root = fileURLToPath(new URL('../', import.meta.url)), desktop = createRequire(new URL('../../package.json', import.meta.url)), local = createRequire(new URL('../package.json', import.meta.url));
  const { build } = desktop('esbuild');
  const output = path.join(root, '.test-temp', 'task-budget'); await fs.mkdir(output, { recursive: true });
  const upstream = fileURLToPath(new URL('../../.cache/upstream/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/client/', import.meta.url));
  await build({ stdin: { sourcefile: 'task-budget-harness.jsx', resolveDir: root, loader: 'jsx', contents: `
import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';
import{TaskBudgetPanel}from'./src/task-budget.jsx';import'@dsh/theme/base.css';import'./src/style.css';
function Harness(){const[state,setState]=useState(null),[busy,setBusy]=useState(new Set()),[error,setError]=useState('');
async function api(route,body){const response=await fetch(route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw new Error(value.error);return value}
useEffect(()=>{let alive=true;const poll=async()=>{const value=await api('/api/task/limits');if(alive)setState(value)};void poll();const timer=setInterval(()=>{void poll()},100);return()=>{alive=false;clearInterval(timer)}},[]);
async function run(name,action){setBusy(new Set([name]));setError('');try{await action();setState(await api('/api/task/limits'))}catch(error){setError(error.message)}finally{setBusy(new Set())}}
return <div className="app-frame" style={{padding:28,width:390,overflow:'auto',height:'100vh'}}><TaskBudgetPanel state={state} api={api} run={run} busy={busy} operationActive={state?.operationActive===true}/>{error&&<p role="alert">{error}</p>}</div>}
createRoot(document.getElementById('root')).render(<Harness/>);` }, outfile: path.join(output, 'app.js'), bundle: true, format: 'esm', platform: 'browser', target: ['chrome120'], jsx: 'automatic',
    alias: { '@dsh/primitives': path.join(upstream, 'ui-primitives', 'src', 'index.ts'), '@dsh/theme': path.join(upstream, 'ui-theme', 'src', 'styles'), ...Object.fromEntries(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => [name, local.resolve(name)])) },
    nodePaths: [path.join(root, 'node_modules')], tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } }, loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file' }, assetNames: 'assets/[name]-[hash]', define: { 'process.env.NODE_ENV': '"production"' }, minify: true,
  });
  const posts = [], errors = []; let policy = { ...DEFAULT_TASK_POLICY }, operationActive = false;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/task/limits') {
      let body = ''; for await (const chunk of request) body += chunk;
      if (request.method === 'POST') { posts.push({ route: url.pathname, body: JSON.parse(body) }); policy = JSON.parse(body); }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ protocol: 'task-limits-v1', policy, hardLimits: TASK_LIMIT_BOUNDS, operationActive })); return;
    }
    try {
      if (url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html lang="zh-CN"><link rel="stylesheet" href="/app.css"><body data-ds-dark-theme><div id="root"></div><script type="module" src="/app.js"></script></body></html>'); return; }
      const file = path.resolve(output, url.pathname.slice(1)); if (!file.startsWith(output + path.sep)) throw new Error('测试路径越界');
      const contents = await fs.readFile(file); response.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }); response.end(contents);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const profile = await fs.mkdtemp(path.join(tmpdir(), 'douyin-task-budget-ui-'));
  const browser = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport: { width: 440, height: 760 } });
  t.after(async () => { await browser.close(); assert.equal(path.dirname(path.resolve(profile)), path.resolve(tmpdir())); await fs.rm(profile, { recursive: true, force: true }); });
  const page = browser.pages()[0]; page.on('pageerror', error => errors.push(error.message)); await page.goto(`http://127.0.0.1:${server.address().port}`);
  const steps = page.getByRole('spinbutton', { name: '手动任务步数上限', exact: true }), calls = page.getByRole('spinbutton', { name: '手动任务工具调用上限', exact: true }), seconds = page.getByRole('spinbutton', { name: '手动任务超时秒数', exact: true });
  const save = page.getByRole('button', { name: '保存手动任务预算', exact: true });
  await page.waitForFunction(() => document.querySelector('[aria-label="手动任务步数上限"]')?.disabled === false);
  assert.equal(await steps.inputValue(), '20'); assert.equal(await calls.inputValue(), '20'); assert.equal(await seconds.inputValue(), '180'); assert.equal(posts.length, 0);
  await steps.fill('40'); await calls.fill('45'); await seconds.fill('600'); await page.waitForTimeout(250);
  assert.equal(await steps.inputValue(), '40'); assert.equal(await seconds.inputValue(), '600');
  operationActive = true; await page.waitForFunction(() => document.querySelector('[aria-label="手动任务步数上限"]').disabled === true);
  assert.equal(await save.isDisabled(), true); assert.equal(posts.length, 0); assert.equal(await calls.inputValue(), '45');
  operationActive = false; await page.waitForFunction(() => document.querySelector('[aria-label="手动任务步数上限"]').disabled === false);
  await seconds.fill('9'); await save.click(); assert.equal(await seconds.evaluate(input => input.validity.rangeUnderflow), true); assert.equal(posts.length, 0);
  await seconds.fill('600'); await save.click(); await page.getByText('手动任务预算已保存，将用于之后启动的任务。', { exact: true }).waitFor();
  assert.deepEqual(posts, [{ route: '/api/task/limits', body: { maxSteps: 40, maxToolCalls: 45, timeoutSeconds: 600 } }]);
  await page.getByText('这三个上限只控制手动模型任务。保存不会改变视频允许时段或本轮截止，也不会重置自主观看预算。', { exact: true }).waitFor();
  policy = { maxSteps: 25, maxToolCalls: 30, timeoutSeconds: 240 };
  await page.waitForFunction(() => document.querySelector('[aria-label="手动任务超时秒数"]').value === '240');
  assert.equal(await steps.inputValue(), '25'); assert.equal(await calls.inputValue(), '30');
  await page.screenshot({ path: path.join(output, 'task-budget.png') }); assert.deepEqual(errors, []);
});
