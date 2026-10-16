import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomousWatch } from '../autonomous-watch.mjs';
import { AutonomousComments } from '../autonomous-comments.mjs';
import { PublicCommentAgent, PUBLIC_COMMENT_PROMPT } from '../public-comment-agent.mjs';
import { parseWatchDecision } from '../api-agent.mjs';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';
import { DailyReport } from '../daily-report.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGDkAAAAASUVORK5CYII=';
const decision = action => ({ text: JSON.stringify({ action, reason: '合成画面有具体配色可说。', reflection: '只记录有限画面。', topics: [{ topic: '配色', signal: 'neutral' }] }) });
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-watch-comment-')), stateDir = path.join(root, 'state'); let clock = Date.parse('2026-10-16T04:00:00Z'), time = 0, videoId = '7579432563794584933', decisions = 0, generated = 0;
  const now = () => clock, personaMemory = new PersonaMemory({ memoryDir: path.join(root, 'memory'), legacyRoleCardFile: path.join(root, 'no-role.md'), clock: now }); personaMemory.initialize({ importLegacy: false });
  personaMemory.context = () => 'PRIVATE_PERSONA_SENTINEL';
  const videoLimits = new VideoLimits({ stateDir, now }); videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 10 }, { explicit: true });
  const state = () => ({ url: `https://www.douyin.com/video/${videoId}`, loginRequired: false, verificationRequired: false, privateChatVisible: false, secret: 'PRIVATE_STATE_SENTINEL', video: { id: videoId, url: `https://www.douyin.com/video/${videoId}`, title: '合成青金配色', author: '合成作者', time, duration: 60, paused: false, readyState: 4 } });
  const calls = [], posts = [], events = [], modelRequests = [];
  const controller = { source: 'api', execute: async (name, _args, { signal } = {}) => { signal?.throwIfAborted(); calls.push(name); if (name === 'douyin_observe') { time += 3; clock += 3000; return { state: state(), frames: [{ videoId, time, mimeType: 'image/png', data: PNG }], observation: { videoId } }; } return state(); }, pauseForLimits: async () => ({ paused: 1 }) };
  const post = overrides.post || (async (input, { authorize }) => { posts.push(input); authorize({ phase: 'prepare', videoId: input.expectedVideoId }); authorize({ phase: 'before-click', videoId: input.expectedVideoId }); const release = authorize.beginDispatch(); release(); return { confirmed: true, deliveryUncertain: false, videoId: input.expectedVideoId, commentId: '90001' }; });
  const commentService = new AutonomousComments({ personaMemory, videoLimits, stateDir, now, post });
  const reportService = new DailyReport({ personaMemory, now }), config = { apiKey: 'synthetic-comment-flow-key', baseUrl: 'https://synthetic.invalid', model: 'synthetic' };
  let provider = async request => { modelRequests.push(request); if (request.system === PUBLIC_COMMENT_PROMPT) { generated++; return { text: JSON.stringify({ text: overrides.text === undefined ? '这个青金配色很舒服。' : overrides.text }), usage: { total_tokens: 2 } }; } decisions++; return decision(decisions === 1 ? 'comment' : 'stop'); };
  const watch = new AutonomousWatch({ controller, config, personaMemory, videoLimits, stateDir, now, commentService, reportService, commentAgent: new PublicCommentAgent({ config }), decisionProvider: request => provider(request), onEvent: event => events.push(event) });
  t.after(async () => { await watch.close(); await commentService.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^douyin-watch-comment-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, stateDir, watch, commentService, reportService, personaMemory, videoLimits, calls, posts, events, modelRequests, state, setVideo: value => { videoId = value; }, provider: value => { provider = value; }, counts: () => ({ decisions, generated }) };
}

test('watch评论使用独立公开视频请求，同一实际观察绑定作品，计入共享模型额度并生成本地日报', async t => {
  const f = fixture(t); f.commentService.configure({ enabled: true }, { explicit: true }); f.watch.start({ startSession: true, maxRequests: 3 }, { explicit: true }); await f.watch.completion;
  assert.equal(f.watch.state().status, 'stopped'); assert.equal(f.watch.state().counts.requests, 3); assert.deepEqual(f.counts(), { decisions: 2, generated: 1 }); assert.equal(f.posts.length, 1); assert.deepEqual(f.posts[0], { expectedVideoId: '7579432563794584933', text: '这个青金配色很舒服。' });
  const publicRequest = f.modelRequests.find(request => request.system === PUBLIC_COMMENT_PROMPT); assert.doesNotMatch(JSON.stringify(publicRequest.messages), /PRIVATE_(PERSONA|STATE)_SENTINEL/); assert.match(JSON.stringify(f.modelRequests[0].messages), /PRIVATE_PERSONA_SENTINEL/);
  assert.equal(f.commentService.state().daily.attempts, 1); assert.equal(f.commentService.state().recent[0].status, 'confirmed'); assert.equal(f.personaMemory.snapshot().interests.length, 0); assert.equal(f.events.some(event => event.type === 'watch.comment'), true); assert.equal(f.reportService.read().observedCount, 1); assert.equal(f.calls.some(name => /chat|forward|like/.test(name)), false);
});

test('watch评论可生成null放弃，不调用发布器或消耗评论次数', async t => {
  const f = fixture(t, { text: null }); f.commentService.configure({ enabled: true }, { explicit: true }); f.watch.start({ startSession: true, maxRequests: 3 }, { explicit: true }); await f.watch.completion;
  assert.equal(f.watch.state().status, 'stopped'); assert.equal(f.watch.state().counts.requests, 3); assert.equal(f.posts.length, 0); assert.equal(f.commentService.state().daily.attempts, 0);
});

test('评论默认关闭、没有额度、未确认暂停或决策夹带正文都不能进入公开生成', async t => {
  const f = fixture(t); f.watch.start({ startSession: true, maxRequests: 3 }, { explicit: true }); await f.watch.completion; assert.equal(f.watch.state().status, 'failed'); assert.equal(f.counts().generated, 0); assert.equal(f.posts.length, 0);
  const value = JSON.parse(decision('comment').text), context = { enabled: true, remainingDaily: 3, remainingSession: 1, paused: false };
  for (const commentContext of [{ ...context, enabled: false }, { ...context, remainingDaily: 0 }, { ...context, remainingSession: 0 }, { ...context, paused: true }]) assert.throws(() => parseWatchDecision(value, { commentContext }));
  assert.throws(() => parseWatchDecision({ ...value, text: '不接受决策正文' }, { commentContext: context }));
});

test('专用评论模型也占请求预算，额度不足时不生成、不发布且保持有限轮次', async t => {
  const f = fixture(t); f.commentService.configure({ enabled: true }, { explicit: true }); f.watch.start({ startSession: true, maxRequests: 1 }, { explicit: true }); await f.watch.completion;
  assert.equal(f.watch.state().status, 'limited'); assert.equal(f.watch.state().counts.requests, 1); assert.equal(f.counts().generated, 0); assert.equal(f.posts.length, 0); assert.ok(Number.isFinite(f.videoLimits.state().session.expiresAt));
});

test('未确认公开评论立即停止watch并保留核对状态，没有第二条自动评论', async t => {
  const f = fixture(t, { post: async (input, { authorize }) => { authorize({ phase: 'before-click', videoId: input.expectedVideoId }); return { confirmed: false, deliveryUncertain: true }; } }); f.commentService.configure({ enabled: true }, { explicit: true }); f.watch.start({ startSession: true, maxRequests: 4 }, { explicit: true }); await f.watch.completion;
  assert.equal(f.watch.state().status, 'needs_user'); assert.equal(f.watch.state().counts.requests, 2); assert.equal(f.commentService.state().paused, true); assert.equal(f.commentService.state().daily.attempts, 1); assert.equal(f.counts().decisions, 1);
});

test('生成期间用户关闭许可或停止watch，返回的文本不会发布', async t => {
  for (const mode of ['disabled', 'stopped']) {
    const f = fixture(t), entered = Promise.withResolvers(); f.commentService.configure({ enabled: true }, { explicit: true });
    f.provider(async request => { if (request.system !== PUBLIC_COMMENT_PROMPT) return decision('comment'); if (mode === 'disabled') { f.commentService.configure({ enabled: false }, { explicit: true }); return { text: JSON.stringify({ text: '不应发布的合成评论' }) }; } entered.resolve(); return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); });
    f.watch.start({ startSession: true, maxRequests: 3 }, { explicit: true }); if (mode === 'stopped') { await entered.promise; await f.watch.stop({ explicit: true }); } await f.watch.completion;
    assert.equal(f.posts.length, 0); assert.equal(f.commentService.state().daily.attempts, 0); assert.equal(f.watch.state().status, mode === 'stopped' ? 'stopped' : 'failed');
  }
});
