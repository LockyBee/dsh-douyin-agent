import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../playwright-runtime.mjs';
import { ChatBrowser } from '../chat-browser.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture({ wrapper = 'button', pointerEvents = 'none', duplicate = false, appendReceipt = true } = {}) {
  const page = await browser.newPage();
  const control = wrapper === 'button' ? 'button' : 'div';
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;font:16px sans-serif}[data-e2e="im-dialog"]{width:800px;height:550px}.header{height:40px}#editor{display:inline-block;width:400px;height:42px;border:1px solid #888}#send-target{display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;padding:0;vertical-align:top}.e2e-send-msg-btn{width:32px;height:32px;pointer-events:${pointerEvents}}</style>
    <div data-e2e="im-dialog">
      <div data-e2e="conversation-item" data-conversation-id="synthetic-svg-peer" data-conversation-type="direct"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" width="20" height="20"><div class="conversationConversationItemtitle">合成SVG好友</div></div>
      <div class="StackLayoutpagespageRoot" data-e2e="chat-page">
        <div class="StackLayoutStackChatHeaderuser header" data-conversation-id="synthetic-svg-peer" data-conversation-type="direct"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" width="20" height="20"><div class="StackLayoutStackChatHeadertitle">合成SVG好友</div></div>
        <div id="messages"><div data-index="0"><div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">合成旧消息</div></div></div></div></div>
        <div data-e2e="msg-input"><div id="editor" contenteditable="true" data-slate-editor="true" data-placeholder="发送消息"><div class="ace-line"><span data-string="true" data-enter="true" data-leaf="true">​</span></div></div><${control} id="send-target" ${wrapper === 'role' ? 'role="button"' : ''}><svg class="e2e-send-msg-btn" viewBox="0 0 32 32"><path d="M2 2L30 16L2 30Z"/></svg>${duplicate ? '<svg class="e2e-send-msg-btn" viewBox="0 0 32 32"><path d="M2 2L30 16L2 30Z"/></svg>' : ''}</${control}></div>
      </div>
    </div>`);
  await page.evaluate(({ wrapper, appendReceipt }) => {
    window.syntheticClicks = 0; window.syntheticTrusted = 0;
    const control = document.getElementById('send-target');
    if (wrapper === 'react') Object.defineProperty(control, '__reactProps$syntheticSend', { value: { onClick: () => {} } });
    control.addEventListener('click', event => {
      window.syntheticClicks++; if (event.isTrusted) window.syntheticTrusted++;
      if (!appendReceipt) return;
      const editor = document.getElementById('editor'), row = document.createElement('div');
      row.dataset.index = String(document.querySelectorAll('[data-e2e="msg-item-content"]').length);
      const box = document.createElement('div'); box.className = 'messageMessageBoxmessageBox messageMessageBoxisFromMe';
      const content = document.createElement('div'); content.dataset.e2e = 'msg-item-content';
      const text = document.createElement('div'); text.className = 'MessageItemTextcontainer'; text.textContent = editor.innerText;
      content.append(text); box.append(content); row.append(box); document.getElementById('messages').append(row); editor.textContent = '';
    });
  }, { wrapper, appendReceipt });
  const controller = { withPage: async (callback, { signal } = {}) => { signal?.throwIfAborted(); return callback(page); }, close: async () => page.close() };
  const chat = new ChatBrowser({ controller }); chat.following = [{ displayName: '合成SVG好友', mutual: true }];
  const contact = (await chat.listContacts({ verifyFollowing: false })).contacts[0];
  await chat.readConversation(contact.id, { allowed: true });
  return { page, chat, contact };
}

async function assertClean(page) {
  assert.deepEqual(await page.evaluate(() => ({ entries: Object.keys(window.__deepseekChatInputs || {}).length, controls: document.querySelectorAll('[data-deepseek-send-token],[data-deepseek-send-marker]').length })), { entries: 0, controls: 0 });
}

test('SVG图标不接收指针时使用原生按钮承载一次可信点击并核对回执', async () => {
  const f = await fixture();
  try {
    const result = await f.chat.sendMessage(f.contact.id, '合成SVG回复', { allowed: true });
    assert.equal(result.confirmed, true, JSON.stringify(result)); assert.equal(result.deliveryUncertain, false);
    assert.deepEqual(await f.page.evaluate(() => [window.syntheticClicks, window.syntheticTrusted]), [1, 1]);
    await assertClean(f.page);
  } finally { await f.chat.close(); }
});

test('SVG图标支持role按钮及局部React点击承载元素，不调用处理函数伪造发送', async () => {
  for (const wrapper of ['role', 'react']) {
    const f = await fixture({ wrapper });
    try {
      const result = await f.chat.sendMessage(f.contact.id, '合成祖先回复', { allowed: true });
      assert.equal(result.confirmed, true, JSON.stringify(result));
      assert.deepEqual(await f.page.evaluate(() => [window.syntheticClicks, window.syntheticTrusted]), [1, 1]);
      await assertClean(f.page);
    } finally { await f.chat.close(); }
  }
});

test('SVG本身可命中时仍直接见证图标内的可信输入，其他区域同类图标不参与选择', async () => {
  const f = await fixture({ wrapper: 'plain', pointerEvents: 'auto' });
  try {
    await f.page.evaluate(() => { const decoy = document.createElement('div'); decoy.innerHTML = '<svg class="e2e-send-msg-btn" width="32" height="32"></svg>'; document.body.append(decoy); });
    const result = await f.chat.sendMessage(f.contact.id, '合成直接SVG回复', { allowed: true });
    assert.equal(result.confirmed, true, JSON.stringify(result)); assert.equal(await f.page.evaluate(() => window.syntheticClicks), 1);
    await assertClean(f.page);
  } finally { await f.chat.close(); }
});

test('未知SVG承载节点、过大祖先和编辑器容器均不被当成发送按钮', async () => {
  for (const mode of ['unknown', 'oversized', 'editor-root']) {
    const f = await fixture({ wrapper: mode === 'oversized' ? 'react' : 'plain' });
    try {
      await f.page.evaluate(mode => {
        if (mode === 'oversized') document.getElementById('send-target').style.width = '400px';
        if (mode === 'editor-root') Object.defineProperty(document.querySelector('[data-e2e="msg-input"]'), '__reactProps$syntheticBroad', { value: { onClick: () => {} } });
      }, mode);
      const result = await f.chat.sendMessage(f.contact.id, '合成不应发送', { allowed: true });
      assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.syntheticClicks), 0);
      assert.equal(await f.page.locator('#editor').innerText(), ''); await assertClean(f.page);
    } finally { await f.chat.close(); }
  }
});

test('读取局部点击承载证据不执行React属性getter', async () => {
  const f = await fixture({ wrapper: 'plain' });
  try {
    await f.page.evaluate(() => { window.syntheticGetterCalls = 0; const props = {}; Object.defineProperty(props, 'onClick', { get() { window.syntheticGetterCalls++; throw new Error('不可调用合成getter'); } }); Object.defineProperty(document.getElementById('send-target'), '__reactProps$getter', { value: props }); });
    const result = await f.chat.sendMessage(f.contact.id, '合成getter检查', { allowed: true });
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false);
    assert.deepEqual(await f.page.evaluate(() => [window.syntheticClicks, window.syntheticGetterCalls]), [0, 0]); await assertClean(f.page);
  } finally { await f.chat.close(); }
});

test('重复发送图标拒绝输入，不按父容器合并绕过唯一性', async () => {
  const f = await fixture({ duplicate: true });
  try {
    const result = await f.chat.sendMessage(f.contact.id, '合成重复图标检查', { allowed: true });
    assert.equal(result.confirmed, false); assert.equal(result.failureCode, 'CHAT_SEND_BUTTON_UNAVAILABLE'); assert.equal(result.deliveryUncertain, false);
    assert.equal(await f.page.evaluate(() => window.syntheticClicks), 0); await assertClean(f.page);
  } finally { await f.chat.close(); }
});

test('SVG父级被遮挡、禁用或图标隐藏时不点击且清理自有草稿', async () => {
  for (const mode of ['overlay', 'disabled', 'hidden']) {
    const f = await fixture();
    try {
      await f.page.evaluate(mode => {
        const button = document.getElementById('send-target');
        if (mode === 'disabled') button.disabled = true;
        if (mode === 'hidden') button.querySelector('svg').style.display = 'none';
        if (mode === 'overlay') { const r = button.getBoundingClientRect(), overlay = document.createElement('div'); overlay.style.cssText = `position:fixed;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;z-index:100;background:#888`; document.body.append(overlay); }
      }, mode);
      const result = await f.chat.sendMessage(f.contact.id, '合成不可点击检查', { allowed: true });
      assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.syntheticClicks), 0);
      assert.equal(await f.page.locator('#editor').innerText(), ''); await assertClean(f.page);
    } finally { await f.chat.close(); }
  }
});

test('填写回复时身份变化不会点击SVG父级', async () => {
  const f = await fixture();
  try {
    await f.page.locator('#editor').evaluate(editor => editor.addEventListener('input', () => document.querySelector('.StackLayoutStackChatHeaderuser').setAttribute('data-conversation-id', 'synthetic-other-peer'), { once: true }));
    const result = await f.chat.sendMessage(f.contact.id, '合成身份变化检查', { allowed: true });
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.syntheticClicks), 0);
    await assertClean(f.page);
  } finally { await f.chat.close(); }
});

test('最终许可阶段取消或替换SVG图标都不能产生迟发点击', async () => {
  for (const mode of ['cancel', 'replace']) {
    const f = await fixture(), abort = new AbortController();
    try {
      const authorize = async ({ phase }) => { if (phase === 'before-click') { if (mode === 'cancel') abort.abort(new Error('取消合成发送')); else await f.page.evaluate(() => { const icon = document.querySelector('.e2e-send-msg-btn'); icon.replaceWith(icon.cloneNode(true)); }); } return true; };
      authorize.beginDispatch = async () => () => {};
      const result = await f.chat.sendMessage(f.contact.id, '合成最终控制检查', { allowed: true, signal: abort.signal, authorize });
      assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.syntheticClicks), 0); await assertClean(f.page);
    } finally { await f.chat.close(); }
  }
});

test('用户原有草稿或最终阶段改写的草稿均保留', async () => {
  for (const initial of [true, false]) {
    const f = await fixture();
    try {
      if (initial) {
        await f.page.locator('#editor').fill('合成用户原有草稿');
        await assert.rejects(f.chat.sendMessage(f.contact.id, '合成自动草稿', { allowed: true }), /已有草稿/);
        assert.equal(await f.page.locator('#editor').innerText(), '合成用户原有草稿');
      } else {
        const authorize = async ({ phase }) => { if (phase === 'before-click') await f.page.locator('#editor').fill('合成用户改写草稿'); return true; }; authorize.beginDispatch = async () => () => {};
        const result = await f.chat.sendMessage(f.contact.id, '合成自动草稿', { allowed: true, authorize });
        assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.locator('#editor').innerText(), '合成用户改写草稿');
      }
      assert.equal(await f.page.evaluate(() => window.syntheticClicks), 0); await assertClean(f.page);
    } finally { await f.chat.close(); }
  }
});

test('可信SVG祖先点击后没有消息回执时保持不确定，整个调用只点击一次', async () => {
  const f = await fixture({ appendReceipt: false });
  try {
    const result = await f.chat.sendMessage(f.contact.id, '合成无回执检查', { allowed: true });
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true);
    assert.deepEqual(await f.page.evaluate(() => [window.syntheticClicks, window.syntheticTrusted]), [1, 1]); await assertClean(f.page);
  } finally { await f.chat.close(); }
});
