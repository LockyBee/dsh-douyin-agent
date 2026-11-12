import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomousWatch } from '../autonomous-watch.mjs';
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

test('冷启动从空白加载页有界等待到就绪，再观察和请求模型', async t => {
  const f = fixture(t), original = f.controller.execute; let statuses = 0, observations = 0;
  f.controller.execute = async (...args) => {
    if (args[0] === 'douyin_status' && ++statuses < 5) return { url: 'about:blank', unsupportedPage: true };
    if (args[0] === 'douyin_open') return { url: 'https://www.douyin.com/jingxuan', video: null };
    if (args[0] === 'douyin_observe') observations++;
    return original(...args);
  };
  const before = f.now(); f.watch.start({ startSession: true, maxRequests: 1 }, { explicit: true }); await f.watch.completion;
  assert.equal(f.watch.state().status, 'stopped'); assert.equal(observations, 1); assert.equal(f.watch.state().counts.requests, 1); assert.ok(f.now() - before >= 2000);
});
test('冷启动持续加载最多30秒且不调用模型，验证码与外站立即停止', async t => {
  for (const mode of ['loading', 'verification', 'foreign']) {
    const f = fixture(t), before = f.now(); let calls = 0;
    f.controller.execute = async () => { calls++; return { url: mode === 'foreign' ? 'https://example.invalid/' : 'https://www.douyin.com/jingxuan', video: null, verificationRequired: mode === 'verification' }; };
    f.watch.start({ startSession: true, maxRequests: 1 }, { explicit: true }); await f.watch.completion;
    assert.equal(f.watch.state().status, 'needs_user'); assert.equal(f.watch.state().counts.requests, 0);
    if (mode === 'loading') { assert.equal(f.now() - before, 30_000); assert.ok(calls <= 63); } else assert.ok(calls <= 2);
  }
});

test('跨上海午夜结束的一轮分别保留开始日与结束日的事实日报', async t => {
  const f = fixture(t);
  f.advance(Date.parse('2026-10-15T15:59:58Z') - f.now());
  f.personaMemory.initialize({ importLegacy: false });
  f.personaMemory.recordObservation(f.state(), { source: 'api', kind: 'dom' });
  f.watch.start({ startSession: true }, { explicit: true }); await f.watch.completion;
  const dates = f.watch.reportService.state().reports.map(item => item.date);
  assert.ok(dates.includes('2026-10-15')); assert.ok(dates.includes('2026-10-16'));
  assert.equal(f.watch.reportService.read({ date: '2026-10-15' }).observedCount, 1);
});

test('默认停止且允许关闭不能启动，允许后可自动建立内部运行', async t => {
  const f = fixture(t); assert.equal(f.watch.state().running, false); assert.equal(f.calls.length, 0);
  assert.throws(() => f.watch.start({startSession:false}, { explicit: true }), /关闭/); assert.throws(() => f.watch.start({ startSession: true }), /明确启动/);
  const session = f.videoLimits.markSession('api', { explicit: true });
  f.watch.start({ startSession: true, maxRequests: 1 }, { explicit: true }); await f.watch.completion;
  assert.equal(f.videoLimits.state().session.id, session.session.id); assert.equal(f.videoLimits.state().session.expiresAt, session.session.expiresAt); assert.equal(f.watch.state().counts.requests, 1, JSON.stringify({state:f.watch.state(),events:f.events.slice(-3)})); assert.equal(f.paused(), 1);
});

test('真实采样结果先进入共同证据，再结构化选择搜索/停留/跳过，兴趣与SQLite笔记均可回读', async t => {
  const f = fixture(t), queue = [choice('search', { query: '猫咪' }), choice('stay', { seconds: 2 }), choice('skip'), choice('stop')], requests = [];
  f.provider(async input => { requests.push(input); return { text: JSON.stringify(queue.shift()), usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }; });
  f.watch.start({ startSession: true, maxRequests: 5 }, { explicit: true }); await f.watch.completion;
  assert.equal(f.watch.state().counts.requests, 4, JSON.stringify(f.watch.state())); assert.equal(f.watch.state().status, 'stopped');
  assert.deepEqual(f.calls.filter(call => ['douyin_search', 'douyin_open_video', 'douyin_next'].includes(call.name)).map(call => [call.name, call.args]), [['douyin_search', { query: '猫咪' }], ['douyin_open_video', { index: 2 }], ['douyin_next', {}]]);
  assert.ok(f.calls.every(call => typeof call.options.autonomousRunId === 'string'));
  assert.ok(requests[0].messages[1].content.some(item => item.type === 'image_url')); assert.equal(requests[0].messages.some(message => message.role === 'tool'), false);
  assert.match(requests[1].messages[1].content[0].text, /猫咪/);
  const learned = f.personaMemory.snapshot(); assert.equal(learned.interests[0].topic, '猫咪'); assert.equal(learned.interests[0].evidence.length, 1); assert.equal(learned.interests[0].signal, 'like'); assert.equal(learned.interests[0].evidence[0].watchedSeconds, 8); assert.equal(learned.userPreferences.length, 0);
  assert.ok(f.memory.recall({ query: '猫咪' }).entries.length >= 1); assert.equal(JSON.stringify(f.events).includes(PNG), false);
});

test('观看动作忽略多余时长，超长停留建议实际只执行十秒并按原预算停止', async t => {
  const f = fixture(t), queue = [
    choice('skip', { query: '', seconds: 30, recipientId: null }),
    choice('stay', { query: null, seconds: 600, recipientId: '' }),
    choice('search', { query: '猫咪', seconds: 90, recipientId: null }),
    choice('stop', { query: '  ', seconds: 100, recipientId: ' ' }),
  ];
  const waits = [], delayImpl = f.watch.delayImpl;
  f.watch.delayImpl = async (ms, signal) => { waits.push(ms); return delayImpl(ms, signal); };
  f.provider(async () => ({ text: JSON.stringify(queue.shift()), usage: { total_tokens: 5 } }));
  f.watch.start({ startSession: true, maxRequests: 4 }, { explicit: true }); await f.watch.completion;
  assert.equal(f.watch.state().status, 'stopped');
  assert.equal(f.watch.state().counts.requests, 4);
  assert.equal(f.calls.filter(call => call.name === 'douyin_next').length, 1);
  assert.deepEqual(waits, [10_000]);
  assert.equal(f.events.filter(event => event.type === 'watch.decision').length, 4);
  assert.equal(f.events.find(event => event.type === 'watch.decision' && event.decision.action === 'stay').decision.seconds, 10);
  assert.equal(f.paused(), 1);
});

test('模型JSON漏写停留时长时宿主默认三秒，随后停止仍保留同轮请求预算', async t => {
  const f = fixture(t), queue = [choice('stay'), choice('stop')], waits = [], delayImpl = f.watch.delayImpl;
  f.watch.delayImpl = async (ms, signal) => { waits.push(ms); return delayImpl(ms, signal); };
  f.provider(async () => {
    const value = queue.shift();
    assert.equal(Object.hasOwn(value, 'seconds'), false);
    return { text: JSON.stringify(value), usage: { total_tokens: 5 } };
  });
  f.watch.start({ startSession: true, maxRequests: 2 }, { explicit: true });
  const session = f.videoLimits.state().session;
  await f.watch.completion;
  assert.equal(f.watch.state().status, 'stopped');
  assert.deepEqual(waits, [3000]);
  assert.equal(f.watch.state().counts.requests, 2);
  assert.equal(f.watch.state().counts.maxRequests, null);
  assert.equal(f.videoLimits.state().session.id, session.id);
  assert.equal(f.videoLimits.state().session.expiresAt, session.expiresAt);
  assert.equal(f.watch.state().counts.dailyRequests,2);assert.equal(f.watch.state().counts.dailyLimit,30);
  assert.equal(f.events.find(event => event.type === 'watch.decision' && event.decision.action === 'stay').decision.seconds, 3);
  assert.equal(f.paused(), 1);
});

test('仅移除不适用于当前动作的空值，不改写调用方数据或有效动作参数', () => {
  for (const [action, extra] of [
    ['skip', { query: '', seconds: 0, recipientId: null }],
    ['stop', { query: null, seconds: null, recipientId: '  ' }],
    ['search', { query: '猫咪', seconds: 0, recipientId: '' }],
    ['stay', { query: ' ', seconds: 2, recipientId: null }],
  ]) {
    const raw = Object.freeze(choice(action, extra)), before = JSON.stringify(raw);
    const expected = choice(action, action === 'search' ? { query: '猫咪' } : action === 'stay' ? { seconds: 2 } : {});
    assert.deepEqual(parseWatchDecision(raw), expected);
    assert.deepEqual(parseWatchDecision(JSON.stringify(raw)), expected);
    assert.equal(JSON.stringify(raw), before);
  }
});

test('时长兼容只接受安全整数，不允许非法类型、越权联系人或未知字段', () => {
  assert.equal(parseWatchDecision(choice('stay')).seconds, 3);
  assert.equal(parseWatchDecision(choice('stay', { seconds: undefined })).seconds, 3);
  for (const seconds of [null, 0, -1, 1.5, '', '2', false, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseWatchDecision(choice('stay', { seconds, query: null, recipientId: '' })), /1至10秒/);
  }
  for (const seconds of [1, 10, 11, 600, Number.MAX_SAFE_INTEGER]) assert.equal(parseWatchDecision(choice('stay', { seconds })).seconds, Math.min(seconds, 10));
  for (const action of ['skip', 'search', 'stop']) {
    for (const seconds of [0, 10, 600, Number.MAX_SAFE_INTEGER]) {
      const value = choice(action, { seconds, ...(action === 'search' ? { query: '猫咪' } : {}) });
      assert.equal(Object.hasOwn(parseWatchDecision(value), 'seconds'), false);
    }
  }
  for (const extra of [{ seconds: -1 }, { seconds: 1.5 }, { seconds: '0' }, { seconds: false }, { seconds: '' }, { seconds: NaN }, { seconds: Infinity }, { seconds: Number.MAX_SAFE_INTEGER + 1 }, { query: {} }, { query: '猫'.repeat(101) }, { recipientId: `conv:${'a'.repeat(64)}` }, { url: null }]) {
    assert.throws(() => parseWatchDecision(choice('skip', extra)));
  }
  for (const query of [undefined, null, '', ' ']) assert.throws(() => parseWatchDecision(choice('search', { query, seconds: 0 })), /关键词/);
});

test('skip、stay与stop忽略模型多带的短搜索词，搜索参数及外发权限仍校验', () => {
  for (const action of ['skip', 'stay', 'stop']) {
    const value = Object.freeze(choice(action, { query: '模型多带的搜索词' }));
    const parsed = parseWatchDecision(value);
    assert.equal(parsed.action, action);
    assert.equal(Object.hasOwn(parsed, 'query'), false);
    assert.equal(value.query, '模型多带的搜索词');
    assert.throws(() => parseWatchDecision({ ...value, recipientId: `conv:${'a'.repeat(64)}` }), /许可好友/);
  }
  for (const query of [null, '', ' ', '猫'.repeat(101)]) assert.throws(() => parseWatchDecision(choice('search', { query })), /关键词/);
  assert.throws(() => parseWatchDecision(choice('share', { query: '猫咪', recipientId: `conv:${'a'.repeat(64)}` })), /关键词/);
  assert.throws(() => parseWatchDecision(choice('comment', { query: '猫咪' })), /关键词/);
});

test('旧换片回执changed为空时，以不同且就绪的作品ID确认，未换片或未就绪仍停止', async t => {
  for (const mode of ['different', 'same', 'unready']) {
    const f = fixture(t), execute = f.controller.execute;
    const queue = [choice('skip', { query: '多余词' }), choice('stop')];
    f.provider(async () => ({ text: JSON.stringify(queue.shift()) }));
    f.controller.execute = async (name, ...rest) => {
      const before = f.state();
      const result = await execute(name, ...rest);
      if (name !== 'douyin_next') return result;
      return { ...result, changed: null, state: mode === 'same' ? before : mode === 'unready' ? { ...result.state, video: { ...result.state.video, readyState: 1 } } : result.state };
    };
    f.watch.start({ startSession: true, maxRequests: 2 }, { explicit: true }); await f.watch.completion;
    assert.equal(f.watch.state().status, mode === 'different' ? 'stopped' : 'failed');
    assert.equal(f.watch.state().counts.requests, mode === 'different' ? 2 : 1);
  }
});

test('skip通过内部controls绑定观察作品，等待后读到新片才继续且不把控制字段交工具参数', async t => {
  const f = fixture(t), execute = f.controller.execute, expectedVideoId = f.state().video.id, queue = [choice('skip'), choice('stop')];
  f.provider(async () => ({ text: JSON.stringify(queue.shift()) }));
  f.controller.execute = async (name, args, controls) => { if (name === 'douyin_next') { assert.equal(controls.expectedVideoId, expectedVideoId); assert.deepEqual(args, {}); await new Promise(resolve => setTimeout(resolve, 20)); } return execute(name, args, controls); };
  f.watch.start({ startSession: true }, { explicit: true }); await f.watch.completion;
  assert.equal(f.watch.state().status, 'stopped'); assert.equal(f.watch.state().counts.requests, 2); assert.equal(f.calls.filter(item => item.name === 'douyin_next').length, 1); assert.equal(f.calls.filter(item => item.name !== 'douyin_next').some(item => item.options.expectedVideoId !== undefined), false);
});

const liveState = (roomId = '12345678') => ({ url: 'https://www.douyin.com/?recommend=1', video: null, pageKind: 'live-preview', livePreview: { recognized: true, source: 'active-feed-live-link', scope: 'recommend-feed', roomId } });

test('无地址的明确直播预览先核对标识跳过，不请求模型或记作兴趣',async t=>{
  const f=fixture(t),execute=f.controller.execute;let preview=true,modelCalls=0;
  f.controller.execute=async(name,args,controls)=>{if(preview){if(name==='douyin_next'){assert.deepEqual(args,{});assert.equal(controls.expectedLivePreviewKey,'1234567890abcdef');assert.equal(controls.enterLive,undefined);preview=false;return execute(name,args,controls);}assert.equal(name,'douyin_status');return{...liveState(),livePreview:{recognized:true,source:'active-feed-live-status',scope:'recommend-feed',roomId:null,previewKey:'1234567890abcdef'}};}return execute(name,args,controls);};
  f.provider(async()=>{modelCalls++;return{text:JSON.stringify(choice('stop'))};});
  f.watch.start({startSession:true},{explicit:true});await f.watch.completion;
  assert.equal(f.watch.state().status,'stopped');assert.equal(modelCalls,1);assert.equal(f.events.filter(e=>e.type==='watch.live-preview-skipped').length,1);assert.equal(f.events.find(e=>e.type==='watch.live-preview-skipped').learned,false);
});

test('图文由模型选择停留和换作品，不启动视频播放或伪造偏好学习',async t=>{
  const f=fixture(t),execute=f.controller.execute;let image=true,requests=0,photoPlay=0;const recorded=[];
  const photo=()=>({url:'https://www.douyin.com/?recommend=1',pageKind:'image-post',video:null,imagePost:{id:'7579432563794584937',source:'active-image-element',recognized:true,loaded:true,title:'合成图文',viewport:{x:0,y:0,width:320,height:420}}});
  const record=f.personaMemory.recordObservation.bind(f.personaMemory);f.personaMemory.recordObservation=(observation,...args)=>{recorded.push(observation.state?.pageKind||'video');return record(observation,...args);};
  f.controller.execute=async(name,...args)=>{if(image){if(name==='douyin_play')photoPlay++;if(name==='douyin_next'){image=false;return execute(name,...args);}if(name==='douyin_observe')return{state:photo(),frames:[{mimeType:'image/png',data:PNG,videoId:photo().imagePost.id,time:null,mediaKind:'image-post'}],observation:{videoId:photo().imagePost.id,workKind:'image-post'}};return photo();}return execute(name,...args);};
  f.provider(async()=>({text:JSON.stringify(++requests===1?choice('stay',{seconds:2}):requests===2?choice('skip'):choice('stop'))}));
  f.watch.start({startSession:true,maxRequests:4},{explicit:true});await f.watch.completion;
  assert.equal(f.watch.state().status,'stopped');assert.equal(requests,3);assert.equal(photoPlay,0);assert.equal(recorded.includes('image-post'),false);assert.equal(f.events.filter(e=>e.type==='watch.image-post').length,2);
});

test('视频后切入图文仍继续观察，不因没有video.id结束整轮',async t=>{
  const f=fixture(t),execute=f.controller.execute;let image=false,requests=0;
  const photo=()=>({url:'https://www.douyin.com/?recommend=1',pageKind:'image-post',video:null,imagePost:{id:'7579432563794584937',source:'active-image-element',recognized:true,loaded:true,title:'合成图文',viewport:{x:0,y:0,width:320,height:420}}});
  f.controller.execute=async(name,...args)=>{if(name==='douyin_next'){image=true;return{changed:true,state:photo()};}if(image){if(name==='douyin_observe')return{state:photo(),frames:[{mimeType:'image/png',data:PNG,videoId:photo().imagePost.id,time:null,mediaKind:'image-post'}],observation:{videoId:photo().imagePost.id,workKind:'image-post'}};return photo();}return execute(name,...args);};
  f.provider(async()=>({text:JSON.stringify(++requests===1?choice('skip'):choice('stop'))}));
  f.watch.start({startSession:true,maxRequests:3},{explicit:true});await f.watch.completion;assert.equal(f.watch.state().status,'stopped');assert.equal(requests,2);
});

test('连续四个不同且已核实的直播预览后仍能继续看作品',async t=>{
  const f=fixture(t),execute=f.controller.execute;let skipped=0;
  f.controller.execute=async(name,...args)=>{if(skipped<4&&name==='douyin_status')return liveState(String(12345678+skipped));if(skipped<4&&name==='douyin_next'){skipped++;return skipped<4?{changed:true,state:liveState(String(12345678+skipped))}:execute(name,...args);}return execute(name,...args);};
  f.watch.start({startSession:true,maxRequests:1},{explicit:true});await f.watch.completion;assert.equal(f.watch.state().status,'stopped');assert.equal(skipped,4);assert.equal(f.watch.state().counts.requests,1);
});

test('推荐流直播入口在平台回到普通作品时继续观察，不在无实际直播画面时调用模型', async t => {
  const f = fixture(t), execute = f.controller.execute;
  let showingLive = true;
  f.controller.execute = async (name, ...rest) => {
    if (showingLive && name === 'douyin_status') return liveState();
    if (showingLive && name === 'douyin_observe') throw new Error('不应采集直播');
    if (showingLive && name === 'douyin_next') { showingLive = false; const result = await execute(name, ...rest); return { ...result, changed: null }; }
    return execute(name, ...rest);
  };
  f.watch.start({ startSession: true, maxRequests: 1 }, { explicit: true }); await f.watch.completion;
  assert.equal(f.watch.state().status, 'stopped');
  assert.equal(f.watch.state().counts.requests, 1);
  assert.equal(f.calls.filter(call => call.name === 'douyin_next').length, 1);
  assert.equal(f.calls.filter(call => call.name === 'douyin_observe').length, 1);
  assert.equal(f.calls.some(call => call.name === 'douyin_open'), false);
  assert.equal(f.calls.filter(call=>call.name==='douyin_next'&&call.options.enterLive===true).length,1);
});

test('图文由模型连续翻完三页，也可主动提前停止，页数不写成视频完播率',async t=>{
 for(const stopEarly of [false,true]){const f=fixture(t);let page=1;const choices=stopEarly?['stop']:['next_image','next_image','stop'];const image=()=>({url:'https://www.douyin.com/note/7579432563794584933',pageKind:'image-post',video:null,imagePost:{id:'7579432563794584933',recognized:true,source:'active-image-element',loaded:true,imageKey:'page'+page,album:{index:page,total:3,hasNext:page<3,atEnd:page===3}}});
 f.controller.execute=async(name,args,options)=>{f.calls.push({name,args,options});if(name==='douyin_next'){assert.equal(options.advanceImage,true);assert.equal(options.expectedImageKey,'page'+page);page++;return{changed:true,pageChanged:true,state:image()};}if(name==='douyin_observe')return{state:image(),frames:[{mimeType:'image/png',data:PNG,videoId:image().imagePost.id,time:null,mediaKind:'image-post',imageKey:'page'+page}],observation:{videoId:image().imagePost.id,workKind:'image-post',imageKey:'page'+page}};return image();};let decisions=0;f.provider(async()=>({text:JSON.stringify(choice(choices[decisions++]))}));f.watch.start({}, {explicit:true});await f.watch.completion;assert.equal(f.watch.state().status,'stopped');assert.equal(page,stopEarly?1:3);assert.equal(decisions,stopEarly?1:3);assert.equal(f.personaMemory.snapshot().recentObservations.length,0);assert.equal(f.calls.some(c=>c.name==='douyin_play'),false);}
});

test('直播进入后模型选择停留再退出，同一观看预算内接着看普通作品且不外发',async t=>{
 const f=fixture(t),original=f.controller.execute;let mode='preview',liveTime=0,decision=0;const roomId='12345678',room=()=>({url:'https://live.douyin.com/'+roomId,pageKind:'live-room',video:{id:null,paused:false,readyState:4,time:liveTime,duration:null},liveRoom:{recognized:true,source:'direct-live-url-and-player',roomId,ended:false,video:{readyState:4,paused:false,time:liveTime,width:320,height:420}}});
 f.controller.execute=async(name,args,options)=>{if(mode==='video')return original(name,args,options);f.calls.push({name,args,options});if(name==='douyin_next'){if(options.enterLive){mode='room';return{changed:true,enteredLive:true,state:room()};}assert.equal(options.exitLive,true);mode='video';return{changed:true,exitedLive:true,state:f.state()};}if(name==='douyin_observe'){assert.equal(mode,'room');liveTime+=3;const id='live:'+roomId;return{state:room(),frames:[{mimeType:'image/png',data:PNG,videoId:id,time:liveTime-2,mediaKind:'live'},{mimeType:'image/png',data:PNG,videoId:id,time:liveTime,mediaKind:'live'}],observation:{videoId:id,workKind:'live',roomId,decodedFramesAdded:3}};}return mode==='preview'?liveState():room();};
 f.provider(async()=>({text:JSON.stringify([choice('stay',{seconds:2}),choice('skip'),choice('stop')][decision++])}));f.watch.start({}, {explicit:true});await f.watch.completion;assert.equal(f.watch.state().status,'stopped');assert.equal(decision,3);assert.equal(f.watch.state().counts.requests,3);assert.equal(f.calls.filter(c=>c.options.enterLive).length,1);assert.equal(f.calls.filter(c=>c.options.exitLive).length,1);assert.equal(f.events.filter(e=>e.type==='watch.live-room').length,2);assert.equal(f.personaMemory.snapshot().recentObservations.length,1);
});

test('直播换片未变化、验证码或缺少明确直播证据时不重复输入或调用模型', async t => {
  for (const mode of ['endless', 'verification', 'unknown']) {
    const f = fixture(t); let nexts = 0, requests = 0;
    f.provider(async () => { requests++; return { text: JSON.stringify(choice()) }; });
    f.controller.execute = async name => {
      if (name === 'douyin_next') nexts++;
      return mode === 'unknown' ? { video: null, pageKind: 'unknown', url: 'https://www.douyin.com/?recommend=1' }
        : { ...liveState('12345678'), ...(mode === 'verification' ? { verificationRequired: true } : {}) };
    };
    f.watch.start({ startSession: true, maxRequests: 1 }, { explicit: true }); await f.watch.completion;
    assert.equal(f.watch.state().status, 'needs_user');
    assert.equal(nexts, mode === 'endless' ? 1 : 0);
    assert.equal(requests, 0);
    assert.equal(f.watch.state().counts.requests, 0);
  }
});

test('时长错误只诊断动作及数字或类型，不包含理由、人格或字符串原值', () => {
  const privateText = '合成私人资料不得写入诊断';
  for (const [seconds, expected] of [[0, 'number:0'], [-1, 'number:-1'], [1.5, 'number:1.5'], [NaN, 'number:NaN'], [privateText, 'string'], [{ privateText }, 'object']]) {
    assert.throws(() => parseWatchDecision(choice('stay', { seconds, reason: privateText, reflection: privateText })), error => {
      assert.match(error.message, /action=stay/);
      assert.ok(error.message.includes(`seconds=${expected}`));
      assert.equal(error.message.includes(privateText), false);
      return true;
    });
  }
});

test('空字段兼容后分享和评论仍要求有效许可与剩余额度', () => {
  const recipientId = `conv:${'a'.repeat(64)}`;
  const shareContext = { enabled: true, paused: false, dailyRemaining: 1, recipients: [{ id: recipientId, name: '合成许可好友' }] };
  const share = choice('share', { query: null, seconds: 0, recipientId });
  assert.equal(parseWatchDecision(share, { shareContext }).recipientId, recipientId);
  for (const seconds of [1, 10, 600]) assert.throws(() => parseWatchDecision({ ...share, seconds }, { shareContext }), /1至10秒/);
  for (const permission of [undefined, { ...shareContext, enabled: false }, { ...shareContext, paused: true }, { ...shareContext, dailyRemaining: 0 }]) {
    assert.throws(() => parseWatchDecision(share, { shareContext: permission }), /许可好友/);
  }
  for (const id of [null, '', `conv:${'b'.repeat(64)}`]) assert.throws(() => parseWatchDecision({ ...share, recipientId: id }, { shareContext }), /许可好友/);
  const commentContext = { enabled: true, paused: false, remainingDaily: 1, remainingSession: 1 };
  const comment = choice('comment', { query: '', seconds: null, recipientId: null });
  assert.equal(parseWatchDecision(comment, { commentContext }).action, 'comment');
  for (const seconds of [1, 10, 600]) assert.throws(() => parseWatchDecision({ ...comment, seconds }, { commentContext }), /1至10秒/);
  for (const permission of [undefined, { ...commentContext, enabled: false }, { ...commentContext, paused: true }, { ...commentContext, remainingDaily: 0 }, { ...commentContext, remainingSession: 0 }]) {
    assert.throws(() => parseWatchDecision(comment, { commentContext: permission }), /评论未启用/);
  }
});

test('每日请求在停止、重构及失败后保持，内部运行不能重置今日额度',async t=>{
 const f=fixture(t);f.videoLimits.savePolicy({dailyRequests:2},{explicit:true});f.provider(async()=>({text:JSON.stringify(choice('skip'))}));
 f.watch.start({startSession:true,maxRequests:1000001},{explicit:true});const sessionId=f.watch.sessionId;await f.watch.completion;assert.equal(f.watch.state().status,'limited');assert.equal(f.watch.state().counts.dailyRequests,2);
 const other=f.other('dsh');assert.throws(()=>other.start({maxRequests:1000001},{explicit:true}),/次数已用完/);assert.equal(f.videoLimits.state().session.id,sessionId);assert.throws(()=>f.videoLimits.markSession('api',{explicit:true}),/次数已用完/);
 f.videoLimits.savePolicy({dailyRequests:3},{explicit:true});f.provider(async()=>{throw new Error('合成网络故障');});other.start({maxRequests:2},{explicit:true});await other.completion;assert.equal(other.state().counts.dailyRequests,3);assert.equal(other.state().status,'failed');
});

test('时限会中止后续模型动作，超过180秒不靠新任务续跑，模型每步不带任意工具', async t => {
  const f = fixture(t); let requests = 0;
  f.videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 5 }, { explicit: true });
  f.provider(async () => { requests++;for(let i=0;i<(requests===1?181:200);i++){f.advance(1000);f.videoLimits.notePlayback('api',f.state());}return { text: JSON.stringify(choice('skip')) }; });
  f.watch.start({ startSession: true }, { explicit: true }); await f.watch.completion;
  assert.equal(requests, 2); assert.equal(f.watch.state().status, 'limited'); assert.equal(f.calls.filter(call => call.name === 'douyin_next').length, 1); assert.equal(f.watch.state().counts.requests, 2);
});

test('API与DSH互斥，外部close不停止owner，合作stop在心跳内取消请求', { timeout: 5000 }, async t => {
  const f = fixture(t), entered = Promise.withResolvers();
  f.provider(({ signal }) => new Promise((resolve, reject) => { entered.resolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  f.watch.start({ startSession: true }, { explicit: true }); await waitForProvider(f.watch, entered.promise);
  const other = f.other('dsh'); assert.equal(other.state().owned, false); assert.throws(() => other.start({}, { explicit: true }), /另一个入口/);
  await other.close(); assert.equal(other.state().running, true);
  const stopping = await other.stop({ explicit: true }); assert.equal(stopping.status, 'stopping'); await f.watch.completion;
  assert.equal(other.state().running, false); assert.equal(other.state().status, 'stopped'); assert.equal(other.state().counts.requests, 1);
});

test('手动任务共享lease与循环互斥，owner停止会立即取消模型并暂停', async t => {
  const f = fixture(t), other = f.other('dsh'), entered = Promise.withResolvers();
  const release = f.watch.claimManual('task'); assert.throws(() => other.start({ startSession: true }, { explicit: true }), /手动任务/); await release();
  f.provider(({ signal }) => new Promise((resolve, reject) => { entered.resolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
  f.watch.start({ startSession: true }, { explicit: true }); await waitForProvider(f.watch, entered.promise); assert.throws(() => other.claimManual('forward'), /先停止共享/);
  const stopped = await f.watch.stop({ explicit: true }); assert.equal(stopped.running, false); assert.equal(stopped.status, 'stopped'); assert.equal(f.paused(), 1);
});

test('模型前采样失败时门闩立即报告实际状态与错误，不等待尚未进入的模型', async t => {
  const f = fixture(t), entered = Promise.withResolvers();
  f.controller.execute = async () => { throw new Error('合成模型前采样故障'); };
  f.provider(async () => { entered.resolve(); return { text: JSON.stringify(choice()) }; });
  f.watch.start({ startSession: true }, { explicit: true });
  await assert.rejects(waitForProvider(f.watch, entered.promise), error => {
    assert.match(error.message, /"status":"failed"/);
    assert.match(error.message, /"lastError":"合成模型前采样故障"/);
    return true;
  });
  assert.equal(f.watch.state().counts.requests, 0);
});

test('无法识别的帧、登录页和模型任意动作都失败关闭，不写兴趣或执行外发', async t => {
  const f = fixture(t); const original = f.controller.execute; let requests = 0;
  f.provider(async () => { requests++; return { text: JSON.stringify({ ...choice(), action: 'sendMessage' }) }; });
  f.watch.start({ startSession: true }, { explicit: true }); await f.watch.completion; assert.equal(f.watch.state().status, 'failed'); assert.equal(f.personaMemory.snapshot().interests.length, 0);
  const used = requests; f.controller.execute = async (name, ...rest) => name === 'douyin_observe' ? { state: f.state(), frames: [] } : original(name, ...rest);
  f.watch.start({}, { explicit: true }); await f.watch.completion; assert.equal(requests, used);
  f.controller.execute = async () => ({ loginRequired: true }); f.watch.start({}, { explicit: true }); await f.watch.completion; assert.equal(f.watch.state().status, 'needs_user');
  assert.equal(f.calls.some(call => /chat|forward|like/.test(call.name)), false);
});

test('每日上限独立于新视频轮次，已退出运行可恢复后再取得手动锁', async t => {
  const f = fixture(t); fs.writeFileSync(f.watch.files.budget, JSON.stringify({ version: 1, sessions: {}, days: { '2026-10-15': 20000 } }));
  assert.throws(() => f.watch.start({ startSession: true }, { explicit: true }), /次数已用完/); assert.equal(f.calls.length, 0);
  assert.equal(f.videoLimits.state().session, null);
  fs.writeFileSync(f.watch.files.budget, JSON.stringify({ version: 1, sessions: {}, days: {} }));
  f.videoLimits.markSession('api', { explicit: true });
  fs.writeFileSync(f.watch.files.lock, JSON.stringify({ version: 1, pid: 2147483647, runId: 'dead-synthetic', sessionId: f.videoLimits.state().session.id, source: 'dsh' }));
  const release= f.watch.claimManual('合成退出恢复'); assert.equal(fs.existsSync(f.watch.files.lock), false); assert.equal(f.calls.length, 0); await release(); await f.watch.stop({ explicit: true }); assert.equal(f.videoLimits.state().daily.requests,0);
});

test('无活 worker 时失败 A 的状态、计数和剩余不混入后来手动 B', async t => {
  const f = fixture(t);
  const a = f.videoLimits.markSession('api', { explicit: true }).session.id;
  f.watch.runId = 'run-failed-a'; f.watch.sessionId = a;
  f.watch.save({ status: 'failed', lastDecision: { action: 'skip', reason: 'A失败' }, lastError: 'A失败' });
  f.videoLimits.endSession({ explicit: true, reason: 'A失败' });
  const b = f.videoLimits.markSession('api', { explicit: true }).session.id;
  fs.writeFileSync(f.watch.files.budget, JSON.stringify({ version: 1, sessions: { [a]: { requests: 5 }, [b]: { requests: 9 } }, days: { '2026-10-15': 14 } }));
  const state = f.watch.state();
  assert.equal(state.sessionId, a);
  assert.equal(state.status, 'failed');
  assert.equal(state.lastDecision.action, 'skip');
  assert.equal(state.counts.requests, 5);
  assert.equal(state.remainingSeconds, 0);
});

test('显式共享暂停只请求当前全局活worker，不拼历史A、不结束当前会话或清空预算', async t => {
  const f = fixture(t);
  const a = f.videoLimits.markSession('api', { explicit: true }).session.id;
  f.watch.runId = 'run-failed-a'; f.watch.sessionId = a;
  f.watch.save({ status: 'failed', lastDecision: { action: 'skip', reason: 'A失败' }, lastError: 'A失败' });
  f.videoLimits.endSession({ explicit: true, reason: 'A失败' });
  const b = f.videoLimits.markSession('api', { explicit: true }).session.id;
  fs.writeFileSync(f.watch.files.budget, JSON.stringify({ version: 1, sessions: { [a]: { requests: 5 }, [b]: { requests: 9 } }, days: { '2026-10-15': 14 } }));
  fs.writeFileSync(f.watch.files.lock, JSON.stringify({ version: 1, pid: process.pid, runId: 'other-live-run', sessionId: b, source: 'dsh', status: 'running', heartbeatAt: new Date(f.now()).toISOString() }));
  const previousBudget = fs.readFileSync(f.watch.files.budget, 'utf8'), previousState = fs.readFileSync(f.watch.files.state, 'utf8');
  const manual = JSON.stringify({ pid: process.pid, token: 'synthetic-manual-owner', kind: 'manual-task' });
  fs.writeFileSync(f.watch.files.manual, manual);
  const stopped = await f.watch.stop({ explicit: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.watch.files.stop, 'utf8')), { runId: 'other-live-run', requestedAt: f.now() });
  assert.equal(JSON.parse(fs.readFileSync(f.watch.files.lock, 'utf8')).runId, 'other-live-run');
  assert.equal(stopped.status, 'stopping');
  assert.equal(stopped.sessionId, b);
  assert.equal(stopped.lastDecision, null);
  assert.equal(stopped.lastError, '');
  assert.equal(stopped.worker.source, 'dsh');
  assert.equal(stopped.counts.requests, 9);
  assert.equal(f.videoLimits.state().session.id, b);
  assert.equal(fs.readFileSync(f.watch.files.budget, 'utf8'), previousBudget);
  assert.equal(fs.readFileSync(f.watch.files.state, 'utf8'), previousState);
  assert.equal(fs.readFileSync(f.watch.files.manual, 'utf8'), manual);
  assert.equal(f.calls.length, 0);
});

test('普通ApiAgent每次请求重读人格；结构化解析拒绝越权与不完整字段', async () => {
  let counter = 0; const prompts = [];
  const agent = new ApiAgent({ controller: { execute: async () => ({}) }, config: { apiKey: 'synthetic', baseUrl: 'https://synthetic.example', model: 'synthetic' }, personaMemory: { context: () => `共享人格版本${++counter}` }, fetchImpl: async (_url, options) => { const body = JSON.parse(options.body); prompts.push(body.messages[0].content); return new Response(JSON.stringify({ choices: [{ message: prompts.length === 1 ? { tool_calls: [{ id: 'synthetic-call', type: 'function', function: { name: 'douyin_status', arguments: '{}' } }] } : { content: '已读取共同人格。' } }] })); } });
  assert.equal((await agent.runTask({ instruction: '看看人格。' })).status, 'completed'); assert.match(prompts[0], /共享人格版本1/); assert.match(prompts[1], /共享人格版本2/);
  for (const value of [{ ...choice(), action: 'forward' }, { ...choice(), tools: [] }, choice('stay', { seconds: -1 }), choice('search', { query: '' }), { ...choice(), reflection: undefined }]) assert.throws(() => parseWatchDecision(value));
  assert.throws(() => watchDecisionMessages({ state: { loginRequired: true }, frames: [] }), /手动操作/);
});

test('API自主决策只发一次含真实采样的受限请求，按接口用量回读并隐藏返回中的密钥', async t => {
  const f = fixture(t), observation = { state: f.state(), frames: [{ mimeType: 'image/png', data: PNG, videoId: f.state().video.id, time: 0 }], observation: { videoId: f.state().video.id } };
  let attempts = 0;
  const agent = new ApiAgent({ controller: f.controller, config: f.options.config, fetchImpl: async (url, options) => {
    attempts++; assert.equal(url, 'https://synthetic.example/chat/completions'); assert.equal(options.headers.authorization, 'Bearer synthetic-key'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); assert.equal(body.tools, undefined); assert.equal(body.stream, false); assert.match(body.messages[1].content[0].text, /共同人格/); assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(choice('stop', { reason: '合成 synthetic-key 说明' })) } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }));
  } });
  const result = await agent.decideWatch({ observation, context: '共同人格：简洁' }); assert.equal(attempts, 1); assert.equal(result.decision.action, 'stop'); assert.equal(JSON.stringify(result).includes('synthetic-key'), false); assert.equal(result.usage.totalTokens, 5);
});


test('观察排队超过30秒不把不可信时长写入偏好，也不中断后续决策', async t => {
  const f=fixture(t),execute=f.controller.execute;
  f.controller.execute=async (...args)=>{if(args[0]==='douyin_observe')f.advance(31_000);return execute(...args);};
  f.watch.start({startSession:true},{explicit:true});await f.watch.completion;
  assert.equal(f.watch.state().status,'stopped');assert.equal(f.watch.state().counts.requests,1);assert.equal(f.watch.state().lastError,'');
  const state=JSON.parse(fs.readFileSync(f.personaMemory.stateFile,'utf8'));assert.equal((state.behavior?.viewings || []).length,0);
  assert.equal(f.events.filter(x=>x.type==='watch.viewing-uncredited').length,1);
});

test('停留后读取状态超过30秒只跳过本次学习，后续观察继续',async t=>{
  const f=fixture(t),q=[choice('stay',{seconds:2}),choice('stop')],delay=f.watch.delayImpl;
  f.provider(async()=>({text:JSON.stringify(q.shift()),usage:{total_tokens:5}}));
  f.watch.delayImpl=async(ms,signal)=>{await delay(ms,signal);f.advance(31_000);};
  f.watch.start({startSession:true},{explicit:true});await f.watch.completion;
  assert.equal(f.watch.state().status,'stopped');assert.equal(f.watch.state().counts.requests,2);assert.equal(f.watch.state().lastError,'');
  const state=JSON.parse(fs.readFileSync(f.personaMemory.stateFile,'utf8'));assert.equal(state.behavior.actions.filter(x=>x.action==='stay').length,0);
  assert.ok(state.behavior.viewings.every(x=>x.wallSeconds<=30));assert.equal(f.events.filter(x=>x.type==='watch.viewing-uncredited').length,1);
});

test('倒退或非有限的学习间隔不伪造观看时长且不吞掉其他证据错误',t=>{
  const f=fixture(t);let writes=0;const record=f.personaMemory.recordViewing.bind(f.personaMemory);f.personaMemory.recordViewing=(...args)=>{writes++;return record(...args);};
  for(const start of [f.now()+1,Number.NaN,Number.NEGATIVE_INFINITY])assert.equal(f.watch.viewing('synthetic-evidence',f.state(),f.state(),start,'synthetic-sample'),null);
  assert.equal(writes,0);assert.throws(()=>f.watch.viewing('synthetic-evidence',f.state(),f.state(),f.now(),'synthetic-sample'));
});
