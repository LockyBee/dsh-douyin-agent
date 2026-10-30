import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '../playwright-runtime.mjs';
import { createHash } from 'node:crypto';
import { readPageState } from '../core.mjs?v=9';
import { ChatBrowser } from '../chat-browser.mjs';
import { VideoForwarder, canonicalVideoUrl, forwardAvatarIdentity, readForwardPanelDom, selectForwardRecipient, safeForwardFailure } from '../video-forward.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
const hash = value => createHash('sha256').update(value).digest('hex');
const stable = (nativeId, isGroup = false) => ({ id: `conv:${hash(`native:${nativeId}`)}`, nativeId, isGroup, identityVersion: 2, identityVerified: true, identityKind: 'native-conversation', identityHash: hash(`native:${nativeId}`), identityBinding: `binding:${hash(`${isGroup ? 'group' : 'direct'}\0native:${nativeId}`)}` });
const recipientId = stable('fixture-person').id;
const contact = { ...stable('fixture-person'), name: '合成好友甲', displayName: '合成好友甲', followed: true, avatar: '/img/aweme-avatar/fixture-avatar' };
const card = { id: `msg:${'b'.repeat(64)}`, sender: 'outgoing', arrivalClassification: 'new-tail', media: { type: 'shared-work', videoId: '12345', url: 'https://www.douyin.com/video/12345' } };
const autonomousAuthorization = () => { const authorize = () => true; authorize.beginDispatch = () => () => {}; return authorize; };

async function fixture({ rows = [{ name: '合成好友甲', avatar: 'https://fixture.local/aweme/aweme-avatar/fixture-avatar.jpeg', label: '分享' }], follow = true, shareResult = [card], existing = [], gateHook, contactData = contact } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-forward-test-'));
  fs.writeFileSync(path.join(stateDir, 'chat-policy.json'), JSON.stringify({ allowlist: [{ ...contactData, verifiedAt: '2026-10-14T00:00:00Z' }] }));
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill(route.request().resourceType() === 'document' ? { contentType: 'text/html', body: '<!doctype html><html><body></body></html>' } : { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>' }));
  await page.goto('https://www.douyin.com/video/12345');
  await page.setContent('<div data-e2e="video-share-icon-container"><div class="s7K4YLGp" style="width:40px;height:40px">分享</div><div data-e2e="video-share-container"></div></div>');
  await page.evaluate(({ rows, existing, shareResult }) => {
    document.body.insertAdjacentHTML('beforeend', '<section data-e2e="feed-active-video" class="video_12345"><video style="position:fixed;left:700px;top:10px;width:80px;height:50px"></video></section>');
    Object.defineProperty(document.querySelector('video'), 'readyState', { value: 4 });
    window.sent = 0; window.messages = existing; window.shareResult = shareResult;
    window.fixtureState = { video: { id: '12345', url: 'https://www.douyin.com/video/12345', readyState: 4 }, loginRequired: false, verificationRequired: false };
    const panel = document.querySelector('[data-e2e="video-share-container"]');
    for (const row of rows) {
      const item = document.createElement('div'); item.className = 'otFjqQEX';
      item.setAttribute('data-conversation-type', row.isGroup ? 'group' : 'direct');
      if (row.isGroup) { item.setAttribute('data-e2e', 'share-group-row'); }
      if (row.nativeId) item.setAttribute('data-conversation-id', row.nativeId);
      const image = document.createElement('img'); image.src = row.avatar; image.width = 30; image.height = 30;
      const name = document.createElement('span'); name.className = 'EnYt_IKl'; name.textContent = row.name;
      const send = document.createElement('div'); send.className = 'xu0OjnsQ'; send.textContent = row.label; send.style.cssText = 'width:70px;height:30px';
      send.addEventListener('click', () => { send.dataset.clicked = 'true'; window.sent += 1; window.messages = [...window.messages, ...window.shareResult]; });
      item.append(image, name, send); panel.append(item);
      if (row.groupMarker) { const group = document.createElement('div'); group.setAttribute('data-e2e', 'group-avatar'); item.append(group); }
    }
  }, { rows: rows.map(row => ({ ...row, nativeId: row.nativeId === undefined ? contactData.nativeId : row.nativeId })), existing, shareResult });
  let gates = 0, pauses = 0, verified = 0, opened = 0, connected = 0;
  const realEvaluate = page.evaluate.bind(page);
  page.evaluate = (fn, arg) => fn === readPageState ? realEvaluate(() => window.fixtureState) : realEvaluate(fn, arg);
  const controller = { source: 'api', withPage: async fn => { connected += 1; return fn(page); }, pauseForLimits: async () => { pauses += 1; }, settle: async () => {} };
  const chatBrowser = {
    contacts: new Map([[recipientId, contactData]]),
    listContacts: async options => { assert.equal(options.verifyFollowing, options.backgroundOnly !== true); verified += 1; return { contacts: [{ ...contactData, followed: follow }] }; },
    readConversation: async (id, options) => { assert.equal(id, recipientId); assert.equal(options.allowed, true); return { conversation: { id: recipientId }, messages: await realEvaluate(() => window.messages) }; },
    openSharedVideo: async (id, messageId, options) => { opened += 1; assert.equal(id, recipientId); assert.equal(options.allowed, true); return { videoId: '12345', url: 'https://www.douyin.com/video/12345' }; },
    sendMessage: async () => { throw new Error('测试禁止文字链接自动降级'); },
  };
  const videoLimits = { beforeAction: (source, name) => { assert.equal(source, 'api'); assert.equal(name, 'douyin_forward_video'); gates += 1; return gateHook?.({ gates, page }) ?? { allowed: true }; } };
  const forwarder = new VideoForwarder({ controller, chatBrowser, videoLimits, stateDir });
  return { page, forwarder, stateDir, stats: () => ({ gates, pauses, verified, opened, connected }), cleanup: async () => { await page.close(); fs.rmSync(stateDir, { recursive: true, force: true }); } };
}

test('长分享列表按稳定身份找到下方对象，只给目标发送一次原生卡片',async()=>{
  const rows=Array.from({length:60},(_,i)=>({name:`合成对象${i}`,nativeId:i===59?contact.nativeId:`synthetic-other-${i}`,avatar:'/avatar.png',label:'分享'}));
  const f=await fixture({rows});
  try{
    await f.page.evaluate(()=>{const panel=document.querySelector('[data-e2e="video-share-container"]');panel.style.cssText='height:180px;width:350px;overflow-y:auto';for(const row of panel.children)row.style.height='70px';document.addEventListener('click',e=>{window.lastInputTrusted=e.isTrusted;},{capture:true});});
    const result=await f.forwarder.forwardAutonomous({recipientId,expectedVideoId:'12345'},{authorize:autonomousAuthorization()});
    assert.equal(result.confirmed,true);assert.equal(await f.page.evaluate(()=>window.sent),1);assert.equal(await f.page.evaluate(()=>window.lastInputTrusted),true);
    assert.equal(await f.page.locator('[data-deepseek-forward-id]').getAttribute('data-conversation-id'),contact.nativeId);
    assert.ok(await f.page.locator('[data-e2e="video-share-container"]').evaluate(p=>p.scrollTop)>0);
  }finally{await f.cleanup();}
});

test('虚拟化分享列表有界遍历到未挂载对象，重绘后重新核对目标而非按昵称猜测',async()=>{
  const f=await fixture();
  try{
    await f.page.evaluate(nativeId=>{
      const panel=document.querySelector('[data-e2e="video-share-container"]');panel.innerHTML='';panel.style.cssText='height:180px;width:350px;overflow-y:auto;position:relative';
      const spacer=document.createElement('div');spacer.style.height='3500px';const windowEl=document.createElement('div');windowEl.style.cssText='position:absolute;left:0;right:0;top:0';panel.append(spacer,windowEl);
      const render=()=>{const first=Math.floor(panel.scrollTop/70);windowEl.style.top=first*70+'px';windowEl.innerHTML='';for(let i=first;i<Math.min(50,first+7);i++){
        const row=document.createElement('div');row.className='otFjqQEX';row.style.height='70px';row.dataset.conversationType='direct';row.dataset.conversationId=i===38?nativeId:'synthetic-row-'+i;
        row.innerHTML='<span class="EnYt_IKl">合成同名好友</span><div class="xu0OjnsQ" style="width:70px;height:30px">分享</div>';
        row.querySelector('.xu0OjnsQ').onclick=()=>{window.sent++;window.messages=[...window.messages,...window.shareResult];};windowEl.append(row);
      }};panel.addEventListener('scroll',render);render();
    },contact.nativeId);
    const result=await f.forwarder.forwardAutonomous({recipientId,expectedVideoId:'12345'},{authorize:autonomousAuthorization()});
    assert.equal(result.confirmed,true);assert.equal(await f.page.evaluate(()=>window.sent),1);
    assert.equal(await f.page.locator('[data-deepseek-forward-id]').getAttribute('data-conversation-id'),contact.nativeId);
  }finally{await f.cleanup();}
});

test('正式转发器在零授权零点击的身份或几何失败上出具绑定回执，最终输入后仍不明',async()=>{
  for(const mode of ['recipient','geometry']){
    const f=await fixture({rows:mode==='recipient'?[{name:'相同昵称但错误账号',nativeId:'unrelated',avatar:'/avatar.png',label:'分享'}]:undefined});
    try{
      if(mode==='geometry')await f.page.locator('.xu0OjnsQ').evaluate(e=>{e.style.pointerEvents='none';});
      let authorized=false;const authorize=({phase})=>{if(phase==='before-click')authorized=true;return true;};authorize.beginDispatch=()=>()=>{};
      await assert.rejects(f.forwarder.forwardAutonomous({recipientId,expectedVideoId:'12345'},{authorize}),error=>{
        assert.equal(error.preflight.sendClicks,0);assert.equal(error.preflight.dispatchAuthorized,false);assert.equal(error.preflight.recipientId,recipientId);assert.equal(error.preflight.videoId,'12345');assert.equal(error.preflight.failureStage,mode);return true;
      });
      assert.equal(authorized,false);assert.equal(await f.page.evaluate(()=>window.sent),0);assert.equal(f.forwarder.receipts().operations.at(-1).status,'not-sent');
    }finally{await f.cleanup();}
  }
});

test('可信人类入口未授权时只提示本机选择，不进入浏览器', async () => {
  const f = await fixture();
  try { const result = await f.forwarder.forward({ recipientId }); assert.equal(result.humanActionRequired, true); assert.equal(result.confirmed, false); assert.deepEqual(f.stats(), { gates: 0, pauses: 0, verified: 0, opened: 0, connected: 0 }); } finally { await f.cleanup(); }
});

test('后台分享准备复用现有稳定许可，不导航关注页或关闭已打开的消息面板', async () => {
  const f = await fixture(), chatPage = await browser.newPage();
  try {
    await chatPage.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    await chatPage.goto('https://www.douyin.com/');
    await chatPage.setContent('<section data-e2e="im-dialog" style="width:500px;height:400px"><div data-e2e="conversation-item" data-conversation-type="direct" data-conversation-id="fixture-person" style="width:400px;height:70px"><img src="/avatar.png" width="24" height="24"><span data-e2e="conversation-name">合成好友甲</span></div></section>');
    const controls = [], chat = new ChatBrowser({ controller: { withPage: async (fn, options) => { controls.push(options); return fn(chatPage); } } });
    chat.isForeground = async () => false;
    chat.verifyFollowing = async () => { assert.fail('后台分享不得重新导航关注页'); };
    f.forwarder.chatBrowser = chat;
    const selected = await f.forwarder.prepareContact(recipientId, undefined, { backgroundOnly: true });
    assert.equal(selected.id, recipientId); assert.equal(selected.followed, null);
    assert.equal(selected.identityBinding, contact.identityBinding); assert.equal(await chatPage.locator('[data-e2e="im-dialog"]').isVisible(), true);
    assert.equal(chatPage.url(), 'https://www.douyin.com/'); assert.equal(chat.following, null);
    assert.equal(controls.length, 1); assert.equal(controls[0].launch, false); assert.equal(controls[0].create, false);
    assert.equal(await f.page.evaluate(() => window.sent), 0);
  } finally { await chatPage.close(); await f.cleanup(); }
});

test('人工群混在许可中不阻断稳定好友分享，基线和卡片回读都只使用现有后台页', async () => {
  const f = await fixture();
  try {
    const policy = JSON.parse(fs.readFileSync(f.forwarder.policyFile));
    policy.allowlist.push({ id: `conv:${'e'.repeat(64)}`, name: '合成人工群', isGroup: true, identityVerified: false, authorizationKind: 'manual', verifiedAt: '2026-10-14T00:00:00Z', relationshipStatus: 'unavailable' });
    fs.writeFileSync(f.forwarder.policyFile, JSON.stringify(policy));
    const read = f.forwarder.chatBrowser.readConversation, options = [];
    f.forwarder.chatBrowser.readConversation = (id, controls) => { options.push(controls); assert.equal(controls.backgroundOnly, true); return read(id, controls); };
    const result = await f.forwarder.forwardAutonomous({ recipientId, expectedVideoId: '12345' }, { authorize: autonomousAuthorization() });
    assert.equal(result.confirmed, true); assert.equal(result.messageId, card.id); assert.equal(options.length, 2);
    assert.equal(await f.page.evaluate(() => window.sent), 1); assert.equal(f.forwarder.receipts().operations.at(-1).status, 'confirmed');
  } finally { await f.cleanup(); }
});

test('缺页或前台的准备失败附零发送证明，身份、未知、撤权错误不冒充可恢复缺页', async () => {
  for (const stage of ['contact-identity', 'conversation-baseline']) for (const code of ['CHAT_PAGE_NOT_OPEN', 'CHAT_FOREGROUND', 'CHAT_CONVERSATION_IDENTITY_MISMATCH', 'SYNTHETIC_UNKNOWN']) {
    const f = await fixture();
    try {
      const fail = async () => { throw Object.assign(new Error('合成准备失败'), { code }); };
      if (stage === 'contact-identity') f.forwarder.chatBrowser.listContacts = fail; else f.forwarder.chatBrowser.readConversation = fail;
      await assert.rejects(f.forwarder.forwardAutonomous({ recipientId, expectedVideoId: '12345' }, { authorize: autonomousAuthorization() }), error => {
        assert.equal(error.failure.code, code); assert.equal(error.failure.stage, stage);
        if (['CHAT_PAGE_NOT_OPEN', 'CHAT_FOREGROUND'].includes(code)) { assert.equal(error.preflight.sendClicks, 0); assert.equal(error.preflight.dispatchAuthorized, false); assert.equal(error.preflight.videoId, '12345'); assert.equal(error.preflight.recipientId, recipientId); }
        else assert.equal(error.preflight, undefined);
        return true;
      });
      assert.equal(await f.page.evaluate(() => window.sent), 0); assert.equal(f.stats().connected, 0);
      const record = f.forwarder.receipts().operations.at(-1); assert.equal(record.status, 'not-sent'); assert.equal(record.sendClicks, 0);
    } finally { await f.cleanup(); }
  }
});

test('自主分享卡片缺少作品身份时保留 uncertain，不点击卡片导航或重新发送', async () => {
  const f = await fixture({ shareResult: [{ ...card, media: { type: 'shared-work' } }] });
  try {
    const result = await f.forwarder.forwardAutonomous({ recipientId, expectedVideoId: '12345' }, { authorize: autonomousAuthorization() });
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(result.failure.stage, 'receipt');
    assert.equal(await f.page.evaluate(() => window.sent), 1); assert.equal(f.stats().opened, 0);
    assert.equal(f.forwarder.receipts().operations.at(-1).status, 'uncertain');
    await assert.rejects(f.forwarder.forwardAutonomous({ recipientId, expectedVideoId: '12345' }, { authorize: autonomousAuthorization() }), /未确认/);
    assert.equal(await f.page.evaluate(() => window.sent), 1);
  } finally { await f.cleanup(); }
});

test('可信点击后的缺页或前台错误属于回执不确定，不生成零发送恢复证明', async () => {
  for (const code of ['CHAT_PAGE_NOT_OPEN', 'CHAT_FOREGROUND']) {
    const f = await fixture();
    try {
      const read = f.forwarder.chatBrowser.readConversation; let reads = 0;
      f.forwarder.chatBrowser.readConversation = async (...args) => { if (++reads > 1) throw Object.assign(new Error('合成发送后消息页不可用'), { code }); return read(...args); };
      const result = await f.forwarder.forwardAutonomous({ recipientId, expectedVideoId: '12345' }, { authorize: autonomousAuthorization() });
      assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(result.preflight, undefined);
      assert.equal(result.failure.code, code); assert.equal(result.failure.stage, 'receipt'); assert.equal(await f.page.evaluate(() => window.sent), 1);
      const record = f.forwarder.receipts().operations.at(-1); assert.equal(record.status, 'uncertain'); assert.equal(record.sendClicks, 1); assert.equal(record.preflight, undefined);
    } finally { await f.cleanup(); }
  }
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

test('分享只按稳定身份选择，重复同ID或同名同头像不同ID都不点击', async () => {
  for (const rows of [[{ name: '合成好友甲', avatar: contact.avatar, label: '分享' }, { name: '另一个显示名', avatar: contact.avatar, label: '分享' }], [{ name: '合成好友甲', avatar: contact.avatar, nativeId: 'another-stable-account', label: '分享' }]]) {
    const f = await fixture({ rows }); try { await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /稳定身份/); assert.equal(await f.page.evaluate(() => window.sent), 0); } finally { await f.cleanup(); }
  }
});

test('同稳定账号更换昵称和头像仍可分享，不依赖外观作身份回退', async () => {
  const f = await fixture({ rows: [{ name: '合成更新昵称', avatar: 'https://fixture.local/aweme-avatar/changed.png', label: '分享' }] });
  try { assert.equal((await f.forwarder.forward({ recipientId }, { humanAuthorized: true })).confirmed, true); assert.equal(await f.page.evaluate(() => window.sent), 1); } finally { await f.cleanup(); }
});

test('合成原生卡片只点击一次并精确回读作品 ID，收据持久化', async () => {
  const f = await fixture();
  try { const result = await f.forwarder.forward({ recipientId, expectedVideoId: '12345' }, { humanAuthorized: true }); assert.equal(result.confirmed, true); assert.equal(result.deliveryType, 'native-card'); assert.equal(result.messageId, card.id); assert.equal(result.videoId, '12345'); assert.equal(await f.page.evaluate(() => window.sent), 1); assert.equal(f.stats().verified, 1); const receipt = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'video-forward-receipts.json'))); assert.equal(receipt.operations[0].status, 'confirmed'); assert.equal(fs.existsSync(path.join(f.stateDir, 'video-forward.guard')), false); } finally { await f.cleanup(); }
});

test('后台低RAF分享仍通过真实几何和中心命中，只产生一次可信输入', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => { window.requestAnimationFrame = () => 0; window.trustedShares = 0; document.querySelector('.xu0OjnsQ').addEventListener('click', event => { if (event.isTrusted) window.trustedShares += 1; }); });
    const result = await f.forwarder.forward({ recipientId, expectedVideoId: '12345' }, { humanAuthorized: true });
    assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.sent), 1); assert.equal(await f.page.evaluate(() => window.trustedShares), 1);
  } finally { await f.cleanup(); }
});

test('分享几何检查拒绝遮挡移动，最终许可后换控件换好友或换作品也不点击', async () => {
  for (const mode of ['covered', 'moving', 'replace-final', 'friend-final', 'video-final', 'move-final', 'cover-final']) {
    const f = await fixture(); let prepared = false;
    try {
      await f.page.evaluate(() => { window.anyTrustedShares = 0; document.addEventListener('click', event => { if (event.isTrusted && event.target.closest('.xu0OjnsQ')) window.anyTrustedShares += 1; }, true); });
      const alter = kind => {
        const send = document.querySelector('.xu0OjnsQ');
        if (kind === 'covered' || kind === 'cover-final') { const r = send.getBoundingClientRect(), cover = document.createElement('div'); cover.style.cssText = `position:fixed;z-index:999999;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;background:black`; document.body.append(cover); }
        else if (kind === 'moving') send.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(300px)' }], { duration: 700, iterations: Infinity, direction: 'alternate' });
        else if (kind === 'replace-final') { const next = send.cloneNode(true); next.removeAttribute('data-deepseek-forward-token'); send.replaceWith(next); }
        else if (kind === 'friend-final') { document.querySelector('.otFjqQEX').setAttribute('data-conversation-id', 'changed-stable-account'); }
        else if (kind === 'video-final') window.fixtureState.video.id = '54321';
        else send.style.marginLeft = '150px';
      };
      const authorize = async ({ phase }) => { if (phase === 'monitor' && !prepared && ['covered', 'moving'].includes(mode)) { prepared = true; await f.page.evaluate(alter, mode); } return true; };
      authorize.beginDispatch = async () => { if (mode.endsWith('-final')) await f.page.evaluate(alter, mode); return () => {}; };
      await assert.rejects(f.forwarder.forwardAutonomous({ recipientId, expectedVideoId: '12345' }, { authorize }), /几何|控件|昵称|头像|身份|切换/, mode);
      assert.equal(await f.page.evaluate(() => window.sent), 0, mode); assert.equal(await f.page.evaluate(() => window.anyTrustedShares), 0, mode);
      assert.equal(f.forwarder.receipts().operations.at(-1).status, 'not-sent', mode);
    } finally { await f.cleanup(); }
  }
});

test('分享的最终短输入许可一直持有到唯一可信鼠标点击完成，随后释放', async () => {
  const f = await fixture(); let held = false, began = 0, released = 0, settled = false, clicks = 0;
  const prototype = Object.getPrototypeOf(f.page.mouse), original = prototype.click;
  try {
    prototype.click = async function(x, y, options) {
      if (this !== f.page.mouse) return original.apply(this, arguments);
      assert.equal(held, true); assert.equal(released, 0); assert.equal(options?.delay || 0, 0); assert.equal(options?.clickCount || 1, 1); clicks += 1;
      const result = await original.apply(this, arguments); assert.equal(held, true); settled = true; return result;
    };
    const authorize = () => true;
    authorize.beginDispatch = () => { assert.equal(held, false); held = true; began += 1; return () => { assert.equal(held, true); assert.equal(settled, true); held = false; released += 1; }; };
    const result = await f.forwarder.forwardAutonomous({ recipientId, expectedVideoId: '12345' }, { authorize });
    assert.equal(result.confirmed, true); assert.equal(clicks, 1); assert.equal(began, 1); assert.equal(released, 1); assert.equal(held, false); assert.equal(await f.page.evaluate(() => window.sent), 1);
  } finally { prototype.click = original; await f.cleanup(); }
});

test('显式授权的现有个人会话绑定可转发，身份绑定变化则不点击', async () => {
  const authorized = { ...contact, followed: null, relationshipStatus: 'unavailable', authorizationKind: 'existing-conversation' };
  for (const changed of [false, true]) {
    const f = await fixture({ follow: null, contactData: authorized });
    try {
      if (changed) f.forwarder.chatBrowser.listContacts = async () => ({ contacts: [{ ...authorized, identityBinding: `binding:${'e'.repeat(64)}` }] });
      if (changed) {
        await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /身份或关注关系/);
        assert.equal(await f.page.evaluate(() => window.sent), 0);
      } else {
        const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true });
        assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.sent), 1);
      }
    } finally { await f.cleanup(); }
  }
});

test('显式许可群聊只匹配真实群聊行，不向同名个人发送', async () => {
  const group = { ...contact, ...stable(contact.nativeId, true), name: '合成群聊', displayName: '合成群聊', followed: null, conversationType: 'group', avatar: 'group-marker', relationshipStatus: 'unavailable', authorizationKind: 'existing-group' };
  const f = await fixture({ follow: null, contactData: group, rows: [{ name: '合成群聊', avatar: 'https://fixture.local/personal.png', label: '分享' }, { name: '合成群聊', avatar: '', label: '分享', isGroup: true, nativeId: group.nativeId, groupMarker: true }] });
  try {
    const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true });
    assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.sent), 1);
    assert.equal(await f.page.locator('[data-e2e="share-group-row"] .xu0OjnsQ').getAttribute('data-clicked'), 'true');
    assert.equal(await f.page.locator('.otFjqQEX').first().locator('.xu0OjnsQ').getAttribute('data-clicked'), null);
  } finally { await f.cleanup(); }
});

test('没有群聊类型证据或稳定群身份的分享行拒绝匹配', () => {
  const group = { ...stable('synthetic-group', true), name: '同名会话', displayName: '同名会话', avatar: 'group-marker' };
  assert.throws(() => selectForwardRecipient([{ displayName: group.displayName, nativeId: group.nativeId, isGroup: false, sendTargetVerified: true, sendLabel: '分享', disabled: false }], group), /稳定身份/);
  assert.throws(() => selectForwardRecipient([{ displayName: group.displayName, isGroup: true, nativeId: 'another-group', sendTargetVerified: true, sendLabel: '分享', disabled: false }], group), /稳定身份/);
  assert.throws(() => selectForwardRecipient([{ displayName: group.displayName, isGroup: true, sendTargetVerified: true, sendLabel: '分享', disabled: false }], group), /稳定身份/);
  assert.equal(forwardAvatarIdentity('group-avatar:["https://fixture.local/aweme/100x100/aweme-avatar/avatar-b.jpeg","/img/aweme-avatar/avatar-a"]'), forwardAvatarIdentity('group-avatar:["/img/aweme-avatar/avatar-a","/img/aweme-avatar/avatar-b"]'));
});

test('分享点击后先重新打开已授权会话再核对新卡片，不重复点击分享', async () => {
  const f = await fixture();
  try {
    const read = f.forwarder.chatBrowser.readConversation;
    const options = [];
    f.forwarder.chatBrowser.readConversation = async (id, opts) => {
      options.push({ ...opts });
      if (options.length > 1 && opts.refresh !== true) return { conversation: { id }, messages: [] };
      return read(id, opts);
    };
    const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true });
    assert.equal(result.confirmed, true); assert.equal(options[1].refresh, true);
    assert.equal(await f.page.evaluate(() => window.sent), 1);
  } finally { await f.cleanup(); }
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
          old.setAttribute('data-conversation-id', 'another-stable-account');
          old.querySelector('img').src = 'https://fixture.local/aweme/aweme-avatar/other-avatar.jpeg';
        });
        return result;
      };
      await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /昵称|头像|身份/);
      assert.equal(await f.page.evaluate(() => window.sent), 0);
      assert.equal(f.forwarder.receipts().operations.at(-1).status, 'not-sent');
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

async function currentPanelFixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-forward-current-')), page = await browser.newPage();
  const secUid = 'MS4SyntheticSelectedStableAccount', uid = '1234567890123456', key = `rendered:user:${hash(secUid)}`;
  const allowed = { ...contact, id: `conv:${hash(key)}`, identityKind: 'rendered-user', identityHash: hash(key), identityBinding: `binding:${hash(`direct\0${key}`)}`, verifiedAt: '2026-10-14T00:00:00Z' };
  delete allowed.nativeId;
  fs.writeFileSync(path.join(stateDir, 'chat-policy.json'), JSON.stringify({ allowlist: [allowed] }));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('https://www.douyin.com/video/12345');
  await page.setContent('<section data-e2e="feed-active-video"><div data-e2e="video-player-share" style="width:60px;height:40px">分享</div></section><div data-e2e="video-player-share">非当前作品分享</div><div class="lC5eOSqy" style="display:none;position:fixed;left:100px;top:100px;width:300px;height:230px;z-index:20;background:white"><h3 class="S874re0p">分享给朋友</h3><div class="VzoNDwLw"><div class="row-wrapper"><div class="otFjqQEX"><span class="EnYt_IKl">改过的合成昵称</span><div class="xu0OjnsQ" style="width:70px;height:32px">分享</div></div></div></div></div>');
  await page.evaluate(({ secUid, uid }) => {
    const video = document.createElement('video'); video.style.cssText = 'position:fixed;left:700px;top:10px;width:80px;height:50px'; document.querySelector('[data-e2e="feed-active-video"]').append(video); Object.defineProperty(video, 'readyState', { value: 4 });
    window.sent = 0; window.opened = 0; window.hiddenDataReads = 0;
    const row = document.querySelector('.otFjqQEX'), user = { type: 1, uid, sec_uid: secUid };
    Object.defineProperty(user, 'infoDict', { get() { window.hiddenDataReads++; throw new Error('禁止读取未展示资料'); } });
    row.parentElement.__reactProps$fixture = { children: { props: { user } } };
    row.__reactProps$fixture = { children: [{ props: {} }, { props: { children: [{ props: { children: [{ props: {} }, { props: { uid, isGroup: false } }] } }] } }, { props: { 'data-userid': uid } }] };
    const send = row.querySelector('.xu0OjnsQ'); send.dataset.userid = uid;
    send.addEventListener('click', event => { if (event.isTrusted) window.sent++; });
    document.querySelector('[data-e2e="feed-active-video"] [data-e2e="video-player-share"]').addEventListener('click', () => { window.opened++; document.querySelector('.lC5eOSqy').style.display = 'block'; });
  }, { secUid, uid });
  const realEvaluate = page.evaluate.bind(page);
  page.evaluate = (fn, arg) => fn === readPageState ? Promise.resolve({ video: { id: '12345', url: 'https://www.douyin.com/video/12345', readyState: 4 } }) : realEvaluate(fn, arg);
  const chatBrowser = { contacts: new Map([[allowed.id, allowed]]), listContacts: async () => ({ contacts: [allowed] }), readConversation: async () => ({ conversation: { id: allowed.id }, messages: await realEvaluate(() => window.sent) ? [card] : [] }) };
  const forwarder = new VideoForwarder({ controller: { source: 'api', withPage: fn => fn(page), pauseForLimits: async () => {} }, chatBrowser, videoLimits: { beforeAction: () => ({ allowed: true }) }, stateDir });
  return { page, forwarder, allowed, secUid, uid, cleanup: async () => { await page.close(); const target = path.resolve(stateDir); assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(target, { recursive: true, force: true }); } };
}

test('当前真实分享UI结构按固定user稳定ID绑定发送目标，打开面板后只发送一次卡片', async () => {
  const f = await currentPanelFixture();
  try {
    const result = await f.forwarder.forward({ recipientId: f.allowed.id, expectedVideoId: '12345' }, { humanAuthorized: true });
    assert.equal(result.confirmed, true); assert.equal(result.deliveryUncertain, false);
    assert.deepEqual(await f.page.evaluate(() => ({ sent: window.sent, opened: window.opened, hiddenDataReads: window.hiddenDataReads })), { sent: 1, opened: 1, hiddenDataReads: 0 });
    assert.equal(f.forwarder.receipts().operations[0].status, 'confirmed');
  } finally { await f.cleanup(); }
});

test('当前分享行不同secUID、按钮uid冲突、类型冲突和缺少固定身份均拒绝且记录具体阶段', async () => {
  for (const mutation of ['secUid', 'buttonUid', 'type', 'missing', 'getter']) {
    const f = await currentPanelFixture();
    try {
      await f.page.evaluate(mutation => {
        const row = document.querySelector('.otFjqQEX'), user = row.parentElement.__reactProps$fixture.children.props.user;
        if (mutation === 'secUid') user.sec_uid = 'MS4SyntheticDifferentAccount';
        if (mutation === 'buttonUid') row.querySelector('.xu0OjnsQ').dataset.userid = '9999999999999999';
        if (mutation === 'type') row.setAttribute('data-conversation-type', 'group');
        if (mutation === 'missing') delete user.sec_uid;
        if (mutation === 'getter') Object.defineProperty(user, 'sec_uid', { get() { throw new Error('不允许执行身份getter'); } });
      }, mutation);
      await assert.rejects(f.forwarder.forward({ recipientId: f.allowed.id }, { humanAuthorized: true }), /稳定身份|目标标识/, mutation);
      assert.equal(await f.page.evaluate(() => window.sent), 0, mutation);
      const receipt = f.forwarder.receipts().operations[0]; assert.equal(receipt.status, 'not-sent'); assert.equal(receipt.sendClicks, 0);
      assert.equal(receipt.failure.code, 'FORWARD_RECIPIENT_IDENTITY_MISMATCH'); assert.equal(receipt.failure.stage, 'recipient');
      assert.equal(await f.page.evaluate(() => window.hiddenDataReads), 0);
    } finally { await f.cleanup(); }
  }
});

test('真实pointerdown后同DOM行改成其他稳定账号、换作品或出现验证码，最终click被同步门禁拦截', async () => {
  for (const mode of ['native-account', 'native-button-uid', 'rendered-account', 'video', 'captcha']) {
    const f = mode.startsWith('native-') ? await fixture() : await currentPanelFixture(), id = f.allowed?.id || recipientId;
    try {
      await f.page.evaluate(mode => {
        const row = document.querySelector('.otFjqQEX'), send = row.querySelector('.xu0OjnsQ');
        send.addEventListener('pointerdown', () => {
          if (mode === 'native-account') row.setAttribute('data-conversation-id', 'changed-account-during-pointerdown');
          if (mode === 'native-button-uid') send.dataset.userid = '7777777777777777';
          if (mode === 'rendered-account') {
            const user = row.parentElement.__reactProps$fixture.children.props.user; user.sec_uid = 'MS4SyntheticOtherDuringPointerdown'; user.uid = '7777777777777777'; send.dataset.userid = user.uid;
            row.__reactProps$fixture.children[1].props.children[0].props.children[1].props.uid = user.uid;
          }
          if (mode === 'video') document.querySelector('[data-e2e="feed-active-video"]').className = 'video_99999';
          if (mode === 'captcha') { const captcha = document.createElement('div'); captcha.id = 'captcha_container'; captcha.style.cssText = 'position:fixed;left:800px;top:20px;width:80px;height:50px'; document.body.append(captcha); }
        }, { once: true });
      }, mode);
      const result = await f.forwarder.forward({ recipientId: id, expectedVideoId: '12345' }, { humanAuthorized: true });
      assert.equal(result.confirmed, false, mode); assert.equal(result.deliveryUncertain, true, mode); assert.equal(result.failure.code, 'FORWARD_INPUT_IDENTITY_CHANGED', mode); assert.equal(result.failure.stage, 'dispatch', mode);
      assert.equal(await f.page.evaluate(() => window.sent), 0, mode); assert.equal(f.forwarder.receipts().operations.at(-1).status, 'uncertain', mode);
    } finally { await f.cleanup(); }
  }
});

test('native行不能用row的稳定编号替代无法映射的显式按钮uid', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => { document.querySelector('.xu0OjnsQ').dataset.userid = '7777777777777777'; });
    await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /稳定身份|目标标识/); assert.equal(await f.page.evaluate(() => window.sent), 0);
  } finally { await f.cleanup(); }
});

test('最终事件只改变昵称仍按同一稳定账号发送，不把外观变化扩大成身份条件', async () => {
  const f = await currentPanelFixture();
  try {
    await f.page.evaluate(() => document.querySelector('.xu0OjnsQ').addEventListener('pointerdown', () => { document.querySelector('.EnYt_IKl').textContent = '点击前换了一个合成昵称'; }, { once: true }));
    const result = await f.forwarder.forward({ recipientId: f.allowed.id }, { humanAuthorized: true }); assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.sent), 1);
  } finally { await f.cleanup(); }
});

test('超过50个完整稳定许可仍可选择，重复或不完整许可名单不放行', async () => {
  const f = await fixture();
  try {
    const many = [contact, ...Array.from({ length: 60 }, (_, index) => ({ ...contact, ...stable(`合成其他账号${index}`) }))].map(item => ({ ...item, verifiedAt: '2026-10-14T00:00:00Z' }));
    fs.writeFileSync(f.forwarder.policyFile, JSON.stringify({ allowlist: many })); assert.equal(f.forwarder.policyContact(recipientId).id, recipientId);
    const manualGroup = { id: `conv:${'c'.repeat(64)}`, name: '合成人工群', isGroup: true, identityVerified: false, authorizationKind: 'manual', verifiedAt: '2026-10-14T00:00:00Z', relationshipStatus: 'unavailable' };
    fs.writeFileSync(f.forwarder.policyFile, JSON.stringify({ allowlist: [{ ...contact, verifiedAt: '2026-10-14T00:00:00Z' }, manualGroup] }));
    assert.equal(f.forwarder.policyContact(recipientId).id, recipientId);
    assert.throws(() => f.forwarder.policyContact(manualGroup.id), error => error.code === 'FORWARD_IDENTITY_REQUIRED');
    fs.writeFileSync(f.forwarder.policyFile, JSON.stringify({ allowlist: [...many, many[0]] })); assert.throws(() => f.forwarder.policyContact(recipientId), /名单/);
    delete many[1].identityHash; fs.writeFileSync(f.forwarder.policyFile, JSON.stringify({ allowlist: many })); assert.throws(() => f.forwarder.policyContact(recipientId), /名单/);
  } finally { await f.cleanup(); }
});

test('分享失败诊断保留阶段原因并隐藏凭据、平台原标识和本地路径', () => {
  const failure = safeForwardFailure({ code: 'FORWARD_SYNTHETIC_FAILURE', stage: 'recipient', message: `合成原因 token=private-token Cookie=private-cookie Bearer private-bearer sk-private-key https://example.invalid/private C:\\private\\key.txt MS4PrivateAccount ${'a'.repeat(64)} 1234567890123456\n后续内容不保留` });
  assert.equal(failure.code, 'FORWARD_SYNTHETIC_FAILURE'); assert.equal(failure.stage, 'recipient'); assert.match(failure.message, /合成原因/);
  for (const secret of ['private-token', 'private-cookie', 'private-bearer', 'sk-private-key', 'example.invalid', 'key.txt', 'MS4PrivateAccount', 'a'.repeat(64), '1234567890123456', '后续内容']) assert.equal(failure.message.includes(secret), false, secret);
});


import {readConversationDom as readNativeItemConversationDom} from '../chat-browser.mjs';

test('原生itemId收据补测：真实读取合成DOM无href卡片，经稳定消息跟踪后确认新收据',async()=>{
  const f=await fixture(),chatPage=await browser.newPage(),reader=new ChatBrowser({voiceCaptureDir:f.stateDir,controller:{withPage:async action=>action(chatPage),close:async()=>{}}});
  try{
    await chatPage.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));await chatPage.goto('https://www.douyin.com/');
    await chatPage.evaluate(()=>{
      document.body.insertAdjacentHTML('beforeend','<div data-e2e="im-dialog"><div data-e2e="chat-page"><div data-e2e="chat-header" data-conversation-id="fixture-person" data-conversation-type="direct" style="height:35px"><span data-e2e="chat-title">合成好友甲</span></div><div data-e2e="message-list" style="display:flex;flex-direction:column-reverse"><div data-index="0"><div data-e2e="message-row" data-message-id="7111111111111111111" data-direction="incoming"><div data-e2e="msg-item-content"><span data-e2e="message-text">合成旧消息</span></div></div></div></div></div></div>');
    });
    f.forwarder.chatBrowser.readConversation=async(id,options)=>{
      assert.equal(id,recipientId);assert.equal(options.allowed,true);
      await chatPage.evaluate(sent=>{
        if(!sent||window.nativeReceiptMounted)return;
        window.nativeReceiptMounted=true;const list=document.querySelector('[data-e2e="message-list"]');list.firstElementChild.dataset.index='1';
        const wrapper=document.createElement('div');wrapper.dataset.index='0';wrapper.innerHTML='<div data-e2e="message-row" data-direction="outgoing"><div data-e2e="msg-item-content"><div class="MessageItemShareAwemecontainer"><span data-e2e="shared-video-title">合成原生分享</span></div></div></div>';
        const node=wrapper.querySelector('[data-e2e="msg-item-content"]'),prototype=Object.create(null);Object.defineProperties(prototype,{conversationId:{value:'fixture-person'},serverId:{value:'7222222222222222222'},createdAt:{value:new Date()}});
        const message=Object.create(prototype);Object.defineProperty(message,'_parsedContent',{value:{itemId:'12345'}});Object.defineProperty(node,'__reactProps$nativeReceipt',{value:{children:[{props:{message}}]}});list.prepend(wrapper);
      },await f.page.evaluate(()=>window.sent));
      const raw=await chatPage.evaluate(readNativeItemConversationDom);return{conversation:{id:recipientId},messages:reader.publicMessages(recipientId,raw.messages)};
    };
    const result=await f.forwarder.forwardAutonomous({recipientId,expectedVideoId:'12345'},{authorize:autonomousAuthorization()});assert.equal(result.confirmed,true,JSON.stringify(result));assert.equal(await f.page.evaluate(()=>window.sent),1);assert.equal(f.stats().opened,0);assert.equal(f.forwarder.receipts().operations.at(-1).status,'confirmed');
  }finally{await chatPage.close();await f.cleanup();}
});

test('原生itemId收据补测：已由绑定消息读取的native作品身份可匹配新发卡片一次',async()=>{
  const f=await fixture({shareResult:[{...card,media:{type:'shared-work',videoId:'12345',url:'https://www.douyin.com/video/12345',publicUrlSource:'rendered-message-item-id',identityConflict:false}}]});
  try{const result=await f.forwarder.forwardAutonomous({recipientId,expectedVideoId:'12345'},{authorize:autonomousAuthorization()});assert.equal(result.confirmed,true);assert.equal(await f.page.evaluate(()=>window.sent),1);assert.equal(f.stats().opened,0);assert.equal(f.forwarder.receipts().operations.at(-1).status,'confirmed');}finally{await f.cleanup();}
});
for(const human of [false,true])test(`原生itemId收据补测：${human?'本人':'自主'}分享遇DOM/native冲突均uncertain，不点击卡片补证`,async()=>{
  const cases=[{videoId:'12345',url:'https://www.douyin.com/video/99999'},{videoId:'12345',url:'https://www.douyin.com/video/12345',identityConflict:true},{videoId:'12345',url:'https://fixture:credential@www.douyin.com/video/12345'},{videoId:'12345',url:'https://untrusted.invalid/video/12345'},{videoId:'1'.repeat(65)}];
  for(const media of cases){const f=await fixture({shareResult:[{...card,media:{type:'shared-work',...media}}]});try{const result=human?await f.forwarder.forward({recipientId,expectedVideoId:'12345'},{humanAuthorized:true}):await f.forwarder.forwardAutonomous({recipientId,expectedVideoId:'12345'},{authorize:autonomousAuthorization()});assert.equal(result.confirmed,false);assert.equal(result.deliveryUncertain,true);assert.equal(await f.page.evaluate(()=>window.sent),1);assert.equal(f.stats().opened,0);assert.equal(f.forwarder.receipts().operations.at(-1).status,'uncertain');}finally{await f.cleanup();}}
});
test('原生itemId收据补测：旧卡片、其他作品、pending和failed仍不是本次新发确认',async()=>{
  for(const change of ['old-id','other-video','pending','failed']){const next={...card,media:{type:'shared-work',videoId:'12345',url:'https://www.douyin.com/video/12345',publicUrlSource:'rendered-message-item-id'},...(change==='pending'?{pending:true}:change==='failed'?{failed:true}:{})};if(change==='other-video')next.media={...next.media,videoId:'99999',url:'https://www.douyin.com/video/99999'};const f=await fixture({existing:change==='old-id'?[next]:[],shareResult:[next]});try{const result=await f.forwarder.forwardAutonomous({recipientId,expectedVideoId:'12345'},{authorize:autonomousAuthorization()});assert.equal(result.confirmed,false);assert.equal(result.deliveryUncertain,true);assert.equal(await f.page.evaluate(()=>window.sent),1);assert.equal(f.stats().opened,0);}finally{await f.cleanup();}}
});
test('原生itemId收据补测：已结案resolved-confirmed字段不能代替本次平台新卡片',async()=>{
  const old={...card,arrivalClassification:'known-old-window',resolvedStatus:'resolved-confirmed',media:{type:'shared-work',videoId:'12345',url:'https://www.douyin.com/video/12345',publicUrlSource:'rendered-message-item-id'}};
  const f=await fixture({existing:[old],shareResult:[old]});try{const result=await f.forwarder.forwardAutonomous({recipientId,expectedVideoId:'12345'},{authorize:autonomousAuthorization()});assert.equal(result.confirmed,false);assert.equal(result.deliveryUncertain,true);assert.equal(await f.page.evaluate(()=>window.sent),1);assert.equal(f.stats().opened,0);}finally{await f.cleanup();}
});

import {checkReceiptBaseline as checkShareBaseline,matchShareReceiptBaseline as matchSavedShareBaseline} from '../receipt-baseline.mjs';
function installShareBaselineFault(file,mode){
  const originals={openSync:fs.openSync,writeFileSync:fs.writeFileSync,fsyncSync:fs.fsyncSync,renameSync:fs.renameSync},descriptors=new Set();
  fs.openSync=(target,...args)=>{const descriptor=originals.openSync(target,...args);if(typeof target==='string'&&target.startsWith(file+'.'))descriptors.add(descriptor);return descriptor;};
  fs.writeFileSync=(target,...args)=>{if(mode==='write'&&descriptors.has(target))throw Object.assign(Error('合成分享基线写失败'),{code:'EIO'});return originals.writeFileSync(target,...args);};
  fs.fsyncSync=descriptor=>{if(mode==='fsync'&&descriptors.has(descriptor))throw Object.assign(Error('合成分享基线刷盘失败'),{code:'EIO'});return originals.fsyncSync(descriptor);};
  fs.renameSync=(from,to)=>{if(mode==='rename'&&to===file)throw Object.assign(Error('合成分享基线原子换入失败'),{code:'EIO'});return originals.renameSync(from,to);};return()=>Object.assign(fs,originals);
}
test('持久基线分享：本人未知不阻断本次在线确认，但未来跨重启匹配明确不可用',async()=>{
  const old={...card,id:'msg:'+'c'.repeat(64)},f=await fixture({existing:[old]});try{const result=await f.forwarder.forwardAutonomous({recipientId,expectedVideoId:'12345'},{authorize:autonomousAuthorization()});assert.equal(result.confirmed,true);assert.equal(await f.page.evaluate(()=>window.sent),1);const row=f.forwarder.receipts().operations.at(-1);assert.equal(checkShareBaseline(row,'native-card').available,true);assert.equal(row.baseline.recheckable,false);assert.equal(row.baseline.reasonCode,'self-identity-unavailable');assert.deepEqual(row.baseline.knownIds,[old.id]);assert.equal(matchSavedShareBaseline({...row,status:'uncertain'},{ownProfileId:'synthetic-self-profile',contact,snapshots:[]}).available,false);}finally{await f.cleanup();}
});
test('持久基线分享：有本人身份时紧邻点击复核，点击前收据已包含稳定会话与旧ID',async()=>{
  const old={...card,id:'msg:'+'c'.repeat(64)},f=await fixture({existing:[old]});try{
    await f.page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<div class="tab-user_self"><a href="/user/synthetic-self-profile">我的</a></div>'));let checked=0;const click=f.page.mouse.click.bind(f.page.mouse);
    f.page.mouse.click=async(...args)=>{if(fs.existsSync(f.forwarder.receiptsFile)){const row=f.forwarder.receipts().operations.at(-1);assert.equal(row.status,'clicking');assert.equal(checkShareBaseline(row,'native-card').available,true);assert.equal(row.baseline.ownProfileHash,hash('synthetic-self-profile'));assert.equal(JSON.stringify(row.baseline).includes('synthetic-self-profile'),false);assert.equal(row.baseline.recheckable,true);assert.equal(row.baseline.contact.identityBinding,contact.identityBinding);assert.deepEqual(row.baseline.knownIds,[old.id]);checked++;}return click(...args);};
    const result=await f.forwarder.forwardAutonomous({recipientId,expectedVideoId:'12345'},{authorize:autonomousAuthorization()});assert.equal(result.confirmed,true);assert.equal(checked,1);assert.equal(await f.page.evaluate(()=>window.sent),1);assert.equal(checkShareBaseline(f.forwarder.receipts().operations.at(-1),'native-card').available,true);
  }finally{await f.cleanup();}
});
test('持久基线分享：已核实本人在最终许可间变化时零发送，未知本人兼容不被误作已核实',async()=>{
  const f=await fixture();try{await f.page.evaluate(()=>document.body.insertAdjacentHTML('beforeend','<div class="tab-user_self"><a href="/user/synthetic-self-profile">我的</a></div>'));const authorize=async({phase})=>{if(phase==='before-click')await f.page.locator('.tab-user_self a').evaluate(anchor=>anchor.href='/user/another-self-profile');return true;};authorize.beginDispatch=()=>()=>{};await assert.rejects(f.forwarder.forwardAutonomous({recipientId,expectedVideoId:'12345'},{authorize}),/本人身份/);assert.equal(await f.page.evaluate(()=>window.sent),0);assert.equal(f.forwarder.receipts().operations.at(-1).status,'not-sent');}finally{await f.cleanup();}
});
test('持久基线分享：写入、刷盘、换入失败均零发送点击，旧收据字节不变',async()=>{
  for(const mode of ['write','fsync','rename']){const f=await fixture();try{const legacy={version:1,operations:[{operationId:'legacy-share',recipientId,videoId:'88888',status:'uncertain'}]};fs.writeFileSync(f.forwarder.receiptsFile,JSON.stringify(legacy));const before=fs.readFileSync(f.forwarder.receiptsFile),restore=installShareBaselineFault(f.forwarder.receiptsFile,mode);try{await assert.rejects(f.forwarder.forwardAutonomous({recipientId,expectedVideoId:'12345'},{authorize:autonomousAuthorization()}),/失败/);}finally{restore();}assert.equal(await f.page.evaluate(()=>window.sent),0,mode);assert.deepEqual(fs.readFileSync(f.forwarder.receiptsFile),before,mode);assert.equal(fs.readdirSync(f.stateDir).some(name=>name.endsWith('.tmp')),false,mode);}finally{await f.cleanup();}}
});
test('持久基线分享：收据刷盘期间取消后不迟发，保留基线而不再次输入',async()=>{
  const f=await fixture(),abort=new AbortController();try{const record=f.forwarder.record.bind(f.forwarder);f.forwarder.record=operation=>{record(operation);if(operation.status==='clicking'&&operation.baseline)abort.abort(new Error('合成刷盘期间取消'));};let rejected;try{await f.forwarder.forwardAutonomous({recipientId,expectedVideoId:'12345'},{authorize:autonomousAuthorization(),signal:abort.signal});}catch(error){rejected=error;}assert.equal(await f.page.evaluate(()=>window.sent),0);assert.match(rejected?.message||'',/取消/);const row=f.forwarder.receipts().operations.at(-1);assert.equal(row.status,'not-sent');assert.equal(checkShareBaseline(row,'native-card').available,true);}finally{await f.cleanup();}
});
