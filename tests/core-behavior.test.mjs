import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserController } from '../core.mjs';
import { PersonaMemory } from '../persona-memory.mjs';

const ID = '7579432563794584933';
function fixture(t, { source = 'api', captureSeconds = 3, persistenceSeconds = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'core-behavior-')); let now = Date.parse('2026-10-15T04:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const personaMemory = new PersonaMemory({ memoryDir: path.join(root, 'memory'), legacyRoleCardFile: path.join(root, 'no-legacy.md'), clock: () => now }); personaMemory.initialize();
  const initialAt = now;
  let current = { url: `https://www.douyin.com/video/${ID}`, loginRequired: false, verificationRequired: false, privateChatVisible: false, video: { id: ID, url: `https://www.douyin.com/video/${ID}`, title: '合成普通任务作品', author: '合成作者', time: 0, duration: 100, readyState: 4, paused: false, viewport: { x: 1, y: 2, width: 200, height: 300 } } };
  const changeVideo = () => { const id = String(BigInt(current.video.id) + 1n); current = { ...current, url: `https://www.douyin.com/video/${id}`, video: { ...current.video, id, url: `https://www.douyin.com/video/${id}`, time: 0, paused: false } }; };
  const advance = (seconds, { progress = seconds, paused = false, change = false } = {}) => { now += seconds * 1000; current.video.time += progress; current.video.paused = paused; if (change) changeVideo(); };
  if (persistenceSeconds) { const recordObservation = personaMemory.recordObservation.bind(personaMemory); personaMemory.recordObservation = (...args) => { const receipt = recordObservation(...args); advance(persistenceSeconds); return receipt; }; }
  let clicks = 0;
  const arrow = { filter: () => arrow, count: async () => 1, first: () => arrow, click: async () => { clicks++; changeVideo(); } };
  const controller = Object.create(BrowserController.prototype);
  Object.assign(controller, { source, state: async () => structuredClone(current), checkVideoLimits: async () => {}, getPersonaMemory: () => personaMemory, page: { locator: () => arrow, screenshot: async () => { advance(captureSeconds); return Buffer.from([255, 216, 255, 217]); } } });
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, personaMemory, controller, advance, initialAt, clicks: () => clicks, snapshot: () => personaMemory.snapshot(), records: () => JSON.parse(fs.readFileSync(personaMemory.stateFile, 'utf8')) };
}

test('普通任务换片前补记真实短等待，超过三秒观看不能误判为快划不喜欢', async t => {
  const f = fixture(t), observation = await f.controller.capture(0); assert.equal(observation.viewing.watchedSeconds, 3);
  f.advance(2); const switched = await f.controller.switchVideo(1);
  assert.equal(switched.changed, true); assert.equal(f.clicks(), 1);
  const before = f.snapshot().recentObservations.find(row => row.videoId === ID); assert.equal(before.watchedSeconds, 5); assert.equal(before.actions.skip, 1); assert.equal(before.signal, 'neutral');
  const views = f.records().behavior.viewings; assert.equal(views.length, 2); assert.deepEqual([views[1].from.time, views[1].to.time, views[1].wallSeconds], [3, 5, 2]);
});

test('真实快速看过后确认换片，可以形成有证据的负向偏好', async t => {
  const f = fixture(t, { source: 'dsh', captureSeconds: 2 }), observation = await f.controller.capture(0);
  f.advance(0.5); assert.equal((await f.controller.switchVideo(1)).changed, true);
  const video = f.snapshot().recentObservations.find(row => row.videoId === ID); assert.equal(video.watchedSeconds, 2.5); assert.equal(video.actions.skip, 1); assert.equal(video.signal, 'dislike');
  f.personaMemory.updateAgentInterests({ evidenceId: observation.personaEvidenceId, topics: [{ topic: '合成主题', signal: 'like' }], reflection: '模型提议不覆盖实际快划证据。' }, { source: 'dsh' }); assert.equal(f.snapshot().interests[0].signal, 'dislike');
});

for (const [label, seconds, options] of [['31秒未知间隔', 31, {}], ['暂停', 2, { progress: 2, paused: true }], ['播放卡住', 2, { progress: 0 }], ['进度跳跃', 2, { progress: 20 }], ['换了另一作品', 2, { progress: 0, change: true }]]) {
  test(`${label}仍可按用户请求换片，但不写入快划负向偏好`, async t => {
    const f = fixture(t); await f.controller.capture(0); f.advance(seconds, options);
    assert.equal((await f.controller.switchVideo(1)).changed, true); assert.equal(f.clicks(), 1);
    const observed = f.snapshot().recentObservations.find(row => row.videoId === ID); assert.equal(observed.watchedSeconds, 3); assert.equal(observed.actions.skip, 0); assert.equal(observed.signal, 'neutral');
    assert.equal(f.records().behavior.actions.length, 0);
  });
}

test('采样尾缓存独立于返回状态，持久化耗时也不会移动实际采样结束时间', async t => {
  const f = fixture(t, { persistenceSeconds: 5 }), result = await f.controller.capture(0);
  assert.equal(f.controller.lastObservationAt, f.initialAt + 3000); assert.equal(result.viewing.creditedSeconds, 3); assert.equal(result.viewing.videoId, ID);
  const cache = structuredClone(f.controller.lastObservationState), receipt = structuredClone(result.viewing);
  result.state.video.id = '999'; result.state.video.time = 90; result.state.video.viewport.x = 999; result.state.privateChatVisible = true;
  assert.deepEqual(f.controller.lastObservationState, cache); assert.deepEqual(result.viewing, receipt); assert.equal(cache.video.time, 3); assert.equal(cache.video.viewport.x, 1);
  assert.equal((await f.controller.switchVideo(1)).changed, true);
  const observed = f.snapshot().recentObservations.find(row => row.videoId === ID); assert.equal(observed.watchedSeconds, 8); assert.equal(observed.actions.skip, 1); assert.equal(observed.signal, 'neutral');
  const gap = f.records().behavior.viewings[1]; assert.deepEqual([gap.from.time, gap.to.time, gap.wallSeconds], [3, 8, 5]);
});

test('自主入口关闭普通归因时只保留实际采样，不抢记watch的停留或跳过', async t => {
  const f = fixture(t); await f.controller.capture(0, undefined, { recordLearning: false }); await f.controller.capture(0, undefined, { recordLearning: false });
  f.advance(2); assert.equal((await f.controller.switchVideo(1, undefined, { recordLearning: false })).changed, true);
  const records = f.records(); assert.equal(records.behavior.viewings.length, 2); assert.equal(records.behavior.actions.length, 0); assert.equal(f.snapshot().recentObservations[0].actions.stay, 0); assert.equal(f.snapshot().recentObservations[0].actions.skip, 0);
});
