import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from '../playwright-runtime.mjs';
import { BrowserController, verifySharedVideoFrameProof } from '../core.mjs';

// 独立无账号 Edge，仅播放 FFmpeg 生成的测试图形，不连接抖音或用户浏览器。
const videoBytes = fs.readFileSync(new URL('./fixtures/shared-canvas-synthetic.mp4', import.meta.url));
let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(t, failure) {
  const context = await browser.newContext({ viewport: { width: 700, height: 500 } });
  t.after(() => context.close());
  await context.route('https://shared-canvas.invalid/**', route => route.fulfill(route.request().url().endsWith('.mp4')
    ? { contentType: 'video/mp4', body: videoBytes }
    : { contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>无账号合成视频</title><video style="width:480px;height:270px" src="/synthetic.mp4" muted loop autoplay playsinline></video>' }));
  const page = await context.newPage();
  await page.goto('https://shared-canvas.invalid/video/12345');
  await page.waitForFunction(() => { const video = document.querySelector('video'); return !video.paused && video.readyState >= 2 && Number.isFinite(video.duration) && video.currentTime > 0.1; });
  await page.evaluate(kind => {
    window.canvasAppends = 0;
    new MutationObserver(rows => { for (const row of rows) for (const node of row.addedNodes) if (node.nodeName === 'CANVAS') window.canvasAppends++; }).observe(document.documentElement, { childList: true, subtree: true });
    if (kind) {
      const original = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (...args) {
        if (kind === 'cors') throw new DOMException('合成跨域阻止', 'SecurityError');
        if (kind === 'ordinary') throw new DOMException('合成画布一般错误', 'InvalidStateError');
        const result = original.apply(this, args);
        if (kind === 'paused-during-capture') document.querySelector('video').pause();
        return result;
      };
    }
  }, failure);
  let sessions = 0;
  const newCDPSession = context.newCDPSession.bind(context);
  context.newCDPSession = async (...args) => { sessions++; return newCDPSession(...args); };
  const controller = Object.create(BrowserController.prototype);
  controller.source = 'verification'; controller.page = page;
  controller.checkVideoLimits = async () => {};
  controller.currentVideo = async () => page.locator('video');
  controller.state = async options => {
    assert.equal(options.record, false);
    return page.evaluate(() => { const video = document.querySelector('video'); return { video: { id: '12345', time: video.currentTime, duration: video.duration, paused: video.paused, readyState: video.readyState }, videoSelection: { identityConflict: false } }; });
  };
  return { page, controller, sessions: () => sessions };
}

test('无账号合成视频：canvas 三帧真实解码、尺寸有界、宿主 proof 成立且不创建截图会话', async t => {
  const f = await fixture(t), result = await f.controller.captureSharedFrames(3);
  assert.equal(verifySharedVideoFrameProof(result, '12345'), true);
  assert.equal(result.frames.length, 3);
  assert.equal(result.observation.captureMethod, 'video-canvas-jpeg-v1');
  assert.ok(result.observation.actualWallSeconds >= 2.8 && result.observation.actualWallSeconds <= 10);
  assert.equal(f.sessions(), 0);
  assert.equal(await f.page.evaluate(() => window.canvasAppends), 0);
  assert.ok(new Set(result.frames.map(frame => frame.data)).size > 1, '真实解码的动态图形不能只复用一张封面');
  for (const frame of result.frames) {
    assert.equal(frame.captureMethod, 'video-canvas-jpeg-v1');
    assert.deepEqual(frame.captureSize, { width: 960, height: 540 });
    const size = await f.page.evaluate(async data => { const image = new Image(); image.src = 'data:image/jpeg;base64,' + data; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; }, frame.data);
    assert.deepEqual(size, frame.captureSize);
  }
  const frame = result.frames[0];
  frame.captureMethod = 'cdp-page-screenshot-interval-v1'; assert.equal(verifySharedVideoFrameProof(result, '12345'), false);
  frame.captureMethod = 'video-canvas-jpeg-v1'; frame.captureSize.width = 961; assert.equal(verifySharedVideoFrameProof(result, '12345'), false);
  frame.captureSize.width = 960; assert.equal(verifySharedVideoFrameProof(result, '12345'), true);
  assert.equal(verifySharedVideoFrameProof(JSON.parse(JSON.stringify(result)), '12345'), false);
});

test('无账号合成视频：只有 canvas SecurityError 使用延迟创建的有界 CDP 截图', async t => {
  const f = await fixture(t, 'cors'), result = await f.controller.captureSharedFrames(1);
  assert.equal(result.frames.length, 3);
  assert.equal(result.observation.captureMethod, 'cdp-page-screenshot-interval-v1');
  assert.deepEqual(result.frameProof.captureMethods, Array(3).fill('cdp-page-screenshot-interval-v1'));
  assert.equal(verifySharedVideoFrameProof(result, '12345'), true);
  assert.equal(f.sessions(), 1);
  assert.equal(await f.page.evaluate(() => window.canvasAppends), 0);
});

test('无账号合成视频：一般画布错误和采样期间暂停不会触发截图兜底', async t => {
  for (const kind of ['ordinary', 'paused-during-capture']) {
    const f = await fixture(t, kind);
    await assert.rejects(f.controller.captureSharedFrames(1), /InvalidStateError|合成画布一般错误|播放|推进|暂停/);
    assert.equal(f.sessions(), 0, kind);
  }
});

test('无账号真实播放：自主选择超过三秒的单批采集仍生成原生进度证明',async t=>{
  const f=await fixture(t),value=await f.controller.captureSharedFrames(4.5);
  assert.equal(verifySharedVideoFrameProof(value,'12345'),true);
  assert.ok(value.observation.actualWallSeconds>=4.4);assert.ok(value.observation.playbackProgressSeconds>4.2);
  assert.equal(value.frameProof.requestedSeconds,4.5);assert.equal(f.sessions(),0);
});
