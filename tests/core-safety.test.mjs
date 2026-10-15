import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../playwright-runtime.mjs';
import { BrowserController, readPageState } from '../core.mjs';
import { VideoLimits } from '../video-limits.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 这些回归使用独立的真实 Edge 和合成网页，不连接用户的 CDP 或登录资料。
// canvas.captureStream 为真实 HTMLVideoElement 提供媒体，不替换 DOM 或浏览器运行时。
let browser;
before(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
});
after(async () => { await browser?.close(); });

const videoMarkup = (id = '111', title = '合成公开作品') => `
  <section data-e2e="feed-active-video">
    <div data-e2e="player-container" class="video_${id}">
      <video muted autoplay playsinline style="width:240px;height:320px"></video>
    </div>
    <div data-e2e="video-desc">${title}</div>
    <a href="/user/synthetic-author">合成作者</a>
  </section>`;

function documentHtml(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>合成页面测试</title>
    <style>body{margin:0;font:16px sans-serif}section{position:relative;width:260px}video{background:#143447}a,span{display:inline-block}</style>
    </head><body>${body}<script>
    window.testStreams = [];
    for (const video of document.querySelectorAll('video')) {
      const canvas = document.createElement('canvas');
      canvas.width = 240; canvas.height = 320;
      const painter = canvas.getContext('2d');
      let tick = 0;
      const draw = () => {
        painter.fillStyle = tick++ % 2 ? '#143447' : '#21475a';
        painter.fillRect(0, 0, 240, 320);
        painter.fillStyle = '#fff'; painter.fillRect(tick % 200, 40, 20, 20);
      };
      draw();
      const stream = canvas.captureStream(12);
      window.testStreams.push(stream);
      video.srcObject = stream;
      void video.play();
      setInterval(draw, 80);
    }
    </script></body></html>`;
}

async function fixture(t, { url = 'https://www.douyin.com/video/111', body = videoMarkup() } = {}) {
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
  t.after(async () => { await context.close(); });
  // 包括外站用例在内，所有请求都在本机拦截，不访问真实抖音或其他站点。
  await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: documentHtml(body) }));
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => [...document.querySelectorAll('video')].every(video => video.readyState >= 2));
  let recorded = 0;
  const memory = { recordVideo() { recorded++; }, close() {} };
  const controller = new BrowserController({ source: 'verification', memory });
  controller.browser = browser;
  controller.page = page;
  return { page, controller, recorded: () => recorded };
}

test('真实合成视频：没有会话时拒绝播放，并直接暂停已有页面',async t=>{
  const {page,controller}=await fixture(t);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-limits-core-'));
  t.after(()=>{controller.cancelLimitsWatch?.();if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir()))throw new Error('测试清理路径越界。');fs.rmSync(directory,{recursive:true,force:true});});
  controller.source='api';controller.limitsEnabled=true;controller.videoLimits=new VideoLimits({stateDir:directory});
  await page.evaluate(()=>{window.name='deepseek-douyin-api';});
  await assert.rejects(controller.execute('douyin_play'),/开始|一轮/);
  assert.equal(await page.locator('video').evaluate(video=>video.paused),true);
});

test('真实合成视频：无人继续调用工具时，后台到期检查仍暂停播放',async t=>{
  const {page,controller}=await fixture(t);let now=Date.now();
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-limits-core-'));
  t.after(()=>{controller.cancelLimitsWatch?.();if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir()))throw new Error('测试清理路径越界。');fs.rmSync(directory,{recursive:true,force:true});});
  controller.source='api';controller.limitsEnabled=true;controller.videoLimits=new VideoLimits({stateDir:directory,now:()=>now});
  controller.limits().savePolicy({windows:['00:00-24:00'],sessionMinutes:1},{explicit:true});controller.limits().markSession('api',{explicit:true});
  await page.evaluate(()=>{window.name='deepseek-douyin-api';});await controller.execute('douyin_play');
  assert.equal(await page.locator('video').evaluate(video=>video.paused),false);now+=61_000;
  await page.waitForFunction(()=>document.querySelector('video').paused,{},{timeout:3500});
  assert.equal(controller.limits().state().allowed,false);
});

test('真实合成媒体：只采集当前HTML视频音轨，结束后不停止原始播放轨道',async t=>{
  const {page,controller}=await fixture(t);
  await page.evaluate(async()=>{
    const video=document.querySelector('video'),context=new AudioContext();await context.resume();
    const oscillator=context.createOscillator(),destination=context.createMediaStreamDestination();oscillator.frequency.value=440;oscillator.connect(destination);oscillator.start();
    window.testAudioContext=context;video.srcObject=new MediaStream([...video.srcObject.getVideoTracks(),...destination.stream.getAudioTracks()]);await video.play();
  });
  const captured=await controller.captureAudio(1);
  assert.equal(captured.videoId,'111');assert.ok(captured.bytes>50);assert.ok(captured.mimeType.startsWith('audio/webm'));
  assert.equal(await page.locator('video').evaluate(video=>video.srcObject.getAudioTracks()[0].readyState),'live');
});

test('合成页面：外站有视频和私密文字时，不读取内容或采集画面', async t => {
  const secret = '合成外站私密标记';
  const { page, controller, recorded } = await fixture(t, { url: 'https://outside.example.test/private', body: videoMarkup('111', secret) });
  let screenshots = 0;
  const realScreenshot = page.screenshot.bind(page);
  page.screenshot = async options => { screenshots++; return realScreenshot(options); };
  const state = await controller.state();
  assert.equal(state.unsupportedPage, true);
  assert.equal(state.visibleText, '');
  assert.equal(state.video, null);
  assert.equal(state.title, null);
  assert.equal(state.url, null);
  assert.equal(JSON.stringify(state).includes(secret), false);
  const capture = await controller.capture(0);
  assert.deepEqual(capture.frames, []);
  assert.equal(screenshots, 0);
  assert.equal(recorded(), 0);
});

test('合成页面：私信区域的视频、作者和文字不进入视频状态或画面', async t => {
  const secret = '合成私信保密标记';
  const { controller } = await fixture(t, { body: `<div data-e2e="im-dialog">${videoMarkup('999', secret)}</div>` });
  const state = await controller.state();
  assert.equal(state.video, null, '私信视频不能当作公开作品');
  assert.equal(JSON.stringify(state).includes(secret), false);
  assert.deepEqual((await controller.capture(0)).frames, []);
});

test('合成页面：截图执行期间出现扫码登录，丢弃实际截图', async t => {
  const { page, controller } = await fixture(t);
  const realScreenshot = page.screenshot.bind(page);
  let screenshots = 0;
  page.screenshot = async options => {
    screenshots++;
    // 在真实截图边界触发页面变化，截图本身仍由 Edge 实际执行。
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.textContent = '手机扫码登录';
      overlay.style.cssText = 'position:fixed;inset:0;background:white;z-index:1000';
      document.body.append(overlay);
    });
    return realScreenshot(options);
  };
  const capture = await controller.capture(0);
  assert.equal(screenshots, 1);
  assert.equal(capture.state.loginRequired, true);
  assert.deepEqual(capture.frames, []);
  assert.match(capture.note, /丢弃/);
});

test('合成页面：两次采样之间换作品，已采集画面保持原作品来源', async t => {
  const { page, controller } = await fixture(t);
  const realState = controller.state.bind(controller);
  let reads = 0;
  controller.state = async options => {
    const state = await realState(options);
    // 第三次读取是首帧截图后的真实 DOM 核验；随后触发真实页面切换。
    if (++reads === 3) await page.evaluate(() => {
      document.querySelector('[data-e2e="player-container"]').className = 'video_222';
      document.querySelector('[data-e2e="video-desc"]').textContent = '合成后续作品';
      history.replaceState(null, '', '/video/222');
    });
    return state;
  };
  const capture = await controller.capture(1);
  assert.equal((await page.evaluate(readPageState)).video.id, '222');
  assert.equal(capture.frames.length, 1);
  assert.equal(capture.state.video.id, '111');
  assert.equal(capture.observation.videoId, '111');
  assert.match(capture.observation.stoppedReason, /切换作品/);
  assert.ok(capture.frames.every(frame => frame.videoId === '111' && typeof frame.time === 'number'));
});

test('合成页面：截图期间换作品，本帧丢弃且不归给新作品', async t => {
  const { page, controller } = await fixture(t);
  const realScreenshot = page.screenshot.bind(page);
  page.screenshot = async options => {
    const image = await realScreenshot(options);
    await page.evaluate(() => {
      document.querySelector('[data-e2e="player-container"]').className = 'video_222';
      history.replaceState(null, '', '/video/222');
    });
    return image;
  };
  const capture = await controller.capture(0);
  assert.deepEqual(capture.frames, []);
  assert.equal(capture.state.video.id, '111');
  assert.equal(capture.observation.videoId, '111');
  assert.match(capture.observation.stoppedReason, /本帧已丢弃/);
});

test('合成页面：预先停止的任务不导航、不记录，也不关闭浏览器', async t => {
  const { page, controller, recorded } = await fixture(t);
  const cancellation = new AbortController();
  const reason = new DOMException('合成测试已停止', 'AbortError');
  cancellation.abort(reason);
  const originalUrl = page.url();
  await assert.rejects(controller.execute('douyin_open', {}, { signal: cancellation.signal }), error => error === reason);
  assert.equal(page.url(), originalUrl);
  assert.equal(recorded(), 0);
  assert.equal(browser.isConnected(), true);
});

test('合成页面：目标作品等待不会把旧的就绪视频当成成功', async t => {
  const { page, controller } = await fixture(t, { url: 'https://www.douyin.com/video/222' });
  assert.equal((await page.evaluate(readPageState)).video.id, '111');
  await page.evaluate(() => { setTimeout(() => {
    document.querySelector('[data-e2e="player-container"]').className = 'video_222';
    document.querySelector('[data-e2e="video-desc"]').textContent = '合成目标作品';
  }, 650); });
  const started = performance.now();
  const state = await controller.settle(undefined, { kind: 'video', videoId: '222' });
  assert.equal(state.video.id, '222');
  assert.ok(performance.now() - started >= 500, '需要等到目标作品真实出现');
});

test('合成页面：搜索预览视频就绪时，仍等待实际搜索卡片', async t => {
  const { page, controller } = await fixture(t, { url: 'https://www.douyin.com/search/synthetic' });
  assert.equal((await page.evaluate(readPageState)).searchResults.length, 0);
  await page.evaluate(() => { setTimeout(() => {
    const card = document.createElement('div');
    card.className = 'search-result-card';
    card.innerHTML = '<a href="/video/333"><span data-e2e="video-desc">合成搜索结果</span></a>';
    document.body.append(card);
  }, 650); });
  const state = await controller.settle(undefined, { kind: 'search' });
  assert.equal(state.searchResults.length, 1);
  assert.equal(state.searchResults[0].id, '333');
});
