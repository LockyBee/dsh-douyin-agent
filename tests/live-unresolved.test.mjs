import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../playwright-runtime.mjs';
import { BrowserController, readPageState } from '../core.mjs';

// 复用真实无头 Edge 和 canvas 媒体；网络全部由合成页面接管。
let browser;
const ID='7579432563794584933';
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});
async function fixture(t,{arrow=true,kind='live'}={}){
  const context=await browser.newContext({viewport:{width:1000,height:800}});t.after(()=>context.close());
  await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8"><style>body{margin:0}section{width:360px;height:500px}video{display:block;width:320px;height:420px}button{position:absolute;left:500px;top:200px;width:80px;height:60px}</style><section data-e2e="${kind==='text'?'feed-active-video':'feed-live-card'}"><video muted autoplay></video><span>直播中</span></section>${arrow?'<button data-e2e="video-switch-next-arrow">下一条</button>':''}`}));
  const page=await context.newPage();await page.goto('https://www.douyin.com/jingxuan');
  await page.evaluate(({ID,kind,arrow})=>{
    window.inputs=0;window.startMedia=()=>{const video=document.querySelector('video'),canvas=document.createElement('canvas');canvas.width=320;canvas.height=420;video.srcObject=canvas.captureStream(12);void video.play();setInterval(()=>canvas.getContext('2d').fillRect(0,0,320,420),60);};
    if(kind==='video'){document.querySelector('section').className='video_'+ID;document.querySelector('section').setAttribute('data-e2e','feed-active-video');document.querySelector('section').insertAdjacentHTML('beforeend','<span data-e2e="live-avatar">作者直播</span>');}
    window.startMedia();document.addEventListener(arrow?'click':'wheel',event=>{if(!event.isTrusted)return;window.inputs++;if(window.transition)return window.transition();const root=document.querySelector('section');root.setAttribute('data-e2e','feed-active-video');root.className='video_'+ID;root.querySelector('span').remove();});
  },{ID,kind,arrow});
  await page.waitForFunction(()=>document.querySelector('video').readyState>=2);
  const controller=new BrowserController({source:'verification',memory:{recordVideo(){}}});controller.page=page;
  return{page,controller,state:()=>page.evaluate(readPageState),inputs:()=>page.evaluate(()=>window.inputs)};
}
for(const arrow of [true,false])test(`无房间地址的明确直播样式卡以${arrow?'按钮':'滚轮'}跳过，仅一次真实输入`,async t=>{
  const f=await fixture(t,{arrow}),s=await f.state();assert.equal(s.pageKind,'live-preview');assert.equal(s.livePreview.roomId,null);assert.match(s.livePreview.previewKey,/^[a-f0-9]{16}$/);
  await f.page.evaluate(()=>{window.requestAnimationFrame=()=>0;});
  const result=await f.controller.switchVideo(1,undefined,{expectedLivePreviewKey:s.livePreview.previewKey,recordLearning:false});assert.equal(result.changed,true,JSON.stringify(result));assert.equal(result.state.video.id,ID);assert.equal(await f.inputs(),1);
  assert.equal(await f.page.evaluate(()=>Object.keys(window.__deepseekVideoSwitchInputs??{}).length),0);
});
test('普通作品的直播头像、只有文案的播放器不冒充无地址直播卡',async t=>{
  for(const kind of ['video','text']){const f=await fixture(t,{kind});assert.equal((await f.state()).livePreview,null);}
});
test('过期预览标识及已有作品观察不驱动当前无地址直播卡',async t=>{
  const f=await fixture(t);for(const controls of [{expectedLivePreviewKey:'0000000000000000'},{expectedVideoId:ID}]){const r=await f.controller.switchVideo(1,undefined,controls);assert.equal(r.staleObservation,true);assert.equal(await f.inputs(),0);}
});
for(const mode of ['media','captcha','private'])test(`最终同步守卫阻止无地址卡竞态：${mode}`,async t=>{
  const f=await fixture(t),s=await f.state(),click=f.page.mouse.click.bind(f.page.mouse);
  f.page.mouse.click=async(...args)=>{await f.page.evaluate(mode=>{if(mode==='media')window.startMedia();else document.body.insertAdjacentHTML('beforeend',mode==='captcha'?'<div id="captcha_container" style="position:fixed;inset:0">请完成验证</div>':'<div data-e2e="im-dialog" style="position:fixed;inset:0">私信</div>');},mode);return click(...args);};
  const result=await f.controller.switchVideo(1,undefined,{expectedLivePreviewKey:s.livePreview.previewKey});assert.equal(result.changed,false);assert.equal(await f.inputs(),0);
});
test('原预算拒绝时无地址直播卡也不输入，未绕过限制',async t=>{
  const f=await fixture(t);f.controller.checkVideoLimits=async()=>{throw new Error('合成每日额度已用完');};await assert.rejects(f.controller.switchVideo(1),/额度已用完/);assert.equal(await f.inputs(),0);
});
test('普通视频换入无地址直播卡仍能确认不同卡片，保留下一次独立决定',async t=>{
  const f=await fixture(t,{kind:'video'});await f.page.evaluate(()=>{window.transition=()=>{const root=document.querySelector('section');root.className='';root.setAttribute('data-e2e','feed-live-card');root.innerHTML='<video muted autoplay style="width:320px;height:420px"></video><span>直播中</span>';window.startMedia();};});
  const result=await f.controller.switchVideo(1,undefined,{expectedVideoId:ID});assert.equal(result.changed,true,JSON.stringify(result));assert.equal(result.state.pageKind,'live-preview');assert.equal(result.state.livePreview.navigation,'skip-only');assert.equal(await f.inputs(),1);
});
