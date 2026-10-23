import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '../playwright-runtime.mjs';
import { WatchMode } from '../watch-mode.mjs';
import { BrowserController } from '../core.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] }); });
after(async () => { await browser?.close(); });
const HTML = `<!doctype html><meta charset="utf-8"><title>合成静默播放</title><input id="focus" value="保留焦点"><video autoplay playsinline style="width:200px;height:240px"></video><script>
const canvas=document.createElement('canvas');canvas.width=200;canvas.height=240;const painter=canvas.getContext('2d');let tick=0;
const draw=()=>{painter.fillStyle=tick++%2?'red':'blue';painter.fillRect(0,0,200,240)};draw();const video=document.querySelector('video');video.srcObject=canvas.captureStream(20);void video.play().catch(()=>{});setInterval(draw,50);
</script>`;
function fixture(t, source = 'api') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-watch-mode-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-watch-mode-/); fs.rmSync(directory, { recursive: true, force: true }); });
  const mode = new WatchMode({ stateDir: directory, source }); return { directory, mode };
}
async function pageFixture(t, label = 'deepseek-douyin-api', url = 'https://www.douyin.com/video/123456') {
  const context = await browser.newContext(); t.after(() => context.close());
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: HTML }));
  const page = await context.newPage(); await page.goto(url); await page.evaluate(name => { window.name = name; }, label);
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2 && !document.querySelector('video').paused, null, { timeout: 5000 });
  return { page, context };
}
function syntheticWindow() {
  const pages = [], commands = [], windows = new Map([[1, { windowState: 'normal' }], [2, { windowState: 'normal' }]]);
  const context = { pages: () => pages, browser: () => ({ contexts: () => [context] }), async newCDPSession(page) { return { async send(method, params) { if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: page.targetId } }; if (method === 'Browser.getWindowForTarget') { const target = pages.find(item => item.targetId === params.targetId); return { windowId: target.windowId, bounds: { ...windows.get(target.windowId) } }; } if (method === 'Browser.setWindowBounds') { commands.push({ method, params }); windows.set(params.windowId, { ...params.bounds }); return {}; } assert.fail(`未允许的合成CDP指令：${method}`); }, async detach() {} }; } };
  const add = (name = 'deepseek-douyin-api', windowId = 1, extra = {}) => { const page = { name, windowId, targetId: `synthetic-${pages.length + 1}`, origin: 'https://www.douyin.com', isClosed: () => false, context: () => context, async evaluate() { return { origin: page.origin, name: page.name, loginRequired: false, verificationRequired: false, ...extra }; }, bringToFront() { assert.fail('静默模式不能置前窗口'); } }; pages.push(page); return page; };
  return { add, pages, commands, windows };
}

test('两入口共用静默许可且默认关闭，设置不接受模型扩权字段或损坏状态', t => {
  const f = fixture(t), dsh = new WatchMode({ stateDir: f.directory, source: 'dsh' });
  assert.equal(f.mode.state().silent, false); assert.equal(f.mode.state().capabilities.headless, false);
  assert.throws(() => f.mode.configure({ silent: true }), /明确/);
  assert.throws(() => f.mode.configure({ silent: true, play: true }, { explicit: true }), /只接收/);
  f.mode.configure({ silent: true }, { explicit: true }); assert.equal(dsh.state().silent, true);
  dsh.configure({ silent: false }, { explicit: true }); assert.equal(f.mode.state().silent, false);
  fs.writeFileSync(f.mode.policyFile, '损坏的合成设置'); assert.throws(() => f.mode.configure({ silent: true }, { explicit: true }), /核对/);
  assert.equal(fs.readFileSync(f.mode.policyFile, 'utf8'), '损坏的合成设置');
});

test('临时真实Edge页面持续静音且有实际播放进度，不改变音量、输入焦点、暂停或visibility', async t => {
  const f = fixture(t), { page } = await pageFixture(t);
  await page.locator('#focus').focus();
  const before = await page.evaluate(() => { const video = document.querySelector('video'); video.volume = 0.37; return { time: video.currentTime, visibility: document.visibilityState, muted: video.muted }; });
  f.mode.configure({ silent: true }, { explicit: true }); const result = await f.mode.apply(page);
  assert.equal(result.applied, true); assert.equal(result.muted, true); assert.equal(result.focusRequested, false);
  await page.waitForFunction(time => document.querySelector('video').currentTime > time + 0.15, before.time, { timeout: 5000 });
  await page.evaluate(() => { document.querySelector('video').muted = false; });
  await page.waitForFunction(() => document.querySelector('video').muted, null, { timeout: 1000 });
  const after = await page.evaluate(() => ({ muted: document.querySelector('video').muted, paused: document.querySelector('video').paused, volume: document.querySelector('video').volume, visibility: document.visibilityState, focus: document.activeElement.id }));
  assert.equal(after.paused, false); assert.equal(after.volume, 0.37); assert.equal(after.visibility, before.visibility); assert.equal(after.focus, 'focus');
  await page.evaluate(() => { document.querySelector('video').volume = 0.12; });
  f.mode.configure({ silent: false }, { explicit: true }); await f.mode.apply(page);
  assert.equal(await page.locator('video').evaluate(video => video.muted), before.muted);
  assert.equal(await page.locator('video').evaluate(video => video.volume), 0.12);
  assert.equal(await page.evaluate(() => Boolean(window.__dafeiyuSilentVideoMode)), false);
});

test('新增媒体与同源导航仍静音，关闭后未来导航不重装旧监听，保留原本静音媒体', async t => {
  const f = fixture(t), { page } = await pageFixture(t); f.mode.configure({ silent: true }, { explicit: true }); await f.mode.apply(page);
  await page.evaluate(() => { const second = document.createElement('video'); second.id = 'original-muted'; second.muted = true; second.volume = 0.24; document.body.append(second); const third = document.createElement('video'); third.id = 'new-video'; document.body.append(third); });
  await page.waitForFunction(() => document.getElementById('new-video').muted, null, { timeout: 1000 });
  f.mode.configure({ silent: false }, { explicit: true }); await f.mode.apply(page);
  assert.equal(await page.locator('#original-muted').evaluate(video => video.muted), true); assert.equal(await page.locator('#new-video').evaluate(video => video.muted), false);
  f.mode.configure({ silent: true }, { explicit: true }); await f.mode.apply(page);
  await page.goto('https://www.douyin.com/video/123457'); await page.waitForFunction(() => document.querySelector('video')?.muted, null, { timeout: 1000 });
  f.mode.configure({ silent: false }, { explicit: true }); await f.mode.apply(page);
  await page.goto('https://www.douyin.com/video/123458');
  assert.equal(await page.locator('video').evaluate(video => video.muted), false); assert.equal(await page.evaluate(() => Boolean(window.__dafeiyuSilentVideoMode)), false);
});

test('非指定标签、离开抖音及登录验证时不新增静默或隐藏操作', async t => {
  const f = fixture(t); f.mode.configure({ silent: true }, { explicit: true });
  const unrelated = await pageFixture(t, 'unrelated'); assert.equal((await f.mode.apply(unrelated.page)).applied, false); assert.equal(await unrelated.page.locator('video').evaluate(video => video.muted), false);
  const foreign = await pageFixture(t, 'deepseek-douyin-api', 'https://fixture.invalid/video'); assert.equal((await f.mode.apply(foreign.page)).applied, false);
  const protectedPage = await pageFixture(t); await protectedPage.page.evaluate(() => { const banner = document.createElement('p'); banner.textContent = '请完成下方验证'; document.body.append(banner); });
  const result = await f.mode.apply(protectedPage.page); assert.equal(result.blocked, true); assert.equal(result.verificationRequired, true); assert.equal(await protectedPage.page.locator('video').evaluate(video => video.muted), false);
});

test('仅用合成CDP核对受管窗口后最小化，关闭不自动显示，显式恢复不调用置前', async t => {
  const f = fixture(t), window = syntheticWindow(), page = window.add(); window.add('deepseek-douyin-dsh');
  assert.equal((await f.mode.minimizeManagedWindow(page)).changed, false); assert.equal(window.commands.length, 0);
  f.mode.configure({ silent: true }, { explicit: true });
  const minimized = await f.mode.minimizeManagedWindow(page); assert.equal(minimized.minimized, true); assert.equal(minimized.headless, false); assert.equal(window.commands.length, 1);
  assert.equal((await f.mode.minimizeManagedWindow(page)).changed, false); assert.equal(window.commands.length, 1);
  f.mode.configure({ silent: false }, { explicit: true }); assert.equal(window.commands.length, 1);
  await assert.rejects(f.mode.restoreManagedWindow(page), /明确/);
  assert.equal((await f.mode.restoreManagedWindow(page, { explicit: true })).restored, true); assert.equal(window.windows.get(1).windowState, 'normal');
  assert.equal(window.commands.every(command => command.method === 'Browser.setWindowBounds'), true);
});

test('同窗出现其他页面或验证就拒绝最小化，不碰不同窗口或原有全屏状态', async t => {
  const f = fixture(t); f.mode.configure({ silent: true }, { explicit: true });
  const unsafe = syntheticWindow(), page = unsafe.add(); unsafe.add('unrelated');
  await assert.rejects(f.mode.minimizeManagedWindow(page), /非受管/); assert.equal(unsafe.commands.length, 0);
  const protectedWindow = syntheticWindow(), login = protectedWindow.add('deepseek-douyin-api', 1, { loginRequired: true });
  await assert.rejects(f.mode.minimizeManagedWindow(login), /验证/); assert.equal(protectedWindow.commands.length, 0);
  const different = syntheticWindow(), own = different.add(); const other = different.add('unrelated', 2); other.origin = 'https://fixture.invalid';
  await f.mode.minimizeManagedWindow(own); assert.equal(different.windows.get(2).windowState, 'normal');
  const fullscreen = syntheticWindow(), full = fullscreen.add(); fullscreen.windows.set(1, { windowState: 'fullscreen' });
  await assert.rejects(f.mode.minimizeManagedWindow(full), /全屏/); assert.equal(fullscreen.commands.length, 0);
});

test('窗口target更换或用户手改状态后不拿旧凭据恢复，外来控制锁不抢占', async t => {
  const f = fixture(t), window = syntheticWindow(), page = window.add(); f.mode.configure({ silent: true }, { explicit: true }); await f.mode.minimizeManagedWindow(page);
  page.targetId = 'synthetic-replaced'; assert.equal((await f.mode.restoreManagedWindow(page, { explicit: true })).changed, false);
  page.targetId = 'synthetic-1'; window.windows.set(1, { windowState: 'maximized' }); assert.equal((await f.mode.restoreManagedWindow(page, { explicit: true })).changed, false);
  window.windows.set(1, { windowState: 'minimized' }); assert.equal((await f.mode.restoreManagedWindow(page, { explicit: true })).changed, false);
  fs.writeFileSync(f.mode.controlFile, '外来合成锁'); assert.throws(() => f.mode.configure({ silent: false }, { explicit: true }), error => error.code === 'WATCH_MODE_BUSY');
  assert.equal(fs.readFileSync(f.mode.controlFile, 'utf8'), '外来合成锁');
});

test('静默保存能最小化仅有私信或准备页的专用窗口，连接恢复不新建或启动页面', async t => {
  const f=fixture(t), window=syntheticWindow();window.add('deepseek-douyin-dsh-chat');window.add('deepseek-douyin-api-chat');window.add('deepseek-douyin-launcher');
  f.mode.configure({silent:true},{explicit:true});let reconnects=0;
  const controller=new BrowserController({source:'api',videoLimits:{stateDir:f.directory}});controller.modePromise=Promise.resolve(f.mode);
  controller.connectExistingBrowser=async()=>{reconnects++;return{isConnected:()=>true,contexts:()=>[window.pages[0].context()]};};
  controller.connect=()=>assert.fail('保存静默不得新建页面或启动视频');
  const result=await controller.applyWatchMode({minimize:true});
  assert.equal(reconnects,1);assert.equal(result.minimized,true);assert.match(result.message,/已最小化/);assert.equal(result.pages.length,3);assert.equal(window.commands.length,1);assert.equal(f.mode.state().application.minimized,true);
});

test('专用窗口包含无关页或登录验证时显示真实阻止原因，没有浏览器时只保存待应用状态', async t => {
  const f=fixture(t);f.mode.configure({silent:true},{explicit:true});
  const make=window=>({isConnected:()=>true,contexts:()=>[window.pages[0].context()]});
  const mixed=syntheticWindow();mixed.add('deepseek-douyin-api-chat');mixed.add('unrelated');const blocked=await f.mode.applyBrowser(make(mixed),{minimize:true});assert.equal(blocked.minimized,false);assert.match(blocked.message,/非受管/);assert.equal(mixed.commands.length,0);
  const login=syntheticWindow();login.add('deepseek-douyin-launcher',1,{loginRequired:true});const protectedState=await f.mode.applyBrowser(make(login),{minimize:true});assert.match(protectedState.message,/登录验证/);assert.equal(login.commands.length,0);
  const absent=await f.mode.applyBrowser(null,{minimize:true});assert.equal(absent.pendingNextVideoAction,true);assert.match(absent.message,/下次浏览/);
});

test('同一静默设置覆盖软件和插件作品页的静音，不修改私信页媒体', async t => {
  const f=fixture(t), api=await pageFixture(t), dsh=await pageFixture(t,'deepseek-douyin-dsh'), chat=await pageFixture(t,'deepseek-douyin-dsh-chat');
  f.mode.configure({silent:true},{explicit:true});const result=await f.mode.applyBrowser(browser);
  assert.equal(result.applied,true);assert.equal(await api.page.locator('video').evaluate(v=>v.muted),true);assert.equal(await dsh.page.locator('video').evaluate(v=>v.muted),true);assert.equal(await chat.page.locator('video').evaluate(v=>v.muted),false);
  f.mode.configure({silent:false},{explicit:true});await f.mode.applyBrowser(browser);assert.equal(await dsh.page.locator('video').evaluate(v=>v.muted),false);
});
