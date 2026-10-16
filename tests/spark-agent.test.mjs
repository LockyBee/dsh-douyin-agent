import test from 'node:test';
import assert from 'node:assert/strict';
import { SparkAgent } from '../spark-agent.mjs';

const config = { apiKey: 'synthetic-spark-secret', baseUrl: 'https://fixture.invalid', model: 'fixture' };
const date = '2026-10-16';

test('人格问候只读取手编正文和本机日期，原生模型没有工具、收件人或历史', async () => {
  const requests = [];
  const agent = new SparkAgent({ config: { apiKey: '' }, personaMemory: { snapshot() { return { manualText: '大肥鱼说话活泼简短。', generatedText: '不得送出的视频兴趣', observations: ['不得送出的观看历史'] }; }, context() { assert.fail('问候不能读取兴趣上下文'); } }, greetingProvider: async request => { requests.push(request); return { text: '早呀，今天也记得喝水～', usage: { promptTokens: 12, extra: '不得返回的字段' } }; } });
  const result = await agent.greet({ date });
  assert.equal(result.text, '[自动问候] 早呀，今天也记得喝水～');
  assert.deepEqual(result.usage, { promptTokens: 12 });
  assert.equal(requests[0].maxTokens, 160);
  assert.deepEqual(requests[0].messages.map(item => item.role), ['user']);
  assert.match(requests[0].system, /大肥鱼说话活泼简短/);
  assert.match(requests[0].messages[0].content, /2026-10-16/);
  assert.equal(JSON.stringify(requests).includes('不得送出'), false);
  assert.equal('tools' in requests[0], false);
  assert.equal('recipientId' in requests[0], false);
});

test('API问候沿用配置且不提供工具，必须完整普通文本响应', async () => {
  let request;
  const agent = new SparkAgent({ config, fetchImpl: async (url, options) => { request = { url, options, body: JSON.parse(options.body) }; return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '[自动问候] 今天过得怎么样呀？' } }], usage: { completion_tokens: 10 } })); } });
  const result = await agent.greet({ date });
  assert.equal(result.text, '[自动问候] 今天过得怎么样呀？');
  assert.equal(request.url, 'https://fixture.invalid/chat/completions');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.body.max_tokens, 160);
  assert.equal(request.body.messages[0].role, 'system');
  assert.equal(request.body.tools, undefined);
  assert.equal(request.body.messages.some(item => item.role === 'assistant'), false);
});

test('问候拒绝空文、超长、链接、凭据、身份冒充、现实承诺及假火花结果', async () => {
  for (const text of ['', '鱼'.repeat(201), '看看 https://example.com', '密码是12345', config.apiKey, '我是用户本人', '我不是AI', '我马上给你转账', '已经续好火花了', '{"enabled":true}', '联系我13812345678']) {
    const agent = new SparkAgent({ config, greetingProvider: async () => ({ text }) });
    await assert.rejects(agent.greet({ date }));
  }
  for (const value of [{ finish_reason: 'length', message: { content: '你好' } }, { finish_reason: 'stop', message: { content: '你好', tool_calls: [{}] } }]) {
    const agent = new SparkAgent({ config, fetchImpl: async () => new Response(JSON.stringify({ choices: [value] })) });
    await assert.rejects(agent.greet({ date }), /未完整结束/);
  }
});

test('外部停止和模型超时会结束问候等待，没有固定句兜底', async () => {
  const agent = new SparkAgent({ config, greetingProvider: () => new Promise(() => {}), timeoutMs: 15 });
  await assert.rejects(agent.greet({ date }), /超时/);
  const stop = new AbortController();
  const pending = new SparkAgent({ config, greetingProvider: () => new Promise(() => {}) }).greet({ date, signal: stop.signal });
  stop.abort(new Error('合成用户停止'));
  await assert.rejects(pending, /合成用户停止/);
  const cancelled = new AbortController(); cancelled.abort(new Error('预先停止'));
  let called = false;
  await assert.rejects(new SparkAgent({ config, greetingProvider: async () => { called = true; return { text: '你好' }; } }).greet({ date, signal: cancelled.signal }), /预先停止/);
  assert.equal(called, false);
});

test('缺少模型、错误日期和超时设置均不发起请求', async () => {
  await assert.rejects(new SparkAgent({ config: { apiKey: '' } }).greet({ date }), /未配置/);
  await assert.rejects(new SparkAgent({ config }).greet({ date: '明天' }), /日期/);
  await assert.rejects(new SparkAgent({ config }).greet({ date: '2026-02-30' }), /日期/);
  assert.throws(() => new SparkAgent({ config, timeoutMs: 45_001 }), /超时/);
});
