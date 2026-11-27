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

test('插件核实观看页验证通过后沿用共享排程恢复一次，保留旧回执和今日额度', async t => {
  const f = fixture(t, '2026-10-23T01:30:00Z');
  f.video.savePolicy({ windows: ['09:00-10:00'], dailyMinutes: 10, dailyRequests: 30 }, { explicit: true });
  let watch = { running: false, status: 'stopped' }, ready = false, probes = 0;
  const options = { ...f.options, getWatchState: async () => watch };
  const desktop = new ScheduledWatch(options);
  const plugin = new ScheduledWatch({
    ...options, source: 'dsh',
    async checkWatchVerification() { probes++; return ready; },
  });
  desktop.configure({ enabled: true }, { explicit: true });
  await desktop.tick();
  const first = desktop.state().last;
  f.video.reserveRequest({ source: 'api' });
  const used = f.video.state().daily.requests;
  const reason = '观看页需要抖音安全验证。';
  watch = { running: false, status: 'needs_user', sessionId: first.sessionId, lastError: reason, recovery: { action: 'verify' } };
  await desktop.tick();
  await plugin.tick();
  await plugin.tick();
  assert.equal(probes, 1);
  assert.equal(f.starts(), 1);
  const paused = plugin.state().last;
  assert.equal(paused.status, 'failed');
  assert.equal(paused.error, reason);

  ready = true;
  f.setTime('2026-10-23T01:30:15Z');
  await Promise.all([plugin.tick(), desktop.tick()]);
  assert.equal(probes, 2);
  assert.equal(f.starts(), 2);
  assert.equal(plugin.state().last.status, 'started');
  assert.equal(plugin.state().lastError, '');
  assert.equal(f.video.state().daily.requests, used);
  assert.deepEqual(plugin.policy(), { enabled: true });
  const previous = plugin.ledger().runs.find(run => run.id === first.id);
  assert.equal(previous.status, 'acknowledged');
  assert.equal(previous.error, reason);
  assert.equal(previous.recovery.code, 'WATCH_VERIFICATION_CLEARED');
});

test('验证检查期间关闭观看、离开时段或用完额度都保留原暂停', async t => {
  for (const restriction of ['关闭观看', '离开时段', '用完额度']) {
    await t.test(restriction, async t => {
      const f = fixture(t, '2026-10-23T01:30:00Z');
      f.video.savePolicy({ windows: ['09:00-10:00'], dailyRequests: 1 }, { explicit: true });
      let watch = { running: false, status: 'stopped' }, probes = 0;
      const schedule = new ScheduledWatch({
        ...f.options, source: 'dsh', getWatchState: async () => watch,
        async checkWatchVerification() {
          probes++;
          if (restriction === '关闭观看') schedule.configure({ enabled: false }, { explicit: true });
          if (restriction === '离开时段') f.setTime('2026-10-23T02:00:00Z');
          if (restriction === '用完额度') f.video.reserveRequest({ source: 'api' });
          return true;
        },
      });
      schedule.configure({ enabled: true }, { explicit: true });
      await schedule.tick();
      const reason = '观看页需要抖音安全验证。';
      watch = { running: false, status: 'needs_user', sessionId: schedule.state().last.sessionId, lastError: reason, recovery: { action: 'verify' } };
      await schedule.tick();
      const paused = schedule.state().last;
      await schedule.tick();
      assert.equal(probes, 1);
      assert.equal(f.starts(), 1);
      assert.deepEqual(schedule.state().last, paused);
    });
  }
});

test('排程锁打开遇到短暂 Windows 拒绝会在本次检查重试，只启动一次', async t => {
  const f = fixture(t), schedule = new ScheduledWatch(f.options);
  schedule.configure({ enabled: true }, { explicit: true });
  const open = fs.openSync;
  let attempts = 0;
  fs.openSync = (file, flags, ...args) => {
    if (file === schedule.guardFile && flags === 'wx' && ++attempts <= 2) {
      throw Object.assign(new Error('合成文件占用'), { code: 'EPERM', path: file });
    }
    return open(file, flags, ...args);
  };
  try { await schedule.tick(); } finally { fs.openSync = open; }
  assert.ok(attempts >= 3);
  assert.equal(f.starts(), 1);
  assert.equal(schedule.state().last.status, 'started');
  assert.equal(schedule.state().lastError, '');
  assert.equal(fs.existsSync(schedule.guardFile), false);
});

test('启动回执写入前排程锁暂时不可用，恢复后补记同一轮且另一入口不重启', async t => {
  const f = fixture(t);
  let blocked = false;
  const schedule = new ScheduledWatch({ ...f.options, startRound: async () => {
    const result = await f.options.startRound();
    blocked = true;
    return result;
  } });
  const other = new ScheduledWatch({ ...f.options, source: 'dsh' });
  schedule.configure({ enabled: true }, { explicit: true });
  const open = fs.openSync;
  fs.openSync = (file, flags, ...args) => {
    if (blocked && file === schedule.guardFile && flags === 'wx') {
      throw Object.assign(new Error('合成 Windows 路径拒绝'), { code: 'EPERM', path: file });
    }
    return open(file, flags, ...args);
  };
  try {
    await schedule.tick();
    assert.equal(f.starts(), 1);
    assert.equal(schedule.state().last.status, 'starting');
    assert.match(schedule.state().lastError, /自动再试/);
    assert.doesNotMatch(schedule.state().lastError, /EPERM|watch-schedule\.guard/);
    assert.equal(other.state().lastError, '');
  } finally { fs.openSync = open; }
  await other.tick();
  assert.equal(f.starts(), 1);
  await schedule.tick();
  assert.equal(f.starts(), 1);
  assert.equal(other.state().last.status, 'started');
  assert.equal(other.state().last.sessionId, 'synthetic-session');
  assert.equal(schedule.state().lastError, '');
});

test('排程锁释放短暂受阻时保留原所有者，下一次检查释放后补记回执', async t => {
  const f = fixture(t), schedule = new ScheduledWatch(f.options);
  schedule.configure({ enabled: true }, { explicit: true });
  const unlink = fs.unlinkSync;
  fs.unlinkSync = (file, ...args) => {
    if (file === schedule.guardFile) throw Object.assign(new Error('合成锁暂不可删除'), { code: 'EPERM', path: file });
    return unlink(file, ...args);
  };
  try {
    await schedule.tick();
    assert.equal(f.starts(), 1);
    assert.equal(schedule.state().last.status, 'starting');
    const other = new ScheduledWatch({ ...f.options, source: 'dsh' });
    assert.throws(() => other.configure({ enabled: false }, { explicit: true }), { code: 'SCHEDULE_BUSY' });
  } finally { fs.unlinkSync = unlink; }
  await schedule.tick();
  assert.equal(f.starts(), 1);
  assert.equal(schedule.state().last.status, 'started');
  assert.equal(fs.existsSync(schedule.guardFile), false);
});

test('允许时段外也会清除已恢复的旧锁错误，旧观看失败回执原样保留', async t => {
  const f = fixture(t), schedule = new ScheduledWatch(f.options);
  f.video.savePolicy({ windows: ['09:00-10:00'] }, { explicit: true });
  schedule.configure({ enabled: true }, { explicit: true });
  const runs = [{ key: 'old-slot', id: 'earlier-round', status: 'failed', error: '合成旧观看错误' }];
  fs.writeFileSync(schedule.ledgerFile, JSON.stringify({
    version: 1, runs, lastError: `EPERM: operation not permitted, open '${schedule.guardFile}'`,
  }));
  assert.match(schedule.state().lastError, /自动再试/);
  await schedule.tick();
  assert.equal(f.starts(), 0);
  assert.equal(schedule.state().lastError, '');
  assert.deepEqual(schedule.ledger().runs, runs);
});
