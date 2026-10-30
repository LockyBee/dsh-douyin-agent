import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { BrowserController } from '../core.mjs';

function fixture(t, source='api') {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dafeiyu-pause-core-'));
  const controller=new BrowserController({source,controlDirectory:directory,videoLimits:{settleWatching(){return{};}}});
  t.after(()=>{assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true});});
  return controller;
}

test('并发暂停只执行一次，关闭等待同一暂停后释放缓存连接',async t=>{
  const controller=fixture(t), entered=Promise.withResolvers(), release=Promise.withResolvers();let checks=0,closed=0;
  controller.pauseForLimitsOnce=async()=>{checks++;entered.resolve();await release.promise;return{paused:0,existingPage:false};};
  controller.browser={close:async()=>{closed++;}};
  const first=controller.pauseForLimits(),second=controller.pauseForLimits();assert.equal(first,second);await entered.promise;
  const closing=controller.close();await Promise.resolve();assert.equal(closed,0);release.resolve();await Promise.all([first,second,closing]);
  assert.equal(checks,1);assert.equal(closed,1);assert.equal(controller.pauseInFlight,null);assert.equal(controller.browser,null);
});

test('暂停失败仍释放浏览器、子服务和记忆，再保留错误报告',async t=>{
  const controller=fixture(t),released=[];
  controller.pauseForLimitsOnce=async()=>{throw new Error('合成暂停故障');};
  controller.browser={close:async()=>{released.push('browser');}};
  controller.sparkPromise=Promise.resolve({close:async()=>{released.push('spark');throw new Error('合成子服务清理故障');}});
  controller.commentsPromise=Promise.resolve({close:async()=>{released.push('comments');}});
  controller.memory={close(){released.push('memory');}};
  await assert.rejects(controller.close(),error=>error instanceof AggregateError&&error.errors.length===2);
  assert.deepEqual(released,['browser','spark','comments','memory']);assert.equal(controller.browser,null);assert.equal(controller.memory,null);
});

test('没有受管宿主记录时暂停不连接浏览器，仍结算使用时间',async t=>{
  const controller=fixture(t);let settled=0;controller.videoLimits={settleWatching(){settled++;}};
  assert.deepEqual(await controller.pauseForLimits(),{paused:0,existingPage:false});assert.equal(settled,2);
});

test('缓存连接暂停在同一求值内核对名称与来源，不暂停聊天或外来页面',async t=>{
  const controller=fixture(t),pages=[];let browserClosed=0;
  for(const [name,origin] of [['deepseek-douyin-api','https://www.douyin.com'],['deepseek-douyin-api-chat','https://www.douyin.com'],['deepseek-douyin-api','https://example.test']]) {
    const video={paused:false},scope=vm.createContext({window:{name},location:{origin},document:{querySelectorAll(){return[video];}},HTMLMediaElement:{prototype:{pause(){this.paused=true;}}}});
    pages.push({video,calls:0,isClosed:()=>false,async evaluate(fn,label){this.calls++;return vm.runInContext(`(${fn.toString()})(${JSON.stringify(label)})`,scope);}});
  }
  controller.browser={isConnected:()=>true,contexts:()=>[{pages:()=>pages}],close:async()=>{browserClosed++;}};
  assert.deepEqual(await controller.pauseForLimits(),{paused:1,existingPage:true});
  assert.equal(pages[0].video.paused,true);assert.equal(pages[1].video.paused,false);assert.equal(pages[2].video.paused,false);
  assert.ok(pages.every(page=>page.calls===1));assert.equal(browserClosed,0);
});
