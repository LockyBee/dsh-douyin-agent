import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatBrowser } from '../chat-browser.mjs';
import { chromium } from '../playwright-runtime.mjs';

function fixture({ focused = true, windowState = 'minimized', failAt } = {}) {
  let created = 0, detached = 0, active = 0;
  const commands = [];
  const page = { evaluate: async () => focused, context: () => ({ newCDPSession: async current => {
    assert.equal(current, page);
    if (failAt === 'create') throw new Error('合成创建失败');
    created++; active++;
    return { send: async (command, input) => {
      commands.push(command); if (failAt === command) throw new Error('合成查询失败');
      if (command === 'Target.getTargetInfo') return { targetInfo: { targetId: 'synthetic-target' } };
      assert.equal(command, 'Browser.getWindowForTarget'); assert.deepEqual(input, { targetId: 'synthetic-target' });
      return { bounds: { windowState } };
    }, detach: async () => { detached++; active--; } };
  } }) };
  return { page, chat: new ChatBrowser({ controller: {} }), counts: () => ({ created, detached, active }), commands };
}

test('网页残留可见和焦点时，已最小化的当前页面窗口仍判为后台', async () => {
  const f = fixture(); assert.equal(await f.chat.isForeground(f.page), false);
  assert.deepEqual(f.counts(), { created: 1, detached: 1, active: 0 });
  assert.deepEqual(f.commands, ['Target.getTargetInfo', 'Browser.getWindowForTarget']);
});

test('普通前台或未知窗口状态不被放行', async () => {
  for (const windowState of ['normal', 'maximized', 'fullscreen', null, 'unknown']) {
    const f = fixture({ windowState }); assert.equal(await f.chat.isForeground(f.page), true);
    assert.equal(f.counts().active, 0);
  }
});

test('网页未聚焦时不额外创建CDP会话', async () => {
  const f = fixture({ focused: false }); assert.equal(await f.chat.isForeground(f.page), false);
  assert.deepEqual(f.counts(), { created: 0, detached: 0, active: 0 });
});

test('CDP创建或查询失败时保守判为前台并释放已创建会话', async () => {
  for (const failAt of ['create', 'Target.getTargetInfo', 'Browser.getWindowForTarget']) {
    const f = fixture({ failAt }); assert.equal(await f.chat.isForeground(f.page), true);
    assert.equal(f.counts().active, 0); assert.equal(f.counts().created, f.counts().detached);
  }
});

test('连续50次只读焦点检查不积累CDP会话或写入命令', async () => {
  const f = fixture(); for (let i = 0; i < 50; i++) assert.equal(await f.chat.isForeground(f.page), false);
  assert.deepEqual(f.counts(), { created: 50, detached: 50, active: 0 });
  assert.ok(f.commands.every(command => ['Target.getTargetInfo', 'Browser.getWindowForTarget'].includes(command)));
});

test('隔离Edge合成页面：真实最小化窗口且DOM残留焦点时返回后台', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage(); await page.setContent('<p>合成焦点窗口</p>');
    await page.evaluate(() => { document.hasFocus = () => true; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); });
    const session = await page.context().newCDPSession(page);
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo');
      const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      const state = await session.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
      assert.equal(state.bounds.windowState, 'minimized');
      assert.deepEqual(await page.evaluate(() => ({ visibility: document.visibilityState, focus: document.hasFocus() })), { visibility: 'visible', focus: true });
      const chat = new ChatBrowser({ controller: {} });
      assert.equal(await chat.isForeground(page), false);
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      assert.equal(await chat.isForeground(page), true);
    } finally { await session.detach(); }
  } finally { await browser.close(); }
});
