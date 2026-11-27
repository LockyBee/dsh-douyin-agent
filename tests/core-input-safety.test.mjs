import test,{before,after}from'node:test';
import assert from'node:assert/strict';
import{chromium}from'../playwright-runtime.mjs';
import{BrowserController,readPageState}from'../core.mjs';
import{ChatBrowser,readChatBlockers}from'../chat-browser.mjs';
let browser;before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true})});after(()=>browser?.close());
const A='7579432563794584933',B='7579432563794584934',C='7579432563794584935';
async function pageFixture(t){
 const context=await browser.newContext({viewport:{width:900,height:700}});t.after(()=>context.close());
 await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><style>body{margin:0}video{width:240px;height:320px}button{position:absolute;top:100px;left:400px;width:70px;height:40px}@keyframes move{from{transform:translateX(0)}to{transform:translateX(80px)}}</style><section data-e2e="feed-active-video" class="video_${A}"><video muted autoplay playsinline></video></section><button data-e2e="video-switch-next-arrow">下一条</button>`}));
 const page=await context.newPage();await page.goto('https://www.douyin.com/');
 await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=240;canvas.height=320;document.querySelector('video').srcObject=canvas.captureStream(20);setInterval(()=>canvas.getContext('2d').fillRect(0,0,240,320),50)});
 await page.waitForFunction(()=>document.querySelector('video').readyState>=2);return page;
}
test('最终核对后等待控件稳定期间A变B，严格返回stale且不产生可信输入',async t=>{
 const page=await pageFixture(t),controller=new BrowserController({source:'verification',memory:{recordVideo(){},close(){}}});controller.page=page;
 await page.evaluate(({B,C})=>{window.activeId=document.querySelector('section').className.slice(6);window.clickedFrom=[];document.querySelector('button').addEventListener('click',()=>{window.clickedFrom.push(window.activeId);window.activeId=C;document.querySelector('section').className=`video_${C}`})},{B,C});
 const read=controller.state.bind(controller);let reads=0;
 controller.state=async options=>{const value=await read(options);if(++reads===3)await page.evaluate(B=>{const button=document.querySelector('button');button.style.animation='move 0.2s linear infinite';setTimeout(()=>{window.activeId=B;document.querySelector('section').className=`video_${B}`},40);setTimeout(()=>button.style.animation='none',650)},B);return value;};
 const result=await controller.switchVideo(1,undefined,{recordLearning:false,expectedVideoId:A});
 const clickedFrom=await page.evaluate(()=>window.clickedFrom);assert.deepEqual(clickedFrom,[]);assert.equal(result.changed,false);assert.equal(result.before.id,B);assert.equal(result.after.id,B);assert.equal(result.staleObservation,true);assert.equal(result.reasonCode,'observed-video-changed');assert.equal(result.expectedVideoId,A);
 console.log(JSON.stringify({verified:'expected-id-held-during-geometry-wait',expected:A,clickedFrom,after:result.after.id,inputCount:clickedFrom.length}));
});
test('无文字验证码与聊天检测一致，并阻止视频截图和换片',async t=>{
 const page=await pageFixture(t);await page.evaluate(()=>{const layer=document.createElement('div');layer.id='captcha_container';layer.style.cssText='position:fixed;inset:0;z-index:999999;background:white';document.body.append(layer)});
 const state=await page.evaluate(readPageState),chatBlockers=await page.evaluate(readChatBlockers),blocked=await page.evaluate(()=>Boolean(document.elementFromPoint(435,120)?.closest('#captcha_container')));
 assert.equal(state.verificationRequired,true);assert.equal(chatBlockers.verificationRequired,true);assert.equal(blocked,true);assert.equal(state.video.id,A);
 const controller=new BrowserController({source:'verification',memory:{recordVideo(){},close(){}}});controller.page=page;page.screenshot=async()=>{throw new Error('验证码不应进入截图');};const capture=await controller.capture(0);assert.deepEqual(capture.frames,[]);const result=await controller.switchVideo(1,undefined,{recordLearning:false,expectedVideoId:A});assert.equal(result.changed,false);assert.equal(result.reasonCode,'switch-blocked');
 console.log(JSON.stringify({verified:'nontext-captcha-blocks-video-observation',coreVerificationRequired:state.verificationRequired,chatVerificationRequired:chatBlockers.verificationRequired,actualPointerBlocked:blocked}));
});

test('验证码中间页没有正文时，观看与聊天都识别为待验证', async t => {
  const page = await pageFixture(t);
  await page.setContent('<title>验证码中间页</title><main></main>');
  assert.equal((await page.evaluate(readPageState)).verificationRequired, true);
  const chat = new ChatBrowser();
  const flags = await chat.dialog(page, AbortSignal.timeout(2000), { open: true });
  assert.deepEqual(flags, { blocked: true, loginRequired: false, verificationRequired: true });
  await page.setContent('<title>抖音</title><button data-e2e="im-entry">消息</button><section data-e2e="im-dialog" hidden>合成会话</section>');
  await page.locator('[data-e2e="im-entry"]').evaluate(entry => {
    entry.onclick = () => { document.querySelector('[data-e2e="im-dialog"]').hidden = false; };
  });
  assert.deepEqual(await chat.dialog(page, AbortSignal.timeout(3000), { open: true }), {
    blocked: false, loginRequired: false, verificationRequired: false,
  });
});

test('等待消息入口时转到验证中间页，返回验证状态且保持零点击', async t => {
  const page = await pageFixture(t);
  const locator = page.locator.bind(page);
  let clicks = 0;
  page.locator = selector => selector === '[data-e2e="im-entry"]' ? {
    waitFor: async () => {
      await page.setContent('<title>验证码中间页</title><main></main>');
      throw new Error('合成消息入口超时');
    },
    click: async () => { clicks++; },
  } : locator(selector);
  assert.deepEqual(await new ChatBrowser().dialog(page, AbortSignal.timeout(3000), { open: true }), {
    blocked: true, loginRequired: false, verificationRequired: true,
  });
  assert.equal(clicks, 0);
});

test('控件稳定后只有一次可信mouse输入，低RAF等待不调用locator.click',async t=>{
 const page=await pageFixture(t),controller=new BrowserController({source:'verification',memory:{recordVideo(){},close(){}}});controller.page=page;
 await page.evaluate(C=>{window.trustedInputs=[];document.querySelector('button').addEventListener('click',event=>{window.trustedInputs.push(event.isTrusted);document.querySelector('section').className=`video_${C}`})},C);
 const locator=page.locator.bind(page);page.locator=selector=>{const value=locator(selector);if(selector.includes('video-switch-')){const first=value.first.bind(value);value.filter=()=>value;value.first=()=>{const button=first();button.click=()=>{throw new Error('换片不应等待locator.click的RAF');};return button;};}return value;};
 const result=await controller.switchVideo(1,undefined,{recordLearning:false,expectedVideoId:A});assert.equal(result.changed,true);assert.equal(result.before.id,A);assert.equal(result.after.id,C);assert.deepEqual(await page.evaluate(()=>window.trustedInputs),[true]);assert.equal(await page.locator('[data-deepseek-switch-token]').count(),0);
});

test('等待几何稳定期间出现无文字验证层则中止，未发出换片输入',async t=>{
 const page=await pageFixture(t),controller=new BrowserController({source:'verification',memory:{recordVideo(){},close(){}}});controller.page=page;
 await page.evaluate(()=>{window.inputs=0;document.querySelector('button').addEventListener('click',()=>window.inputs++);document.querySelector('button').style.animation='move 0.2s linear infinite';});
 const read=controller.state.bind(controller);let reads=0;controller.state=async options=>{const value=await read(options);if(++reads===3)await page.evaluate(()=>setTimeout(()=>{const layer=document.createElement('div');layer.id='captcha_container';layer.style.cssText='position:fixed;inset:0;z-index:999999;background:white';document.body.append(layer)},40));return value;};
 const result=await controller.switchVideo(1,undefined,{recordLearning:false,expectedVideoId:A});assert.equal(result.changed,false);assert.equal(result.reasonCode,'switch-blocked');assert.equal(await page.evaluate(()=>window.inputs),0);
});

test('最终宿主回读后到可信输入到达前A变B，同步门禁阻止控件处理且返回stale',async t=>{
 const page=await pageFixture(t),controller=new BrowserController({source:'verification',memory:{recordVideo(){},close(){}}});controller.page=page;
 await page.evaluate(C=>{window.inputs=[];document.querySelector('button').addEventListener('click',event=>{window.inputs.push(event.isTrusted);document.querySelector('section').className=`video_${C}`})},C);
 const click=page.mouse.click.bind(page.mouse);page.mouse.click=async(...args)=>{await page.evaluate(B=>document.querySelector('section').className=`video_${B}`,B);return click(...args);};
 const result=await controller.switchVideo(1,undefined,{recordLearning:false,expectedVideoId:A});assert.equal(result.changed,false);assert.equal(result.staleObservation,true);assert.equal(result.reasonCode,'observed-video-changed');assert.equal(result.expectedVideoId,A);assert.equal(result.state.video.id,B);assert.deepEqual(await page.evaluate(()=>window.inputs),[]);assert.equal(await page.locator('[data-deepseek-switch-token]').count(),0);
});

test('最终回读后可信输入到达前出现验证码，事件门禁不点击验证层或视频',async t=>{
 const page=await pageFixture(t),controller=new BrowserController({source:'verification',memory:{recordVideo(){},close(){}}});controller.page=page;
 await page.evaluate(()=>{window.inputs=0;document.addEventListener('click',()=>window.inputs++);});
 const click=page.mouse.click.bind(page.mouse);page.mouse.click=async(...args)=>{await page.evaluate(()=>{const layer=document.createElement('div');layer.id='captcha_container';layer.style.cssText='position:fixed;inset:0;z-index:999999;background:white';document.body.append(layer)});return click(...args);};
 const result=await controller.switchVideo(1,undefined,{recordLearning:false,expectedVideoId:A});assert.equal(result.changed,false);assert.equal(result.reasonCode,'switch-blocked');assert.equal(result.state.verificationRequired,true);assert.equal(await page.evaluate(()=>window.inputs),0);
});

test('可信输入延迟超过短临界段时保持阻断，不在门禁超时后放行过期作品',async t=>{
 const page=await pageFixture(t),controller=new BrowserController({source:'verification',memory:{recordVideo(){},close(){}}});controller.page=page;
 await page.evaluate(()=>{window.inputs=0;document.querySelector('button').addEventListener('click',()=>window.inputs++);});
 const click=page.mouse.click.bind(page.mouse);page.mouse.click=async(...args)=>{await page.waitForTimeout(1650);await page.evaluate(B=>document.querySelector('section').className=`video_${B}`,B);return click(...args);};
 const result=await controller.switchVideo(1,undefined,{recordLearning:false,expectedVideoId:A});assert.equal(result.changed,false);assert.equal(result.staleObservation,true);assert.equal(result.state.video.id,B);assert.equal(await page.evaluate(()=>window.inputs),0);assert.equal(await page.locator('[data-deepseek-switch-token]').count(),0);
});

test('几何等待中预算失效或主动取消均无可信输入',async t=>{
 for(const mode of ['budget','abort']){
  const page=await pageFixture(t),controller=new BrowserController({source:'verification',memory:{recordVideo(){},close(){}}});controller.page=page;
  await page.evaluate(()=>{window.inputs=0;document.querySelector('button').addEventListener('click',()=>window.inputs++);document.querySelector('button').style.animation='move 0.2s linear infinite';});
  const abort=new AbortController();let checks=0;controller.checkVideoLimits=async()=>{if(++checks===3){if(mode==='budget')throw new Error('合成每日预算已用完');abort.abort(new Error('合成主动取消'));}};
  await assert.rejects(controller.switchVideo(1,abort.signal,{recordLearning:false,expectedVideoId:A}),mode==='budget'?/预算/:/取消/);assert.equal(await page.evaluate(()=>window.inputs),0);assert.equal(await page.locator('[data-deepseek-switch-token]').count(),0);
 }
});

test('无箭头时滚轮只在原作品几何与中心命中核实后输入一次',async t=>{
 const page=await pageFixture(t),controller=new BrowserController({source:'verification',memory:{recordVideo(){},close(){}}});controller.page=page;
 await page.evaluate(C=>{document.querySelector('button').remove();window.wheels=[];document.addEventListener('wheel',event=>{window.wheels.push({trusted:event.isTrusted,deltaY:event.deltaY});document.querySelector('section').className=`video_${C}`},{passive:true})},C);
 const result=await controller.switchVideo(1,undefined,{recordLearning:false,expectedVideoId:A});assert.equal(result.changed,true);assert.deepEqual(await page.evaluate(()=>window.wheels),[{trusted:true,deltaY:700}]);
});

test('推荐流箭头不可用且播放器中心被遮挡时，只滚动一次命中已核对作品的位置', async t => {
  const page = await pageFixture(t);
  const controller = new BrowserController({ source: 'verification', memory: { recordVideo() {}, close() {} } });
  controller.page = page;
  await page.evaluate(C => {
    const button = document.querySelector('button');
    button.disabled = true;
    const layer = document.createElement('div');
    layer.style.cssText = 'position:absolute;left:100px;top:140px;width:40px;height:40px;z-index:10';
    document.body.append(layer);
    window.switches = [];
    document.addEventListener('click', () => window.switches.push('click'));
    document.addEventListener('wheel', event => {
      window.switches.push(event.isTrusted && Boolean(event.target.closest('[data-e2e="feed-active-video"]')) ? 'wheel' : 'outside');
      document.querySelector('section').className = 'video_' + C;
    });
  }, C);
  const result = await controller.switchVideo(1, undefined, { recordLearning: false, expectedVideoId: A });
  assert.equal(result.changed, true);
  assert.equal(result.after.id, C);
  assert.deepEqual(await page.evaluate(() => window.switches), ['wheel']);
  assert.equal(await page.locator('[data-deepseek-switch-token]').count(), 0);
});
