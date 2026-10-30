import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { BrowserController } from '../core.mjs';

function fixture(t,initial=[{}]) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-tab-ownership-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  const pages=[];
  function page(input={}) {
    const value={name:input.name||'',address:input.url||'about:blank',text:input.text||'',elements:input.elements||0,closed:false,navigations:[],writes:[]};
    Object.assign(value,{
      isClosed:()=>value.closed,url:()=>value.address,async close(){value.closed=true;},setDefaultTimeout(){},setDefaultNavigationTimeout(){},
      async evaluate(fn,arg){
        await setImmediate();const window={name:value.name},document={body:{textContent:value.text},querySelectorAll:()=>({length:value.elements})};
        const result=vm.runInNewContext(`(${fn.toString()})(__argument)`,{window,document,__argument:arg});
        if(window.name!==value.name)value.writes.push(window.name);value.name=window.name;return result;
      },
      async goto(url){await setImmediate();value.navigations.push(url);value.address=url;},
      locator:selector=>({waitFor:async()=>{assert.equal(selector,'[data-e2e="im-entry"]');}}),
    });pages.push(value);return value;
  }
  initial.forEach(page);
  const context={pages:()=>[...pages],newPage:async()=>{await setImmediate();return page();}};
  const browser={isConnected:()=>true,contexts:()=>[context]};
  function controller(source){
    const value=new BrowserController({source,controlDirectory:directory});value.browser=browser;
    // 只模拟标签认领与导航完成；不连接浏览器、不读取视频或用户资料。
    value.settle=async()=>({video:{id:'synthetic-ready-video',readyState:4}});return value;
  }
  return {pages,page,context,browser,controller,directory};
}

test('api-chat与api并发遇到同一空白页时各自认领不同标签',async t=>{
  const f=fixture(t),chat=f.controller('api-chat'),watch=f.controller('api'),original=f.pages[0];
  const [chatPage,watchPage]=await Promise.all([chat.connect(),watch.connect()]);
  assert.notEqual(chatPage,watchPage);assert.equal(f.pages.length,2);
  assert.equal(chatPage.name,'deepseek-douyin-api-chat');assert.equal(watchPage.name,'deepseek-douyin-api');
  assert.ok(chatPage===original||watchPage===original);
  assert.equal(chatPage.writes.includes('deepseek-douyin-api'),false);assert.equal(watchPage.writes.includes('deepseek-douyin-api-chat'),false);
});

test('缓存页被其他入口改名后不抢回foreign页，重新创建自己的标签',async t=>{
  const f=fixture(t),controller=f.controller('api'),old=await controller.connect();
  old.name='deepseek-douyin-api-chat';const previousAddress=old.address,previousNavigations=old.navigations.length;
  const replacement=await controller.connect();
  assert.notEqual(replacement,old);assert.equal(replacement.name,'deepseek-douyin-api');
  assert.equal(old.name,'deepseek-douyin-api-chat');assert.equal(old.address,previousAddress);assert.equal(old.navigations.length,previousNavigations);
});

test('已存在多个同名归属页时拒绝任取一个，不导航或重命名',async t=>{
  const f=fixture(t,[{name:'deepseek-douyin-api',url:'https://www.douyin.com/?synthetic=one'},{name:'deepseek-douyin-api',url:'https://www.douyin.com/?synthetic=two'}]),controller=f.controller('api');
  await assert.rejects(controller.connect(),/多个归属相同/);
  assert.equal(f.pages.length,2);assert.ok(f.pages.every(page=>page.navigations.length===0&&page.writes.length===0));
});

test('缓存成功后再出现第二个同名页，下次操作同样拒绝而不沿用旧缓存',async t=>{
  const f=fixture(t),controller=f.controller('api'),cached=await controller.connect();
  f.page({name:'deepseek-douyin-api',url:'https://www.douyin.com/?synthetic=duplicate'});const count=cached.navigations.length;
  await assert.rejects(controller.connect(),/多个归属相同/);assert.equal(cached.navigations.length,count);assert.equal(f.pages.length,2);
});

test('其他入口空白页与含内容的未命名页不能被当成可认领初始页',async t=>{
  const f=fixture(t,[{name:'foreign-synthetic-owner'},{text:'合成页面内容',elements:1}]),original=[...f.pages],controller=f.controller('api-chat');
  const owned=await controller.connect();assert.equal(f.pages.length,3);assert.ok(!original.includes(owned));
  assert.equal(original[0].name,'foreign-synthetic-owner');assert.equal(original[1].name,'');
  assert.ok(original.every(page=>page.navigations.length===0&&page.writes.length===0));
});

test('多个未命名空白页来源不明时新建标签，不随意挑选其中一个',async t=>{
  const f=fixture(t,[{},{}]),original=[...f.pages],owned=await f.controller('api').connect();
  assert.equal(f.pages.length,3);assert.ok(!original.includes(owned));assert.ok(original.every(page=>page.name===''&&page.navigations.length===0));
});

test('后台连接禁止新建或导航空白标签，失败时保持原页面不变',async t=>{
  const f=fixture(t,[{}]),controller=f.controller('api-chat');
  await assert.rejects(controller.connect(undefined,{launch:false,create:false}),error=>error.code==='CHAT_PAGE_NOT_OPEN');
  assert.equal(f.pages.length,1);assert.deepEqual(f.pages[0].navigations,[]);assert.equal(f.pages[0].writes.length,0);
});

test('后台连接遇到已归属但空白页时不导航，交由前台人工打开',async t=>{
  const f=fixture(t,[{name:'deepseek-douyin-api-chat',url:'about:blank'}]),controller=f.controller('api-chat');
  for(let i=0;i<3;i++) await assert.rejects(controller.connect(undefined,{launch:false,create:false}),error=>error.code==='CHAT_PAGE_NOT_OPEN');
  assert.equal(f.pages.length,1);assert.deepEqual(f.pages[0].navigations,[]);
});

test('新控制器可只重连已有专用浏览器，不误报关闭也不创建页面',async t=>{
  const f=fixture(t,[{name:'deepseek-douyin-api-chat',url:'https://www.douyin.com/'}]),controller=f.controller('api-chat');
  controller.browser=null;let reconnects=0;
  controller.connectExistingBrowser=async()=>{reconnects++;controller.browser=f.browser;return f.browser;};
  const page=await controller.connect(undefined,{launch:false,create:false});
  assert.equal(reconnects,1);assert.equal(page,f.pages[0]);assert.equal(f.pages.length,1);assert.deepEqual(page.navigations,[]);
});

test('初始化导航失败后关闭本次新建页，连续重试不积累存活标签',async t=>{
  const f=fixture(t,[]),controller=f.controller('api-chat');
  f.context.newPage=async()=>{const page=f.page();page.goto=async()=>{throw new Error('合成导航超时');};return page;};
  for(let i=0;i<10;i++)await assert.rejects(controller.connect(),/合成导航超时/);
  assert.equal(f.pages.filter(page=>!page.closed).length,0);assert.equal(controller.page,null);
});

test('借用初始空白页的导航失败后，下次会重新初始化，不把空白页当作就绪',async t=>{
  const f=fixture(t),controller=f.controller('api-chat'),page=f.pages[0],goto=page.goto;let attempts=0;
  page.goto=async(...args)=>{if(++attempts===1)throw new Error('合成首次导航失败');return goto(...args);};
  await assert.rejects(controller.connect(),/合成首次导航失败/);
  assert.equal(page.closed,false);assert.equal(await controller.connect(),page);assert.equal(attempts,2);assert.equal(f.pages.length,1);
});

test('同名离站缓存页保留原状，新的受管聊天入口可创建且后续不因旧页重复归属被拒',async t=>{
  const f=fixture(t,[{name:'deepseek-douyin-api-chat',url:'https://foreign.invalid/left',text:'离站旧页'}]);const foreign=f.pages[0],controller=f.controller('api-chat');
  const first=await controller.connect();
  assert.notEqual(first,foreign);assert.equal(first.name,'deepseek-douyin-api-chat');assert.equal(f.pages.length,2);
  assert.equal(foreign.address,'https://foreign.invalid/left');assert.equal(foreign.name,'deepseek-douyin-api-chat');assert.deepEqual(foreign.navigations,[]);assert.deepEqual(foreign.writes,[]);
  const second=await controller.connect();assert.equal(second,first);assert.equal(f.pages.length,2);
  assert.equal(foreign.address,'https://foreign.invalid/left');assert.deepEqual(foreign.navigations,[]);assert.deepEqual(foreign.writes,[]);
});
