import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../playwright-runtime.mjs';
import { ChatBrowser, MessageIdentityTracker, readContactDom, readConversationDom } from '../chat-browser.mjs';
import { messageFingerprint } from '../chat-message.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture() {
  const page = await browser.newPage();
  await page.setContent(`<div data-e2e="im-dialog">
    <div data-e2e="conversation-item" data-conversation-id="test-a"><img src="https://fixture.local/avatar-a.png"><div class="conversationConversationItemtitle">测试甲</div><div class="unread-count">1</div><pre id="private-preview">不应读取的其他预览</pre></div>
    <div data-e2e="conversation-item" data-conversation-id="test-b"><img src="https://fixture.local/avatar-b.png"><div class="conversationConversationItemtitle">测试乙</div></div>
    <div class="StackLayoutpagespageRoot" data-e2e="chat-page"><div class="StackLayoutStackChatHeaderuser"><img src="https://fixture.local/avatar-a.png"><div class="StackLayoutStackChatHeadertitle">测试甲</div></div>
      <div id="message-list"><div class="MessageBoxTimetimeLayout">2026-10-14 12:00</div><div data-index="0"><div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">合成消息</div></div></div></div></div>
      <div data-e2e="msg-input"><div contenteditable="true" style="min-width:80px;min-height:30px"></div><button class="e2e-send-msg-btn">发送</button></div>
    </div></div>`);
  await page.evaluate(() => {
    window.sent = 0; window.previewReads = 0;
    Object.defineProperty(document.getElementById('private-preview'), 'textContent', { get() { window.previewReads += 1; throw new Error('禁止读取预览'); } });
    for (const row of document.querySelectorAll('[data-e2e="conversation-item"]')) row.addEventListener('click', () => {
      document.querySelector('.StackLayoutStackChatHeadertitle').textContent = row.querySelector('.conversationConversationItemtitle').textContent;
      document.querySelector('.StackLayoutStackChatHeaderuser img').src = row.querySelector('img').src;
    });
    document.querySelector('.e2e-send-msg-btn').addEventListener('click', () => {
      window.sent += 1;
      const text = document.querySelector('[contenteditable]').innerText;
      const row = document.createElement('div'); row.setAttribute('data-index', String(document.querySelectorAll('[data-e2e="msg-item-content"]').length));
      const box = document.createElement('div'); box.className = 'messageMessageBoxmessageBox messageMessageBoxisFromMe';
      const content = document.createElement('div'); content.setAttribute('data-e2e', 'msg-item-content');
      const body = document.createElement('div'); body.className = 'MessageItemTextcontainer'; body.textContent = text;
      content.append(body); box.append(content); row.append(box); document.getElementById('message-list').append(row);
      document.querySelector('[contenteditable]').textContent = '';
    });
  });
  const controller = { withPage: async (callback, { signal } = {}) => { signal?.throwIfAborted(); return callback(page); }, close: async () => page.close() };
  const chat = new ChatBrowser({ controller });
  chat.following = [{ displayName: '测试甲', mutual: true }, { displayName: '测试乙', mutual: true }];
  return { page, chat };
}

test('会话列表不读取预览，昵称、关系和不透明 ID 正确', async () => {
  const { page, chat } = await fixture();
  try {
    const list = await chat.listContacts();
    assert.equal(list.contacts.length, 2);
    assert.equal(list.contacts[0].followed, true);
    assert.equal(list.contacts[0].isGroup, false);
    assert.match(list.contacts[0].id, /^conv:[a-f0-9]{64}$/);
    assert.equal(list.contacts[0].lastMessagePreview, undefined);
    assert.equal(JSON.stringify(list).includes('test-a'), false);
    assert.equal(await page.evaluate(() => window.previewReads), 0);
    assert.equal((await page.evaluate(readContactDom)).length, 2);
  } finally { await chat.close(); }
});

test('未授权读取或发送都不进入页面，不向合成联系人发送', async () => {
  const { page, chat } = await fixture();
  try {
    await assert.rejects(chat.readConversation('conv:' + 'a'.repeat(64)), /明确授权/);
    await assert.rejects(chat.sendMessage('conv:' + 'a'.repeat(64), '测试'), /明确授权/);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('精确会话选择后回读身份及消息，只读指定联系人', async () => {
  const { chat } = await fixture();
  try {
    const list = await chat.listContacts();
    const selected = await chat.readConversation(list.contacts[1].id, { allowed: true });
    assert.equal(selected.conversation.id, list.contacts[1].id);
    assert.equal(selected.contact.name, '测试乙');
    assert.equal(selected.messages[0].sender, 'incoming');
    assert.equal(selected.messages[0].text, '合成消息');
    assert.equal(selected.messages[0].eligibleForReply, false);
    assert.equal(selected.messages[0].sentAt, '2026-10-14 12:00');
    assert.equal(selected.messages[0].dateEvidence.kind, 'absolute');
    assert.equal(selected.dayEvidence.latestEndVerified, false);
  } finally { await chat.close(); }
});

test('同名同头像会话有歧义时拒绝操作', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => { const row = document.querySelector('[data-e2e="conversation-item"]'); row.removeAttribute('data-conversation-id'); row.after(row.cloneNode(true)); });
    await assert.rejects(chat.listContacts(), /歧义/);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('发送按钮点击和发出消息回读仅在合成页面验证', async () => {
  const { page, chat } = await fixture();
  try {
    const { contacts } = await chat.listContacts();
    const result = await chat.sendMessage(contacts[1].id, '合成回复', { allowed: true });
    assert.equal(result.confirmed, true);
    assert.equal(result.contact.id, contacts[1].id);
    assert.equal(result.deliveryUncertain, false);
    assert.match(result.messageId, /^msg:/);
    assert.equal(await page.evaluate(() => window.sent), 1);
  } finally { await chat.close(); }
});

test('等待按钮稳定期间撤回主动问候许可，不会迟发或调用最终输入许可', async () => {
  const { page, chat } = await fixture(); let enabled = true, began = 0, prepared = false;
  try {
    const { contacts } = await chat.listContacts();
    const authorize = async ({ phase }) => {
      if (phase === 'monitor' && !prepared) { prepared = true; await page.evaluate(() => document.querySelector('.e2e-send-msg-btn').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 900 })); setTimeout(() => { enabled = false; }, 80); }
      return enabled;
    };
    authorize.beginDispatch = () => { began++; return () => {}; };
    const result = await chat.sendMessage(contacts[0].id, '合成问候', { allowed: true, authorize });
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(began, 0);
    await page.waitForTimeout(300); assert.equal(await page.evaluate(() => window.sent), 0); assert.equal(await page.locator('[contenteditable]').innerText(), '');
  } finally { await chat.close(); }
});

test('可信最终输入许可覆盖唯一真实点击，撤回或释放后不会再次点击', async () => {
  const { page, chat } = await fixture(); let enabled = true, held = false, began = 0, released = 0, finalClicks = 0, finalClickSettled = false, releaseCheck;
  const locatorPrototype = Object.getPrototypeOf(page.locator('.e2e-send-msg-btn')), originalClick = locatorPrototype.click;
  try {
    const { contacts } = await chat.listContacts();
    await page.evaluate(() => {
      window.fixtureLease = { held: false, trace: [] };
      document.querySelector('.e2e-send-msg-btn').addEventListener('click', event => {
        const lease = window.fixtureLease;
        lease.trace.push({ phase: 'click', trusted: event.isTrusted, held: lease.held });
      });
    });
    // 同步记录最终点击 Promise 的完成顺序，不插入浏览器等待或更改产品点击参数。
    locatorPrototype.click = async function(options) {
      if (options?.timeout !== 350 || options?.noWaitAfter !== true || options?.trial) return originalClick.apply(this, arguments);
      assert.equal(held, true); assert.equal(released, 0); finalClicks++;
      const result = await originalClick.apply(this, arguments);
      assert.equal(held, true); finalClickSettled = true;
      return result;
    };
    const authorize = () => enabled;
    authorize.beginDispatch = async () => {
      assert.equal(held, false); assert.equal(released, 0); began++; held = true;
      await page.evaluate(() => { const lease = window.fixtureLease; lease.held = true; lease.trace.push({ phase: 'acquired' }); });
      return () => {
        assert.equal(held, true); assert.equal(finalClickSettled, true); assert.equal(released, 0);
        held = false; released++;
        releaseCheck = page.evaluate(() => { const lease = window.fixtureLease; lease.held = false; lease.trace.push({ phase: 'released' }); return lease.trace; });
      };
    };
    const result = await chat.sendMessage(contacts[0].id, '合成问候', { allowed: true, authorize });
    assert.equal(result.confirmed, true); assert.equal(began, 1); assert.equal(finalClicks, 1); assert.equal(released, 1); assert.equal(held, false);
    assert.deepEqual(await releaseCheck, [{ phase: 'acquired' }, { phase: 'click', trusted: true, held: true }, { phase: 'released' }]);
    assert.equal(await page.evaluate(() => window.sent), 1);
    enabled = false;
    await assert.rejects(chat.sendMessage(contacts[0].id, '撤回后不得发送', { allowed: true, authorize }), /许可已撤回/);
    const abort = new AbortController(); abort.abort(new Error('合成取消后不得迟发'));
    await assert.rejects(chat.sendMessage(contacts[0].id, '取消后不得发送', { allowed: true, authorize, signal: abort.signal }), /合成取消/);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.sent), 1); assert.equal((await page.evaluate(() => window.fixtureLease.trace)).filter(item => item.phase === 'click').length, 1);
    assert.equal(began, 1); assert.equal(finalClicks, 1); assert.equal(released, 1);
  } finally { locatorPrototype.click = originalClick; await releaseCheck?.catch(() => {}); await chat.close(); }
});

test('等待按钮稳定期间会话身份变化，不向变化后的好友发送', async () => {
  const { page, chat } = await fixture(); let prepared = false;
  try {
    const { contacts } = await chat.listContacts();
    const authorize = async ({ phase }) => { if (phase === 'monitor' && !prepared) { prepared = true; await page.evaluate(() => { document.querySelector('.e2e-send-msg-btn').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 900 }); setTimeout(() => { document.querySelector('.StackLayoutStackChatHeadertitle').textContent = '合成其他好友'; }, 80); }); } return true; };
    authorize.beginDispatch = () => () => {};
    const result = await chat.sendMessage(contacts[0].id, '不应发送', { allowed: true, authorize });
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('旧自动回复没有主动许可钩子时，取消信号仍阻止等待后的迟发', async () => {
  const { page, chat } = await fixture(); const abort = new AbortController();
  try {
    const { contacts } = await chat.listContacts();
    await page.exposeFunction('fixtureAbortSend', () => abort.abort(new Error('合成停止回复')));
    await page.evaluate(() => document.querySelector('[contenteditable]').addEventListener('input', () => {
      document.querySelector('.e2e-send-msg-btn').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 900 }); setTimeout(() => window.fixtureAbortSend(), 80);
    }, { once: true }));
    const result = await chat.sendMessage(contacts[0].id, '旧回复停止测试', { allowed: true, signal: abort.signal });
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); await page.waitForTimeout(300); assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('已有草稿或发送按钮不唯一时不点击发送', async () => {
  const { page, chat } = await fixture();
  try {
    const { contacts } = await chat.listContacts();
    await page.locator('[contenteditable]').fill('用户草稿');
    await assert.rejects(chat.sendMessage(contacts[0].id, '合成回复', { allowed: true }), /已有草稿/);
    assert.equal(await page.locator('[contenteditable]').innerText(), '用户草稿');
    await page.locator('[contenteditable]').fill('');
    await page.evaluate(() => document.querySelector('.e2e-send-msg-btn').after(document.querySelector('.e2e-send-msg-btn').cloneNode(true)));
    const result = await chat.sendMessage(contacts[0].id, '合成回复', { allowed: true });
    assert.equal(result.confirmed, false);
    assert.equal(result.deliveryUncertain, false);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('预期私信水位或填写期间消息变化时不点击发送', async () => {
  const { page, chat } = await fixture();
  try {
    const { contacts } = await chat.listContacts();
    const before = await chat.readConversation(contacts[0].id, { allowed: true });
    const wrong = await chat.sendMessage(contacts[0].id, '合成回复', { allowed: true, expectedMessageIds: ['msg:其他水位'] });
    assert.equal(wrong.confirmed, false);
    assert.equal(wrong.deliveryUncertain, false);
    await page.evaluate(() => document.querySelector('[contenteditable]').addEventListener('input', () => {
      const newRow = document.createElement('div'); newRow.setAttribute('data-index', '1');
      newRow.innerHTML = '<div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">填写期间的新消息</div></div></div>';
      document.getElementById('message-list').append(newRow);
    }, { once: true }));
    const changed = await chat.sendMessage(contacts[0].id, '合成回复', { allowed: true, expectedMessageIds: before.messages.map(item => item.id) });
    assert.equal(changed.confirmed, false);
    assert.equal(changed.deliveryUncertain, false);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('填写期间用户改写草稿，取消发送时保留用户内容',async()=>{
  const {page,chat}=await fixture();
  try{
    const {contacts}=await chat.listContacts();
    const before=await chat.readConversation(contacts[0].id,{allowed:true});
    await page.evaluate(()=>document.querySelector('[contenteditable]').addEventListener('input',event=>{event.target.textContent='用户刚输入的草稿';},{once:true}));
    const result=await chat.sendMessage(contacts[0].id,'合成回复',{allowed:true,expectedMessageIds:before.messages.map(item=>item.id)});
    assert.equal(result.confirmed,false);assert.equal(await page.evaluate(()=>window.sent),0);
    assert.equal(await page.locator('[contenteditable]').innerText(),'用户刚输入的草稿');
  }finally{await chat.close();}
});

const row = (order, text, timestamp = '2026-10-14 12:00') => ({ nativeId: null, direction: 'incoming', kind: 'text', text, timestamp, order });
test('同日重复短句用真实序号区分，滑动窗口保留旧 ID', () => {
  const tracker = new MessageIdentityTracker();
  const first = tracker.identify('测试会话', [row(0, '你好'), row(1, '你好')]);
  assert.notEqual(first[0].id, first[1].id);
  const shifted = tracker.identify('测试会话', [row(1, '你好'), row(2, '你好')]);
  assert.equal(shifted[0].id, first[1].id);
  assert.equal(shifted[0].eligibleForReply, false);
  assert.equal(shifted[1].eligibleForReply, true);
  const again = tracker.identify('测试会话', [row(1, '你好'), row(2, '你好')]);
  assert.deepEqual(again.map(item => item.id), shifted.map(item => item.id));
});

test('前插旧历史、时间标签变化和无重叠窗口不认作新私信', () => {
  const tracker = new MessageIdentityTracker();
  const first = tracker.identify('测试会话', [row(0, '甲'), row(1, '乙')]);
  const prepended = tracker.identify('测试会话', [row(0, '旧'), row(1, '甲'), row(2, '乙')]);
  assert.equal(prepended[0].eligibleForReply, false);
  assert.equal(prepended[1].id, first[0].id);
  assert.equal(prepended[2].id, first[1].id);
  const changed = tracker.identify('测试会话', [row(1, '甲', '昨天'), row(2, '乙', '昨天')]);
  assert.equal(changed.some(item => item.eligibleForReply), false);
  const unrelated = tracker.identify('测试会话', [row(10, '旧窗口'), row(11, '旧窗口')]);
  assert.equal(unrelated.some(item => item.eligibleForReply), false);
});

test('非文字和无法核实序号的消息保留 ID 但不纳入自动回复', () => {
  const tracker = new MessageIdentityTracker();
  const images = tracker.identify('测试会话', [{ ...row(0, ''), kind: 'video' }, { ...row(1, ''), kind: 'emoji' }]);
  assert.equal(images.every(item => item.unsupported), true);
  const unknown = tracker.identify('无序号会话', [row(null, '短句'), row(null, '短句')]);
  assert.notEqual(unknown[0].id, unknown[1].id);
  assert.equal(unknown.every(item => !item.eligibleForReply), true);
});

test('网页重复消息身份会停止自动回复', () => {
  const tracker = new MessageIdentityTracker();
  assert.throws(() => tracker.identify('重复序号会话', [row(0, '你好'), row(0, '你好')]), /身份重复/);
});

test('相对时间逐分钟变化不产生新消息身份或回复资格', () => {
  const tracker = new MessageIdentityTracker();
  const before = tracker.identify('相对时间会话', [row(0, '既有消息', '48分钟前'), row(1, '既有消息', '48分钟前')]);
  const after = tracker.identify('相对时间会话', [row(0, '既有消息', '49分钟前'), row(1, '既有消息', '49分钟前')]);
  assert.deepEqual(after.map(item => item.id), before.map(item => item.id));
  assert.equal(after.every(item => item.arrivalClassification === 'known-old-window'), true);
  assert.equal(after.every(item => !item.eligibleForReply), true);
  assert.equal(after[0].timestamp, '49分钟前');
});

test('补载旧历史只标为旧历史，回到已知窗口不重复认作新到达', () => {
  const tracker = new MessageIdentityTracker();
  const first = tracker.identify('历史窗口会话', [row(4, '甲'), row(5, '乙')]);
  const earlier = tracker.identify('历史窗口会话', [row(0, '早期消息'), row(1, '另一个早期消息')]);
  assert.equal(earlier.every(item => item.arrivalClassification === 'old-history'), true);
  const returned = tracker.identify('历史窗口会话', [row(4, '甲', '昨日'), row(5, '乙', '昨日')]);
  assert.deepEqual(returned.map(item => item.id), first.map(item => item.id));
  assert.equal(returned.every(item => item.arrivalClassification === 'known-old-window'), true);
  const newest = tracker.identify('历史窗口会话', [row(5, '乙'), row(6, '乙')]);
  assert.equal(newest[1].arrivalClassification, 'new-tail');
  assert.equal(newest[1].eligibleForReply, true);
});

test('无重叠且高于已知水位的陌生窗口仍需核对', () => {
  const tracker = new MessageIdentityTracker();
  tracker.identify('陌生窗口会话', [row(0, '基线')]);
  const uncertain = tracker.identify('陌生窗口会话', [row(20, '可能新消息')]);
  assert.equal(uncertain[0].arrivalClassification, 'ambiguous-new');
  assert.equal(uncertain[0].eligibleForReply, false);
});

test('前插旧历史使重复短句序号移动时不重新回复', () => {
  const tracker = new MessageIdentityTracker();
  const before = tracker.identify('重复历史会话', [row(0, '你好'), row(1, '你好')]);
  const after = tracker.identify('重复历史会话', [row(0, '早期记录'), row(1, '你好'), row(2, '你好')]);
  assert.deepEqual(after.slice(1).map(item => item.id), before.map(item => item.id));
  assert.equal(after.every(item => !item.eligibleForReply), true);
  assert.equal(after[0].arrivalClassification, 'old-history');
});

test('表情提取标签和本机资源引用，不把图片临时 URL 放进返回值', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => {
      document.querySelector('[data-e2e="msg-item-content"]').innerHTML = '<div class="MessageItemEmojiemojiBox"><img alt="[赞]" src="https://fixture.local/private-emoji.png?temporary_secret=test" style="width:64px;height:64px"></div>';
    });
    const { contacts } = await chat.listContacts();
    const result = await chat.readConversation(contacts[0].id, { allowed: true });
    const message = result.messages[0];
    assert.equal(message.kind, 'emoji');
    assert.equal(message.media.label, '[赞]');
    assert.equal(message.media.imageCount, 1);
    assert.match(message.media.resources[0].resourceRef, /^media:[a-f0-9]{64}$/);
    assert.equal(message.unsupported, false);
    assert.equal(JSON.stringify(result).includes('temporary_secret'), false);
    assert.equal(JSON.stringify(result).includes('private-emoji.png'), false);
  } finally { await chat.close(); }
});

test('单消息截图只取精确表情区域，缺少标签时保持未知', async () => {
  const { page, chat } = await fixture();
  try {
    const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="blue"/></svg>');
    await page.evaluate(src => {
      const box = document.querySelector('[data-e2e="msg-item-content"]');
      const media = document.createElement('div'); media.className = 'MessageItemEmojiemojiBox';
      const img = document.createElement('img'); img.src = src; img.width = 64; img.height = 64;
      media.append(img); box.replaceChildren(media);
    }, image);
    const { contacts } = await chat.listContacts();
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    assert.equal(read.messages[0].media.label, null);
    await assert.rejects(chat.captureMessage(contacts[0].id, read.messages[0].id), /明确授权/);
    const captured = await chat.captureMessage(contacts[0].id, read.messages[0].id, { allowed: true });
    assert.equal(captured.frames.length, 1);
    assert.equal(captured.frames[0].mimeType, 'image/jpeg');
    assert.equal(Buffer.from(captured.frames[0].data, 'base64').length > 100, true);
    assert.equal(captured.understandingScope, 'single-message-image');
    assert.equal(captured.messageId, read.messages[0].id);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('分享作品仅从真实 DOM 链接取得公开作品 ID，未知时不猜', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => {
      document.querySelector('[data-e2e="msg-item-content"]').innerHTML = '<div class="MessageItemShareAwemecontainer"><img class="MessageItemShareAwemeawemeContainer" src="https://fixture.local/private-cover.jpg?secret=test"><p class="MessageItemShareAwemeauthorName">合成作者</p><div data-e2e="shared-video-title">合成作品</div><a href="https://www.douyin.com/video/12345?temporary_secret=test">打开</a></div>';
    });
    const { contacts } = await chat.listContacts();
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    const message = read.messages[0];
    assert.equal(message.media.type, 'shared-work');
    assert.equal(message.media.videoId, '12345');
    assert.equal(message.media.url, 'https://www.douyin.com/video/12345');
    assert.equal(message.media.title, '合成作品');
    assert.equal(message.media.author, '合成作者');
    assert.equal(message.media.safeOpenSelector.includes(message.id), true);
    assert.equal(JSON.stringify(read).includes('temporary_secret'), false);
    assert.equal(JSON.stringify(read).includes('private-cover.jpg'), false);
    const resolved = await chat.openSharedVideo(contacts[0].id, message.id, { allowed: true });
    assert.equal(resolved.source, 'dom-link');
    assert.equal(resolved.opened, false);
    await page.evaluate(() => document.querySelector('.MessageItemShareAwemecontainer a').remove());
    const withoutLink = await chat.readConversation(contacts[0].id, { allowed: true });
    assert.equal(withoutLink.messages[0].media.videoId, null);
    assert.equal(withoutLink.messages[0].media.url, null);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('只有空白或零宽占位符视为空草稿，真实文字和图片草稿保留', async () => {
  const { page, chat } = await fixture();
  try {
    const { contacts } = await chat.listContacts();
    await page.evaluate(() => document.querySelector('[contenteditable]').textContent = '\u200B\u2060 ');
    const sent = await chat.sendMessage(contacts[0].id, '合成回复', { allowed: true });
    assert.equal(sent.confirmed, true);
    assert.equal(await page.evaluate(() => window.sent), 1);
    await page.evaluate(() => document.querySelector('[contenteditable]').textContent = '\u200B用户草稿');
    await assert.rejects(chat.sendMessage(contacts[0].id, '另一条合成回复', { allowed: true }), /已有草稿/);
    assert.equal(await page.locator('[contenteditable]').innerText(), '\u200B用户草稿');
    await page.evaluate(() => document.querySelector('[contenteditable]').innerHTML = '<img src="https://fixture.local/draft.png">');
    await assert.rejects(chat.sendMessage(contacts[0].id, '另一条合成回复', { allowed: true }), /已有草稿/);
    assert.equal(await page.locator('[contenteditable] img').count(), 1);
    assert.equal(await page.evaluate(() => window.sent), 1);
  } finally { await chat.close(); }
});

test('相同原生消息 ID 的表情资源变化，进入发送前与填写后都拒绝回复', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => {
      const content = document.querySelector('[data-e2e="msg-item-content"]');
      content.setAttribute('data-message-id', 'fixture-native-stable');
      content.innerHTML = '<div class="MessageItemEmojiemojiBox"><img src="https://fixture.local/emoji-a.png" alt="合成表情甲"></div>';
    });
    const { contacts } = await chat.listContacts();
    const first = await chat.readConversation(contacts[0].id, { allowed: true });
    const expected = first.messages.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
    await page.evaluate(() => document.querySelector('.MessageItemEmojiemojiBox').innerHTML = '<img src="https://fixture.local/emoji-b.png" alt="合成表情乙">');
    const changedBefore = await chat.sendMessage(contacts[0].id, '合成回复', { allowed: true, expectedMessageIds: first.messages.map(item => item.id), expectedMessageContent: expected });
    assert.equal(changedBefore.confirmed, false);
    assert.equal(await page.locator('[contenteditable]').innerText(), '');
    const current = await chat.readConversation(contacts[0].id, { allowed: true });
    assert.equal(current.messages[0].id, first.messages[0].id);
    await page.evaluate(() => document.querySelector('[contenteditable]').addEventListener('input', () => document.querySelector('.MessageItemEmojiemojiBox').innerHTML = '<img src="https://fixture.local/emoji-c.png" alt="合成表情丙">', { once: true }));
    const changedDuring = await chat.sendMessage(contacts[0].id, '合成回复', { allowed: true });
    assert.equal(changedDuring.confirmed, false);
    assert.equal(changedDuring.deliveryUncertain, false);
    assert.equal(await page.locator('[contenteditable]').innerText(), '');
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('聊天页面暂停背景视频，播放捕获监听只注册一次', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => { const video = document.createElement('video'); video.id = 'fixture-video'; window.pauseCount = 0; video.pause = () => { window.pauseCount += 1; }; document.body.append(video); });
    await chat.listContacts(); await chat.listContacts();
    const before = await page.evaluate(() => window.pauseCount);
    await page.evaluate(() => document.querySelector('#fixture-video').dispatchEvent(new Event('play')));
    assert.equal(await page.evaluate(() => window.pauseCount), before + 1);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('解析没有公开链接的分享卡片，点击前紧邻检查时间限制', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => { document.querySelector('[data-e2e="msg-item-content"]').innerHTML = '<div class="MessageItemShareAwemecontainer" style="width:80px;height:40px">合成卡片</div>'; window.cardClicks = 0; document.querySelector('.MessageItemShareAwemecontainer').addEventListener('click', () => window.cardClicks += 1); });
    chat.controller.source = 'dsh-chat';
    chat.controller.limits = () => ({ beforeAction: (source, name) => { assert.equal(source, 'dsh'); assert.equal(name, 'douyin_open_video'); return { allowed: false, reason: '合成时间到点' }; } });
    const { contacts } = await chat.listContacts();
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    await assert.rejects(chat.openSharedVideo(contacts[0].id, read.messages[0].id, { allowed: true }), /时间到点/);
    assert.equal(await page.evaluate(() => window.cardClicks), 0);
  } finally { await chat.close(); }
});

test('无链接卡片点击没有导航或新窗口，原详情 URL 不能充当作品回读', async () => {
  const { page, chat } = await fixture();
  try {
    const markup = await page.content();
    await page.route('https://www.douyin.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('https://www.douyin.com/video/12345'); await page.setContent(markup);
    await page.evaluate(() => { document.querySelector('[data-e2e="msg-item-content"]').innerHTML = '<div class="MessageItemShareAwemecontainer" style="width:80px;height:40px">合成卡片</div>'; window.cardClicks = 0; document.querySelector('.MessageItemShareAwemecontainer').addEventListener('click', () => window.cardClicks += 1); });
    chat.controller.source = 'api-chat'; chat.controller.limits = () => ({ beforeAction: () => ({ allowed: true }) });
    const { contacts } = await chat.listContacts();
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    const resolved = await chat.openSharedVideo(contacts[0].id, read.messages[0].id, { allowed: true });
    assert.equal(resolved.opened, true); assert.equal(resolved.videoId, null); assert.equal(resolved.url, null);
    assert.match(resolved.reason, /未采用原详情页/);
    assert.equal(await page.evaluate(() => window.cardClicks), 1);
  } finally { await chat.close(); }
});

test('同作品 ID 在点击后新开窗口可回读，解析窗口暂停后关闭', async () => {
  const { page, chat } = await fixture();
  try {
    const markup = await page.content(); let pauseCount = 0;
    await page.context().route('https://www.douyin.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body><video id="fixture-video"></video><script>document.querySelector("video").pause=()=>console.log("fixture-paused")</script></body>' }));
    await page.goto('https://www.douyin.com/video/12345'); await page.setContent(markup);
    await page.evaluate(() => { document.querySelector('[data-e2e="msg-item-content"]').innerHTML = '<div class="MessageItemShareAwemecontainer" style="width:80px;height:40px">合成卡片</div>'; document.querySelector('.MessageItemShareAwemecontainer').addEventListener('click', () => window.open('https://www.douyin.com/video/12345')); });
    page.on('popup', popup => popup.on('console', message => { if (message.text() === 'fixture-paused') pauseCount += 1; }));
    chat.controller.source = 'api-chat'; chat.controller.limits = () => ({ beforeAction: () => ({ allowed: true }) });
    const { contacts } = await chat.listContacts();
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    const resolved = await chat.openSharedVideo(contacts[0].id, read.messages[0].id, { allowed: true });
    assert.equal(resolved.opened, true); assert.equal(resolved.videoId, '12345'); assert.equal(resolved.source, 'actual-opened-page-url');
    assert.equal(pauseCount, 1); assert.equal(page.context().pages().length, 1);
  } finally { await chat.close(); }
});

test('真实抖音纵向翻转列表逆序为旧到新，标记仍绑定原 DOM 消息', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => {
      const list = document.querySelector('#message-list'); list.className = 'messageMessageListlist'; list.style.transform = 'scale(-1,-1)';
      list.innerHTML = '<div data-index="0" style="transform:scale(-1,-1)"><div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">最新合成消息</div></div></div></div>'
        + '<div data-index="1" style="transform:scale(-1,-1)"><div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content"><div class="MessageItemEmojiemojiBox"><img width="64" height="64" alt="合成表情" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2264%22 height=%2264%22%3E%3Crect width=%2264%22 height=%2264%22 fill=%22red%22/%3E%3C/svg%3E"></div></div></div></div>'
        + '<div data-index="2" style="transform:scale(-1,-1)"><div class="MessageBoxTimetimeLayout">30分钟前</div><div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">较旧合成消息</div></div></div></div>';
    });
    const { contacts } = await chat.listContacts();
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    assert.deepEqual(read.messages.map(item => item.domIndex), [2, 1, 0]);
    assert.deepEqual(read.messages.map(item => item.order), [0, 1, 2]);
    assert.equal(read.messages.every(item => item.orderMode === 'relative'), true);
    assert.equal(read.messages.every(item => item.latestEndVerified === true), true);
    assert.equal(read.messages[0].text, '较旧合成消息'); assert.equal(read.messages[2].text, '最新合成消息');
    await chat.markMessages(page, read.messages);
    assert.equal(await page.locator('[data-index="0"] [data-e2e="msg-item-content"]').getAttribute('data-deepseek-message-id'), read.messages[2].id);
    assert.equal(await page.locator('[data-index="2"] [data-e2e="msg-item-content"]').getAttribute('data-deepseek-message-id'), read.messages[0].id);
    const captured = await chat.captureMessage(contacts[0].id, read.messages[1].id, { allowed: true });
    assert.equal(captured.frames.length, 1); assert.equal(captured.media.type, 'emoji');
    await page.evaluate(() => document.querySelector('[data-index="0"]').remove());
    const olderWindow = await chat.readConversation(contacts[0].id, { allowed: true });
    assert.equal(olderWindow.messages.every(item => item.orderMode === 'relative' && item.latestEndVerified === false), true);
    assert.equal(olderWindow.messages.some(item => item.eligibleForReply), false);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('消息列表拓扑未知时不把相对位置当永久水位，不授予新回复资格', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => document.querySelector('#message-list').className = 'messageMessageListlist');
    const { contacts } = await chat.listContacts();
    await chat.readConversation(contacts[0].id, { allowed: true });
    await page.evaluate(() => {
      const row = document.createElement('div'); row.setAttribute('data-index', '1');
      row.innerHTML = '<div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content" data-message-id="fixture-new-native"><div class="MessageItemTextcontainer">另一合成消息</div></div></div>';
      document.querySelector('#message-list').append(row);
    });
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    assert.equal(read.messages.every(item => item.orderMode === 'relative' && item.latestEndVerified === false), true);
    assert.equal(read.messages.some(item => item.eligibleForReply), false);
    const raw = await page.evaluate(readConversationDom);
    assert.equal(raw.chronology, 'unknown'); assert.equal(raw.sourceDomOrder, 'unknown');
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});
