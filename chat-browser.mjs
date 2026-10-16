import { createHash } from 'node:crypto';
import { BrowserController } from './core.mjs?v=9';
import { messageFingerprint } from './chat-message.mjs';
import { MessageIdentityTracker } from './message-tracker.mjs';
export { MessageIdentityTracker } from './message-tracker.mjs';

const HOME = 'https://www.douyin.com/?recommend=1&from_nav=1';
const hash = value => createHash('sha256').update(value).digest('hex');
const stop = signal => signal?.throwIfAborted();
const readableDraft = value => value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
const localDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));

export function analyzeConversationDay(snapshot, { now = Date.now, confirmedHistory = [] } = {}) {
  const current = typeof now === 'function' ? now() : now, today = localDay(current);
  const recipientId = snapshot?.conversation?.id || snapshot?.contact?.id;
  if (typeof recipientId === 'string' && recipientId.trim() && confirmedHistory.some(item => item?.confirmed === true && item.recipientId === recipientId && typeof item.messageId === 'string' && item.messageId.trim() && item.date === today && Number.isFinite(Date.parse(item.at)) && localDay(Date.parse(item.at)) === today && Date.parse(item.at) <= current)) return { status: 'already-sent', reason: '共同账本已确认今天向这位好友发过消息。' };
  const evidence = snapshot?.dayEvidence;
  if (snapshot?.blocked || snapshot?.loginRequired || snapshot?.verificationRequired || !recipientId || !Array.isArray(snapshot.messages) || !evidence?.latestEndVerified || evidence.chronology !== 'oldest-first' || !Number.isFinite(Date.parse(evidence.observedAt)) || localDay(Date.parse(evidence.observedAt)) !== today || Date.parse(evidence.observedAt) > current || current - Date.parse(evidence.observedAt) > 60_000) return { status: 'date-unknown', reason: '会话最新端、日期或快照时效尚未核实。' };
  const messages = snapshot.messages;
  if (messages.some(item => !['incoming', 'outgoing'].includes(item.sender || item.direction) || item.pending || item.failed)) return { status: 'date-unknown', reason: '会话含方向不明或未确认的消息，未自动问候。' };
  const dayOf = item => {
    if (item.dateEvidence?.kind === 'unknown') return null;
    const raw = String(item.dateEvidence?.raw ?? item.sentAt ?? item.timestamp ?? '').trim();
    if (/^今天(?:\s|$)/.test(raw)) return today;
    const date = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})(?:日)?(?:$|[ T\s])/.exec(raw);
    if (!date) return null;
    const padded = `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`;
    if (!Number.isFinite(Date.parse(padded + 'T00:00:00+08:00')) || localDay(Date.parse(padded + 'T00:00:00+08:00')) !== padded) return null;
    if (/T.*(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return Number.isFinite(Date.parse(raw)) ? localDay(Date.parse(raw)) : null;
    return padded;
  };
  if (messages.some(item => (item.sender || item.direction) === 'outgoing' && dayOf(item) === today)) return { status: 'already-sent', reason: '当前会话已读到今天真实发出的消息。' };
  const outgoing = messages.findLastIndex(item => (item.sender || item.direction) === 'outgoing');
  if (messages.slice(outgoing + 1).some(item => (item.sender || item.direction) === 'incoming')) return { status: 'pending-incoming', reason: '对方有待回复消息，优先交给聊天回复。' };
  if (!messages.length && evidence.emptyTodayVerified === true) return { status: 'eligible', reason: '当前最新会话明确显示今天尚无消息。' };
  if (outgoing >= 0) {
    const date = dayOf(messages[outgoing]);
    if (date && date < today) return { status: 'eligible', reason: '已核对最新端，最近发出消息的明确日期早于今天。' };
  }
  return { status: 'date-unknown', reason: '没有足够日期证据判断今天是否发过消息。' };
}

// 只采集会话身份和未读标识，不读取预览或其他会话正文。
export function readContactDom() {
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  const dialog = document.querySelector('[data-e2e="im-dialog"]');
  return [...(dialog?.querySelectorAll('[data-e2e="conversation-item"]') ?? [])].map((row, index) => ({
    index,
    displayName: clean(row.querySelector('.conversationConversationItemtitle,[data-e2e="conversation-name"]')?.textContent),
    nativeId: row.getAttribute('data-conversation-id') || row.getAttribute('data-conversation-short-id') || null,
    avatar: resource(row.querySelector('.commonIMAvataravatarContainer img,img')?.getAttribute('src')),
    unread: Boolean(row.querySelector('[class*="unread"],[class*="Unread"],[data-e2e="unread-count"]')),
    isGroup: Boolean(row.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]')),
  }));
}

export function readChatBlockers() {
  const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const labels = [...document.querySelectorAll('body *')].filter(e => !e.childElementCount && visible(e) && !e.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]'));
  return {
    loginRequired: labels.some(e => /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(e.textContent)),
    verificationRequired: labels.some(e => /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(e.textContent)),
  };
}

export function readConversationDom() {
  const clean = value => (value ?? '').trim();
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  const dialog = document.querySelector('[data-e2e="im-dialog"]');
  const headers = [...(dialog?.querySelectorAll('.StackLayoutStackChatHeaderuser,[data-e2e="chat-header"]') ?? [])].filter(visible);
  const header = headers.length === 1 ? headers[0] : null;
  const root = header?.closest('.StackLayoutpagespageRoot,[data-e2e="chat-page"]');
  const displayName = clean(header?.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent);
  const avatar = resource(header?.querySelector('img')?.getAttribute('src'));
  let timestamp = null;
  const messages = [];
  const nodes = root?.querySelectorAll('.MessageBoxTimetimeLayout,time,[data-e2e="msg-item-content"]') ?? [];
  const list = root?.querySelector('.messageMessageListlist');
  let newestFirst = false, chronologySource = list ? 'message-list-order-unverified' : 'dom-order';
  if (list) {
    const style = getComputedStyle(list);
    let verticallyFlipped = false;
    try { verticallyFlipped = style.transform !== 'none' && new DOMMatrix(style.transform).d < 0; } catch {}
    newestFirst = verticallyFlipped || style.flexDirection === 'column-reverse';
    if (newestFirst) chronologySource = verticallyFlipped ? 'message-list-vertical-transform' : 'message-list-column-reverse';
  }
  for (const node of nodes) {
    if (!node.matches('[data-e2e="msg-item-content"]')) { timestamp = node.getAttribute('datetime') || clean(node.textContent) || timestamp; continue; }
    const box = node.closest('.messageMessageBoxmessageBox,[data-e2e="message-row"]') || node;
    const fromMe = Boolean(node.closest('.MessageBoxContentisFromMe,.messageMessageBoxisFromMe,[data-direction="outgoing"]'));
    const direction = fromMe ? 'outgoing' : box.matches('.messageMessageBoxmessageBox,[data-e2e="message-row"]') ? 'incoming' : 'unknown';
    const textNode = node.querySelector('.MessageItemTextcontainer,[data-e2e="message-text"]');
    const emoji = node.querySelector('.MessageItemEmojiemojiBox');
    const share = node.querySelector('.MessageItemShareAwemecontainer');
    const kind = textNode ? 'text' : emoji ? 'emoji' : share ? 'video' : 'unsupported';
    const text = textNode ? clean(textNode.innerText || textNode.textContent) : '';
    let media = null;
    if (emoji) {
      const images = [...emoji.querySelectorAll('img')].map(image => ({ src: image.currentSrc || image.getAttribute('src') || '', label: clean(image.getAttribute('alt') || image.getAttribute('aria-label') || image.getAttribute('title')) || null }));
      const label = clean(emoji.getAttribute('aria-label') || emoji.getAttribute('title')) || images.map(image => image.label).filter(Boolean).join(' ') || null;
      media = { type: 'emoji', label, images, requiresVisual: true, understandingScope: 'single-message-image' };
    }
    if (share) {
      let url = null, videoId = null;
      for (const link of share.querySelectorAll('a[href]')) {
        try { const candidate = new URL(link.getAttribute('href'), location.href); const match = /^\/video\/(\d+)\/?$/.exec(candidate.pathname);
          if (candidate.protocol === 'https:' && /^(?:www\.)?douyin\.com$/.test(candidate.hostname) && match) { videoId = match[1]; url = `https://www.douyin.com/video/${videoId}`; break; }
        } catch {}
      }
      const title = clean(share.querySelector('.MessageItemShareAwemetitle,.MessageItemShareAwemedesc,[data-e2e="shared-video-title"]')?.textContent) || null;
      const author = clean(share.querySelector('.MessageItemShareAwemeauthorName,[data-e2e="shared-video-author"]')?.textContent) || null;
      const cover = share.querySelector('.MessageItemShareAwemeawemeContainer,img:not(.MessageItemShareAwemephotosTag):not(.MessageItemShareAwemeauthorAvatar)');
      media = { type: 'shared-work', videoId, url, title, author, isPhotoGallery: Boolean(share.querySelector('.MessageItemShareAwemephotosTag')),
        images: cover ? [{ src: cover.currentSrc || cover.getAttribute('src') || '', label: clean(cover.getAttribute('alt')) || null }] : [],
        requiresVisual: true, understandingScope: 'card-cover-and-dom-metadata', publicUrlSource: url ? 'dom-link' : null, canResolveByOpeningCard: true };
    }
    const indexNode = node.closest('[data-index]');
    const rawOrder = indexNode?.getAttribute('data-index');
    const order = rawOrder !== null && rawOrder !== undefined && /^\d+$/.test(rawOrder) ? Number(rawOrder) : null;
    const nativeId = box.getAttribute('data-message-id') || box.getAttribute('data-msg-id') || node.getAttribute('data-message-id') || null;
    const ownTimestamp = box.getAttribute('data-sent-at') || box.getAttribute('data-timestamp') || node.getAttribute('data-sent-at');
    const ownTimeNode = box.querySelector('.MessageBoxTimetimeLayout,time');
    const ownTime = ownTimeNode?.getAttribute('datetime') || clean(ownTimeNode?.textContent);
    const dated = ownTimestamp || ownTime || (!newestFirst ? timestamp : null);
    messages.push({ nativeId, direction, sender: direction, text, kind, media, timestamp: ownTimestamp || timestamp, order, domIndex: order, domPosition: messages.length, orderMode: list ? 'relative' : 'absolute',
      dateEvidence: { raw: dated || timestamp || '', kind: dated ? /^今天(?:\s|$)/.test(dated) ? 'today' : /^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(dated) ? 'absolute' : 'unknown' : 'unknown', source: ownTimestamp ? 'message-attribute' : ownTime ? 'message-time' : !newestFirst ? 'group-label' : 'unverified-group-label' },
      failed: Boolean(box.querySelector('[class*="sendFail"],[class*="SendFail"],[data-e2e="message-failed"]')),
      pending: Boolean(box.querySelector('[class*="sending"],[class*="Sending"],[data-e2e="message-pending"]')) });
  }
  const emptyTodayVerified = messages.length === 0 && [...(root?.querySelectorAll('[data-e2e="empty-conversation"],[class*="empty" i]') ?? [])].some(element => visible(element) && /^今天(?:还)?(?:暂无|没有|尚无)消息[。！!\s]*$/.test(clean(element.textContent)));
  const latestEndVerified = emptyTodayVerified || newestFirst && messages.some(message => message.domIndex === 0);
  if (list) messages.forEach(message => { message.latestEndVerified = latestEndVerified; });
  if (newestFirst) {
    messages.reverse();
    let previousTime = null;
    messages.forEach((message, index) => { message.order = index; message.timestamp ??= previousTime; previousTime = message.timestamp; });
  }
  const loading = [...(root?.querySelectorAll('[class*="loading"],[class*="Loading"],[aria-busy="true"]') ?? [])].some(visible);
  const historyStartVerified = [...(root?.querySelectorAll('[data-e2e="history-start"],[class*="no-more-tip"],[class*="noMoreTip"]') ?? [])].some(element => visible(element) && /没有更多消息|暂无更多消息|已显示全部消息/.test(clean(element.textContent)));
  return { displayName, avatar, messages, loading, latestEndVerified, emptyTodayVerified, historyStartVerified, observedAt: new Date().toISOString(), chronology: list && !newestFirst && !emptyTodayVerified ? 'unknown' : 'oldest-first', chronologySource, sourceDomOrder: newestFirst ? 'newest-first' : list ? 'unknown' : 'oldest-first' };
}

export function readChatIdentityDom() {
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  const headers = [...document.querySelectorAll('[data-e2e="im-dialog"] .StackLayoutStackChatHeaderuser,[data-e2e="im-dialog"] [data-e2e="chat-header"]')].filter(visible);
  const header = headers.length === 1 ? headers[0] : null;
  const src = header?.querySelector('img')?.getAttribute('src');
  let avatar = ''; try { avatar = new URL(src, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch {}
  return { displayName: header?.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent.trim(), avatar };
}

export class ChatBrowser {
  constructor({ source = 'api-chat', controller } = {}) {
    if (!['api-chat', 'dsh-chat'].includes(source)) throw new TypeError('私信入口须为 api-chat 或 dsh-chat。');
    this.controller = controller ?? new BrowserController({ source });
    this.contacts = new Map();
    this.following = null;
    this.identities = new MessageIdentityTracker();
    this.mediaResources = new Map();
  }
  async dialog(page, signal) {
    stop(signal);
    await page.evaluate(() => {
      if (!window.__deepseekChatPauseVideo) {
        window.__deepseekChatPauseVideo = true;
        document.addEventListener('play', event => { if (event.target instanceof HTMLVideoElement) event.target.pause(); }, true);
      }
      for (const video of document.querySelectorAll('video')) video.pause();
    });
    const flags = await page.evaluate(readChatBlockers);
    if (flags.loginRequired || flags.verificationRequired) return { ...flags, blocked: true };
    if (!await page.locator('[data-e2e="im-dialog"]').isVisible().catch(() => false)) {
      const entry = page.locator('[data-e2e="im-entry"]');
      try { await entry.waitFor({ state: 'visible', timeout: 20_000 }); }
      catch { throw new Error('没有找到抖音消息入口。'); }
      await entry.click();
      await page.locator('[data-e2e="im-dialog"]').waitFor({ state: 'visible' });
    }
    stop(signal);
    return { ...flags, blocked: false };
  }
  async verifyFollowing(page, signal) {
    // 本人的关注名单仅在首次发现联系人时核对；后续新增联系人不会进入服务的固定白名单。
    await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    const my = page.locator('a').filter({ has: page.locator('span').filter({ hasText: /^我的$/ }) });
    await my.waitFor({ state: 'visible', timeout: 10_000 });
    const href = await my.getAttribute('href');
    const target = new URL(href, HOME);
    if (target.hostname !== 'www.douyin.com' || !target.pathname.startsWith('/user/')) throw new Error('本人的关注入口不符合当前网页约定。');
    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-e2e="user-info-follow"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(800);
    const expectedCount = await page.locator('[data-e2e="user-info-follow"]').evaluate(element => Number(/\d+/.exec(element.textContent)?.[0] ?? 0));
    const first = page.locator('[data-e2e="user-fans-container"] .OlxToPIh').first();
    for (let attempt = 0; attempt < 3 && !await first.isVisible().catch(() => false); attempt += 1) {
      stop(signal);
      await page.locator('[data-e2e="user-info-follow"]').click();
      await first.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    }
    if (!await first.isVisible()) throw new Error('本人的关注列表未就绪，未确认联系人关系。');
    if (expectedCount > 0 && expectedCount <= 20) await page.waitForFunction(count => document.querySelectorAll('[data-e2e="user-fans-container"] .OlxToPIh').length >= count, expectedCount, { timeout: 10_000 });
    stop(signal);
    this.following = await page.evaluate(() => [...document.querySelectorAll('[data-e2e="user-fans-container"] .OlxToPIh')].map(row => ({
      displayName: row.querySelector('.Zce7SWd3 a')?.textContent.trim(),
      mutual: [...row.querySelectorAll('button')].some(button => button.textContent.trim() === '相互关注'),
    })));
    await page.goto(HOME, { waitUntil: 'domcontentloaded' });
    await this.dialog(page, signal);
  }
  async contactList(page, signal) {
    const flags = await this.dialog(page, signal);
    if (flags.blocked) return { ...flags, contacts: [] };
    await page.locator('[data-e2e="im-dialog"] [data-e2e="conversation-item"]').first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    if (this.following?.length === 2) await page.waitForFunction(() => document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="conversation-item"]').length >= 2, undefined, { timeout: 5000 }).catch(() => {});
    const rows = await page.evaluate(readContactDom);
    const identities = rows.map(row => `conv:${hash(row.nativeId ? `native:${row.nativeId}` : `${row.displayName}\0${row.avatar}`)}`);
    if (new Set(identities).size !== identities.length || rows.some(row => !row.displayName || (!row.nativeId && !row.avatar))) throw new Error('联系人身份不完整或存在歧义，已停止读取会话。');
    const contacts = [];
    this.contacts.clear();
    for (const [index, row] of rows.entries()) {
      const id = identities[index];
      const matching = this.following?.filter(item => item.displayName === row.displayName && item.mutual) ?? [];
      const uniqueName = rows.filter(item => item.displayName === row.displayName).length === 1;
      const followed = matching.length === 1 && uniqueName ? true : null;
      const contact = { id, displayName: row.displayName, name: row.displayName, unread: row.unread, followed, isGroup: row.isGroup ? true : followed ? false : null,
        relationshipEvidence: followed ? { source: 'self-follow-list', label: '相互关注', matchedBy: 'unique-display-name', accountIdCrossChecked: false } : null };
      this.contacts.set(id, { ...contact, avatar: row.avatar });
      await page.locator('[data-e2e="conversation-item"]').nth(index).evaluate((element, value) => { element.setAttribute('data-deepseek-chat-id', value); }, id);
      contacts.push(contact);
    }
    return { ...flags, contacts };
  }
  listContacts({ signal, verifyFollowing = this.following === null } = {}) {
    return this.controller.withPage(async page => {
      const initial = await this.dialog(page, signal);
      if (initial.blocked) return { ...initial, contacts: [] };
      if (verifyFollowing) await this.verifyFollowing(page, signal);
      return this.contactList(page, signal);
    }, { signal });
  }
  async select(page, recipientId, signal) {
    if (typeof recipientId !== 'string' || !/^conv:[a-f0-9]{64}$/.test(recipientId)) throw new TypeError('需要已发现的精确联系人 ID。');
    const flags = await this.contactList(page, signal);
    if (flags.blocked) return { flags };
    const contact = this.contacts.get(recipientId);
    if (!contact || contact.isGroup === true) throw new Error('指定联系人已变化或属于群聊，已停止操作。');
    const row = page.locator(`[data-e2e="conversation-item"][data-deepseek-chat-id="${recipientId}"]`);
    if (await row.count() !== 1) throw new Error('指定会话不是唯一匹配，已停止操作。');
    const current = await page.evaluate(readChatIdentityDom);
    if (current.displayName !== contact.displayName || current.avatar !== contact.avatar) {
      const back = page.locator('[data-stack-layer="chat"] .StackLayoutStackTitleBarbackBtn');
      if (current.displayName && await back.count() === 1) {
        await back.click();
        await this.contactList(page, signal);
      }
      try { await row.click(); }
      catch { throw new Error('指定会话未成功打开，未读取正文或点击发送。'); }
      await page.waitForFunction(expected => {
        const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
        const headers = [...document.querySelectorAll('[data-e2e="im-dialog"] .StackLayoutStackChatHeaderuser,[data-e2e="im-dialog"] [data-e2e="chat-header"]')].filter(visible);
        if (headers.length !== 1) return false;
        const header = headers[0];
        const name = header.querySelector('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]')?.textContent.trim();
        let avatar = ''; try { avatar = new URL(header.querySelector('img')?.getAttribute('src'), location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch {}
        return name === expected.displayName && avatar === expected.avatar;
      }, { displayName: contact.displayName, avatar: contact.avatar }, { timeout: 10_000 });
      await page.waitForTimeout(300);
    }
    const identity = await page.evaluate(readChatIdentityDom);
    if (identity.displayName !== contact.displayName || identity.avatar !== contact.avatar) throw new Error('会话标题或头像回读与联系人不一致，已停止操作。');
    stop(signal);
    return { contact, flags };
  }
  async stableConversation(page, contact, signal) {
    let previous;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      stop(signal);
      const current = await page.evaluate(readConversationDom);
      if (current.displayName !== contact.displayName || current.avatar !== contact.avatar) throw new Error('读取前会话身份发生变化。');
      const signature = JSON.stringify(current.messages);
      if (!current.loading && previous === signature) return current;
      previous = current.loading ? undefined : signature;
      await page.waitForTimeout(150);
    }
    throw new Error('指定会话的消息列表仍在加载或变化，未确认正文快照。');
  }
  publicMessages(recipientId, rawRows) {
    const rows = rawRows.map(row => {
      if (!row.media) return row;
      const { images = [], ...media } = row.media;
      const resources = images.filter(image => image.src).map(image => {
        const ref = `media:${hash(image.src.startsWith('data:') ? image.src : (() => { try { return new URL(image.src).pathname; } catch { return image.src; } })())}`;
        this.mediaResources.set(ref, { src: image.src, label: image.label ?? null, recipientId });
        return { resourceRef: ref, label: image.label ?? null };
      });
      return { ...row, media: { ...media, imageCount: resources.length, resources } };
    });
    const identified = this.identities.identify(recipientId, rows);
    return identified.map(row => row.media?.type === 'shared-work' ? { ...row, media: { ...row.media,
      safeOpenSelector: `[data-deepseek-message-id="${row.id}"] .MessageItemShareAwemecontainer` } } : row);
  }
  async markMessages(page, messages) {
    await page.evaluate(mapping => {
      const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
      const header = [...document.querySelectorAll('[data-e2e="im-dialog"] .StackLayoutStackChatHeaderuser,[data-e2e="im-dialog"] [data-e2e="chat-header"]')].filter(visible);
      const root = header.length === 1 ? header[0].closest('.StackLayoutpagespageRoot,[data-e2e="chat-page"]') : null;
      const nodes = [...(root?.querySelectorAll('[data-e2e="msg-item-content"]') ?? [])];
      if (nodes.length !== mapping.length || new Set(mapping.map(item => item.domPosition)).size !== nodes.length) throw new Error('消息窗口已经改变。');
      for (const item of mapping) {
        if (!Number.isSafeInteger(item.domPosition) || item.domPosition < 0 || item.domPosition >= nodes.length) throw new Error('消息 DOM 位置不可核对。');
        nodes[item.domPosition].setAttribute('data-deepseek-message-id', item.id);
      }
    }, messages.map((message, index) => ({ id: message.id, domPosition: message.domPosition ?? index })));
  }
  readConversation(recipientId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('读取正文需要这个指定联系人的明确授权。'));
    return this.controller.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, conversation: null, contact: null, messages: [] };
      const raw = await this.stableConversation(page, contact, signal);
      if (raw.displayName !== contact.displayName || raw.avatar !== contact.avatar) throw new Error('读取前会话身份发生变化。');
      const { avatar, ...publicContact } = contact;
      const messages = this.publicMessages(recipientId, raw.messages);
      await this.markMessages(page, messages);
      return { ...flags, conversation: { id: contact.id, displayName: contact.displayName }, contact: publicContact,
        messages, dayEvidence: { observedAt: raw.observedAt, latestEndVerified: raw.latestEndVerified, chronology: raw.chronology, historyStartVerified: raw.historyStartVerified, emptyTodayVerified: raw.emptyTodayVerified } };
    }, { signal });
  }
  captureMessage(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('查看画面需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.controller.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, frames: [], imageStatus: '登录或验证画面未采集。' };
      const raw = await this.stableConversation(page, contact, signal);
      const messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId);
      if (!message?.media || message.unsupported) throw new Error('该消息没有已识别的表情或分享作品画面。');
      await this.markMessages(page, messages);
      const frame = page.locator(`[data-e2e="im-dialog"] [data-deepseek-message-id="${messageId}"]`).locator('.MessageItemEmojiemojiBox,.MessageItemShareAwemecontainer');
      if (await frame.count() !== 1) throw new Error('没有唯一的指定消息画面。');
      const current = await page.evaluate(readChatIdentityDom);
      const protectedScreen = await page.evaluate(readChatBlockers);
      if (protectedScreen.loginRequired || protectedScreen.verificationRequired) return { ...protectedScreen, frames: [], imageStatus: '登录或验证画面未采集。' };
      if (current.displayName !== contact.displayName || current.avatar !== contact.avatar) throw new Error('截取画面前会话身份发生变化。');
      stop(signal);
      const rectangle=await frame.boundingBox();
      const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
      if(!rectangle) throw new Error('指定消息画面目前不可见，未采集。');
      const clip={x:Math.max(0,rectangle.x),y:Math.max(0,rectangle.y),width:Math.min(viewport.width,rectangle.x+rectangle.width)-Math.max(0,rectangle.x),height:Math.min(viewport.height,rectangle.y+rectangle.height)-Math.max(0,rectangle.y)};
      if(clip.width<2||clip.height<2) throw new Error('指定消息不在当前视口内，未采集其他区域。');
      const unobstructed=await frame.evaluate(element=>{const r=element.getBoundingClientRect(),x=Math.max(1,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(1,Math.min(innerHeight-1,r.y+r.height/2));return element.contains(document.elementFromPoint(x,y));});
      if(!unobstructed) throw new Error('指定消息被其他界面遮挡，未采集。');
      // 倒转的虚拟列表不能依赖 locator 的自动滚动稳定等待；只截取当前消息的可见矩形。
      const data = await page.screenshot({ type:'jpeg',quality:70,clip,timeout:5000 });
      const afterRectangle=await frame.boundingBox();
      if(!afterRectangle||['x','y','width','height'].some(key=>Math.abs(afterRectangle[key]-rectangle[key])>1)) throw new Error('截图期间指定消息位置改变，画面已丢弃。');
      const afterIdentity=await page.evaluate(readChatIdentityDom);
      const afterProtection=await page.evaluate(readChatBlockers);
      if(afterProtection.loginRequired||afterProtection.verificationRequired) return {...afterProtection,frames:[],imageStatus:'截图期间出现登录或验证，本次画面已丢弃。'};
      if(afterIdentity.displayName!==contact.displayName || afterIdentity.avatar!==contact.avatar) throw new Error('截图期间会话身份发生变化，画面已丢弃。');
      const afterRaw=await this.stableConversation(page,contact,signal);
      const afterMessages=this.publicMessages(recipientId,afterRaw.messages);
      const afterMessage=afterMessages.find(item=>item.id===messageId);
      const mediaIdentity=value=>JSON.stringify([value?.sender,value?.kind,value?.text,value?.media?.type,value?.media?.resources,value?.media?.label,value?.media?.title,value?.media?.videoId]);
      if(!afterMessage || mediaIdentity(afterMessage)!==mediaIdentity(message)) throw new Error('截图期间指定消息发生变化，画面已丢弃。');
      return { ...flags, conversation: { id: recipientId, displayName: contact.displayName }, messageId,
        media: message.media, understandingScope: message.media.understandingScope,
        frames: [{ mimeType: 'image/jpeg', data: data.toString('base64') }], imageStatus: '已采集指定消息的实际画面，尚需支持图像的模型读取。' };
    }, { signal });
  }
  openSharedVideo(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('打开分享作品需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.controller.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, opened: false };
      const raw = await this.stableConversation(page, contact, signal);
      const messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId);
      if (message?.media?.type !== 'shared-work') throw new Error('该消息不是已识别的分享作品卡片。');
      if (message.media.url) return { ...flags, opened: false, videoId: message.media.videoId, url: message.media.url, source: 'dom-link' };
      await this.markMessages(page, messages);
      const card = page.locator(`[data-e2e="im-dialog"] ${message.media.safeOpenSelector}`);
      if (await card.count() !== 1) throw new Error('没有唯一的指定分享卡片。');
      const beforeUrl = new URL(page.url());
      const beforeId = /^\/video\/(\d+)\/?$/.exec(beforeUrl.pathname)?.[1] || beforeUrl.searchParams.get('modal_id') || null;
      const pop = page.waitForEvent('popup', { timeout: 2500 }).catch(() => null);
      stop(signal);
      const parentSource = this.controller.source?.startsWith('dsh') ? 'dsh' : 'api';
      const decision = this.controller.limits().beforeAction(parentSource, 'douyin_open_video');
      if (!decision.allowed) throw new Error(decision.reason || '当前时间不允许打开分享作品。');
      let popup, target = page;
      try {
        await card.click();
        popup = await pop;
        target = popup ?? page;
        if (popup) await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        await target.waitForFunction(({ beforeId, newPopup }) => {
          const observed = new URL(location.href);
          const id = /^\/video\/(\d+)\/?$/.exec(observed.pathname)?.[1] || observed.searchParams.get('modal_id');
          return /^\d+$/.test(id || '') && (newPopup || id !== beforeId);
        }, { beforeId, newPopup: Boolean(popup) }, { timeout: 5000 }).catch(() => {});
        const observed = new URL(target.url());
        const id = /^\/video\/(\d+)\/?$/.exec(observed.pathname)?.[1] || observed.searchParams.get('modal_id');
        if (observed.protocol !== 'https:' || !/^(?:www\.)?douyin\.com$/.test(observed.hostname) || !/^\d+$/.test(id || '')) return { ...flags, opened: true, videoId: null, url: null, reason: '实际打开页面没有可核实的公开作品 ID。' };
        if (!popup && id === beforeId) return { ...flags, opened: true, videoId: null, url: null, reason: '点击后没有核实新的作品页面，未采用原详情页的作品 ID。' };
        return { ...flags, opened: true, videoId: id, url: `https://www.douyin.com/video/${id}`, source: 'actual-opened-page-url', isPhotoGallery: message.media.isPhotoGallery };
      } finally {
        if (!popup) { popup = await pop; if (popup) target = popup; }
        await target.evaluate(() => { for (const video of document.querySelectorAll('video')) video.pause(); }).catch(() => {});
        if (popup) await popup.close().catch(() => {});
      }
    }, { signal });
  }
  sendMessage(recipientId, message, { allowed = false, expectedMessageIds, expectedMessageContent, signal: parentSignal, authorize } = {}) {
    if (allowed !== true) return Promise.reject(new Error('发送需要这个指定联系人的明确授权。'));
    if (typeof message !== 'string' || !message.trim() || [...message].length > 1000) return Promise.reject(new TypeError('发送内容须为 1 到 1000 字的非空文字。'));
    if (authorize !== undefined && (typeof authorize !== 'function' || typeof authorize.beginDispatch !== 'function')) return Promise.reject(new TypeError('主动问候需要本机许可检查和最终短输入控制。'));
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const authorized = async phase => { stop(signal); if (authorize && await authorize({ phase, recipientId }) !== true) throw new Error('主动问候许可已撤回，未继续发送。'); stop(signal); };
    return this.controller.withPage(async page => {
      await authorized('prepare');
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, confirmed: false, deliveryUncertain: false };
      const before = await page.evaluate(readConversationDom);
      const initialMessages = this.publicMessages(recipientId, before.messages);
      const expected = expectedMessageIds ?? initialMessages.map(item => item.id);
      const contentOf = messages => messages.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
      const expectedContent = expectedMessageContent ?? contentOf(initialMessages);
      if (!Array.isArray(expected) || expected.some(id => typeof id !== 'string') || initialMessages.some(item => item.direction === 'unknown') || JSON.stringify(initialMessages.map(item => item.id)) !== JSON.stringify(expected)
        || !Array.isArray(expectedContent) || expectedContent.some(item => !item || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint ?? '')) || JSON.stringify(contentOf(initialMessages)) !== JSON.stringify(expectedContent)) return { confirmed: false, deliveryUncertain: false, reason: '私信水位或内容已变化，未填写或发送回复。' };
      const receipt = { conversation: { id: contact.id, displayName: contact.displayName }, contact: { id: contact.id, name: contact.displayName } };
      const editor = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]');
      if (await editor.count() !== 1) throw new Error('没有唯一的私信文字输入框。');
      if (readableDraft(await editor.innerText()) || await editor.locator('img,video,audio,[data-slate-void="true"]').count()) throw new Error('当前会话已有草稿，已停止发送以保留原内容。');
      let clicked = false, monitoring = false, monitor, polling, releaseDispatch;
      const witnessId = `chat-${hash(`${recipientId}:${Date.now()}:${Math.random()}`)}`;
      try {
        await editor.fill(message);
        stop(signal);
        const ready = await page.evaluate(readConversationDom);
        if (ready.displayName !== contact.displayName || ready.avatar !== contact.avatar || readableDraft(await editor.innerText()) !== readableDraft(message)) throw new Error('发送前身份或输入文字回读不一致。');
        const readyMessages = this.publicMessages(recipientId, ready.messages);
        if (readyMessages.some(item => item.direction === 'unknown') || JSON.stringify(readyMessages.map(item => item.id)) !== JSON.stringify(expected) || JSON.stringify(contentOf(readyMessages)) !== JSON.stringify(expectedContent)) throw new Error('填写回复期间私信水位或内容发生变化，未点击发送。');
        const escaped = contact.displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const targetPage = page.locator('.StackLayoutpagespageRoot,[data-e2e="chat-page"]').filter({ has: page.locator('.StackLayoutStackChatHeadertitle,[data-e2e="chat-title"]').filter({ hasText: new RegExp(`^${escaped}$`) }) });
        const send = targetPage.locator('.e2e-send-msg-btn,[data-e2e="send-msg-btn"]');
        if (await send.count() !== 1) throw new Error('没有唯一的指定会话发送按钮。');
        await send.evaluate((button, token) => {
          const entries = window.__deepseekChatInputs ??= Object.create(null), entry = { dispatched: false };
          const witness = event => { if (event.isTrusted && (event.target === button || button.contains(event.target))) entry.dispatched = true; };
          document.addEventListener('click', witness, true);
          entry.cleanup = () => document.removeEventListener('click', witness, true); entries[token] = entry;
        }, witnessId);
        const inputDispatched = () => page.evaluate(token => window.__deepseekChatInputs?.[token]?.dispatched === true, witnessId);
        const checkPendingInput = async () => {
          if (clicked && await inputDispatched()) return;
          await authorized('monitor');
          if (await editor.count() !== 1 || await send.count() !== 1 || readableDraft(await editor.innerText()) !== readableDraft(message)) throw new Error('等待期间发送按钮或草稿发生变化，未发送。');
          const current = await page.evaluate(readConversationDom), blockers = await page.evaluate(readChatBlockers);
          if (blockers.loginRequired || blockers.verificationRequired || current.displayName !== contact.displayName || current.avatar !== contact.avatar) throw new Error('等待期间会话身份或页面许可发生变化，未发送。');
          const messages = this.publicMessages(recipientId, current.messages);
          if (messages.some(item => item.direction === 'unknown') || JSON.stringify(messages.map(item => item.id)) !== JSON.stringify(expected) || JSON.stringify(contentOf(messages)) !== JSON.stringify(expectedContent)) throw new Error('等待期间收到新消息或消息内容变化，未发送。');
          stop(signal);
        };
        monitoring = true;
        monitor = setInterval(() => { if (polling || !monitoring) return; polling = checkPendingInput().catch(async error => { if (monitoring && !await inputDispatched().catch(() => false)) interrupt.abort(error); }).finally(() => { polling = null; }); }, 40);
        await checkPendingInput();
        await send.click({ trial: true, timeout: 3000 });
        stop(signal); await checkPendingInput(); await authorized('before-click');
        if (await inputDispatched()) throw new Error('等待期间已发生发送输入，未再点击一次。');
        if (authorize) { releaseDispatch = await authorize.beginDispatch(); if (typeof releaseDispatch !== 'function') throw new Error('最终输入控制没有返回可释放的许可。'); }
        stop(signal); clicked = true;
        await send.click({ timeout: 350, noWaitAfter: true });
        releaseDispatch?.(); releaseDispatch = null;
        if (!await inputDispatched()) throw new Error('没有核对到真实发送输入，结果需要核对。');
        monitoring = false; clearInterval(monitor); stop(signal);
        const beforeIds = new Set(expected);
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const after = await page.evaluate(readConversationDom);
          if (after.displayName !== contact.displayName || after.avatar !== contact.avatar) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '发送后会话发生变化，未再次发送。' };
          const messages = this.identities.identify(recipientId, after.messages);
          const sent = messages.find(item => item.direction === 'outgoing' && item.text === message.trim() && !beforeIds.has(item.id));
          if (sent && !sent.failed && !sent.pending) return { ...receipt, confirmed: true, messageId: sent.id, deliveryUncertain: false };
          if (sent?.failed) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '网页显示发送失败，未自动重试。' };
          stop(signal);
          await page.waitForTimeout(200);
        }
        return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '未取得新发出消息的界面回读，未自动重试。' };
      } catch {
        if (!clicked) await editor.evaluate((element,own)=>{
          // 只清除本次写入的完整回复；用户已改动的草稿保留。
          const readable=value=>value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g,'').trim();
          if(readable(element.innerText)===readable(own)) {
            element.textContent='';
            element.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward'}));
          }
        },message).catch(()=>{});
        return { ...receipt, confirmed: false, deliveryUncertain: clicked, reason: clicked ? '发送动作已尝试但结果不确定，未自动重试。' : '发送前检查未通过，未点击发送。' };
      } finally {
        monitoring = false; clearInterval(monitor); releaseDispatch?.();
        await page.evaluate(token => { const entry = window.__deepseekChatInputs?.[token]; entry?.cleanup(); if (window.__deepseekChatInputs) delete window.__deepseekChatInputs[token]; }, witnessId).catch(() => {});
      }
    }, { signal });
  }
  async close() { await this.controller.close(); }
}
