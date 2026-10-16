import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSparkGreeting } from '../native-spark-greeting.mjs';

test('原生问候使用指定DSH模型和有限文本，不继承会话历史或工具', async () => {
  let request;
  const llm = { async *stream(value) { request = value; yield { type: 'text-delta', index: 0, text: '今天过得怎么样？' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: '今天过得怎么样？' } }; yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }; yield { type: 'finish', reason: { kind: 'stop' } }; } };
  const agent = { options: { provider: '已有提供商', model: '已有模型' }, session: { id: '插件设置专用调用', messages: ['其他私聊不可读取'] } };
  const result = await createNativeSparkGreeting({ llm, agent })({ system: '生成一句短问候。', messages: [{ role: 'user', content: '今天问好。' }], signal: new AbortController().signal });
  assert.equal(result.text, '今天过得怎么样？'); assert.equal(result.usage.totalTokens, 20);
  assert.equal(request.provider, '已有提供商'); assert.equal(request.model, '已有模型'); assert.equal(request.maxTokens, 160);
  assert.deepEqual(request.messages.map(item => ({ role: item.role, content: item.content })), [{ role: 'user', content: [{ type: 'text', text: '今天问好。' }] }]);
  assert.equal(request.tools, undefined); assert.equal(JSON.stringify(request).includes('其他私聊'), false);
});

test('原生问候不接受模型未完整完成、非文本历史或缺失路由', async () => {
  const agent = { options: { provider: '提供商', model: '模型' }, session: { id: '设置调用' } };
  const generate = createNativeSparkGreeting({ agent, llm: { async *stream() { yield { type: 'text-delta', index: 0, text: '尚未完整' }; yield { type: 'finish', reason: { kind: 'length' } }; } } });
  await assert.rejects(generate({ system: '问候', messages: [{ role: 'user', content: '请问候。' }] }), /未完整返回/);
  await assert.rejects(generate({ system: '问候', messages: [{ role: 'assistant', content: '旧聊天。' }] }), /不接收/);
  assert.throws(() => createNativeSparkGreeting({ agent: { options: {}, session: { id: '无路由' } }, llm: {} }), /模型路由/);
});

test('原生问候的预取消不发起模型请求', async () => {
  let calls = 0; const abort = new AbortController(); abort.abort(new Error('用户停止。'));
  const generate = createNativeSparkGreeting({ agent: { options: { provider: '提供商', model: '模型' }, session: { id: '设置调用' } }, llm: { async *stream() { calls++; } } });
  await assert.rejects(generate({ system: '问候', messages: [{ role: 'user', content: '请问候。' }], signal: abort.signal }), /用户停止/);
  assert.equal(calls, 0);
});
