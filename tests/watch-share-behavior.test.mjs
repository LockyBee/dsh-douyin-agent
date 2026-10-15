import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomousWatch } from '../autonomous-watch.mjs';
import { AutonomousShare } from '../autonomous-share.mjs';
import { ApiAgent, parseWatchDecision, watchDecisionMessages, WATCH_SYSTEM_PROMPT } from '../api-agent.mjs';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGDkAAAAASUVORK5CYII=';
const ID = '7579432563794584933', recipientId = `conv:${'a'.repeat(64)}`;
const decision = (action, fields = {}) => ({ action, reason: '这段合成猫咪动作适合与许可好友交流。', topics: [{ topic: '猫咪', signal: 'like' }], reflection: '主题与信号只是提议，等待实际观看和互动核对。', ...fields });
const state = (id = ID, time = 0, duration = 10) => ({ url: `https://www.douyin.com/video/${id}`, loginRequired: false, verificationRequired: false, privateChatVisible: false, video: { id, url: `https://www.douyin.com/video/${id}`, title: '合成猫咪', author: '合成作者', time, duration, paused: false, readyState: 4 } });
const capture = current => ({ state: current, frames: [{ mimeType: 'image/png', data: PNG, time: current.video.time, videoId: current.video.id }], observation: { videoId: current.video.id } });

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-share-behavior-')), stateDir = path.join(root, 'state'), source = options.source || 'api';
  let now = Date.parse('2026-10-15T03:00:00Z'), id = ID, time = 0, playbackPaused = false;
  const nowFn = () => now;
  const personaMemory = new PersonaMemory({ memoryDir: path.join(root, 'memory'), legacyRoleCardFile: path.join(root, 'no-legacy.md'), clock: nowFn });
  const videoLimits = new VideoLimits({ stateDir, now: nowFn }); videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 10 }, { explicit: true });
  fs.writeFileSync(path.join(stateDir, 'chat-policy.json'), JSON.stringify({ allowlist: [{ id: recipientId, name: '合成好友甲', followed: true, isGroup: false, verifiedAt: '2026-10-15T01:00:00Z' }] }));
  const current = () => { const value = state(id, time, options.duration || 10); value.video.paused = playbackPaused; return value; }, actions = [], requests = [], sends = [], delays = [], queue = options.decisions || [decision('stop')];
  let pauses = 0, watch;
  const controller = { execute: async (name, args, controls) => {
    controls.signal.throwIfAborted(); actions.push({ name, args, controls });
    if (name === 'douyin_observe') {
      const before = current(); now += 3000; time += options.sampleProgress ?? 3; const observation = capture(current());
      if (options.coreViewing) { const evidenceId = personaMemory.recordObservation(observation, { source, kind: 'visual' }).evidenceId; observation.personaEvidenceId = evidenceId; observation.viewing = personaMemory.recordViewing({ evidenceId, from: before, to: observation.state, wallSeconds: 3, sampleId: `core-synthetic-${actions.length}` }, { source }); }
      return observation;
    }
    if (name === 'douyin_next') { if (options.changed !== false) { id = String(BigInt(id) + 1n); time = 0; } return { changed: options.changed !== false, state: current() }; }
    if (name === 'douyin_search') return { ...current(), searchResults: [{ index: 0 }] };
    if (name === 'douyin_open_video') { id = String(BigInt(id) + 2n); time = 0; return current(); }
    return current();
  }, pauseForLimits: async () => { pauses++; } };
  const send = async (input, controls) => {
    sends.push({ input, controls }); assert.equal(controls.autonomousRunId, watch.runId); assert.ok(controls.signal instanceof AbortSignal); assert.deepEqual(Object.keys(input).sort(), ['expectedVideoId', 'recipientId']);
    controls.authorize({ phase: 'prepare', videoId: input.expectedVideoId, recipientId: input.recipientId });
    if (options.sendFailure) throw new Error('合成发送前故障');
    controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId, recipientId: input.recipientId });
    if (options.stopAfterConfirmed) watch.cancel();
    return options.uncertain ? { confirmed: false, deliveryUncertain: true, deliveryType: 'native-card', operationId: 'synthetic-uncertain-forward' } : { confirmed: true, deliveryUncertain: false, deliveryType: 'native-card', videoId: input.expectedVideoId, messageId: 'synthetic-shared-card', operationId: 'synthetic-confirmed-forward' };
  };
  const shareService = new AutonomousShare({ personaMemory, videoLimits, controller, stateDir, source, now: nowFn, send });
  if (options.sharing) shareService.configure({ enabled: true, dailyLimit: 3 }, { explicit: true });
  const decisionProvider = async input => {
    requests.push(input); if (options.disableDuringModel) shareService.configure({ enabled: false }, { explicit: true });
    if (requests.length === 1) {
      now += options.modelDelayMs ?? 0; time += (options.modelDelayMs ?? 0) / 1000;
      if (options.switchDuringModel) { id = String(BigInt(id) + 1n); time = 0; }
      if (options.pauseDuringModel) playbackPaused = true;
    }
    return { text: JSON.stringify(queue.shift() || decision('stop')), usage: { total_tokens: 1 } };
  };
  watch = new AutonomousWatch({ controller, config: source === 'dsh' ? {} : { apiKey: 'synthetic-key' }, videoLimits, personaMemory, shareService, source, stateDir, now: nowFn, decisionProvider, delayImpl: async (ms, signal) => {
    delays.push(ms);
    signal.throwIfAborted(); if (options.cancelStay) { watch.cancel(); return; }
    const elapsed = options.delayMs ?? ms; now += elapsed; time += options.stayProgress ?? elapsed / 1000;
    if (options.switchDuringStay) { id = String(BigInt(id) + 1n); time = 0; }
    if (options.pauseDuringStay) playbackPaused = true;
  } });
  t.after(async () => { await watch.close(); await shareService.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const run = async () => { watch.start({ startSession: true, maxRequests: 5 }, { explicit: true }); return await watch.completion; };
  return { root, stateDir, source, current, actions, requests, sends, delays, watch, shareService, personaMemory, videoLimits, run, pauses: () => pauses };
}

test('分享模型协议只允许当前许可好友，不允许URL、作品编号、观察编号或正文', () => {
  const shareContext = { enabled: true, paused: false, dailyRemaining: 3, recipients: [{ id: recipientId, name: '合成好友甲' }] }, share = decision('share', { recipientId });
  assert.equal(parseWatchDecision(share, { shareContext }).recipientId, recipientId);
  for (const fields of [{ url: `https://www.douyin.com/video/${ID}` }, { videoId: ID }, { evidenceId: `video:${'b'.repeat(64)}` }, { text: '不得发送的正文' }, { enabled: true }, { query: '不能搜索并分享' }, { seconds: 2 }]) assert.throws(() => parseWatchDecision({ ...share, ...fields }, { shareContext }));
  for (const permission of [undefined, { ...shareContext, enabled: false }, { ...shareContext, paused: true }, { ...shareContext, dailyRemaining: 0 }, { ...shareContext, recipients: [] }]) assert.throws(() => parseWatchDecision(share, { shareContext: permission }), /许可好友/);
  assert.throws(() => parseWatchDecision(decision('share', { recipientId: `conv:${'c'.repeat(64)}` }), { shareContext }), /许可好友/);
  assert.throws(() => parseWatchDecision(decision('skip', { recipientId }), { shareContext }));
  const messages = watchDecisionMessages(capture(state()), { context: '合成人格', shareContext }); assert.match(messages[1].content[0].text, /"dailyRemaining":3/); assert.match(messages[1].content[0].text, new RegExp(recipientId)); assert.match(WATCH_SYSTEM_PROMPT, /不要每条都分享/); assert.match(WATCH_SYSTEM_PROMPT, /无需逐次/);
});

test('API与DSH循环把宿主当前证据绑定到分享，成功卡片才记录实际互动与兴趣', async t => {
  for (const source of ['api', 'dsh']) {
    const f = fixture(t, { source, sharing: true, decisions: [decision('share', { recipientId }), decision('stop')] }); const final = await f.run();
    assert.equal(final.status, 'stopped'); assert.equal(f.sends.length, 1); assert.equal(f.requests.length, 2); assert.equal(f.actions.some(({ name }) => /forward|chat|like/.test(name)), false);
    assert.deepEqual(f.sends[0].input, { recipientId, expectedVideoId: ID }); assert.equal(f.sends[0].controls.humanAuthorized, undefined);
    const ledger = f.shareService.ledger(), snapshot = f.personaMemory.snapshot(), observation = snapshot.recentObservations.find(row => row.videoId === ID);
    assert.equal(observation.actions.share, 1); assert.equal(observation.watchedSeconds, 6); assert.equal(snapshot.interests[0].signal, 'like'); assert.equal(snapshot.userPreferences.length, 0);
    const data = JSON.parse(fs.readFileSync(f.personaMemory.stateFile)); assert.equal(data.behavior.actions[0].operationId, ledger.operations[0].operationId); assert.equal(data.behavior.actions[0].source, source); assert.equal(ledger.operations[0].evidenceId, data.behavior.actions[0].evidenceId);
    assert.match(f.requests[0].messages[1].content[0].text, /"enabled":true/); assert.equal(f.requests[0].messages.some(row => row.role === 'tool'), false);
  }
});

test('分享关闭、名单外、模型等待期间撤回许可时不进入发送器，也不学习like', async t => {
  for (const options of [{}, { sharing: true, disableDuringModel: true }, { sharing: true, target: `conv:${'d'.repeat(64)}` }]) {
    const f = fixture(t, { ...options, decisions: [decision('share', { recipientId: options.target || recipientId })] }); const final = await f.run();
    assert.equal(final.status, 'failed'); assert.equal(f.sends.length, 0); assert.equal(f.shareService.state().daily.attempts, 0); assert.equal(f.personaMemory.snapshot().interests.length, 0);
  }
});

test('分享回执不确定会停止循环并保留暂停；发送故障不伪装成成功互动', async t => {
  for (const options of [{ uncertain: true }, { sendFailure: true }]) {
    const f = fixture(t, { ...options, sharing: true, decisions: [decision('share', { recipientId }), decision('skip')] }); const final = await f.run();
    assert.equal(final.status, options.uncertain ? 'needs_user' : 'failed'); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.actions.some(row => row.name === 'douyin_next'), false);
    assert.equal(f.personaMemory.snapshot().interests.length, 0); assert.equal(f.personaMemory.snapshot().recentObservations[0].actions.share, 0); assert.equal(f.shareService.state().paused, !!options.uncertain);
    if (options.sendFailure) assert.match(final.lastError, /合成发送前故障/);
  }
});

test('成功卡片回读恰逢停止时仍保全已发生互动，不继续浏览或重发', async t => {
  const f = fixture(t, { sharing: true, stopAfterConfirmed: true, decisions: [decision('share', { recipientId }), decision('skip')] }); const result = await f.run();
  assert.equal(result.status, 'stopped'); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.shareService.ledger().operations[0].status, 'confirmed');
  assert.equal(f.personaMemory.snapshot().recentObservations[0].actions.share, 1); assert.equal(f.personaMemory.snapshot().interests[0].signal, 'like'); assert.equal(f.actions.some(row => row.name === 'douyin_next'), false);
});

test('真实进度与实际等待满足观看比例后才确认停留，不能拿请求10秒充当观看10秒', async t => {
  const short = fixture(t, { decisions: [decision('stay', { seconds: 10 }), decision('stop')], delayMs: 500, duration: 100 }); await short.run();
  const shortView = short.personaMemory.snapshot().recentObservations.find(row => row.videoId === ID); assert.equal(shortView.watchedSeconds, 6.5); assert.equal(shortView.actions.stay, 1); assert.equal(shortView.signal, 'neutral'); assert.equal(short.personaMemory.snapshot().interests[0].signal, 'neutral');
  const sustained = fixture(t, { decisions: [decision('stay', { seconds: 5 }), decision('stop')], duration: 20 }); await sustained.run();
  const held = sustained.personaMemory.snapshot().recentObservations.find(row => row.videoId === ID); assert.equal(held.watchedSeconds, 11); assert.equal(held.actions.stay, 1); assert.equal(held.signal, 'like'); assert.equal(sustained.personaMemory.snapshot().interests[0].signal, 'like');
});

test('31秒合法模型响应后按新基线测2秒停留，不超可信窗口或补算31秒观看', async t => {
  const f = fixture(t, { coreViewing: true, modelDelayMs: 31000, duration: 100, decisions: [decision('stay', { seconds: 2 }), decision('stop')] });
  const result = await f.run(); assert.equal(result.status, 'stopped'); assert.equal(result.lastError, ''); assert.equal(f.requests.length, 2); assert.deepEqual(f.delays, [2000]);
  const records = JSON.parse(fs.readFileSync(f.personaMemory.stateFile)), held = records.behavior.viewings.find(row => row.sampleId.includes(':stay-view:'));
  assert.equal(held.from.time, 34); assert.equal(held.to.time, 36); assert.equal(held.wallSeconds, 2); assert.ok(records.behavior.viewings.every(row => row.wallSeconds <= 30));
  const viewed = f.personaMemory.snapshot().recentObservations.find(row => row.videoId === ID); assert.equal(viewed.watchedSeconds, 8); assert.equal(viewed.actions.stay, 1);
});

test('模型等待长于可信窗口后仍可换片，但不把漏记的长停留误判为快划不喜欢', async t => {
  const f = fixture(t, { modelDelayMs: 31000, duration: 100, decisions: [decision('skip'), decision('stop')] }); const result = await f.run();
  assert.equal(result.status, 'stopped'); assert.equal(f.actions.filter(row => row.name === 'douyin_next').length, 1);
  const skipped = f.personaMemory.snapshot().recentObservations.find(row => row.videoId === ID); assert.equal(skipped.watchedSeconds, 3); assert.equal(skipped.actions.skip, 0); assert.equal(skipped.signal, 'neutral'); assert.equal(f.personaMemory.snapshot().interests.length, 0);
  const short = fixture(t, { modelDelayMs: 2000, duration: 100, decisions: [decision('skip'), decision('stop')] }); await short.run();
  const measured = short.personaMemory.snapshot().recentObservations.find(row => row.videoId === ID); assert.equal(measured.watchedSeconds, 5); assert.equal(measured.actions.skip, 1); assert.equal(measured.signal, 'neutral'); assert.equal(short.personaMemory.snapshot().interests[0].signal, 'neutral');
  const records = JSON.parse(fs.readFileSync(short.personaMemory.stateFile)), waited = records.behavior.viewings.find(row => row.sampleId.includes(':model-wait:')); assert.equal(waited.wallSeconds, 2); assert.equal(waited.from.time, 3); assert.equal(waited.to.time, 5);
});

test('模型等待或停留期间换片与暂停均不学习，到视频截止仍立即结束', async t => {
  for (const options of [{ switchDuringModel: true }, { pauseDuringModel: true }, { switchDuringStay: true }, { pauseDuringStay: true }]) {
    const f = fixture(t, { ...options, modelDelayMs: 31000, duration: 100, decisions: [decision('stay', { seconds: 2 })] }); const result = await f.run();
    assert.equal(result.status, 'needs_user', JSON.stringify({ options, result })); assert.equal(f.personaMemory.snapshot().interests.length, 0); assert.equal(f.personaMemory.snapshot().recentObservations.find(row => row.videoId === ID).actions.stay, 0);
    if (options.switchDuringModel || options.pauseDuringModel) assert.equal(f.delays.length, 0);
  }
  const expired = fixture(t, { modelDelayMs: 31000, delayMs: 27000, duration: 1000, decisions: [decision('stay', { seconds: 2 })] });
  expired.videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 1 }, { explicit: true }); const result = await expired.run();
  assert.equal(result.status, 'limited', JSON.stringify(result)); assert.equal(expired.requests.length, 1); assert.equal(expired.videoLimits.state().allowed, false); assert.equal(expired.personaMemory.snapshot().interests.length, 0); assert.equal(expired.personaMemory.snapshot().recentObservations[0].actions.stay, 0);
});

test('失败换片、停留中换片或取消、拖动进度与卡住均不能学成喜欢', async t => {
  for (const options of [{ decisions: [decision('skip')], changed: false }, { decisions: [decision('stay', { seconds: 2 })], switchDuringStay: true }, { decisions: [decision('stay', { seconds: 2 })], cancelStay: true }, { decisions: [decision('stay', { seconds: 2 }), decision('stop')], stayProgress: 10, duration: 100 }, { decisions: [decision('stay', { seconds: 2 }), decision('stop')], sampleProgress: 0, stayProgress: 0 }]) {
    const f = fixture(t, options); await f.run(); assert.equal(f.personaMemory.snapshot().interests.length, 0); assert.equal(f.personaMemory.snapshot().recentObservations[0].actions.stay, 0);
  }
});

test('确认快速跳过才形成负向依据；只观察后搜索或停止不凭单帧学习', async t => {
  const skip = fixture(t, { duration: 100, decisions: [decision('skip'), decision('stop')] }); await skip.run();
  const skipped = skip.personaMemory.snapshot().recentObservations.find(row => row.videoId === ID); assert.equal(skipped.watchedSeconds, 3); assert.equal(skipped.actions.skip, 1); assert.equal(skipped.signal, 'dislike'); assert.equal(skip.personaMemory.snapshot().interests[0].signal, 'dislike');
  for (const decisions of [[decision('stop')], [decision('search', { query: '猫咪' }), decision('stop')]]) { const f = fixture(t, { decisions }); await f.run(); assert.equal(f.personaMemory.snapshot().interests.length, 0); }
});

test('核心已返回真实观看回执时不重复写viewing，回执与采样不一致则停止学习', async t => {
  const f = fixture(t, { coreViewing: true, decisions: [decision('skip'), decision('stop')], duration: 100 }); await f.run();
  const records = JSON.parse(fs.readFileSync(f.personaMemory.stateFile)); assert.equal(records.behavior.viewings.length, 2); assert.ok(records.behavior.viewings.every(row => row.sampleId.startsWith('core-synthetic-')));
  const bad = fixture(t, { coreViewing: true, decisions: [decision('skip')] }), original = bad.watch.controller.execute;
  bad.watch.controller.execute = async (...args) => { const output = await original(...args); if (output.viewing) output.viewing.evidenceId = `video:${'0'.repeat(64)}`; return output; };
  assert.equal((await bad.run()).status, 'failed'); assert.equal(bad.requests.length, 0); assert.equal(bad.personaMemory.snapshot().interests.length, 0);
});

test('旧人格替身缺少snapshot与行为接口时仍可观看，不创建分享服务或伪造学习', async t => {
  const f = fixture(t, { decisions: [decision('skip'), decision('stop')] }); let learned = 0;
  f.watch.personaMemory = { context: () => '合成人格替身', recordObservation: () => ({ evidenceId: `video:${'f'.repeat(64)}` }), updateAgentInterests: () => { learned++; } }; f.watch.shareService = undefined;
  assert.equal((await f.run()).status, 'stopped'); assert.equal(f.watch.shareService, undefined); assert.equal(learned, 0);
});

test('普通任务模型工具表仍不包含直接私信、转发或分享配置入口', () => {
  const agent = new ApiAgent({ controller: { execute() {} }, config: { apiKey: 'synthetic-key' } });
  assert.equal(agent.toolDefinitions.some(tool => /chat_|forward_video|share_configure|watch_start|watch_stop/.test(tool.name)), false);
});
