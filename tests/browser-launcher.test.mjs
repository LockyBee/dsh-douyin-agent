import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from '../playwright-runtime.mjs';
import { BrowserLauncher, PREPARE_PAGE_NAME, connectDedicatedBrowser } from '../browser-launcher.mjs';
import { createApiServer } from '../app.mjs';

const run = promisify(execFile);
const HTML = `<!doctype html><meta charset="utf-8"><title>合成准备页</title><video muted autoplay playsinline style="width:200px;height:240px"></video><script>
const canvas=document.createElement('canvas');canvas.width=200;canvas.height=240;const paint=canvas.getContext('2d');paint.fillRect(0,0,200,240);
const video=document.querySelector('video');video.srcObject=canvas.captureStream(12);setInterval(()=>{paint.fillStyle=Date.now()%2?'red':'blue';paint.fillRect(0,0,200,240);},50);void video.play().catch(()=>{});</script>`;
let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
async function contextFixture(t) {
  const context = await browser.newContext(); t.after(() => context.close());
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: HTML }));
  return { context, scopedBrowser: { contexts: () => [context] } };
}
async function playingPage(context, label, url = 'https://www.douyin.com/video/7770000000000000001') {
  const page = await context.newPage(); await page.goto(url); await page.evaluate(name => { window.name = name; }, label);
  await page.waitForFunction(() => { const video = document.querySelector('video'); return video.readyState >= 2 && !video.paused; }, null, { timeout: 5000 });
  return page;
}

test('独立准备页重用且自动暂停，原来正在播放的作品和其他标签页保持原状', async t => {
  const { context, scopedBrowser } = await contextFixture(t);
  const existing = await playingPage(context, 'deepseek-douyin-api'); const originalUrl = existing.url();
  const launcher = new BrowserLauncher({ getBrowser: async () => scopedBrowser });
  const first = await launcher.open(); assert.equal(first.mode, 'prepare'); assert.equal(first.reused, false); assert.equal(first.paused, true);
  const prepared = (await Promise.all(context.pages().map(async page => ({ page, name: await page.evaluate(() => window.name) })))).find(item => item.name === PREPARE_PAGE_NAME).page;
  await prepared.locator('video').waitFor({ state: 'attached', timeout: 5000 });
  assert.equal(await prepared.locator('video').evaluate(video => video.paused), true);
  await prepared.goto('https://www.douyin.com/video/7770000000000000002');
  await prepared.locator('video').waitFor({ state: 'attached', timeout: 5000 });
  await prepared.locator('video').evaluate(video => video.play().catch(() => {}));
  const selectedUrl = prepared.url(), pages = context.pages().length;
  const second = await launcher.open(); assert.equal(second.reused, true); assert.equal(context.pages().length, pages); assert.equal(prepared.url(), selectedUrl);
  assert.equal(await prepared.locator('video').evaluate(video => video.paused), true);
  assert.equal(existing.url(), originalUrl); assert.equal(await existing.locator('video').evaluate(video => video.paused), false);
  assert.equal(second.sessionChanged, false);
});

test('共享自主观看期间仅显示原命名入口，不暂停、不导航、不加准备脚本或新页', async t => {
  const { context, scopedBrowser } = await contextFixture(t), page = await playingPage(context, 'deepseek-douyin-dsh');
  const url = page.url(), count = context.pages().length;
  const launcher = new BrowserLauncher({ getBrowser: async () => scopedBrowser, getWatchState: () => ({ source: 'dsh', runId: 'synthetic-owner' }) });
  const result = await launcher.open(); assert.equal(result.mode, 'watch'); assert.equal(result.watchPreserved, true); assert.equal(result.paused, null);
  assert.equal(page.url(), url); assert.equal(context.pages().length, count); assert.equal(await page.locator('video').evaluate(video => video.paused), false);
  assert.equal(await page.evaluate(() => Boolean(window.__dafeiyuPreparePauseInstalled)), false);
});

test('首次打开复用唯一空白初始页，避免留下不受管空标签而阻止静默最小化', async t => {
  const {context,scopedBrowser}=await contextFixture(t), blank=await context.newPage();
  const launcher=new BrowserLauncher({getBrowser:async()=>scopedBrowser});const result=await launcher.open();
  assert.equal(result.reused,true);assert.equal(context.pages().length,1);assert.equal(context.pages()[0],blank);assert.equal(await blank.evaluate(()=>window.name),PREPARE_PAGE_NAME);assert.equal(result.paused,true);
});

test('自主观看入口缺失时给出可操作错误，不创建新页或改动现有页面', async t => {
  const { context, scopedBrowser } = await contextFixture(t), page = await playingPage(context, 'unrelated-synthetic-tab');
  const launcher = new BrowserLauncher({ getBrowser: async () => scopedBrowser, getWatchState: () => ({ source: 'api' }) });
  await assert.rejects(launcher.open(), /原入口页/); assert.equal(context.pages().length, 1); assert.equal(await page.locator('video').evaluate(video => video.paused), false);
});

test('调试连接使用30秒上限并隐藏原始连接信息，取消后只释放迟到的新连接', async () => {
  await assert.rejects(connectDedicatedBrowser('synthetic://not-a-real-endpoint', { connect: async (_endpoint, options) => { assert.equal(options.timeout, 30_000); throw Object.assign(new Error('synthetic-private-endpoint'), { name: 'TimeoutError' }); } }), error => /30秒/.test(error.message) && !error.message.includes('synthetic-private-endpoint'));
  const abort = new AbortController(), late = Promise.withResolvers(); let disconnected = 0;
  const connecting = connectDedicatedBrowser('synthetic://not-a-real-endpoint', { signal: abort.signal, connect: () => late.promise });
  abort.abort(new Error('合成用户取消')); await assert.rejects(connecting, /合成用户取消/);
  late.resolve({ close: async () => { disconnected++; } }); await new Promise(resolve => setImmediate(resolve)); assert.equal(disconnected, 1);
});

test('本机HTTP无需APIKey也能打开准备入口，仍校验token和空参数，重复请求互斥', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let opens = 0;
  const controller = { execute: async () => { throw new Error('准备入口不得调用模型工具'); }, openBrowser: async ({ signal }) => { opens++; assert.ok(signal instanceof AbortSignal); entered.resolve(); await release.promise; return { opened: true, mode: 'prepare', paused: true, sessionChanged: false }; } };
  const server = createApiServer({ controller, config: { apiKey: '', model: 'synthetic' }, pauseVideoSources: async () => ({}) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`, bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  const options = { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': bootstrap.token }, body: '{}' };
  assert.equal((await fetch(`${base}/api/browser/open`, { ...options, headers: { 'content-type': 'application/json' } })).status, 403);
  assert.equal((await fetch(`${base}/api/browser/open`, { ...options, body: '{"url":"https://untrusted.example"}' })).status, 400);
  const pending = fetch(`${base}/api/browser/open`, options); await entered.promise;
  try { assert.equal((await fetch(`${base}/api/browser/open`, options)).status, 409); } finally { release.resolve(); }
  const result = await pending; assert.equal(result.status, 200); assert.equal((await result.json()).opened, true); assert.equal(opens, 1); assert.equal(bootstrap.config.configured, false);
});

test('真实临时Edge经核心openBrowser复用准备页和watch入口，有限轮次文件逐字节不变', { timeout: 30_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-launcher-core-')); const home = path.join(root, 'home'), temporary = path.join(root, 'tmp'), stateDir = path.join(root, 'state');
  for (const directory of [home, temporary, stateDir]) fs.mkdirSync(directory);
  t.after(() => { if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('浏览器入口测试目录越界。'); fs.rmSync(root, { recursive: true, force: true }); });
  const script = `
import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {chromium} from ${JSON.stringify(new URL('../playwright-runtime.mjs', import.meta.url).href)};
import {BrowserController} from ${JSON.stringify(new URL('../core.mjs', import.meta.url).href)};
import {VideoLimits} from ${JSON.stringify(new URL('../video-limits.mjs', import.meta.url).href)};
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const context=await browser.newContext();await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:${JSON.stringify(HTML)}}));
 const limits=new VideoLimits({stateDir:process.env.SYNTHETIC_LAUNCHER_STATE});
 const before=fs.readFileSync(limits.sessionsFile,'utf8');const policy=fs.readFileSync(limits.policyFile,'utf8');
 const controller=new BrowserController({source:'api',videoLimits:limits});controller.browser=browser;
 const first=await controller.openBrowser();const second=await controller.openBrowser();
 assert.equal(first.mode,'prepare');assert.equal(second.reused,true);assert.equal(context.pages().length,1);
 const prepare=context.pages()[0];await prepare.locator('video').waitFor({state:'attached',timeout:5000});assert.equal(await prepare.locator('video').evaluate(video=>video.paused),true);
 const watch=await context.newPage();await watch.goto('https://www.douyin.com/video/7770000000000000008');await watch.evaluate(()=>{window.name='deepseek-douyin-dsh'});await watch.waitForFunction(()=>document.querySelector('video')?.readyState>=2&&!document.querySelector('video').paused,null,{timeout:5000});
 fs.writeFileSync(path.join(limits.stateDir,'watch-loop.lock'),JSON.stringify({version:1,pid:process.pid,source:'dsh',runId:'synthetic-live-owner',sessionId:'synthetic-session'}));
 const third=await controller.openBrowser();assert.equal(third.mode,'watch');assert.equal(await watch.locator('video').evaluate(video=>video.paused),false);assert.equal(context.pages().length,2);
 assert.equal(fs.readFileSync(limits.sessionsFile,'utf8'),before);assert.equal(fs.readFileSync(limits.policyFile,'utf8'),policy);assert.equal(controller.page,null);
 console.log(JSON.stringify({reused:second.reused,preparePaused:true,watchPreserved:third.watchPreserved,clockUnchanged:true}));
}finally{await browser.close()}
`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { timeout: 25_000, windowsHide: true, env: { ...process.env, HOME: home, USERPROFILE: home, TEMP: temporary, TMP: temporary, DOUYIN_RUNTIME_LOCATION_FILE: path.join(root, 'absent-location.json'), SYNTHETIC_LAUNCHER_STATE: stateDir } });
  assert.deepEqual(JSON.parse(stdout.trim()), { reused: true, preparePaused: true, watchPreserved: true, clockUnchanged: true });
});
