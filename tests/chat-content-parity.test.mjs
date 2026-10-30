import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '../playwright-runtime.mjs';
import { ChatBrowser, readConversationDom } from '../chat-browser.mjs';
import { ChatAgent, normalizeChatReplyText } from '../chat-agent.mjs';
import { ChatService } from '../chat-service.mjs';
import { chatMessageSummary, isReplyableMessage, messageFingerprint } from '../chat-message.mjs';
import { groupMessageAddressesFish } from '../group-reply-trigger.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
async function dom(t, html, group = false) {
  const page = await browser.newPage(); t.after(() => page.close());
  await page.setContent(`<div data-e2e="im-dialog"><div data-e2e="conversation-item" data-conversation-id="synthetic-chat" data-conversation-type="${group ? 'group' : 'direct'}"><div class="conversationConversationItemtitle">合成会话</div></div><div data-e2e="chat-page"><div data-e2e="chat-header" data-conversation-id="synthetic-chat" data-conversation-type="${group ? 'group' : 'direct'}"><div data-e2e="chat-title">合成会话</div></div><div data-index="0"><div data-e2e="message-row" data-direction="incoming" data-message-id="synthetic-message"><div data-e2e="message-content">${html}</div></div></div></div></div>`);
  const chat = new ChatBrowser({ controller: { withPage: async fn => fn(page), close: async () => {} } });
  return { page, chat, read: () => page.evaluate(readConversationDom) };
}

test('识别可见附件类别，只返回卡片资料，不访问链接或文件', async t => {
  const f = await dom(t, ''); let requests = 0;
  await f.page.route('https://forbidden.invalid/**', route => { requests++; return route.abort(); });
  for (const type of ['file','location','user-card','live','music','call','gift','video','link']) {
    await f.page.locator('[data-e2e="message-content"]').evaluate((node, type) => { node.innerHTML = `<div data-e2e="message-${type}">合成标题<a href="https://forbidden.invalid/private?secret=PRIVATE_QUERY">合成链接</a></div>`; }, type);
    const message = (await f.read()).messages[0];
    assert.equal(message.media.type, type === 'video' ? 'video-attachment' : type);
    assert.equal(message.media.contentStatus, 'not-opened');
    assert.equal(message.media.understandingScope, 'visible-message-metadata-only');
    assert.equal(isReplyableMessage(message), true);
    assert.doesNotMatch(JSON.stringify(chatMessageSummary(message)), /PRIVATE_QUERY|\/private/);
  }
  assert.equal(requests, 0);
});

test('未知附件有明确占位，撤回和系统消息不触发回复', async t => {
  const f = await dom(t, '<div data-e2e="message-placeholder">合成新附件</div>');
  let message = (await f.read()).messages[0];
  assert.equal(message.media.type, 'unknown'); assert.equal(isReplyableMessage(message), true);
  for (const type of ['recalled', 'system']) {
    await f.page.locator('[data-e2e="message-content"]').evaluate((node, type) => { node.innerHTML = `<div data-e2e="message-${type}">合成通知</div>`; }, type);
    message = (await f.read()).messages[0]; assert.equal(message.kind, type); assert.equal(message.nonReplyableNotice, true); assert.equal(isReplyableMessage(message), false);
  }
});

test('引用中的正文、图片和@与本条正文隔离，不用引用昵称触发群回复', async t => {
  const f = await dom(t, '<div data-e2e="message-quote"><div data-e2e="message-text"><span data-mention-self="true">@大肥鱼</span>旧问题</div><div data-e2e="message-image"><img alt="合成旧图"></div></div><div data-e2e="message-text">合成当前问题</div>', true);
  const message = (await f.read()).messages[0];
  assert.equal(message.text, '合成当前问题'); assert.match(message.reference.text, /旧问题/); assert.equal(message.media, null);
  assert.equal(message.mentionedSelf, false); assert.equal(groupMessageAddressesFish(message), false);
  const old = messageFingerprint(message); message.reference.text = '另一条合成引用'; assert.notEqual(messageFingerprint(message), old);
});

test('图文混合同时保留正文和图片，普通标签表情不丢失', async t => {
  const f = await dom(t, '<div data-e2e="message-text">看这个[微笑]</div><div data-e2e="message-image"><img alt="合成图片" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></div>');
  const message = (await f.read()).messages[0];
  assert.equal(message.text, '看这个[微笑]'); assert.equal(message.kind, 'image'); assert.equal(message.media.type, 'image');
  assert.equal(chatMessageSummary(message).text, message.text);
});

test('当前文字中的唯一抖音作品公开链接走原作品观察，冲突链接不猜选', async t => {
  const f = await dom(t, '<div data-e2e="message-text">合成提问 https://www.douyin.com/video/123456789?from=synthetic</div>');
  const message = (await f.read()).messages[0];
  assert.equal(message.media.type, 'shared-work'); assert.equal(message.media.url, 'https://www.douyin.com/video/123456789');
  for (const text of ['https://www.douyin.com/video/123abc', 'https://www.douyin.com/video/123 https://www.douyin.com/video/456']) {
    await f.page.locator('[data-e2e="message-text"]').evaluate((node, text) => { node.textContent = text; }, text);
    assert.equal((await f.read()).messages[0].media, null);
  }
});

test('动图在同一消息内采两帧，保持引用图排除和原身份门禁', async t => {
  const f = await dom(t, '<div data-e2e="message-quote"><div data-e2e="message-emoji" style="width:50px;height:50px">合成旧表情</div></div><div data-e2e="message-sticker" data-animated="true" style="width:120px;height:90px;background:green">合成动图</div>');
  const raw = await f.read(), contact = { id: 'conv:' + 'a'.repeat(64), displayName: raw.displayName, nativeId: raw.nativeId, conversationType: 'direct', isGroup: false };
  f.chat.select = async () => ({ contact, flags: {} });
  const messages = f.chat.publicMessages(contact.id, raw.messages);
  const result = await f.chat.captureMessage(contact.id, messages[0].id, { allowed: true });
  assert.equal(result.frames.length, 2); assert.equal(result.understandingScope, 'single-message-animation-sampling'); assert.match(result.note, /300毫秒.*没有音频/);
});

test('动图采样期间引用或附件内容变化时不返回混淆的画面', async t => {
  const f = await dom(t, '<div data-e2e="message-quote">合成原引用</div><div data-e2e="message-sticker" data-animated="true" style="width:120px;height:90px;background:green">合成动图</div>');
  const raw = await f.read(), contact = { id: 'conv:' + 'a'.repeat(64), displayName: raw.displayName, nativeId: raw.nativeId, conversationType: 'direct', isGroup: false };
  f.chat.select = async () => ({ contact, flags: {} });
  const messages = f.chat.publicMessages(contact.id, raw.messages), screenshot = f.page.screenshot.bind(f.page); let calls = 0;
  f.page.screenshot = async options => { const bytes = await screenshot(options); if (++calls === 1) await f.page.locator('[data-e2e="message-quote"]').evaluate(node => { node.textContent = '合成替换引用'; }); return bytes; };
  await assert.rejects(f.chat.captureMessage(contact.id, messages[0].id, { allowed: true }), /消息变化/); assert.equal(calls, 1);
});

test('模型入参同时包含正文、引用和附件，不泄漏资源地址或任意字段', async () => {
  let request;
  const agent = new ChatAgent({ config: { apiKey: '' }, replyProvider: async value => { request = value; return { text: '合成回复。' }; } });
  await agent.reply({ messages: [{ id: 'synthetic-mixed', sender: 'incoming', text: '合成新问题', reference: { text: '合成被引用的问题', private: 'PRIVATE_REFERENCE' }, media: { type: 'file', title: '合成文件.pdf', understandingScope: 'visible-message-metadata-only', resources: [{ src: 'PRIVATE_URL' }], secret: 'PRIVATE_MEDIA' } }] });
  const body = JSON.parse(request.messages[0].content);
  assert.equal(body.text, '合成新问题'); assert.equal(body.reference.text, '合成被引用的问题'); assert.equal(body.media.title, '合成文件.pdf');
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE_REFERENCE|PRIVATE_URL|PRIVATE_MEDIA/);
  assert.match(request.system, /接梗/); assert.match(request.system, /文件未读正文/);
  assert.equal(normalizeChatReplyText('【自动回复】 合成短句\n[[QQ_BREAK]]\n合成补充'), '合成短句\n\n合成补充');
});

function serviceFixture(t, group = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chat-parity-'));
  const contact = { id: 'conv:' + '1'.repeat(64), name: '合成许可会话', followed: true, isGroup: group, identityVerified: true, identityBinding: 'binding:' + '2'.repeat(64), identityVersion: 2, identityKind: group ? 'rendered-group' : 'rendered-user', identityHash: '1'.repeat(64) };
  const messages = [{ id: 'old', sender: 'incoming', text: '合成基线' }], sent = [], inputs = [];
  const adapter = { listContacts: async () => ({ contacts: [contact] }), readConversation: async () => ({ conversation: { id: contact.id, isGroup: group }, contact, messages: structuredClone(messages) }), sendMessage: async (_id, text) => { sent.push(text); return { confirmed: true, messageId: 'sent-' + sent.length }; } };
  const agent = { replyTokens: 512, reply: async input => { inputs.push(input); return { text: '合成自然回复' }; } };
  const service = new ChatService({ stateDir: directory, browser: adapter, agent, config: { apiKey: 'synthetic-key' } });
  t.after(async () => { await service.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  return { service, contact, messages, sent, inputs, adapter };
}

test('卡片与未知附件不进入媒体播放或人工搁置，可靠新消息只回复一次', async t => {
  const f = serviceFixture(t); await f.service.configure({ recipientIds: [f.contact.id] }); await f.service.start({ schedule: false });
  for (const type of ['file','location','user-card','live','music','call','gift','video-attachment','link','unknown']) {
    f.messages.push({ id: 'synthetic-' + type, sender: 'incoming', text: '', kind: type, eligibleForReply: true, media: { type, title: '合成可见卡片', understandingScope: 'visible-message-metadata-only' } });
    await f.service.poll();
  }
  await f.service.poll(); assert.equal(f.sent.length, 10); assert.equal(f.inputs.length, 10); assert.equal(f.service.state().contacts[0].status, 'ready');
});

test('群卡片仍需当前@或昵称；只引用大肥鱼不触发', async t => {
  const f = serviceFixture(t, true); await f.service.configure({ recipientIds: [f.contact.id], allowConversationOnly: true }); await f.service.start({ schedule: false });
  const card = { sender: 'incoming', text: '', eligibleForReply: true, media: { type: 'link', understandingScope: 'visible-message-metadata-only' } };
  f.messages.push({ ...card, id: 'quote-only', reference: { text: '@大肥鱼' } }); await f.service.poll(); assert.equal(f.sent.length, 0);
  f.messages.push({ ...card, id: 'mention-new', mentionedSelf: true }); await f.service.poll(); assert.equal(f.sent.length, 1);
});

test('同批超过四张画面仍回复其他消息，未采集部分明确告知模型', async t => {
  const f = serviceFixture(t); const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPEkAAAAASUVORK5CYII=';
  f.adapter.captureMessage = async (_id, messageId) => ({ messageId, frames: [{ mimeType: 'image/png', data: pixel }] });
  await f.service.configure({ recipientIds: [f.contact.id] }); await f.service.start({ schedule: false });
  for (let n = 0; n < 6; n++) f.messages.push({ id: 'image-' + n, sender: 'incoming', text: '', kind: 'image', eligibleForReply: true, media: { type: 'image' } });
  await f.service.poll(); assert.equal(f.sent.length, 1); assert.equal(f.service.state().contacts[0].status, 'ready');
  assert.equal(f.inputs[0].mediaObservations.reduce((sum, item) => sum + item.frames.length, 0), 4);
  assert.equal(f.inputs[0].mediaObservations.filter(item => item.understandingScope === 'message-not-observed-budget').length, 2);
});
