import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomousWatch } from '../autonomous-watch.mjs';
import { createHash } from 'node:crypto';
import { ApiAgent, parseWatchDecision, watchDecisionMessages } from '../api-agent.mjs';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';
import { MemoryStore } from '../memory.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGDkAAAAASUVORK5CYII=';
const choice = (action = 'stop', extra = {}) => ({ action, reason: '根据当前合成画面选择。', reflection: '有限采样显示猫咪，这是代理兴趣。', topics: [{ topic: '猫咪', signal: 'like' }], ...extra });
async function waitForProvider(watch, entered) {
  await Promise.race([
    entered,
    watch.completion.then(() => { throw new Error(`自主观看在进入合成模型前提前结束：${JSON.stringify(watch.state())}`); }),
  ]);
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-watch-')); let clock = Date.parse('2026-10-15T02:00:00Z'), id = '7579432563794584933', time = 0;
  const stateDir = path.join(root, 'state'), memoryDir = path.join(root, 'memory');
  const personaMemory = new PersonaMemory({ memoryDir, legacyRoleCardFile: path.join(root, 'absent-legacy.md'), clock: () => clock });
  const videoLimits = new VideoLimits({ stateDir, now: () => clock });
  fs.mkdirSync(memoryDir, { recursive: true }); const memory = new MemoryStore(path.join(memoryDir, 'shared.sqlite'), { qqMemoryPath: null });
  const calls = [], events = []; let paused = 0, provider = async () => ({ text: JSON.stringify(choice()), usage: { total_tokens: 5 } });
  const state = () => ({ url: `https://www.douyin.com/video/${id}`, loginRequired: false, verificationRequired: false, privateChatVisible: false, video: { id, url: `https://www.douyin.com/video/${id}`, title: '合成猫咪视频', author: '合成作者', time, duration: 100, readyState: 4, paused: false } });
  const controller = { execute: async (name, args, options) => {
    calls.push({ name, args, options }); options.signal?.throwIfAborted();
    if (name === 'douyin_next') { id = String(BigInt(id) + 1n); time = 0; return { changed: true, state: state() }; }
    if (name === 'douyin_search') return { ...state(), searchResults: [{ index: 2, id: '7579432563794584939' }] };
    if (name === 'douyin_open_video') { id = '7579432563794584939'; time = 0; return state(); }
    if (name === 'douyin_observe') { time += 3; clock += 3000; const current = state(); memory.recordVideo(current, 'api'); return { state: current, frames: [{ mimeType: 'image/png', data: PNG, videoId: id, time }], observation: { videoId: id, seconds: 3 } }; }
    return state();
  }, pauseForLimits: async () => { paused++; return { paused: 1 }; } };
  const options = { controller, config: { apiKey: 'synthetic-key', baseUrl: 'https://synthetic.example', model: 'synthetic' }, videoLimits, personaMemory, stateDir, now: () => clock, decisionProvider: input => provider(input), delayImpl: async (ms, signal) => { signal.throwIfAborted(); clock += ms; time += ms / 1000; }, onEvent: event => events.push(event) };
  const watch = new AutonomousWatch(options), instances = [watch];
  t.after(async () => { for (const instance of instances) await instance.close(); memory.close(); const target = path.resolve(root); if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界。'); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, watch, options, controller, videoLimits, personaMemory, memory, calls, events, state, paused: () => paused, now: () => clock, advance: ms => { clock += ms; }, provider: value => { provider = value; }, other: source => { const instance = new AutonomousWatch({ ...options, source }); instances.push(instance); return instance; } };
}
test('失败换片在自主观看停止前保存去敏诊断，API状态可读取且保留原失败门禁',async t=>{
 const f=fixture(t),execute=f.controller.execute;f.provider(async()=>({text:JSON.stringify(choice('skip'))}));f.controller.execute=async(name,...rest)=>name==='douyin_next'?{changed:false,reasonCode:'switch-control-not-interactable',before:{...f.state().video,viewport:{x:10,y:20,width:400,height:500}},after:f.state().video,state:{...f.state(),pageKind:'video',videoSelection:{candidateCount:2,ambiguous:true,identityConflict:false}},frames:[{data:'不应记录的图像'}],privateText:'不应记录的正文'}:execute(name,...rest);f.watch.start({startSession:true},{explicit:true});await f.watch.completion;assert.equal(f.watch.state().status,'failed');assert.match(f.watch.state().lastError,/未确认切换/);const saved=JSON.parse(fs.readFileSync(f.watch.files.state,'utf8')).lastSwitchDiagnostic;assert.equal(saved.reasonCode,'switch-control-not-interactable');assert.equal(saved.selection.candidateCount,2);assert.equal(saved.after.readyState,4);assert.equal(saved.before.viewport.width,400);assert.equal(saved.before.idHash,createHash('sha256').update(f.state().video.id).digest('hex'));assert.deepEqual(f.watch.state().lastSwitchDiagnostic,saved);const text=JSON.stringify(saved);for(const value of [f.state().video.id,'https://','合成猫咪视频','合成作者','不应记录','frames','privateText'])assert.equal(text.includes(value),false,value);assert.ok(text.length<4096);assert.equal(f.calls.filter(item=>item.name==='douyin_next').length,0);
});
function directFixture(output){let saved={},clock=1000,writes=0;const watch=Object.create(AutonomousWatch.prototype);Object.assign(watch,{config:{},source:'api',runId:'synthetic-run',abort:new AbortController(),now:()=>clock,worker:()=>({owned:true}),assertAllowed:()=>{},save:value=>{writes++;Object.assign(saved,value);},videoLimits:{notePlayback:()=>{}},controller:{execute:async()=>output},onEvent:()=>{}});return{watch,saved,writes:()=>writes,advance:value=>clock+=value};}
test('诊断只保留最近失败一份，成功及普通工具不会清除或扩大历史',async()=>{
 const f=directFixture({changed:false,reasonCode:'switch-not-confirmed',state:{video:{id:'7579432563794584933',readyState:1}}});await f.watch.execute('douyin_next');const first=structuredClone(f.saved);f.watch.controller.execute=async()=>({changed:true,state:{video:{id:'7579432563794584934',readyState:4}}});await f.watch.execute('douyin_next');await f.watch.execute('douyin_screenshot');assert.equal(f.writes(),1);assert.deepEqual(f.saved,first);f.advance(100);f.watch.controller.execute=async()=>({changed:false,reasonCode:'video-identity-not-ready'});await f.watch.execute('douyin_previous');assert.equal(f.writes(),2);assert.equal(f.saved.lastSwitchDiagnostic.tool,'douyin_previous');assert.equal(Object.keys(f.saved).length,1);
});
test('换片异常只记录有界错误码，不保存错误原文；失去owner不覆盖别的运行',async()=>{
 const f=directFixture(null),error=Object.assign(Error('含平台ID与私密正文7579432563794584933'),{code:'SWITCH_TEST_ERROR'});f.watch.controller.execute=async()=>{throw error;};await assert.rejects(f.watch.execute('douyin_next'),value=>value===error);assert.equal(f.saved.lastSwitchDiagnostic.reasonCode,'SWITCH_TEST_ERROR');assert.equal(JSON.stringify(f.saved).includes(error.message),false);f.watch.worker=()=>({owned:false});await assert.rejects(f.watch.execute('douyin_next'));assert.equal(f.writes(),1);
});
test('异常字段不会突破诊断上限，不复制任意控制器字段',async()=>{
 const f=directFixture({changed:false,reasonCode:'私密'.repeat(10000),state:{video:{id:'不是平台ID',readyState:900,time:Infinity,duration:-1,viewport:{x:Infinity,y:-Infinity,width:1e100,height:-2},title:'私密'.repeat(10000)},videoSelection:{candidateCount:1e20,ambiguous:true},unknown:'不可保存'}});await f.watch.execute('douyin_next',{}, {expectedVideoId:'不应输出'});const d=f.saved.lastSwitchDiagnostic;assert.equal(d.reasonCode,null);assert.equal(d.expectedVideoIdHash,null);assert.equal(d.after.idHash,null);assert.equal(d.after.readyState,null);assert.equal(d.selection.candidateCount,null);assert.ok(JSON.stringify(d).length<4096);assert.equal(JSON.stringify(d).includes('私密'),false);
});
test('诊断写入或观察器故障不改变原换片结果或原始异常',async()=>{
 const output={changed:false,reasonCode:'switch-not-confirmed'},f=directFixture(output);f.watch.save=()=>{throw Error('合成诊断IO故障');};f.watch.onEvent=event=>{if(event.type==='watch.diagnostic_failed')throw Error('合成诊断观察器故障');};assert.equal(await f.watch.execute('douyin_next'),output);const original=Error('合成原换片异常');f.watch.worker=()=>{throw Error('合成owner读取故障');};f.watch.controller.execute=async()=>{throw original;};await assert.rejects(f.watch.execute('douyin_next'),error=>error===original);
});
test('changed为真但最终未就绪或同ID，以及live回读后变化，仍在聚合失败前记录诊断',async t=>{
 for(const mode of ['same-id','not-ready','post-live-change']){const f=fixture(t),execute=f.controller.execute;f.provider(async()=>({text:JSON.stringify(choice('skip'))}));f.controller.execute=async(name,...rest)=>{if(name!=='douyin_next')return execute(name,...rest);return{changed:true,state:{...f.state(),video:{...f.state().video,id:mode==='same-id'?f.state().video.id:'7579432563794584999',readyState:mode==='not-ready'?1:4}}};};if(mode==='post-live-change')f.watch.skipLivePreviews=async value=>value.changed===true?({...value,state:{...value.state,video:{...value.state.video,id:f.state().video.id}}}):value;f.watch.start({startSession:true},{explicit:true});await f.watch.completion;assert.equal(f.watch.state().status,'failed',mode);const diagnostic=f.watch.state().lastSwitchDiagnostic;assert.equal(diagnostic.stage,'autonomous-verification',mode);assert.equal(diagnostic.reasonCode,mode==='not-ready'?'autonomous-switch-not-ready':'autonomous-switch-same-id',mode);assert.equal(diagnostic.changed,true,mode);}
});
test('API状态对白名单外旧诊断字段及非法hash重新过滤，不回传原始状态对象',async t=>{
 const f=fixture(t);f.watch.start({startSession:true},{explicit:true});await f.watch.completion;f.watch.save({lastSwitchDiagnostic:{version:1,kind:'video-switch-failure',tool:'douyin_next',stage:'autonomous-verification',at:'2026-10-28T00:00:00Z',source:'api',runIdHash:'不应输出',expectedVideoIdHash:'7579432563794584933',reasonCode:'switch-not-confirmed',before:{idHash:'7579432563794584933',title:'私密正文',url:'https://private.invalid'},frames:['私密图像'],privateText:'私密正文'}});const diagnostic=f.watch.state().lastSwitchDiagnostic,text=JSON.stringify(diagnostic);assert.equal(diagnostic.runIdHash,null);assert.equal(diagnostic.expectedVideoIdHash,null);assert.equal(diagnostic.before.idHash,null);for(const value of ['私密','https://','7579432563794584933','frames','privateText'])assert.equal(text.includes(value),false,value);assert.ok(text.length<4096);f.watch.save({lastSwitchDiagnostic:{version:2,kind:'arbitrary',secret:'私密正文'}});assert.equal(f.watch.state().lastSwitchDiagnostic,null);
});
