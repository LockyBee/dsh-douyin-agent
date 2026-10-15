import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApiServer, stopApiServer } from '../app.mjs';

const config = { apiKey: 'synthetic-key', model: 'synthetic' };
test('服务停止等待任务、worker、浏览器和额外清理完成，重复停止共用一次结果', async () => {
  const closed = [], release = Promise.withResolvers(), entered = Promise.withResolvers();
  const agent = { runTask: async ({ signal }) => {
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await release.promise; closed.push('task'); return { status: 'stopped' };
  } };
  const server = createApiServer({ config, agent, controller: { execute: async () => ({}), close: async () => { await release.promise; closed.push('browser'); } }, chatService: { close: async () => { await release.promise; closed.push('chat'); } } });
  server.addShutdownHook(async () => { await release.promise; closed.push('extra'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, bootstrap = await (await fetch(base + '/api/bootstrap')).json();
  const response = await fetch(base + '/api/task', { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': bootstrap.token }, body: JSON.stringify({ instruction: '合成退出任务，不访问模型' }) });
  assert.equal(response.status, 202); await response.json(); await entered.promise;
  const stopping = stopApiServer(server); assert.equal(stopping, stopApiServer(server));
  let stopped = false; void stopping.then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(stopped, false);
  release.resolve(); await stopping;
  assert.deepEqual(closed.sort(), ['browser', 'chat', 'extra', 'task']);
  assert.equal(server.listening, false); assert.throws(() => server.addShutdownHook(() => {}), /停止前/);
});
test('未监听的启动失败实例也能清理，资源错误回传且重复停止不重做', async () => {
  let closes = 0;
  const server = createApiServer({ config, controller: { execute: async () => ({}), close: async () => { closes++; throw new Error('合成关闭失败'); } } });
  const stopped = stopApiServer(server); await assert.rejects(stopped, AggregateError); assert.equal(stopped, stopApiServer(server)); assert.equal(closes, 1);
  assert.throws(() => stopApiServer({}), /本工具/);
});
