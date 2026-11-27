import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VideoReactions } from '../video-reactions.mjs';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';

function fixture(t, react) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-reactions-')), stateDir = path.join(root, 'state');
  const now = () => Date.parse('2026-11-14T04:00:00Z');
  const personaMemory = new PersonaMemory({ memoryDir: path.join(root, 'memory'), legacyRoleCardFile: path.join(root, 'none'), clock: now }); personaMemory.initialize();
  const videoLimits = new VideoLimits({ stateDir, now });
  videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 60 }, { explicit: true }); videoLimits.markSession('api', { explicit: true });
  const watchRunId = 'synthetic-watch', lockFile = path.join(stateDir, 'watch-loop.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, source: 'api', runId: watchRunId, sessionId: videoLimits.state().session.id, status: 'running' }));
  const calls = [], options = { personaMemory, videoLimits, stateDir, now, react: react || (async (input, controls) => { calls.push(input); controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId, action: input.action }); controls.authorize.beginDispatch()(); return { action: input.action, videoId: input.expectedVideoId, verified: true, active: true }; }) };
  const service = new VideoReactions(options);
  const input = (action = 'like', videoId = '12345') => ({ action, videoId, evidenceId: personaMemory.recordObservation({ url: `https://www.douyin.com/video/${videoId}`, loginRequired: false, verificationRequired: false, privateChatVisible: false, video: { id: videoId, url: `https://www.douyin.com/video/${videoId}`, title: '合成作品', author: '合成作者', time: 3, duration: 60, readyState: 4, paused: false } }, { source: 'api' }).evidenceId });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, options, input, controls: { watchRunId }, calls, stateDir, lockFile, videoLimits };
}

test('新互动默认关闭，只有用户可更改两个独立开关', async t => {
  const f = fixture(t);
  assert.deepEqual(f.service.context('12345'), { like: false, favorite: false });
  assert.throws(() => f.service.configure({ like: true, favorite: true }), /用户/);
  for (const body of [{ like: true }, { like: 1, favorite: true }, { like: true, favorite: false, enabled: true }, []]) assert.throws(() => f.service.configure(body, { explicit: true }));
  await assert.rejects(f.service.react(f.input(), f.controls), /未启用/);
  f.service.configure({ like: true, favorite: false }, { explicit: true });
  assert.deepEqual(f.service.context('12345'), { like: true, favorite: false });
  await assert.rejects(f.service.react(f.input('favorite'), f.controls), /未启用/);
});

test('同一作品点赞收藏分别执行一次，重启不取消也不重复点击', async t => {
  const f = fixture(t); f.service.configure({ like: true, favorite: true }, { explicit: true });
  for (const action of ['like', 'favorite']) assert.equal((await f.service.react(f.input(action), f.controls)).confirmed, true);
  assert.equal(f.calls.length, 2);
  const other = new VideoReactions(f.options);
  assert.deepEqual(other.context('12345'), { like: false, favorite: false });
  assert.equal((await other.react(f.input(), f.controls)).skipped, true);
  assert.equal(f.calls.length, 2); await other.close();
});

test('已点赞只回读，不制造一次新的确认点击', async t => {
  const f = fixture(t, async input => ({ action: input.action, videoId: input.expectedVideoId, verified: true, active: true, alreadyActive: true }));
  f.service.configure({ like: true, favorite: true }, { explicit: true });
  const result = await f.service.react(f.input(), f.controls);
  assert.equal(result.confirmed, false); assert.equal(result.alreadyActive, true); assert.equal(f.service.ledger().operations[0].status, 'already-active');
});

test('未点击便返回成功不能伪造平台确认', async t => {
  const f = fixture(t, async input => ({ action: input.action, videoId: input.expectedVideoId, verified: true, active: true }));
  f.service.configure({ like: true, favorite: true }, { explicit: true });
  assert.equal((await f.service.react(f.input(), f.controls)).confirmed, false);
});

test('点击后回读失败保留不明收据，另一入口与重开开关都不会再点', async t => {
  const f = fixture(t, async (input, controls) => { controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId, action: input.action }); throw Error('合成回读中断'); });
  f.service.configure({ like: true, favorite: true }, { explicit: true });
  assert.equal((await f.service.react(f.input(), f.controls)).deliveryUncertain, true);
  const other = new VideoReactions(f.options);
  other.configure({ like: false, favorite: false }, { explicit: true }); other.configure({ like: true, favorite: true }, { explicit: true });
  assert.equal(other.state().paused, true); assert.deepEqual(other.context('67890'), { like: false, favorite: false });
  await assert.rejects(other.react(f.input('favorite'), f.controls), /尚未确认/); await other.close();
});

test('停止、换轮次、错误来源或观察被替换时撤销点击', async t => {
  for (const mutation of ['stop', 'session', 'source', 'evidence', 'disabled']) {
    let f;
    f = fixture(t, async (input, controls) => {
      if (mutation === 'stop') fs.writeFileSync(path.join(f.stateDir, 'watch-stop.request.json'), JSON.stringify({ runId: f.controls.watchRunId }));
      if (mutation === 'session') f.videoLimits.endSession({ explicit: true });
      if (mutation === 'source') { const value = JSON.parse(fs.readFileSync(f.lockFile)); value.source = 'dsh'; fs.writeFileSync(f.lockFile, JSON.stringify(value)); }
      if (mutation === 'evidence') f.options.personaMemory.snapshot = () => ({ recentObservations: [] });
      if (mutation === 'disabled') f.service.configure({ like: false, favorite: true }, { explicit: true });
      controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId, action: input.action });
      throw Error('不应执行到这里');
    });
    f.service.configure({ like: true, favorite: true }, { explicit: true });
    await assert.rejects(f.service.react(f.input(), f.controls));
    assert.equal(f.service.ledger().operations[0].status, 'not-sent');
  }
});

test('最终点击持有设置锁，禁止并发改变许可；释放后可正常关闭', async t => {
  let f;
  f = fixture(t, async (input, controls) => {
    controls.authorize({ phase: 'before-click', videoId: input.expectedVideoId, action: input.action });
    const release = controls.authorize.beginDispatch();
    assert.throws(() => f.service.configure({ like: false, favorite: false }, { explicit: true }), /正在处理/);
    release();
    return { action: input.action, videoId: input.expectedVideoId, verified: true, active: true };
  });
  f.service.configure({ like: true, favorite: false }, { explicit: true });
  assert.equal((await f.service.react(f.input(), f.controls)).confirmed, true);
  f.service.configure({ like: false, favorite: false }, { explicit: true });
});

test('未知字段、手写地址和取消动作不进入浏览器；坏历史不会自动清空', async t => {
  const f = fixture(t); f.service.configure({ like: true, favorite: true }, { explicit: true });
  for (const value of [{ ...f.input(), action: 'unlike' }, { ...f.input(), url: 'https://www.douyin.com/video/12345' }, { ...f.input(), evidenceId: 'invented' }]) await assert.rejects(f.service.react(value, f.controls));
  assert.equal(f.calls.length, 0);
  fs.writeFileSync(f.service.files.ledger, 'broken'); assert.throws(() => f.service.context('12345'), /核对/);
});
