import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { BrowserController, readPageState } from '../core.mjs';
import { chromium } from '../playwright-runtime.mjs';

const VIDEO_ID = '7579432563794584933';
const state = (ready = false, extra = {}) => ({
  url: 'https://www.douyin.com/?recommend=1',
  loginRequired: false, verificationRequired: false,
  searchResults: [], visibleText: '',
  video: ready ? { id: VIDEO_ID, readyState: 4, paused: false } : null,
  ...extra,
});

// 受控时钟只推进本机定时器；页面状态是替身，不代表抖音实际加载时间。
function controlled(t, reader) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  let reads = 0, inputs = 0;
  const forbiddenInput = () => { inputs++; throw new Error('就绪探针不得发送输入或导航。'); };
  const controller = Object.create(BrowserController.prototype);
  controller.page = {
    evaluate: async fn => {
      assert.equal(fn, readPageState);
      return structuredClone(await reader({ now: Date.now(), reads: ++reads }));
    },
    goto: forbiddenInput,
    locator: forbiddenInput,
    keyboard: { press: forbiddenInput },
    mouse: { click: forbiddenInput, wheel: forbiddenInput },
  };
  return { controller, reads: () => reads, inputs: () => inputs };
}

function track(promise) {
  const output = { settled: false };
  output.completion = promise.then(
    value => { output.settled = true; return { value }; },
    error => { output.settled = true; return { error }; },
  );
  return output;
}

async function advance(t, ms) {
  await nextTurn();
  for (let elapsed = 0; elapsed < ms; elapsed += 500) {
    t.mock.timers.tick(Math.min(500, ms - elapsed));
    await nextTurn();
  }
}

for (const readyAt of [9_000, 17_000, 29_500, 30_000]) {
  test(`合成时钟：第 ${readyAt / 1000} 秒就绪立即成功，不继续耗尽等待或输入`, async t => {
    const f = controlled(t, ({ now }) => state(now >= readyAt));
    const task = track(f.controller.settle());
    await advance(t, readyAt - 500);
    assert.equal(task.settled, false);
    await advance(t, 500);
    const result = await task.completion;
    assert.ifError(result.error);
    assert.equal(result.value.video.id, VIDEO_ID);
    assert.equal(Date.now(), readyAt);
    assert.equal(f.reads(), readyAt / 500 + 1);
    const count = f.reads();
    await advance(t, 2_000);
    assert.equal(f.reads(), count);
    assert.equal(f.inputs(), 0);
  });
}

test('合成时钟：30秒预算耗尽时最后核对一次并失败，不多等或导航', async t => {
  const f = controlled(t, () => state());
  const task = track(f.controller.settle());
  await advance(t, 29_500);
  assert.equal(task.settled, false);
  await advance(t, 500);
  const result = await task.completion;
  assert.match(result.error?.message || '', /推荐流尚未读到就绪视频/);
  assert.equal(Date.now(), 30_000);
  assert.equal(f.reads(), 61);
  await advance(t, 5_000);
  assert.equal(f.reads(), 61);
  assert.equal(f.inputs(), 0);
});

test('合成时钟：等待期间取消立即结束，后续时钟推进不再读取或输入', async t => {
  const f = controlled(t, () => state()), cancellation = new AbortController();
  const reason = new Error('合成用户取消冷启动。');
  const task = track(f.controller.settle(cancellation.signal));
  await nextTurn();
  assert.equal(f.reads(), 1);
  cancellation.abort(reason);
  const result = await task.completion;
  assert.equal(result.error?.name, 'AbortError');
  assert.equal(result.error?.cause, reason);
  assert.equal(Date.now(), 0);
  await advance(t, 5_000);
  assert.equal(f.reads(), 1);
  assert.equal(f.inputs(), 0);
});

test('合成时钟：进入探针前已取消，不读取页面或输入', async t => {
  const f = controlled(t, () => state(true)), cancellation = new AbortController();
  const reason = new Error('合成预先取消。');
  cancellation.abort(reason);
  await assert.rejects(f.controller.settle(cancellation.signal), error => error === reason);
  assert.equal(f.reads(), 0);
  assert.equal(f.inputs(), 0);
});

test('合成时钟：状态读取期间取消，即使这次返回就绪也不能报成功', async t => {
  const cancellation = new AbortController(), reason = new Error('合成读取期间取消。');
  const f = controlled(t, () => { cancellation.abort(reason); return state(true); });
  await assert.rejects(f.controller.settle(cancellation.signal), error => error === reason);
  assert.equal(f.reads(), 1);
  assert.equal(f.inputs(), 0);
});

for (const protectedState of ['loginRequired', 'verificationRequired']) {
  for (const appearsAt of [0, 9_000]) {
    test(`合成时钟：${protectedState} 在第 ${appearsAt / 1000} 秒出现时返回阻断，不盲等或继续调用`, async t => {
      const f = controlled(t, ({ now }) => state(false, { [protectedState]: now >= appearsAt }));
      const task = track(f.controller.settle());
      await advance(t, appearsAt);
      const result = await task.completion;
      assert.ifError(result.error);
      assert.equal(result.value[protectedState], true);
      assert.equal(Date.now(), appearsAt);
      const count = f.reads();
      await advance(t, 30_000);
      assert.equal(f.reads(), count);
      assert.equal(f.inputs(), 0);
    });
  }
}

test('隔离Edge合成DOM：实际延迟9秒挂载视频，探针等到媒体就绪后提前返回', { timeout: 25_000 }, async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(async () => { await browser.close(); });
  const context = await browser.newContext({ viewport: { width: 900, height: 800 }, serviceWorkers: 'block' });
  const url = 'https://www.douyin.com/?recommend=1&synthetic-settle=1';
  let navigations = 0;
  await context.route('**/*', route => {
    if (route.request().isNavigationRequest() && route.request().url() === url) {
      navigations++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><meta charset="utf-8"><title>冷启动合成页面</title><body style="margin:0"></body></html>' });
    }
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.evaluate(id => {
    window.syntheticInputs = 0;
    for (const type of ['pointerdown', 'click', 'keydown', 'wheel']) document.addEventListener(type, () => window.syntheticInputs++);
    window.syntheticStart = performance.now();
    setTimeout(() => {
      const section = document.createElement('section');
      section.setAttribute('data-e2e', 'feed-active-video');
      section.innerHTML = `<div data-e2e="player-container" class="video_${id}"><video muted autoplay playsinline style="width:240px;height:320px"></video></div><div data-e2e="video-desc">第九秒挂载的合成作品</div>`;
      document.body.append(section);
      const canvas = document.createElement('canvas');
      canvas.width = 240; canvas.height = 320;
      const painter = canvas.getContext('2d');
      const draw = () => { painter.fillStyle = '#143447'; painter.fillRect(0, 0, 240, 320); };
      draw();
      window.syntheticStream = canvas.captureStream(12);
      const video = section.querySelector('video');
      video.srcObject = window.syntheticStream;
      void video.play();
      window.syntheticDraw = setInterval(draw, 80);
    }, 9_000);
  }, VIDEO_ID);
  assert.equal((await page.evaluate(readPageState)).video, null);
  const controller = Object.create(BrowserController.prototype);
  controller.page = page;
  const started = performance.now();
  const result = await controller.settle();
  const elapsedMs = performance.now() - started;
  const pageTiming = await page.evaluate(() => ({ elapsedMs: performance.now() - window.syntheticStart, inputs: window.syntheticInputs }));
  assert.equal(result.video.id, VIDEO_ID);
  assert.ok(result.video.readyState >= 2);
  assert.ok(pageTiming.elapsedMs >= 9_000);
  assert.ok(elapsedMs < 20_000, `就绪后仍额外等候：${elapsedMs}ms`);
  assert.equal(navigations, 1);
  assert.equal(pageTiming.inputs, 0);
  t.diagnostic(JSON.stringify({ elapsedMs: Math.round(elapsedMs), pageElapsedMs: Math.round(pageTiming.elapsedMs), readyState: result.video.readyState, navigations, inputs: pageTiming.inputs, realAccountUsed: false, realNetworkUsed: false }));
});
