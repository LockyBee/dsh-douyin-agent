import { randomUUID } from 'node:crypto';

// 问候只沿用当前 DSH 的文本模型路由，不提供工具或其他会话内容。
export function createNativeSparkGreeting({ llm, agent } = {}) {
  const route = agent?.session?.requestHeader?.()?.config;
  const provider = route?.provider ?? agent?.options?.provider;
  const model = route?.model ?? agent?.options?.model;
  if (!provider || !model || typeof llm?.stream !== 'function' || !agent?.session?.id) throw new Error('当前 DSH 未提供可核实的文本模型路由，不能启动人格问候。');
  return async ({ system, messages, signal, maxTokens = 160 } = {}) => {
    signal?.throwIfAborted();
    if (typeof system !== 'string' || !system.trim() || system.length > 24_000 || !Array.isArray(messages) || !messages.length || messages.length > 3 || messages.some(message => message?.role !== 'user' || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 4000) || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 256) throw new Error('人格问候只接收有限的文本提示，不接收工具、图片或历史会话。');
    const converted = messages.map(message => ({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: message.content }], source: { kind: 'plugin', plugin: 'douyin-browser', form: 'snapshot', sections: [] } }));
    let text = '', finish, usage = {}; const deltaIndexes = new Set();
    for await (const chunk of llm.stream({ provider, model, messages: converted, system, maxTokens, signal, sessionId: agent.session.id })) {
      signal?.throwIfAborted();
      if (chunk.type === 'text-delta') { deltaIndexes.add(chunk.index); text += chunk.text; }
      if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !deltaIndexes.has(chunk.index)) text += chunk.block.text;
      if (text.length > 2000) throw new Error('人格问候模型返回过长，未发送。');
      if (chunk.type === 'usage') usage = { promptTokens: chunk.usage?.inputTokens || 0, completionTokens: chunk.usage?.outputTokens || 0, totalTokens: chunk.usage?.totalTokens ?? (chunk.usage?.inputTokens || 0) + (chunk.usage?.outputTokens || 0) };
      if (chunk.type === 'finish') finish = chunk.reason;
    }
    signal?.throwIfAborted();
    if (finish?.kind !== 'stop' || !text.trim()) throw new Error(`DSH 人格问候未完整返回（${finish?.kind || '缺少完成标记'}），未发送。`);
    return { text: text.trim(), usage };
  };
}
