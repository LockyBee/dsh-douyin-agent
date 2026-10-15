import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../playwright-runtime.mjs';
import { BrowserController } from '../core.mjs';

// 独立 Edge 和本机拦截的合成视频，不连接用户的 CDP、抖音或登录资料。
let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });

const html = `<!doctype html><html><head><meta charset="utf-8"><title>合成连续采样</title>
  <style>
    body{margin:0;height:2200px;background:#143447;color:white}
    section{position:fixed;left:30px;top:100px;width:240px;height:320px}
    video{display:block;width:240px;height:320px}
    #motion{position:absolute;left:0;top:0;width:20px;height:20px;background:#ffe66b;animation:drift 100s linear infinite}
    @keyframes drift{from{transform:translateX(0)}to{transform:translateX(200px)}}
    #controls{position:fixed;left:320px;top:120px}
  </style></head><body>
  <section data-e2e="feed-active-video">
    <div data-e2e="player-container" class="video_111"><video autoplay muted playsinline></video><div id="motion"></div></div>
    <span data-e2e="video-desc">合成连续播放作品</span><a href="/user/synthetic">合成作者</a>
  </section>
  <div id="controls"><input id="search" value="合成搜索词"><textarea>合成输入区</textarea><div contenteditable>合成可编辑区</div></div>
  <script>
    const canvas=document.createElement('canvas');canvas.width=240;canvas.height=320;
    const painter=canvas.getContext('2d');let tick=0;
    const draw=()=>{painter.fillStyle='#143447';painter.fillRect(0,0,240,320);painter.fillStyle='#fff';painter.fillRect(tick++%220,60,20,20)};
    draw();const video=document.querySelector('video');video.srcObject=canvas.captureStream(30);void video.play();setInterval(draw,32);
    window.probe={edits:[],media:[],animations:[],viewport:[],focus:[]};
    for(const event of ['pause','seeking','emptied','loadstart'])video.addEventListener(event,()=>probe.media.push(event));
    for(const event of ['animationstart','animationcancel','animationend'])document.querySelector('#motion').addEventListener(event,()=>probe.animations.push(event));
    for(const event of ['resize','scroll'])window.addEventListener(event,()=>probe.viewport.push(event));
    for(const event of ['focus','blur'])window.addEventListener(event,()=>probe.focus.push(event));
    new MutationObserver(rows=>probe.edits.push(...rows.map(row=>({tag:row.target.tagName,attribute:row.attributeName})))).observe(document.querySelector('#controls'),{subtree:true,attributes:true});
    window.readProbe=()=>({edits:[...probe.edits],media:[...probe.media],animations:[...probe.animations],viewport:[...probe.viewport],focus:[...probe.focus],
      videoTime:video.currentTime,paused:video.paused,animationTime:document.querySelector('#motion').getAnimations()[0].currentTime,
      x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,visibility:document.visibilityState});
    window.clearProbe=()=>{for(const rows of Object.values(probe))rows.length=0;};
  </script></body></html>`;

async function fixture(t) {
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
  t.after(() => context.close());
  await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  const page = await context.newPage();
  await page.goto('https://www.douyin.com/video/111');
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.1 && document.querySelector('#motion').getAnimations()[0]?.currentTime > 0);
  await page.evaluate(() => { scrollTo(0, 300); document.querySelector('#search').focus({ preventScroll: true }); });
  await page.waitForTimeout(50);
  await page.evaluate(() => clearProbe());
  const controller = new BrowserController({ source: 'verification', memory: { recordVideo() {} } });
  controller.page = page; controller.browser = browser;
  return { page, context, controller };
}

test('合成视频：连续截图不改输入样式，不重置动画、媒体、滚动或视口', async t => {
  const { page, controller } = await fixture(t);
  const before = await page.evaluate(() => readProbe());
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  const result = await controller.capture(0.3);
  const after = await page.evaluate(() => readProbe());
  assert.equal(result.frames.length, 3);
  assert.ok(result.frames.every(frame => frame.videoId === '111' && frame.mimeType === 'image/jpeg' && Buffer.from(frame.data, 'base64').length > 100));
  assert.ok(after.videoTime > before.videoTime, '真实 HTMLVideoElement 在采样期间继续播放');
  assert.ok(after.animationTime > before.animationTime, '同一个 CSS 动画的时间线继续前进');
  assert.equal(after.paused, false);
  assert.deepEqual(after.edits, [], '采样不临时隐藏或恢复页面中输入框的光标样式');
  assert.deepEqual(after.media, []);
  assert.deepEqual(after.animations, []);
  assert.deepEqual(after.viewport, []);
  assert.deepEqual(after.focus, []);
  assert.deepEqual([after.x, after.y, after.width, after.height], [before.x, before.y, before.width, before.height]);
  assert.equal(navigations, 0);
  const decoded = await page.evaluate(async data => { const image = new Image(); image.src = 'data:image/jpeg;base64,' + data; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; }, result.frames[0].data);
  assert.deepEqual(decoded, { width: 240, height: 320 }, '仍只输出当前视频在视口内的裁剪画面');
});

test('合成后台标签：采样不抢前台或改变当前作品', async t => {
  const { page, context, controller } = await fixture(t);
  const foreground = await context.newPage();
  await foreground.goto('https://www.douyin.com/video/222');
  await foreground.bringToFront();
  await page.waitForTimeout(50);
  await page.evaluate(() => clearProbe());
  const before = await page.evaluate(() => readProbe());
  const result = await controller.capture(0);
  const after = await page.evaluate(() => readProbe());
  assert.equal(result.frames.length, 1);
  assert.equal(result.state.video.id, '111');
  assert.equal(page.url(), 'https://www.douyin.com/video/111');
  assert.equal(after.visibility, before.visibility);
  assert.deepEqual(after.focus, []);
  assert.deepEqual(after.viewport, []);
  assert.equal(await foreground.evaluate(() => document.visibilityState), 'visible');
});

test('合成截图边界：登录覆盖出现时继续丢弃画面', async t => {
  const { page, controller } = await fixture(t);
  const screenshot = page.screenshot.bind(page);
  page.screenshot = async options => {
    await page.evaluate(() => { const overlay = document.createElement('div'); overlay.textContent = '手机扫码登录'; overlay.style.cssText = 'position:fixed;inset:0;background:white;z-index:9'; document.body.append(overlay); });
    return screenshot(options);
  };
  const result = await controller.capture(0);
  assert.equal(result.state.loginRequired, true);
  assert.deepEqual(result.frames, []);
});

test('合成截图边界：截图结束前取消时不交付画面', async t => {
  const { page, controller } = await fixture(t);
  const cancellation = new AbortController();
  const reason = new DOMException('合成采样已取消', 'AbortError');
  const screenshot = page.screenshot.bind(page);
  page.screenshot = async options => { const image = await screenshot(options); cancellation.abort(reason); return image; };
  await assert.rejects(controller.capture(0, cancellation.signal), error => error === reason);
});
