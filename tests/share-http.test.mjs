import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { AutonomousShare } from '../autonomous-share.mjs';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';
import { createApiServer } from '../app.mjs';

const friend = `conv:${'e'.repeat(64)}`;
async function fixture(t, send = async () => { throw new Error('设置接口不能触发发送'); }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-share-http-')), stateDir = path.join(root, 'state'), memoryDir = path.join(root, 'memory');
  const overrides = { DOUYIN_RUNTIME_LOCATION_FILE: path.join(root, 'location.json'), DOUYIN_STATE_DIR: stateDir, DEEPSEEK_SHARED_MEMORY_DB: path.join(memoryDir, 'shared.sqlite') };
  const oldEnv = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]])); Object.assign(process.env, overrides);
  const personaMemory = new PersonaMemory({ memoryDir, legacyRoleCardFile: path.join(root, 'absent-card.md') }); personaMemory.initialize();
  const now = () => Date.parse('2026-10-15T04:00:00Z'), videoLimits = new VideoLimits({ stateDir, now });
  videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 10 }, { explicit: true }); videoLimits.markSession('api', { explicit: true });
  fs.writeFileSync(path.join(stateDir, 'chat-policy.json'), JSON.stringify({ allowlist: [{ id: friend, name: '合成已验证好友', followed: true, isGroup: false, verifiedAt: '2026-10-15T01:00:00Z' }] }));
  const evidenceId = personaMemory.recordObservation({ url: 'https://www.douyin.com/video/12345', loginRequired: false, verificationRequired: false, privateChatVisible: false, video: { id: '12345', url: 'https://www.douyin.com/video/12345', time: 2, duration: 50, readyState: 4, paused: false } }, { source: 'api' }).evidenceId;
  const shareService = new AutonomousShare({ personaMemory, videoLimits, stateDir, now, send });
  let browserCalls = 0, closed = 0;
  const controller = { execute: async () => { browserCalls++; throw new Error('设置接口不能进入浏览器'); }, close: async () => { closed++; } };
  const server = createApiServer({ controller, config: { apiKey: '', model: 'synthetic-model' }, personaMemory, shareService, videoLimits, pauseVideoSources: async () => {}, port: 0 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, bootstrap = await (await fetch(origin + '/api/bootstrap')).json();
  const request = async (route, body, headers = {}) => {
    const response = await fetch(origin + route, { headers: { 'x-session-token': bootstrap.token, ...body !== undefined ? { 'content-type': 'application/json' } : {}, ...headers }, ...body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {} });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { await server.stop(); for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } const target = path.resolve(root); assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(target, { recursive: true, force: true }); });
  return { root, stateDir, origin, bootstrap, request, server, shareService, videoLimits, input: { evidenceId, videoId: '12345', recipientId: friend, reason: '合成作品分享决定' }, stats: () => ({ browserCalls, closed }) };
}

test('分享设置HTTP要求本机token和同源，只接受开关与预算，不启动浏览器或视频轮次', async t => {
  const f = await fixture(t), sessions = fs.readFileSync(f.videoLimits.sessionsFile, 'utf8');
  assert.equal(f.bootstrap.config.configured, false); assert.equal(f.bootstrap.share.available, true);
  assert.equal((await fetch(f.origin + '/api/share/state')).status, 403);
  assert.equal((await f.request('/api/share/configure', { enabled: true }, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.request('/api/share/configure', { enabled: true }, { 'sec-fetch-site': 'same-site' })).status, 403);
  const initial = await f.request('/api/share/state'); assert.equal(initial.body.enabled, false); assert.equal(initial.body.dailyLimit, 3);
  for (const body of [{ enabled: true, recipientId: friend }, { enabled: true, dailyLimit: 21 }, { enabled: true, url: 'https://www.douyin.com/video/999' }, { dailyLimit: 3 }]) assert.equal((await f.request('/api/share/configure', body)).status, 400);
  const configured = await f.request('/api/share/configure', { enabled: true, dailyLimit: 4 }); assert.equal(configured.status, 200); assert.equal(configured.body.dailyLimit, 4); assert.equal(configured.body.recipients[0].id, friend);
  assert.equal((await f.request('/api/share/send', f.input)).status, 404); assert.equal((await f.request('/api/share/configure', { enabled: false })).status, 200);
  assert.equal(f.stats().browserCalls, 0); assert.equal(fs.readFileSync(f.videoLimits.sessionsFile, 'utf8'), sessions); assert.equal(f.shareService.state().daily.attempts, 0);
});

test('HTTP保留未确认卡片的核对入口，核对不清空预算或自动重新启用', async t => {
  const f = await fixture(t, async (input, { authorize }) => { authorize({ phase: 'before-click', videoId: input.expectedVideoId, recipientId: input.recipientId }); return { confirmed: false, deliveryUncertain: true, operationId: 'synthetic-forward-uncertain' }; });
  await f.request('/api/share/configure', { enabled: true }); const sent = await f.shareService.share(f.input);
  const state = await f.request('/api/share/state'); assert.equal(state.status, 200); assert.equal(state.body.paused, true); assert.equal(state.body.needsReview[0].operationId, sent.operationId);
  await f.request('/api/share/configure', { enabled: false }); assert.equal((await f.request('/api/share/configure', { enabled: true })).status, 409);
  assert.equal((await f.request('/api/share/resolve', { operationId: sent.operationId, outcome: 'reset-budget' })).status, 400);
  assert.equal((await f.request('/api/share/resolve', { operationId: sent.operationId, outcome: 'not-sent', enabled: true })).status, 400);
  const resolved = await f.request('/api/share/resolve', { operationId: sent.operationId, outcome: 'not-sent' }); assert.equal(resolved.status, 200); assert.equal(resolved.body.paused, false); assert.equal(resolved.body.enabled, false); assert.equal(resolved.body.daily.attempts, 1);
  await f.request('/api/share/configure', { enabled: true }); await assert.rejects(f.shareService.share(f.input), /重复/); assert.equal(f.stats().browserCalls, 0);
});

test('关闭软件HTTP服务会等待自己尚未发送的分享取消并释放共享锁', async t => {
  const entered = Promise.withResolvers();
  const f = await fixture(t, async (input, { signal, authorize }) => { authorize({ phase: 'prepare', videoId: input.expectedVideoId, recipientId: input.recipientId }); entered.resolve(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); });
  await f.request('/api/share/configure', { enabled: true }); const sharing = f.shareService.share(f.input); const rejection = assert.rejects(sharing, /关闭/); await entered.promise;
  await f.server.stop(); await rejection; assert.equal(f.shareService.active, null); assert.equal(fs.existsSync(f.shareService.files.send), false); assert.equal(f.shareService.ledger().operations[0].status, 'not-sent'); assert.equal(f.stats().closed, 1);
  await assert.rejects(fetch(f.origin));
});

test('最终输入锁占用时关闭接口明确返回忙，释放后才能回报已关闭', async t => {
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const f = await fixture(t, async (input, { authorize }) => {
    authorize({ phase: 'before-click', videoId: input.expectedVideoId, recipientId: input.recipientId });
    const release = authorize.beginDispatch(); entered.resolve();
    try { await finish.promise; } finally { release(); }
    return { confirmed: false, deliveryUncertain: true };
  });
  await f.request('/api/share/configure', { enabled: true });
  const sharing = f.shareService.share(f.input); await entered.promise;
  try {
    const blocked = await f.request('/api/share/configure', { enabled: false });
    assert.equal(blocked.status, 409); assert.equal(f.shareService.policy().enabled, true);
  } finally { finish.resolve(); }
  await sharing;
  const closed = await f.request('/api/share/configure', { enabled: false });
  assert.equal(closed.status, 200); assert.equal(closed.body.enabled, false); assert.equal(closed.body.paused, true);
  assert.equal(fs.existsSync(f.shareService.files.control), false);
});
