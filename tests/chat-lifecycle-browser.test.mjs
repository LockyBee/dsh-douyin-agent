import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../playwright-runtime.mjs';
import { ChatBrowser } from '../chat-browser.mjs';

test('消息面板已关闭时，后台检查不点击入口或安装额外监听', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button data-e2e="im-entry">消息</button><video></video>');
    await page.evaluate(() => { window.testClicks = 0; document.querySelector('button').onclick = () => { window.testClicks++; const panel = document.createElement('div'); panel.dataset.e2e = 'im-dialog'; panel.style.cssText = 'width:100px;height:100px'; document.body.append(panel); }; });
    const chat = new ChatBrowser({ controller: {} });
    for (let i = 0; i < 30; i++) await assert.rejects(chat.dialog(page), error => error.code === 'CHAT_PAGE_NOT_OPEN');
    assert.deepEqual(await page.evaluate(() => ({ clicks: window.testClicks, installed: Boolean(window.__deepseekChatPauseVideo) })), { clicks: 0, installed: false });
    await chat.dialog(page, undefined, { open: true });
    assert.equal(await page.evaluate(() => window.testClicks), 1);
  } finally { await browser.close(); }
});
