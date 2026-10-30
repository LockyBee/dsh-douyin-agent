import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserLauncher, PREPARE_PAGE_NAME, PREPARE_HOME } from '../browser-launcher.mjs';
import { BrowserController, acquireBrowserOperationLock } from '../core.mjs';

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

test('同一客户端将未触碰准备页接成作品页，不建页不导航不关闭并撤销暂停监听',async()=>{
  const {launcher,browser,page,pages}=await prepared(),before={...page.calls};
  assert.equal(await launcher.adoptPreparedPage(browser,'deepseek-douyin-api'),page);
  assert.equal(pages.length,1);assert.equal(page.name,'deepseek-douyin-api');
  assert.deepEqual(page.calls,before);assert.equal(page.observers.filter(o=>o.active).length,0);
  assert.equal(page.docEvents.get('play').size,0);assert.equal(page.docEvents.get('pointerdown').size,0);
  await page.play();assert.equal(page.videos[0].paused,false);
  await page.goto('https://www.douyin.com/video/7770000000000000001');
  assert.equal(page.name,'deepseek-douyin-api');assert.equal(page.sandbox.window.__dafeiyuPreparePauseInstalled,undefined);
  await page.play();assert.equal(page.videos[0].paused,false);
});

test('人用空白页有内容时仅复用自己新建的准备页，既有页面保留',async()=>{
  const human=new Page();human.flags.bodyText='合成未保存草稿';
  const{launcher,browser,pages}=fixture([human]);await launcher.open();const own=pages[1];own.focused=false;
  assert.equal(await launcher.adoptPreparedPage(browser,'deepseek-douyin-dsh'),own);
  assert.equal(human.url(),'about:blank');assert.equal(human.name,'');assert.equal(human.calls.close,0);assert.equal(human.flags.bodyText,'合成未保存草稿');
});

test('显式打开可在初次导航清空名称后声明准备角色，后续永久初始化不能凭空认领',async()=>{
  const f=fixture();f.pages[0].clearNameOnNextNavigation=true;await f.launcher.open();const page=f.pages[0];
  assert.equal(page.name,PREPARE_PAGE_NAME);assert.ok(page.videos.every(video=>video.paused));page.focused=false;
  assert.equal(await f.launcher.adoptPreparedPage(f.browser,'deepseek-douyin-api'),page);
  page.clearNameOnNextNavigation=true;await page.goto('https://www.douyin.com/video/7770000000000000003');
  assert.equal(page.name,'');assert.equal(page.sandbox.window.__dafeiyuPreparePauseInstalled,undefined);await page.play();assert.equal(page.videos[0].paused,false);
});

for(const name of['',PREPARE_PAGE_NAME])test(`外站新文档名称为${name?'旧准备角色':'空'}时永久初始化不安装暂停器、不改名`,async()=>{
  const{page,launcher,browser}=await prepared();assert.equal(await launcher.adoptPreparedPage(browser,'deepseek-douyin-api'),page);
  page.sandbox.window.name=name;await page.goto('https://example.invalid/synthetic-only');
  assert.equal(page.name,name);assert.equal(page.sandbox.window.__dafeiyuPreparePauseInstalled,undefined);assert.equal(page.docEvents.get('play')?.size||0,0);await page.play();assert.equal(page.videos[0].paused,false);
});

test('既有旧准备页没有本客户端创建证明，保持原名和全部页面',async()=>{
  const old=new Page(PREPARE_HOME,PREPARE_PAGE_NAME);const{launcher,browser}=fixture([old]);await launcher.open();old.focused=false;
  assert.equal(await launcher.adoptPreparedPage(browser,'deepseek-douyin-api'),null);assert.equal(old.name,PREPARE_PAGE_NAME);assert.equal(old.calls.close,0);
});

test('另一客户端不继承准备页所有权，关闭新连接不承担回收证明',async()=>{
  const{browser,page}=await prepared();const other=new BrowserLauncher({getBrowser:async()=>browser});
  assert.equal(await other.adoptPreparedPage(browser,'deepseek-douyin-api'),null);assert.equal(page.name,PREPARE_PAGE_NAME);assert.equal(page.calls.close,0);
});

for(const[name,change]of[
  ['真正前台',page=>{page.focused=true;}],
  ['输入草稿',page=>{page.flags.inputs=[{tagName:'INPUT',type:'text',value:'合成草稿'}];}],
  ['多行草稿',page=>{page.flags.inputs=[{tagName:'TEXTAREA',type:'textarea',value:'合成草稿'}];}],
  ['富文本草稿',page=>{page.flags.inputs=[{tagName:'DIV',isContentEditable:true,textContent:'合成草稿'}];}],
  ['待上传文件',page=>{page.flags.inputs=[{tagName:'INPUT',type:'file',files:[{}]}];}],
  ['登录提示',page=>{page.flags.bodyText='扫码登录';}],
  ['验证提示',page=>{page.flags.bodyText='请完成验证';}],
  ['消息或验证遮挡',page=>{page.flags.blocker=true;}],
  ['仍在播放',page=>{page.videos[0].paused=false;}],
  ['真人输入已发生',page=>{page.trusted('pointerdown');}],
  ['同地址新文档',page=>{page.sandbox.performance.timeOrigin++;}],
  ['文档地址改变',page=>{page.sandbox.location.href='https://www.douyin.com/video/7770000000000000002';}],
  ['页面角色改变',page=>{page.sandbox.window.name='human-owned';}],
  ['准备租约丢失',page=>{delete page.sandbox.window.__dafeiyuPrepareLease;}]
])test(`${name}时拒绝转作品角色且不关闭、清草稿或输入`,async()=>{
  const{launcher,browser,page}=await prepared();change(page);const calls={...page.calls};
  assert.equal(await launcher.adoptPreparedPage(browser,'deepseek-douyin-api'),null);assert.deepEqual(page.calls,calls);
  assert.equal(page.sandbox.window.__dafeiyuPrepareLease?.adopted||false,false);
});

test('聊天角色不能接管准备页，事先取消也不转角色',async()=>{
  const{launcher,browser,page}=await prepared();assert.equal(await launcher.adoptPreparedPage(browser,'deepseek-douyin-api-chat'),null);
  const abort=new AbortController();abort.abort(new Error('合成取消'));
  await assert.rejects(launcher.adoptPreparedPage(browser,'deepseek-douyin-api',{signal:abort.signal}),/合成取消/);assert.equal(page.name,PREPARE_PAGE_NAME);
});

test('打开抖音优先显示已有作品页，播放草稿和暂停脚本均不改',async()=>{
  const page=new Page(PREPARE_HOME,'deepseek-douyin-api');page.flags.inputs=[{tagName:'TEXTAREA',value:'合成草稿'}];
  const{launcher,pages}=fixture([page]);const result=await launcher.open();
  assert.equal(result.mode,'watch');assert.equal(result.activeWatch,false);assert.equal(result.paused,null);assert.equal(pages.length,1);
  assert.equal(page.videos[0].paused,false);assert.equal(page.flags.inputs[0].value,'合成草稿');assert.deepEqual(page.calls,{goto:0,close:0,front:1,init:0});
});

test('多个作品入口先按当前来源唯一选择，归属相同的多页不择一',async()=>{
  const api=new Page(PREPARE_HOME,'deepseek-douyin-api'),dsh=new Page(PREPARE_HOME,'deepseek-douyin-dsh');
  const f=fixture([api,dsh]);await f.launcher.open();assert.equal(api.calls.front,1);assert.equal(dsh.calls.front,0);
  f.pages.push(new Page(PREPARE_HOME,'deepseek-douyin-api'));await assert.rejects(f.launcher.open(),/多个/);assert.equal(f.pages.length,3);assert.equal(f.pages.reduce((sum,p)=>sum+p.calls.close,0),0);
});

for(const create of[false,true])test(`核心 connect create=${create} 保留已有授权和标签锁边界`,async t=>{
  const{launcher,browser,page,pages}=await prepared(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'dafeiyu-adopt-lock-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const controller=new BrowserController({source:'api',controlDirectory:directory});controller.browser=browser;controller.browserLauncher=launcher;
  if(create){assert.equal(await controller.connect(undefined,{create}),page);assert.equal(page.name,'deepseek-douyin-api');}
  else{await assert.rejects(controller.connect(undefined,{create}),error=>error.code==='CHAT_PAGE_NOT_OPEN');assert.equal(page.name,PREPARE_PAGE_NAME);}
  assert.equal(pages.length,1);assert.equal(page.calls.goto,1);assert.equal(page.calls.close,0);assert.deepEqual(fs.readdirSync(directory),[]);
});

for(const revoked of[false,true])test(`等待标签锁期间授权${revoked?'撤回':'保留'}，转角色前在临界区重新核对`,async t=>{
  const{launcher,browser,page,pages}=await prepared(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'dafeiyu-adopt-revoke-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const controller=new BrowserController({source:'api',controlDirectory:directory});controller.browser=browser;controller.browserLauncher=launcher;
  const release=await acquireBrowserOperationLock('tab-claim',{directory});let allowed=true,calls=0;
  const operation=controller.connect(undefined,{create:true,authorizePrepare:async()=>{calls++;if(!allowed)throw Error('合成撤权');}});
  await new Promise(resolve=>setImmediate(resolve));if(revoked)allowed=false;release();
  if(revoked){await assert.rejects(operation,/合成撤权/);assert.equal(page.name,PREPARE_PAGE_NAME);assert.equal(page.sandbox.window.__dafeiyuPrepareLease.adopted,false);}
  else{assert.equal(await operation,page);assert.equal(page.name,'deepseek-douyin-api');}
  assert.equal(calls,1);assert.equal(pages.length,1);assert.equal(page.calls.goto,1);assert.equal(page.calls.close,0);assert.deepEqual(fs.readdirSync(directory),[]);
});

test('等标签锁时取消不执行转角色授权或改动页面',async t=>{
  const{launcher,browser,page}=await prepared(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'dafeiyu-adopt-abort-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const controller=new BrowserController({source:'api',controlDirectory:directory});controller.browser=browser;controller.browserLauncher=launcher;
  const release=await acquireBrowserOperationLock('tab-claim',{directory}),abort=new AbortController();let calls=0;
  const operation=controller.connect(abort.signal,{create:true,authorizePrepare:async()=>{calls++;}}),rejected=assert.rejects(operation,/合成取消/);
  await new Promise(resolve=>setImmediate(resolve));abort.abort(Error('合成取消'));release();await rejected;
  assert.equal(calls,0);assert.equal(page.name,PREPARE_PAGE_NAME);assert.equal(page.calls.close,0);assert.deepEqual(fs.readdirSync(directory),[]);
});
