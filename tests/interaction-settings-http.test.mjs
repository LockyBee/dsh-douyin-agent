import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApiServer } from '../app.mjs';
import { AutonomousComments } from '../autonomous-comments.mjs';
import { DailyReport } from '../daily-report.mjs';
import { WatchMode } from '../watch-mode.mjs';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';

const videoId = '7579432563794584933';
const videoState = () => ({ url: `https://www.douyin.com/video/${videoId}`, loginRequired: false, verificationRequired: false, privateChatVisible: false, video: { id: videoId, url: `https://www.douyin.com/video/${videoId}`, title: '合成公开视频', author: '合成作者', time: 2, duration: 30, readyState: 4, paused: false } });
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-interaction-http-')), stateDir = path.join(root, 'state');
  const now = () => Date.parse('2026-10-16T04:00:00Z');
  const personaMemory = new PersonaMemory({ memoryDir: path.join(root, 'memory'), legacyRoleCardFile: path.join(root, 'absent-card.md'), clock: now }); personaMemory.initialize({ importLegacy: false });
  const videoLimits = new VideoLimits({ stateDir, now }); videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 10 }, { explicit: true }); videoLimits.markSession('api', { explicit: true });
  const runId = 'synthetic-http-watch'; fs.writeFileSync(path.join(stateDir, 'watch-loop.lock'), JSON.stringify({ version: 1, pid: process.pid, runId, source: 'api', status: 'running', sessionId: videoLimits.state().session.id }));
  const evidenceId = personaMemory.recordObservation(videoState(), { source: 'api' }).evidenceId;
  let browserCalls = 0, closed = 0; const applied = [];
  const controller = { source: 'api', execute: async () => { browserCalls++; throw new Error('设置接口不能操作浏览器'); }, close: async () => { closed++; }, ...(options.apply ? { applyWatchMode: async input => { applied.push(input); return { applied: false, pendingNextVideoAction: true, focusRequested: false }; } } : {}) };
  const commentService = new AutonomousComments({ personaMemory, videoLimits, stateDir, now, post: options.post || (async () => assert.fail('设置接口不能发布评论')) });
  const reportService = new DailyReport({ personaMemory, now }), modeService = new WatchMode({ stateDir, now });
  const config = { apiKey: 'synthetic-http-secret', model: 'synthetic', baseUrl: 'https://synthetic.example' };
  const agent = { config, runTask: async () => assert.fail('设置接口不能调用模型') };
  const watchService = { config, agent: { config }, commentAgent: { config }, state: () => ({ running: false, owned: false }), cancel() {}, close: async () => {} };
  const server = createApiServer({ controller, config, agent, personaMemory, videoLimits, watchService, ...(options.unavailable ? {} : { commentService, reportService, modeService }), pauseVideoSources: async () => {}, port: 0 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, bootstrap = await (await fetch(origin + '/api/bootstrap')).json();
  const request = async (route, body, headers = {}) => { const response = await fetch(origin + route, { headers: { 'x-session-token': bootstrap.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; };
  t.after(async () => { await server.stop(); await commentService.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^douyin-interaction-http-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, stateDir, now, personaMemory, videoLimits, runId, input: { evidenceId, videoId, text: '这个配色很舒服。' }, controller, config, agent, watchService, commentService, reportService, modeService, server, origin, bootstrap, request, applied, stats: () => ({ browserCalls, closed }) };
}

test('评论、日报和静默设置均受本机token与同源限制，未注入服务明确不可用', async t => {
  const f = await fixture(t);
  for (const key of ['comments', 'reports', 'mode']) assert.equal(f.bootstrap[key].available, true);
  for (const endpoint of ['comments/state', 'reports/state', 'mode/state']) {
    assert.equal((await fetch(`${f.origin}/api/${endpoint}`)).status, 403);
    assert.equal((await f.request(`/api/${endpoint}`, undefined, { origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await f.request(`/api/${endpoint}`, undefined, { 'sec-fetch-site': 'same-site' })).status, 403);
  }
  const absent = await fixture(t, { unavailable: true });
  for (const key of ['comments', 'reports', 'mode']) { assert.equal(absent.bootstrap[key].available, false); assert.equal((await absent.request(`/api/${key}/state`)).status, 503); }
  assert.equal(f.stats().browserCalls, 0);
});

test('评论HTTP仅允许显式总开关和有限预算，不接受正文、作品、发送或模型字段', async t => {
  const f = await fixture(t), sessions = fs.readFileSync(f.videoLimits.sessionsFile, 'utf8');
  const initial = await f.request('/api/comments/state'); assert.equal(initial.body.enabled, false); assert.equal(initial.body.policy.dailyLimit, 3);
  for (const body of [{}, { dailyLimit: 3 }, { enabled: 1 }, { enabled: true, dailyLimit: 21 }, { enabled: true, perSessionLimit: 4 }, { enabled: true, text: '合成评论' }, { enabled: true, videoId }, { enabled: true, explicit: true }, { enabled: true, apiKey: 'synthetic-new-key' }]) assert.equal((await f.request('/api/comments/configure', body)).status, 400, JSON.stringify(body));
  const configured = await f.request('/api/comments/configure', { enabled: true, dailyLimit: 4, perSessionLimit: 2 }); assert.equal(configured.status, 200); assert.deepEqual(configured.body.policy, { enabled: true, dailyLimit: 4, perSessionLimit: 2 });
  assert.equal((await f.request('/api/comments/comment', f.input)).status, 404); assert.equal((await f.request('/api/comments/state?enabled=true')).status, 400);
  assert.equal((await f.request('/api/comments/configure', { enabled: false })).body.enabled, false);
  assert.equal(f.commentService.state().daily.attempts, 0); assert.equal(fs.readFileSync(f.videoLimits.sessionsFile, 'utf8'), sessions); assert.equal(f.stats().browserCalls, 0);
});

test('评论核对HTTP保留扣过的额度与作品去重，不把未确认当成功或自动重发', async t => {
  const f = await fixture(t, { post: async (input, { authorize }) => { authorize({ phase: 'before-click', videoId: input.expectedVideoId }); return { confirmed: false, deliveryUncertain: true }; } });
  await f.request('/api/comments/configure', { enabled: true }); const result = await f.commentService.comment(f.input, { watchRunId: f.runId });
  const current = await f.request('/api/comments/state'); assert.equal(current.body.paused, true); assert.equal(current.body.needsReview[0].operationId, result.operationId);
  assert.equal((await f.request('/api/comments/resolve', { operationId: result.operationId, outcome: 'reset-budget' })).status, 400);
  assert.equal((await f.request('/api/comments/resolve', { operationId: result.operationId, outcome: 'not-sent', enabled: true })).status, 400);
  await f.request('/api/comments/configure', { enabled: false });
  const resolved = await f.request('/api/comments/resolve', { operationId: result.operationId, outcome: 'not-sent' }); assert.equal(resolved.status, 200); assert.equal(resolved.body.paused, false); assert.equal(resolved.body.enabled, false); assert.equal(resolved.body.daily.attempts, 1);
  await f.request('/api/comments/configure', { enabled: true }); await assert.rejects(f.commentService.comment(f.input, { watchRunId: f.runId }), /重复|次数/); assert.equal(f.stats().browserCalls, 0);
});

test('日报HTTP只生成今天的真实本地证据，可回读且拒绝任意日期、路径与正文写入', async t => {
  const f = await fixture(t); const before = await f.request('/api/reports/state'); assert.equal(before.body.reports.length, 0);
  assert.equal((await f.request('/api/reports/read?date=2026-10-16')).status, 404);
  for (const route of ['/api/reports/read?date=../secret', '/api/reports/read?date=2026-02-30', '/api/reports/read?date=2026-10-16&date=2026-10-15', '/api/reports/read?path=secret', '/api/reports/state?date=2026-10-16']) assert.equal((await f.request(route)).status, 400, route);
  for (const body of [{ date: '2026-10-15' }, { markdown: '不可信正文' }, { reason: 'watch-finished' }]) assert.equal((await f.request('/api/reports/generate', body)).status, 400);
  assert.equal((await f.request('/api/reports/generate?date=2026-10-16', {})).status, 400);
  const generated = await f.request('/api/reports/generate', {}); assert.equal(generated.status, 200); assert.equal(generated.body.date, '2026-10-16'); assert.equal(generated.body.observedCount, 1); assert.match(generated.body.markdown, /合成公开视频/);
  const read = await f.request('/api/reports/read?date=2026-10-16'); assert.equal(read.body.markdown, generated.body.markdown); assert.equal((await f.request('/api/reports/read')).body.markdown, generated.body.markdown);
  assert.equal((await f.request('/api/reports/generate', {})).body.changed, false); assert.equal((await f.request('/api/reports/state')).body.reports.length, 1);
  assert.equal(JSON.stringify(generated).includes(f.config.apiKey), false); assert.equal(f.stats().browserCalls, 0);
});

test('日报HTTP保留手工修改并报告冲突，不覆盖用户自己的内容', async t => {
  const f = await fixture(t), generated = await f.request('/api/reports/generate', {}), changed = generated.body.markdown + '\n合成用户补充'; fs.writeFileSync(generated.body.path, changed);
  const response = await f.request('/api/reports/generate', {}); assert.equal(response.status, 409); assert.equal(fs.readFileSync(generated.body.path, 'utf8'), changed);
  const state = await f.request('/api/reports/state'); assert.equal(state.body.today.conflict, true);
});

test('静默设置仅保存开关并声明待应用，不开启浏览器、不修改视频轮次或抢焦点', async t => {
  const f = await fixture(t), sessions = fs.readFileSync(f.videoLimits.sessionsFile, 'utf8');
  assert.equal((await f.request('/api/mode/state')).body.silent, false);
  for (const body of [{}, { silent: 1 }, { silent: true, play: true }, { silent: true, startSession: true }, { silent: true, explicit: true }]) assert.equal((await f.request('/api/mode/configure', body)).status, 400);
  assert.equal((await f.request('/api/mode/configure?silent=true', { silent: true })).status, 400);
  const saved = await f.request('/api/mode/configure', { silent: true }); assert.equal(saved.status, 200); assert.equal(saved.body.silent, true); assert.equal(saved.body.applied, false); assert.equal(saved.body.pendingNextVideoAction, true);
  assert.equal((await f.request('/api/mode/state')).body.silent, true); assert.equal(fs.readFileSync(f.videoLimits.sessionsFile, 'utf8'), sessions); assert.equal(f.stats().browserCalls, 0);
  const connected = await fixture(t, { apply: true }); await connected.request('/api/mode/configure', { silent: true }); await connected.request('/api/mode/configure', { silent: false }); assert.deepEqual(connected.applied, [{ minimize: true }, { minimize: false }]);
});

test('进程内更换API同步专用评论模型，活动发布期间禁止切换凭据', async t => {
  const f = await fixture(t), original = f.config;
  f.server.configureApi({ apiKey: 'synthetic-replacement-key', baseUrl: 'https://synthetic.example/v1', model: 'new-synthetic-model' });
  assert.equal(f.watchService.commentAgent.config, original); assert.equal(f.watchService.commentAgent.config.apiKey, 'synthetic-replacement-key');
  f.commentService.active = { synthetic: true }; assert.throws(() => f.server.configureApi({ apiKey: 'another-synthetic-key' }), /先停止/); f.commentService.active = null;
  assert.equal(f.config.apiKey, 'synthetic-replacement-key'); assert.equal((await f.request('/api/comments/state')).status, 200);
});

test('关闭HTTP会取消自身未发布评论并等待锁释放，不遗留发送事务', async t => {
  const entered = Promise.withResolvers();
  const f = await fixture(t, { post: async (input, { signal, authorize }) => { authorize({ phase: 'prepare', videoId: input.expectedVideoId }); entered.resolve(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  await f.request('/api/comments/configure', { enabled: true }); const pending = f.commentService.comment(f.input, { watchRunId: f.runId }); const rejected = assert.rejects(pending, /关闭/); await entered.promise;
  await f.server.stop(); await rejected; assert.equal(f.commentService.active, null); assert.equal(fs.existsSync(f.commentService.files.send), false); assert.equal(f.commentService.state().daily.attempts, 1); assert.equal(f.stats().closed, 1);
});
