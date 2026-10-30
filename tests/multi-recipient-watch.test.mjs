import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AutonomousWatch, readShareProgress} from '../autonomous-watch.mjs';
import {AutonomousShare} from '../autonomous-share.mjs';
import {parseWatchDecision} from '../api-agent.mjs';
import {PersonaMemory} from '../persona-memory.mjs';
import {VideoLimits} from '../video-limits.mjs';
import {interactionPresence} from '../interaction-status.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const ids=['甲','乙','丙'].map(hash).map(value=>`conv:${value}`), ID='123456789012345';
const decision=(action,extra={})=>({action,reason:'依据当前合成视频进行测试',topics:[],reflection:'只依据本次真实处理结果',...extra});
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGDkAAAAASUVORK5CYII=';
function fixture(t,{source='api',decisions,sendMode={},afterSend}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-multi-share-')),stateDir=path.join(root,'state');
  let now=Date.parse('2026-10-15T03:00:00Z'),time=0,videoId=ID,watch;
  const clock=()=>now,events=[],sent=[],actions=[],requests=[],progress=[],queue=[...decisions];
  const videoLimits=new VideoLimits({stateDir,now:clock});videoLimits.savePolicy({windows:['00:00-24:00'],sessionMinutes:10},{explicit:true});
  const contacts=ids.map((id,index)=>({id,name:`合成好友${index}`,isGroup:false,followed:true,verifiedAt:'2026-10-15T01:00:00Z',identityVersion:2,identityKind:'rendered-user',identityHash:id.slice(5),identityBinding:'binding:'+hash('绑定'+index),identityVerified:true}));
  fs.writeFileSync(path.join(stateDir,'chat-policy.json'),JSON.stringify({allowlist:contacts}));
  const personaMemory=new PersonaMemory({memoryDir:path.join(root,'memory'),legacyRoleCardFile:path.join(root,'none'),clock});
  const state=()=>({url:`https://www.douyin.com/video/${videoId}`,loginRequired:false,verificationRequired:false,privateChatVisible:false,video:{id:videoId,url:`https://www.douyin.com/video/${videoId}`,time,duration:100,paused:false,readyState:4,title:'合成作品',author:'合成作者'}});
  const controller={execute:async name=>{actions.push(name);if(name==='douyin_observe'){now+=3000;time+=3;return{state:state(),frames:[{mimeType:'image/png',data:PNG,time,videoId}],observation:{videoId}};}if(name==='douyin_next'){videoId=String(BigInt(videoId)+1n);time=0;return{changed:true,state:state()};}return state();},pauseForLimits:async()=>{}};
  const share=new AutonomousShare({controller,personaMemory,videoLimits,stateDir,source,now:clock,send:async(input,controls)=>{
    progress.push(watch.state().shareProgress);sent.push(input.recipientId);
    controls.authorize({phase:'prepare',videoId:input.expectedVideoId,recipientId:input.recipientId});
    const mode=sendMode[input.recipientId];
    if(mode==='zero'){
      const code='FORWARD_GEOMETRY_FAILED',stage='geometry',forwardOperationId='合成零点击-'+sent.length;
      throw Object.assign(new Error('合成控件几何不可用'),{code,failure:{code,stage},forwardOperationId,preflight:{protocol:'share-preflight-v1',outcome:'not-sent',videoId:input.expectedVideoId,recipientId:input.recipientId,forwardOperationId,sendClicks:0,dispatchAuthorized:false,failureCode:code,failureStage:stage}});
    }
    controls.authorize({phase:'before-click',videoId:input.expectedVideoId,recipientId:input.recipientId});
    afterSend?.({input,controls,share,watch});
    return mode==='uncertain'?{confirmed:false,deliveryUncertain:true,deliveryType:'native-card',operationId:'合成不明'}:{confirmed:true,deliveryUncertain:false,deliveryType:'native-card',videoId:input.expectedVideoId,messageId:'合成卡片'+sent.length,operationId:'合成发送'+sent.length};
  }});share.configure({enabled:true},{explicit:true});
  watch=new AutonomousWatch({controller,config:{apiKey:'synthetic'},videoLimits,personaMemory,shareService:share,stateDir,source,now:clock,decisionProvider:async input=>{requests.push(input);const next=queue.shift()??decision('stop');return{text:typeof next==='string'?next:JSON.stringify(next),usage:{total_tokens:1}};},delayImpl:async ms=>{now+=ms;time+=ms/1000;},onEvent:e=>events.push(e)});
  t.after(async()=>{await watch.close();await share.close();fs.rmSync(root,{recursive:true,force:true});});
  return{watch,share,videoLimits,sent,events,requests,actions,progress,async run(){watch.start({startSession:true},{explicit:true});return watch.completion;}};
}

test('多对象协议兼容旧单人字段及数组，去重且不修改原始对象',()=>{
  const shareContext={enabled:true,dailyRemaining:null,recipients:ids.map(id=>({id,name:'合成对象'}))};
  const raw=decision('share',{recipientIds:[ids[0],ids[1],ids[0]]}),before=structuredClone(raw);
  assert.deepEqual(parseWatchDecision(raw,{shareContext}).recipientIds,ids.slice(0,2));assert.deepEqual(raw,before);
  assert.equal(parseWatchDecision(decision('share',{recipientId:ids[0]}),{shareContext}).recipientId,ids[0]);
  assert.deepEqual(parseWatchDecision(decision('share',{recipientId:ids.slice(0,2)}),{shareContext}).recipientIds,ids.slice(0,2));
  for(const fields of [{recipientIds:[]},{recipientIds:[`conv:${'f'.repeat(64)}`]},{recipientIds:[ids[0]],recipientId:ids[1]},{recipientIds:[ids[0]],url:'https://www.douyin.com/video/9'}])assert.throws(()=>parseWatchDecision(decision('share',fields),{shareContext}));
});

for(const source of ['api','dsh'])test(`${source}三位对象串行处理，单个零点击失败不拖停其余对象或换片`,async t=>{
  const f=fixture(t,{source,decisions:[decision('share',{recipientIds:ids}),decision('skip'),decision('stop')],sendMode:{[ids[1]]:'zero'}});
  const result=await f.run();assert.equal(result.status,'stopped',result.lastError);assert.deepEqual(f.sent,ids);assert.ok(f.actions.includes('douyin_next'));
  assert.deepEqual(f.share.ledger().operations.map(x=>x.status),['confirmed','not-sent','confirmed']);assert.equal(f.share.state().paused,false);
  assert.deepEqual(f.progress.map(p=>p.currentIndex),[1,2,3]);assert.equal(f.requests.length,3);
  assert.ok(f.events.some(e=>e.type==='watch.share-not-sent'));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.watch.files.state)).shareProgress,{total:3,currentIndex:3,completed:3,confirmed:2,notSent:1,skipped:0,status:'completed'});
});

test('中间一人点击后不明时暂停后续分享，但继续观看，不重发或虚构送达',async t=>{
  const f=fixture(t,{decisions:[decision('share',{recipientIds:ids}),decision('skip'),decision('stop')],sendMode:{[ids[1]]:'uncertain'}});
  assert.equal((await f.run()).status,'stopped');assert.deepEqual(f.sent,ids.slice(0,2));assert.equal(f.share.state().paused,true);assert.ok(f.actions.includes('douyin_next'));
  assert.deepEqual(f.share.ledger().operations.map(x=>x.status),['confirmed','uncertain']);assert.ok(f.events.some(e=>e.type==='watch.share-paused'));
});

test('重复同一批对象时复用逐人收据，不重复发卡片',async t=>{
  const f=fixture(t,{decisions:[decision('share',{recipientIds:ids.slice(0,2)}),decision('share',{recipientIds:ids.slice(0,2)}),decision('stop')]});
  assert.equal((await f.run()).status,'stopped');assert.deepEqual(f.sent,ids.slice(0,2));assert.equal(f.share.ledger().operations.length,2);
  assert.equal(f.events.filter(e=>e.type==='watch.share-skipped').length,2);
});

test('批次处理中关闭好友互动不发送剩余对象，原观看预算不被重置',async t=>{
  const f=fixture(t,{decisions:[decision('share',{recipientIds:ids}),decision('skip'),decision('stop')],afterSend:({share})=>share.configure({enabled:false},{explicit:true})});
  assert.equal((await f.run()).status,'stopped');assert.deepEqual(f.sent,[ids[0]]);assert.ok(f.actions.includes('douyin_next'));assert.equal(f.videoLimits.state().daily.requests,3);
});

test('处理首位对象后停止观看，不继续分享给剩余对象，保留已确认收据',async t=>{
  const f=fixture(t,{decisions:[decision('share',{recipientIds:ids}),decision('skip')],afterSend:({watch})=>watch.cancel()});
  assert.equal((await f.run()).status,'stopped');assert.deepEqual(f.sent,[ids[0]]);assert.deepEqual(f.share.ledger().operations.map(x=>x.status),['confirmed']);assert.equal(f.actions.includes('douyin_next'),false);
});

test('一次坏决策丢弃后重新观察，连续三次坏决策停止且每次记入原请求预算',async t=>{
  const good=fixture(t,{decisions:[decision('skip',{unknown:'不执行此字段'}),decision('skip'),decision('stop')]});
  assert.equal((await good.run()).status,'stopped');assert.equal(good.actions.filter(x=>x==='douyin_observe').length,3);assert.equal(good.actions.filter(x=>x==='douyin_next').length,1);assert.equal(good.videoLimits.state().daily.requests,3);
  const bad=fixture(t,{decisions:['not-json','not-json','not-json',decision('skip')]});assert.equal((await bad.run()).status,'failed');assert.equal(bad.requests.length,3);assert.equal(bad.videoLimits.state().daily.requests,3);assert.equal(bad.actions.includes('douyin_next'),false);
});

test('截断决策按真实失败调用计数，原每日请求预算先到就停止，不多调用一次',async t=>{
  const f=fixture(t,{decisions:[]});let attempts=0;
  f.videoLimits.savePolicy({dailyRequests:2},{explicit:true});
  f.watch.decisionProvider=async()=>{attempts++;throw Object.assign(new Error('合成模型截断'),{code:'WATCH_DECISION_INCOMPLETE',usage:{total_tokens:2}});};
  assert.equal((await f.run()).status,'limited');assert.equal(attempts,2);assert.equal(f.videoLimits.state().daily.requests,2);assert.deepEqual(f.sent,[]);assert.equal(f.actions.includes('douyin_next'),false);
});

test('分享进度按有效实时worker呈现，损坏或陈旧数据不假报分享中',()=>{
  const now=Date.parse('2026-10-15T03:00:00Z'),progress={total:3,currentIndex:2,completed:1,confirmed:1,notSent:0,skipped:0,status:'sharing'};
  assert.deepEqual(readShareProgress({...progress,privateData:'不输出'}),progress);assert.equal(readShareProgress({...progress,completed:4}),null);
  const presence=interactionPresence({watch:{running:true,worker:{alive:true,heartbeatAt:now},phase:'sharing',shareProgress:progress},now});assert.match(presence.watch.label,/2\/3/);
  assert.equal(interactionPresence({watch:{running:true,worker:{alive:true,heartbeatAt:now-10000},phase:'sharing',shareProgress:progress},now}).watch.active,false);
});
