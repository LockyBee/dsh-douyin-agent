import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startApiServer } from '../app.mjs';
import { TaskLimits } from '../task-limits.mjs';
import { VideoLimits } from '../video-limits.mjs';

const policy = { maxSteps: 80, maxToolCalls: 100, timeoutSeconds: 600 };
const recipientId = `conv:${'a'.repeat(64)}`;
const answer = message => new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
const tool = (index, name = 'douyin_status') => ({ id: `synthetic-task-${index}`, type: 'function', function: { name, arguments: '{}' } });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-limits-http-')), home = path.join(root, 'home'), stateDir = path.join(root, 'state'), memoryDir = path.join(root, 'memory');
  fs.mkdirSync(home); fs.mkdirSync(memoryDir);
  const env = { HOME: home, USERPROFILE: home, DOUYIN_RUNTIME_LOCATION_FILE: path.join(root, 'location.json'), DOUYIN_STATE_DIR: stateDir, DEEPSEEK_SHARED_MEMORY_DB: path.join(memoryDir, 'shared.sqlite'), DOUYIN_MEDIA_ENV_FILE: path.join(root, 'media.env') };
  const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  fs.writeFileSync(env.DOUYIN_RUNTIME_LOCATION_FILE, JSON.stringify({ version: 1, stateDir, memoryDir, memoryDbPath: env.DEEPSEEK_SHARED_MEMORY_DB }));
  const servers = [], realFetch = globalThis.fetch;
  const f = { root, home, stateDir, servers, now: Date.parse('2026-10-15T03:00:00Z'), requests: [], executed: [], pauses: 0, mode: 'answer', watchRunning: false, contactWait: null, contactEntered: null, modelEntered: null };
  t.after(async () => {
    f.contactWait?.resolve(); await Promise.all(servers.map(server => server.stop()));
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(path.resolve(os.homedir()), path.resolve(home));
  const config = { apiKey: 'synthetic-task-http-key', baseUrl: 'https://synthetic-model.invalid', model: 'synthetic-task-model' };
  const videoLimits = new VideoLimits({ stateDir, now: () => f.now });
  videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 10 }, { explicit: true }); videoLimits.markSession('api', { explicit: true }); f.videoLimits = videoLimits;
  const controller = { source: 'api', execute: async (name, _args, { signal } = {}) => {
    signal?.throwIfAborted();
    const permitted = videoLimits.beforeAction('api', name); if (!permitted.allowed) throw new Error(permitted.reason);
    f.executed.push(name);
    if (name === 'douyin_forward_video') return { confirmed: false, deliveryUncertain: false, humanActionRequired: true };
    return { video: { id: '7579432563794584933', title: '合成作品', paused: false } };
  }, pauseForLimits: async () => { f.pauses++; return { paused: 0, existingPage: false }; }, close: async () => {} };
  const contact = { id: recipientId, name: '合成许可好友', followed: true, isGroup: false };
  const chatService = { state: () => ({ policy: { allowlist: [contact] } }), listContacts: async () => { f.contactEntered?.resolve(); await f.contactWait?.promise; return { contacts: [contact] }; }, close: async () => {} };
  const watchService = { state: () => ({ running: f.watchRunning, owned: false, worker: null }), claimManual: () => async () => {}, cancel: () => {}, close: async () => { f.watchRunning = false; } };
  const shareService = { active: null, close: async () => {} };
  const personaMemory = { context: () => '合成人格，不读取私人资料', snapshot: () => ({ recentObservations: [] }) };
  const fakeFetch = async (url, options) => {
    assert.equal(url, 'https://synthetic-model.invalid/chat/completions');
    assert.equal(options.headers.authorization, `Bearer ${config.apiKey}`);
    f.requests.push(JSON.parse(options.body)); const index = f.requests.length;
    if (f.mode === 'hold') { f.modelEntered.resolve(); await new Promise((_, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }); }); }
    if (f.mode === 'many-steps') return answer(index <= 25 ? { tool_calls: [tool(index)] } : { content: '已完成超过默认步数的合成任务。' });
    if (f.mode === 'always-tools') return answer({ tool_calls: [tool(index)] });
    if (f.mode === 'three-tools') return answer({ tool_calls: [tool(1), tool(2), tool(3)] });
    if (f.mode === 'expire-video') {
      if (index === 2) { f.now = videoLimits.state().session.expiresAt + 1; await f.server.enforceVideoLimits(); }
      return answer({ tool_calls: [tool(index, 'douyin_next')] });
    }
    return answer({ content: '合成任务完成。' });
  };
  f.rebuild = async () => {
    if (f.server) await f.server.stop();
    f.taskLimits = new TaskLimits({ stateDir });
    // 生产构造器捕获合成 fetch；本地 HTTP 始终使用保存的真实 fetch。
    globalThis.fetch = fakeFetch;
    try { f.server = await startApiServer({ controller, config: { ...config }, chatService, videoLimits, mediaAdapter: {}, personaMemory, watchService, shareService, taskLimits: f.taskLimits, port: 0 }); }
    finally { globalThis.fetch = realFetch; }
    servers.push(f.server); f.origin = `http://127.0.0.1:${f.server.address().port}`;
    f.bootstrap = await (await realFetch(f.origin + '/api/bootstrap')).json();
  };
  f.request = async (route, body, extra = {}) => {
    const response = await realFetch(f.origin + route, { headers: { 'x-session-token': f.bootstrap.token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(extra.headers || {}) }, ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {}), ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'headers')) });
    return { status: response.status, body: await response.json() };
  };
  f.readBootstrap = async () => await (await realFetch(f.origin + '/api/bootstrap')).json();
  f.waitIdle = async () => { for (let attempt = 0; attempt < 100; attempt++) { const value = (await f.request('/api/state')).body; if (!value.running) return value; await delay(5); } assert.fail('合成任务未在测试期限内结束'); };
  f.runTask = async mode => { f.mode = mode; f.requests.length = 0; f.executed.length = 0; const response = await f.request('/api/task', { instruction: '使用合成模型验证用户选定预算，不访问真人页面。' }); assert.equal(response.status, 202); return (await f.waitIdle()).task; };
  f.videoBytes = () => [videoLimits.policyFile, videoLimits.sessionsFile].map(file => fs.readFileSync(file, 'utf8'));
  f.shareService = shareService;
  await f.rebuild();
  return f;
}

test('预算HTTP校验token、同源、完整整数参数与硬界，保存不会改变视频轮次', async t => {
  const f = await fixture(t), originalVideo = f.videoBytes();
  const missing = await fetch(f.origin + '/api/task/limits'); assert.equal(missing.status, 403);
  assert.equal((await f.request('/api/task/limits', policy, { headers: { 'x-session-token': 'synthetic-invalid-token' } })).status, 403);
  assert.equal((await f.request('/api/task/limits', policy, { headers: { origin: 'https://synthetic-untrusted.invalid' } })).status, 403);
  assert.equal((await f.request('/api/task/limits', undefined, { method: 'DELETE' })).status, 405);
  const initial = await f.request('/api/task/limits'); assert.equal(initial.status, 200); assert.equal(initial.body.configured, false); assert.deepEqual(initial.body.policy, { maxSteps: 20, maxToolCalls: 20, timeoutSeconds: 180 });
  assert.equal((await f.request('/api/task/limits', policy)).status, 200); const saved = fs.readFileSync(f.taskLimits.policyFile);
  for (const body of [null, [], {}, { maxSteps: 80 }, { ...policy, maxSteps: 0 }, { ...policy, maxSteps: 10001 }, { ...policy, maxToolCalls: 10001 }, { ...policy, timeoutSeconds: 9 }, { ...policy, timeoutSeconds: 604801 }, { ...policy, maxSteps: 1.5 }, { ...policy, maxSteps: '80' }, { ...policy, enabled: false }, { ...policy, sessionMinutes: 100 }]) { assert.equal((await f.request('/api/task/limits', body)).status, 400); assert.deepEqual(fs.readFileSync(f.taskLimits.policyFile), saved); }
  assert.equal((await f.request('/api/task/limits', policy, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('/api/task/limits', undefined, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"maxSteps":' })).status, 400);
  assert.deepEqual(f.videoBytes(), originalVideo); assert.equal(f.requests.length, 0); assert.equal(f.executed.length, 0);
  assert.equal(fs.existsSync(f.taskLimits.guardFile), false);
});

test('100工具80步600秒保存到真实Agent并在生产服务重建后回读，超过默认20步仍能完成', async t => {
  const f = await fixture(t), originalVideo = f.videoBytes();
  const configured = await f.request('/api/task/limits', policy); assert.equal(configured.status, 200); assert.deepEqual(configured.body.policy, policy);
  const bootstrap = await f.readBootstrap(); assert.equal(bootstrap.limits.maxToolCalls, 100); assert.equal(bootstrap.limits.maxSteps, 80); assert.equal(bootstrap.limits.taskTimeoutSeconds, 600); assert.equal(JSON.stringify(bootstrap).includes('synthetic-task-http-key'), false);
  const stored = fs.readFileSync(f.taskLimits.policyFile); await f.rebuild();
  assert.deepEqual((await f.request('/api/task/limits')).body.policy, policy); assert.equal(f.bootstrap.limits.maxToolCalls, 100); assert.equal(f.bootstrap.limits.maxSteps, 80); assert.equal(f.bootstrap.limits.taskTimeoutSeconds, 600);
  assert.deepEqual(fs.readFileSync(f.taskLimits.policyFile), stored); assert.deepEqual(f.videoBytes(), originalVideo);
  const completed = await f.runTask('many-steps'); assert.equal(completed.status, 'completed'); assert.equal(completed.steps, 26); assert.equal(completed.toolsUsed, 25); assert.equal(f.requests.length, 26); assert.equal(f.executed.length, 25);
  assert.equal((await f.request('/api/task/limits', { maxSteps: 2, maxToolCalls: 100, timeoutSeconds: 600 })).status, 200);
  const steps = await f.runTask('always-tools'); assert.equal(steps.status, 'limited'); assert.equal(steps.steps, 2); assert.equal(f.requests.length, 2);
  assert.equal((await f.request('/api/task/limits', { maxSteps: 80, maxToolCalls: 2, timeoutSeconds: 600 })).status, 200);
  const tools = await f.runTask('three-tools'); assert.equal(tools.status, 'limited'); assert.equal(tools.toolsUsed, 2); assert.equal(f.executed.length, 2); assert.equal(f.requests.length, 1);
});

test('活动任务、自主观看、转发与分享忙碌时预算不可改，结束后才保存', async t => {
  const f = await fixture(t); await f.request('/api/task/limits', policy); const saved = fs.readFileSync(f.taskLimits.policyFile), next = { maxSteps: 50, maxToolCalls: 60, timeoutSeconds: 200 };
  f.mode = 'hold'; f.modelEntered = Promise.withResolvers(); assert.equal((await f.request('/api/task', { instruction: '合成挂起任务，只等待取消信号。' })).status, 202); await f.modelEntered.promise;
  assert.equal((await f.request('/api/task/limits', next)).status, 409); assert.deepEqual(fs.readFileSync(f.taskLimits.policyFile), saved);
  assert.equal((await f.request('/api/stop', {})).status, 200); await f.waitIdle();
  f.watchRunning = true; assert.equal((await f.request('/api/task/limits', next)).status, 409); f.watchRunning = false;
  f.shareService.active = {}; assert.equal((await f.request('/api/task/limits', next)).status, 409); f.shareService.active = null;
  f.contactEntered = Promise.withResolvers(); f.contactWait = Promise.withResolvers();
  const forward = f.request('/api/forward', { recipientId }); await f.contactEntered.promise;
  try { assert.equal((await f.request('/api/task/limits', next)).status, 409); assert.deepEqual(fs.readFileSync(f.taskLimits.policyFile), saved); }
  finally { f.contactWait.resolve(); }
  assert.equal((await forward).status, 200); assert.equal((await f.request('/api/task/limits', next)).status, 200); assert.deepEqual((await f.request('/api/task/limits')).body.policy, next);
});

test('预算文件损坏时HTTP拒绝读写，重建也保留原字节与视频文件', async t => {
  const f = await fixture(t); await f.request('/api/task/limits', policy); const originalVideo = f.videoBytes(), broken = Buffer.from('{"version":1,"policy":损坏的合成设置');
  fs.writeFileSync(f.taskLimits.policyFile, broken);
  assert.equal((await f.request('/api/task/limits')).status, 400); assert.equal((await f.request('/api/task/limits', { maxSteps: 20, maxToolCalls: 20, timeoutSeconds: 180 })).status, 400);
  assert.deepEqual(fs.readFileSync(f.taskLimits.policyFile), broken); assert.equal((await f.readBootstrap()).limits.maxToolCalls, 100);
  await assert.rejects(f.rebuild(), /损坏|格式无效/); assert.deepEqual(fs.readFileSync(f.taskLimits.policyFile), broken); assert.deepEqual(f.videoBytes(), originalVideo);
  assert.equal(fs.existsSync(f.taskLimits.guardFile), false); assert.equal(fs.readdirSync(f.stateDir).some(name => name.endsWith('.tmp')), false);
});

test('提高任务预算不能越过视频截止，运行中到点取消且不自动开启新轮', async t => {
  const f = await fixture(t); await f.request('/api/task/limits', policy); const session = f.videoLimits.state().session;
  const stopped = await f.runTask('expire-video'); assert.equal(stopped.status, 'stopped'); assert.equal(f.requests.length, 2); assert.equal(f.executed.filter(name => name === 'douyin_next').length, 1);
  const after = f.videoLimits.state(); assert.equal(after.allowed, false); assert.equal(after.session.id, session.id); assert.equal(after.session.expiresAt, session.expiresAt);
  const count = f.requests.length; assert.equal((await f.request('/api/task', { instruction: '过时段不得重开任务。' })).status, 409); assert.equal(f.requests.length, count);
  assert.deepEqual((await f.request('/api/task/limits')).body.policy, policy); assert.equal((await f.readBootstrap()).limits.taskTimeoutSeconds, 600);
});
