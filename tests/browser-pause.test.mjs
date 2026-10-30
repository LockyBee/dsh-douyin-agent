import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { pauseExistingVideoPages } from '../browser-pause.mjs';

const endpoint = 'http://127.0.0.1:19227';
const target = (id, url = 'https://www.douyin.com/') => ({ type: 'page', url, webSocketDebuggerUrl: `ws://127.0.0.1:19227/devtools/page/${id}` });
function fixture(mode = 'ok', targets = [target('managed')]) {
  const calls = [], sockets = [], listeners = new Map();
  class FakeSocket extends EventTarget {
    constructor(url) { super(); this.url = url; this.closed = false; sockets.push(this); queueMicrotask(() => { if (!this.closed && mode !== 'connecting') this.dispatchEvent(new Event('open')); }); }
    addEventListener(type, listener, options) { super.addEventListener(type, listener, options); const set = listeners.get(this) || new Set(); set.add(`${type}:${String(listener)}`); listeners.set(this, set); }
    removeEventListener(type, listener, options) { super.removeEventListener(type, listener, options); listeners.get(this)?.delete(`${type}:${String(listener)}`); }
    send(value) {
      const input = JSON.parse(value); calls.push(input);
      queueMicrotask(() => {
        if (this.closed || mode === 'timeout') return;
        if (mode === 'error' || mode === 'close') { this.dispatchEvent(new Event(mode)); return; }
        const result = mode === 'protocol' ? { id: 1, error: { message: '合成错误' } } : mode === 'exception' ? { id: 1, result: { exceptionDetails: { text: '合成异常' } } } : { id: 1, result: { result: { value: mode === 'invalid' ? { matched: true, paused: -1 } : { matched: this.url.endsWith('/managed'), paused: this.url.endsWith('/managed') ? 1 : 0 } } } };
        this.dispatchEvent(new MessageEvent('message', { data: mode === 'malformed' ? '{' : JSON.stringify(result) }));
      });
    }
    close() { this.closed = true; }
  }
  const fetchImpl = async (url, options) => { assert.equal(url.href, endpoint + '/json/list'); assert.equal(options.redirect, 'error'); options.signal.throwIfAborted(); return new Response(JSON.stringify(targets)); };
  return { options: { endpoint, source: 'api', fetchImpl, WebSocketImpl: FakeSocket, timeoutMs: 50 }, calls, sockets, assertReleased() { assert.ok(sockets.every(socket => socket.closed)); assert.ok([...listeners.values()].every(set => set.size === 0)); } };
}

test('暂停检查只执行一次原子入口核对，不建立隔离环境或关闭页面', async () => {
  const f = fixture('ok', [target('managed'), target('foreign'), target('outside', 'https://example.test/')]);
  assert.deepEqual(await pauseExistingVideoPages(f.options), { paused: 1, existingPage: true });
  assert.equal(f.calls.length, 2); assert.equal(f.sockets.length, 2);
  for (const call of f.calls) { assert.equal(call.method, 'Runtime.evaluate'); assert.match(call.params.expression, /location\.origin.*window\.name/); assert.match(call.params.expression, /deepseek-douyin-api/); assert.equal(call.params.returnByValue, true); }
  f.assertReleased();
});

test('来源、回环端口及所有目标地址在打开连接前核对', async () => {
  for (const patch of [{ source: 'api-chat' }, { endpoint: 'https://127.0.0.1:19227' }, { endpoint: 'http://example.test:19227' }, { endpoint: 'http://user:pass@127.0.0.1:19227' }]) {
    const f = fixture(); await assert.rejects(pauseExistingVideoPages({ ...f.options, ...patch })); assert.equal(f.sockets.length, 0);
  }
  for (const url of ['ws://example.test:19227/devtools/page/foreign', 'ws://127.0.0.1:19228/devtools/page/foreign', 'ws://127.0.0.1:19227/devtools/browser/foreign', 'ws://127.0.0.1:19227/devtools/page/foreign?secret=synthetic']) {
    const f = fixture('ok', [target('managed'), { ...target('foreign'), webSocketDebuggerUrl: url }]); await assert.rejects(pauseExistingVideoPages(f.options)); assert.equal(f.sockets.length, 0);
  }
});

test('错误协议、页面异常、坏响应和提前关闭均释放所有连接与监听', async () => {
  for (const mode of ['error', 'close', 'protocol', 'exception', 'invalid', 'malformed']) {
    const f = fixture(mode); await assert.rejects(pauseExistingVideoPages(f.options)); f.assertReleased();
  }
});

test('连接中取消、响应等待取消和超时不遗留监听或连接', async () => {
  for (const mode of ['connecting', 'timeout']) {
    const f = fixture(mode), abort = new AbortController();
    const pending = pauseExistingVideoPages({ ...f.options, signal: abort.signal, timeoutMs: 500 });
    await new Promise(resolve => setTimeout(resolve, 5)); abort.abort(new Error('合成取消'));
    await assert.rejects(pending, /合成取消/); f.assertReleased(); assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
    const timed = fixture(mode); await assert.rejects(pauseExistingVideoPages({ ...timed.options, timeoutMs: 10 }), error => error.code === 'BROWSER_PAUSE_TIMEOUT'); timed.assertReleased();
  }
});

test('重复200次检查的协议和事件资源均有界', async () => {
  const f = fixture();
  for (let index = 0; index < 200; index++) await pauseExistingVideoPages(f.options);
  assert.equal(f.sockets.length, 200); assert.equal(f.calls.length, 200); f.assertReleased();
  assert.ok(f.calls.every(call => call.method === 'Runtime.evaluate'));
});
