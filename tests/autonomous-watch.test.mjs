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

test('默认停止且无轮次不能启动；显式启动也不延长已有有限轮次', async t => {
  const f = fixture(t); assert.equal(f.watch.state().running, false); assert.equal(f.calls.length, 0);
  assert.throws(() => f.watch.start({}, { explicit: true }), /开始新一轮/); assert.throws(() => f.watch.start({ startSession: true }), /明确启动/);
  const session = f.videoLimits.markSession('api', { explicit: true });
  f.watch.start({ startSession: true, maxRequests: 1 }, { explicit: true }); await f.watch.completion;
  assert.equal(f.videoLimits.state().session.id, session.session.id); assert.equal(f.videoLimits.state().session.expiresAt, session.session.expiresAt); assert.equal(f.watch.state().counts.requests, 1); assert.equal(f.paused(), 1);
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
  assert.equal(f.watch.state().counts.maxRequests, 2);
  assert.equal(f.videoLimits.state().session.id, session.id);
  assert.equal(f.videoLimits.state().session.expiresAt, session.expiresAt);
  assert.throws(() => f.watch.start({ maxRequests: 100 }, { explicit: true }), /预算已用完/);
  assert.equal(f.watch.state().counts.requests, 2);
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

test('时长兼容只接受安全整数，不允许非法类型、非空跨动作参数或未知字段', () => {
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
  for (const extra of [{ seconds: -1 }, { seconds: 1.5 }, { seconds: '0' }, { seconds: false }, { seconds: '' }, { seconds: NaN }, { seconds: Infinity }, { seconds: Number.MAX_SAFE_INTEGER + 1 }, { query: '猫咪' }, { recipientId: `conv:${'a'.repeat(64)}` }, { url: null }]) {
    assert.throws(() => parseWatchDecision(choice('skip', extra)));
  }
  for (const query of [undefined, null, '', ' ']) assert.throws(() => parseWatchDecision(choice('search', { query, seconds: 0 })), /关键词/);
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

test('同轮预算在停止、重新构造及失败后保持；预算耗尽不再采样或自行续轮', async t => {
  const f = fixture(t); f.provider(async () => ({ text: JSON.stringify(choice('skip')) }));
  f.watch.start({ startSession: true, maxRequests: 2 }, { explicit: true }); const sessionId = f.watch.sessionId; await f.watch.completion;
  assert.equal(f.watch.state().status, 'limited'); assert.equal(f.watch.state().counts.requests, 2); assert.equal(f.calls.filter(call => call.name === 'douyin_observe').length, 2);
  const other = f.other('dsh'); assert.equal(other.state().running, false); assert.throws(() => other.start({ maxRequests: 100 }, { explicit: true }), /预算已用完/); assert.equal(other.state().counts.requests, 2); assert.equal(f.videoLimits.state().session.id, sessionId);
  f.videoLimits.markSession('api', { explicit: true }); f.provider(async () => { throw new Error('合成网络故障'); });
  other.start({ maxRequests: 2 }, { explicit: true }); await other.completion; assert.equal(other.state().counts.requests, 1); assert.equal(other.state().status, 'failed');
});

test('时限会中止后续模型动作，超过180秒不靠新任务续跑，模型每步不带任意工具', async t => {
  const f = fixture(t); let requests = 0;
  f.videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 5 }, { explicit: true });
  f.provider(async () => { requests++; f.advance(requests === 1 ? 181_000 : 200_000); return { text: JSON.stringify(choice('skip')) }; });
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

test('每日上限独立于新视频轮次，已死进程残留只能明确停止后清理', async t => {
  const f = fixture(t); fs.writeFileSync(f.watch.files.budget, JSON.stringify({ version: 1, sessions: {}, days: { '2026-10-15': 20000 } }));
  assert.throws(() => f.watch.start({ startSession: true }, { explicit: true }), /预算已用完/); assert.equal(f.calls.length, 0);
  assert.equal(f.videoLimits.state().session, null);
  fs.writeFileSync(f.watch.files.budget, JSON.stringify({ version: 1, sessions: {}, days: {} }));
  f.videoLimits.markSession('api', { explicit: true });
  fs.writeFileSync(f.watch.files.lock, JSON.stringify({ version: 1, pid: 2147483647, runId: 'dead-synthetic', sessionId: f.videoLimits.state().session.id, source: 'dsh' }));
  assert.throws(() => f.watch.start({}, { explicit: true }), /残留/); await f.watch.stop({ explicit: true }); assert.equal(fs.existsSync(f.watch.files.lock), false); assert.equal(f.calls.length, 0);
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
