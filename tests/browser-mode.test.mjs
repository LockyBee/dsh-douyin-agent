import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BrowserMode, browserExecutionMode } from '../browser-mode.mjs';
import { runBrowserHost } from '../browser-host.mjs';

function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-browser-mode-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
test('后台运行方式默认不改旧行为，只保存用户选择，不启动或关闭浏览器', t => {
  const controlDir = temp(t), service = new BrowserMode({ controlDir });
  assert.equal(service.state().mode, 'visible');
  assert.throws(() => service.configure({ mode: 'background' }), /用户/);
  for (const input of [{ mode: true }, { mode: 'headless' }, { mode: 'background', profile: 'other' }]) assert.throws(() => service.configure(input, { explicit: true }));
  assert.equal(service.configure({ mode: 'background' }, { explicit: true }).mode, 'background');
  fs.writeFileSync(path.join(controlDir, 'browser.json'), JSON.stringify({ pid: process.pid, ready: true, mode: 'visible' }));
  assert.equal(service.state().restartRequired, true);
  assert.equal(new BrowserMode({ controlDir }).policy().mode, 'background');
  fs.writeFileSync(service.file, 'broken'); assert.throws(() => service.policy(), /核对/);
});
test('后台模式必须由浏览器启动参数证明，网页焦点或未响应不算证据；同连接只查一次', async () => {
  for (const [args, expected] of [[['--headless=new'], 'background'], [['--headless'], 'background'], [['--window-position=-10000,0'], 'visible'], [['--not-headless=true'], 'visible']]) {
    let calls = 0, detached = 0;
    const browser = { newBrowserCDPSession: async () => ({ send: async method => { assert.equal(method, 'Browser.getBrowserCommandLine'); calls++; return { arguments: args }; }, detach: async () => { detached++; } }) };
    assert.equal(await browserExecutionMode(browser), expected); assert.equal(await browserExecutionMode(browser), expected);
    assert.equal(calls, 1); await new Promise(resolve => setImmediate(resolve)); assert.equal(detached, 1);
  }
  assert.equal(await browserExecutionMode({}), 'unknown');
  assert.equal(await browserExecutionMode({ newBrowserCDPSession: async () => { throw Error('无法读取'); } }), 'unknown');
  let detached = 0;
  const native = { newBrowserCDPSession: async () => ({ send: async method => { if (method === 'Browser.getBrowserCommandLine') throw Error('automation 未开启'); return { userAgent: 'Mozilla/5.0 HeadlessChrome/157.0.0.0' }; }, detach: async () => { detached++; } }) };
  assert.equal(await browserExecutionMode(native), 'background'); await new Promise(resolve => setImmediate(resolve)); assert.equal(detached, 1);
});
test('实际宿主按明确模式启动 persistent Edge，并记录同一模式，不更换用户目录', async t => {
  for (const mode of ['visible', 'background']) {
    const controlDir = temp(t), profile = path.join(controlDir, 'profile'); let captured;
    const context = new EventEmitter(); Object.assign(context, { pages: () => [], newCDPSession: async () => ({}), close: async () => context.emit('close') });
    const result = await runBrowserHost({ profile, controlDir, port: 19320, mode, chromiumImpl: { launchPersistentContext: async (directory, options) => { captured = { directory, options }; return context; } }, probeInstallation: async () => ({}), logger: { log() {}, error() {} }, processImpl: { pid: process.pid, on() {}, exit() {} } });
    assert.equal(result.started, true); assert.equal(captured.directory, profile); assert.equal(captured.options.headless, mode === 'background');
    assert.ok(captured.options.ignoreDefaultArgs.includes('--mute-audio'), '声音由静默设置控制');
    const stored = JSON.parse(fs.readFileSync(path.join(controlDir, 'browser.json'))); assert.equal(stored.mode, mode); assert.equal(stored.headless, mode === 'background');
    await context.close();
  }
  let called = false;
  const result = await runBrowserHost({ profile: 'unused', controlDir: 'unused', port: 19320, mode: 'invalid', chromiumImpl: { launchPersistentContext: async () => { called = true; } } });
  assert.equal(result.exitCode, 2); assert.equal(called, false);
});
