import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../playwright-runtime.mjs';
import { BrowserController, readPageState } from '../core.mjs';

// 使用独立 Edge 与全部本机拦截的合成页面，不连接登录资料或真实抖音。
let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
const ID = '7579432563794584933';
const liveCard = (room = '12345678', video = true) => `<section data-e2e="feed-active-video" style="width:360px;height:440px">${video ? '<video style="width:320px;height:360px"></video>' : ''}<a href="https://live.douyin.com/${room}">点击进入直播间</a></section>`;
async function fixture(t, { body = liveCard(), url = 'https://www.douyin.com/?recommend=1' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  t.after(async () => { await context.close(); });
  await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><style>body{margin:0}a{display:block;height:30px}</style>${body}` }));
  const page = await context.newPage(); await page.goto(url);
  const controller = new BrowserController({ source: 'verification', memory: { recordVideo() {}, close() {} } });
  controller.page = page;
  return { page, controller };
}

test('当前推荐卡片具有唯一直播房间链接时识别预览，没有视频元素也可确认卡片', async t => {
  for (const video of [true, false]) {
    const f = await fixture(t, { body: liveCard('12345678', video) });
    const state = await f.page.evaluate(readPageState);
    assert.equal(state.pageKind, 'live-preview');
    assert.equal(state.livePreview.recognized, true);
    assert.equal(state.livePreview.roomId, '12345678');
    assert.equal(state.video?.id ?? null, null);
    assert.ok(state.livePreview.viewport.width > 0);
    const observed = await f.controller.capture(0);
    assert.deepEqual(observed.frames, []);
    assert.match(observed.note, /不采集直播/);
  }
});
test('推荐入口重定向精选页后仍可核对唯一直播卡，不把普通直播文案当房间证据', async t => {
  for (const route of ['/jingxuan', '/jingxuan/']) {
    const f = await fixture(t, { url: 'https://www.douyin.com' + route });
    assert.equal((await f.page.evaluate(readPageState)).livePreview?.roomId, '12345678');
  }
});
test('直播卡片本身是房间链接时仍识别，实际输入门禁采用同一房间证据', async t => {
  const f = await fixture(t, { body: '<a data-e2e="feed-live-card" href="https://live.douyin.com/12345678" style="width:360px;height:440px">进入直播</a><button data-e2e="video-switch-next-arrow">下一条</button>' });
  assert.equal((await f.page.evaluate(readPageState)).livePreview?.roomId, '12345678');
  await f.page.evaluate(id => document.querySelector('button').addEventListener('click', () => {
    const root = document.querySelector('a'); root.removeAttribute('href'); root.innerHTML = `<div data-e2e="player-container" class="video_${id}"><video style="width:320px;height:360px"></video></div>`;
    const canvas = document.createElement('canvas'), video = root.querySelector('video'); canvas.width = 320; canvas.height = 360; video.srcObject = canvas.captureStream(5); video.muted = true; void video.play();
    setInterval(() => canvas.getContext('2d').fillRect(0, 0, 320, 360), 100);
  }), ID);
  const result = await f.controller.switchVideo(1); assert.equal(result.changed, true); assert.equal(result.state.video.id, ID);
});

test('直播文案、侧栏直播入口、非推荐页、私信和验证码不触发自动直播标记', async t => {
  for (const variant of [
    { body: '<section data-e2e="feed-active-video" style="height:400px">直播中，点击进入直播间</section>' },
    { body: '<section data-e2e="feed-active-video" style="height:400px"><video style="width:320px;height:360px"></video></section><aside><a href="https://live.douyin.com/12345678">直播入口</a></aside>' },
    { url: `https://www.douyin.com/video/${ID}` },
    { url: 'https://live.douyin.com/12345678' },
    { body: `${liveCard()}<div data-e2e="im-dialog" style="width:100px;height:100px">私信</div>` },
    { body: `${liveCard()}<div>请完成下方验证</div>` },
    { body: liveCard().replace('</section>', '<a href="https://live.douyin.com/87654321">另一直播入口</a></section>') },
  ]) {
    const f = await fixture(t, variant), state = await f.page.evaluate(readPageState);
    assert.notEqual(state.livePreview?.recognized, true);
  }
});

test('真实作品标题和链接中含直播信息时仍是作品，不伪判直播', async t => {
  const body = `<section data-e2e="feed-active-video"><div data-e2e="player-container" class="video_${ID}"><video style="width:320px;height:360px"></video></div><div data-e2e="video-desc">直播片段回放</div><a href="https://live.douyin.com/12345678">作者直播</a></section>`;
  const f = await fixture(t, { body }), state = await f.page.evaluate(readPageState);
  assert.equal(state.pageKind, 'video');
  assert.equal(state.video.id, ID);
  assert.equal(state.livePreview, null);
});

test('当前直播卡没有跳转链接时，可按明确直播状态和房间标识识别并换片',async t=>{
  const f=await fixture(t,{body:'<section data-e2e="feed-live-card" data-live-status="live" data-room-id="12345678" style="width:360px;height:440px">合成直播预览</section><button data-e2e="video-switch-next-arrow">下一条</button>'});
  const state=await f.page.evaluate(readPageState);assert.equal(state.livePreview.source,'active-feed-live-room');assert.equal(state.livePreview.roomId,'12345678');
  await f.page.evaluate(id=>{window.inputs=0;document.querySelector('button').addEventListener('click',()=>{window.inputs++;const root=document.querySelector('section');root.removeAttribute('data-live-status');root.removeAttribute('data-room-id');root.setAttribute('data-e2e','feed-active-video');root.className='video_'+id;root.innerHTML='<video style="width:320px;height:360px"></video>';const canvas=document.createElement('canvas'),video=root.querySelector('video');canvas.width=320;canvas.height=360;video.srcObject=canvas.captureStream(5);video.muted=true;void video.play();setInterval(()=>canvas.getContext('2d').fillRect(0,0,320,360),100);});},ID);
  const switched=await f.controller.switchVideo(1);assert.equal(switched.changed,true);assert.equal(switched.state.video.id,ID);assert.equal(await f.page.evaluate(()=>window.inputs),1);
});

test('只有直播文字或未核实状态的房间属性，仍不当作已识别直播',async t=>{
  for(const attrs of ['data-room-id="12345678"','data-live-status="live" data-room-id="not-a-room"','data-live-status="ended" data-room-id="12345678"']){const f=await fixture(t,{body:`<section data-e2e="feed-live-card" ${attrs} style="width:360px;height:440px">直播中</section>`});assert.equal((await f.page.evaluate(readPageState)).livePreview,null);}
});

test('从已核实直播预览换片后确认新的真实作品，无法确认时不声称切换成功', async t => {
  const f = await fixture(t, { body: `${liveCard('12345678', false)}<button data-e2e="video-switch-next-arrow">下一条</button>` });
  await f.page.evaluate(id => {
    document.querySelector('button').addEventListener('click', () => {
      const root = document.querySelector('section');
      root.innerHTML = `<div data-e2e="player-container" class="video_${id}"><video style="width:320px;height:360px"></video></div>`;
      const video = root.querySelector('video'), canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 360;
      video.srcObject = canvas.captureStream(5); video.muted = true; void video.play();
      setInterval(() => { canvas.getContext('2d').fillRect(0,0,320,360); }, 100);
    });
  }, ID);
  const result = await f.controller.switchVideo(1);
  assert.equal(result.changed, true);
  assert.equal(result.beforePageKind, 'live-preview');
  assert.equal(result.state.video.id, ID);
  assert.ok(result.state.video.readyState >= 2);
});
