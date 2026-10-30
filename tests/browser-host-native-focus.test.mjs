import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { installNativeFocusReset, runBrowserHost } from '../browser-host.mjs';
import { chromium } from '../playwright-runtime.mjs';
import { connectDedicatedBrowser } from '../browser-launcher.mjs';

class FakePage extends EventEmitter {
  constructor() { super(); this.closed = false; this.frame = {}; this.draft = '合成原草稿'; }
  isClosed() { return this.closed; }
  mainFrame() { return this.frame; }
  close() { this.closed = true; this.emit('close'); }
}
class FakeContext extends EventEmitter {
  constructor(pages = [new FakePage()]) { super(); this.list = pages; this.sent = []; this.detached = 0; this.closed = 0; this.sessions = 0; this.action = async () => {}; }
  pages() { return this.list.filter(page => !page.closed); }
  async newCDPSession(page) {
    this.sessions++;
    return { send: async (method, value) => { this.sent.push({ page, method, value }); await this.action(page); }, detach: async () => { this.detached++; } };
  }
  add(page) { this.list.push(page); this.emit('page', page); return page; }
  async close() { this.closed++; this.emit('close'); }
}
const turn = () => new Promise(resolve => setImmediate(resolve));
async function tempDirectory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-host-native-focus-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^douyin-host-native-focus-/); await fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }); });
  return root;
}
test('宿主焦点：启动既有页及未来页仅发送关闭模拟命令，保留草稿并detach', async t => {
  const page = new FakePage(), context = new FakeContext([page]), reset = await installNativeFocusReset(context); t.after(() => reset.close());
  const newer = context.add(new FakePage()); await reset.flush(newer);
  assert.ok(context.sent.length >= 2); assert.ok(context.sent.every(item => item.method === 'Emulation.setFocusEmulationEnabled' && item.value.enabled === false));
  assert.equal(page.draft, '合成原草稿'); assert.equal(context.detached, context.sessions); assert.equal(context.closed, 0);
});
test('宿主焦点：主frame导航及DOM就绪会重置，子frame不引入额外会话', async t => {
  const page = new FakePage(), context = new FakeContext([page]), reset = await installNativeFocusReset(context); t.after(() => reset.close());
  const before = context.sessions; page.emit('framenavigated', {}); await turn(); assert.equal(context.sessions, before);
  page.emit('framenavigated', page.mainFrame()); page.emit('domcontentloaded'); await reset.flush(page);
  assert.ok(context.sessions > before); assert.equal(context.detached, context.sessions);
});
test('宿主焦点：页面关闭竞态不误报失败，迟到session仍detach且关闭后无监听残留', async () => {
  const page = new FakePage(), context = new FakeContext([page]), gate = Promise.withResolvers(), faults = []; let detached = 0;
  context.newCDPSession = () => gate.promise;
  const opening = installNativeFocusReset(context, { onFailure: error => faults.push(error), timeoutMs: 500 });
  page.close(); gate.resolve({ send: () => { throw Error('关闭后不能发送命令'); }, detach: async () => { detached++; } });
  const reset = await opening; await reset.close(); assert.equal(detached, 1); assert.equal(faults.length, 0); assert.equal(context.listenerCount('page'), 0); assert.equal(page.eventNames().length, 0);
});
test('宿主焦点：CDP失败不静默吞掉，启动返回失败且正常清理', async t => {
  const directory = await tempDirectory(t), context = new FakeContext(), logs = [];
  context.action = async () => { throw Error('token=synthetic-secret C:\\private\\profile'); };
  const result = await runBrowserHost({ profile: path.join(directory, 'profile'), controlDir: directory, port: 19228, chromiumImpl: { launchPersistentContext: async () => context }, probeInstallation: async () => ({ version: '106.0.1.2' }), logger: { log() {}, error: value => logs.push(value) }, processImpl: { pid: process.pid, on() {}, exit() {} } });
  const state = JSON.parse(await fs.readFile(path.join(directory, 'browser.json'), 'utf8'));
  assert.equal(result.started, false); assert.equal(state.ready, false); assert.equal(state.launchFailure.code, 'EDGE_FOCUS_RESET_FAILED'); assert.equal(context.detached, 1); assert.equal(context.closed, 1); assert.ok(!JSON.stringify([state, logs]).includes('synthetic-secret'));
});
test('宿主焦点：运行中新页CDP失败明确撤销ready，保留浏览器与草稿', async t => {
  const directory = await tempDirectory(t), context = new FakeContext(), logs = [];
  const result = await runBrowserHost({ profile: path.join(directory, 'profile'), controlDir: directory, port: 19229, chromiumImpl: { launchPersistentContext: async () => context }, probeInstallation: async () => ({ version: '106.0.1.2' }), logger: { log() {}, error: value => logs.push(value) }, processImpl: { pid: process.pid, on() {}, exit() {} } });
  assert.equal(result.started, true); context.action = async () => { throw Error('合成运行中CDP失败'); }; const page = context.add(new FakePage());
  const deadline = Date.now() + 2000;
  while (!(JSON.parse(await fs.readFile(path.join(directory, 'browser.json'), 'utf8')).launchFailure) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const state = JSON.parse(await fs.readFile(path.join(directory, 'browser.json'), 'utf8'));
  assert.equal(state.ready, false); assert.equal(state.launchFailure.code, 'EDGE_FOCUS_RESET_FAILED'); assert.equal(context.closed, 0); assert.equal(page.draft, '合成原草稿'); assert.ok(logs.length > 0); await context.close();
});
test('宿主焦点：故障后的flush不能通过空resolve冒充健康', async () => {
  const context = new FakeContext(), reset = await installNativeFocusReset(context), page = new FakePage();
  context.action = async () => { throw Error('合成故障'); }; context.add(page);
  await assert.rejects(reset.flush(page), /焦点模拟/); await assert.rejects(reset.flush(page), /焦点模拟/); await reset.close();
});
test('宿主焦点：运行中故障记录无法持久化时正常退出，不继续保留活ready', async t => {
  const directory = await tempDirectory(t), controlDir = path.join(directory, 'control'), context = new FakeContext(), exit = Promise.withResolvers(), logs = [];
  await fs.mkdir(controlDir);
  await runBrowserHost({ profile: path.join(directory, 'profile'), controlDir, port: 19230, chromiumImpl: { launchPersistentContext: async () => context }, probeInstallation: async () => ({ version: '106.0.1.2' }), logger: { log() {}, error: value => logs.push(value) }, processImpl: { pid: process.pid, on() {}, exit: code => exit.resolve(code) } });
  await fs.rename(controlDir, path.join(directory, 'moved-control')); context.action = async () => { throw Error('合成故障'); }; context.add(new FakePage());
  const code = await Promise.race([exit.promise, new Promise((_, reject) => setTimeout(() => reject(Error('故障后未正常退出')), 2000))]);
  assert.equal(code, 1); assert.equal(context.closed, 1); assert.ok(logs.some(value => value.includes('正常结束专用浏览器')));
});
test('宿主焦点：超时明确失败，迟到创建的session只detach不再设置模拟', async () => {
  const page = new FakePage(), context = new FakeContext([page]), gate = Promise.withResolvers(), faults = []; let sends = 0, detached = 0;
  context.newCDPSession = () => gate.promise;
  await assert.rejects(installNativeFocusReset(context, { timeoutMs: 15, onFailure: error => faults.push(error) }), /焦点模拟/);
  gate.resolve({ send: async () => { sends++; }, detach: async () => { detached++; } }); await turn();
  assert.equal(faults.length, 1); assert.equal(sends, 0); assert.equal(detached, 1); assert.equal(context.listenerCount('page'), 0);
});
test('宿主焦点：context在初始化中关闭时拒绝就绪，不与单页关闭混同', async () => {
  const page = new FakePage(), context = new FakeContext([page]), gate = Promise.withResolvers(); let detached = 0;
  context.newCDPSession = () => gate.promise;
  const opening = installNativeFocusReset(context);
  await context.close(); gate.resolve({ send: async () => {}, detach: async () => { detached++; } });
  await assert.rejects(opening, error => error.code === 'EDGE_FOCUS_RESET_FAILED'); assert.equal(detached, 1); assert.equal(context.listenerCount('page'), 0);
});

async function nativeClient(url) {
  const socket = new WebSocket(url), pending = new Map(); let sequence = 0;
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const onMessage = event => { const value = JSON.parse(event.data), item = pending.get(value.id); if (!item) return; pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(Error(value.error.message)) : item.resolve(value.result); };
  socket.addEventListener('message', onMessage);
  return { call(method, params = {}) { return new Promise((resolve, reject) => { const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('隔离原生CDP超时')); }, 5000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); }); }, async close() { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('隔离连接结束')); } pending.clear(); socket.removeEventListener('message', onMessage); if (socket.readyState === WebSocket.OPEN) await new Promise(resolve => { socket.addEventListener('close', resolve, { once: true }); socket.close(); }); } };
}
test('隔离真实宿主：连续新页、导航及noDefaults重连保持真实焦点和草稿', { timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-host-native-focus-')), server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve));
  let context, attached; const clients = [];
  t.after(async () => { await attached?.close().catch(() => {}); for (const client of clients.reverse()) await client.close().catch(() => {}); await context?.close().catch(() => {}); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-host-native-focus-/); await fs.rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }); });
  const result = await runBrowserHost({ profile: path.join(directory, 'profile'), controlDir: path.join(directory, 'control'), port, chromiumImpl: { launchPersistentContext: async (profile, options) => { context = await chromium.launchPersistentContext(profile, { ...options, headless: true, args: [...options.args, '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND'] }); return context; } }, probeInstallation: async () => ({ version: '106.0.1.2' }), logger: { log() {}, error: value => { throw Error(value); } }, processImpl: { pid: process.pid, on() {}, exit() {} } });
  assert.equal(result.started, true);
  const endpoint = 'http://127.0.0.1:' + port, background = [];
  const read = async (page, expression = '({focus:document.hasFocus(),draft:document.querySelector("input")?.value??null})') => {
    const rows = await (await fetch(endpoint + '/json/list')).json(), row = rows.find(item => item.url === page.url()); assert.ok(row);
    const client = await nativeClient(row.webSocketDebuggerUrl); clients.push(client);
    return (await client.call('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  };
  const waitFor = async (page, expected) => { let value; const deadline = Date.now() + 5000; do { value = await read(page); if (value.focus === expected) return value; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < deadline); assert.equal(value.focus, expected); };
  for (let index = 0; index < 5; index++) { const page = await context.newPage(); await page.goto('data:text/html,<title>host-' + index + '</title><input value="draft-' + index + '">'); background.push(page); }
  const active = await context.newPage(); await active.goto('data:text/html,<title>host-active</title>'); await active.bringToFront();
  for (let index = 0; index < background.length; index++) assert.deepEqual(await waitFor(background[index], false), { focus: false, draft: 'draft-' + index });
  assert.equal((await waitFor(active, true)).focus, true);
  await background[0].goto('data:text/html,<title>host-navigated</title><input value="new-draft">'); await active.bringToFront(); assert.deepEqual(await waitFor(background[0], false), { focus: false, draft: 'new-draft' });
  attached = await connectDedicatedBrowser(endpoint); assert.equal((await waitFor(background[0], false)).focus, false); await attached.close(); attached = null;
  await background[1].evaluate(async () => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16; const graphics = canvas.getContext('2d'), video = document.createElement('video'); video.muted = true; video.autoplay = true; document.body.append(canvas, video); let frame = 0; window.__syntheticMediaTimer = setInterval(() => { graphics.fillStyle = frame++ % 2 ? 'red' : 'blue'; graphics.fillRect(0, 0, 16, 16); }, 50); video.srcObject = canvas.captureStream(10); await video.play(); });
  await active.bringToFront(); const mediaExpression = '({focus:document.hasFocus(),visibility:document.visibilityState,paused:document.querySelector("video").paused,time:document.querySelector("video").currentTime})';
  const mediaBefore = await read(background[1], mediaExpression); await new Promise(resolve => setTimeout(resolve, 1000)); const mediaAfter = await read(background[1], mediaExpression);
  console.log(JSON.stringify({ kind: 'isolated-host-background-media', before: mediaBefore, after: mediaAfter, advanced: mediaAfter.time > mediaBefore.time, douyinCompatibilityVerified: false }));
  await background[0].bringToFront(); assert.deepEqual(await waitFor(background[0], true), { focus: true, draft: 'new-draft' }); assert.equal((await waitFor(active, false)).focus, false);
  const state = JSON.parse(await fs.readFile(path.join(directory, 'control/browser.json'), 'utf8')); assert.equal(state.ready, true); assert.ok(await (await fetch(endpoint + '/json/version')).json());
});
