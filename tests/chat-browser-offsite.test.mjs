import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '../playwright-runtime.mjs';
import { BrowserController } from '../core.mjs';
import { ChatBrowser } from '../chat-browser.mjs';

test('离站同名缓存页保留，显式准备创建唯一受管聊天页且重复准备不累积', async t => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext(); t.after(() => context.close());
  const html = `<!doctype html><meta charset="utf-8"><body>
    <div data-e2e="im-entry" style="display:block;width:40px;height:20px">消息</div>
    <div data-e2e="im-dialog" style="display:block;width:320px;height:320px">
      <div data-e2e="conversation-item" data-conversation-id="synthetic-one" data-conversation-type="direct"><img src="https://fixture.local/one.png" width="20" height="20"><div class="conversationConversationItemtitle">合成好友</div></div>
    </div><script>document.hasFocus=()=>false;</script></body>`;
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  const foreign = await context.newPage(); await foreign.goto('https://foreign.invalid/left'); await foreign.evaluate(() => { window.name = 'deepseek-douyin-api-chat'; });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chat-offsite-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const controller = new BrowserController({ source: 'api-chat', controlDirectory: directory });
  controller.browser = { isConnected: () => true, contexts: () => [context] };
  const chat = new ChatBrowser({ controller });
  const first = await chat.prepareChat();
  assert.equal(first.prepared, true);
  assert.equal(first.count, 1);
  const pages = context.pages();
  assert.equal(pages.length, 2);
  assert.equal(foreign.url(), 'https://foreign.invalid/left');
  assert.equal(await foreign.evaluate(() => window.name), 'deepseek-douyin-api-chat');
  const managed = pages.find(page => page !== foreign);
  assert.ok(managed);
  assert.equal(await managed.evaluate(() => window.name), 'deepseek-douyin-api-chat');
  const second = await chat.prepareChat();
  assert.equal(second.prepared, true);
  assert.equal(context.pages().length, 2);
  assert.equal(foreign.url(), 'https://foreign.invalid/left');
});
