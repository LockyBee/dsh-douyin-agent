import test,{before,after}from'node:test';import assert from'node:assert/strict';
import{chromium}from'../playwright-runtime.mjs';import{BrowserController,readPageState}from'../core.mjs';import{watchDecisionMessages}from'../api-agent.mjs';
let browser;before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});after(async()=>browser?.close());
const A='7579432563794584933',B='7579432563794584934';
const svg='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="420"><rect width="320" height="420" fill="#427aaa"/><circle cx="160" cy="180" r="70" fill="#ffe0a0"/></svg>');
const card=(id=A)=>`<section data-e2e="feed-active-video" class="video_${id}" style="width:360px;height:500px"><img data-e2e="photo-image" src="${svg}" width="320" height="420"><div data-e2e="video-desc">合成图文作品</div></section>`;
async function fixture(t,{body=card(),url='https://www.douyin.com/?recommend=1'}={}){
 const context=await browser.newContext({viewport:{width:1100,height:850}});t.after(()=>context.close());await context.route('https://www.douyin.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><style>body{margin:0}section{position:relative}button{position:fixed;left:700px;top:200px;width:60px;height:50px}</style>${body}`}));
 const page=await context.newPage();await page.goto(url);await page.locator('img').first().evaluate(image=>image.decode()).catch(()=>{});
 const controller=new BrowserController({source:'verification',memory:{recordVideo(){},close(){}}});controller.page=page;return{page,controller};
}
test('图文识别绑定当前作品和已加载的实际大图，不借用视频进度',async t=>{
 const f=await fixture(t),s=await f.page.evaluate(readPageState);assert.equal(s.pageKind,'image-post');assert.equal(s.imagePost.id,A);assert.equal(s.imagePost.loaded,true);assert.equal(s.video,null);assert.ok(s.imagePost.viewport.width>=300);assert.equal(s.imagePost.duration,undefined);
});

test('首次打开推荐流或图文详情时，已就绪图文不再等待视频元素超时',async t=>{
 for(const detail of [false,true]){const f=await fixture(t,{url:detail?`https://www.douyin.com/note/${A}`:undefined});const result=await f.controller.settle(AbortSignal.timeout(1200),{kind:detail?'video':'recommend',videoId:detail?A:undefined});assert.equal(result.pageKind,'image-post');assert.equal(result.imagePost.id,A);}
});
test('只有头像、未知作品ID或正在加载的视频时不冒充可观察图文',async t=>{
 for(const body of [card().replace('width="320" height="420"','width="32" height="32"'),card().replace(`class="video_${A}"`,''),card().replace('data-e2e="photo-image"',''),card().replace(`class="video_${A}"`,'').replace('</section>',`<a href="https://example.invalid/note/${A}">外站内容</a></section>`),card().replace('</section>','<video style="width:320px;height:400px"></video></section>')]){const f=await fixture(t,{body}),s=await f.page.evaluate(readPageState);assert.notEqual(s.pageKind,'image-post');}
});
test('图文来源身份冲突或有私信和验证码时不返回可采样图文',async t=>{
 for(const body of [card().replace('</section>',`<a href="https://www.douyin.com/note/${B}">另一作品</a></section>`),card()+'<div data-e2e="im-dialog" style="width:100px;height:100px">合成私信</div>',card()+'<div id="captcha_container" style="width:100px;height:100px"></div>']){const f=await fixture(t,{body}),s=await f.page.evaluate(readPageState);assert.equal(s.imagePost,null);}
});
test('图文实际截图只有当前图片，没有伪造视频播放时间',async t=>{
 const f=await fixture(t),result=await f.controller.capture(0);assert.equal(result.state.imagePost.id,A);assert.equal(result.frames.length,1);assert.equal(result.frames[0].videoId,A);assert.equal(result.frames[0].time,null);assert.equal(result.observation.workKind,'image-post');assert.ok(Buffer.from(result.frames[0].data,'base64').length>100);assert.match(result.observation.note,/当前/);
});
test('图片截图期间换作品或出现私信，整次图文采样作废',async t=>{
 for(const mode of ['changed','private']){const f=await fixture(t),original=f.controller.captureViewport.bind(f.controller);f.controller.captureViewport=async(...args)=>{const buffer=await original(...args);await f.page.evaluate(({mode,id})=>{if(mode==='changed')document.querySelector('section').className='video_'+id;else{const panel=document.createElement('div');panel.setAttribute('data-e2e','im-dialog');panel.style.cssText='width:100px;height:100px';document.body.append(panel);}},{mode,id:B});return buffer;};const result=await f.controller.capture(0);assert.equal(result.frames.length,0);}
});
test('图文观察可进入同一观看模型，但不声称已读完整套图片',async t=>{
 const f=await fixture(t),observation=await f.controller.capture(0),messages=watchDecisionMessages(observation);const text=messages[1].content[0].text;assert.match(text,/图文/);assert.match(text,/当前/);assert.match(text,/本次不分享/);assert.throws(()=>watchDecisionMessages({...observation,frames:observation.frames.map(frame=>({...frame,videoId:B}))}),/同一/);
});
test('图文换片仅点击一次，并核实已到另一作品',async t=>{
 const f=await fixture(t,{body:card()+'<button data-e2e="video-switch-next-arrow">下一条</button>'});await f.page.evaluate(id=>{window.inputs=0;document.querySelector('button').addEventListener('click',()=>{window.inputs++;document.querySelector('section').className='video_'+id;});},B);
 const result=await f.controller.switchVideo(1,undefined,{recordLearning:false,expectedVideoId:A});assert.equal(result.changed,true);assert.equal(result.beforePageKind,'image-post');assert.equal(result.state.imagePost.id,B);assert.equal(await f.page.evaluate(()=>window.inputs),1);
});
