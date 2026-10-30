import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScheduledWatch, scheduledSlot } from '../scheduled-watch.mjs';
import { VideoLimits } from '../video-limits.mjs';
import { AutonomousWatch } from '../autonomous-watch.mjs';
import { interactionStatus } from '../interaction-status.mjs';
function fixture(t,time='2026-10-23T00:59:00Z') {const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-scheduled-'));let clock=Date.parse(time);const video=new VideoLimits({stateDir,now:()=>clock});t.after(()=>{assert.equal(path.dirname(stateDir),path.resolve(os.tmpdir()));fs.rmSync(stateDir,{recursive:true,force:true});});let starts=0;const options={stateDir,getVideoLimits:async()=>video,getWatchState:async()=>({running:false}),startRound:async()=>{starts++;return{sessionId:'synthetic-session'};},now:()=>clock};return{stateDir,video,options,setTime:value=>{clock=Date.parse(value);},starts:()=>starts};}

test('聊天采样持有手动锁时等待，释放后自动继续且不记失败', async t => {
 const f=fixture(t),schedule=new ScheduledWatch(f.options);f.video.savePolicy({windows:['00:00-24:00'],dailyMinutes:10,dailyRequests:30},{explicit:true});schedule.configure({enabled:true},{explicit:true});
 const manual=path.join(f.stateDir,'watch-manual.lock');fs.writeFileSync(manual,JSON.stringify({pid:process.pid,token:'synthetic-chat-lock',kind:'chat-shared-video'}));
 await schedule.tick();assert.equal(f.starts(),0);assert.equal(schedule.state().last,null);
 fs.unlinkSync(manual);await schedule.tick();assert.equal(f.starts(),1);assert.equal(schedule.state().last.status,'started');
});

test('检查后才被聊天占用时保留等待回执，下一次检查仍可继续', async t => {
 const f=fixture(t);let busy=true;const schedule=new ScheduledWatch({...f.options,startRound:async()=>{if(busy)throw Object.assign(new Error('合成聊天采样占用'),{code:'WATCH_MANUAL_OCCUPIED'});return f.options.startRound();}});
 f.video.savePolicy({windows:['00:00-24:00'],dailyMinutes:10,dailyRequests:30},{explicit:true});schedule.configure({enabled:true},{explicit:true});await schedule.tick();assert.equal(schedule.state().last.status,'occupied');assert.equal(schedule.state().lastError,'');busy=false;await schedule.tick();assert.equal(f.starts(),1);
});
test('未允许或时段外不启动，健康空闲时自动继续且两个入口不重复同时启动',async t=>{
 const f=fixture(t);f.video.savePolicy({windows:['09:00-10:00','20:00-21:00'],dailyMinutes:10,dailyRequests:30},{explicit:true});let running=false;
 const options={...f.options,getWatchState:async()=>({running}),startRound:async()=>{running=true;return f.options.startRound();}},a=new ScheduledWatch({...options,source:'api'}),b=new ScheduledWatch({...options,source:'dsh'});
 await a.tick();assert.equal(f.starts(),0);a.configure({enabled:true},{explicit:true});await a.tick();assert.equal(f.starts(),0);f.setTime('2026-10-23T01:00:00Z');await Promise.all([a.tick(),b.tick()]);assert.equal(f.starts(),1);await b.tick();assert.equal(f.starts(),1);
 running=false;await a.tick();assert.equal(f.starts(),2);assert.equal(a.state().last.status,'started');
});
test('全天按上海日期每天一轮，跨夜时段保持同一编号，周末全天单独按天处理',()=>{const all={windows:['00:00-24:00']};assert.notEqual(scheduledSlot(all,Date.parse('2026-10-23T15:59:00Z')).key,scheduledSlot(all,Date.parse('2026-10-23T16:00:00Z')).key);const night={windows:['23:00-01:00']};assert.equal(scheduledSlot(night,Date.parse('2026-10-23T15:30:00Z')).key,scheduledSlot(night,Date.parse('2026-10-23T16:30:00Z')).key);const weekend={windows:['18:00-24:00'],weekendWindows:['00:00-24:00']};assert.notEqual(scheduledSlot(weekend,Date.parse('2026-10-24T02:00:00Z')).key,scheduledSlot(weekend,Date.parse('2026-10-25T02:00:00Z')).key);});
test('启动失败保留回执，同一时段不循环重试；已有观看也不另开轮次',async t=>{const f=fixture(t);let starts=0;const schedule=new ScheduledWatch({...f.options,startRound:async()=>{starts++;throw new Error('合成模型尚未配置');}});schedule.configure({enabled:true,maxRequests:30},{explicit:true});await schedule.tick();await schedule.tick();assert.equal(starts,1);assert.equal(schedule.state().last.status,'failed');f.setTime('2026-10-24T01:00:00Z');const second=new ScheduledWatch({...f.options,getWatchState:async()=>({running:true})});await second.tick();assert.equal(second.state().last.status,'failed');assert.equal(f.starts(),0);});
test('关闭许可可撤回尚未真正启动的异步操作，损坏回执不清空、不抢占残留锁',async t=>{const f=fixture(t);let release,entered;const gate=new Promise(resolve=>{release=resolve;}),entry=new Promise(resolve=>{entered=resolve;});let started=false;const schedule=new ScheduledWatch({...f.options,startRound:async({signal})=>{entered();await gate;signal.throwIfAborted();started=true;}});schedule.configure({enabled:true,maxRequests:30},{explicit:true});const pending=schedule.tick();await entry;schedule.configure({enabled:false,maxRequests:30},{explicit:true});release();await pending;assert.equal(started,false);assert.equal(schedule.state().last.status,'failed');fs.writeFileSync(schedule.ledgerFile,'{');await schedule.tick();assert.equal(fs.readFileSync(schedule.ledgerFile,'utf8'),'{');fs.writeFileSync(schedule.guardFile,'合成残留锁');assert.throws(()=>schedule.configure({enabled:false,maxRequests:30},{explicit:true}),error=>error.code==='SCHEDULE_BUSY');assert.equal(fs.readFileSync(schedule.guardFile,'utf8'),'合成残留锁');});
test('调度接入自主观看循环，达到每日请求上限后同日不再自动启动',async t=>{const f=fixture(t);f.video.savePolicy({windows:['00:00-24:00'],dailyMinutes:10,dailyRequests:1},{explicit:true});const id='7579432563794584933',state={video:{id,title:'合成作品',time:0,duration:60,paused:false,readyState:4}};let decisions=0,paused=0;const controller={async execute(name){if(name==='douyin_observe')return{state,frames:[{videoId:id,mimeType:'image/jpeg',data:'eA=='}],personaEvidenceId:'synthetic-evidence'};return state;},async pauseForLimits(){paused++;}};
  const watch=new AutonomousWatch({controller,videoLimits:f.video,stateDir:f.stateDir,now:f.options.now,personaMemory:{context:()=>'',recordViewing:()=>null},config:{apiKey:'synthetic-key'},agent:{async decideWatch(){decisions++;return{decision:{action:'stop',reason:'合成观察已完成',reflection:'仅使用合成画面',topics:[]},usage:{totalTokens:1}};}}});
  const scheduler=new ScheduledWatch({...f.options,getWatchState:async()=>watch.state(),startRound:async()=>watch.start({startSession:true},{explicit:true})});scheduler.configure({enabled:true},{explicit:true});await scheduler.tick();await watch.completion;assert.equal(decisions,1);assert.equal(watch.state().running,false);assert.equal(f.video.state().session.startedBy,'api');assert.equal(scheduler.state().last.status,'started');await scheduler.tick();assert.equal(decisions,1);assert.ok(paused>0);await watch.close();
});
test('好友状态区分许可与运行，分享等待自主观看，续火入口已移除',()=>{const initial=interactionStatus({modelReady:true,chat:{policy:{allowlist:[{id:'synthetic'}]}},spark:{enabled:true},share:{enabled:true},comments:{enabled:true}});assert.ok(initial.rows.every(item=>!item.running));assert.match(initial.rows[0].message,/未启动/);assert.match(initial.rows[1].message,/等待自主观看/);const active=interactionStatus({modelReady:true,chat:{running:true,policy:{allowlist:[{}]}},spark:{enabled:true,running:true,inWindow:true},share:{enabled:true},comments:{enabled:true},watch:{running:true}});assert.ok(active.rows.every(item=>item.running));});


test('自动观看失败理由跨软件插件与重构实例可回读，重新明确开启后旧错误清除',async t=>{
 const f=fixture(t);const schedule=new ScheduledWatch({...f.options,startRound:async()=>{throw new Error('合成浏览器占用 https://example.invalid/work?token=synthetic-secret');}});schedule.configure({enabled:true},{explicit:true});await schedule.tick();
 const other=new ScheduledWatch({...f.options,source:'dsh'});assert.equal(other.state().last.status,'failed');assert.match(other.state().lastError,/合成浏览器占用/);assert.doesNotMatch(JSON.stringify(other.state()),/synthetic-secret/);
 other.configure({enabled:true},{explicit:true});assert.equal(other.state().lastError,'');assert.equal(schedule.state().lastError,'');assert.equal(schedule.state().last.status,'acknowledged');
});

test('启动后watch异步失败会持久显示原因，保持失败回执且不在每tick重复开新运行',async t=>{
 const f=fixture(t);let watch={running:false,status:'stopped'};const schedule=new ScheduledWatch({...f.options,getWatchState:async()=>watch});schedule.configure({enabled:true},{explicit:true});await schedule.tick();assert.equal(f.starts(),1);watch={running:false,status:'failed',lastError:'合成同一入口锁超时'};await schedule.tick();await schedule.tick();assert.equal(f.starts(),1);const other=new ScheduledWatch({...f.options,source:'dsh'});assert.equal(other.state().last.status,'failed');assert.equal(other.state().lastError,'合成同一入口锁超时');
});
