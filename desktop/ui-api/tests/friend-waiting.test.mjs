import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../playwright-runtime.mjs';

test('软件好友页显示回复等待原因和准备入口，无收到收据时不输出孤立0', async t => {
  const ui = fileURLToPath(new URL('../', import.meta.url)), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-friend-waiting-'));
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const local = createRequire(new URL('../package.json', import.meta.url)), desktop = createRequire(new URL('../../package.json', import.meta.url));
  const source = await fs.readFile(path.join(ui, 'src/main.jsx'), 'utf8');
  const helpers = source.slice(source.indexOf('function Field('), source.indexOf('function ApiSettings('));
  const panel = source.slice(source.indexOf('function FriendInteractionPanel('), source.indexOf('function ForwardPanel('));
  const videoPanel = source.slice(source.indexOf('function VideoPanel('), source.indexOf('function AudioPanel('));
  const primitive = path.join(directory, 'primitives.jsx');
  await fs.writeFile(primitive, `import React from'react';export const Button=({children,...props})=><button type="button" {...props}>{children}</button>;export const Input=props=><input {...props}/>;export const Switch=({label,checked,onChange,...props})=><button type="button" role="switch" aria-label={label} aria-checked={checked} onClick={()=>onChange(!checked)} {...props}>{label}</button>;export const Tag=({children})=><span>{children}</span>;export const JsonBlock=()=>null;`);
  const entry = `import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';import{Button,Input,Switch,Tag,JsonBlock}from'@dsh/primitives';import{useAutoSave,AutoSaveStatus}from${JSON.stringify(path.join(ui, 'src/use-auto-save.jsx'))};import{ShareReceipts}from${JSON.stringify(path.join(ui, 'src/autonomous-share.jsx'))};import{canAuthorizeConversation,hasStableConversationIdentity,matchesAuthorizedContact}from${JSON.stringify(path.resolve(ui, '../../contact-authorization.mjs'))};import{watchIsActive}from${JSON.stringify(path.join(ui, 'src/api.mjs'))};
  const truncated=v=>v,contactName=c=>c?.name||c?.displayName||'联系人';${helpers}${panel}${videoPanel}
  const api=async(route,body)=>{const response=await fetch(route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw new Error(data.error);return data;};
  const person={id:'conv:'+'a'.repeat(64),name:'合成许可个人',isGroup:false,identityVersion:2,identityKind:'rendered-user',identityHash:'a'.repeat(64),identityVerified:true,identityBinding:'binding:'+'a'.repeat(64),verifiedAt:'2026-10-24T00:00:00.000Z',authorizationKind:'existing-conversation'};
  const value={chat:{running:false,policy:{allowlist:[person],groupMentionNames:['大肥鱼']},contacts:[],daily:{requests:0}},interactions:{policy:{enabled:true},friend:{waitReason:'专用消息标签页已离开抖音；请点准备回复通道。',lastErrorCode:'CHAT_PAGE_LEFT_DOUYIN',nextRetryAt:'2026-10-27T23:10:00.000Z',canPrepare:true},presence:{status:'attention',online:false,label:'等待准备回复通道',reason:'专用消息标签页已离开抖音；请点准备回复通道。'}},share:{enabled:true,paused:true,recoveryRequired:false,needsReview:[],recipients:[],unavailableRecipients:[{id:'conv:'+'c'.repeat(64),name:'合成人工群',reason:'缺少稳定会话身份，不能发送原生作品卡片；仍保留在许可名单，不影响观看或回复。'}],recent:[]}};
  const calls=[];function Harness(){const[busy,setBusy]=useState(new Set());async function run(key,action){setBusy(old=>new Set([...old,key]));try{await action()}finally{setBusy(old=>{const n=new Set(old);n.delete(key);return n})}}return <FriendInteractionPanel state={value.chat} interactions={value.interactions} share={value.share} api={api} run={run} busy={busy} configured={true} connected={true}/>;}
  window.__calls=calls;const original=window.fetch;window.fetch=async(route,...args)=>{calls.push({route:String(route),body:args[0]?.body});return original(route,...args)};createRoot(document.getElementById('root')).render(<Harness/>);`;
  await desktop('esbuild').build({ stdin: { contents: entry, loader: 'jsx', resolveDir: directory }, outfile: path.join(directory, 'app.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', alias: { '@dsh/primitives': primitive, ...Object.fromEntries(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => [name, local.resolve(name)])) }, define: { 'process.env.NODE_ENV': '"production"' } });
  const server = http.createServer(async (request, response) => {
    if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html' }); return response.end('<div id="root"></div><script type="module" src="/app.js"></script>'); }
    if (request.url === '/app.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); return response.end(await fs.readFile(path.join(directory, 'app.js'))); }
    if (request.url === '/api/chat/prepare') { let raw=''; for await (const chunk of request) raw += chunk; response.writeHead(200, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ prepared: true, count: 1, body: raw })); }
    response.writeHead(404, { 'content-type': 'application/json' }); response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message)); await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForTimeout(500);
  if (!(await page.getByText('等待准备：专用消息标签页已离开抖音；请点准备回复通道。', { exact: false }).count())) { t.diagnostic(`errors=${errors.join('|')} body=${(await page.locator('body').innerText()).slice(0,1000)}`); }
  await page.getByText('等待准备：专用消息标签页已离开抖音；请点准备回复通道。', { exact: false }).waitFor();
  await page.getByText(/暂不能自主分享/).waitFor();
  assert.equal(await page.getByText(/有 0 条分享收据/).count(), 0);
  const prepare = page.getByRole('button', { name: '准备回复通道/重新连接并重试', exact: true }); await prepare.waitFor();
  await prepare.click(); await page.waitForTimeout(100);
  const calls = await page.evaluate(() => window.__calls || []); assert.ok(calls.some(item => item.route === '/api/chat/prepare'));
});
