import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chromium } from '../playwright-runtime.mjs';
import { ChatBrowser, readConversationDom } from '../chat-browser.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
const conversationId = '8123456789012345678', sender = '11234567890', otherSender = '2123456789012345678';
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto('https://www.douyin.com/');
  await page.setContent('<div data-e2e="im-dialog"><div data-e2e="chat-page"><div data-e2e="group-chat-header" data-conversation-type="group" style="height:40px"><span data-e2e="chat-title">合成许可群</span><span data-e2e="group-avatar"></span></div><div data-e2e="message-list" style="display:flex;flex-direction:column-reverse"></div></div></div>');
  await page.evaluate(({ conversationId, sender, otherSender }) => {
    const header = document.querySelector('[data-e2e="group-chat-header"]');
    const conversation = Object.create(Object.assign(Object.create(null), { id: conversationId })); conversation.conversationType = 'group';
    Object.defineProperty(header, '__reactProps$memberFixtureHeader', { value: { children: [{ props: { conversation } }] } });
    const rows = [];
    for (let index = 0; index < 3; index++) {
      const wrapper = document.createElement('div'); wrapper.dataset.index = String(index);
      wrapper.innerHTML = '<div class="messageMessageBoxmessageBox" data-direction="incoming"><div data-e2e="msg-item-content"></div></div>';
      const row = wrapper.firstChild, node = row.firstChild;
      if (index === 1) node.innerHTML = '<div class="MessageItemShareAwemecontainer"><p class="MessageItemShareAwemeauthorName">合成视频作者，不能当群成员</p></div>';
      else { const name = document.createElement('div'); name.className = 'MessageBoxMessageTitleavatarName MessageBoxMessageTitleclickable'; name.textContent = index ? '合成另一成员' : '合成分享者'; row.prepend(name); node.innerHTML = '<div class="MessageItemTextcontainer">大肥鱼，看看上面的视频</div>'; }
      const prototype = Object.assign(Object.create(null), { conversationId, serverId: String(9123456789012345600n + BigInt(index)), sender: index === 2 ? otherSender : sender, createdAt: new Date() });
      const model = Object.create(prototype); model.isMyMessage = false; model._parsedContent = index === 1 ? { itemId: '7123456789012345678', author: { uid: otherSender }, userId: otherSender } : { text: '合成正文' };
      Object.defineProperty(node, '__reactProps$memberFixtureMessage', { value: { children: [{ props: { message: model } }] } });
      document.querySelector('[data-e2e="message-list"]').append(wrapper); rows.push({ row, node, prototype, model });
    }
    window.groupMemberFixture = rows; window.memberGetterReads = 0;
  }, { conversationId, sender, otherSender });
  const raw = () => page.evaluate(readConversationDom);
  const chat = new ChatBrowser({ controller: { withPage: async action => action(page), close: async () => {} } });
  return { page, raw, chat };
}

test('原生群成员：已绑定消息原型sender生成成员身份，连续隐藏头像的卡片仍属于分享者', async t => {
  const f = await fixture(t), raw = await f.raw(), rows = f.chat.publicMessages(`conv:${hash(raw.identityKey)}`, raw.messages);
  const work = rows.find(row => row.media?.type === 'shared-work'), ask = rows.find(row => row.memberName === '合成分享者'), other = rows.find(row => row.memberName === '合成另一成员');
  assert.ok(work?.memberId); assert.equal(work.memberId, ask.memberId); assert.notEqual(work.memberId, other.memberId); assert.equal(work.memberName, null); assert.notEqual(work.memberName, '合成视频作者，不能当群成员');
  assert.equal((await f.raw()).messages.find(row => row.media?.type === 'shared-work').member.nativeId, sender);
});

test('原生群成员：模型sender不读取作品author、uid或secSender作为替代', async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => { const value = window.groupMemberFixture[1]; delete value.prototype.sender; value.prototype.secSender = 'synthetic-sec-user'; value.model._parsedContent.sender = '999999999'; value.model._parsedContent.author.uid = '888888888'; });
  const work = (await f.raw()).messages.find(row => row.media?.type === 'shared-work'); assert.equal(work.member.nativeId, null); assert.equal(work.member.name, null);
});

test('原生群成员：getter、own与prototype冲突、深层原型和非法值都不取得成员身份', async t => {
  for (const kind of ['own-getter', 'proto-getter', 'conflict', 'deep', 'number', 'zero', 'whitespace', 'too-long']) {
    const f = await fixture(t);
    await f.page.evaluate(({ kind, sender }) => {
      const value = window.groupMemberFixture[1], get = () => { window.memberGetterReads++; return sender; };
      if (kind === 'own-getter') Object.defineProperty(value.model, 'sender', { get });
      if (kind === 'proto-getter') Object.defineProperty(value.prototype, 'sender', { get });
      if (kind === 'conflict') value.model.sender = '9999999999';
      if (kind === 'deep') { delete value.prototype.sender; Object.setPrototypeOf(value.prototype, { sender }); }
      if (kind === 'number') value.prototype.sender = Number(sender);
      if (kind === 'zero') value.prototype.sender = '0';
      if (kind === 'whitespace') value.prototype.sender = ' ' + sender;
      if (kind === 'too-long') value.prototype.sender = '1'.repeat(65);
    }, { kind, sender });
    const row = (await f.raw()).messages.find(row => row.media?.type === 'shared-work'); assert.equal(row.member.nativeId, null, kind); assert.equal(await f.page.evaluate(() => window.memberGetterReads), 0, kind);
  }
});

test('原生群成员：跨会话模型、无稳定消息ID和DOM消息ID不符时不借用sender', async t => {
  for (const kind of ['conversation', 'server-missing', 'server-getter', 'message-conflict']) {
    const f = await fixture(t);
    await f.page.evaluate(kind => { const value = window.groupMemberFixture[1]; if (kind === 'conversation') value.prototype.conversationId = '999999999999'; if (kind === 'server-missing') delete value.prototype.serverId; if (kind === 'server-getter') Object.defineProperty(value.prototype, 'serverId', { get() { window.memberGetterReads++; return '9999999999'; } }); if (kind === 'message-conflict') value.row.dataset.messageId = 'different-message'; }, kind);
    const row = (await f.raw()).messages.find(row => row.media?.type === 'shared-work'); assert.equal(row.member.nativeId, null, kind); assert.equal(await f.page.evaluate(() => window.memberGetterReads), 0, kind);
  }
});

test('原生群成员：DOM发送者与模型冲突时不选边，兼容没有原生模型的明确DOM身份', async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => { window.groupMemberFixture[1].row.dataset.senderId = 'different-member'; });
  let work = (await f.raw()).messages.find(row => row.media?.type === 'shared-work'); assert.equal(work.member.nativeId, null);
  await f.page.evaluate(() => { const value = window.groupMemberFixture[1]; delete value.prototype.sender; });
  work = (await f.raw()).messages.find(row => row.media?.type === 'shared-work'); assert.equal(work.member.nativeId, 'different-member');
});

test('原生群成员：同值own与prototype可兼容，姓名重名不合并身份', async t => {
  const f = await fixture(t);
  await f.page.evaluate(sender => { window.groupMemberFixture[1].model.sender = sender; document.querySelectorAll('.MessageBoxMessageTitleavatarName').forEach(node => node.textContent = '合成重名'); }, sender);
  const raw = await f.raw(), rows = f.chat.publicMessages(`conv:${hash(raw.identityKey)}`, raw.messages), named = rows.filter(row => row.memberName === '合成重名');
  assert.equal(named.length, 2); assert.notEqual(named[0].memberId, named[1].memberId); assert.equal(new Set(rows.map(row => row.memberId)).size, 2);
});
