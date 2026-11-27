import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../playwright-runtime.mjs';

test('独立面板自动保存保护草稿，用量在整轮未结束时更新且刷新不并发', { timeout: 60_000 }, async t => {
  const ui = fileURLToPath(new URL('../', import.meta.url)), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-auto-panels-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-auto-panels-/); await fs.rm(directory, { recursive: true, force: true }); });
  const desktopRequire = createRequire(new URL('../../package.json', import.meta.url)), local = createRequire(new URL('../package.json', import.meta.url));
  const primitives = path.join(directory, 'primitives.jsx');
  await fs.writeFile(primitives, `import React from 'react';
export const Button=({children,size,variant,...props})=><button type="button" {...props}>{children}</button>;
export const Input=props=><input {...props}/>;
export const Switch=({label,checked,onChange,...props})=><button type="button" role="switch" aria-label={label} aria-checked={checked} onClick={()=>onChange(!checked)} {...props}>{label}</button>;
export const Tag=({children})=><span>{children}</span>; export const MarkdownText=({text})=><div>{text}</div>;`);
  const entry = `import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';
import{ViewingModePanel,CommentsPanel}from${JSON.stringify(path.join(ui, 'src/watch-settings.jsx'))};
import{HealthDashboard,TopicPanel}from${JSON.stringify(path.join(ui, 'src/health-dashboard.jsx'))};
import{PersonaPanel}from${JSON.stringify(path.join(ui, 'src/watch-persona.jsx'))};
import{TaskBudgetPanel}from${JSON.stringify(path.join(ui, 'src/task-budget.jsx'))};
const api=async(route,body)=>{const response=await fetch(route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error),{status:response.status});return value;};
function Harness(){const[state,setState]=useState(null),[connected,setConnected]=useState(true),[health,setHealth]=useState(true);useEffect(()=>{let alive=true;const refresh=()=>void fetch('/fixture').then(r=>r.json()).then(value=>{if(alive)setState(value)});refresh();const timer=setInterval(refresh,150);window.__connected=setConnected;window.__health=setHealth;return()=>{alive=false;clearInterval(timer)}},[]);if(!state)return null;const props={connected,api,run:(_key,action)=>action(),busy:new Set()};return <><h1 tabIndex="0">合成独立面板</h1><ViewingModePanel {...props} state={state.mode}/><CommentsPanel {...props} state={state.comments}/><TopicPanel {...props} state={state.topic} active={false}/><TaskBudgetPanel {...props} state={state.limits} operationActive={false}/><PersonaPanel {...props} snapshot={state.persona} onSnapshot={persona=>setState(old=>({...old,persona}))} watchState={{status:'stopped'}} watchReady={connected}/>{health&&<HealthDashboard {...props}/>}</>};createRoot(document.getElementById('root')).render(<Harness/>);`;
  await desktopRequire('esbuild').build({ stdin: { contents: entry, resolveDir: directory, loader: 'jsx' }, outfile: path.join(directory, 'app.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', alias: { '@dsh/primitives': primitives, ...Object.fromEntries(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => [name, local.resolve(name)])) }, define: { 'process.env.NODE_ENV': '"production"' } });
  const calls = [], errors = [], held = { comments: null, persona: null, usage: null }; let holdComment = false, holdPersona = false, holdUsage = false, rejectPersona = false, activeUsage = 0, maxUsage = 0, usageReads = 0, personaVersion = 1;
  const value = {
    mode: { protocol: 'watch-mode-v1', silent: false },
    comments: { protocol: 'autonomous-comments-v1', enabled: false, policy: { enabled: false, dailyLimit: 3, perSessionLimit: 1 }, daily: { attempts: 0 }, needsReview: [] },
    topic: { mode: 'recommend', topics: [], exclude: [] },
    limits: { policy: { maxSteps: 20, maxToolCalls: 20, timeoutSeconds: 180 }, hardLimits: { maxSteps: { minimum: 1, maximum: 10000 }, maxToolCalls: { minimum: 1, maximum: 10000 }, timeoutSeconds: { minimum: 1, maximum: 604800 } } },
    persona: { revision: 'r1', manualText: '合成人格原文', personaText: '', interests: [], recentObservations: [] },
  };
  let tokens = 10;
  const usage = () => ({ checkedAt: new Date().toISOString(), date: '2026-10-24', today: { requests: 2, totalTokens: tokens }, total: { totalTokens: tokens }, groups: [], days: [], inProgress: { total: 1 }, period: '合成本轮仍在继续', note: '合成模型每次响应完成即记账。' });
  const server = http.createServer(async (request, response) => {
    const route = new URL(request.url, 'http://127.0.0.1').pathname;
    const reply = (data, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
    try {
      if (route === '/') { response.writeHead(200, { 'content-type': 'text/html' }); return response.end('<!doctype html><html><div id="root"></div><script type="module" src="/app.js"></script></html>'); }
      if (route === '/app.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); return response.end(await fs.readFile(path.join(directory, 'app.js'))); }
      if (route === '/fixture') return reply(value);
      if (route === '/api/usage') {
        usageReads += 1; activeUsage += 1; maxUsage = Math.max(maxUsage, activeUsage); const snapshot = usage();
        response.once('finish', () => { activeUsage -= 1; });
        if (holdUsage) { holdUsage = false; held.usage = () => reply(snapshot); return; }
        return reply(snapshot);
      }
      let raw = ''; for await (const chunk of request) raw += chunk;
      const input = raw ? JSON.parse(raw) : undefined; calls.push({ route, input });
      if (route === '/api/mode/configure') { value.mode = { ...value.mode, ...input }; return reply(value.mode); }
      if (route === '/api/comments/configure') { value.comments.policy = { ...value.comments.policy, ...input }; value.comments.enabled = value.comments.policy.enabled; const result = structuredClone(value.comments); if (holdComment) { holdComment = false; held.comments = () => reply(result); return; } return reply(result); }
      if (route === '/api/watch/options') { value.topic = input; return reply({ policy: input }); }
      if (route === '/api/task/limits') { value.limits.policy = input; return reply(value.limits); }
      if (route === '/api/persona') return reply(value.persona);
      if (route === '/api/persona/card') {
        if (rejectPersona) { rejectPersona = false; value.persona = { ...value.persona, revision: `r${++personaVersion}`, manualText: '合成外部更新' }; return reply({ error: '合成人格版本冲突' }, 409); }
        if (input.expectedRevision !== value.persona.revision) return reply({ error: '合成人格版本冲突' }, 409);
        value.persona = { ...value.persona, revision: `r${++personaVersion}`, manualText: input.text }; const result = structuredClone(value.persona);
        if (holdPersona) { holdPersona = false; held.persona = () => reply(result); return; } return reply(result);
      }
      return reply({ error: '合成接口不存在' }, 404);
    } catch (error) { return reply({ error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading', { name: '合成独立面板' }).waitFor();
  const until = async check => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('合成状态等待超时。'); await new Promise(resolve => setTimeout(resolve, 15)); } };
  assert.equal(await page.getByRole('button', { name: /^保存/ }).count(), 0);
  await page.getByRole('switch', { name: '静默观看', exact: true }).click(); await until(() => value.mode.silent);
  await page.getByRole('switch', { name: '允许自主发布评论' }).click(); await until(() => value.comments.enabled);
  const daily = page.getByRole('spinbutton', { name: '评论每日尝试上限' });
  holdComment = true; await daily.fill('5'); await until(() => held.comments);
  await daily.fill('9'); await page.waitForTimeout(700); assert.equal(await daily.inputValue(), '9'); held.comments(); held.comments = null;
  await until(() => value.comments.policy.dailyLimit === 9); await page.waitForTimeout(250); assert.equal(await daily.inputValue(), '9');
  await daily.fill(''); await page.getByRole('switch', { name: '允许自主发布评论' }).click(); await until(() => !value.comments.enabled); assert.equal(await daily.inputValue(), '', '关闭评论不抹掉未完成数字草稿');
  await page.getByRole('combobox', { name: '观看方式' }).selectOption('topic'); await page.waitForTimeout(700); assert.equal(calls.some(item => item.route === '/api/watch/options'), false);
  await page.getByRole('textbox', { name: '想看的主题' }).fill('猫咪\n天文'); await until(() => value.topic.mode === 'topic'); assert.deepEqual(value.topic.topics, ['猫咪', '天文']);
  const budget = page.getByRole('spinbutton', { name: '手动任务步数上限' }); await budget.fill(''); await page.waitForTimeout(700); assert.equal(calls.some(item => item.route === '/api/task/limits'), false);
  await budget.fill('123'); await until(() => value.limits.policy.maxSteps === 123);
  await page.locator('.effective-persona > summary').click();
  await page.getByRole('button', { name: '编辑人格', exact: true }).click(); const card = page.getByRole('textbox', { name: '人格正文', exact: true });
  await card.fill('合成草稿一'); await page.waitForTimeout(700); assert.equal(calls.some(item => item.route === '/api/persona/card'), false);
  rejectPersona = true; await card.press('Tab'); await page.getByText('人格文件已有新版本，未保存的草稿已保留。', { exact: true }).waitFor(); assert.equal(await card.inputValue(), '合成草稿一');
  await page.getByRole('button', { name: '保留草稿，采用最新版本号' }).click(); await page.getByText('人格正文已自动保存，两个入口会读取同一份文件。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '编辑人格', exact: true }).click(); holdPersona = true;
  await card.fill('合成草稿二'); await card.press('Tab'); await until(() => held.persona);
  await card.fill('合成更新草稿三'); held.persona(); held.persona = null; await page.waitForTimeout(350);
  assert.equal(await card.inputValue(), '合成更新草稿三'); assert.equal(calls.filter(item => item.route === '/api/persona/card').length, 3);
  await card.press('Tab'); await until(() => value.persona.manualText === '合成更新草稿三');
  const tokenCard = page.locator('.usage-grid .interest-card').filter({ hasText: '已报告 Token' }).getByRole('heading');
  tokens = 123; await tokenCard.filter({ hasText: '123' }).waitFor(); await page.getByText('1个请求中，Token待平台返回。', { exact: false }).waitFor();
  holdUsage = true; const reads = usageReads; await page.getByRole('button', { name: '刷新用量', exact: true }).click(); await until(() => held.usage);
  tokens = 456; await page.getByRole('button', { name: '刷新用量', exact: true }).click(); assert.equal(usageReads, reads + 1); held.usage(); held.usage = null;
  await tokenCard.filter({ hasText: '456' }).waitFor(); assert.equal(maxUsage, 1, '手动与定时刷新不得并发');
  const beforeUnmount = usageReads; await page.evaluate(() => window.__health(false)); await page.waitForTimeout(1700); assert.equal(usageReads, beforeUnmount, '卸载后停止刷新');
  assert.deepEqual(errors, []);
});
