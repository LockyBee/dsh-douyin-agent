import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { VideoLimits, allowedWindow, validateVideoPolicy } from '../video-limits.mjs';
import { createApiServer } from '../app.mjs';

function fixture(t, timestamp = '2026-10-14T02:00:00Z') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-video-time-')); let clock = Date.parse(timestamp);
  const limits = new VideoLimits({ stateDir: directory, now: () => clock });
  t.after(() => { const target = path.resolve(directory); if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界。'); fs.rmSync(target, { recursive: true, force: true }); });
  return { limits, directory, advance: (ms) => { clock += ms; }, setTime: (value) => { clock = Date.parse(value); }, now: () => clock };
}
const policy = (windows = ['00:00-24:00'], sessionMinutes = 10) => ({ windows, sessionMinutes });

test('默认 10 分钟且未开始时拒绝刷；状态、暂停和私信不受限，模型调用不能重置时钟', (t) => {
  const f = fixture(t); assert.equal(f.limits.state().policy.sessionMinutes, 10); assert.equal(f.limits.beforeAction('api', 'douyin_open').allowed, false);
  assert.equal(f.limits.beforeAction('dsh', 'douyin_status').allowed, true); assert.equal(f.limits.beforeAction('api', 'douyin_pause').allowed, true); assert.equal(f.limits.beforeAction('dsh', 'douyin_chat_status').allowed, true);
  assert.throws(() => f.limits.markSession('api'), /显式/); assert.throws(() => f.limits.savePolicy(policy()), /明确/);
});
test('API、DSH 和重建实例共用同一时钟，open/next 不会给一轮自动加时', (t) => {
  const f = fixture(t); const initial = f.limits.markSession('api', { explicit: true }); const startAt = initial.session.startAt;
  f.advance(120_000); assert.equal(f.limits.beforeAction('dsh', 'douyin_next').allowed, true); assert.equal(f.limits.beforeAction('api', 'douyin_open').state.session.startAt, startAt);
  const second = new VideoLimits({ stateDir: f.directory, now: f.now }); assert.equal(second.state().session.expiresAt, initial.session.expiresAt); assert.equal(second.state().remainingSeconds, 480);
  f.advance(480_000); assert.equal(second.beforeAction('dsh', 'douyin_play').allowed, false); assert.equal(f.limits.state().session.status, 'expired'); assert.equal(f.limits.state().remainingSeconds, 0);
  const next = second.markSession('dsh', { explicit: true }); assert.notEqual(next.session.id, initial.session.id); assert.equal(next.session.startAt, f.now());
});
test('多个每日窗口按上海时区计算，开始包含而结束不包含', () => {
  const selected = validateVideoPolicy(policy(['08:00-09:00','20:00-21:00']));
  assert.ok(allowedWindow(selected, Date.parse('2026-10-14T00:00:00Z'))); assert.ok(allowedWindow(selected, Date.parse('2026-10-14T12:30:00Z')));
  assert.equal(allowedWindow(selected, Date.parse('2026-10-14T01:00:00Z')), null); assert.equal(allowedWindow(selected, Date.parse('2026-10-14T11:59:59Z')), null);
});
test('跨午夜窗口连续有效，会话在窗口结束时截断，不在午夜错误切断全天窗口', (t) => {
  const f = fixture(t, '2026-10-14T15:50:00Z'); f.limits.savePolicy(policy(['23:00-01:00'], 120), { explicit: true });
  const begun = f.limits.markSession('api', { explicit: true }); assert.equal(begun.session.expiresAt, Date.parse('2026-10-14T17:00:00Z'));
  f.setTime('2026-10-14T16:30:00Z'); assert.equal(f.limits.state().allowed, true); assert.equal(f.limits.state().remainingSeconds, 1800);
  f.setTime('2026-10-14T17:00:00Z'); assert.equal(f.limits.state().allowed, false);
  const g = fixture(t, '2026-10-14T15:50:00Z'); g.limits.savePolicy(policy(['00:00-24:00'], 120), { explicit: true }); assert.equal(g.limits.markSession('api', { explicit: true }).session.expiresAt, Date.parse('2026-10-14T17:50:00Z'));
});
test('保存更长规则不延长已开始的轮，缩短或关闭当前时间窗会立即限时', (t) => {
  const f = fixture(t); const initial = f.limits.markSession('api', { explicit: true }); f.advance(120_000);
  f.limits.savePolicy(policy(['00:00-24:00'], 20), { explicit: true }); assert.equal(f.limits.state().session.expiresAt, initial.session.expiresAt);
  f.limits.savePolicy(policy(['00:00-24:00'], 5), { explicit: true }); assert.equal(f.limits.state().remainingSeconds, 180);
  const state = f.limits.savePolicy(policy(['20:00-21:00'], 10), { explicit: true }); assert.equal(state.allowed, false); assert.equal(state.session.status, 'expired'); assert.throws(() => f.limits.markSession('api', { explicit: true }), /允许时间段/);
});
test('空窗口、无穷时长、零上限、非法小时和关闭全部上限均拒绝，原设置不改', (t) => {
  const f = fixture(t); const original = fs.readFileSync(f.limits.policyFile, 'utf8');
  for (const input of [policy([],10), policy(['00:00-24:00'],Infinity), policy(['00:00-24:00'],NaN), policy(['00:00-24:00'],0), policy(['00:00-24:00'],1000001), policy(['24:00-01:00']), policy(['23:00-24:10']), policy(['12:00-12:00']), policy(['not-a-window']), { ...policy(), disabled:true }, { ...policy(), timeZone:'UTC' }]) assert.throws(() => f.limits.savePolicy(input, { explicit:true }));
  assert.equal(fs.readFileSync(f.limits.policyFile,'utf8'),original);
});
test('到点定时调用 API、DSH 的暂停回调并发出中止信号，之后禁止继续切换', async (t) => {
  const f = fixture(t); f.limits.savePolicy(policy(['00:00-24:00'],1),{explicit:true}); f.limits.markSession('api',{explicit:true}); const paused=[]; let denied=0;
  const cancel=f.limits.watch({intervalMs:10,pause:async source=>{paused.push(source);return{paused:true}},onDeny:()=>{denied++}}); t.after(cancel);
  f.advance(60_000); await new Promise(resolve=>setTimeout(resolve,35)); cancel(); assert.ok(paused.includes('api')); assert.ok(paused.includes('dsh')); assert.ok(denied>0); assert.equal(f.limits.state().session.status,'expired'); assert.equal(f.limits.beforeAction('api','douyin_next').allowed,false);
});
test('损坏的视频状态拒绝刷但仍允许暂停与私信，定时器不漏掉暂停', async (t) => {
  const f=fixture(t); fs.writeFileSync(f.limits.policyFile,'损坏的设置'); const paused=[]; await f.limits.enforce({pause:async source=>paused.push(source)});
  assert.deepEqual(paused.sort(),['api','dsh']); assert.equal(f.limits.beforeAction('api','douyin_pause').allowed,true); assert.equal(f.limits.beforeAction('dsh','douyin_chat_start').allowed,true); assert.throws(()=>f.limits.beforeAction('api','douyin_play'));
});

async function serverFixture(t, f) {
  const config={apiKey:'fixture-video-key',model:'deepseek-flash'}; const paused={api:false,dsh:false}; let modelCalls=0; let chatStops=0;
  const agent={runTask:({signal})=>{modelCalls++;return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({status:'stopped',message:'视频模型任务已停止。'}),{once:true}))}};
  const chatService={state:()=>({running:true}),stop:()=>{chatStops++;return{running:false}},close:async()=>{}};
  const server=createApiServer({controller:{execute:async()=>({})},config,agent,chatService,videoLimits:f.limits,pauseVideoSources:async source=>{paused[source]=true;return{paused:true}},port:0}); server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})); const base=`http://127.0.0.1:${server.address().port}`; const bootstrap=await(await fetch(base+'/api/bootstrap')).json();
  const headers={'x-session-token':bootstrap.token,'content-type':'application/json'};
  const request=async(route,body)=>{const response=await fetch(base+route,{headers,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});return{status:response.status,body:await response.json()}};
  return{server,base,headers,request,paused,modelCalls:()=>modelCalls,chatStops:()=>chatStops};
}
test('本机 API 校验参数与令牌；时间用完实际调用暂停并停止模型，私信 worker 继续运行', async (t) => {
  const f=fixture(t); const s=await serverFixture(t,f);
  assert.equal((await fetch(s.base+'/api/video/status')).status,403); assert.equal((await s.request('/api/video/policy',policy([],10))).status,400);
  assert.equal((await s.request('/api/video/policy',{...policy(),sessionMinutes:null})).status,200);
  assert.equal((await s.request('/api/task',{instruction:'尚未开始的一轮不能刷'})).status,409); assert.equal(s.modelCalls(),0);
  assert.equal((await s.request('/api/video/policy',policy(['00:00-24:00'],1))).status,200); assert.equal((await s.request('/api/video/start',{})).status,200);
  s.paused.api=false;s.paused.dsh=false; assert.equal((await s.request('/api/task',{instruction:'合成视频任务'})).status,202); f.advance(60_000); await s.server.enforceVideoLimits(); await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(s.paused.api,true); assert.equal(s.paused.dsh,true); assert.equal((await s.request('/api/state')).body.task.status,'stopped'); assert.equal((await s.request('/api/chat/state')).body.running,true); assert.equal(s.chatStops(),0); assert.equal((await s.request('/api/task',{instruction:'不能续刷'})).status,409);
  const spoofed=await new Promise((resolve,reject)=>{const request=http.request(s.base+'/api/video/status',{headers:{host:'untrusted.example','x-session-token':s.headers['x-session-token']}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode))});request.on('error',reject);request.end()});assert.equal(spoofed,403);
  const tooLong=await fetch(s.base+'/api/video/policy',{method:'POST',headers:s.headers,body:JSON.stringify(policy(['x'.repeat(21_000)]))});assert.equal(tooLong.status,413);
});
test('控制台可以设置跨午夜时段、显式开始、看剩余时间并结束；使用临时 Edge 不操作登录资料', {skip:process.env.DOUYIN_UI_TEST!=='1'}, async (t)=>{
  const f=fixture(t,'2026-10-14T15:30:00Z');const s=await serverFixture(t,f);const require=createRequire(import.meta.url);const {chromium}=createRequire(require.resolve('@playwright/mcp'))('playwright');const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:980}});const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(s.base);await page.locator('#videoTimePanel').waitFor();await page.locator('#videoWindows').fill('23:00-01:00');await page.locator('#videoMinutes').fill('12');await page.getByRole('button',{name:'保存时间设置',exact:true}).click();await page.getByRole('button',{name:'开始新一轮',exact:true}).click();await page.locator('#videoRemaining').filter({hasText:'剩余 12 分'}).waitFor();await page.getByRole('button',{name:'结束当前轮',exact:true}).click();await page.locator('#videoRemaining').filter({hasText:'当前不可刷'}).waitFor();assert.equal(f.limits.state().policy.sessionMinutes,12);assert.equal(f.limits.state().session.status,'ended');assert.equal(s.chatStops(),0);assert.deepEqual(errors,[]);await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
});

test('定时器到点实际暂停临时 Edge 内两个播放中的 HTML 视频元素', {skip:process.env.DOUYIN_UI_TEST!=='1'}, async t => {
  const f=fixture(t);f.limits.savePolicy(policy(['00:00-24:00'],1),{explicit:true});f.limits.markSession('api',{explicit:true});const require=createRequire(import.meta.url);const{chromium}=createRequire(require.resolve('@playwright/mcp'))('playwright');const browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const pages={};
  for(const source of ['api','dsh']){const page=pages[source]=await browser.newPage();await page.setContent('<canvas width="32" height="32"></canvas><video muted autoplay></video>');await page.evaluate(()=>{const canvas=document.querySelector('canvas');const context=canvas.getContext('2d');const draw=()=>{context.fillStyle='red';context.fillRect(0,0,32,32);requestAnimationFrame(draw)};draw();const video=document.querySelector('video');video.srcObject=canvas.captureStream(10);void video.play()});await page.waitForFunction(()=>document.querySelector('video').readyState>=2&&!document.querySelector('video').paused);assert.equal(await page.locator('video').evaluate(video=>video.paused),false)}
  const cancel=f.limits.watch({intervalMs:10,pause:async source=>pages[source].locator('video').evaluate(video=>{video.pause();return{paused:video.paused}})});t.after(cancel);f.advance(60_000);await Promise.all(Object.values(pages).map(page=>page.waitForFunction(()=>document.querySelector('video').paused)));cancel();assert.equal(f.limits.state().allowed,false);assert.equal(f.limits.beforeAction('dsh','douyin_next').allowed,false);
});
