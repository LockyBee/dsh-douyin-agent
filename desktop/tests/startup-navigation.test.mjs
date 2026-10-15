import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createStartupTimeline, localStartupUrl, navigateStartup, probeStartupPage } from '../src/startup-navigation.mjs';

const html = Buffer.from('<!doctype html><html lang="zh-CN"><body>合成启动页面</body></html>');
const expectedSha256 = createHash('sha256').update(html).digest('hex');
const navError = (code = 'ERR_FAILED', errno = -2) => Object.assign(new Error('合成导航失败'), { code, errno });

async function fixture(t, behavior, { status = 200, type = 'text/html; charset=utf-8' } = {}) {
  let httpCalls = 0, resolveExit;
  const server = http.createServer((_request, response) => { httpCalls++; response.writeHead(status, { 'content-type': type }); response.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const contents = Object.assign(new EventEmitter(), { destroyed: false, current: 'about:blank', isDestroyed() { return this.destroyed; }, getURL() { return this.current; }, stop() { this.emit('did-stop-loading'); } });
  const backend = { child: { connected: true, exitCode: null, signalCode: null }, exited: new Promise(resolve => { resolveExit = resolve; }) };
  const events = [];
  const window = { webContents: contents, calls: 0, isDestroyed: () => contents.destroyed, async loadURL(target) { this.calls++; contents.emit('did-start-navigation', {}, target, false, true); return behavior({ contents, window, backend, target, exit: () => { backend.child.connected = false; backend.child.exitCode = 1; resolveExit(); } }); } };
  return { window, contents, backend, events, url, httpCalls: () => httpCalls,
    run: options => navigateStartup({ window, backend, url, expectedSha256, record: (event, detail) => events.push({ event, ...detail }), retryDelays: [0, 0], ...options }),
  };
}
function complete({ contents, target }) { contents.current = target; contents.emit('did-finish-load'); contents.emit('did-stop-loading'); }
function assertNoListeners(contents) { for (const name of ['destroyed', 'did-start-navigation', 'did-fail-load', 'did-finish-load', 'did-stop-loading', 'render-process-gone', 'preload-error']) assert.equal(contents.listenerCount(name), 0, name); }

test('真实临时HTTP就绪，Electron无主框架失败的stop/-2只有限重试后确认就绪', async t => {
  const f = await fixture(t, values => { if (values.window.calls === 1) { values.contents.emit('did-stop-loading'); throw navError(); } complete(values); });
  assert.deepEqual(await f.run({ checkRenderer: async () => true }), { ready: true, attempts: 2 });
  assert.equal(f.window.calls, 2); assert.equal(f.httpCalls(), 2);
  assert.equal(f.events.filter(item => item.event === 'navigation.retry').length, 1);
  assert.equal(f.events.at(-1).event, 'navigation.ready');
  assert.equal(f.events.find(item => item.event === 'http.ready').sha256, expectedSha256);
  assertNoListeners(f.contents);
});

test('明确的本机连接瞬断可重试，已记录的ERR_FAILED与取消导航不重试', async t => {
  const transient = await fixture(t, values => {
    if (values.window.calls === 1) { values.contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', values.target, true); values.contents.emit('did-stop-loading'); throw navError('ERR_CONNECTION_REFUSED', -102); }
    complete(values);
  });
  assert.equal((await transient.run()).attempts, 2);
  for (const [code, errno] of [['ERR_FAILED', -2], ['ERR_ABORTED', -3], ['ERR_FILE_NOT_FOUND', -6]]) {
    const f = await fixture(t, values => { values.contents.emit('did-fail-load', {}, errno, code, values.target, true); values.contents.emit('did-stop-loading'); throw navError(code, errno); });
    await assert.rejects(f.run(), error => error.code === code); assert.equal(f.window.calls, 1); assertNoListeners(f.contents);
  }
});

test('无stop证据的泛化-2不重试，重试总数最多三次且不无限等待', async t => {
  const unsupported = await fixture(t, () => { throw navError(); });
  await assert.rejects(unsupported.run(), error => error.code === 'ERR_FAILED'); assert.equal(unsupported.window.calls, 1);
  const repeated = await fixture(t, ({ contents }) => { contents.emit('did-stop-loading'); throw navError(); });
  await assert.rejects(repeated.run(), error => error.code === 'ERR_FAILED'); assert.equal(repeated.window.calls, 3); assert.equal(repeated.httpCalls(), 3);
  assert.equal(repeated.events.filter(item => item.event === 'navigation.retry').length, 2); assertNoListeners(repeated.contents);
  await assert.rejects(repeated.run({ maxAttempts: 4 }), /预算/);
});

test('HTTP就绪检查期间旧about:blank停止事件不算本次导航失败证据', async t => {
  const f = await fixture(t, () => { throw navError(); });
  await assert.rejects(f.run({ probe: async (...args) => { f.contents.emit('did-stop-loading'); return probeStartupPage(...args); } }), error => error.code === 'ERR_FAILED');
  assert.equal(f.window.calls, 1); assert.equal(f.events.some(item => item.event === 'navigation.retry'), false);
  assert.equal(f.events.find(item => item.event === 'navigation.stopped-event').stage, 'preflight');
});

test('用户销毁窗口与后台退出均立即结束，不把它们当瞬时-2重试', async t => {
  const destroyed = await fixture(t, ({ contents }) => { contents.destroyed = true; contents.emit('destroyed'); throw navError(); });
  await assert.rejects(destroyed.run(), error => error.code === 'STARTUP_WINDOW_CLOSED'); assert.equal(destroyed.window.calls, 1); assertNoListeners(destroyed.contents);
  const exited = await fixture(t, ({ exit }) => { exit(); return new Promise(() => {}); });
  await assert.rejects(exited.run(), error => error.code === 'STARTUP_BACKEND_EXITED'); assert.equal(exited.window.calls, 1); assertNoListeners(exited.contents);
});

test('渲染进程退出与预加载错误不重试，成功load也要检查桌面接口', async t => {
  const crashed = await fixture(t, ({ contents }) => { contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 5 }); return new Promise(() => {}); });
  await assert.rejects(crashed.run(), error => error.code === 'STARTUP_RENDERER_GONE'); assert.equal(crashed.window.calls, 1);
  const preload = await fixture(t, values => { values.contents.emit('preload-error', {}, '/不应记录的本地路径', new Error('合成错误不应输出')); complete(values); });
  await assert.rejects(preload.run(), error => error.code === 'STARTUP_PRELOAD_FAILED'); assert.equal(preload.window.calls, 1);
  assert.doesNotMatch(JSON.stringify(preload.events), /不应记录|合成错误/);
  const unready = await fixture(t, complete);
  await assert.rejects(unready.run({ checkRenderer: async () => false }), error => error.code === 'STARTUP_RENDERER_UNREADY'); assert.equal(unready.window.calls, 1);
});

test('导航超时有界结束且停止当前加载，不借它产生的-2再次重试', async t => {
  const f = await fixture(t, () => new Promise(() => {}));
  await assert.rejects(f.run({ timeoutMs: 20 }), error => error.code === 'STARTUP_NAVIGATION_TIMEOUT');
  assert.equal(f.window.calls, 1); assert.equal(f.events.some(item => item.event === 'navigation.retry'), false); assertNoListeners(f.contents);
});

test('目标仅限无凭据无查询的本机首页，HTTP和实际导航目标不匹配则不加载重试', async t => {
  for (const url of ['https://127.0.0.1:1234/', 'http://localhost:1234/', 'http://127.0.0.1:1234/api/bootstrap', 'http://name:secret@127.0.0.1:1234/', 'http://127.0.0.1:1234/?token=secret', 'http://127.0.0.1:1234/#secret']) assert.throws(() => localStartupUrl(url), /本机/);
  const changed = await fixture(t, values => { complete(values); values.contents.current = 'https://example.invalid/'; });
  await assert.rejects(changed.run(), error => error.code === 'STARTUP_TARGET_CHANGED'); assert.equal(changed.window.calls, 1);
  const badResponse = await fixture(t, complete, { status: 503 });
  await assert.rejects(badResponse.run(), error => error.code === 'STARTUP_HTTP_UNREADY'); assert.equal(badResponse.window.calls, 0);
  const badHash = await fixture(t, complete);
  await assert.rejects(badHash.run({ expectedSha256: '0'.repeat(64) }), error => error.code === 'STARTUP_HTTP_INVALID'); assert.equal(badHash.window.calls, 0);
  const probe = await probeStartupPage(badHash.url, { expectedSha256 }); assert.deepEqual(probe, { status: 200, bytes: html.length, sha256: expectedSha256 });
});

test('主框架偏离本机首页即便随后stop/-2也不重试，子框架失败不冒充主框架', async t => {
  const foreign = await fixture(t, ({ contents }) => { contents.emit('did-start-navigation', {}, 'https://untrusted.invalid/?secret=never-log', false, true); contents.emit('did-stop-loading'); throw navError(); });
  await assert.rejects(foreign.run(), error => error.code === 'ERR_FAILED'); assert.equal(foreign.window.calls, 1); assert.doesNotMatch(JSON.stringify(foreign.events), /untrusted|secret/);
  const subframe = await fixture(t, values => { values.contents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://untrusted.invalid/', false); complete(values); });
  assert.equal((await subframe.run()).ready, true); assert.equal(subframe.window.calls, 1);
});

test('成功启动归档旧错误而不保留活动误报，诊断时间线不保存URL、Key或任意字段', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'douyin-startup-timeline-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  const first = await createStartupTimeline(directory, { runId: 'synthetic-failed-run' });
  await first.fail('合成旧启动失败，供历史核对');
  const second = await createStartupTimeline(directory, { runId: 'synthetic-success-run' });
  second.record('navigation.rejected', { code: 'ERR_FAILED', errno: -2, target: 'http://name:synthetic-secret@127.0.0.1/', apiKey: 'synthetic-secret', message: 'synthetic-secret' });
  await second.success(); second.record('exit.requested', { exitCode: 0 }); await second.flush();
  await assert.rejects(fs.access(path.join(directory, 'startup-error.txt')), { code: 'ENOENT' });
  assert.match(await fs.readFile(path.join(directory, 'startup-errors', 'synthetic-failed-run.txt'), 'utf8'), /合成旧启动失败/);
  assert.match(await fs.readFile(path.join(directory, 'startup-errors', 'synthetic-success-run-previous.txt'), 'utf8'), /合成旧启动失败/);
  const raw = await fs.readFile(second.file, 'utf8'); assert.doesNotMatch(raw, /synthetic-secret|http:|apiKey|message/);
  const lines = raw.trim().split('\n').map(line => JSON.parse(line)); assert.deepEqual(lines.map(line => line.seq), [1, 2, 3, 4]);
  assert.equal(lines.some(line => line.event === 'startup.ready'), true); assert.equal(lines.at(-1).event, 'exit.requested');
});
