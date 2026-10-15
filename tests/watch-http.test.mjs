import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { AutonomousWatch } from '../autonomous-watch.mjs';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';
import { createApiServer } from '../app.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGDkAAAAASUVORK5CYII=';
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-watch-http-')), stateDir = path.join(root, 'state');
  const config = { apiKey: 'synthetic-http-key', model: 'synthetic', baseUrl: 'https://synthetic.example' }, entered = Promise.withResolvers();
  const personaMemory = new PersonaMemory({ memoryDir: path.join(root, 'memory'), legacyRoleCardFile: path.join(root, 'absent-card.md') });
  const videoLimits = new VideoLimits({ stateDir }); const actions = [], pauses = []; let closes = 0;
  const state = { url: 'https://www.douyin.com/video/7579432563794584933', loginRequired: false, verificationRequired: false, privateChatVisible: false, video: { id: '7579432563794584933', url: 'https://www.douyin.com/video/7579432563794584933', title: '合成画面', time: 1, duration: 100, readyState: 4, paused: false } };
  const controller = { source: 'api', execute: async name => { actions.push(name); return name === 'douyin_observe' ? { state, frames: [{ mimeType: 'image/png', data: PNG, videoId: state.video.id, time: 1 }], observation: { videoId: state.video.id } } : state; }, pauseForLimits: async () => ({}), close: async () => { closes++; } };
  const decisionProvider = ({ signal }) => new Promise((resolve, reject) => { entered.resolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  const watchService = new AutonomousWatch({ controller, config, videoLimits, personaMemory, stateDir, decisionProvider });
  const chatService = { state: () => ({ policy: { allowlist: [{ id: 'synthetic-friend', followed: true, isGroup: false }] } }), close: async () => {} };
  const server = createApiServer({ controller, config, personaMemory, watchService, videoLimits, chatService, pauseVideoSources: async source => { pauses.push(source); }, port: 0 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await server.stop(); await watchService.close(); const target = path.resolve(root); if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试目录越界。'); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`, bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  const request = async (route, body) => { const response = await fetch(base + route, { headers: { 'x-session-token': bootstrap.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; };
  return { root, server, config, controller, watchService, personaMemory, videoLimits, base, bootstrap, request, entered, decisionProvider, pauses, actions, closes: () => closes };
}

test('自主观看和人格HTTP校验token；有限轮次、互斥及手编版本由真实服务执行', async t => {
  const f = await fixture(t); assert.equal(f.bootstrap.watch.available, true); assert.equal(f.bootstrap.persona.available, true);
  assert.equal((await fetch(`${f.base}/api/persona`)).status, 403); assert.equal((await fetch(`${f.base}/api/watch/state`)).status, 403);
  assert.equal((await f.request('/api/watch/start', {})).status, 409); assert.equal((await f.request('/api/watch/start', { unsafe: true })).status, 400);
  assert.equal((await f.request('/api/video/start', {})).status, 200);
  const started = await f.request('/api/watch/start', { startSession: false, maxRequests: 2 }); assert.equal(started.status, 200); await f.entered.promise;
  const persona = await f.request('/api/persona'); assert.equal(persona.status, 200);
  assert.equal((await f.request('/api/persona/card', { text: '合成新人格', expectedRevision: persona.body.revision })).status, 409);
  assert.equal((await f.request('/api/task', { instruction: '不应并行的合成任务' })).status, 409);
  assert.equal((await f.request('/api/forward', { recipientId: 'synthetic-friend' })).status, 409);
  assert.equal((await f.request('/api/video/start', {})).status, 409); assert.throws(() => f.server.configureApi({}), /先停止/);
  assert.equal((await f.request('/api/watch/stop', { unsafe: true })).status, 400);
  const stopped = await f.request('/api/watch/stop', {}); assert.equal(stopped.status, 200); assert.equal(stopped.body.running, false); assert.equal(stopped.body.counts.requests, 1);
  const fresh = (await f.request('/api/persona')).body;
  const saved = await f.request('/api/persona/card', { text: '合成新人格：说话简洁。', expectedRevision: fresh.revision }); assert.equal(saved.status, 200); assert.match(saved.body.manualText, /说话简洁/);
  assert.equal((await f.request('/api/persona/card', { text: '不应覆盖', expectedRevision: fresh.revision })).status, 409);
  assert.equal(JSON.stringify({ started, persona, stopped, saved }).includes(f.config.apiKey), false); assert.equal(f.actions.some(name => /forward|chat/.test(name)), false);
});

test('软件服务关闭保留另一个DSH入口的owner循环及其视频，显式合作停止才结束它', async t => {
  const f = await fixture(t), nativeEntered = Promise.withResolvers(); let nativePauses = 0;
  const controller = { ...f.controller, source: 'dsh', pauseForLimits: async () => { nativePauses++; return {}; } };
  const native = new AutonomousWatch({ controller, config: {}, videoLimits: f.videoLimits, personaMemory: f.personaMemory, stateDir: path.join(f.root, 'state'), source: 'dsh', decisionProvider: ({ signal }) => new Promise((resolve, reject) => { nativeEntered.resolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  t.after(() => native.close()); native.start({ startSession: true }, { explicit: true }); await nativeEntered.promise;
  assert.equal(f.watchService.state().owned, false); await f.server.stop();
  assert.equal(native.state().running, true); assert.equal(nativePauses, 0); assert.deepEqual(f.pauses, ['api']); assert.equal(f.closes(), 1);
  const pending = await f.watchService.stop({ explicit: true }); assert.equal(pending.status, 'stopping'); await native.completion; assert.equal(nativePauses, 1);
});
