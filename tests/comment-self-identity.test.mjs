import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from '../playwright-runtime.mjs';
import {readPageState} from '../core.mjs?v=9';
import {CommentBrowser,readCommentSelfIdentity,readCommentDom} from '../comment-browser.mjs';
let browser;
const SELF='MS4wLjAB_SYNTHETIC_SELF',OTHER='MS4wLjAB_SYNTHETIC_OTHER',VIDEO='12345',TEXT='合成色彩层次很舒服。';
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});
async function fixture(t,options={}){
  const context=await browser.newContext();t.after(()=>context.close());await context.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><body></body>'}));
  const page=await context.newPage();await page.goto('https://www.douyin.com/video/'+VIDEO);
  await page.setContent('<div class="tab-user_self"><a href="/user/self">我的</a></div><section class="comment-mainContent" data-video-id="12345"><div data-e2e="comment-list"></div></section><div class="comment-input-container"><div contenteditable="true" role="textbox" style="width:280px;min-height:40px"></div><button data-e2e="comment-post">发布</button></div>');
  await page.evaluate(({SELF,OTHER,TEXT,options})=>{
    const anchor=document.querySelector('.tab-user_self a'),tab=anchor.parentElement;
    window.selfGetterCalls=0;window.commentClicks=0;
    const userInfo={isLogin:true,statusCode:0,info:{secUid:SELF,sec_uid:SELF}};window.fixtureUser=userInfo;
    const build=()=>{let current={memoizedProps:{}};const head=current;for(let depth=1;depth<=5;depth++){current.return={memoizedProps:{}};current=current.return;if(depth===4)current.memoizedProps={userInfo};}return head;};
    Object.defineProperty(anchor,'__reactFiber$synthetic',{value:build(),configurable:true});
    if(options.secure)anchor.href='/user/'+SELF;
    if(options.noMetadata)delete anchor.__reactFiber$synthetic;
    if(options.conflict)userInfo.info.sec_uid=OTHER;
    if(options.secureConflict){anchor.href='/user/'+OTHER;}
    if(options.getter)Object.defineProperty(userInfo.info,'secUid',{get(){window.selfGetterCalls++;return SELF;}});
    if(options.loggedOut)userInfo.isLogin=false;
    if(options.duplicateNavigation)tab.append(anchor.cloneNode(true));
    window.addComment=({id='90001',author=SELF,text=TEXT,video='12345',status='sent'}={})=>{
      const row=document.createElement('div');row.dataset.e2e='comment-item';row.dataset.commentId=id;row.dataset.videoId=video;row.dataset.sendStatus=status;
      row.innerHTML='<div class="comment-item-avatar"><a><span style="display:inline-block;width:28px;height:28px">头像</span></a></div><span data-e2e="comment-content"></span>';
      row.querySelector('a').href='/user/'+author;row.querySelector('[data-e2e="comment-content"]').textContent=text;document.querySelector('[data-e2e="comment-list"]').append(row);
    };
    document.querySelector('[data-e2e="comment-post"]').addEventListener('click',()=>{
      window.commentClicks++;if(options.changeAfterClick){userInfo.info.secUid=OTHER;userInfo.info.sec_uid=OTHER;}
      if(options.publish===false)return;
      const id=options.sameOld?'90000':'90001';window.addComment({id,author:options.otherAuthor?OTHER:SELF,status:options.pending?'pending':'sent'});
      if(options.duplicateReceipt)window.addComment({id:'90002'});
      document.querySelector('[contenteditable]').textContent='';
    });
  },{SELF,OTHER,TEXT,options});
  const evaluate=page.evaluate.bind(page);page.evaluate=(fn,args)=>fn===readPageState?evaluate(()=>({loginRequired:false,verificationRequired:false,privateChatVisible:false,video:{id:'12345',url:'https://www.douyin.com/video/12345',readyState:4}})):evaluate(fn,args);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'comment-self-proposal-'));t.after(()=>{assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true});});
  const controller={withPage:(action,controls)=>{controls.signal?.throwIfAborted();return action(page);}},commenter=new CommentBrowser({controller,stateDir:directory,videoLimits:{state:()=>({allowed:true})}});
  let hook=async()=>{};const authorize=async request=>{await hook(request);return true;};authorize.beginDispatch=()=>()=>{};
  return{page,commenter,directory,hook:fn=>{hook=fn;},post:()=>commenter.post({expectedVideoId:VIDEO,text:TEXT},{authorize}),identity:()=>page.evaluate(readCommentSelfIdentity)};
}
test('self路由由真实语义导航fiber登录userinfo取得本人，未读显示名或任意作品作者',async t=>{
  const f=await fixture(t);const identity=await f.identity();assert.equal(identity.ready,true);assert.equal(identity.ownProfileId,SELF);assert.equal(identity.source,'navigation-login-metadata');
  await f.page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<div data-e2e="player-container" class="video_12345"><a href="/user/arbitrary-author">任意作者</a></div>'));
  assert.equal((await f.identity()).ownProfileId,SELF);
});
test('旧真实个人链接独立兼容，链接与登录元数据冲突则拒绝',async t=>{
  const legacy=await fixture(t,{secure:true,noMetadata:true});assert.equal((await legacy.identity()).ready,true);assert.equal((await legacy.identity()).source,'secure-navigation');
  const conflict=await fixture(t,{secureConflict:true});assert.equal((await conflict.identity()).ready,false);assert.equal((await conflict.identity()).reasonCode,'self-identity-conflict');
});
test('缺失、secUid字段冲突、getter、退出登录及重复导航全部拒绝',async t=>{
  for(const options of [{noMetadata:true},{conflict:true},{getter:true},{loggedOut:true},{duplicateNavigation:true}]){const f=await fixture(t,options);assert.equal((await f.identity()).ready,false);assert.equal(await f.page.evaluate(()=>window.selfGetterCalls),0);assert.equal((await f.post()).confirmed,false);assert.equal(await f.page.evaluate(()=>window.commentClicks),0);}
});
test('userinfo仅继承一层数据字段可读，二层和访问器不能提供身份',async t=>{
  const f=await fixture(t);await f.page.evaluate(({SELF})=>{window.fixtureUser.info=Object.create({secUid:SELF,sec_uid:SELF});},{SELF});assert.equal((await f.identity()).ready,true);
  await f.page.evaluate(()=>{window.fixtureUser.info=Object.create(Object.create({secUid:'second-prototype-only'}));});assert.equal((await f.identity()).ready,false);
});
test('fiber最多读取5次return，不触碰第6层getter',async t=>{
  const f=await fixture(t);await f.page.evaluate(()=>{let fiber=document.querySelector('.tab-user_self a').__reactFiber$synthetic;for(let i=0;i<5;i++)fiber=fiber.return;Object.defineProperty(fiber,'return',{get(){window.selfGetterCalls++;throw new Error('不可读取第6层');}});});assert.equal((await f.identity()).ready,true);assert.equal(await f.page.evaluate(()=>window.selfGetterCalls),0);
});
test('可信本人ID仅内部用于mine回读，原string参数兼容且不带出ID',async t=>{
  const f=await fixture(t);await f.page.evaluate(()=>window.addComment());let value=await f.page.evaluate(readCommentDom,{expectedVideoId:VIDEO,ownProfileId:SELF});assert.equal(value.rows[0].mine,true);assert.equal(JSON.stringify(value).includes(SELF),false);
  await f.page.evaluate(({SELF})=>{document.querySelector('.tab-user_self a').href='/user/'+SELF;},{SELF});value=await f.page.evaluate(readCommentDom,VIDEO);assert.equal(value.rows[0].mine,true);
  assert.deepEqual((await f.page.evaluate(readCommentDom,{expectedVideoId:VIDEO,ownProfileId:'self'})).rows,[]);
});
test('模型JSON不能把ownProfileId塞进发布参数绕过本人核对',async t=>{
  const f=await fixture(t);await assert.rejects(f.commenter.post({expectedVideoId:VIDEO,text:TEXT,ownProfileId:OTHER}),TypeError);assert.equal(await f.page.evaluate(()=>window.commentClicks),0);
});
test('真实合成点击一次，新本人评论稳定回读确认，收据没有本人ID',async t=>{
  const f=await fixture(t),result=await f.post();assert.equal(result.confirmed,true);assert.equal(await f.page.evaluate(()=>window.commentClicks),1);assert.equal(JSON.stringify(f.commenter.receipts()).includes(SELF),false);
  const again=await f.post();assert.equal(again.confirmed,false);assert.equal(await f.page.evaluate(()=>window.commentClicks),1);
});
test('发布前改账号或失去本人资料均不点击，原草稿保留',async t=>{
  for(const mode of ['account','lost']){const f=await fixture(t);let changed=false;f.hook(async({phase})=>{if(phase==='before-click'&&!changed){changed=true;await f.page.evaluate(({mode,OTHER})=>{if(mode==='lost')delete document.querySelector('.tab-user_self a').__reactFiber$synthetic;else{window.fixtureUser.info.secUid=OTHER;window.fixtureUser.info.sec_uid=OTHER;}},{mode,OTHER});}});const result=await f.post();assert.equal(result.confirmed,false);assert.equal(result.deliveryUncertain,false);assert.equal(await f.page.evaluate(()=>window.commentClicks),0);assert.equal(await f.page.locator('[contenteditable]').innerText(),TEXT);}
});
test('点击后改账号保留uncertain，不把旧本人评论当成功，也不重发',async t=>{
  const f=await fixture(t,{changeAfterClick:true});const result=await f.post();assert.equal(result.confirmed,false);assert.equal(result.deliveryUncertain,true);assert.equal(await f.page.evaluate(()=>window.commentClicks),1);assert.equal(f.commenter.receipts().operations[0].status,'uncertain');await f.post();assert.equal(await f.page.evaluate(()=>window.commentClicks),1);
});
test('旧评论、他人同文、pending、同文多条仍不能确认，不自动重发',async t=>{
  for(const options of [{sameOld:true},{otherAuthor:true},{pending:true},{duplicateReceipt:true},{publish:false}]){const f=await fixture(t,options);if(options.sameOld)await f.page.evaluate(()=>window.addComment({id:'90000'}));const result=await f.post();assert.equal(result.confirmed,false);assert.equal(result.deliveryUncertain,true);assert.equal(await f.page.evaluate(()=>window.commentClicks),1);await f.post();assert.equal(await f.page.evaluate(()=>window.commentClicks),1);}
});
test('外域、私信或评论里的伪本人导航不能提供身份',async t=>{
  for(const mode of ['outside','private','comment']){const f=await fixture(t);await f.page.evaluate(mode=>{const tab=document.querySelector('.tab-user_self');if(mode==='outside')tab.querySelector('a').href='https://outside.invalid/user/pretend-self';else{const area=document.createElement('div');area.dataset.e2e=mode==='private'?'im-dialog':'comment-item';tab.replaceWith(area);area.append(tab);}},mode);assert.equal((await f.identity()).ready,false);}
});
