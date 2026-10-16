import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { randomUUID } from 'node:crypto';
import { BrowserController, readPageState } from './core.mjs?v=9';
import { ChatBrowser } from './chat-browser.mjs?v=9';
import { OutboundCoordinator } from './outbound-send.mjs';
import { VideoLimits } from './video-limits.mjs';

const stop = signal => signal?.throwIfAborted();
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file); };

export function canonicalVideoUrl(value) {
  if (typeof value !== 'string' || value.length > 300) throw new TypeError('请提供抖音公开作品链接。');
  let url; try { url = new URL(value); } catch { throw new TypeError('作品链接格式不正确。'); }
  const id = /^\/video\/(\d+)\/?$/.exec(url.pathname)?.[1];
  if (url.protocol !== 'https:' || url.hostname !== 'www.douyin.com' || url.port || url.username || url.password || !id) throw new TypeError('只接受 https://www.douyin.com/video/数字 的公开作品链接。');
  return { videoId: id, url: `https://www.douyin.com/video/${id}` };
}

// 同一头像在聊天和分享面板使用不同代理前缀与图片格式，保留资源路径核对。
export function forwardAvatarIdentity(value) {
  let pathname; try { pathname = new URL(value, 'https://www.douyin.com').pathname; } catch { return ''; }
  pathname = pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/');
  const resource = pathname.split('/aweme-avatar/')[1];
  return resource ? `aweme-avatar/${resource.replace(/\.(?:jpeg|jpg|png|webp)$/i, '')}` : pathname;
}

export function readForwardPanelDom() {
  const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden'; };
  const rows = [];
  for (const [panelIndex, panel] of [...document.querySelectorAll('[data-e2e="video-share-container"]')].entries()) {
    for (const [rowIndex, row] of [...panel.querySelectorAll('.otFjqQEX,[data-e2e="share-friend-row"]')].entries()) {
      if (!visible(row)) continue;
      const button = row.querySelector('.xu0OjnsQ,[data-e2e="share-friend-send"]');
      rows.push({ panelIndex, rowIndex, displayName: row.querySelector('.EnYt_IKl,[data-e2e="share-friend-name"]')?.textContent.trim() ?? '',
        avatar: row.querySelector('img')?.getAttribute('src') ?? '', sendLabel: button?.textContent.trim() ?? '',
        disabled: !button || button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true' });
    }
  }
  return { rows };
}

export function selectForwardRecipient(rows, contact) {
  const sameName = rows.filter(row => row.displayName === contact.displayName);
  if (sameName.length !== 1) throw new Error('分享面板中的好友昵称没有唯一匹配，已停止转发。');
  const row = sameName[0];
  const expected = forwardAvatarIdentity(contact.avatar), actual = forwardAvatarIdentity(row.avatar);
  if (!expected || !actual || actual !== expected) throw new Error('分享面板中的好友头像与已核对会话不一致，已停止转发。');
  if (row.disabled || !['分享', '发送'].includes(row.sendLabel)) throw new Error('好友的分享按钮不可用或已经发生变化，未点击发送。');
  return row;
}

function assertVideo(state, videoId) {
  if (state.loginRequired || state.verificationRequired || state.unsupportedPage || state.privateChatVisible) throw new Error('当前页面需要登录、验证或仍有私信遮挡，未转发。');
  if (!state.video?.id || state.video.readyState < 2 || (videoId && state.video.id !== videoId)) throw new Error('目标作品未就绪或已切换，未转发。');
  return canonicalVideoUrl(state.video.url ?? `https://www.douyin.com/video/${state.video.id}`);
}

function readMarkedRecipientDom(element) {
  const r = element.getBoundingClientRect(), s = getComputedStyle(element);
  const button = element.querySelector('.xu0OjnsQ,[data-e2e="share-friend-send"]');
  return { displayName: element.querySelector('.EnYt_IKl,[data-e2e="share-friend-name"]')?.textContent.trim() ?? '',
    avatar: element.querySelector('img')?.getAttribute('src') ?? '', sendLabel: button?.textContent.trim() ?? '',
    disabled: !element.isConnected || r.width <= 0 || r.height <= 0 || s.visibility === 'hidden' || s.display === 'none' || !button || button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true' };
}

function installInputWitness(button, token) {
  const entries = window.__deepseekForwardInputs ??= Object.create(null);
  const entry = { dispatched: false };
  const witness = event => { if (event.isTrusted && (event.target === button || button.contains(event.target))) entry.dispatched = true; };
  document.addEventListener('click', witness, true);
  entry.cleanup = () => document.removeEventListener('click', witness, true);
  entries[token] = entry;
}

export class VideoForwarder {
  constructor({ source = 'api', controller, chatBrowser, videoLimits, stateDir = resolveRuntimePaths().stateDir } = {}) {
    if (!['api', 'dsh'].includes(source)) throw new TypeError('视频转发入口只能是 api 或 dsh。');
    this.source = controller?.source === 'dsh' ? 'dsh' : source;
    this.videoLimits = videoLimits ?? controller?.videoLimits ?? new VideoLimits({ stateDir });
    this.controller = controller ?? new BrowserController({ source, videoLimits: this.videoLimits });
    this.chatBrowser = chatBrowser ?? new ChatBrowser({ source: this.source === 'dsh' ? 'dsh-chat' : 'api-chat' });
    this.ownsController = !controller; this.ownsChat = !chatBrowser;
    this.stateDir = stateDir; fs.mkdirSync(stateDir, { recursive: true });
    this.outbound = new OutboundCoordinator({ stateDir, source: this.source });
    this.policyFile = path.join(stateDir, 'chat-policy.json');
    this.receiptsFile = path.join(stateDir, 'video-forward-receipts.json');
    this.guardFile = path.join(stateDir, 'video-forward.guard');
  }
  policyContact(recipientId) {
    if (typeof recipientId !== 'string' || !/^conv:[a-f0-9]{64}$/.test(recipientId)) throw new TypeError('请在本机选择已核对的联系人。');
    let policy; try { policy = JSON.parse(fs.readFileSync(this.policyFile, 'utf8')); } catch { throw new Error('本机联系人白名单不可读，未转发。'); }
    if (!Array.isArray(policy.allowlist) || policy.allowlist.length > 2) throw new Error('本机固定联系人名单不符合当前授权范围。');
    const matched = policy.allowlist.filter(item => item.id === recipientId);
    if (matched.length !== 1 || matched[0].followed !== true || matched[0].isGroup !== false || !matched[0].verifiedAt) throw new Error('收件人不在已核对的两位好友名单内，未转发。');
    return matched[0];
  }
  async gate(signal) {
    stop(signal);
    const decision = this.videoLimits.beforeAction(this.source, 'douyin_forward_video');
    if (!decision.allowed) { await this.controller.pauseForLimits?.(); throw new Error(decision.reason || '当前时间不允许转发视频。'); }
    return decision;
  }
  receipts() {
    try { const value = JSON.parse(fs.readFileSync(this.receiptsFile, 'utf8')); if (!Array.isArray(value.operations)) throw new Error(); return value; }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, operations: [] }; throw new Error('转发收据不可读，需要人工核对，未再次发送。'); }
  }
  record(operation) { const value = this.receipts(); const index = value.operations.findIndex(item => item.operationId === operation.operationId); if (index < 0) value.operations.push(operation); else value.operations[index] = operation; write(this.receiptsFile, value); }
  acquire() {
    let descriptor; try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw new Error('另一项转发正在执行，或转发锁需要人工核对，未再次发送。'); throw error; }
    const token = randomUUID(); try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    return () => { try { const owner = JSON.parse(fs.readFileSync(this.guardFile, 'utf8')); if (owner.pid === process.pid && owner.token === token) fs.unlinkSync(this.guardFile); } catch {} };
  }
  async prepareContact(recipientId, signal) {
    const stored = this.policyContact(recipientId);
    const list = await this.chatBrowser.listContacts({ signal, verifyFollowing: true });
    if (list.blocked || list.loginRequired || list.verificationRequired) throw new Error('联系人关系核对需要登录或验证，未转发。');
    const contacts = list.contacts.filter(item => item.id === recipientId);
    if (contacts.length !== 1 || contacts[0].followed !== true || contacts[0].isGroup !== false || contacts[0].name !== stored.name) throw new Error('收件人的当前身份或关注关系与固定名单不一致，未转发。');
    const contact = this.chatBrowser.contacts.get(recipientId);
    if (!contact?.avatar || contact.displayName !== contacts[0].name) throw new Error('收件人的会话头像或昵称不可核对，未转发。');
    return contact;
  }
  async openPanel(page, signal) {
    stop(signal);
    const share = page.locator('[data-e2e="video-share-icon-container"]').filter({ visible: true });
    if (await share.count() !== 1) return false;
    const icon = share.locator('.s7K4YLGp');
    await (await icon.count() === 1 ? icon : share).hover();
    for (let i = 0; i < 12; i += 1) { stop(signal); if ((await page.evaluate(readForwardPanelDom)).rows.length) return true; await page.waitForTimeout(150); }
    return false;
  }
  async forward(input = {}, { signal, humanAuthorized = false } = {}) {
    if (humanAuthorized !== true) return { confirmed: false, deliveryUncertain: false, humanActionRequired: true, reason: '请在本机转发界面选择作品和好友，再点击转发。' };
    return this.#forward(input, { signal });
  }
  async forwardAutonomous({ recipientId, expectedVideoId, ...extra } = {}, { signal, authorize, autonomousRunId } = {}) {
    if (typeof authorize !== 'function') return { confirmed: false, deliveryUncertain: false, reason: '自主分享缺少可信的本机许可检查，未发送。' };
    if (Object.keys(extra).length || typeof expectedVideoId !== 'string' || !/^\d{1,64}$/.test(expectedVideoId)) throw new TypeError('自主分享只接受已观察的当前作品和已验证好友，不能指定其他链接或正文。');
    if (typeof authorize.beginDispatch !== 'function') return { confirmed: false, deliveryUncertain: false, reason: '自主分享缺少与本机设置互斥的最终输入许可，未发送。' };
    return this.#forward({ recipientId, expectedVideoId }, { signal, authorize, autonomousRunId });
  }
  async #forward(input = {}, options = {}) {
    return this.outbound.run({ recipientId: input.recipientId, purpose: 'video', signal: options.signal }, () => this.#sendTransaction(input, options));
  }
  async #sendTransaction({ recipientId, url, expectedVideoId } = {}, { signal: parentSignal, authorize, autonomousRunId } = {}) {
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const authorized = async phase => {
      if (authorize && await authorize({ phase, recipientId, videoId: expectedVideoId }) !== true) throw new Error('自主分享许可已撤回或检查未通过，未发送。');
      stop(signal);
    };
    await authorized('prepare');
    if (expectedVideoId !== undefined && (typeof expectedVideoId !== 'string' || !/^\d+$/.test(expectedVideoId))) throw new TypeError('目标作品 ID 格式不正确。');
    const target = url ? canonicalVideoUrl(url) : null;
    if (target && expectedVideoId && target.videoId !== expectedVideoId) throw new Error('链接与目标作品 ID 不一致，未转发。');
    await this.gate(signal);
    this.controller.watchVideoLimits?.();
    this.policyContact(recipientId);
    const release = this.acquire();
    const operation = { operationId: randomUUID(), recipientId, startedAt: new Date().toISOString(), status: 'preparing', sendClicks: 0 };
    let clicked = false;
    try {
      const contact = await this.prepareContact(recipientId, signal);
      const before = await this.chatBrowser.readConversation(recipientId, { allowed: true, signal });
      if (before.blocked || before.conversation?.id !== recipientId) throw new Error('指定会话的转发前快照未通过身份核对。');
      const beforeIds = new Set(before.messages.map(message => message.id));
      const newCardIds = new Set();
      const sendResult = await this.controller.withPage(async page => {
        await this.gate(signal);
        if (target) { await page.goto(target.url, { waitUntil: 'domcontentloaded' }); await this.controller.settle(signal, { kind: 'video', videoId: target.videoId }); }
        const video = assertVideo(await page.evaluate(readPageState), expectedVideoId ?? target?.videoId);
        operation.videoId = video.videoId;
        if (authorize && this.receipts().operations.some(item => item.recipientId === recipientId && item.videoId === video.videoId && item.status === 'confirmed')) throw new Error('这位好友已收到同一作品的已确认卡片，未自主重复分享。');
        if (this.receipts().operations.some(item => item.recipientId === recipientId && item.videoId === video.videoId && ['clicking', 'uncertain'].includes(item.status))) throw new Error('该好友与作品存在未确认的转发记录，请先人工核对，未再次发送。');
        if (!await this.openPanel(page, signal)) return { confirmed: false, deliveryUncertain: false, needsFallback: true, deliveryType: 'native-card', reason: '当前网页没有可核对的好友分享面板，可明确选择发送公开链接。' };
        const selected = selectForwardRecipient((await page.evaluate(readForwardPanelDom)).rows, contact);
        const row = page.locator('[data-e2e="video-share-container"]').nth(selected.panelIndex).locator('.otFjqQEX,[data-e2e="share-friend-row"]').nth(selected.rowIndex);
        await row.evaluate((element, id) => element.setAttribute('data-deepseek-forward-id', id), operation.operationId);
        await this.gate(signal);
        this.policyContact(recipientId);
        assertVideo(await page.evaluate(readPageState), video.videoId);
        const current = selectForwardRecipient((await page.evaluate(readForwardPanelDom)).rows, contact);
        if (current.panelIndex !== selected.panelIndex || current.rowIndex !== selected.rowIndex) throw new Error('分享面板的好友位置发生变化，未点击发送。');
        const marked = page.locator(`[data-e2e="video-share-container"] [data-deepseek-forward-id="${operation.operationId}"]`);
        if (await marked.count() !== 1) throw new Error('带标记的分享好友不是唯一匹配，未点击发送。');
        const send = marked.locator('.xu0OjnsQ,[data-e2e="share-friend-send"]');
        if (await send.count() !== 1) throw new Error('分享按钮不是唯一匹配，未点击发送。');
        await this.gate(signal);
        stop(signal);
        assertVideo(await page.evaluate(readPageState), video.videoId);
        const latest = selectForwardRecipient((await page.evaluate(readForwardPanelDom)).rows, contact);
        const markedIdentity = await marked.evaluate(readMarkedRecipientDom);
        selectForwardRecipient([markedIdentity], contact);
        if (markedIdentity.displayName !== latest.displayName || forwardAvatarIdentity(markedIdentity.avatar) !== forwardAvatarIdentity(latest.avatar)) throw new Error('带标记的分享行身份发生变化，未点击发送。');
        await send.evaluate(installInputWitness, operation.operationId);
        const inputDispatched = () => page.evaluate(token => window.__deepseekForwardInputs?.[token]?.dispatched === true, operation.operationId);
        const checkPendingInput = async () => {
          if (clicked && await inputDispatched()) return;
          await authorized('monitor');
          const time = this.videoLimits.state?.();
          if (time && !time.allowed) throw new Error(time.reason || '视频时限已结束，未继续输入。');
          this.policyContact(recipientId);
          assertVideo(await page.evaluate(readPageState), video.videoId);
          if (await marked.count() !== 1 || await send.count() !== 1) throw new Error('待发送好友或按钮已变化，未继续输入。');
          const latest = selectForwardRecipient((await page.evaluate(readForwardPanelDom)).rows, contact);
          const identity = await marked.evaluate(readMarkedRecipientDom);
          selectForwardRecipient([identity], contact);
          if (identity.displayName !== latest.displayName || forwardAvatarIdentity(identity.avatar) !== forwardAvatarIdentity(latest.avatar)) throw new Error('等待期间带标记的好友身份变化，未继续输入。');
          stop(signal);
        };
        let polling, monitoring = true, releaseDispatch;
        const monitor = setInterval(() => {
          if (!monitoring || polling) return;
          polling = checkPendingInput().catch(async error => {
            if (monitoring && !await inputDispatched().catch(() => false)) interrupt.abort(error);
          }).finally(() => { polling = null; });
        }, 40);
        try {
          await checkPendingInput();
          // 先等待真实按钮可操作；等待期间仍持续核对共享许可和当前 DOM。
          await send.click({ trial: true, timeout: 3000 });
          stop(signal);
          await checkPendingInput();
          await authorized('before-click');
          if (await inputDispatched()) throw new Error('等待期间已发生分享输入，未再点击一次。');
          if (authorize) releaseDispatch = await authorize.beginDispatch();
          stop(signal);
          operation.status = 'clicking'; operation.sendClicks = 1; this.record(operation);
          clicked = true;
          // 真实输入只有一次；短最终输入仍受监测，结果不明时保留 uncertain 收据。
          await send.click({ timeout: 350, noWaitAfter: true });
          releaseDispatch?.(); releaseDispatch = null;
          stop(signal);
          if (!await inputDispatched()) throw new Error('没有核对到真实浏览器输入事件，分享结果待核对。');
        } finally {
          monitoring = false; clearInterval(monitor);
          releaseDispatch?.();
          await page.evaluate(token => {
            const entry = window.__deepseekForwardInputs?.[token];
            entry?.cleanup();
            if (window.__deepseekForwardInputs) delete window.__deepseekForwardInputs[token];
          }, operation.operationId).catch(() => {});
        }
        return { videoId: video.videoId };
      }, { signal, autonomousRunId });
      if (sendResult.needsFallback) return sendResult;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        stop(signal);
        const after = await this.chatBrowser.readConversation(recipientId, { allowed: true, signal });
        if (after.blocked || after.conversation?.id !== recipientId) break;
        for (const message of after.messages) if (!beforeIds.has(message.id) && message.arrivalClassification === 'new-tail') newCardIds.add(message.id);
        const candidates = after.messages.filter(message => newCardIds.has(message.id) && message.sender === 'outgoing' && message.media?.type === 'shared-work' && !message.failed && !message.pending);
        const matches = [];
        for (const candidate of candidates) {
          let observed = candidate.media.videoId;
          if (!observed && candidate.media.url) observed = canonicalVideoUrl(candidate.media.url).videoId;
          if (!observed) { await this.gate(signal); const resolved = await this.chatBrowser.openSharedVideo(recipientId, candidate.id, { allowed: true, signal }); if (!resolved.blocked) observed = resolved.videoId; }
          if (observed === sendResult.videoId) matches.push(candidate);
        }
        if (matches.length > 1) break;
        if (matches.length === 1) {
            const candidate = matches[0];
            const confirmed = { confirmed: true, deliveryUncertain: false, deliveryType: 'native-card', operationId: operation.operationId, videoId: sendResult.videoId, messageId: candidate.id };
            this.record({ ...operation, status: 'confirmed', completedAt: new Date().toISOString(), messageId: candidate.id });
            return confirmed;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() });
      return { confirmed: false, deliveryUncertain: true, deliveryType: 'native-card', operationId: operation.operationId, videoId: operation.videoId, reason: '已点击一次分享，但没有回读到对应作品的新发出卡片，请人工核对，未再次发送。' };
    } catch (error) {
      if (!clicked) throw error;
      const result = { confirmed: false, deliveryUncertain: true, deliveryType: 'native-card', operationId: operation.operationId, videoId: operation.videoId, reason: '分享点击后的结果未确认，请人工核对，未再次发送。' };
      try { this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() }); } catch { result.receiptWarning = '点击后的收据更新失败，需要人工核对。'; }
      return result;
    } finally { release(); }
  }
  async close() { if (this.ownsChat) await this.chatBrowser.close(); if (this.ownsController) await this.controller.close(); }
}
