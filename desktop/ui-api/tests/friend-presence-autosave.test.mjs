import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../playwright-runtime.mjs';

test('软件好友面板保留屏外许可和保存保护，后台恢复不要求人工清待答', { timeout: 35_000 }, async t => {
  const ui = fileURLToPath(new URL('../', import.meta.url)), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-friend-ui-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-friend-ui-/); await fs.rm(directory, { recursive: true, force: true }); });
  const local = createRequire(new URL('../package.json', import.meta.url)), desktop = createRequire(new URL('../../package.json', import.meta.url));
  const source = await fs.readFile(path.join(ui, 'src/main.jsx'), 'utf8');
  const helpers = source.slice(source.indexOf('function Field('), source.indexOf('function ApiSettings('));
  const panel = source.slice(source.indexOf('function FriendInteractionPanel('), source.indexOf('function ForwardPanel('));
  const videoPanel = source.slice(source.indexOf('function VideoPanel('), source.indexOf('function AudioPanel('));
  assert.ok(helpers.includes('function FriendPresence(') && panel.includes('shownContacts'));
  const primitiveFile = path.join(directory, 'primitives.jsx');
  await fs.writeFile(primitiveFile, `import React from'react';export const Button=({children,size,variant,...props})=><button type="button" {...props}>{children}</button>;export const Input=props=><input {...props}/>;export const Switch=({label,checked,onChange,...props})=><button type="button" role="switch" aria-label={label} aria-checked={checked} onClick={()=>onChange(!checked)} {...props}>{label}</button>;export const Tag=({children})=><span>{children}</span>;export const JsonBlock=()=>null;`);
  const entry = `import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';import{Button,Input,Switch,Tag,JsonBlock}from'@dsh/primitives';
import{useAutoSave,AutoSaveStatus}from${JSON.stringify(path.join(ui, 'src/use-auto-save.jsx'))};import{ShareReceipts}from${JSON.stringify(path.join(ui, 'src/autonomous-share.jsx'))};import{canAuthorizeConversation,hasStableConversationIdentity,matchesAuthorizedContact}from${JSON.stringify(path.resolve(ui, '../../contact-authorization.mjs'))};import{watchIsActive}from${JSON.stringify(path.join(ui, 'src/api.mjs'))};
const truncated=value=>value,contactName=item=>item?.name||item?.displayName||'联系人';${helpers}\n${panel}\n${videoPanel}
const api=async(route,body)=>{const response=await fetch(route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();if(!response.ok)throw Object.assign(new Error(data.error),{status:response.status});return data;};
function Harness(){const[state,setState]=useState(null),[busy,setBusy]=useState(new Set()),[opened,setOpened]=useState(false),[error,setError]=useState('');useEffect(()=>{let alive=true;const poll=()=>void api('/fixture').then(value=>{if(alive)setState(value)});poll();const timer=setInterval(poll,100);return()=>{alive=false;clearInterval(timer)}},[]);async function run(key,action){setBusy(old=>new Set([...old,key]));try{await action()}catch(error){setError(error.message)}finally{setBusy(old=>{const copy=new Set(old);copy.delete(key);return copy})}}return state&&<><FriendPresence presence={state.interactions.presence} connected={true} onOpen={()=>setOpened(true)}/>{opened&&<p>合成已打开好友互动</p>}{error&&<p role="alert">{error}</p>}<VideoPanel state={state.video} schedule={state.schedule} watch={state.watch} configured={state.configured} connected={true} busy={busy} api={api} run={run}/><FriendInteractionPanel state={state.chat} interactions={state.interactions} share={state.share} connected={true} configured={true} busy={busy} api={api} run={run}/></>};createRoot(document.getElementById('root')).render(<Harness/>);`;
  await desktop('esbuild').build({ stdin: { contents: entry, loader: 'jsx', resolveDir: directory }, outfile: path.join(directory, 'app.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', alias: { '@dsh/primitives': primitiveFile, ...Object.fromEntries(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => [name, local.resolve(name)])) }, define: { 'process.env.NODE_ENV': '"production"' } });
  const person = { id: 'conv:' + 'a'.repeat(64), name: '合成已许可个人', followed: null, isGroup: false, identityVerified: true, identityBinding: 'binding:' + 'a'.repeat(64), identityVersion: 2, identityKind: 'rendered-user', identityHash: 'a'.repeat(64), relationshipStatus: 'unavailable', authorizationKind: 'existing-conversation', verifiedAt: '2026-10-24T00:00:00.000Z' };
  const group = { id: 'conv:' + 'b'.repeat(64), name: '合成待选群', followed: null, isGroup: true, identityVerified: true, identityBinding: 'binding:' + 'b'.repeat(64), identityVersion: 2, identityKind: 'rendered-group', identityHash: 'b'.repeat(64), relationshipStatus: 'unavailable', verifiedAt: '2026-10-24T00:00:00.000Z' };
  const unknown = { id: 'conv:' + 'c'.repeat(64), name: '合成未知类型', isGroup: null };
  const weak = { id: 'conv:' + 'e'.repeat(64), name: '合成缺少稳定身份', isGroup: false, followed: true, identityVerified: true, identityBinding: 'binding:' + 'e'.repeat(64) };
  let listedContacts = [group, unknown, weak];
  const value = { chat: { running: true, policy: { allowlist: [person], groupMentionNames: ['大肥鱼'] }, contacts: [{ id: person.id, status: 'paused', reason: '合成需要核对' }] }, interactions: { policy: { enabled: true }, friend: {}, presence: { status: 'attention', online: false, label: '回复未就绪', reason: '合成许可联系人需要核对' } }, share: { daily: { attempts: 0 }, needsReview: [] } };
  value.configured = true; value.video = { policy: { windows: ['00:00-24:00'], dailyMinutes: 10, dailyRequests: 30 }, daily: { usedSeconds: 12, requests: 2 } }; value.schedule = { policy: { enabled: false } }; value.watch = { running: false, status: 'stopped' };
  const calls = [], errors = []; let saveRelease, resolveRelease, allowStart = true;
  const server = http.createServer(async (request, response) => {
    const route = new URL(request.url, 'http://localhost').pathname, reply = data => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (route === '/') { response.writeHead(200, { 'content-type': 'text/html' }); return response.end('<!doctype html><html><div id="root"></div><script type="module" src="/app.js"></script></html>'); }
    if (route === '/app.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); return response.end(await fs.readFile(path.join(directory, 'app.js'))); }
    if (route === '/fixture') return reply(value);
    let raw = ''; for await (const chunk of request) raw += chunk; const input = raw ? JSON.parse(raw) : undefined; calls.push({ route, input });
    if (route === '/api/chat/contacts') return reply({ contacts: listedContacts, listDiscovery: { source: 'current-conversation-list', scannedToEnd: false, reason: '合成预算已到。' } });
    if (route === '/api/watch/schedule') { value.schedule.policy.enabled = input.enabled; value.watch.running = input.enabled && allowStart; value.watch.status = value.watch.running ? 'running' : 'stopped'; return reply(value.schedule); }
    if (route === '/api/chat/configure') {
      value.chat.policy.allowlist = input.recipientIds.map(id => id === person.id ? person : { ...group, authorizationKind: 'existing-group' }); value.chat.policy.groupMentionNames = input.groupMentionNames;
      if (!saveRelease) { saveRelease = () => reply(value.chat); return; } return reply(value.chat);
    }
    if (route === '/api/chat/resolve') { resolveRelease = () => { value.chat.contacts[0].status = 'ready'; value.interactions.presence = { status: 'watching', online: true, label: '在线 · 看视频中', reason: '合成后端确认全部许可已就绪' }; reply(value.chat); }; return; }
    response.writeHead(404); response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message)); await page.goto(`http://127.0.0.1:${server.address().port}`);
  const until = async check => { const end = Date.now() + 8000; while (!check()) { if (Date.now() > end) throw new Error('合成面板等待超时。'); await new Promise(resolve => setTimeout(resolve, 15)); } };
  const presence = page.getByLabel('好友互动状态', { exact: true }); await presence.filter({ hasText: '回复未就绪' }).waitFor();
  const start = page.getByRole('button', { name: '开始自主观看', exact: true }), pause = page.getByRole('button', { name: '暂停观看', exact: true }), beforeVideo = structuredClone(value.video);
  value.configured = false; await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '开始自主观看' && button.disabled)); value.configured = true;
  await start.click(); await until(() => value.watch.running); await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '开始自主观看' && button.disabled));
  await pause.click(); await until(() => value.schedule.policy.enabled === false); await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '开始自主观看' && !button.disabled)); assert.deepEqual(value.video, beforeVideo, '开始/暂停不改每日政策或已用额度');
  allowStart = false; value.schedule.policy.enabled = true; await page.waitForFunction(() => document.querySelector('[aria-label="允许自动观看"]').getAttribute('aria-checked') === 'true');
  assert.equal(await start.isEnabled(), true, '已允许但尚未运行时可请求立即检查'); await start.click(); await until(() => calls.filter(item => item.route === '/api/watch/schedule').length === 3); assert.equal(value.watch.running, false);
  await pause.click(); await until(() => value.schedule.policy.enabled === false); assert.deepEqual(value.video, beforeVideo);
  await page.getByRole('button', { name: '读取联系人与群聊', exact: true }).click();
  const selectedPerson = page.getByRole('checkbox', { name: '许可联系人 合成已许可个人', exact: true }); assert.equal(await selectedPerson.isChecked(), true); assert.equal(await selectedPerson.locator('..').locator('small').count(), 0, '名单只显示勾选项和昵称');
  const weakChoice = page.getByRole('checkbox', { name: '许可联系人 合成缺少稳定身份', exact: true }); assert.equal(await weakChoice.isDisabled(), false); assert.equal(await weakChoice.isChecked(), false); assert.equal(await weakChoice.locator('..').locator('small').count(), 0, '名单只显示勾选项和昵称');
  await page.getByText('当前列表尚未完整读取。', { exact: false }).waitFor(); assert.equal(calls.some(item => item.route === '/api/chat/configure'), false);
  const groupChoice = page.getByRole('checkbox', { name: '许可联系人 合成待选群', exact: true });
  if (!await page.getByRole('checkbox', { name: '授权已核对的现有会话', exact: true }).isChecked()) await page.getByRole('checkbox', { name: '授权已核对的现有会话', exact: true }).check();
  assert.equal(calls.some(item => item.route === '/api/chat/configure'), false);
  await groupChoice.check(); await until(() => saveRelease);
  assert.equal(await page.getByRole('button', { name: '已人工核对，解除暂停', exact: true }).count(), 0); assert.equal(calls.some(item => item.route === '/api/chat/resolve'), false);
  const names = page.getByRole('textbox', { name: '群聊响应昵称', exact: true }); await names.fill('大肥'); saveRelease(); await page.waitForTimeout(150);
  assert.equal(calls.filter(item => item.route === '/api/chat/configure').length, 1); assert.equal(await names.inputValue(), '大肥');
  await names.fill('大肥鱼,合成完整昵称'); await names.press('Tab'); await until(() => calls.filter(item => item.route === '/api/chat/configure').length === 2);
  assert.deepEqual(calls.filter(item => item.route === '/api/chat/configure').at(-1).input.recipientIds, [person.id, group.id]);
  assert.equal(await groupChoice.locator('..').locator('small').count(), 0, '名单只显示勾选项和昵称');
  const renamed = { ...person, name: '合成已许可个人新昵称' }, other = { ...person, id: 'conv:' + 'd'.repeat(64), identityHash: 'd'.repeat(64), identityBinding: 'binding:' + 'd'.repeat(64), name: renamed.name };
  listedContacts = [renamed, group, unknown, weak, other]; const savesBeforeRename = calls.filter(item => item.route === '/api/chat/configure').length;
  await page.getByRole('button', { name: '读取联系人与群聊', exact: true }).click();
  const sameName = page.getByRole('checkbox', { name: `许可联系人 ${renamed.name}`, exact: true }); await sameName.nth(1).waitFor(); assert.equal(await sameName.nth(0).isChecked(), true); assert.equal(await sameName.nth(1).isChecked(), false); assert.equal(await sameName.nth(0).locator('..').locator('small').count(), 0, '名单只显示勾选项和昵称'); assert.equal(calls.filter(item => item.route === '/api/chat/configure').length, savesBeforeRename, '改昵称和读取同名账号不自动改许可名单');
  value.chat.contacts[0].status = 'ready'; value.interactions.presence = { status: 'watching', online: true, label: '在线 · 看视频中', reason: '合成后端确认全部许可已就绪' };
  await presence.filter({ hasText: '在线 · 看视频中' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '查看遗留待处理消息', exact: true }).count(), 0);
  assert.equal(calls.filter(item => item.route === '/api/chat/resolve').length, 0); assert.deepEqual(errors, []);
});
