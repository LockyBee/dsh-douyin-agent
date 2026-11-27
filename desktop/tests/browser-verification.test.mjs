import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createBrowserVerification, openBrowserVerificationWindow } from '../src/browser-verification.mjs';

const binding = { instanceId: '合成专用浏览器', targetId: 'c'.repeat(32) };
const required = { status: 'required', mode: 'background', binding, verificationRequired: true };

test('辅助验证只打开一个窗口，通过检查前保留原标签的身份', async () => {
  const reads = [], opened = [];
  let next = required, closed = 0, focused = 0;
  const helper = createBrowserVerification({
    inspect: async selected => { reads.push(selected); return next; },
    openView: async target => {
      opened.push(target);
      return { isDestroyed: () => false, isMinimized: () => false, show: () => {}, close: () => closed++, focus: () => focused++ };
    },
  });
  const first = helper.open();
  assert.equal(helper.open(), first);
  assert.deepEqual(await first, { status: 'opened', mode: 'background', verificationRequired: true });
  assert.equal(opened.length, 1);
  assert.equal(new URL(opened[0].url).origin, 'http://127.0.0.1:9227');
  assert.equal(opened[0].socket, `ws://127.0.0.1:9227/devtools/page/${binding.targetId}`);
  assert.equal((await helper.open()).status, 'opened');
  assert.equal(focused, 1);
  assert.equal((await helper.check()).status, 'required');
  assert.equal(closed, 0);
  next = { status: 'ready', mode: 'background' };
  assert.deepEqual(await helper.check(), { status: 'verified', mode: 'background', verificationRequired: false });
  assert.deepEqual(reads, [undefined, binding, binding, binding, undefined]);
  assert.equal(closed, 1);
  assert.equal((await helper.check()).status, 'ready');
});

test('本次验证通过后，另一张有真实验证码的标签仍显示待验证', async () => {
  const other = { ...required, binding: { ...binding, targetId: 'd'.repeat(32) } };
  let passed = false, closed = 0;
  const helper = createBrowserVerification({
    inspect: async selected => !passed ? required : selected ? { status: 'ready', mode: 'background' } : other,
    openView: async () => ({ isDestroyed: () => false, close: () => closed++ }),
  });
  await helper.open();
  passed = true;
  assert.deepEqual(await helper.check(), { status: 'required', mode: 'background', verificationRequired: true });
  assert.equal(closed, 1);
});

test('旧浏览器会话消失时关闭验证窗口，本次结果由新会话重新检查', async () => {
  const calls = [];
  let next = required, closed = 0;
  const helper = createBrowserVerification({
    inspect: async selected => { calls.push(selected); return next; },
    openView: async () => ({ isDestroyed: () => false, close: () => closed++ }),
  });
  await helper.open();
  next = { status: 'session-changed' };
  assert.equal((await helper.check()).status, 'session-changed');
  next = { status: 'ready', mode: 'background' };
  assert.equal((await helper.check()).status, 'ready');
  assert.deepEqual(calls, [undefined, binding, undefined]);
  assert.equal(closed, 1);
});

test('辅助验证拒绝伪造的标签编号', async () => {
  const helper = createBrowserVerification({
    inspect: async () => ({ ...required, binding: { ...binding, targetId: 'https://example.test/' } }),
    openView: async () => assert.fail('不得打开未核对的标签。'),
  });
  await assert.rejects(helper.open(), /核对/);
});

test('主窗口在验证画面加载时关掉，随后打开的独立验证窗口也会关闭', async () => {
  const started = Promise.withResolvers();
  const loaded = Promise.withResolvers();
  let closed = 0;
  const helper = createBrowserVerification({
    inspect: async () => required,
    openView: () => { started.resolve(); return loaded.promise; },
  });
  const opening = helper.open();
  await started.promise;
  helper.close();
  loaded.resolve({ isDestroyed: () => false, close: () => closed++ });
  await assert.rejects(opening, /软件窗口已关闭/);
  assert.equal(closed, 1);
});

test('验证窗口只连接本机官方投屏资源和选中的单一标签', async () => {
  const target = {
    url: 'http://127.0.0.1:9227/devtools/inspector.html',
    socket: `ws://127.0.0.1:9227/devtools/page/${binding.targetId}`,
  };
  let filter;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = function setHandler(handler) { this.openHandler = handler; };
      this.webContents.session = new EventEmitter();
      this.webContents.session.setPermissionCheckHandler = () => {};
      this.webContents.session.setPermissionRequestHandler = () => {};
      this.webContents.session.webRequest = { onBeforeRequest: handler => { filter = handler; } };
    }
    async loadURL(url) { this.url = url; }
    isMinimized() { return false; }
    show() { this.shown = true; }
    focus() { this.focused = true; }
  }
  const view = await openBrowserVerificationWindow(Window, target);
  assert.equal(view.url, target.url);
  assert.equal(view.shown, true);
  assert.equal(view.focused, true);
  assert.equal('parent' in view.options, false);
  assert.equal(view.options.webPreferences.nodeIntegration, false);
  assert.equal(view.options.webPreferences.sandbox, true);
  assert.deepEqual(view.webContents.openHandler(), { action: 'deny' });
  const cancelled = url => { let result; filter({ url }, value => { result = value.cancel; }); return result; };
  assert.equal(cancelled(target.socket), false);
  assert.equal(cancelled('http://127.0.0.1:9227/devtools/inspector.html'), false);
  assert.equal(cancelled('http://127.0.0.1:9227/devtools/entrypoints/inspector/inspector.js'), false);
  assert.equal(cancelled('http://127.0.0.1:9227/json/list'), true);
  assert.equal(cancelled(`ws://127.0.0.1:9227/devtools/page/${'d'.repeat(32)}`), true);
  assert.equal(cancelled('https://example.test/devtools/inspector.html'), true);
});
