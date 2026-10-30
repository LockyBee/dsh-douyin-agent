import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { FriendInteractions } from '../friend-interactions.mjs';
import { ChatService } from '../chat-service.mjs';
import { ChatBrowser } from '../chat-browser.mjs';
import { BrowserController } from '../core.mjs';
import { chromium } from '../playwright-runtime.mjs';

const contact = { id: `conv:${'1'.repeat(64)}`, name: '合成许可好友', followed: true, isGroup: false, identityVerified: true, identityBinding: `binding:${'2'.repeat(64)}`, identityVersion: 2, identityKind: 'rendered-user', identityHash: '1'.repeat(64) };
const config = { apiKey: 'synthetic-only', model: 'synthetic', baseUrl: 'https://api.deepseek.com' };
const missing = () => Object.assign(new Error('合成消息页未打开'), { code: 'CHAT_PAGE_NOT_OPEN' });
const settle = async coordinator => { await coordinator.reconcile(); await Promise.race([coordinator.autoPrepareJob, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('自动准备自等待或未及时完成。')), 5000); timer.unref(); })]); };
async function fixture(t, options = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-auto-prepare-')), calls = { prepare: 0, start: 0, model: 0, sent: 0 }; let present = true;
  const browser = { listContacts: async () => { if (!present) throw missing(); return { contacts: [structuredClone(contact)] }; }, prepareChat: async ({ signal, automatic }) => { calls.prepare++; assert.equal(automatic, true); signal.throwIfAborted(); present = true; return { prepared: true, count: 1 }; }, readConversation: async () => ({ conversation: { id: contact.id }, contact: structuredClone(contact), messages: [{ id: 'baseline-old', sender: 'incoming', text: '合成启动前旧消息', eligibleForReply: true }] }), sendMessage: async () => { calls.sent++; throw new Error('准备通道不得发送。'); } };
  const agent = { reply: async () => { calls.model++; throw new Error('准备通道不得调用模型。'); } };
  const services = [], coordinators = [];
  const createService = () => { const service = new ChatService({ stateDir, browser, agent, config }); services.push(service); return service; };
  const service = createService(); await service.configure({ recipientIds: [contact.id] }); present = false;
  const originalAllowlist = structuredClone(service.state().policy.allowlist);
  const share = { state: () => ({ enabled: true, paused: true, recoveryRequired: false, needsReview: [{ status: 'uncertain' }] }), configure: () => assert.fail('准备不能改分享策略。') };
  const create = (chat = service, extra = {}) => { const coordinator = new FriendInteractions({ stateDir, getChat: () => chat, getShare: () => share, modelReady: () => true, startChat: async (value, { signal }) => { calls.start++; return value.start({ schedule: false, signal }); }, ...extra }); coordinators.push(coordinator); return coordinator; };
  const unchanged = () => { assert.deepEqual(service.state().policy.allowlist, originalAllowlist); assert.equal(calls.model, 0); assert.equal(calls.sent, 0); };
  t.after(async () => { for (const coordinator of coordinators) await coordinator.close(); for (const value of services) await value.close(); assert.equal(path.dirname(path.resolve(stateDir)), path.resolve(os.tmpdir())); assert.match(path.basename(stateDir), /^douyin-auto-prepare-/); fs.rmSync(stateDir, { recursive: true, force: true }); });
  return { stateDir, calls, browser, service, createService, create, unchanged, setPresent: value => { present = value; } };
}

test('真实服务缺消息页后自然准备并启动，不等待自身reconcile，不补发旧消息', async t => {
  const f = await fixture(t), coordinator = f.create(); await settle(coordinator);
  assert.equal(f.service.state().running, true); assert.equal(coordinator.state().status, 'running'); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.start, 2);
  await f.service.poll(); for (let i = 0; i < 30; i++) await coordinator.reconcile();
  assert.equal(f.calls.prepare, 1); assert.equal(fs.existsSync(coordinator.prepareGuard), false); assert.equal(JSON.parse(fs.readFileSync(coordinator.prepareBudgetFile)).attempts, 1); f.unchanged();
});

test('API和DSH竞争只由共享准备租约的拥有者准备，另入口看到真实worker后自然恢复', async t => {
  const f = await fixture(t), otherService = f.createService(), a = f.create(), b = f.create(otherService);
  const entered = Promise.withResolvers(), released = Promise.withResolvers(), prepare = f.browser.prepareChat;
  f.browser.prepareChat = async input => { entered.resolve(); await released.promise; return prepare(input); };
  await a.reconcile(); await entered.promise;
  await b.reconcile(); await b.autoPrepareJob; assert.equal(f.calls.prepare, 0); assert.equal(b.state().replyRunning, false);
  released.resolve(); await a.autoPrepareJob; await b.reconcile(); assert.equal(f.calls.prepare, 1); assert.equal(a.state().replyRunning, true); assert.equal(b.state().replyRunning, true); assert.equal(fs.existsSync(a.prepareGuard), false); f.unchanged();
});

test('自动准备失败有限退避，十分钟最多三次，次数记录不改每日用量', async t => {
  const f = await fixture(t), coordinator = f.create();
  f.browser.prepareChat = async () => { f.calls.prepare++; throw Object.assign(new Error('合成前台保护'), { code: 'CHAT_FOREGROUND' }); };
  for (let i = 0; i < 8; i++) { coordinator.deferUntil = 0; await settle(coordinator); }
  assert.equal(f.calls.prepare, 3); assert.equal(JSON.parse(fs.readFileSync(coordinator.prepareBudgetFile)).attempts, 3); assert.equal(coordinator.state().lastErrorCode, 'CHAT_PREPARE_RATE_LIMITED'); assert.equal(f.service.state().daily.requests, 0); assert.equal(fs.existsSync(coordinator.prepareGuard), false); f.unchanged();
});

test('活的其他准备租约不抢占，次数预算也不因此消耗', async t => {
  const f = await fixture(t), coordinator = f.create(), owner = { version: 1, pid: process.pid, token: randomUUID(), startedAt: Date.now() }; fs.writeFileSync(coordinator.prepareGuard, JSON.stringify(owner));
  await settle(coordinator); assert.equal(coordinator.state().lastErrorCode, 'CHAT_PREPARE_BUSY'); assert.equal(f.calls.prepare, 0); assert.equal(fs.existsSync(coordinator.prepareBudgetFile), false); assert.deepEqual(JSON.parse(fs.readFileSync(coordinator.prepareGuard)), owner); f.unchanged();
});

test('可核实已退出的准备进程可释放旧准备租约，非发送锁不改资格或收据', async t => {
  const f = await fixture(t), coordinator = f.create(); fs.writeFileSync(coordinator.prepareGuard, JSON.stringify({ version: 1, pid: 2147483647, token: randomUUID(), startedAt: Date.now() - 70_000 }));
  await settle(coordinator); assert.equal(f.calls.prepare, 1); assert.equal(f.service.state().running, true); assert.equal(fs.existsSync(coordinator.prepareGuard), false); f.unchanged();
});

test('准备中本人关闭总开关立即撤回信号，不持长控制锁阻止关闭', async t => {
  const f = await fixture(t), coordinator = f.create(), entered = Promise.withResolvers();
  f.browser.prepareChat = async ({ signal }) => { f.calls.prepare++; entered.resolve(signal); await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); };
  await coordinator.reconcile(); const signal = await entered.promise; assert.equal(fs.existsSync(path.join(f.stateDir, 'friend-interactions-control.guard')), false);
  await coordinator.configure({ enabled: false }, { explicit: true }); await coordinator.autoPrepareJob;
  assert.equal(signal.aborted, true); assert.equal(f.service.state().running, false); assert.equal(coordinator.state().enabled, false); assert.equal(fs.existsSync(coordinator.prepareGuard), false); f.unchanged();
});

test('关闭入口等待自动准备退出，后续微任务不能重开', async t => {
  const f = await fixture(t), coordinator = f.create(), entered = Promise.withResolvers();
  f.browser.prepareChat = async ({ signal }) => { entered.resolve(); await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); };
  await coordinator.reconcile(); await entered.promise; await coordinator.close(); assert.equal(f.service.state().running, false); assert.equal(coordinator.autoPrepareJob, null); assert.equal(fs.existsSync(coordinator.prepareGuard), false); f.unchanged();
});

test('损坏准备次数记录拒绝自动新建，不重置原数据', async t => {
  const f = await fixture(t), coordinator = f.create(); fs.writeFileSync(coordinator.prepareBudgetFile, '{synthetic-broken'); await settle(coordinator);
  assert.equal(f.calls.prepare, 0); assert.equal(f.service.state().running, false); assert.equal(fs.readFileSync(coordinator.prepareBudgetFile, 'utf8'), '{synthetic-broken'); f.unchanged();
});

test('准备次数窗口到期后自然恢复有限准备，不需要用户重新按按钮', async t => {
  const f = await fixture(t), coordinator = f.create(), at = Date.now() - 600_001;
  fs.writeFileSync(coordinator.prepareBudgetFile, JSON.stringify({ version: 1, windowStartedAt: at, lastAttemptAt: at, attempts: 3 }));
  await settle(coordinator); assert.equal(f.service.state().running, true); assert.equal(f.calls.prepare, 1); assert.equal(JSON.parse(fs.readFileSync(coordinator.prepareBudgetFile)).attempts, 1); f.unchanged();
});

test('准备期间租约被替换时保留新租约，清掉本入口等待状态而不自锁', async t => {
  const f = await fixture(t), coordinator = f.create(), replacement = { version: 1, pid: process.pid, token: randomUUID(), startedAt: Date.now() };
  f.browser.prepareChat = async () => { fs.writeFileSync(coordinator.prepareGuard, JSON.stringify(replacement)); throw new Error('合成准备失败'); };
  await settle(coordinator); assert.deepEqual(JSON.parse(fs.readFileSync(coordinator.prepareGuard)), replacement); assert.equal(coordinator.prepare, null); assert.equal(f.service.state().running, false); f.unchanged();
});

test('前台、离开抖音、未知错误不自动导航已有页面，只有缺消息页触发', async t => {
  for (const code of ['CHAT_FOREGROUND', 'CHAT_PAGE_LEFT_DOUYIN', 'CHAT_LOGIN_REQUIRED', 'SYNTHETIC_UNKNOWN']) {
    const f = await fixture(t), coordinator = f.create(undefined, { startChat: async () => { throw Object.assign(new Error('合成保护'), { code }); } }); await settle(coordinator); assert.equal(f.calls.prepare, 0); assert.equal(coordinator.autoPrepareJob, null); f.unchanged();
  }
});

test('无模型、无名单、总开关关闭或设置维护时不自动准备', async t => {
  for (const mode of ['model', 'contacts', 'off', 'settings']) {
    const f = await fixture(t), coordinator = f.create(undefined, mode === 'model' ? { modelReady: () => false } : {});
    if (mode === 'contacts') { f.setPresent(true); await f.service.configure({ recipientIds: [] }); }
    if (mode === 'off') fs.writeFileSync(coordinator.policyFile, JSON.stringify({ version: 1, enabled: false }));
    if (mode === 'settings') fs.writeFileSync(coordinator.settingsGuard, 'synthetic-settings-owner');
    await settle(coordinator); assert.equal(f.calls.prepare, 0); assert.equal(f.service.state().running, false); assert.equal(f.calls.model, 0); assert.equal(f.calls.sent, 0);
  }
});

test('取得准备租约前另一入口撤回或进入维护：在同一控制临界区复核，零预算零建页', async t => {
  for (const mode of ['off', 'settings']) {
    const f = await fixture(t), coordinator = f.create(), acquire = coordinator.acquirePrepare.bind(coordinator);
    coordinator.acquirePrepare = input => { if (mode === 'off') fs.writeFileSync(coordinator.policyFile, JSON.stringify({ version: 1, enabled: false })); else fs.writeFileSync(coordinator.settingsGuard, 'synthetic-other-settings'); return acquire(input); };
    await settle(coordinator); assert.equal(f.calls.prepare, 0); assert.equal(f.service.state().running, false); assert.equal(fs.existsSync(coordinator.prepareGuard), false); assert.equal(fs.existsSync(coordinator.prepareBudgetFile), false); f.unchanged();
  }
});

test('自动路径缺少浏览器prepare能力时拒绝，不降级到可输入的listContacts', async t => {
  const f = await fixture(t); delete f.browser.prepareChat; let reads = 0; f.browser.listContacts = async () => { reads++; throw new Error('不得降级列表读取。'); };
  await assert.rejects(f.service.prepareChat({ automatic: true, authorizePrepare: async () => true }), error => error.code === 'CHAT_PREPARE_UNSUPPORTED'); assert.equal(reads, 0); f.unchanged();
});

async function edgeFixture(t, { foreground = false } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-auto-prepare-edge-')), controlDirectory = path.join(stateDir, 'control'); fs.mkdirSync(controlDirectory);
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-background-networking', '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  const context = await browser.newContext(); let navigations = 0, sendCount = 0;
  const html = `<button data-e2e="im-entry">消息</button><div data-e2e="im-dialog" hidden><div data-e2e="conversation-item" data-conversation-id="synthetic-edge-permitted" data-conversation-type="direct"><img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"><div data-e2e="conversation-name">合成好友</div><a href="https://www.douyin.com/user/synthetic-public-user">主页</a><span class="relation">相互关注</span></div><div data-e2e="chat-page"><div data-e2e="chat-header" data-conversation-id="synthetic-edge-permitted" data-conversation-type="direct"><img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"><div class="StackLayoutStackChatHeadertitle">合成好友</div></div><div class="messageMessageListlist" id="message-list" style="display:flex;flex-direction:column"><div data-index="0"><div class="messageMessageBoxmessageBox" data-message-id="synthetic-old"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">合成旧消息</div></div></div></div></div><div data-e2e="msg-input"><div contenteditable="true"></div><button class="e2e-send-msg-btn">发送</button></div></div></div><script>window.sent=0;document.querySelector('[data-e2e="im-entry"]').onclick=()=>document.querySelector('[data-e2e="im-dialog"]').hidden=false;document.querySelector('.e2e-send-msg-btn').onclick=()=>window.sent++;</script>`;
  await context.route('**/*', route => { if (route.request().url().startsWith('https://www.douyin.com/')) { navigations++; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }); } return route.abort(); });
  if (!foreground) await context.addInitScript(() => { document.hasFocus = () => false; });
  const existing = await context.newPage(); await existing.goto('https://www.douyin.com/recommend'); await existing.evaluate(() => { window.name = 'deepseek-douyin-api'; });
  const controller = new BrowserController({ source: 'api-chat', controlDirectory }); controller.browser = browser;
  const chat = new ChatBrowser({ controller }); chat.following = [{ displayName: '合成好友', mutual: true }];
  const connected = { isConnected: () => browser.isConnected(), contexts: () => [context], newBrowserCDPSession: () => browser.newBrowserCDPSession(), close: async () => {} }; controller.browser = connected;
  const createService = () => new ChatService({ browser: chat, config, stateDir, agent: { reply: async () => { throw new Error('准备不得调用模型。'); } } });
  const coordinators = [], services = [];
  t.after(async () => { for (const value of coordinators) await value.close(); for (const service of services) { service.stopPolling(); if (service.runId) service.stop(); } await context.close(); await browser.close(); assert.equal(path.dirname(path.resolve(stateDir)), path.resolve(os.tmpdir())); assert.match(path.basename(stateDir), /^douyin-auto-prepare-edge-/); fs.rmSync(stateDir, { recursive: true, force: true }); });
  return { stateDir, browser, context, existing, controller, chat, createService, services, coordinators, navigations: () => navigations, sends: async () => { sendCount = 0; for (const page of context.pages()) sendCount += await page.evaluate(() => window.sent || 0); return sendCount; } };
}

test('真实Edge合成缺页：自动准备仅创建一个受管聊天页，真实ChatService自然恢复且零发送', { timeout: 30_000 }, async t => {
  const f = await edgeFixture(t);
  await f.existing.evaluate(() => { document.querySelector('[data-e2e="im-dialog"]').hidden = false; window.name = 'deepseek-douyin-api-chat'; });
  f.controller.page = f.existing; const contacts = (await f.chat.listContacts({ backgroundOnly: true, verifyFollowing: false })).contacts;
  const service = f.createService(); f.services.push(service); await service.configure({ recipientIds: [contacts[0].id], allowConversationOnly: true });
  await f.existing.evaluate(() => { window.name = 'deepseek-douyin-api'; }); f.controller.page = null;
  const coordinator = new FriendInteractions({ stateDir: f.stateDir, getChat: () => service, getShare: () => ({ state: () => ({ enabled: true, paused: true }), configure: () => assert.fail() }), modelReady: () => true, startChat: (chat, { signal }) => chat.start({ schedule: false, signal }) }); f.coordinators.push(coordinator);
  await settle(coordinator); assert.equal(service.state().running, true);
  const owned = []; for (const page of f.context.pages()) if (await page.evaluate(() => window.name) === 'deepseek-douyin-api-chat') owned.push(page);
  assert.equal(owned.length, 1); assert.equal(f.context.pages().length, 2); assert.equal(coordinator.state().status, 'running'); assert.equal(await f.sends(), 0);
  const before = f.navigations(); for (let i = 0; i < 12; i++) await coordinator.reconcile(); assert.equal(f.navigations(), before); assert.equal(f.context.pages().length, 2); assert.equal(await f.sends(), 0);
});

test('真实Edge合成前台：建页前停止，不强制清焦点或改变窗口状态', { timeout: 30_000 }, async t => {
  const f = await edgeFixture(t, { foreground: true }); await f.existing.bringToFront(); assert.equal(await f.chat.isForeground(f.existing), true);
  const before = f.navigations(); await assert.rejects(f.chat.prepareChat({ automatic: true, authorizePrepare: async () => true }), error => error.code === 'CHAT_FOREGROUND'); assert.equal(f.context.pages().length, 1); assert.equal(f.navigations(), before); assert.equal(await f.sends(), 0);
});

test('真实Edge合成已有草稿：不导航、不改草稿、不多建页', { timeout: 30_000 }, async t => {
  const f = await edgeFixture(t); await f.existing.evaluate(() => { window.name = 'deepseek-douyin-dsh-chat'; document.querySelector('[data-e2e="im-dialog"]').hidden = false; document.querySelector('[contenteditable]').textContent = '合成草稿必须保留'; });
  const before = f.navigations(); await assert.rejects(f.chat.prepareChat({ automatic: true, authorizePrepare: async () => true }), error => error.code === 'CHAT_DRAFT_PRESENT'); assert.equal(f.context.pages().length, 1); assert.equal(f.navigations(), before); assert.equal(await f.existing.locator('[contenteditable]').innerText(), '合成草稿必须保留'); assert.equal(await f.sends(), 0);
});

test('真实Edge合成登录与验证码：已有受管页发现阻断即停止，不另建页', { timeout: 30_000 }, async t => {
  for (const html of ['<div data-e2e="login-panel">扫码登录</div>', '<div id="captcha_container">验证码</div>']) {
    const f = await edgeFixture(t); await f.existing.evaluate(value => document.body.insertAdjacentHTML('afterbegin', value), html);
    const before = f.navigations(); await assert.rejects(f.chat.prepareChat({ automatic: true, authorizePrepare: async () => true }), error => error.code === 'CHAT_LOGIN_REQUIRED'); assert.equal(f.context.pages().length, 1); assert.equal(f.navigations(), before); assert.equal(await f.sends(), 0);
  }
});

test('真实Edge合成双入口竞争：共享准备到worker就绪的租约只产生一个受管聊天页', { timeout: 30_000 }, async t => {
  const f = await edgeFixture(t);
  await f.existing.evaluate(() => { document.querySelector('[data-e2e="im-dialog"]').hidden = false; window.name = 'deepseek-douyin-api-chat'; });
  f.controller.page = f.existing; const contacts = (await f.chat.listContacts({ backgroundOnly: true, verifyFollowing: false })).contacts;
  const aService = f.createService(); f.services.push(aService); await aService.configure({ recipientIds: [contacts[0].id], allowConversationOnly: true });
  await f.existing.evaluate(() => { window.name = 'deepseek-douyin-api'; }); f.controller.page = null;
  const otherController = new BrowserController({ source: 'dsh-chat', controlDirectory: f.controller.controlDirectory }); otherController.browser = f.controller.browser;
  const otherChat = new ChatBrowser({ source: 'dsh-chat', controller: otherController }); otherChat.following = [{ displayName: '合成好友', mutual: true }];
  const bService = new ChatService({ browser: otherChat, config, stateDir: f.stateDir, agent: { reply: async () => assert.fail('准备不能调用模型。') } }); f.services.push(bService);
  const create = service => { const value = new FriendInteractions({ stateDir: f.stateDir, getChat: () => service, getShare: () => ({ state: () => ({ enabled: true, paused: true }), configure: () => assert.fail() }), modelReady: () => true, startChat: (chat, { signal }) => chat.start({ schedule: false, signal }) }); f.coordinators.push(value); return value; };
  const a = create(aService), b = create(bService); await Promise.all([a.reconcile(), b.reconcile()]); await Promise.all([a.autoPrepareJob, b.autoPrepareJob]); await Promise.all([a.reconcile(), b.reconcile()]);
  assert.equal(a.state().replyRunning, true); assert.equal(b.state().replyRunning, true);
  let count = 0; for (const page of f.context.pages()) if (/^deepseek-douyin-(?:api|dsh)-chat$/.test(await page.evaluate(() => window.name))) count++;
  assert.equal(count, 1); assert.equal(f.context.pages().length, 2); assert.equal(await f.sends(), 0);
});

test('真实Edge合成受管名称留在外站：先核origin，不读取内容、不导航或创建回复页', { timeout: 30_000 }, async t => {
  const f = await edgeFixture(t); await f.context.route('https://synthetic.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<p>外站合成内容不得读取</p>' }));
  await f.existing.goto('https://synthetic.invalid/away'); await f.existing.evaluate(() => { window.name = 'deepseek-douyin-api-chat'; });
  const evaluate = f.existing.evaluate.bind(f.existing); let reads = 0; f.existing.evaluate = (...args) => { reads++; return evaluate(...args); };
  const before = f.navigations(); await assert.rejects(f.chat.prepareChat({ automatic: true, authorizePrepare: async () => true }), error => error.code === 'CHAT_PAGE_LEFT_DOUYIN'); assert.equal(reads, 0); assert.equal(f.existing.url(), 'https://synthetic.invalid/away'); assert.equal(f.context.pages().length, 1); assert.equal(f.navigations(), before);
});

test('真实Edge合成建页边界撤回：在外层检查之后撤权，core最终检查仍拒绝创建', { timeout: 30_000 }, async t => {
  for (const mode of ['off', 'settings', 'contacts']) {
    const f = await edgeFixture(t);
    await f.existing.evaluate(() => { document.querySelector('[data-e2e="im-dialog"]').hidden = false; window.name = 'deepseek-douyin-api-chat'; });
    f.controller.page = f.existing; const contacts = (await f.chat.listContacts({ backgroundOnly: true, verifyFollowing: false })).contacts;
    const service = f.createService(); f.services.push(service); await service.configure({ recipientIds: [contacts[0].id], allowConversationOnly: true });
    await f.existing.evaluate(() => { window.name = 'deepseek-douyin-api'; }); f.controller.page = null;
    const coordinator = new FriendInteractions({ stateDir: f.stateDir, getChat: () => service, getShare: () => ({ state: () => ({ enabled: true, paused: true }), configure: () => assert.fail() }), modelReady: () => true, startChat: (chat, { signal }) => chat.start({ schedule: false, signal }) }); f.coordinators.push(coordinator);
    const connect = f.controller.connect.bind(f.controller); let revoked = false;
    f.controller.connect = async (signal, options) => {
      if (options.create === true && !revoked) {
        revoked = true;
        if (mode === 'off') fs.writeFileSync(coordinator.policyFile, JSON.stringify({ version: 1, enabled: false }));
        else if (mode === 'settings') fs.writeFileSync(coordinator.settingsGuard, 'synthetic-other-settings');
        else { const policy = JSON.parse(fs.readFileSync(service.policyFile)); policy.allowlist = []; fs.writeFileSync(service.policyFile, JSON.stringify(policy)); }
      }
      return connect(signal, options);
    };
    const before = f.navigations(); await settle(coordinator); assert.equal(revoked, true); assert.equal(service.state().running, false); assert.equal(f.context.pages().length, 1); assert.equal(f.navigations(), before); assert.equal(await f.sends(), 0); assert.equal(fs.existsSync(coordinator.prepareGuard), false);
  }
});

function disconnectedHostProbe(t, phase, automatic = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-auto-prepare-disconnect-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-auto-prepare-disconnect-/); fs.rmSync(directory, { recursive: true, force: true }); });
  const script = `
    import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import assert from 'node:assert/strict'; import childProcess from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    const root=${JSON.stringify(directory)}, phase=${JSON.stringify(phase)}, automatic=${automatic};
    assert.equal(path.resolve(os.homedir()),path.resolve(root),'宿主探针必须使用临时home。');
    let starts=0,requests=0;
    childProcess.spawn=()=>{starts++;throw Object.assign(new Error('合成宿主启动边界已拦截'),{code:'SYNTHETIC_HOST_START_INTERCEPTED'});}; syncBuiltinESMExports();
    globalThis.fetch=async()=>{requests++;return {ok:false};};
    const {BrowserController}=await import(${JSON.stringify(import.meta.resolve('../core.mjs'))});
    const {ChatBrowser}=await import(${JSON.stringify(import.meta.resolve('../chat-browser.mjs'))});
    const controller=new BrowserController({source:'api-chat'});
    assert.ok(path.resolve(controller.controlDirectory).startsWith(path.resolve(root)+path.sep),'不能使用真实浏览器控制目录。');
    const connected={isConnected:()=>true,contexts:()=>[{pages:()=>[]}],close:async()=>{}}, closed={isConnected:()=>false,close:async()=>{}};
    controller.browser=automatic?connected:closed;let checked=0;
    controller.connectExistingBrowser=async()=>{if(++checked===1&&automatic){if(phase==='after-preflight')queueMicrotask(()=>{controller.browser=closed;});return connected;}return null;};
    if(phase==='before-create'){const connect=controller.connect.bind(controller);controller.connect=async(signal,options)=>{try{return await connect(signal,options);}catch(error){if(error.code==='CHAT_PAGE_NOT_OPEN'&&options.create===false)controller.browser=closed;throw error;}};}
    const chat=new ChatBrowser({controller}); let code='';
    try{await chat.prepareChat({automatic,authorizePrepare:async()=>true});}catch(error){code=error.code||error.message;}
    console.log(JSON.stringify({starts,requests,checked,code,controlInTemporaryHome:true}));
  `;
  const imports = []; for (let i = 0; i < process.execArgv.length; i++) if (process.execArgv[i] === '--import') imports.push('--import', process.execArgv[++i]);
  const result = spawnSync(process.execPath, [...imports, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, USERPROFILE: directory, HOME: directory, DOUYIN_RUNTIME_LOCATION_FILE: path.join(directory, 'absent-runtime-location.json'), DOUYIN_STATE_DIR: path.join(directory, 'state'), DEEPSEEK_SHARED_MEMORY_DB: path.join(directory, 'memory', 'absent.sqlite') } });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('自动准备初查后浏览器断连：真实core链不查询端口或启动宿主', t => {
  const result = disconnectedHostProbe(t, 'after-preflight'); assert.equal(result.starts, 0); assert.equal(result.requests, 0); assert.equal(result.code, 'BROWSER_NOT_RUNNING'); assert.equal(result.controlInTemporaryHome, true);
});

test('自动准备第一次无页检查后浏览器退出：第二次withPage也不启动宿主', t => {
  const result = disconnectedHostProbe(t, 'before-create'); assert.equal(result.starts, 0); assert.equal(result.requests, 0); assert.equal(result.code, 'BROWSER_NOT_RUNNING'); assert.equal(result.controlInTemporaryHome, true);
});

test('人工准备仍保留启动兼容，启动边界由临时子进程拦截而不真正启动', t => {
  const result = disconnectedHostProbe(t, 'manual', false); assert.equal(result.starts, 1); assert.equal(result.requests, 1); assert.equal(result.code, 'SYNTHETIC_HOST_START_INTERCEPTED'); assert.equal(result.controlInTemporaryHome, true);
});
