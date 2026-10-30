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
  fs.writeFileSync(path.join(stateDir, 'chat-policy.json'), JSON.stringify({ allowlist: [{ id: recipientId, name: '合成好友甲', followed: true, isGroup: false, verifiedAt: '2026-10-15T01:00:00Z', identityVersion: 2, identityKind: 'rendered-user', identityHash: 'a'.repeat(64), identityVerified: true, identityBinding: 'binding:' + 'b'.repeat(64) }] }));
  const current = () => { const value = state(id, time, options.duration || 10); value.video.paused = playbackPaused; return value; }, actions = [], requests = [], sends = [], delays = [], events = [], queue = options.decisions || [decision('stop')];
  let pauses = 0, watch;
  const advancePlayback=ms=>{for(let remaining=ms;remaining>0;){const step=Math.min(1000,remaining);now+=step;time+=step/1000;videoLimits.notePlayback(source,current(),{ownerId:watch?.runId||source});remaining-=step;}};
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
    if (options.preflightFailure) {
      const code = options.preflightFailure, stage = 'conversation-baseline', forwardOperationId = 'synthetic-watch-preflight';
      throw Object.assign(new Error('合成后台消息页暂不可用'), { code, forwardOperationId, failure: { code, stage, message: '合成后台消息页暂不可用' }, preflight: { protocol: 'share-preflight-v1', outcome: 'not-sent', forwardOperationId, videoId: input.expectedVideoId, recipientId: input.recipientId, sendClicks: 0, dispatchAuthorized: false, failureCode: code, failureStage: stage } });
    }
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
      if(options.liveAccounting)advancePlayback(options.modelDelayMs??0);else{now += options.modelDelayMs ?? 0; time += (options.modelDelayMs ?? 0) / 1000;}
      if (options.switchDuringModel) { id = String(BigInt(id) + 1n); time = 0; }
      if (options.pauseDuringModel) playbackPaused = true;
    }
    return { text: JSON.stringify(queue.shift() || decision('stop')), usage: { total_tokens: 1 } };
  };
  watch = new AutonomousWatch({ controller, config: source === 'dsh' ? {} : { apiKey: 'synthetic-key' }, videoLimits, personaMemory, shareService, source, stateDir, now: nowFn, decisionProvider, onEvent: event => events.push(event), delayImpl: async (ms, signal) => {
    delays.push(ms);
    signal.throwIfAborted(); if (options.cancelStay) { watch.cancel(); return; }
    const elapsed = options.delayMs ?? ms;if(options.liveAccounting)advancePlayback(elapsed);else{now += elapsed; time += options.stayProgress ?? elapsed / 1000;}
    if (options.switchDuringStay) { id = String(BigInt(id) + 1n); time = 0; }
    if (options.pauseDuringStay) playbackPaused = true;
  } });
  t.after(async () => { await watch.close(); await shareService.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const run = async () => { watch.start({ startSession: true, maxRequests: 5 }, { explicit: true }); return await watch.completion; };
  return { root, stateDir, source, current, actions, requests, sends, delays, events, watch, shareService, personaMemory, videoLimits, run, switchVideo: () => { id = String(BigInt(id) + 1n); time = 0; return current(); }, pauses: () => pauses };
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

test('后台缺页或前台只跳过明确未发送的分享，继续观察，不把失败学习成喜欢', async t => {
  for (const source of ['api', 'dsh']) for (const code of ['CHAT_PAGE_NOT_OPEN', 'CHAT_FOREGROUND']) {
    const f = fixture(t, { source, sharing: true, preflightFailure: code, decisions: [decision('share', { recipientId }), decision('stop')] });
    const result = await f.run(); assert.equal(result.status, 'stopped'); assert.equal(result.lastError, ''); assert.equal(f.requests.length, 2);
    assert.equal(f.actions.filter(item => item.name === 'douyin_observe').length, 2); assert.equal(f.sends.length, 1);
    assert.equal(f.shareService.ledger().operations[0].status, 'not-sent'); assert.equal(f.shareService.state().paused, false);
    assert.equal(f.personaMemory.snapshot().interests.length, 0); assert.equal(f.personaMemory.snapshot().recentObservations[0].actions.share, 0);
    const event = f.events.find(item => item.type === 'watch.share-not-sent'); assert.equal(event.failureCode, code); assert.equal(event.stage, 'conversation-baseline');
  }
});

test('缺失或冲突的未发送证明不能放行，不确定标记不能伪装成零点击', async t => {
  const forwardOperationId = 'synthetic-watch-proof', code = 'CHAT_PAGE_NOT_OPEN', stage = 'contact-identity';
  const good = { status: 'not-sent', code: 'SHARE_PREFLIGHT_NOT_SENT', confirmed: false, deliveryUncertain: false, deliveryType: 'native-card', operationId: 'synthetic-share-proof', forwardOperationId, videoId: ID, recipientId, failure: { code, stage }, preflight: { protocol: 'share-preflight-v1', outcome: 'not-sent', forwardOperationId, videoId: ID, recipientId, sendClicks: 0, dispatchAuthorized: false, failureCode: code, failureStage: stage } };
  for (const mutation of ['missing', 'uncertain', 'confirmed', 'operation', 'wrong-video', 'wrong-recipient', 'dispatch', 'one-click', 'stage', 'code']) {
    const f = fixture(t, { sharing: true, decisions: [decision('share', { recipientId }), decision('stop')] }), delivery = structuredClone(good);
    if (mutation === 'missing') delete delivery.preflight; if (mutation === 'uncertain') delivery.deliveryUncertain = true; if (mutation === 'confirmed') delivery.confirmed = true;
    if (mutation === 'operation') delivery.forwardOperationId = 'other-operation'; if (mutation === 'wrong-video') delivery.videoId = '99999'; if (mutation === 'wrong-recipient') delivery.recipientId = `conv:${'c'.repeat(64)}`;
    if (mutation === 'dispatch') delivery.preflight.dispatchAuthorized = true; if (mutation === 'one-click') delivery.preflight.sendClicks = 1; if (mutation === 'stage') delivery.preflight.failureStage = 'receipt'; if (mutation === 'code') delivery.preflight.failureCode = 'SYNTHETIC_UNKNOWN';
    f.shareService.share = async () => delivery;
    const result = await f.run(); assert.equal(result.status, 'needs_user', mutation); assert.equal(f.requests.length, 1); assert.equal(f.events.some(event => event.type === 'watch.share-not-sent'), false); assert.equal(f.personaMemory.snapshot().recentObservations[0].actions.share, 0);
  }
});

test('同片同人重复分享只跳过该动作，继续换片，不重复发送、扣次或学习分享', async t => {
  for (const source of ['api', 'dsh']) {
    const f = fixture(t, { source, sharing: true, decisions: [decision('share', { recipientId, reason: 'PRIVATE_LOCAL_SHARE_REASON' }), decision('share', { recipientId }), decision('skip'), decision('stop')] });
    const result = await f.run(); assert.equal(result.status, 'stopped'); assert.equal(f.requests.length, 4); assert.equal(f.sends.length, 1); assert.equal(f.shareService.state().daily.attempts, 1); assert.equal(f.shareService.ledger().operations.length, 1);
    assert.ok(f.actions.some(item => item.name === 'douyin_next')); assert.equal(f.personaMemory.snapshot().recentObservations.find(item => item.videoId === ID).actions.share, 1);
    const skipped = f.events.filter(event => event.type === 'watch.share-skipped'); assert.equal(skipped.length, 1); assert.equal(skipped[0].code, 'SHARE_ALREADY_PROCESSED'); assert.equal(skipped[0].videoId, ID); assert.equal(skipped[0].recipientId, recipientId);
    const prompt = f.requests[1].messages[1].content[0].text; assert.match(prompt, /当前作品分享去重摘要/); assert.ok(prompt.includes(JSON.stringify({ videoId: ID, processedRecipients: [{ recipientId, status: 'confirmed' }] }))); assert.doesNotMatch(prompt, /PRIVATE_LOCAL_SHARE_REASON/);
    assert.doesNotMatch(f.requests[3].messages[1].content[0].text, /当前作品分享去重摘要/);
  }
});

test('watch只接受精确匹配的typed去重结果，伪装skip、未知错误和不确定结果仍停止', async t => {
  const good = { status: 'skipped', code: 'SHARE_ALREADY_PROCESSED', skipped: true, confirmed: false, deliveryUncertain: false, recipientId, videoId: ID, previousStatus: 'confirmed' };
  for (const extra of [{ status: undefined }, { code: 'UNKNOWN_SKIP' }, { skipped: false }, { confirmed: true }, { deliveryUncertain: true }, { recipientId: `conv:${'c'.repeat(64)}` }, { videoId: '99999' }, { previousStatus: 'uncertain' }]) {
    const f = fixture(t, { sharing: true, decisions: [decision('share', { recipientId }), decision('skip')] }); f.shareService.share = async () => ({ ...good, ...extra });
    const result = await f.run(); assert.equal(result.status, 'needs_user'); assert.equal(f.requests.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.events.some(event => event.type === 'watch.share-skipped'), false); assert.equal(f.personaMemory.snapshot().recentObservations[0].actions.share, 0); assert.equal(f.actions.some(item => item.name === 'douyin_next'), false);
  }
  const f = fixture(t, { sharing: true, decisions: [decision('share', { recipientId })] }); f.shareService.share = async () => { throw new Error('合成未知分享错误'); }; const result = await f.run(); assert.equal(result.status, 'failed'); assert.match(result.lastError, /合成未知分享错误/); assert.equal(f.events.some(event => event.type === 'watch.share-skipped'), false);
});

test('分享回执不确定只暂停分享并继续观看；未知发送故障不伪装成成功互动', async t => {
  for (const options of [{ uncertain: true }, { sendFailure: true }]) {
    const f = fixture(t, { ...options, sharing: true, decisions: [decision('share', { recipientId }), decision('skip')] }); const final = await f.run();
    assert.equal(final.status, options.uncertain ? 'stopped' : 'failed'); assert.equal(f.requests.length, options.uncertain ? 3 : 1); assert.equal(f.sends.length, 1); assert.equal(f.actions.some(row => row.name === 'douyin_next'), !!options.uncertain);
    if(options.sendFailure)assert.equal(f.personaMemory.snapshot().interests.length, 0);
    assert.equal(f.personaMemory.snapshot().recentObservations.find(row=>row.videoId===ID).actions.share, 0); assert.equal(f.shareService.state().paused, !!options.uncertain);
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

test('模型等待暂停或停留期间换片与暂停仍停止学习，到视频截止立即结束', async t => {
  for (const options of [{ pauseDuringModel: true }, { switchDuringStay: true }, { pauseDuringStay: true }]) {
    const f = fixture(t, { ...options, modelDelayMs: 31000, duration: 100, decisions: [decision('stay', { seconds: 2 })] }); const result = await f.run();
    assert.equal(result.status, 'needs_user', JSON.stringify({ options, result })); assert.equal(f.personaMemory.snapshot().interests.length, 0); assert.equal(f.personaMemory.snapshot().recentObservations.find(row => row.videoId === ID).actions.stay, 0);
    if (options.switchDuringModel || options.pauseDuringModel) assert.equal(f.delays.length, 0);
  }
  const expired = fixture(t, { liveAccounting:true,modelDelayMs: 31000, delayMs: 27000, duration: 1000, decisions: [decision('stay', { seconds: 2 })] });
  expired.videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 1 }, { explicit: true }); const result = await expired.run();
  assert.equal(result.status, 'limited', JSON.stringify(result)); assert.equal(expired.requests.length, 1); assert.equal(expired.videoLimits.state().allowed, false); assert.equal(expired.personaMemory.snapshot().interests.length, 0); assert.equal(expired.personaMemory.snapshot().recentObservations[0].actions.stay, 0);
});

test('模型等待A变B后丢弃所有非stop旧决策，只重新观察B，不学习或对B执行A动作', async t => {
  for (const action of ['skip', 'stay', 'search', 'share', 'comment']) {
    const selected = decision(action, action === 'share' ? { recipientId } : action === 'search' ? { query: '合成主题' } : action === 'stay' ? { seconds: 2 } : {});
    const f = fixture(t, { sharing: true, switchDuringModel: true, duration: 100, decisions: [selected, decision('stop')] });
    let comments = 0; f.watch.commentService = { context: () => ({ enabled: true, paused: false, remainingDaily: 1, remainingSession: 1 }), comment: async () => { comments++; assert.fail('旧作品评论不能作用到新作品'); } }; f.watch.commentAgent.generate = async () => { comments++; assert.fail('旧作品不应生成评论'); };
    const result = await f.run(); assert.equal(result.status, 'stopped', action); assert.equal(result.lastError, ''); assert.equal(f.requests.length, 2); assert.equal(f.sends.length, 0); assert.equal(comments, 0); assert.deepEqual(f.delays, []);
    assert.equal(f.actions.some(item => ['douyin_next', 'douyin_search', 'douyin_open_video'].includes(item.name)), false); assert.equal(f.actions.filter(item => item.name === 'douyin_observe').length, 2); assert.equal(f.personaMemory.snapshot().interests.length, 0);
    const old = f.personaMemory.snapshot().recentObservations.find(item => item.videoId === ID); assert.deepEqual(old.actions, { stay: 0, skip: 0, share: 0 }); assert.ok(f.personaMemory.snapshot().recentObservations.some(item => item.videoId !== ID));
    const dropped = f.events.filter(event => event.type === 'watch.decision-discarded'); assert.equal(dropped.length, 1); assert.equal(dropped[0].action, action); assert.equal(dropped[0].expectedVideoId, ID); assert.notEqual(dropped[0].currentVideoId, ID);
  }
});

test('换片输入前A已变B的精确stale回执不产生第二次输入，重新观察B而不记A的skip', async t => {
  const f = fixture(t, { decisions: [decision('skip'), decision('stop')] }), execute = f.watch.controller.execute; let skipChecks = 0;
  f.watch.controller.execute = async (name, args, controls) => {
    if (name !== 'douyin_next') return execute(name, args, controls);
    skipChecks++; assert.equal(skipChecks, 1); assert.deepEqual(args, {}); assert.equal(controls.expectedVideoId, ID);
    const state = f.switchVideo(); return { changed: false, staleObservation: true, reasonCode: 'observed-video-changed', expectedVideoId: ID, before: state.video, after: state.video, state };
  };
  const result = await f.run(); assert.equal(result.status, 'stopped'); assert.equal(f.requests.length, 2); assert.equal(skipChecks, 1); assert.equal(f.actions.filter(item => item.name === 'douyin_next').length, 0); assert.equal(f.actions.filter(item => item.name === 'douyin_observe').length, 2); assert.equal(f.personaMemory.snapshot().interests.length, 0); assert.equal(f.personaMemory.snapshot().recentObservations.find(item => item.videoId === ID).actions.skip, 0); assert.equal(f.events.filter(event => event.type === 'watch.decision-discarded').length, 1);
});

test('伪装或不完整stale回执、同片、暂停、未就绪和验证码都不能当成正常换片继续', async t => {
  for (const mutation of ['changed', 'flag', 'reason', 'expected', 'same', 'paused', 'unready', 'missing', 'verification']) {
    const f = fixture(t, { decisions: [decision('skip'), decision('stop')] }), execute = f.watch.controller.execute;
    f.watch.controller.execute = async (name, args, controls) => {
      if (name !== 'douyin_next') return execute(name, args, controls);
      assert.equal(controls.expectedVideoId, ID); const state = mutation === 'same' ? f.current() : f.switchVideo(); const output = { changed: false, staleObservation: true, reasonCode: 'observed-video-changed', expectedVideoId: ID, state };
      if (mutation === 'changed') output.changed = true; if (mutation === 'flag') output.staleObservation = false; if (mutation === 'reason') output.reasonCode = 'unknown-reason'; if (mutation === 'expected') output.expectedVideoId = '9999999999999'; if (mutation === 'paused') state.video.paused = true; if (mutation === 'unready') state.video.readyState = 1; if (mutation === 'missing') delete output.state; if (mutation === 'verification') state.verificationRequired = true;
      return output;
    };
    const result = await f.run(); assert.equal(result.status, 'needs_user', mutation); assert.equal(f.requests.length, 1); assert.equal(f.personaMemory.snapshot().interests.length, 0); assert.equal(f.personaMemory.snapshot().recentObservations.find(item => item.videoId === ID).actions.skip, 0); assert.equal(f.events.some(event => event.type === 'watch.decision-discarded'), false);
  }
});

test('模型等待已换片但新片暂停、验证或未就绪时仍停，不因重采样自动播放', async t => {
  for (const mutation of ['paused', 'unready', 'verification']) {
    const f = fixture(t, { switchDuringModel: true, decisions: [decision('stay', { seconds: 2 }), decision('stop')] }), execute = f.watch.controller.execute;
    f.watch.controller.execute = async (name, ...args) => { const output = await execute(name, ...args); if (name === 'douyin_status' && f.requests.length) { if (mutation === 'paused') output.video.paused = true; if (mutation === 'unready') output.video.readyState = 1; if (mutation === 'verification') output.verificationRequired = true; } return output; };
    const result = await f.run(); assert.equal(result.status, 'needs_user', mutation); assert.equal(f.requests.length, 1); assert.equal(f.actions.some(item => item.name === 'douyin_play'), false); assert.equal(f.personaMemory.snapshot().interests.length, 0);
  }
});

test('模型后暂缺ID两次时只读等待，B就绪后丢旧动作重采样，不新模型或额外输入', async t => {
  const f = fixture(t, { decisions: [decision('skip'), decision('stop')] }), execute = f.watch.controller.execute; let reads = 0;
  f.watch.controller.execute = async (name, ...args) => {
    const output = await execute(name, ...args);
    if (name === 'douyin_status' && f.requests.length === 1) { reads++; if (reads <= 2) return { ...output, video: { ...output.video, id: null, readyState: 0 } }; if (reads === 3) return f.switchVideo(); }
    return output;
  };
  const result = await f.run(); assert.equal(result.status, 'stopped'); assert.equal(result.lastError, ''); assert.equal(reads, 3); assert.deepEqual(f.delays, [250, 250]); assert.equal(f.requests.length, 2); assert.equal(f.actions.some(item => item.name === 'douyin_next'), false); assert.equal(f.actions.filter(item => item.name === 'douyin_observe').length, 2); assert.equal(f.personaMemory.snapshot().recentObservations.find(item => item.videoId === ID).actions.skip, 0); assert.equal(f.personaMemory.snapshot().interests.length, 0);
});

test('模型后未知作品持续不就绪时最多四秒只读等待，不盲重试输入或新模型', async t => {
  const f = fixture(t, { decisions: [decision('skip')] }), execute = f.watch.controller.execute;
  f.watch.controller.execute = async (name, ...args) => { const output = await execute(name, ...args); return name === 'douyin_status' && f.requests.length ? { ...output, video: { ...output.video, id: null, readyState: 0 } } : output; };
  const result = await f.run(); assert.equal(result.status, 'needs_user'); assert.match(result.lastError, /仍未稳定/); assert.equal(f.delays.length, 16); assert.equal(f.delays.reduce((sum, ms) => sum + ms, 0), 4000); assert.equal(f.requests.length, 1); assert.equal(f.actions.some(item => item.name === 'douyin_next'), false); assert.equal(f.personaMemory.snapshot().interests.length, 0);
});

test('暂缺ID但明确暂停、验证码、离站或私信遮挡时立即停止，不进入过渡帧等待', async t => {
  for (const mutation of ['paused', 'verification', 'offsite', 'private']) {
    const f = fixture(t, { decisions: [decision('skip')] }), execute = f.watch.controller.execute;
    f.watch.controller.execute = async (name, ...args) => { const output = await execute(name, ...args); if (name === 'douyin_status' && f.requests.length) { output.video.id = null; output.video.readyState = 0; if (mutation === 'paused') output.video.paused = true; if (mutation === 'verification') output.verificationRequired = true; if (mutation === 'offsite') output.url = 'https://example.invalid/'; if (mutation === 'private') output.privateChatVisible = true; } return output; };
    const result = await f.run(); assert.equal(result.status, 'needs_user', mutation); assert.deepEqual(f.delays, []); assert.equal(f.requests.length, 1); assert.equal(f.actions.some(item => item.name === 'douyin_next'), false);
  }
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
