import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserLauncher, PREPARE_PAGE_NAME, PREPARE_HOME } from '../browser-launcher.mjs';
import { BrowserController, acquireBrowserOperationLock } from '../core.mjs';
import { ChatService } from '../chat-service.mjs';

class Page {
  constructor(url='about:blank',name='') {
    this.address=url;this.name=name;this.focused=false;this.closed=false;this.originCounter=1;
    this.init=[];this.calls={goto:0,close:0,front:0,init:0};this.flags={};this.createDocument();
  }
  createDocument() {
    const page=this,docEvents=new Map(),winEvents=new Map();this.docEvents=docEvents;this.winEvents=winEvents;this.observers=[];
    const add=(map,type,fn)=>{if(!map.has(type))map.set(type,new Set());map.get(type).add(fn);};
    const remove=(map,type,fn)=>map.get(type)?.delete(fn);
    class Media { constructor(){this.paused=false;this.pauses=0;} pause(){this.paused=true;this.pauses++;} play(){this.paused=false;for(const fn of docEvents.get('play')||[])fn({target:this,isTrusted:true});return Promise.resolve();} }
    this.videos=this.address==='about:blank'?[]:[new Media(),new Media(),new Media()];
    const element=overrides=>({getBoundingClientRect:()=>({left:0,top:0,right:100,bottom:20,width:100,height:20}),childElementCount:0,textContent:'',...overrides});
    const document={
      body:{get textContent(){return page.flags.bodyText||'';}},hasFocus:()=>page.focused,
      addEventListener:(type,fn)=>add(docEvents,type,fn),removeEventListener:(type,fn)=>remove(docEvents,type,fn),
      querySelectorAll(selector){
        if(selector==='video')return page.videos;
        if(selector==='body *')return page.flags.bodyText?[element({textContent:page.flags.bodyText})]:[];
        if(selector==='input,textarea,[contenteditable="true"]')return (page.flags.inputs||[]).map(value=>element(value));
        if(selector.startsWith('#captcha_container'))return page.flags.blocker?[element()]:[];
        throw Error('未建模的查询：'+selector);
      }
    };
    const window={name:this.name,addEventListener:(type,fn)=>add(winEvents,type,fn),removeEventListener:(type,fn)=>remove(winEvents,type,fn)};
    const location=this.address==='about:blank'?{href:'about:blank',origin:'null'}:new URL(this.address);
    this.sandbox=vm.createContext({window,document,location,performance:{timeOrigin:this.originCounter},HTMLMediaElement:Media,HTMLVideoElement:Media,
      MutationObserver:class {constructor(fn){this.fn=fn;this.active=false;page.observers.push(this);}observe(){this.active=true;}disconnect(){this.active=false;}},
      getComputedStyle:()=>({display:'block',visibility:'visible'}),innerWidth:1920,innerHeight:1080});
  }
  url(){return this.address;} isClosed(){return this.closed;}
  async evaluate(fn,arg){this.sandbox.__arg=arg;try{const result=await vm.runInContext(`(${fn.toString()})(__arg)`,this.sandbox);this.name=this.sandbox.window.name;return result;}finally{delete this.sandbox.__arg;}}
  async addInitScript(fn,arg){this.calls.init++;this.init.push([fn,arg]);}
  async goto(url){this.calls.goto++;this.name=this.clearNameOnNextNavigation?'':this.sandbox.window.name;this.clearNameOnNextNavigation=false;this.address=url;this.originCounter++;this.createDocument();for(const[fn,arg]of this.init)await this.evaluate(fn,arg);}
  async bringToFront(){this.calls.front++;this.focused=true;}
  async close(){this.calls.close++;this.closed=true;}
  setDefaultTimeout(){} setDefaultNavigationTimeout(){}
  trusted(type){for(const fn of this.docEvents.get(type)||[])fn({isTrusted:true});}
  async play(){await this.videos[0].play();}
}
function fixture(pages=[new Page()]) {
  const context={pages:()=>pages.filter(page=>!page.closed),newPage:async()=>{const page=new Page();pages.push(page);return page;}};
  const browser={contexts:()=>[context],isConnected:()=>true};
  const launcher=new BrowserLauncher({getBrowser:async()=>browser,preferExistingWatchPage:true,preferredSource:'api'});
  return{pages,context,browser,launcher};
}
async function prepared(){const f=fixture();await f.launcher.open();f.page=f.pages[0];f.page.focused=false;return f;}

test('自动消息准备后只关闭当前客户端自有的空闲准备页，不关闭chat/watch页',async()=>{
  const f=await prepared(),chat=new Page(PREPARE_HOME,'deepseek-douyin-api-chat'),watch=new Page(PREPARE_HOME,'deepseek-douyin-dsh');f.pages.push(chat,watch);
  const result=await f.launcher.closeIdlePreparedPage(f.browser,{authorizeClose:async()=>true});assert.equal(result.closed,true);assert.equal(f.page.calls.close,1);assert.equal(chat.calls.close,0);assert.equal(watch.calls.close,0);assert.equal(f.launcher.preparedOwnership.has(f.page),false);
});
for(const[name,change]of[
  ['真实前台',page=>{page.focused=true;}],['输入草稿',page=>{page.flags.inputs=[{tagName:'INPUT',type:'text',value:'合成草稿'}];}],['富文本草稿',page=>{page.flags.inputs=[{tagName:'DIV',isContentEditable:true,textContent:'合成草稿'}];}],['待传文件',page=>{page.flags.inputs=[{tagName:'INPUT',type:'file',files:[{}]}];}],
  ['登录提示',page=>{page.flags.bodyText='扫码登录';}],['验证提示',page=>{page.flags.bodyText='请完成验证';}],['消息遮挡',page=>{page.flags.blocker=true;}],['仍播放',page=>{page.videos[0].paused=false;}],['曾有真人点击',page=>{page.trusted('pointerdown');}],['页面重载',page=>{page.sandbox.performance.timeOrigin++;}],['页面已导航',page=>{page.sandbox.location.href='https://www.douyin.com/video/7770000000000000001';}],['token改变',page=>{page.sandbox.window.__dafeiyuPrepareLease.token='other-client';}],['已转观看角色',page=>{page.sandbox.window.name='deepseek-douyin-api';}]
])test(`${name}时不回收准备页`,async()=>{const f=await prepared();change(f.page);const result=await f.launcher.closeIdlePreparedPage(f.browser,{authorizeClose:async()=>true});assert.equal(result.closed,false);assert.equal(f.page.calls.close,0);});

test('另一客户端或旧准备页没有WeakMap证明时不重新认领或关闭',async()=>{
  const f=await prepared(),other=new BrowserLauncher({getBrowser:async()=>f.browser});assert.equal((await other.closeIdlePreparedPage(f.browser,{authorizeClose:async()=>true})).closed,false);assert.equal(f.page.calls.close,0);
  const old=new Page(PREPARE_HOME,PREPARE_PAGE_NAME),legacy=fixture([old]);await legacy.launcher.open();old.focused=false;assert.equal((await legacy.launcher.closeIdlePreparedPage(legacy.browser,{authorizeClose:async()=>true})).closed,false);assert.equal(old.calls.close,0);
});
test('缺授权、授权撤回、事先取消及观看worker存在都不关闭',async()=>{
  for(const mode of['missing','revoke','abort','watch']){const f=await prepared(),abort=new AbortController();if(mode==='abort')abort.abort(Error('合成取消'));if(mode==='watch')f.launcher.getWatchState=()=>({source:'api'});
    const options={signal:abort.signal,...(mode==='missing'?{}:{authorizeClose:async()=>{if(mode==='revoke')throw Error('合成撤权');}})};
    if(['revoke','abort'].includes(mode))await assert.rejects(f.launcher.closeIdlePreparedPage(f.browser,options));else assert.equal((await f.launcher.closeIdlePreparedPage(f.browser,options)).closed,false);assert.equal(f.page.calls.close,0);
  }
});
test('授权await期间页面被用户触碰或采用为观看页时最终门禁拒绝关闭',async()=>{
  for(const changed of['touch','role']){const f=await prepared();const result=await f.launcher.closeIdlePreparedPage(f.browser,{authorizeClose:async()=>{if(changed==='touch')f.page.trusted('keydown');else f.page.sandbox.window.name='deepseek-douyin-dsh';}});assert.equal(result.closed,false);assert.equal(f.page.calls.close,0);}
});
for(const mode of['revoke','watch'])test(`DOM核对等待期间${mode==='revoke'?'共享授权撤回':'观看worker启动'}，关闭前最终门禁阻止回收`,async()=>{
  const f=await prepared(),evaluate=f.page.evaluate.bind(f.page);let allowed=true,watch=null,checks=0;
  f.launcher.getWatchState=()=>watch;
  f.page.evaluate=async(fn,arg)=>{const result=await evaluate(fn,arg);if(fn.toString().includes('const entry=window.__dafeiyuPrepareLease')){if(mode==='revoke')allowed=false;else watch={source:'dsh'};}return result;};
  const operation=f.launcher.closeIdlePreparedPage(f.browser,{authorizeClose:async()=>{checks++;if(!allowed)throw Error('合成最终撤权');}});
  if(mode==='revoke')await assert.rejects(operation,/合成最终撤权/);else assert.equal((await operation).closed,false);
  assert.equal(checks,2);assert.equal(f.page.calls.close,0);
});
test('MainCore持标签与准备页锁回收，取消等待不关闭也不遗留锁',async t=>{
  for(const cancelled of[false,true]){const f=await prepared(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'dy-prepare-close-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const controller=new BrowserController({source:'api',controlDirectory:directory});controller.browser=f.browser;controller.browserLauncher=f.launcher;
    const release=await acquireBrowserOperationLock('tab-claim',{directory}),abort=new AbortController(),operation=controller.releaseIdlePreparePage({signal:abort.signal,authorizePrepare:async()=>true});
    const done=cancelled?assert.rejects(operation,/合成取消/):operation;await new Promise(resolve=>setImmediate(resolve));if(cancelled)abort.abort(Error('合成取消'));release();const result=await done;if(!cancelled)assert.equal(result.closed,true);assert.equal(f.page.calls.close,cancelled?0:1);assert.deepEqual(fs.readdirSync(directory),[]);
  }
});
async function serviceFixture(t,{result={prepared:true,count:3},onPrepared}={}){
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-prepare-hook-')),calls={model:0,send:0,prepare:0};
  const service=new ChatService({stateDir,config:{apiKey:'synthetic-only'},agent:{reply:async()=>{calls.model++;assert.fail('准备不能调模型');}},browser:{listContacts:async()=>[],readConversation:async()=>[],sendMessage:async()=>{calls.send++;assert.fail('准备不能发送');},prepareChat:async()=>{calls.prepare++;return result;}},onPrepared});
  const policy={...service.policy,allowlist:[{id:`conv:${'1'.repeat(64)}`,name:'合成许可好友',isGroup:false,followed:true,authorizationKind:'manual',verifiedAt:'2026-10-28T00:00:00Z'}]};fs.writeFileSync(service.policyFile,JSON.stringify(policy));const originalPolicy=fs.readFileSync(service.policyFile),originalWatermarks=fs.readFileSync(service.watermarkFile);
  t.after(async()=>{await service.close();assert.equal(path.dirname(path.resolve(stateDir)),path.resolve(os.tmpdir()));fs.rmSync(stateDir,{recursive:true,force:true});});
  const unchanged=()=>{assert.deepEqual(fs.readFileSync(service.policyFile),originalPolicy);assert.deepEqual(fs.readFileSync(service.watermarkFile),originalWatermarks);assert.equal(calls.model,0);assert.equal(calls.send,0);};return{service,calls,unchanged};
}
test('可选onPrepared只在automatic明确成功且有联系人时调用，不改许可、水位或预算',async t=>{
  for(const mode of['automatic','manual','blocked','empty']){let hooks=0;const f=await serviceFixture(t,{result:mode==='blocked'?{blocked:true,prepared:false}:mode==='empty'?{prepared:true,count:0}:{prepared:true,count:3},onPrepared:async({authorizePrepare})=>{hooks++;await authorizePrepare();return{closed:true,reasonCode:'OWNED_IDLE_PREPARE_CLOSED'};}});
    const result=await f.service.prepareChat({automatic:mode!=='manual',authorizePrepare:async()=>true});assert.equal(hooks,mode==='automatic'?1:0);if(mode==='automatic')assert.equal(result.prepareCleanup.closed,true);f.unchanged();
  }
});
test('资源回收失败可跳过但不能阻断已就绪聊天，取消和撤权仍停止',async t=>{
  const f=await serviceFixture(t,{onPrepared:async()=>{throw Error('合成回收失败');}});const result=await f.service.prepareChat({automatic:true,authorizePrepare:async()=>true});assert.equal(result.prepared,true);assert.equal(result.prepareCleanup.closed,false);assert.equal(result.prepareCleanup.reasonCode,'PREPARE_RECLAIM_UNAVAILABLE');f.unchanged();
  const denied=await serviceFixture(t,{onPrepared:async()=>assert.fail('撤权后不能执行回收')});await assert.rejects(denied.service.prepareChat({automatic:true,authorizePrepare:async()=>{throw Error('合成撤权');}}),/合成撤权/);denied.unchanged();
});
