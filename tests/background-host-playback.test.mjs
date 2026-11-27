import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { connectDedicatedBrowser } from '../browser-launcher.mjs';
import { browserExecutionMode } from '../browser-mode.mjs';
import { BrowserController, inspectDedicatedVerification } from '../core.mjs';
import { NativeBrowserVerification } from '../native-verification.mjs';
import { ChatBrowser } from '../chat-browser.mjs';
import { VideoLimits } from '../video-limits.mjs';
import { MemoryStore } from '../memory.mjs';
import { WatchMode } from '../watch-mode.mjs';
import { releaseRetiredFeedBuffers } from '../browser-pause.mjs';

test('真实后台宿主：无界面启动后生产采样器取得视频帧，播放时间和解码帧均推进', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dy-background-host-')), controlDir = path.join(root, 'control');
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../browser-host.mjs', import.meta.url)), path.join(root, 'profile'), controlDir, String(port), 'background'], { windowsHide: true, stdio: 'ignore' });
  let browser, controller; const memory = new MemoryStore(path.join(root, 'memory/shared.sqlite'), { qqMemoryPath: null });
  t.after(async () => {
    if (browser?.isConnected()) { const session = await browser.newBrowserCDPSession(); await session.send('Browser.close').catch(() => {}); }
    if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 4000))]);
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    memory.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
  });
  let ready;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = JSON.parse(await fs.readFile(path.join(controlDir, 'browser.json'), 'utf8')); if (ready.ready) break; } catch {}
    if (child.exitCode !== null) throw Error('后台宿主提前退出'); await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready.ready, true); assert.equal(ready.headless, true); assert.equal(ready.mode, 'background');
  browser = await connectDedicatedBrowser(`http://127.0.0.1:${port}`); assert.equal(await browserExecutionMode(browser), 'background');
  const cdp = await browser.newBrowserCDPSession();
  try {
    const result = await cdp.send('Browser.getBrowserCommandLine');
    assert.equal(result.arguments.includes('--mute-audio'), false);
  } finally { await cdp.detach(); }
  const context = browser.contexts()[0], page = context.pages()[0];
  const clip = await fs.readFile(new URL('./fixtures/headless-progress.mp4', import.meta.url));
  const videoId = '7579432563794584933';
  await context.route('**/*', route => route.request().url().endsWith('/fixture.mp4') ? route.fulfill({ contentType: 'video/mp4', body: clip }) : route.fulfill({ contentType: 'text/html', body: `<!doctype html><section data-e2e="feed-active-video"><div data-e2e="player-container" class="video_${videoId}"><video autoplay muted playsinline loop style="width:320px;height:180px" src="/fixture.mp4"></video></div><div data-e2e="video-desc">合成彩条测试</div></section>` }));
  await page.goto(`https://www.douyin.com/video/${videoId}`); await page.evaluate(() => { window.name = 'deepseek-douyin-api'; });
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2 && !document.querySelector('video').paused);
  const limits = new VideoLimits({ stateDir: path.join(root, 'state') });
  controller = new BrowserController({ source: 'verification', memory, videoLimits: limits, controlDirectory: controlDir }); controller.browser = browser; controller.page = page;
  const before = await page.evaluate(() => ({ time: document.querySelector('video').currentTime, frames: document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames }));
  const result = await controller.execute('douyin_observe', { seconds: 3 });
  const after = await page.evaluate(() => ({ time: document.querySelector('video').currentTime, frames: document.querySelector('video').getVideoPlaybackQuality().totalVideoFrames }));
  assert.ok(result.frames.length >= 2); assert.ok(result.frames.every(frame => frame.videoId === videoId && frame.mimeType === 'image/jpeg'));
  assert.ok(after.time > before.time + 1); assert.ok(after.frames > before.frames);
  const mode = new WatchMode({ stateDir: path.join(root, 'state') }); mode.configure({ silent: true }, { explicit: true });
  await page.evaluate(() => { document.querySelector('video').muted = false; });
  const applied = await mode.applyBrowser(browser, { minimize: true }); assert.equal(applied.executionMode, 'background'); assert.equal(applied.background, true); assert.equal(applied.minimized, false);
  assert.equal(await page.locator('video').evaluate(element => element.muted), true);
  mode.configure({ silent: false }, { explicit: true });
  await mode.applyBrowser(browser);
  assert.equal(await page.locator('video').evaluate(element => element.muted), false);
  const inspect = await mode.inspectBrowser(browser); assert.equal(inspect.executionMode, 'background'); assert.deepEqual(inspect.windows, []);

  const inspectOptions = { profile: path.join(root, 'profile'), controlDir, port };
  const verification = new NativeBrowserVerification({ browserProfile: inspectOptions.profile, controlDirectory: controlDir, browserPort: port });
  t.after(() => verification.dispose());
  await page.evaluate(() => {
    const notice = document.createElement('div');
    notice.id = 'captcha_container';
    notice.textContent = '合成验证画面';
    notice.style.cssText = 'position:fixed;left:100px;top:100px;width:320px;height:100px;background:#fff';
    notice.addEventListener('mousedown', event => { notice.dataset.started = String(event.clientX); });
    notice.addEventListener('mouseup', event => {
      if (event.clientX - Number(notice.dataset.started) < 100) return;
      notice.remove();
      const entry = document.createElement('button');
      entry.dataset.e2e = 'im-entry';
      entry.textContent = '消息';
      document.body.append(entry);
    });
    document.body.append(notice);
  });
  const chat = await context.newPage();
  await chat.goto('https://www.douyin.com/user/self');
  await chat.evaluate(() => {
    window.name = 'deepseek-douyin-api-chat';
    document.body.insertAdjacentHTML('beforeend', '<button id="ready-chat" data-e2e="im-entry">消息</button>');
  });
  const challenge = await inspectDedicatedVerification(undefined, inspectOptions);
  assert.equal(challenge.status, 'required');
  assert.equal(challenge.verificationRequired, true);
  assert.equal(challenge.binding.instanceId, ready.instanceId);
  assert.equal((await inspectDedicatedVerification(challenge.binding, inspectOptions)).verificationRequired, true);
  const safeState = await verification.control({ action: 'check' });
  assert.deepEqual(safeState, { status: 'required', mode: 'background', required: true });
  assert.equal(await verification.isWatchReady(), false, '消息页就绪不能解除观看页的验证暂停');
  const opened = await verification.control({ action: 'open' });
  assert.equal(opened.status, 'opened');
  assert.equal('binding' in opened, false);
  assert.equal('targetId' in opened, false);
  const frame = await verification.capture({ session: opened.session });
  assert.equal(frame.status, 'opened');
  assert.equal(Buffer.from(frame.frame.data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const point = (type, x) => ({ type, x: x / viewport.width, y: 125 / viewport.height });
  await assert.rejects(verification.operate({ session: opened.session, view: 'old-view', event: point('press', 125) }), { status: 409 });
  await assert.rejects(verification.operate({ session: opened.session, view: frame.frame.view, event: { type: 'Runtime.evaluate', expression: '1' } }), { status: 400 });
  for (const event of [point('press', 125), point('move', 275), point('release', 275)]) {
    await verification.operate({ session: opened.session, view: frame.frame.view, event });
  }
  await page.locator('#captcha_container').waitFor({ state: 'detached' });
  const finished = await verification.capture({ session: opened.session });
  assert.deepEqual(finished, { status: 'ready', mode: 'background', required: false });
  assert.equal(await verification.isWatchReady(), true);
  await chat.evaluate(() => { window.name = 'deepseek-douyin-dsh'; });
  assert.equal(await verification.isWatchReady(), false, '存在多个可疑观看页时等待进一步核对');
  await chat.evaluate(() => {
    window.name = 'deepseek-douyin-api-chat';
    document.querySelector('#ready-chat').remove();
  });
  await assert.rejects(verification.capture({ session: opened.session }), { status: 409 });
  await page.evaluate(() => {
    const caption = document.createElement('p');
    caption.textContent = '作品介绍：安全验证有什么用';
    document.body.append(caption);
  });
  const checked = await inspectDedicatedVerification(challenge.binding, inspectOptions);
  assert.equal(checked.status, 'ready');
  assert.equal(checked.verificationRequired, false);

  await page.goto('https://www.douyin.com/recommend');
  await page.evaluate(() => {
    window.name = 'deepseek-douyin-api';
    document.body.insertAdjacentHTML('beforeend', `
      <div id="captcha_container">请完成安全验证</div>
      <section class="video_10000000001" data-e2e="feed-video" style="position:fixed;top:-300px">
        <video id="previous" preload="auto" muted src="/fixture.mp4" style="width:160px;height:90px"></video>
      </section>
      <section class="video_10000000002" data-e2e="feed-video" style="position:fixed;top:400px">
        <video id="visible" preload="auto" muted src="/fixture.mp4" style="width:160px;height:90px"></video>
      </section>`);
  });
  await page.waitForFunction(() => ['#previous', '#visible'].every(selector => document.querySelector(selector)?.buffered.length));
  const label = 'deepseek-douyin-api', previousVideoId = '10000000001';
  assert.equal(await page.evaluate(releaseRetiredFeedBuffers, { label: label + '-chat', previousVideoId }), 0);
  assert.equal(await page.evaluate(releaseRetiredFeedBuffers, { label, previousVideoId: '10000000009' }), 0);
  assert.equal(await page.evaluate(releaseRetiredFeedBuffers, { label, previousVideoId }), 1);
  await page.waitForFunction(() => document.querySelector('#previous').buffered.length === 0);
  assert.equal(await page.locator('#previous').getAttribute('src'), '/fixture.mp4');
  assert.equal(await page.locator('#visible').evaluate(element => element.buffered.length > 0), true);
  assert.equal(await page.locator('[data-e2e="feed-active-video"] video').evaluate(element => element.paused), false);
  assert.equal(await page.locator('#captcha_container').textContent(), '请完成安全验证');
  await page.locator('#previous').evaluate(element => element.play());
  await page.waitForFunction(() => document.querySelector('#previous').currentTime > 0);

  let allowed = true;
  const completedWatch = new BrowserController({
    source: 'api', controlDirectory: controlDir, browserProfile: path.join(root, 'profile'), browserPort: port,
    videoLimits: { stateDir: path.join(root, 'state'), state: () => ({ allowed }) },
  });
  await page.evaluate(() => document.querySelectorAll('video').forEach(video => video.pause()));
  await completedWatch.releaseFinishedWatchMedia({ failedFeed: true });
  assert.match(page.url(), /\/recommend$/);
  assert.equal(await page.locator('#captcha_container').count(), 1);
  await page.evaluate(() => {
    document.querySelector('#captcha_container').remove();
    document.body.insertAdjacentHTML('beforeend', '<textarea>合成草稿</textarea>');
  });
  await completedWatch.releaseFinishedWatchMedia({ failedFeed: true });
  assert.match(page.url(), /\/recommend$/);
  await page.locator('textarea').evaluate(element => element.remove());
  await completedWatch.releaseFinishedWatchMedia();
  assert.match(page.url(), /\/recommend$/);
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend','<section role="dialog">测试中的对话框</section>'));
  await completedWatch.releaseFinishedWatchMedia({ failedFeed: true });
  assert.match(page.url(), /\/recommend$/);
  await page.locator('[role="dialog"]').evaluate(element => { element.hidden = true; });
  await completedWatch.releaseFinishedWatchMedia({ failedFeed: true });
  await page.waitForURL('about:blank');
  assert.equal(await page.evaluate(() => window.name), label);
  const chatAdapter = new ChatBrowser({ controller: { connectExistingBrowser: async () => browser, executionMode: async () => 'background' } });
  await chatAdapter.assertAutomaticPrepareSafe(undefined, async () => {}, false);
  assert.match(chat.url(), /\/user\/self$/);
  await chat.evaluate(() => {
    const entry = document.createElement('button');
    entry.dataset.e2e = 'im-entry';
    entry.textContent = '消息';
    entry.addEventListener('click', () => {
      document.body.insertAdjacentHTML('beforeend', '<section data-e2e="im-dialog">测试消息列表</section>');
    });
    document.body.prepend(entry);
  });
  await chatAdapter.ensureChatPage(chat, undefined);
  assert.match(chat.url(), /\/user\/self$/);
  assert.equal(await chat.locator('[data-e2e="im-dialog"]').isVisible(), true);

  await page.goto('https://www.douyin.com/recommend?modal_id=10000000001');
  await page.evaluate(() => document.querySelector('video').pause());
  await completedWatch.releaseFinishedWatchMedia({ failedFeed: true });
  assert.match(page.url(), /modal_id=/);
  await page.goto('https://www.douyin.com/recommend');
  await page.evaluate(() => document.querySelector('video').pause());
  await completedWatch.releaseFinishedWatchMedia({ allowUnload: true });
  assert.match(page.url(), /\/recommend$/);
  allowed = false;
  await completedWatch.releaseFinishedWatchMedia({ allowUnload: true });
  await page.waitForURL('about:blank');
  assert.match(chat.url(), /\/user\/self$/);
});
