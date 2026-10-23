import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, createForwardGate, mergeEvents, publicSettings, saveNativeSettings, saveNativeMediaKey, watchIsActive, watchStartInput } from '../src/api.mjs';

test('会话凭证只进入本机请求头，bootstrap返回状态不暴露token', async () => {
  const calls = [];
  const client = createApiClient(async (route, options) => { calls.push({ route, options }); return { ok: true, json: async () => route === '/api/bootstrap' ? { service: 'douyin-api-local', token: 'synthetic-session', config: { configured: true } } : { stopped: true } }; });
  await assert.rejects(client.request('/api/stop', {}), /会话校验/);
  assert.equal('token' in await client.bootstrap(), false);
  await client.request('/api/stop', {});
  assert.equal(calls[1].options.headers['x-session-token'], 'synthetic-session'); assert.equal(calls[1].route, '/api/stop');
  assert.equal(calls[1].options.body, '{}');
  await assert.rejects(client.request('https://example.invalid/api/stop', {}), /本机/);
});

test('API Key仅交给窄native方法，返回值只保留公开字段', async () => {
  const calls = [];
  const input = { apiKey: 'synthetic-secret', baseUrl: 'https://api.example.invalid', model: '合成模型', remember: false, unexpected: '不传入IPC' };
  const value = await saveNativeSettings({ saveSettings: async payload => { calls.push(payload); return { ...payload, configured: true, memoryFolder: '/synthetic-memory', token: '不回显' }; } }, input);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['apiKey', 'baseUrl', 'model', 'remember']);
  assert.equal(calls[0].apiKey, input.apiKey); assert.equal(value.configured, true);
  assert.doesNotMatch(JSON.stringify(value), /synthetic-secret|不回显/);
  assert.deepEqual(Object.keys(publicSettings({ apiKey: '不暴露' })).sort(), ['baseUrl', 'configured', 'memoryFolder', 'model', 'remember']);
  await assert.rejects(saveNativeSettings(undefined, input), /桌面软件/);
});

test('转发只接受真实用户事件，同一选择不重试，人工核对后才能重新选择', () => {
  const gate = createForwardGate();
  assert.throws(() => gate.take({ isTrusted: false }), /亲自/); assert.equal(gate.locked, false);
  gate.take({ isTrusted: true }); assert.equal(gate.locked, true);
  assert.throws(() => gate.take({ isTrusted: true }), /已提交/);
  assert.throws(() => gate.reset({ isTrusted: false }), /亲自/); assert.equal(gate.locked, true);
  gate.reset({ isTrusted: true }); assert.equal(gate.locked, false);
});

test('音频 Key 仅交给窄桌面 IPC，收据不回显任何凭据', async () => {
  let called;
  const receipt = await saveNativeMediaKey({ saveMediaKey: async value => { called = value; return { ...value, configured: true, unexpected: '不回显' }; } }, { backend: 'mimo', apiKey: ' synthetic-mimo-key ', enabled: true });
  assert.deepEqual(called, { backend: 'mimo', apiKey: 'synthetic-mimo-key' });
  assert.deepEqual(receipt, { backend: 'mimo', configured: true, storage: 'shared-env' });
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic|不回显/);
  await assert.rejects(saveNativeMediaKey(undefined, { backend: 'mimo', apiKey: 'synthetic' }), /新版/);
});

test('轮询按revision去重并限制保留数量，工具结果仍归属原任务', () => {
  const previous = [{ revision: 1, taskId: 'old', type: 'tool.result' }];
  const one = mergeEvents(previous, [{ revision: 2, type: 'tool.start' }], 'new');
  assert.equal(one[0].taskId, 'old'); assert.equal(one[1].taskId, 'new');
  const values = mergeEvents(one, Array.from({ length: 220 }, (_, i) => ({ revision: i + 3 })), 'new');
  assert.equal(values.length, 200); assert.equal(values.at(-1).revision, 222);
  assert.equal(mergeEvents(previous, [{ revision: 1, type: 'tool.result' }], 'new')[0].taskId, 'old');
});

test('本机服务重建会话后给UI重置事件水位提示，不回传新旧凭证', async () => {
  let sequence = 0;
  const client = createApiClient(async () => ({ ok: true, json: async () => ({ service: 'douyin-api-local', token: `synthetic-${++sequence}` }) }));
  const first = await client.bootstrap(), second = await client.bootstrap();
  assert.equal(first.sessionChanged, false); assert.equal(second.sessionChanged, true);
  assert.doesNotMatch(JSON.stringify({ first, second }), /synthetic-/);
});

test('自主观看预算只接受有限整数，界面启动不隐式创建新轮', () => {
  assert.deepEqual(watchStartInput('30'), { startSession: false, maxRequests: 30 });
  for (const value of [0, 10001, 2.5, '', '无上限', Infinity]) assert.throws(() => watchStartInput(value), /1 至 100/);
  assert.deepEqual(watchStartInput(1), { startSession: false, maxRequests: 1 });
  assert.deepEqual(watchStartInput(100), { startSession: false, maxRequests: 100 });
  assert.equal(watchIsActive({ running: false, owned: false, worker: { alive: true, source: 'dsh' } }), true);
  assert.equal(watchIsActive({ status: 'stopping' }), true);
  assert.equal(watchIsActive({ status: 'limited', running: false, worker: null }), false);
});

test('人格保存的版本冲突保留HTTP状态供界面处理，不隐式重试', async () => {
  const calls = [];
  const client = createApiClient(async (route, options) => {
    calls.push({ route, options });
    return route === '/api/bootstrap' ? { ok: true, json: async () => ({ service: 'douyin-api-local', token: 'synthetic-persona' }) } : { ok: false, status: 409, json: async () => ({ error: '人格版本已更新' }) };
  });
  await client.bootstrap();
  await assert.rejects(client.request('/api/persona/card', { text: '手编人格', expectedRevision: '旧版本' }), error => error.status === 409 && /版本/.test(error.message));
  assert.equal(calls.filter(call => call.route === '/api/persona/card').length, 1);
});
