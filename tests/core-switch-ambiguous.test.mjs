import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../playwright-runtime.mjs';
import { BrowserController, readPageState } from '../core.mjs';

// 复用现有真实 Edge、canvas 媒体和状态读取；所有网络请求均由本机合成页接管。
const A='7579432563794584933',B='7579432563794584934',C='7579432563794584935';
let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});

function markup({arrow=true,duplicate=false,tied=false,unknown=false,unready=false,conflict=false,mode='change'}={}){
  return `<!doctype html><meta charset="utf-8"><title>双候选换片合成测试</title>
  <style>body{margin:0;overflow:hidden}section{position:absolute}video{display:block;background:#184458}#current{left:20px;top:20px}#preload{left:650px;top:20px}button{position:absolute;left:500px;top:250px;width:70px;height:60px}</style>
  <section id="current" data-e2e="feed-active-video" ${conflict?`class="video_${B}"`:''}>
    <div data-e2e="player-container" class="${unknown?'':`video_${A}`}"><video id="main" muted autoplay playsinline width="360" height="480"></video></div>
    <span data-e2e="video-desc">当前合成作品</span>
  </section>
  <section id="preload" data-e2e="feed-active-video">
    <div data-e2e="player-container" class="${unknown?'':`video_${duplicate?A:B}`}"><video id="next" muted autoplay playsinline width="${tied?360:140}" height="${tied?480:180}"></video></div>
    <span data-e2e="video-desc">合成预载作品</span>
  </section>
  ${arrow?'<button data-e2e="video-switch-next-arrow">下一条</button>':''}
  <script>
  window.acceptedInputs=[];window.streams=[];window.renderTimers=[];
  window.setIdentity=(current,preload='${C}')=>{
    document.querySelector('#current [data-e2e="player-container"]').className=current?'video_'+current:'';
    document.querySelector('#preload [data-e2e="player-container"]').className=preload?'video_'+preload:'';
  };
  for(const video of document.querySelectorAll('video')){
    if(${unready}&&video.id==='main')continue;
    const canvas=document.createElement('canvas');canvas.width=48;canvas.height=48;const drawing=canvas.getContext('2d');let tick=0;
    const draw=()=>{drawing.fillStyle=tick++%2?'#184458':'#23566f';drawing.fillRect(0,0,48,48);};draw();
    window.renderTimers.push(setInterval(draw,80));const stream=canvas.captureStream(12);window.streams.push(stream);video.srcObject=stream;void video.play();
  }
  const handle=event=>{
    if(!event.isTrusted)return;
    if(event.type==='click'&&!event.target.closest('[data-e2e="video-switch-next-arrow"]'))return;
    if(event.type==='wheel'&&!event.target.closest('#current'))return;
    window.acceptedInputs.push({type:event.type,trusted:event.isTrusted});
    if('${mode}'==='change')window.setIdentity('${B}');
    if('${mode}'==='flash'){window.setIdentity('${B}');setTimeout(()=>window.setIdentity('${A}','${B}'),450);}
  };
  document.addEventListener('${arrow?'click':'wheel'}',handle,{passive:false});
  </script>`;
}

async function fixture(t,options={}){
  const context=await browser.newContext({viewport:{width:1100,height:800},serviceWorkers:'block'});
  t.after(async()=>{await context.close();});
  await context.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:markup(options)}));
  const page=await context.newPage();await page.goto('https://www.douyin.com/recommend');
  await page.waitForFunction(unready=>[...document.querySelectorAll('video')].filter(video=>!unready||video.id!=='main').every(video=>video.readyState>=2),options.unready===true);
  const controller=new BrowserController({source:'verification',memory:{recordVideo(){}}});
  controller.page=page;controller.browser=browser;let reads=0,afterReads=0;
  controller.state=async()=>{
    reads++;await options.beforeRead?.({page,reads,afterReads});
    if(await page.evaluate(()=>window.acceptedInputs.length)>0)afterReads++;
    await options.beforeAfterRead?.({page,reads,afterReads});
    return page.evaluate(readPageState);
  };
  return{page,controller,reads:()=>reads,inputs:()=>page.evaluate(()=>window.acceptedInputs),
    switch:signal=>controller.switchVideo(1,signal,{recordLearning:false,expectedVideoId:A})};
}

async function assertClean(f){
  assert.equal(await f.page.evaluate(()=>Object.keys(window.__deepseekVideoSwitchInputs??{}).length),0);
  assert.equal(await f.page.locator('[data-deepseek-switch-token]').count(),0);
  assert.equal(browser.isConnected(),true);
}

for(const arrow of [true,false])test(`双候选预载：${arrow?'真实点击':'真实滚轮'}只输入一次，并连续确认新片`,async t=>{
  const f=await fixture(t,{arrow}),initial=await f.page.evaluate(readPageState);
  assert.equal(initial.videoSelection.candidateCount,2);assert.equal(initial.videoSelection.ambiguous,true);assert.equal(initial.video.id,A);
  const result=await f.switch();
  assert.equal(result.changed,true);assert.equal(result.switchConfirm,'stable');assert.equal(result.before.id,A);assert.equal(result.after.id,B);
  assert.deepEqual(await f.inputs(),[{type:arrow?'click':'wheel',trusted:true}]);assert.ok(f.reads()>=8);
  await assertClean(f);
});

test('单候选在等待期间出现结构性预载，pending 重读仍接受同一唯一作品',async t=>{
  const f=await fixture(t,{beforeRead:async({page,reads})=>{
    if(reads===1)await page.locator('#preload').evaluate(element=>{element.style.display='none';});
    if(reads===3)await page.locator('#preload').evaluate(element=>{element.style.display='';});
  }});
  const result=await f.switch();assert.equal(result.changed,true);assert.equal(result.switchConfirm,'stable');assert.equal((await f.inputs()).length,1);await assertClean(f);
});

test('输入前作品真正变化时，旧 expectedVideoId 不驱动新作品',async t=>{
  const f=await fixture(t,{beforeRead:async({page,reads})=>{if(reads===3)await page.evaluate(({B,C})=>window.setIdentity(B,C),{B,C});}});
  const result=await f.switch();assert.equal(result.changed,false);assert.equal(result.staleObservation,true);assert.equal(result.reasonCode,'observed-video-changed');assert.equal(result.after.id,B);assert.deepEqual(await f.inputs(),[]);await assertClean(f);
});

for(const options of [{duplicate:true},{tied:true},{unknown:true},{unready:true},{conflict:true}])test(`多候选无法唯一且就绪绑定时拒绝输入：${JSON.stringify(options)}`,async t=>{
  const f=await fixture(t,options),result=await f.switch();
  assert.equal(result.changed,false);assert.equal(result.reasonCode,'video-identity-not-ready');assert.deepEqual(await f.inputs(),[]);await assertClean(f);
});

for(const [label,html] of [
  ['登录','<div style="position:fixed;inset:0;z-index:999">手机扫码登录</div>'],
  ['验证码','<div id="captcha_container" style="position:fixed;inset:0;z-index:999">请完成验证</div>'],
  ['私信','<div data-e2e="im-dialog" style="position:fixed;inset:0;z-index:999">合成私信面板</div>'],
])test(`多候选${label}遮挡仍立即拒绝`,async t=>{
  const f=await fixture(t);await f.page.evaluate(html=>document.body.insertAdjacentHTML('beforeend',html),html);
  const result=await f.switch();assert.equal(result.reasonCode,'switch-blocked');assert.deepEqual(await f.inputs(),[]);await assertClean(f);
});

for(const [label,mutate] of [
  ['身份切换但旧 ID 仍以预载存在',({A,B})=>window.setIdentity(B,A)],
  ['相同 ID 变为两个元素',({A})=>{document.querySelector('#preload [data-e2e="player-container"]').className='video_'+A;}],
  ['当前播放器变为未就绪',()=>{document.querySelector('#main').srcObject=null;}],
  ['验证码在真实输入前出现',()=>{document.body.insertAdjacentHTML('beforeend','<div id="captcha_container" style="position:fixed;inset:0;z-index:999">请完成验证</div>');}],
])test(`最后同步守卫拒绝竞态：${label}`,async t=>{
  const f=await fixture(t),realClick=f.page.mouse.click.bind(f.page.mouse);let attempted=0;
  f.page.mouse.click=async(...args)=>{attempted++;await f.page.evaluate(mutate,{A,B});return realClick(...args);};
  const result=await f.switch();assert.equal(attempted,1);assert.equal(result.changed,false);assert.deepEqual(await f.inputs(),[]);await assertClean(f);
});

test('新片仅闪现一次后弹回，不确认切换，也不补发输入',async t=>{
  const f=await fixture(t,{mode:'flash'}),result=await f.switch();
  assert.equal(result.changed,false);assert.equal(result.switchConfirm,null);assert.equal(result.reasonCode,'switch-not-confirmed');assert.equal(result.after.id,A);assert.equal((await f.inputs()).length,1);await assertClean(f);
});

test('真实输入未换片时保持失败，不把输入回执冒充新片',async t=>{
  const f=await fixture(t,{mode:'none'}),result=await f.switch();
  assert.equal(result.changed,false);assert.equal(result.switchConfirm,null);assert.equal(result.reasonCode,'switch-not-confirmed');assert.equal((await f.inputs()).length,1);await assertClean(f);
});

test('只有最终一次看到新 ID 时仅标 id-seen，changed 仍为 false',async t=>{
  const f=await fixture(t,{mode:'none',beforeAfterRead:async({page,afterReads})=>{if(afterReads===40)await page.evaluate(({B,C})=>window.setIdentity(B,C),{B,C});}});
  let skipped=0;const observed=await f.page.evaluate(readPageState);
  Object.assign(f.controller,{lastObservationVideoId:A,lastObservationEvidenceId:'synthetic-observation',lastObservationState:observed,lastObservationAt:Date.now()-1000,
    getPersonaMemory:()=>({recordViewing:()=>({accepted:true}),recordBehavior:()=>{skipped++;}})});
  const result=await f.controller.switchVideo(1,undefined,{recordLearning:true,expectedVideoId:A});
  assert.equal(result.changed,false);assert.equal(result.switchConfirm,'id-seen');assert.equal(result.after.id,B);assert.equal(result.reasonCode,'switch-not-confirmed');assert.equal(skipped,0);assert.equal((await f.inputs()).length,1);await assertClean(f);
});

test('稳定采样前取消不输入，输入后取消不追加换片',async t=>{
  const beforeInput=await fixture(t);await assert.rejects(beforeInput.switch(AbortSignal.timeout(100)));assert.deepEqual(await beforeInput.inputs(),[]);await assertClean(beforeInput);
  const afterInput=await fixture(t,{mode:'none'});await assert.rejects(afterInput.switch(AbortSignal.timeout(1200)));assert.equal((await afterInput.inputs()).length,1);await assertClean(afterInput);
});

test('最终稳定读取期间取消不能仍返回换片成功',async t=>{
  const cancellation=new AbortController();
  const f=await fixture(t,{beforeAfterRead:async({afterReads})=>{if(afterReads===2)cancellation.abort(new Error('合成最终读取期间取消'));}});
  await assert.rejects(f.switch(cancellation.signal),/合成最终读取期间取消/);assert.equal((await f.inputs()).length,1);await assertClean(f);
});
