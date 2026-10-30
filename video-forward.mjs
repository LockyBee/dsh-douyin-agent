import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { BrowserController, readPageState } from './core.mjs?v=9';
import { ChatBrowser } from './chat-browser.mjs?v=9';
import { hasStableConversationIdentity, isStoredContactAuthorized, matchesAuthorizedContact } from './contact-authorization.mjs';
import { OutboundCoordinator } from './outbound-send.mjs';
import { VideoLimits } from './video-limits.mjs';

const stop = signal => signal?.throwIfAborted();
import {writeDurableReceiptFile as write,createCommentReceiptBaseline,createShareReceiptBaseline,checkReceiptBaseline,preserveReceiptBaseline} from './receipt-baseline.mjs';
import {readCommentSelfIdentity} from './comment-browser.mjs';
import {isRecoverableSharePreflight} from './autonomous-share.mjs';

export function canonicalVideoUrl(value) {
  if (typeof value !== 'string' || value.length > 300) throw new TypeError('请提供抖音公开作品链接。');
  let url; try { url = new URL(value); } catch { throw new TypeError('作品链接格式不正确。'); }
  const id = /^\/video\/(\d+)\/?$/.exec(url.pathname)?.[1];
  if (url.protocol !== 'https:' || url.hostname !== 'www.douyin.com' || url.port || url.username || url.password || !id) throw new TypeError('只接受 https://www.douyin.com/video/数字 的公开作品链接。');
  return { videoId: id, url: `https://www.douyin.com/video/${id}` };
}

function sharedCardReceiptIdentity(media) {
  if (media?.type !== 'shared-work' || media.identityConflict === true) return { videoId: null, rejected: true };
  let direct = null, linked = null;
  if (media.videoId !== undefined && media.videoId !== null) {
    if (typeof media.videoId !== 'string' || !/^\d{1,64}$/.test(media.videoId)) return { videoId: null, rejected: true };
    direct = media.videoId;
  }
  if (media.url !== undefined && media.url !== null) {
    try { linked = canonicalVideoUrl(media.url).videoId; if (!/^\d{1,64}$/.test(linked)) return { videoId: null, rejected: true }; }
    catch { return { videoId: null, rejected: true }; }
  }
  if (direct && linked && direct !== linked) return { videoId: null, rejected: true };
  return { videoId: direct || linked, rejected: false };
}

// 同一头像在聊天和分享面板使用不同代理前缀与图片格式，保留资源路径核对。
export function forwardAvatarIdentity(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (value === 'group-marker') return value;
  if (typeof value === 'string' && value.startsWith('group-avatar:')) {
    try { const items = JSON.parse(value.slice(13)); return Array.isArray(items) && items.length && items.every(item => typeof item === 'string') ? `group-avatar:${JSON.stringify(items.map(forwardAvatarIdentity).sort())}` : ''; } catch { return ''; }
  }
  let pathname; try { pathname = new URL(value, 'https://www.douyin.com').pathname; } catch { return ''; }
  pathname = pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/');
  const resource = pathname.split('/aweme-avatar/')[1];
  return resource ? `aweme-avatar/${resource.replace(/\.(?:jpeg|jpg|png|webp)$/i, '')}` : pathname;
}

const panelSelector = '[data-e2e="video-share-container"],.lC5eOSqy';
const rowSelector = '.otFjqQEX,[data-e2e="share-friend-row"],[data-e2e="share-group-row"]';
const hash = value => createHash('sha256').update(value).digest('hex');
const boundedId = value => (typeof value === 'string' || Number.isSafeInteger(value)) && String(value).trim().length > 0 && String(value).trim().length <= 512 ? String(value).trim() : null;
export function safeForwardFailure(value, stage = 'prepare') {
  const code = /^[A-Z][A-Z0-9_]{1,79}$/.test(value?.code || '') ? value.code : 'FORWARD_' + String(stage).replace(/[^a-z0-9]/gi, '_').toUpperCase() + '_FAILED';
  const actualStage = /^[a-z][a-z0-9-]{0,39}$/.test(value?.stage || '') ? value.stage : stage;
  const message = String(value?.message || '分享未完成，请核对当前页面。').split('\n')[0].replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [凭据已隐藏]').replace(/\b(?:token|api[-_]?key|cookie|authorization)\s*[:=]\s*[^\s，。；]+/gi, '[凭据已隐藏]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[凭据已隐藏]').replace(/https?:\/\/[^\s，。；]+/gi, '[地址]').replace(/\b[A-Za-z]:\\[^\s，。；]+/g, '[本地路径]').replace(/\b(?:conv:|binding:)?[a-f0-9]{64}\b|MS4[A-Za-z0-9_-]+|\b\d{10,}\b/g, '[平台标识]').slice(0, 300);
  return { code, stage: actualStage, message };
}
function forwardRowKey(row, kind) {
  if (!row || row.identityConflict || typeof row.isGroup !== 'boolean') return null;
  const values = row.identity || {}, raw = kind === 'native-conversation' ? boundedId(row.nativeId) : kind === 'rendered-user' ? boundedId(values.secUid) : kind === 'rendered-user-id' ? boundedId(values.userId) : kind === 'rendered-group' ? boundedId(values.groupId) : kind === 'rendered-conversation' ? boundedId(values.conversationId) : kind === 'rendered-conversation-short' ? boundedId(values.conversationShortId) : null;
  return raw ? kind === 'native-conversation' ? `native:${raw}` : `rendered:${kind.slice(9)}:${hash(raw)}` : null;
}
export function readForwardPanelDom({ markedId, includeOffscreen = false } = {}) {
  const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const props = element => { if (!element) return null; const keys = Object.getOwnPropertyNames(element).filter(key => key.startsWith('__reactProps$')); return keys.length === 1 ? own(element, keys[0]) : null; };
  const child = (value, index) => { const children = own(value, 'children'); return own((Array.isArray(children) ? children : [children])[index], 'props'); };
  const id = value => (typeof value === 'string' || Number.isSafeInteger(value)) && String(value).trim().length > 0 && String(value).trim().length <= 512 ? String(value).trim() : null;
  const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden'; };
  const rows = [];
  for (const [panelIndex, panel] of [...document.querySelectorAll('[data-e2e="video-share-container"],.lC5eOSqy')].entries()) {
    if (!visible(panel) || !panel.matches('[data-e2e="video-share-container"]') && panel.querySelector('.S874re0p')?.textContent.trim() !== '分享给朋友') continue;
    for (const [rowIndex, row] of [...panel.querySelectorAll('.otFjqQEX,[data-e2e="share-friend-row"],[data-e2e="share-group-row"]')].entries()) {
      const style = getComputedStyle(row), bounds = row.getBoundingClientRect();
      const rendered = bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      if (!(includeOffscreen ? rendered : visible(row)) || markedId && row.getAttribute('data-deepseek-forward-id') !== markedId) continue;
      const button = row.querySelector('.xu0OjnsQ,[data-e2e="share-friend-send"],[data-e2e="share-group-send"]');
      const group = row.querySelector('[data-e2e="group-avatar"],[class*="GroupAvatar"]');
      // 只读当前渲染行父节点的固定 user props，不访问 infoDict、store 或其他会话正文。
      const userElement = own(props(row.parentElement), 'children'), user = !Array.isArray(userElement) ? own(own(userElement, 'props'), 'user') : null;
      const badge = child(child(child(props(row), 1), 0), 1), types = new Set();
      const declared = row.getAttribute('data-conversation-type');
      if (declared === 'direct' || row.getAttribute('data-is-group') === 'false') types.add(false);
      if (declared === 'group' || row.getAttribute('data-is-group') === 'true' || row.getAttribute('data-e2e') === 'share-group-row' || group) types.add(true);
      if (own(user, 'type') === 1) types.add(false);
      if (typeof own(user, 'isGroup') === 'boolean') types.add(own(user, 'isGroup'));
      if (typeof own(badge, 'isGroup') === 'boolean') types.add(own(badge, 'isGroup'));
      const isGroup = types.size === 1 ? [...types][0] : null;
      const userId = id(own(user, 'uid')), buttonUserId = id(button?.getAttribute('data-userid')), badgeUid = id(own(badge, 'uid'));
      const identity = { secUid: id(own(user, 'sec_uid')), userId, groupId: id(own(user, 'groupId')), conversationId: id(own(user, 'conversationId')), conversationShortId: id(own(badge, 'conversationShortId')) || id(own(user, 'conversationShortId')) };
      const images = [...(group?.querySelectorAll('img') ?? [])].map(image => image.getAttribute('src')).filter(Boolean).sort();
      rows.push({ panelIndex, rowIndex, displayName: row.querySelector('.EnYt_IKl,[data-e2e="share-friend-name"],[data-e2e="share-group-name"]')?.textContent.trim() ?? '',
        nativeId: id(row.getAttribute('data-conversation-id')) || id(row.getAttribute('data-conversation-short-id')), identity, buttonTargetId: buttonUserId,
        identityConflict: types.size !== 1 || Boolean(buttonUserId && !userId || userId && (buttonUserId !== userId || badgeUid && badgeUid !== userId)), sendTargetVerified: Boolean(userId ? buttonUserId === userId && (!badgeUid || badgeUid === userId) : !buttonUserId && (row.getAttribute('data-conversation-id') || row.getAttribute('data-conversation-short-id'))),
        isGroup, conversationType: isGroup === true ? 'group' : isGroup === false ? 'direct' : 'unknown',
        avatar: isGroup && images.length ? `group-avatar:${JSON.stringify(images)}` : isGroup && group ? 'group-marker' : row.querySelector('img')?.getAttribute('src') ?? '', sendLabel: button?.textContent.trim() ?? '',
        disabled: !button || button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true' });
    }
  }
  return { rows };
}

export function selectForwardRecipient(rows, contact) {
  if (!hasStableConversationIdentity(contact)) throw Object.assign(new Error('许可会话缺少完整稳定身份，未转发。'), { code: 'FORWARD_IDENTITY_REQUIRED', stage: 'recipient' });
  const matched = rows.filter(row => { const key = forwardRowKey(row, contact.identityKind); return key && row.isGroup === contact.isGroup && hash(key) === contact.identityHash && `binding:${hash(`${contact.isGroup ? 'group' : 'direct'}\0${key}`)}` === contact.identityBinding; });
  if (matched.length !== 1) throw Object.assign(new Error('分享面板没有唯一匹配许可稳定身份和类型的收件人，未转发。'), { code: 'FORWARD_RECIPIENT_IDENTITY_MISMATCH', stage: 'recipient', matchCount: matched.length });
  const row = matched[0];
  if (row.sendTargetVerified !== true) throw Object.assign(new Error('分享按钮的目标标识未与许可收件人绑定，未点击发送。'), { code: 'FORWARD_BUTTON_TARGET_MISMATCH', stage: 'recipient' });
  if (row.disabled || !['分享', '发送'].includes(row.sendLabel)) throw Object.assign(new Error('好友的分享按钮不可用或已经发生变化，未点击发送。'),{code:'FORWARD_BUTTON_UNAVAILABLE',stage:'recipient'});
  return row;
}

const sameForwardRow = (left, right, contact) => left.isGroup === right.isGroup && left.sendTargetVerified === true && right.sendTargetVerified === true && forwardRowKey(left, contact.identityKind) === forwardRowKey(right, contact.identityKind) && left.identity?.userId === right.identity?.userId && left.buttonTargetId === right.buttonTargetId;

function moveForwardList({ reset = false } = {}) {
  const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const panels = [...document.querySelectorAll('[data-e2e="video-share-container"],.lC5eOSqy')].filter(panel => visible(panel) && (panel.matches('[data-e2e="video-share-container"]') || panel.querySelector('.S874re0p')?.textContent.trim() === '分享给朋友') && panel.querySelector('.otFjqQEX,[data-e2e="share-friend-row"],[data-e2e="share-group-row"]'));
  if (panels.length !== 1) return { moved: false };
  const panel = panels[0], first = panel.querySelector('.otFjqQEX,[data-e2e="share-friend-row"],[data-e2e="share-group-row"]');
  let container = first.parentElement;
  while (container && panel.contains(container)) {
    if (/(auto|scroll)/.test(getComputedStyle(container).overflowY) && container.scrollHeight > container.clientHeight + 1) break;
    if (container === panel) { container = null; break; }
    container = container.parentElement;
  }
  if (!container) return { moved: false };
  const before = container.scrollTop, maximum = Math.max(0, container.scrollHeight - container.clientHeight);
  const target = reset && before > 0 ? 0 : Math.min(maximum, before + Math.max(1, Math.floor(container.clientHeight * 0.8)));
  container.scrollTo({ top: target, behavior: 'instant' });
  return { moved: Math.abs(container.scrollTop - before) > 0.5 };
}

function assertVideo(state, videoId) {
  if (state.loginRequired || state.verificationRequired || state.unsupportedPage || state.privateChatVisible) throw new Error('当前页面需要登录、验证或仍有私信遮挡，未转发。');
  if (!state.video?.id || state.video.readyState < 2 || (videoId && state.video.id !== videoId)) throw new Error('目标作品未就绪或已切换，未转发。');
  return canonicalVideoUrl(state.video.url ?? `https://www.douyin.com/video/${state.video.id}`);
}

function installInputWitness(button, { token, expected, videoId }, readState, readPanel) {
  const entries = window.__deepseekForwardInputs ??= Object.create(null);
  const entry = { armed: false, dispatched: false, blocked: false };
  button.setAttribute('data-deepseek-forward-token', token);
  const witness = event => {
    if (!entry.armed || !event.isTrusted) return;
    let valid = false;
    try {
      const state = readState(), rows = readPanel({ markedId: token }).rows, current = rows.length === 1 && rows[0];
      valid = !entry.blocked && !event.defaultPrevented && Date.now() - entry.armedAt < 1500 && button.isConnected && button.getAttribute('data-deepseek-forward-token') === token && (event.target === button || button.contains(event.target)) &&
        !state.loginRequired && !state.verificationRequired && !state.unsupportedPage && !state.privateChatVisible && !state.videoSelection?.ambiguous && state.video?.id === videoId && state.video.readyState >= 2 &&
        current && !current.identityConflict && current.sendTargetVerified === true && !current.disabled && ['分享', '发送'].includes(current.sendLabel) && current.isGroup === expected.isGroup && current.nativeId === expected.nativeId && current.buttonTargetId === expected.buttonTargetId &&
        ['secUid', 'userId', 'groupId', 'conversationId', 'conversationShortId'].every(key => current.identity?.[key] === expected.identity?.[key]);
    } catch { valid = false; }
    if (!valid) { entry.blocked = true; event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (event.type === 'click') { entry.dispatched = true; entry.armed = false; }
  };
  const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  for (const type of events) document.addEventListener(type, witness, { capture: true, passive: false });
  entry.cleanup = () => { for (const type of events) document.removeEventListener(type, witness, true); if (button.getAttribute('data-deepseek-forward-token') === token) button.removeAttribute('data-deepseek-forward-token'); };
  entries[token] = entry;
}

// 注入的三个函数都来自本仓库；事件阶段同步复用正式DOM解析，避免异步核验后身份被替换。
const installForwardWitness = new Function('button', 'options', `const readState=(${readPageState.toString()});const readPanel=(${readForwardPanelDom.toString()});return (${installInputWitness.toString()})(button,options,readState,readPanel);`);

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
    if (!Array.isArray(policy.allowlist) || new Set(policy.allowlist.map(item => item?.id)).size !== policy.allowlist.length || policy.allowlist.some(item => !isStoredContactAuthorized(item))) throw new Error('本机会话名单包含损坏或未授权的记录，未转发。');
    const matched = policy.allowlist.filter(item => item.id === recipientId);
    if (matched.length !== 1 || !isStoredContactAuthorized(matched[0])) throw new Error('收件人不在已核对的会话名单内，未转发。');
    if (!hasStableConversationIdentity(matched[0])) throw Object.assign(new Error('目标会话缺少完整稳定身份，不能作为原生卡片收件人。'), { code: 'FORWARD_IDENTITY_REQUIRED', stage: 'recipient' });
    return matched[0];
  }
  async gate(signal) {
    stop(signal);
    const decision = this.videoLimits.beforeAction(this.source, 'douyin_forward_video');
    if (!decision.allowed) { await this.controller.pauseForLimits?.(); throw new Error(decision.reason || '当前时间不允许转发视频。'); }
    return decision;
  }
  receipts() {
    try { const value = JSON.parse(fs.readFileSync(this.receiptsFile, 'utf8')); if (!Array.isArray(value.operations) || value.operations.some(item => item?.baseline && !checkReceiptBaseline(item, 'native-card').available)) throw new Error(); return value; }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, operations: [] }; throw new Error('转发收据不可读，需要人工核对，未再次发送。'); }
  }
  record(operation) { const value = this.receipts(); const index = value.operations.findIndex(item => item.operationId === operation.operationId), stored = preserveReceiptBaseline(index < 0 ? null : value.operations[index], operation, 'native-card'); if (index < 0) value.operations.push(stored); else value.operations[index] = stored; write(this.receiptsFile, value); }
  acquire() {
    let descriptor; try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw new Error('另一项转发正在执行，或转发锁需要人工核对，未再次发送。'); throw error; }
    const token = randomUUID(); try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    return () => { try { const owner = JSON.parse(fs.readFileSync(this.guardFile, 'utf8')); if (owner.pid === process.pid && owner.token === token) fs.unlinkSync(this.guardFile); } catch {} };
  }
  async prepareContact(recipientId, signal, { backgroundOnly = false } = {}) {
    const stored = this.policyContact(recipientId);
    const list = await this.chatBrowser.listContacts({ signal, verifyFollowing: !backgroundOnly, backgroundOnly });
    if (list.blocked || list.loginRequired || list.verificationRequired) throw new Error('联系人关系核对需要登录或验证，未转发。');
    // 后台分享沿用本机许可；未知关注关系不等于撤权，稳定身份仍须完整相符。
    const matches = current => matchesAuthorizedContact(stored, backgroundOnly && current?.followed == null && hasStableConversationIdentity(current) ? { ...current, followed: stored.followed } : current);
    const contacts = list.contacts.filter(item => item.id === recipientId);
    if (contacts.length !== 1 || !matches(contacts[0])) throw new Error('收件人的当前身份或关注关系与固定名单不一致，未转发。');
    const contact = this.chatBrowser.contacts.get(recipientId);
    if (!contact || !hasStableConversationIdentity(contact) || !matches(contact)) throw new Error('收件人的当前稳定身份不可核对，未转发。');
    return contact;
  }
  async locateRecipient(page, contact, signal) {
    const deadline = Date.now() + 4000;
    let first = true, lastError;
    do {
      stop(signal); if(!first)await this.gate(signal); this.policyContact(contact.id);
      try {
        const selected = selectForwardRecipient((await page.evaluate(readForwardPanelDom, { includeOffscreen: true })).rows, contact);
        const row = page.locator(panelSelector).nth(selected.panelIndex).locator(rowSelector).nth(selected.rowIndex);
        await row.evaluate(element => element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }));
        await page.waitForTimeout(50);
        stop(signal);
        return selectForwardRecipient((await page.evaluate(readForwardPanelDom)).rows, contact);
      } catch (error) {
        if (error.code !== 'FORWARD_RECIPIENT_IDENTITY_MISMATCH' || error.matchCount !== 0) throw error;
        lastError = error;
      }
      if (!(await page.evaluate(moveForwardList, { reset: first })).moved) break;
      first = false;
      await page.waitForTimeout(75);
    } while (Date.now() < deadline);
    throw lastError;
  }
  async openPanel(page, signal) {
    stop(signal);
    let share = page.locator('[data-e2e="feed-active-video"] [data-e2e="video-player-share"]').filter({ visible: true });
    if (await share.count() === 0) share = page.locator('[data-e2e="video-share-icon-container"]').filter({ visible: true });
    if (await share.count() !== 1) return false;
    const icon = share.locator('.s7K4YLGp');
    await (await icon.count() === 1 ? icon : share).hover();
    for (let phase = 0; phase < 2; phase++) {
      for (let i = 0; i < 12; i += 1) { stop(signal); if ((await page.evaluate(readForwardPanelDom)).rows.length) return true; await page.waitForTimeout(150); }
      if (phase === 0) { stop(signal); await share.click(); }
    }
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
    let entered = false;
    try {
      return await this.outbound.run({ recipientId: input.recipientId, purpose: 'video', signal: options.signal }, () => { entered = true; return this.#sendTransaction(input, options); });
    } catch (error) {
      if (!entered && options.authorize && !options.signal?.aborted && error.code === 'OUTBOUND_BUSY' && error.beforeDelivery === true) {
        const forwardOperationId = randomUUID(), failure = safeForwardFailure(error,'outbound-wait');
        error.failure=failure;error.forwardOperationId=forwardOperationId;
        error.preflight={protocol:'share-preflight-v1',outcome:'not-sent',forwardOperationId,videoId:input.expectedVideoId,recipientId:input.recipientId,sendClicks:0,dispatchAuthorized:false,failureCode:failure.code,failureStage:failure.stage};
      }
      throw error;
    }
  }
  async #sendTransaction({ recipientId, url, expectedVideoId } = {}, { signal: parentSignal, authorize, autonomousRunId } = {}) {
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const operation = { operationId: randomUUID(), recipientId, ...(expectedVideoId ? { videoId: expectedVideoId } : {}), startedAt: new Date().toISOString(), status: 'preparing', sendClicks: 0 };
    let clicked = false, dispatchAuthorized = false, release, stage = 'authorization';
    const authorized = async phase => {
      if (authorize && await authorize({ phase, recipientId, videoId: expectedVideoId }) !== true) throw new Error('自主分享许可已撤回或检查未通过，未发送。');
      if (phase === 'before-click') dispatchAuthorized = true;
      stop(signal);
    };
    try {
    await authorized('prepare');
    if (expectedVideoId !== undefined && (typeof expectedVideoId !== 'string' || !/^\d+$/.test(expectedVideoId))) throw new TypeError('目标作品 ID 格式不正确。');
    const target = url ? canonicalVideoUrl(url) : null;
    if (target) operation.videoId = target.videoId;
    if (target && expectedVideoId && target.videoId !== expectedVideoId) throw new Error('链接与目标作品 ID 不一致，未转发。');
    stage = 'time-gate'; await this.gate(signal);
    this.controller.watchVideoLimits?.();
    stage = 'contact-policy';
    this.policyContact(recipientId);
    release = this.acquire();
      stage = 'contact-identity';
      const contact = await this.prepareContact(recipientId, signal, { backgroundOnly: Boolean(authorize) });
      stage = 'conversation-baseline';
      const before = await this.chatBrowser.readConversation(recipientId, { allowed: true, signal, backgroundOnly: Boolean(authorize) });
      if (before.blocked || before.conversation?.id !== recipientId) throw new Error('指定会话的转发前快照未通过身份核对。');
      if (!Array.isArray(before.messages) || before.messages.length > 2000) throw new Error('点击前消息窗口超出收据基线边界，未发送。');
      const beforeMessages = before.messages.map(message => ({ id: message?.id })), baselineCapturedAt = new Date().toISOString();
      const beforeIds = new Set(beforeMessages.map(message => message.id));
      const newCardIds = new Set();
      const sendResult = await this.controller.withPage(async page => {
        stage = 'video';
        await this.gate(signal);
        if (target) { await page.goto(target.url, { waitUntil: 'domcontentloaded' }); await this.controller.settle(signal, { kind: 'video', videoId: target.videoId }); }
        const video = assertVideo(await page.evaluate(readPageState), expectedVideoId ?? target?.videoId);
        const receiptSelf = await page.evaluate(readCommentSelfIdentity);
        operation.videoId = video.videoId;
        if (authorize && this.receipts().operations.some(item => item.recipientId === recipientId && item.videoId === video.videoId && item.status === 'confirmed')) throw new Error('这位好友已收到同一作品的已确认卡片，未自主重复分享。');
        if (this.receipts().operations.some(item => item.recipientId === recipientId && item.videoId === video.videoId && ['clicking', 'uncertain'].includes(item.status))) throw new Error('该好友与作品存在未确认的转发记录，请先人工核对，未再次发送。');
        stage = 'open-panel';
        if (!await this.openPanel(page, signal)) {
          const failure = safeForwardFailure({ code: 'FORWARD_SHARE_PANEL_UNAVAILABLE', stage, message: '当前作品的好友分享面板未能打开或没有可核对的收件人，未发送。' }, stage);
          if (authorize) throw Object.assign(new Error(failure.message), failure);
          this.record({ ...operation, status: 'not-sent', completedAt: new Date().toISOString(), failure });
          return { confirmed: false, deliveryUncertain: false, needsFallback: true, deliveryType: 'native-card', operationId: operation.operationId, failure, reason: failure.message };
        }
        stage = 'recipient';
        const selected = await this.locateRecipient(page, contact, signal);
        const row = page.locator(panelSelector).nth(selected.panelIndex).locator(rowSelector).nth(selected.rowIndex);
        await row.evaluate((element, id) => element.setAttribute('data-deepseek-forward-id', id), operation.operationId);
        await this.gate(signal);
        this.policyContact(recipientId);
        assertVideo(await page.evaluate(readPageState), video.videoId);
        const current = selectForwardRecipient((await page.evaluate(readForwardPanelDom)).rows, contact);
        if (current.panelIndex !== selected.panelIndex || current.rowIndex !== selected.rowIndex) throw new Error('分享面板的好友位置发生变化，未点击发送。');
        const marked = page.locator(`[data-deepseek-forward-id="${operation.operationId}"]`);
        if (await marked.count() !== 1) throw new Error('带标记的分享好友不是唯一匹配，未点击发送。');
        const send = marked.locator('.xu0OjnsQ,[data-e2e="share-friend-send"],[data-e2e="share-group-send"]');
        if (await send.count() !== 1) throw new Error('分享按钮不是唯一匹配，未点击发送。');
        await this.gate(signal);
        stop(signal);
        assertVideo(await page.evaluate(readPageState), video.videoId);
        const latest = selectForwardRecipient((await page.evaluate(readForwardPanelDom)).rows, contact);
        const markedRows = (await page.evaluate(readForwardPanelDom, { markedId: operation.operationId })).rows;
        if (markedRows.length !== 1) throw new Error('带标记的稳定身份分享行不可唯一回读，未点击发送。');
        const markedIdentity = markedRows[0];
        selectForwardRecipient([markedIdentity], contact);
        if (!sameForwardRow(markedIdentity, latest, contact)) throw new Error('带标记的分享行身份发生变化，未点击发送。');
        await send.evaluate(installForwardWitness, { token: operation.operationId, expected: markedIdentity, videoId: video.videoId });
        const inputDispatched = () => page.evaluate(token => window.__deepseekForwardInputs?.[token]?.dispatched === true, operation.operationId);
        const readSendPoint = async () => {
          if (await marked.count() !== 1 || await send.count() !== 1 || !await send.isVisible() || !await send.isEnabled()) return null;
          return send.evaluate((button, token) => {
            if (button.getAttribute('data-deepseek-forward-token') !== token || button.closest('[disabled],[aria-disabled="true"]')) return null;
            const r = button.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
            if (r.width < 2 || r.height < 2 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
            const hit = document.elementFromPoint(x, y);
            if (!hit || hit !== button && !button.contains(hit)) return null;
            return { x: r.x, y: r.y, width: r.width, height: r.height, clickX: x, clickY: y };
          }, operation.operationId);
        };
        const sameGeometry = (left, right) => left && right && ['x', 'y', 'width', 'height'].every(key => Math.abs(left[key] - right[key]) <= 0.5);
        const checkPendingInput = async () => {
          if (clicked && await inputDispatched()) return;
          await authorized('monitor');
          const time = this.videoLimits.state?.();
          if (time && !time.allowed) throw new Error(time.reason || '视频时限已结束，未继续输入。');
          this.policyContact(recipientId);
          assertVideo(await page.evaluate(readPageState), video.videoId);
          if (await marked.count() !== 1 || await send.count() !== 1) throw new Error('待发送好友或按钮已变化，未继续输入。');
          const latest = selectForwardRecipient((await page.evaluate(readForwardPanelDom)).rows, contact);
          const identities = (await page.evaluate(readForwardPanelDom, { markedId: operation.operationId })).rows;
          if (identities.length !== 1) throw new Error('等待期间分享行稳定身份不可唯一回读，未继续输入。');
          const identity = identities[0];
          selectForwardRecipient([identity], contact);
          if (!sameForwardRow(identity, latest, contact)) throw new Error('等待期间带标记的好友身份变化，未继续输入。');
          stop(signal);
        };
        let polling, monitoring = true, releaseDispatch;
        stage = 'geometry';
        const monitor = setInterval(() => {
          if (!monitoring || polling) return;
          polling = checkPendingInput().catch(async error => {
            if (monitoring && !await inputDispatched().catch(() => false)) interrupt.abort(error);
          }).finally(() => { polling = null; });
        }, 40);
        try {
          await checkPendingInput();
          // 后台页不依赖RAF；连续三次核对真实几何及中心命中，期间仍检查作品和许可。
          await send.evaluate(button => button.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }));
          let stablePoint, previousPoint, stableSamples = 0;
          const geometryDeadline = Date.now() + 3000;
          while (Date.now() < geometryDeadline) {
            stop(signal); await checkPendingInput();
            const point = await readSendPoint();
            stableSamples = sameGeometry(point, previousPoint) ? stableSamples + 1 : point ? 1 : 0;
            previousPoint = point;
            if (stableSamples >= 3) { stablePoint = point; break; }
            await page.waitForTimeout(75);
          }
          if (!stablePoint) throw new Error('分享控件未通过连续几何及命中核对，未点击发送。');
          stop(signal);
          await checkPendingInput();
          stage = 'dispatch'; await authorized('before-click');
          if (await inputDispatched()) throw new Error('等待期间已发生分享输入，未再点击一次。');
          if (authorize) { releaseDispatch = await authorize.beginDispatch(); if (typeof releaseDispatch !== 'function') throw new Error('最终分享许可没有返回可释放的控制，未点击发送。'); }
          await checkPendingInput();
          await this.gate(signal);
          const finalPoint = await readSendPoint();
          if (!sameGeometry(finalPoint, stablePoint)) throw new Error('最终输入前分享控件移动、替换或被遮挡，未点击发送。');
          stop(signal);
          if (receiptSelf.ready) { const currentSelf = await page.evaluate(readCommentSelfIdentity); if (!currentSelf.ready || currentSelf.ownProfileId !== receiptSelf.ownProfileId) throw new Error('最终分享输入前登录本人身份已变化，未点击。'); }
          operation.baseline = createShareReceiptBaseline(operation, { messages: beforeMessages, contact, ownProfileId: receiptSelf.ready ? receiptSelf.ownProfileId : null, capturedAt: baselineCapturedAt });
          operation.status = 'clicking'; operation.sendClicks = 1; this.record(operation);
          stop(signal); await checkPendingInput(); await this.gate(signal);
          if (receiptSelf.ready) { const currentSelf = await page.evaluate(readCommentSelfIdentity); if (!currentSelf.ready || currentSelf.ownProfileId !== receiptSelf.ownProfileId) throw new Error('收据保存后登录本人身份已变化，未点击。'); }
          if (!sameGeometry(await readSendPoint(), finalPoint)) throw new Error('收据保存后分享控件移动、替换或被遮挡，未点击。');
          stop(signal); clicked = true;
          const armed = await send.evaluate((button, token) => { const entry = window.__deepseekForwardInputs?.[token]; if (!entry || button.getAttribute('data-deepseek-forward-token') !== token) return false; entry.armedAt = Date.now(); entry.armed = true; return true; }, operation.operationId);
          if (!armed) throw new Error('最终分享事件门禁未能启用，分享结果需要核对。');
          // 真实输入只有一次；短最终输入仍受监测，结果不明时保留 uncertain 收据。
          await page.mouse.click(finalPoint.clickX, finalPoint.clickY);
          releaseDispatch?.(); releaseDispatch = null;
          stop(signal);
          if (await page.evaluate(token => window.__deepseekForwardInputs?.[token]?.blocked === true, operation.operationId)) throw Object.assign(new Error('最终分享输入时作品、收件人或按钮身份变化，已拦截发送，请核对当前状态。'), { code: 'FORWARD_INPUT_IDENTITY_CHANGED', stage: 'dispatch' });
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
      stage = 'receipt';
      for (let attempt = 0; attempt < 8; attempt += 1) {
        stop(signal);
        const after = await this.chatBrowser.readConversation(recipientId, { allowed: true, signal, refresh: attempt === 0, backgroundOnly: Boolean(authorize) });
        if (after.blocked || after.conversation?.id !== recipientId) break;
        for (const message of after.messages) if (!beforeIds.has(message.id) && message.arrivalClassification === 'new-tail') newCardIds.add(message.id);
        const candidates = after.messages.filter(message => newCardIds.has(message.id) && message.sender === 'outgoing' && message.media?.type === 'shared-work' && !message.failed && !message.pending);
        const matches = [];
        for (const candidate of candidates) {
          const work = sharedCardReceiptIdentity(candidate.media);
          if (work.rejected) continue;
          let observed = work.videoId;
          if (!observed && !authorize) { await this.gate(signal); const resolved = await this.chatBrowser.openSharedVideo(recipientId, candidate.id, { allowed: true, signal }); if (!resolved.blocked) observed = resolved.videoId; }
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
      const failure = safeForwardFailure({ code: 'FORWARD_RECEIPT_UNCONFIRMED', stage, message: '已点击一次分享，但没有回读到对应作品的新发出卡片，请人工核对，未再次发送。' }, stage);
      this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString(), failure });
      return { confirmed: false, deliveryUncertain: true, deliveryType: 'native-card', operationId: operation.operationId, videoId: operation.videoId, failure, reason: failure.message };
    } catch (error) {
      const failure = safeForwardFailure(error, stage);
      if (!clicked) {
        const rejected = error instanceof Error ? error : new Error(failure.message); rejected.failure = failure; rejected.forwardOperationId = operation.operationId;
        const preflight = authorize && !signal.aborted && !dispatchAuthorized && operation.sendClicks === 0 && isRecoverableSharePreflight(failure.code, stage)
          ? { protocol: 'share-preflight-v1', outcome: 'not-sent', forwardOperationId: operation.operationId, videoId: operation.videoId, recipientId, sendClicks: 0, dispatchAuthorized: false, failureCode: failure.code, failureStage: stage } : null;
        if (preflight) rejected.preflight = preflight;
        try { this.record({ ...operation, status: 'not-sent', completedAt: new Date().toISOString(), failure, ...(preflight ? { preflight } : {}) }); } catch { rejected.receiptWarning = '发送前的诊断收据未能保存，请核对本机记录。'; }
        throw rejected;
      }
      const result = { confirmed: false, deliveryUncertain: true, deliveryType: 'native-card', operationId: operation.operationId, videoId: operation.videoId, failure, reason: '分享点击后的结果未确认，请人工核对，未再次发送。' };
      try { this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString(), failure }); } catch { result.receiptWarning = '点击后的收据更新失败，需要人工核对。'; }
      return result;
    } finally { release?.(); }
  }
  async close() { if (this.ownsChat) await this.chatBrowser.close(); if (this.ownsController) await this.controller.close(); }
}
