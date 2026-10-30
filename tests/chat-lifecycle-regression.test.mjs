import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatBrowser } from '../chat-browser.mjs';

function controller(options) {
  return { withPage: async (callback, value) => { options.push(value); return callback({ evaluate: async () => true, isClosed: () => false }); } };
}

test('后台读取联系人不允许启动浏览器或新建标签，且在前台检查后停止', async () => {
  const options = [];
  const chat = new ChatBrowser({ controller: controller(options) });
  await assert.rejects(chat.listContacts({ verifyFollowing: false, backgroundOnly: true }), error => error.code === 'CHAT_FOREGROUND');
  assert.equal(options.length, 1);
  assert.equal(options[0].launch, false);
  assert.equal(options[0].create, false);
});

test('默认只核对一次关注关系，后续读取复用结果，不重复触发导航', async () => {
  let verified = 0;
  const chat = new ChatBrowser({ controller: controller([]) });
  chat.verifyFollowing = async () => { verified += 1; chat.following = []; };
  chat.dialog = async () => ({ blocked: false });
  chat.ensureChatPage = async () => {};
  chat.contactList = async () => ({ contacts: [] });
  await chat.listContacts();
  await chat.listContacts();
  await chat.listContacts();
  assert.equal(verified, 1);
});

test('后台连续读取联系人不核对关注关系，也不恢复导航或打开消息面板', async () => {
  const options = [], chat = new ChatBrowser({ controller: controller(options) });
  chat.isForeground = async () => false;
  chat.verifyFollowing = async () => assert.fail('后台不能为核对关注关系导航');
  chat.dialog = async (page, signal, value) => { assert.equal(value.open, false); return { blocked: false }; };
  chat.contactList = async (page, signal, value) => { assert.equal(value.ensurePage, false); return { contacts: [] }; };
  for (let i = 0; i < 100; i++) await chat.listContacts({ backgroundOnly: true, verifyFollowing: true });
  assert.equal(options.length, 100); assert.ok(options.every(value => value.launch === false && value.create === false));
  assert.equal(chat.following, null);
});

test('后台默认观察方法同样不创建新页面', async () => {
  const options = [], chat = new ChatBrowser({ controller: controller(options) });
  await chat.withPage(async () => {});
  assert.equal(options[0].launch, false); assert.equal(options[0].create, false);
});
