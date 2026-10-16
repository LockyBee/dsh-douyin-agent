import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '../playwright-runtime.mjs';
import { readPageState } from '../core.mjs?v=9';
import { VideoForwarder, canonicalVideoUrl, forwardAvatarIdentity, readForwardPanelDom } from '../video-forward.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
const recipientId = `conv:${'a'.repeat(64)}`;
const contact = { id: recipientId, name: '合成好友甲', displayName: '合成好友甲', followed: true, isGroup: false, avatar: '/img/aweme-avatar/fixture-avatar' };
const card = { id: `msg:${'b'.repeat(64)}`, sender: 'outgoing', arrivalClassification: 'new-tail', media: { type: 'shared-work', videoId: '12345', url: 'https://www.douyin.com/video/12345' } };

async function fixture({ rows = [{ name: '合成好友甲', avatar: 'https://fixture.local/aweme/aweme-avatar/fixture-avatar.jpeg', label: '分享' }], follow = true, shareResult = [card], existing = [], gateHook } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-forward-test-'));
  fs.writeFileSync(path.join(stateDir, 'chat-policy.json'), JSON.stringify({ allowlist: [{ ...contact, verifiedAt: '2026-10-14T00:00:00Z' }] }));
  const page = await browser.newPage();
  await page.setContent('<div data-e2e="video-share-icon-container"><div class="s7K4YLGp" style="width:40px;height:40px">分享</div><div data-e2e="video-share-container"></div></div>');
  await page.evaluate(({ rows, existing, shareResult }) => {
    window.sent = 0; window.messages = existing; window.shareResult = shareResult;
    window.fixtureState = { video: { id: '12345', url: 'https://www.douyin.com/video/12345', readyState: 4 }, loginRequired: false, verificationRequired: false };
    const panel = document.querySelector('[data-e2e="video-share-container"]');
    for (const row of rows) {
      const item = document.createElement('div'); item.className = 'otFjqQEX';
      const image = document.createElement('img'); image.src = row.avatar; image.width = 30; image.height = 30;
      const name = document.createElement('span'); name.className = 'EnYt_IKl'; name.textContent = row.name;
      const send = document.createElement('div'); send.className = 'xu0OjnsQ'; send.textContent = row.label; send.style.cssText = 'width:70px;height:30px';
      send.addEventListener('click', () => { window.sent += 1; window.messages = [...window.messages, ...window.shareResult]; });
      item.append(image, name, send); panel.append(item);
    }
  }, { rows, existing, shareResult });
  let gates = 0, pauses = 0, verified = 0, opened = 0, connected = 0;
  const realEvaluate = page.evaluate.bind(page);
  page.evaluate = (fn, arg) => fn === readPageState ? realEvaluate(() => window.fixtureState) : realEvaluate(fn, arg);
  const controller = { source: 'api', withPage: async fn => { connected += 1; return fn(page); }, pauseForLimits: async () => { pauses += 1; }, settle: async () => {} };
  const chatBrowser = {
    contacts: new Map([[recipientId, contact]]),
    listContacts: async options => { assert.equal(options.verifyFollowing, true); verified += 1; return { contacts: [{ ...contact, followed: follow }] }; },
    readConversation: async (id, options) => { assert.equal(id, recipientId); assert.equal(options.allowed, true); return { conversation: { id: recipientId }, messages: await realEvaluate(() => window.messages) }; },
    openSharedVideo: async (id, messageId, options) => { opened += 1; assert.equal(id, recipientId); assert.equal(options.allowed, true); return { videoId: '12345', url: 'https://www.douyin.com/video/12345' }; },
    sendMessage: async () => { throw new Error('测试禁止文字链接自动降级'); },
  };
  const videoLimits = { beforeAction: (source, name) => { assert.equal(source, 'api'); assert.equal(name, 'douyin_forward_video'); gates += 1; return gateHook?.({ gates, page }) ?? { allowed: true }; } };
  const forwarder = new VideoForwarder({ controller, chatBrowser, videoLimits, stateDir });
  return { page, forwarder, stateDir, stats: () => ({ gates, pauses, verified, opened, connected }), cleanup: async () => { await page.close(); fs.rmSync(stateDir, { recursive: true, force: true }); } };
}

test('可信人类入口未授权时只提示本机选择，不进入浏览器', async () => {
  const f = await fixture();
  try { const result = await f.forwarder.forward({ recipientId }); assert.equal(result.humanActionRequired, true); assert.equal(result.confirmed, false); assert.deepEqual(f.stats(), { gates: 0, pauses: 0, verified: 0, opened: 0, connected: 0 }); } finally { await f.cleanup(); }
});

test('作品链接只保留公开作品路径，拒绝其他站点及链接和 ID 不一致', async () => {
  assert.deepEqual(canonicalVideoUrl('https://www.douyin.com/video/12345?secret=fixture'), { videoId: '12345', url: 'https://www.douyin.com/video/12345' });
  for (const url of ['https://evil.local/video/12345', 'javascript:alert(1)', 'https://user:pass@www.douyin.com/video/12345', 'https://www.douyin.com/video/12345/other']) assert.throws(() => canonicalVideoUrl(url));
  const f = await fixture(); try { await assert.rejects(f.forwarder.forward({ recipientId, url: 'https://www.douyin.com/video/12345', expectedVideoId: '999' }, { humanAuthorized: true }), /不一致/); assert.equal(f.stats().connected, 0); } finally { await f.cleanup(); }
});

test('时间门控先于联系人或分享界面，拒绝后主动暂停', async () => {
  const f = await fixture({ gateHook: () => ({ allowed: false, reason: '合成时间窗外' }) });
  try { await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /时间窗外/); assert.equal(f.stats().pauses, 1); assert.equal(f.stats().verified, 0); assert.equal(await f.page.evaluate(() => window.sent), 0); } finally { await f.cleanup(); }
});

test('当前取消关注或固定白名单外联系人都拒绝转发', async () => {
  const f = await fixture({ follow: false });
  try { await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /关注关系/); await assert.rejects(f.forwarder.forward({ recipientId: `conv:${'c'.repeat(64)}` }, { humanAuthorized: true }), /名单内/); assert.equal(await f.page.evaluate(() => window.sent), 0); } finally { await f.cleanup(); }
});

test('相同头像资源的代理前缀和图片格式可核对，其他头像不等价', () => {
  assert.equal(forwardAvatarIdentity('/img/aweme-avatar/fixture-avatar'), forwardAvatarIdentity('https://fixture.local/aweme/100x100/aweme-avatar/fixture-avatar.jpeg?temporary=1'));
  assert.notEqual(forwardAvatarIdentity('/img/aweme-avatar/fixture-avatar'), forwardAvatarIdentity('/img/aweme-avatar/other-avatar'));
});

test('分享面板同名歧义和头像变化不点击发送', async () => {
  for (const rows of [[{ name: '合成好友甲', avatar: 'https://fixture.local/img/aweme-avatar/fixture-avatar', label: '分享' }, { name: '合成好友甲', avatar: 'https://fixture.local/img/aweme-avatar/other', label: '分享' }], [{ name: '合成好友甲', avatar: 'https://fixture.local/img/aweme-avatar/other', label: '分享' }]]) {
    const f = await fixture({ rows }); try { await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /唯一匹配|头像/); assert.equal(await f.page.evaluate(() => window.sent), 0); } finally { await f.cleanup(); }
  }
});

test('合成原生卡片只点击一次并精确回读作品 ID，收据持久化', async () => {
  const f = await fixture();
  try { const result = await f.forwarder.forward({ recipientId, expectedVideoId: '12345' }, { humanAuthorized: true }); assert.equal(result.confirmed, true); assert.equal(result.deliveryType, 'native-card'); assert.equal(result.messageId, card.id); assert.equal(result.videoId, '12345'); assert.equal(await f.page.evaluate(() => window.sent), 1); assert.equal(f.stats().verified, 1); const receipt = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'video-forward-receipts.json'))); assert.equal(receipt.operations[0].status, 'confirmed'); assert.equal(fs.existsSync(path.join(f.stateDir, 'video-forward.guard')), false); } finally { await f.cleanup(); }
});
test('视频分享的完整事务持共同锁，确认卡片也进入共同发出账本', async () => {
  const f = await fixture();
  try {
    const prepare = f.forwarder.prepareContact.bind(f.forwarder);
    f.forwarder.prepareContact = async (...args) => { assert.equal(fs.existsSync(path.join(f.stateDir, 'outbound-send.guard')), true); return prepare(...args); };
    const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true });
    assert.equal(result.confirmed, true); const rows = f.forwarder.outbound.history(recipientId); assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'video'); assert.equal(rows[0].messageId, card.id);
    assert.equal(fs.existsSync(path.join(f.stateDir, 'outbound-send.guard')), false);
  } finally { await f.cleanup(); }
});

test('点击前作品变化或时间到点都拒绝分享', async () => {
  for (const kind of ['video', 'expired']) {
    const f = await fixture({ gateHook: ({ gates }) => gates === 3 && kind === 'expired' ? { allowed: false, reason: '合成到点' } : { allowed: true } });
    try { if (kind === 'video') { const original = f.forwarder.gate.bind(f.forwarder); let calls = 0; f.forwarder.gate = async signal => { const result = await original(signal); if (++calls === 3) await f.page.evaluate(() => window.fixtureState.video.id = '999'); return result; }; } await assert.rejects(f.forwarder.forward({ recipientId, expectedVideoId: '12345' }, { humanAuthorized: true }), /切换|到点/); assert.equal(await f.page.evaluate(() => window.sent), 0); } finally { await f.cleanup(); }
  }
});

test('标记行被复用成另一好友，即使目标仍在原位置也不点击错误行', async () => {
  for (const mutationGate of [3, 4]) {
    const f = await fixture();
    try {
      const original = f.forwarder.gate.bind(f.forwarder); let calls = 0;
      f.forwarder.gate = async signal => {
        const result = await original(signal);
        if (++calls === mutationGate) await f.page.evaluate(() => {
          const old = document.querySelector('[data-deepseek-forward-id]');
          const replacement = old.cloneNode(true); replacement.removeAttribute('data-deepseek-forward-id');
          old.before(replacement);
          old.querySelector('.EnYt_IKl').textContent = '合成其他好友';
          old.querySelector('img').src = 'https://fixture.local/aweme/aweme-avatar/other-avatar.jpeg';
        });
        return result;
      };
      await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /昵称|头像|身份/);
      assert.equal(await f.page.evaluate(() => window.sent), 0);
      assert.equal(fs.existsSync(path.join(f.stateDir, 'video-forward-receipts.json')), false);
    } finally { await f.cleanup(); }
  }
});

test('最后一次门控期间取消操作，标记行仍正确也不分享', async () => {
  const f = await fixture(); const aborter = new AbortController();
  try {
    const original = f.forwarder.gate.bind(f.forwarder); let calls = 0;
    f.forwarder.gate = async signal => { const result = await original(signal); if (++calls === 4) aborter.abort(); return result; };
    await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true, signal: aborter.signal }), { name: 'AbortError' });
    assert.equal(await f.page.evaluate(() => window.sent), 0);
  } finally { await f.cleanup(); }
});

test('旧卡片或不同作品不作为成功证据，未确认记录阻止再次点击', async () => {
  const f = await fixture({ existing: [card], shareResult: [{ ...card, id: `msg:${'d'.repeat(64)}`, media: { type: 'shared-work', videoId: '999' } }] });
  try { const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true }); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.sent), 1); await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /未确认的转发记录/); assert.equal(await f.page.evaluate(() => window.sent), 1); } finally { await f.cleanup(); }
});

test('卡片没有 DOM 链接时通过指定新卡片打开结果核实作品', async () => {
  const f = await fixture({ shareResult: [{ ...card, media: { type: 'shared-work' } }] });
  try { const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true }); assert.equal(result.confirmed, true); assert.equal(f.stats().opened, 1); assert.equal(await f.page.evaluate(() => window.sent), 1); } finally { await f.cleanup(); }
});

test('补载的旧卡片以及两个相同作品新卡片不作为唯一转发回读', async () => {
  for (const shareResult of [[{ ...card, arrivalClassification: 'old-history' }], [card, { ...card, id: `msg:${'c'.repeat(64)}` }]]) {
    const f = await fixture({ shareResult });
    try { const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true }); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.sent), 1); } finally { await f.cleanup(); }
  }
});

test('没有原生分享界面时提示公开链接降级，不自动发送文字', async () => {
  const f = await fixture({ rows: [] });
  try { const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true }); assert.equal(result.needsFallback, true); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.sent), 0); } finally { await f.cleanup(); }
});

test('同一转发控制锁阻止并发入口，保留需要人工核对的锁', async () => {
  const f = await fixture();
  try { fs.writeFileSync(path.join(f.stateDir, 'video-forward.guard'), '{}'); await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /转发锁/); assert.equal(f.stats().verified, 0); assert.equal(fs.existsSync(path.join(f.stateDir, 'video-forward.guard')), true); } finally { await f.cleanup(); }
});

test('分享 DOM 仅读取身份和发送按钮，未返回会话预览', async () => {
  const f = await fixture();
  try { const panel = await f.page.evaluate(readForwardPanelDom); assert.equal(panel.rows[0].displayName, '合成好友甲'); assert.equal(panel.rows[0].sendLabel, '分享'); assert.equal(panel.rows[0].lastMessagePreview, undefined); assert.equal(panel.rows[0].message, undefined); } finally { await f.cleanup(); }
});
