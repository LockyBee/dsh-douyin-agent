import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VideoLimits, validateVideoPolicy, allowedWindow } from '../video-limits.mjs';
import { UsageLedger, normalizeUsage } from '../usage-ledger.mjs';
import { WatchOptions } from '../watch-options.mjs';
import { AutonomousWatch } from '../autonomous-watch.mjs';
import { runDiagnostics } from '../diagnostics.mjs';
import { ApiAgent } from '../api-agent.mjs';
import { createApiServer } from '../app.mjs';
function fixture(t, time = '2026-10-23T12:00:00Z') {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-experience-')); let clock = Date.parse(time);
  t.after(() => { assert.ok(path.resolve(stateDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const options = { stateDir, now: () => clock };
  return { ...options, video: new VideoLimits(options), ledger: new UsageLedger(options), topics: new WatchOptions(options), advance: ms => { clock += ms; } };
}
test('不限单轮时长可跨月读取和手动停止；保存不限时长不会延长旧轮次', t => {
  const f = fixture(t); f.video.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: null }, { explicit: true });
  const state = f.video.markSession('dsh', { explicit: true }); assert.equal(state.session.expiresAt, null); assert.equal(state.remainingSeconds, null);
  assert.equal(JSON.parse(JSON.stringify(state)).session.expiresAt, null);
  f.advance(40 * 86400000); assert.equal(new VideoLimits(f).state().allowed, true); f.video.endSession({ explicit: true }); assert.equal(f.video.state().allowed, false);
  f.video.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 10 }, { explicit: true }); const old = f.video.markSession('api', { explicit: true });
  f.video.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: null }, { explicit: true }); assert.equal(f.video.state().session.expiresAt, old.session.expiresAt);
});
test('不限单轮时长仍按跨夜时段截止；长轮次不被三日窗口或32位定时器截断', t => {
  const f = fixture(t, '2026-10-23T15:30:00Z');
  f.video.savePolicy({ windows: ['23:00-01:00'], sessionMinutes: null }, { explicit: true }); const state = f.video.markSession('api', { explicit: true });
  assert.equal(state.session.expiresAt, Date.parse('2026-10-23T17:00:00Z')); f.advance(90 * 60000); assert.equal(f.video.state().allowed, false);
  f.video.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 1000000 }, { explicit: true }); const long = f.video.markSession('api', { explicit: true });
  f.advance(31 * 86400000); assert.equal(f.video.state().allowed, true); assert.equal(f.video.state().session.expiresAt, long.session.expiresAt);
  assert.throws(() => validateVideoPolicy({ windows: ['00:00-24:00'], sessionMinutes: 1000001 }));
});
test('谷时段工作日避开高峰、周末全天，星期五晚可跨周末连续到周一上午', () => {
  const policy = validateVideoPolicy({ windows: ['00:00-09:00','12:00-14:00','18:00-24:00'], weekendWindows: ['00:00-24:00'], sessionMinutes: null });
  assert.equal(allowedWindow(policy, Date.parse('2026-10-23T02:00:00Z')), null);
  assert.ok(allowedWindow(policy, Date.parse('2026-10-24T02:00:00Z')));
  assert.equal(allowedWindow(policy, Date.parse('2026-10-23T12:00:00Z')).expiresAt, Date.parse('2026-10-26T01:00:00Z'));
});
test('用量两入口共用、按日模型汇总、缓存不重复计入、缺失保持未知、重复回执去重', t => {
  const f = fixture(t); f.ledger.record({ id: 'one', source: 'dsh', model: 'test', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 } });
  new UsageLedger(f).record({ id: 'one', source: 'dsh', model: 'test', usage: { inputTokens: 100, outputTokens: 20 } });
  f.ledger.record({ id: 'two', source: 'api', kind: 'task', model: 'test', usage: {} });
  const result = f.ledger.state(); assert.equal(result.today.requests, 2); assert.equal(result.today.totalTokens, 120); assert.equal(result.today.cachedTokens, 80); assert.equal(result.today.unknownRequests, 1); assert.equal(result.groups.length, 2);
  f.advance(86400000); assert.equal(f.ledger.state().today.requests, 0); assert.equal(f.ledger.state().total.requests, 2);
  assert.equal(normalizeUsage({}).totalTokens, null); assert.equal(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }).totalTokens, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(f.ledger.directory, '2026-10-23.jsonl'),'utf8'), /apiKey|prompt"|content"/);
});
test('模型返回内容无效仍计入已报告用量，缺失用量不伪造零 Token', async t => {
  const f = fixture(t), id = '1234567890123', observation = { state: { video: { id } }, frames: [{ videoId: id, mimeType: 'image/jpeg', data: 'eA==' }] };
  const agent = new ApiAgent({ controller: { execute() {} }, config: { apiKey: 'synthetic-only', model: 'synthetic-model', baseUrl: 'https://example.invalid' }, usageLedger: f.ledger, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason:'stop', message:{content:'不是有效JSON'} }], usage:{prompt_tokens:40,completion_tokens:3,total_tokens:43,prompt_cache_hit_tokens:30} })) });
  await assert.rejects(agent.decideWatch({ observation }), /有效 JSON/); const usage = f.ledger.state().today; assert.equal(usage.requests,1); assert.equal(usage.totalTokens,43); assert.equal(usage.cachedTokens,30);
  const nativeError = Object.assign(new Error('合成响应被截断'),{usage:{inputTokens:10,outputTokens:5,cacheReadTokens:8}});
  await assert.rejects(agent.decideWatch({ observation, decisionProvider: async () => { throw nativeError; } }), /被截断/);
  assert.equal(f.ledger.state().today.requests,2); assert.equal(f.ledger.state().today.totalTokens,58); assert.equal(normalizeUsage(null).totalTokens,null);
});
test('主题设置显式保存、跨入口读取，损坏不覆盖；首条主题搜索复用真实结果打开', async t => {
  const f = fixture(t); assert.throws(() => f.topics.configure({ mode: 'topic', topics: ['猫咪'], exclude: [] }));
  f.topics.configure({ mode: 'topic', topics: ['猫咪'], exclude: ['广告'] }, { explicit: true }); assert.deepEqual(new WatchOptions(f).state().policy.topics, ['猫咪']);
  f.video.markSession('api', { explicit: true }); const calls = [], id = '1234567890123';
  const controller = { async execute(name,args) { calls.push({name,args}); if (name === 'douyin_search') return { searchResults: [{ index: 2, id }] }; if (name === 'douyin_observe') throw new Error('合成采样终止'); return { video: { id, paused: false } }; }, async pauseForLimits() {} };
  const watch = new AutonomousWatch({ controller, videoLimits: f.video, personaMemory: { context: () => '' }, stateDir: f.stateDir, config: { apiKey: 'synthetic-key' }, now: f.now });
  watch.start({}, { explicit: true }); await watch.completion;
  assert.deepEqual(calls.find(item => item.name === 'douyin_search').args, { query: '猫咪' }); assert.deepEqual(calls.find(item => item.name === 'douyin_open_video').args, { index: 2 }); assert.equal(watch.state().running, false);
  fs.writeFileSync(f.topics.file, '{'); assert.throws(() => f.topics.configure({ mode: 'recommend', topics: [], exclude: [] }, { explicit: true })); assert.equal(fs.readFileSync(f.topics.file,'utf8'), '{');
});
test('自检可报告缺少 Node，错误不回显凭据路径，不修改已有设置也不启动模型或浏览器', async t => {
  const f = fixture(t), before = fs.readFileSync(f.video.policyFile);
  const result = await runDiagnostics({ videoLimits: f.video, watchService: { state: () => ({ running: false }) }, optionsService: f.topics, usageLedger: f.ledger, paths: { stateDir: f.stateDir, memoryDir: path.join(f.stateDir,'memory') }, nodeResolver: () => { throw new Error('secret-key-private-path'); } });
  assert.equal(result.ok, false); assert.equal(result.checks.find(item => item.id === 'node').status, 'fail'); assert.doesNotMatch(JSON.stringify(result), /secret-key-private-path/); assert.deepEqual(fs.readFileSync(f.video.policyFile), before);
  assert.ok(!fs.readdirSync(f.stateDir).some(file => file.startsWith('.selfcheck')));
});
test('独立软件真实HTTP接口可读用量、保存主题；未认证写操作拒绝', async t => {
  const f = fixture(t), config = { apiKey: '', model: 'test' }, controller = { execute() {}, async pauseForLimits() {} };
  const server = createApiServer({ controller, config, videoLimits: f.video, agent: new ApiAgent({ controller, config }) });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.address().port}`, boot = await (await fetch(base+'/api/bootstrap')).json(), headers = { 'x-session-token': boot.token, 'content-type':'application/json' };
  assert.equal((await fetch(base+'/api/watch/options',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
  const saved = await fetch(base+'/api/watch/options',{method:'POST',headers,body:JSON.stringify({mode:'topic',topics:['天文'],exclude:[]})}); assert.equal(saved.status,200);
  assert.equal((await (await fetch(base+'/api/usage',{headers})).json()).protocol,'usage-ledger-v1'); assert.deepEqual(f.topics.state().policy.topics,['天文']);
});
