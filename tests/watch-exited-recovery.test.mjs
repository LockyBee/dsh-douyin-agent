import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {AutonomousWatch} from '../autonomous-watch.mjs';
import {VideoLimits} from '../video-limits.mjs';
import {ScheduledWatch} from '../scheduled-watch.mjs';
const digest=f=>createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const ID='7579432563794584933',PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGDkAAAAASUVORK5CYII=';
function fixture(t){
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'dy-exited-watch-'));let now=Date.parse('2026-11-12T10:00:00Z'),models=0;
 const video=new VideoLimits({stateDir,now:()=>now});video.savePolicy({enabled:true,windows:['00:00-24:00'],dailyRequests:400,dailyMinutes:null},{explicit:true});
 const state=()=>({url:'https://www.douyin.com/video/'+ID,video:{id:ID,readyState:4,paused:false,time:3,duration:100}});
 const controller={async execute(name){if(name==='douyin_observe')return{state:state(),frames:[{videoId:ID,mimeType:'image/png',data:PNG,time:3}],personaEvidenceId:'synthetic-evidence'};return state();},async pauseForLimits(){}};
 const watch=new AutonomousWatch({controller,config:{apiKey:'synthetic'},videoLimits:video,personaMemory:{context:()=>'',recordViewing:()=>null},agent:{async decideWatch(){models++;return{decision:{action:'stop',reason:'合成样本已读',topics:[],reflection:'只验证本地流程'}};}},stateDir,now:()=>now});
 t.after(async()=>{await watch.close();assert.equal(path.dirname(stateDir),path.resolve(os.tmpdir()));assert.match(path.basename(stateDir),/^dy-exited-watch-/);fs.rmSync(stateDir,{recursive:true,force:true});});
 const dead=spawnSync(process.execPath,['-e',''],{windowsHide:true});assert.equal(dead.status,0);assert.ok(dead.pid);
 const worker={version:1,pid:dead.pid,runId:randomUUID(),sessionId:randomUUID(),source:'dsh',status:'running',heartbeatAt:now-10000};
 const saved={status:'running',runId:worker.runId,sessionId:worker.sessionId,source:worker.source,lastError:'合成旧失败原文',lastDecision:{action:'stay'},phase:'model',pendingRequests:1};
 const seed=(pid=dead.pid)=>{worker.pid=pid;fs.writeFileSync(watch.files.lock,JSON.stringify(worker));fs.writeFileSync(watch.files.state,JSON.stringify(saved));};
 return{stateDir,watch,video,worker,saved,seed,models:()=>models,setTime:v=>{now=Date.parse(v);},now:()=>now,journal:path.join(stateDir,'watch-recovered-runs.json')};
}
test('已退出进程的观看锁自动归档恢复，原预算和旧错误留存且重复恢复无额外写入',t=>{
 const f=fixture(t);f.video.reserveRequest();f.video.reserveRequest();f.seed();fs.writeFileSync(f.watch.files.stop,JSON.stringify({runId:f.worker.runId,requestedAt:f.now()}));
 const files=['video-policy.json','watch-budget.json'].map(n=>path.join(f.stateDir,n)),before=files.map(digest),result=f.watch.recoverExitedRun();assert.equal(result.recovered,true);assert.equal(fs.existsSync(f.watch.files.lock),false);assert.equal(fs.existsSync(f.watch.files.stop),false);assert.deepEqual(files.map(digest),before);
 const journal=JSON.parse(fs.readFileSync(f.journal));assert.equal(journal.runs.length,1);assert.deepEqual(journal.runs[0].worker,f.worker);assert.deepEqual(journal.runs[0].state,f.saved);const old=digest(f.journal);assert.equal(f.watch.recoverExitedRun().recovered,false);assert.equal(digest(f.journal),old);assert.equal(f.models(),0);
});
test('存活进程及权限不明的进程不因旧心跳被接管，未清理不属于旧运行的停止请求',t=>{
 const f=fixture(t);f.seed(process.pid);const before=digest(f.watch.files.lock);assert.equal(f.watch.recoverExitedRun().recovered,false);assert.equal(digest(f.watch.files.lock),before);assert.equal(fs.existsSync(f.journal),false);
 f.seed();const kill=process.kill;process.kill=(pid,signal)=>{if(pid===f.worker.pid)throw Object.assign(new Error('合成权限拒绝'),{code:'EPERM'});return kill(pid,signal);};try{assert.equal(f.watch.recoverExitedRun().recovered,false);assert.equal(fs.existsSync(f.watch.files.lock),true);}finally{process.kill=kill;}
 const foreign={runId:randomUUID(),requestedAt:f.now()};fs.writeFileSync(f.watch.files.stop,JSON.stringify(foreign));assert.equal(f.watch.recoverExitedRun().recovered,true);assert.deepEqual(JSON.parse(fs.readFileSync(f.watch.files.stop)),foreign);
});
test('恢复日志损坏时保留旧运行锁，归档时被替换的新锁也不被删除',t=>{
 const f=fixture(t);f.seed();fs.writeFileSync(f.journal,'损坏记录');const before=digest(f.watch.files.lock);assert.throws(()=>f.watch.recoverExitedRun());assert.equal(digest(f.watch.files.lock),before);fs.unlinkSync(f.journal);
 const rename=fs.renameSync;let replaced=false;fs.renameSync=(from,to)=>{const value=rename(from,to);if(to===f.journal&&!replaced){replaced=true;fs.writeFileSync(f.watch.files.lock,JSON.stringify({...f.worker,pid:process.pid,runId:randomUUID()}));}return value;};try{assert.throws(()=>f.watch.recoverExitedRun());assert.equal(JSON.parse(fs.readFileSync(f.watch.files.lock)).pid,process.pid);}finally{fs.renameSync=rename;}
});
test('新观看及手动采样无需用户先按停止，退出记录恢复后沿用每日已用请求',async t=>{
 const f=fixture(t);f.video.reserveRequest();f.seed();const release=f.watch.claimManual('合成采样');assert.equal(fs.existsSync(f.watch.files.lock),false);await release();f.seed();f.watch.start({startSession:true},{explicit:true});await f.watch.completion;assert.equal(f.models(),1);assert.equal(f.video.state().daily.requests,2);assert.equal(f.watch.state().status,'stopped');
});
test('调度在时段外也可回收已退出运行，旧残留锁错误可恢复而其他失败不被清空',async t=>{
 const f=fixture(t);f.video.savePolicy({windows:['18:00-24:00']},{explicit:true});f.setTime('2026-11-12T07:00:00Z');f.seed();let starts=0;
 const schedule=new ScheduledWatch({stateDir:f.stateDir,now:f.now,getVideoLimits:async()=>f.video,getWatchState:async()=>f.watch.state(),recoverRound:async()=>f.watch.recoverExitedRun(),startRound:async()=>{starts++;return{sessionId:'synthetic-new'};}});schedule.configure({enabled:true},{explicit:true});
 const stale='上次自主观看留下运行锁，请先点击停止清理残留。';fs.writeFileSync(schedule.ledgerFile,JSON.stringify({version:1,runs:[{id:'old',key:'old-slot',status:'failed',error:stale},{id:'other',key:'other-slot',status:'failed',error:'合成验证码失败'}],lastError:stale}));await schedule.tick();assert.equal(starts,0);assert.equal(fs.existsSync(f.watch.files.lock),false);const history=schedule.ledger();assert.equal(history.runs[0].status,'acknowledged');assert.equal(history.runs[0].error,stale);assert.equal(history.runs[1].status,'failed');assert.equal(history.runs[1].error,'合成验证码失败');f.setTime('2026-11-12T10:00:00Z');await schedule.tick();assert.equal(starts,1);await schedule.close();
});
