import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { BrowserController } from './core.mjs?v=9';
import { messageFingerprint, messageContent, messageWatermark, compareMessageWatermark } from './chat-message.mjs';
import { MessageIdentityTracker } from './message-tracker.mjs';
import { matchesAuthorizedContact, hasStableConversationIdentity } from './contact-authorization.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { imageFileType, UPLOAD_STAGING_CONTRACT, readUploadStagingContractDom, readImageUploadPreviewDom, installImageDispatchGuardDom } from './chat-output.mjs';
export { MessageIdentityTracker } from './message-tracker.mjs';

const HOME = 'https://www.douyin.com/?recommend=1&from_nav=1';
const hash = value => createHash('sha256').update(value).digest('hex');
const stop = signal => signal?.throwIfAborted();
const AUDIO_LIMIT = 25 * 1024 * 1024;
const publicAudioAddress = address => !/^(?:0\.|10\.|127\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|192\.0\.|192\.0\.2\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|198\.(?:18|19|51)\.|203\.0\.113\.|22[4-9]\.|2[3-5]\d\.)/.test(address);
function voiceAudioResponse(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: 'GET', family: 4, signal, lookup: (hostname, options, callback) => {
      lookup(hostname, { all: true, family: 4 }).then(addresses => {
        if (!addresses.length || addresses.some(item => !publicAudioAddress(item.address))) throw new Error('语音资源没有可核对的公网地址。');
        if (options.all) callback(null, addresses); else callback(null, addresses[0].address, 4);
      }).catch(callback);
    } }, response => {
      const status = response.statusCode || 500, headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      if ([204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers })); }
      else resolve(new Response(Readable.toWeb(response), { status, headers }));
    });
    request.once('error', () => reject(new Error('指定语音资源下载失败，未读取其他音频。')));
    request.setTimeout(20_000, () => request.destroy(new Error('指定语音资源下载超时。'))); request.end();
  });
}
const allowedAudioUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && ['douyin.com', 'douyincdn.com', 'douyinstatic.com', 'byteimg.com', 'ibytedtos.com', 'bytedance.com', 'douyinpic.com', 'snssdk.com', 'bytecdn.cn', 'douyinvod.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)); } catch { return false; }
};
function chatAudioFormat(bytes) {
  if (bytes.length < 8) return null;
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') return { mimeType: 'audio/wav', extension: 'wav' };
  if (bytes.subarray(0, 4).toString() === 'OggS') return { mimeType: 'audio/ogg', extension: 'ogg' };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { mimeType: 'audio/webm', extension: 'webm' };
  if (bytes.subarray(4, 8).toString() === 'ftyp') return { mimeType: 'audio/mp4', extension: 'm4a' };
  if (bytes.subarray(0, 6).toString() === '#!AMR\n' || bytes.subarray(0, 9).toString() === '#!AMR-WB\n') return { mimeType: 'audio/amr', extension: 'amr' };
  if (bytes.subarray(0, 3).toString() === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) return { mimeType: 'audio/mpeg', extension: 'mp3' };
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return { mimeType: 'audio/aac', extension: 'aac' };
  return null;
}
const readableDraft = value => value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim();
const localDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const contactIdentityKey = row => row.nativeId ? `native:${row.nativeId}` : row.identityKey ? `rendered:${row.identityKey}` : row.conversationType === 'direct' && row.profileUrl ? `user:${row.profileUrl}` : null;
const sameConversationIdentity = (current, contact) => Boolean(current && contact && current.identityUnavailable !== true && !current.identityConflict && !contact.identityConflict
  && current.isGroup === contact.isGroup && current.conversationType === contact.conversationType
  && (!current.identityKey || !contact.identityKey || current.identityKey === contact.identityKey)
  && contactIdentityKey(current) && contactIdentityKey(current) === contactIdentityKey(contact));
const normalizeDisplayName = value => String(value || '').normalize('NFKC').replace(/[，、,]\s*/g, '，').replace(/\s+/g, ' ').trim();
const sameWeakConversation = (current, contact) => hasStableConversationIdentity(contact) ? sameConversationIdentity(current, contact) : Boolean(current && contact && current.identityConflict !== true && !contact.identityConflict
  && current.isGroup === contact.isGroup && current.conversationType === contact.conversationType
  && typeof current.displayName === 'string' && current.displayName
  && (() => {
    const actual = normalizeDisplayName(current.displayName), expected = normalizeDisplayName(contact.displayName || contact.name);
    return Boolean(expected) && (actual === expected || current.isGroup === true && actual.startsWith(expected) && /^\s*\(\d{1,6}\)$/.test(actual.slice(expected.length)));
  })());
const contactOpaqueId = row => `conv:${hash(contactIdentityKey(row) ?? `${row.displayName}\0${row.avatar}`)}`;
const contactIdentityBinding = row => !row.identityConflict && contactIdentityKey(row) && ['direct', 'group'].includes(row.conversationType)
  ? `binding:${hash(`${row.conversationType}\0${contactIdentityKey(row)}`)}` : null;
const stableIdentityFields = row => contactIdentityBinding(row) ? { identityVersion: 2, identityKind: row.nativeId ? 'native-conversation' : row.identityKey ? `rendered-${row.identityKey.split(':')[0]}` : 'profile-user', identityHash: hash(contactIdentityKey(row)) } : {};
const expectedDomIdentity = contact => ({ expectedKey: contactIdentityKey(contact), expectedType: contact.conversationType, expectedRenderedKey: contact.identityKey || null });

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
export async function readContactDom() {
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const groupPrototypeIdentity = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { id: null, shortId: null, conflict: false, signature: 'absent' };
    const prototype = Object.getPrototypeOf(value), result = { id: null, shortId: null, conflict: false };
    const shape = descriptor => !descriptor ? ['absent'] : !Object.hasOwn(descriptor, 'value') ? ['accessor'] : ['data', typeof descriptor.value, typeof descriptor.value === 'string' || Number.isSafeInteger(descriptor.value) ? String(descriptor.value) : null];
    const signatures = ['conversationId', 'conversationShortId', 'groupId', 'id', 'shortId', 'conversationType', 'type'].map(key => shape(Object.getOwnPropertyDescriptor(value, key)));
    for (const key of ['id', 'shortId']) {
      const ownDescriptor = Object.getOwnPropertyDescriptor(value, key), descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, key);
      signatures.push(shape(descriptor));
      if (ownDescriptor && !Object.hasOwn(ownDescriptor, 'value')) result.conflict = true;
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !/^\d{1,64}$/.test(descriptor.value)) { result.conflict = true; continue; }
      if (ownDescriptor && (!Object.hasOwn(ownDescriptor, 'value') || ownDescriptor.value !== descriptor.value)) { result.conflict = true; continue; }
      result[key] = descriptor.value;
    }
    result.signature = JSON.stringify([result.id, result.shortId, result.conflict, signatures]);
    return result;
  };
  const digest = async value => globalThis.crypto?.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('') : null;
  const groupRowConversations = row => {
    const values = [], seen = new Set();
    const visit = (props, depth) => {
      if (!props || typeof props !== 'object' || seen.has(props)) return;
      seen.add(props);
      for (const key of ['conversation', 'conversationInfo', 'conversationData']) { const value = own(props, key); if (value && typeof value === 'object' && !Array.isArray(value)) values.push(value); }
      if (depth >= 3) return;
      const children = own(props, 'children');
      if (Array.isArray(children)) { for (let index = 0; index < Math.min(100, own(children, 'length') || 0); index++) visit(own(own(children, String(index)), 'props'), depth + 1); }
      else visit(own(children, 'props'), depth + 1);
    };
    const propsKeys = Object.getOwnPropertyNames(row).filter(key => key.startsWith('__reactProps$'));
    if (propsKeys.length === 1) visit(own(row, propsKeys[0]), 0);
    const fiberKeys = Object.getOwnPropertyNames(row).filter(key => key.startsWith('__reactFiber$'));
    if (fiberKeys.length === 1) {
      let fiber = own(row, fiberKeys[0]);
      const fibers = new Set();
      for (let depth = 0; fiber && typeof fiber === 'object' && depth < 4 && !fibers.has(fiber); depth++, fiber = own(fiber, 'return')) {
        fibers.add(fiber);
        const props = own(fiber, 'memoizedProps');
        for (const key of ['conversation', 'conversationInfo', 'conversationData']) { const value = own(props, key); if (value && typeof value === 'object' && !Array.isArray(value)) values.push(value); }
      }
    }
    return [...new Set(values)];
  };
  const renderedIdentity = async row => {
    const keys = Object.getOwnPropertyNames(row).filter(key => key.startsWith('__reactProps$'));
    if (keys.length !== 1) return { identityKey: null, identitySource: null, identityConflict: keys.length > 1 };
    const identities = new Map(), types = new Set(), seen = new Set();
    const inspect = (value, conversation = false) => {
      if (!value || typeof value !== 'object') return;
      for (const [family, fields] of [['conversation', ['conversationId', ...(conversation ? ['id'] : [])]], ['conversation-short', ['conversationShortId', ...(conversation ? ['shortId'] : [])]], ['group', ['groupId']], ['user', ['secUid', ...(conversation ? ['_toParticipantSecUserId'] : [])]], ['user-id', ['userId']]]) {
        for (const field of fields) { const id = own(value, field); if (typeof id !== 'string' && !Number.isSafeInteger(id)) continue; const normalized = String(id).trim(); if (normalized && normalized.length <= 512) { const set = identities.get(family) ?? new Set(); set.add(normalized); identities.set(family, set); } }
      }
      for (const field of ['conversationType', 'type']) { const type = own(value, field); if (typeof type === 'string' && ['direct', 'single', 'personal', 'group'].includes(type.toLowerCase())) types.add(type.toLowerCase() === 'group' ? 'group' : 'direct'); }
    };
    const visit = (props, depth) => {
      if (!props || typeof props !== 'object' || seen.has(props)) return; seen.add(props); inspect(props);
      for (const key of ['conversation', 'conversationInfo', 'conversationData']) inspect(own(props, key), true);
      if (depth >= 3) return;
      const children = own(props, 'children');
      for (const child of (Array.isArray(children) ? children : [children]).slice(0, 100)) visit(own(child, 'props'), depth + 1);
    };
    // 只读取已渲染行的三层 children props 和明确会话对象的标量身份，不执行 getter。
    visit(own(row, keys[0]), 0);
    const groupEligible = () => row.getAttribute('data-conversation-type') === 'group' || row.getAttribute('data-is-group') === 'true' || Boolean(row.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]')) || types.has('group') || !row.querySelector('a[href*="/user/"]') && /[,，、]/.test(row.querySelector('.conversationConversationItemtitle,[data-e2e="conversation-name"]')?.textContent || '');
    const groupRoots = () => { const roots = [own(row, keys[0])], fiberKeys = Object.getOwnPropertyNames(row).filter(key => key.startsWith('__reactFiber$')); if (fiberKeys.length !== 1) return roots; let fiber = own(row, fiberKeys[0]); for (let depth = 0; fiber && typeof fiber === 'object' && depth < 4; depth++, fiber = own(fiber, 'return')) roots.push(fiber); return roots; };
    const initialGroupRoots = groupEligible() ? groupRoots() : null;
    const initialGroupConversations = groupEligible() ? groupRowConversations(row) : null;
    const initialGroupOwners = initialGroupConversations?.map(value => Object.getPrototypeOf(value));
    const groupSignature = () => JSON.stringify([groupEligible(), row.getAttribute('data-conversation-type'), row.getAttribute('data-is-group'), groupRowConversations(row).map(value => groupPrototypeIdentity(value).signature)]);
    const initialGroupSignature = groupEligible() ? groupSignature() : null;
    let prototypeConflict = false;
    if (groupEligible()) for (const value of groupRowConversations(row)) {
      const group = groupPrototypeIdentity(value); prototypeConflict ||= group.conflict;
      for (const [family, id] of [['conversation', group.id], ['conversation-short', group.shortId]]) if (id) { const set = identities.get(family) ?? new Set(); set.add(id); identities.set(family, set); }
    }
    if (prototypeConflict || [...identities.values()].some(values => values.size !== 1) || types.size > 1) return { identityKey: null, identitySource: null, identityConflict: true };
    const selected = [...identities].find(([family]) => ['conversation', 'conversation-short', 'group'].includes(family)) ?? [...identities].find(([family]) => family === 'user') ?? [...identities][0];
    if (!selected) return { identityKey: null, identitySource: null, identityConflict: false, renderedType: [...types][0] ?? null };
    const fingerprint = await digest([...selected[1]][0]);
    if (initialGroupSignature !== null && (!row.isConnected || initialGroupSignature !== groupSignature() || JSON.stringify(groupRoots().map((value, index) => value === initialGroupRoots[index])) !== JSON.stringify(initialGroupRoots.map(() => true)) || JSON.stringify(groupRowConversations(row).map((value, index) => value === initialGroupConversations[index] && Object.getPrototypeOf(value) === initialGroupOwners[index])) !== JSON.stringify(initialGroupConversations.map(() => true)))) return { identityKey: null, identitySource: null, identityConflict: true };
    return { identityKey: fingerprint ? `${selected[0]}:${fingerprint}` : null, identitySource: fingerprint ? 'rendered-row-metadata' : null, identityConflict: false, renderedType: [...types][0] ?? null };
  };
  const dialog = document.querySelector('[data-e2e="im-dialog"]');
  return Promise.all([...(dialog?.querySelectorAll('[data-e2e="conversation-item"]') ?? [])].map(async (row, index) => {
    const metadata = await renderedIdentity(row);
    let profileUrl = null;
    const name = row.querySelector('.conversationConversationItemtitle,[data-e2e="conversation-name"]');
    const link = name?.closest('a[href]') || name?.querySelector('a[href]') || row.querySelector('a[data-e2e="conversation-user"][href]');
    try { const url = new URL(link?.getAttribute('href'), location.href); if (url.protocol === 'https:' && url.hostname === 'www.douyin.com' && /^\/user\/[^/?#]+\/?$/.test(url.pathname)) profileUrl = url.origin + url.pathname; } catch {}
    const relationshipLabel = clean(row.querySelector('[data-e2e="follow-status"],[data-e2e="relationship"]')?.textContent);
    const displayName = clean(name?.textContent);
    const groupAvatar = row.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]');
    const declared = row.getAttribute('data-conversation-type') || metadata.renderedType;
    const looksLikeGroup = !profileUrl && /[,，、]/.test(displayName);
    const isGroup = declared === 'group' || row.getAttribute('data-is-group') === 'true' || Boolean(groupAvatar) || looksLikeGroup;
    const isDirect = !isGroup && (['direct', 'single', 'personal'].includes(declared) || row.getAttribute('data-is-group') === 'false' || Boolean(profileUrl) || /^user(?:-id)?:/.test(metadata.identityKey || '') && Boolean(row.querySelector('.commonIMAvataravatarContainer img')));
    const conversationType = isGroup || !isDirect ? 'group' : 'direct';
    const groupImages = [...(groupAvatar?.querySelectorAll('img') ?? [])].map(image => resource(image.getAttribute('src'))).filter(Boolean).sort();
    const avatar = isGroup ? groupImages.length ? `group-avatar:${JSON.stringify(groupImages)}` : groupAvatar ? 'group-marker' : resource(row.querySelector('img')?.getAttribute('src')) : resource(row.querySelector('.commonIMAvataravatarContainer img,img')?.getAttribute('src'));
    const identityConflict = metadata.identityConflict || Boolean(metadata.renderedType && metadata.renderedType !== conversationType);
    const identityKey = isGroup && metadata.identityKey && !/^(?:conversation|conversation-short|group):/.test(metadata.identityKey) ? null : metadata.identityKey;
    return ({
    index,
    displayName,
    nativeId: row.getAttribute('data-conversation-id') || row.getAttribute('data-conversation-short-id') || null,
    avatar,
    unread: Boolean(row.querySelector('[class*="unread"],[class*="Unread"],[data-e2e="unread-count"]')),
    isGroup: conversationType === 'group', conversationType,
    profileUrl, relationshipLabel: !isGroup && ['已关注', '相互关注', '互相关注'].includes(relationshipLabel) ? relationshipLabel : null,
    ...metadata, identityKey, identityConflict,
  }); }));
}

export function readFollowingDom() {
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const roots = [...document.querySelectorAll('[data-e2e="user-fans-container"],[data-e2e="following-list"],[data-e2e="follow-list"]')].filter(visible);
  const rows = roots.flatMap(root => [...root.querySelectorAll('.OlxToPIh,[data-e2e="follow-user-item"],[data-e2e="user-item"]')]).filter(visible);
  return rows.map(row => {
    const link = row.querySelector('.Zce7SWd3 a,[data-e2e="user-name"],a[href*="/user/"]');
    const displayName = link?.textContent.trim();
    const labels = [...row.querySelectorAll('button,[data-e2e="follow-status"],[data-e2e="relationship"]')].map(e => e.textContent.trim());
    return { displayName, mutual: labels.some(label => ['相互关注', '互相关注'].includes(label)) };
  }).filter(row => row.displayName);
}

export function readConversationListDom() {
  const selectors = ['[data-e2e="im-dialog"] [data-e2e="conversation-list"]', '[data-e2e="im-dialog"] [class*="conversationConversationListwrapper"]'];
  const found = [];
  for (const selector of selectors) [...document.querySelectorAll(selector)].forEach((element, index) => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (rect.width < 1 || rect.height < 1 || style.display === 'none' || style.visibility === 'hidden' || found.some(item => item.element === element)) return;
    if (!element.querySelector('[data-e2e="conversation-item"]')) return;
    found.push({ element, selector, index });
  });
  if (found.length !== 1) return null;
  const { element, selector, index } = found[0];
  const loading = [...element.querySelectorAll('[data-e2e="conversation-loading"],[aria-busy="true"],[class*="loading"],[class*="Loading"]')].some(node => { const rect = node.getBoundingClientRect(), style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; });
  return { selector, index, scrollTop: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, loading };
}

export function readChatBlockers() {
  const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  const labels = [...document.querySelectorAll('body *')].filter(e => !e.childElementCount && visible(e) && !e.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]'));
  return {
    loginRequired: labels.some(e => /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(e.textContent)),
    verificationRequired: [...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"]')].some(visible) || labels.some(e => /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(e.textContent)),
  };
}

export async function readConversationDom({ expectedKey, expectedType, expectedRenderedKey, allowWeak = false } = {}) {
  const clean = value => (value ?? '').trim();
  const quoteSelector = '[data-e2e="message-quote"],[data-e2e="message-reply-preview"],[class*="MessageItemReply"],[class*="MessageItemQuote"],[class*="QuoteMessage"]';
  const readableText = (element, skipQuotes = false) => {
    const parts = [];
    const visit = node => {
      if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent || ''); return; }
      if (!(node instanceof Element) || node.matches('script,style,[aria-hidden="true"]') || skipQuotes && node.matches(quoteSelector)) return;
      if (node.tagName === 'IMG') { const label = clean(node.getAttribute('title') || node.getAttribute('alt') || node.getAttribute('aria-label')); parts.push(label || '[未命名表情]'); return; }
      if (node.tagName === 'BR') { parts.push('\n'); return; }
      for (const child of node.childNodes) visit(child);
    };
    visit(element); return clean(parts.join(''));
  };
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  const dialog = document.querySelector('[data-e2e="im-dialog"]');
  const headers = [...(dialog?.querySelectorAll('[class*="StackLayoutStackChatHeaderuser"],[data-e2e="chat-header"],[data-e2e="group-chat-header"]') ?? [])].filter(visible);
  const header = headers.length === 1 ? headers[0] : null;
  const root = header?.closest('[class*="StackLayoutpagespageRoot"],[data-e2e="chat-page"]');
  const displayName = clean(header?.querySelector('[class*="StackLayoutStackChatHeadertitle"],[data-e2e="chat-title"],[data-e2e="group-chat-title"]')?.textContent).replace(/\s+/g, ' ');
  const groupAvatar = header?.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]');
  const declaredGroup = header?.getAttribute('data-conversation-type') === 'group' || root?.getAttribute('data-conversation-type') === 'group' || header?.getAttribute('data-is-group') === 'true' || Boolean(groupAvatar) || header?.getAttribute('data-e2e') === 'group-chat-header';
  const groupImages = [...(groupAvatar?.querySelectorAll('img') ?? [])].map(image => resource(image.getAttribute('src'))).filter(Boolean).sort();
  const avatar = declaredGroup ? groupImages.length ? `group-avatar:${JSON.stringify(groupImages)}` : groupAvatar ? 'group-marker' : resource(header?.querySelector('img')?.getAttribute('src')) : resource(header?.querySelector('img')?.getAttribute('src'));
  const conversationNativeId = header?.getAttribute('data-conversation-id') || root?.getAttribute('data-conversation-id') || header?.getAttribute('data-conversation-short-id') || root?.getAttribute('data-conversation-short-id') || null;
  const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const groupPrototypeIdentity = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { id: null, shortId: null, conflict: false, signature: 'absent' };
    const prototype = Object.getPrototypeOf(value), result = { id: null, shortId: null, conflict: false };
    const shape = descriptor => !descriptor ? ['absent'] : !Object.hasOwn(descriptor, 'value') ? ['accessor'] : ['data', typeof descriptor.value, typeof descriptor.value === 'string' || Number.isSafeInteger(descriptor.value) ? String(descriptor.value) : null];
    const signatures = ['conversationId', 'conversationShortId', 'groupId', 'id', 'shortId', 'conversationType', 'type'].map(key => shape(Object.getOwnPropertyDescriptor(value, key)));
    for (const key of ['id', 'shortId']) {
      const ownDescriptor = Object.getOwnPropertyDescriptor(value, key), descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, key);
      signatures.push(shape(descriptor));
      if (ownDescriptor && !Object.hasOwn(ownDescriptor, 'value')) result.conflict = true;
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !/^\d{1,64}$/.test(descriptor.value)) { result.conflict = true; continue; }
      if (ownDescriptor && (!Object.hasOwn(ownDescriptor, 'value') || ownDescriptor.value !== descriptor.value)) { result.conflict = true; continue; }
      result[key] = descriptor.value;
    }
    result.signature = JSON.stringify([result.id, result.shortId, result.conflict, signatures]);
    return result;
  };
  const digest = async value => globalThis.crypto?.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('') : null;
  const identities = new Map(), types = new Set(), add = (family, value) => {
    if (typeof value !== 'string' && !Number.isSafeInteger(value)) return;
    const id = String(value).trim(); if (!id || id.length > 512) return;
    const values = identities.get(family) ?? new Set(); values.add(id); identities.set(family, values);
  };
  // 只读取当前可见会话头部已核实的固定 props 路径，不执行 getter 或访问消息对象。
  const keys = header ? Object.getOwnPropertyNames(header).filter(key => key.startsWith('__reactProps$')) : [];
  const props = keys.length === 1 ? own(header, keys[0]) : null, children = own(props, 'children');
  const conversation = own(own(Array.isArray(children) ? own(children, '0') : children, 'props'), 'conversation');
  for (const [family, fields] of [['conversation', ['conversationId', 'id']], ['conversation-short', ['conversationShortId', 'shortId']], ['group', ['groupId']], ['user', ['secUid', '_toParticipantSecUserId']], ['user-id', ['userId']]]) for (const field of fields) add(family, own(conversation, field));
  for (const field of ['conversationType', 'type']) { const type = own(conversation, field); if (typeof type === 'string' && ['direct', 'single', 'personal', 'group'].includes(type.toLowerCase())) types.add(type.toLowerCase() === 'group' ? 'group' : 'direct'); }
  let profileUrl = null;
  for (const link of header?.querySelectorAll('a[href]') ?? []) {
    try { const url = new URL(link.getAttribute('href'), location.href); if (url.protocol === 'https:' && url.hostname === 'www.douyin.com' && /^\/user\/[^/?#]+\/?$/.test(url.pathname)) { if (profileUrl && profileUrl !== url.origin + url.pathname) types.add('conflict'); profileUrl = url.origin + url.pathname; } } catch {}
  }
  for (const declared of [header?.getAttribute('data-conversation-type'), root?.getAttribute('data-conversation-type')]) if (declared && ['direct', 'single', 'personal', 'group'].includes(declared)) types.add(declared === 'group' ? 'group' : 'direct');
  if (declaredGroup) types.add('group');
  else if (profileUrl || identities.has('user') || identities.has('user-id') || header?.getAttribute('data-is-group') === 'false') types.add('direct');
  const looksLikeGroup = /[,，、]/.test(displayName);
  const conversationType = types.size === 1 ? [...types][0] : (declaredGroup || looksLikeGroup || !profileUrl) ? 'group' : 'direct';
  const groupPrototype = conversationType === 'group' ? groupPrototypeIdentity(conversation) : null;
  const groupPrototypeOwner = groupPrototype && conversation ? Object.getPrototypeOf(conversation) : null;
  if (groupPrototype) { add('conversation', groupPrototype.id); add('conversation-short', groupPrototype.shortId); }
  const conflictingNativeIds = new Set([header?.getAttribute('data-conversation-id'), root?.getAttribute('data-conversation-id'), header?.getAttribute('data-conversation-short-id'), root?.getAttribute('data-conversation-short-id')].filter(Boolean));
  let identityConflict = Boolean(groupPrototype?.conflict) || keys.length > 1 || types.size > 1 || conflictingNativeIds.size > 1 || [...identities.values()].some(values => values.size !== 1);
  const selected = [...identities].find(([family]) => ['conversation', 'conversation-short', 'group'].includes(family)) ?? [...identities].find(([family]) => family === 'user') ?? [...identities][0];
  const metadataSignature = () => JSON.stringify([['conversationId', 'id', 'conversationShortId', 'shortId', 'groupId', 'secUid', '_toParticipantSecUserId', 'userId', 'conversationType', 'type'].map(key => { const value = own(conversation, key); return typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : null; }), conversationType === 'group' ? groupPrototypeIdentity(conversation).signature : null, ['conversationId','id'].map(key=>{const d=conversation&&Object.getPrototypeOf(conversation)&&Object.getOwnPropertyDescriptor(Object.getPrototypeOf(conversation),key);return !d?null:!Object.hasOwn(d,'value')?['accessor']:['data',typeof d.value,typeof d.value==='string'?d.value:null];})]);
  const domMetadataSignature = () => JSON.stringify([header, root].map(element => element ? ['data-e2e', 'data-conversation-id', 'data-conversation-short-id', 'data-conversation-type', 'data-is-group'].map(key => element.getAttribute(key)) : null).concat(Boolean(header?.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]'))));
  const initialMetadata = metadataSignature(), initialDomMetadata = domMetadataSignature();
  const fingerprint = selected && !identityConflict ? await digest([...selected[1]][0]) : null;
  const currentProps = keys.length === 1 ? own(header, keys[0]) : null;
  const currentChildren = own(currentProps, 'children'), currentConversation = own(own(Array.isArray(currentChildren) ? own(currentChildren, '0') : currentChildren, 'props'), 'conversation');
  const currentHeaders = [...document.querySelectorAll('[data-e2e="im-dialog"] [class*="StackLayoutStackChatHeaderuser"],[data-e2e="im-dialog"] [data-e2e="chat-header"],[data-e2e="im-dialog"] [data-e2e="group-chat-header"]')].filter(visible);
  if (!header?.isConnected || currentHeaders.length !== 1 || currentHeaders[0] !== header || currentProps !== props || currentConversation !== conversation || groupPrototype && conversation && Object.getPrototypeOf(conversation) !== groupPrototypeOwner || metadataSignature() !== initialMetadata || domMetadataSignature() !== initialDomMetadata) identityConflict = true;
  const identityKey = fingerprint && (conversationType !== 'group' || ['conversation', 'conversation-short', 'group'].includes(selected[0])) ? `${selected[0]}:${fingerprint}` : null;
  const identity = { displayName, avatar, nativeId: conversationNativeId, identityKey, profileUrl, identityConflict, ...(groupPrototype?.id || groupPrototype?.shortId ? { groupPrototypeIdentity: true } : {}), isGroup: conversationType === 'group', conversationType };
  const stableKey = conversationNativeId ? `native:${conversationNativeId}` : identityKey ? `rendered:${identityKey}` : conversationType === 'direct' && profileUrl ? `user:${profileUrl}` : null;
  if (!header || identityConflict || (!stableKey && !allowWeak) || expectedKey && (stableKey !== expectedKey || conversationType !== expectedType || expectedRenderedKey && identityKey && identityKey !== expectedRenderedKey)) return { ...identity, messages: [], identityUnavailable: true, loading: false };
  let timestamp = null;
  const messages = [];
  const dataField = (object, key) => {
    if (!object || typeof object !== 'object') return undefined;
    const ownDescriptor = Object.getOwnPropertyDescriptor(object, key), prototype = Object.getPrototypeOf(object);
    const inherited = prototype && Object.getOwnPropertyDescriptor(prototype, key);
    if (ownDescriptor && !Object.hasOwn(ownDescriptor, 'value') || inherited && !Object.hasOwn(inherited, 'value')) return undefined;
    if (ownDescriptor && inherited && ownDescriptor.value !== inherited.value) return undefined;
    return ownDescriptor ? ownDescriptor.value : inherited?.value;
  };
  const renderedMessage = element => {
    const keys = Object.getOwnPropertyNames(element).filter(key => key.startsWith('__reactProps$'));
    const children = keys.length === 1 ? own(own(element, keys[0]), 'children') : null;
    const child = Array.isArray(children) ? own(children, '0') : children;
    return own(own(child, 'props'), 'message');
  };
  const conversationIdCandidate = conversationNativeId || groupPrototype?.id || dataField(conversation, 'conversationId') || dataField(conversation, 'id') || null;
  const expectedConversationId = typeof conversationIdCandidate==='string' && conversationIdCandidate.length<=512 && !/[\u0000-\u0020\u007f]/.test(conversationIdCandidate) ? conversationIdCandidate : null;
  const selfUids = new Set();
  let selfConflict = false, selfLoggedOut = false;
  const selfAnchors = [...document.querySelectorAll('.tab-user_self a[href]')].filter(element => visible(element) && !element.closest('[data-e2e="im-dialog"],[data-e2e="comment-item"]'));
  if (selfAnchors.length === 1) {
    let route; try { route = new URL(selfAnchors[0].getAttribute('href'), location.origin); } catch {}
    const routeId = route?.origin === 'https://www.douyin.com' && !route.username && !route.password ? /^\/user\/([A-Za-z0-9_-]{1,300})\/?$/.exec(route.pathname)?.[1] : null;
    if (routeId) for (const element of new Set([selfAnchors[0], selfAnchors[0].closest('.tab-user_self')])) {
      if (!element) continue;
      const keys = Object.getOwnPropertyNames(element).filter(key => key.startsWith('__reactFiber$'));
      if (keys.length > 1) { selfConflict = true; continue; }
      let fiber = keys.length === 1 ? own(element, keys[0]) : null;
      for (let depth = 0; fiber && depth <= 5; depth++) {
        if (depth) fiber = dataField(fiber, 'return'); if (!fiber) break;
        const user = dataField(dataField(fiber, 'memoizedProps'), 'userInfo');
        if (!user || typeof user !== 'object') continue;
        const loggedIn = dataField(user, 'isLogin'), status = dataField(user, 'statusCode');
        if (loggedIn === false || typeof status === 'number' && status !== 0) { selfLoggedOut = true; continue; }
        if (loggedIn !== true || status !== 0) continue;
        const info = dataField(user, 'info'), secure = dataField(info, 'secUid') ?? dataField(info, 'sec_uid');
        if (routeId !== 'self' && secure !== routeId) { selfConflict = true; continue; }
        const values = ['uid', 'userId', 'user_id'].map(key => dataField(info, key)).filter(value => value !== undefined);
        if (values.some(value => typeof value !== 'string' || !/^\d{1,64}$/.test(value))) { selfConflict = true; continue; }
        values.forEach(value => selfUids.add(value));
      }
    }
  }
  const selfUid = !selfConflict && !selfLoggedOut && selfUids.size === 1 ? [...selfUids][0] : null;
  const contents = '[data-e2e="msg-item-content"],[data-e2e="message-content"],[data-testid="message-content"]';
  const nodes = [...(root?.querySelectorAll(`[class*="MessageBoxTimetimeLayout"],time,${contents}`) ?? [])].filter(node => !node.matches(contents) || !node.parentElement?.closest(contents));
  const list = root?.querySelector('[class*="messageMessageListlist"],[data-e2e="message-list"]');
  let newestFirst = false, chronologySource = list ? 'message-list-order-unverified' : 'dom-order';
  if (list) {
    const style = getComputedStyle(list);
    let verticallyFlipped = false;
    try { verticallyFlipped = style.transform !== 'none' && new DOMMatrix(style.transform).d < 0; } catch {}
    newestFirst = verticallyFlipped || style.flexDirection === 'column-reverse';
    if (newestFirst) chronologySource = verticallyFlipped ? 'message-list-vertical-transform' : 'message-list-column-reverse';
  }
  for (const node of nodes) {
    if (!node.matches(contents)) { timestamp = node.getAttribute('datetime') || clean(node.textContent) || timestamp; continue; }
    const box = node.closest('[class*="messageMessageBoxmessageBox"],[data-e2e="message-row"]') || node;
    const model = renderedMessage(node), modelConversationId = dataField(model, 'conversationId');
    const modelBound = typeof expectedConversationId === 'string' && modelConversationId === expectedConversationId;
    const parsed = modelBound ? own(model, '_parsedContent') : null;
    const ancestors = []; for (let e = node; e && e !== root && root?.contains(e); e = e.parentElement) ancestors.push(e);
    const fromMe = ancestors.some(e => e.getAttribute('data-direction') === 'outgoing' || e.getAttribute('data-is-self') === 'true' || e.getAttribute('data-is-from-me') === 'true' || [...e.classList].some(token => /(?:^|[_-]|Content|Box)isFromMe(?:[_-]|$)/i.test(token)));
    const incoming = ancestors.some(e => e.getAttribute('data-direction') === 'incoming' || e.getAttribute('data-is-self') === 'false' || e.getAttribute('data-is-from-me') === 'false');
    const direction = fromMe && !incoming ? 'outgoing' : incoming && !fromMe || !fromMe && box.classList.contains('messageMessageBoxmessageBox') ? 'incoming' : 'unknown';
    // 引用预览属于历史资料，不能冒充本条正文、媒体或新的群聊呼叫。
    const ownNodes = selector => [...node.querySelectorAll(selector)].filter(element => !element.closest(quoteSelector));
    const ownNode = selector => ownNodes(selector)[0] || null;
    const quoted = [...node.querySelectorAll(quoteSelector)].filter(element => !element.parentElement?.closest(quoteSelector));
    const reference = quoted.length ? { text: quoted.map(element => readableText(element)).join('\n').slice(0, 1200), scope: 'visible-quoted-message', contentStatus: 'preview-only' } : null;
    const textNode = ownNode('[class*="MessageItemTextcontainer"],[data-e2e="message-text"]');
    const emoji = ownNode('[class*="MessageItemEmojiemojiBox"],[data-e2e="message-emoji"],[data-e2e="message-sticker"],[class*="MessageItemSticker"]');
    const share = ownNode('[class*="MessageItemShareAwemecontainer"],[data-e2e="shared-video-card"]');
    const image = !emoji && !share ? ownNode('[class*="MessageItemImagecontainer"],[class*="MessageItemImageimageBox"],[class*="MessageItemImageImageBox"],[data-e2e="message-image"]') : null;
    const voice = !emoji && !share && !image ? ownNode('[class*="MessageItemAudio"],[class*="MessageItemVoice"],[data-e2e="message-voice"],[data-e2e="message-audio"]') : null;
    const inlineEmoji = textNode ? [...textNode.querySelectorAll('[class*="TextMessageTextemoji"] img,[data-e2e="inline-emoji"] img,img[data-e2e="inline-emoji"]')] : [];
    let kind = emoji ? 'emoji' : share ? 'video' : image ? 'image' : voice ? 'voice' : textNode || reference ? 'text' : 'unsupported';
    let text = textNode ? readableText(textNode, true).slice(0, 8000) : '';
    let media = null;
    if (inlineEmoji.length && inlineEmoji.some(item => !clean(item.getAttribute('title') || item.getAttribute('alt') || item.getAttribute('aria-label')))) {
      media = { type: 'emoji', inline: true, label: null, images: inlineEmoji.map(item => ({ src: item.currentSrc || item.getAttribute('src') || '', label: clean(item.getAttribute('title') || item.getAttribute('alt') || item.getAttribute('aria-label')) || null })), requiresVisual: true, understandingScope: 'single-message-image' };
    }
    if (emoji) {
      const images = [...emoji.querySelectorAll('img')].map(image => ({ src: image.currentSrc || image.getAttribute('src') || '', label: clean(image.getAttribute('alt') || image.getAttribute('aria-label') || image.getAttribute('title')) || null }));
      const label = clean(emoji.getAttribute('aria-label') || emoji.getAttribute('title')) || images.map(image => image.label).filter(Boolean).join(' ') || null;
      media = { type: 'emoji', label, images, requiresVisual: true, understandingScope: 'single-message-image' };
    }
    if (share) {
      let url = null, videoId = null, publicUrlSource = null;
      const domIds = new Set(); let invalidLink = false;
      for (const link of share.querySelectorAll('a[href]')) {
        const href = link.getAttribute('href');
        if (typeof href !== 'string' || href.length > 300) { invalidLink = true; continue; }
        try {
          const candidate = new URL(href, location.href), match = /^\/video\/(\d{1,64})\/?$/.exec(candidate.pathname);
          if (!/^(?:www\.)?douyin\.com$/.test(candidate.hostname) || !candidate.pathname.startsWith('/video/')) continue;
          if (candidate.protocol !== 'https:' || candidate.username || candidate.password || candidate.port || !match) { invalidLink = true; continue; }
          domIds.add(match[1]);
        } catch { invalidLink = true; }
      }
      const parsedDescriptor = modelBound ? Object.getOwnPropertyDescriptor(model, '_parsedContent') : null;
      const parsedObject = parsedDescriptor && Object.hasOwn(parsedDescriptor, 'value') && parsedDescriptor.value && typeof parsedDescriptor.value === 'object' && !Array.isArray(parsedDescriptor.value) ? parsedDescriptor.value : null;
      const itemDescriptor = parsedObject ? Object.getOwnPropertyDescriptor(parsedObject, 'itemId') : null;
      const nativeItemId = itemDescriptor && Object.hasOwn(itemDescriptor, 'value') && typeof itemDescriptor.value === 'string' && /^\d{1,64}$/.test(itemDescriptor.value) ? itemDescriptor.value : null;
      const invalidNative = Boolean(parsedDescriptor && !parsedObject || itemDescriptor && !nativeItemId);
      const stableServerId = modelBound ? dataField(model, 'serverId') : null;
      const stableMessage = box.getAttribute('data-message-id') || box.getAttribute('data-msg-id') || node.getAttribute('data-message-id') || (typeof stableServerId === 'string' && /^[1-9]\d{0,63}$/.test(stableServerId) ? stableServerId : null);
      const trustedNativeId = typeof stableMessage === 'string' && stableMessage.length > 0 && stableMessage.length <= 500 && stableMessage.trim() === stableMessage && !/[\u0000-\u001f\u007f]/.test(stableMessage) ? nativeItemId : null;
      const domId = domIds.size === 1 ? [...domIds][0] : null;
      const cardIdentityConflict = invalidLink || invalidNative || domIds.size > 1 || node.querySelectorAll('[class*="MessageItemShareAwemecontainer"],[data-e2e="shared-video-card"]').length !== 1 || Boolean(nativeItemId && domId && nativeItemId !== domId);
      if (!cardIdentityConflict) {
        videoId = trustedNativeId || domId;
        if (videoId) { url = 'https://www.douyin.com/video/' + videoId; publicUrlSource = trustedNativeId ? domId ? 'dom-link-and-rendered-item-id' : 'rendered-message-item-id' : 'dom-link'; }
      }
      const title = clean(share.querySelector('[class*="MessageItemShareAwemetitle"],[class*="MessageItemShareAwemedesc"],[data-e2e="shared-video-title"]')?.textContent) || null;
      const author = clean(share.querySelector('[class*="MessageItemShareAwemeauthorName"],[data-e2e="shared-video-author"]')?.textContent) || null;
      const cover = share.querySelector('.MessageItemShareAwemeawemeContainer,img:not(.MessageItemShareAwemephotosTag):not(.MessageItemShareAwemeauthorAvatar)');
      media = { type: 'shared-work', videoId, url, title, author, isPhotoGallery: Boolean(share.querySelector('.MessageItemShareAwemephotosTag')),
        images: cover ? [{ src: cover.currentSrc || cover.getAttribute('src') || '', label: clean(cover.getAttribute('alt')) || null }] : [],
        requiresVisual: true, understandingScope: 'card-cover-and-dom-metadata', publicUrlSource: url ? publicUrlSource : null, identityConflict: cardIdentityConflict, canResolveByOpeningCard: !cardIdentityConflict };
    }
    if (image) {
      const images = [...image.querySelectorAll('img')].map(item => ({ src: item.currentSrc || item.getAttribute('src') || '', label: clean(item.getAttribute('alt') || item.getAttribute('aria-label')) || null }));
      if (image.tagName === 'IMG') images.unshift({ src: image.currentSrc || image.getAttribute('src') || '', label: clean(image.getAttribute('alt')) || null });
      const actualImages = image.tagName === 'IMG' ? [image] : [...image.querySelectorAll('img')];
      media = { type: 'image', images, imageReady: images.length > 0 && images.length <= 4 && actualImages.every(item => item.complete === true && item.naturalWidth > 0) && images.every(item => Boolean(item.src)), requiresVisual: true, understandingScope: 'single-message-image' };
      const digest = modelBound ? own(parsed, 'md5') : null;
      if(typeof digest==='string'&&/^[a-f0-9]{32}$/i.test(digest))media.imageMd5=digest.toLowerCase();
    }
    if (voice) {
      const audio = voice.matches('audio') ? voice : voice.querySelector('audio');
      let source = audio?.currentSrc || audio?.getAttribute('src') || audio?.querySelector('source[src]')?.getAttribute('src') || voice.getAttribute('data-audio-src') || '';
      let rendererDuration = null;
      if (!source && voice.matches('[class*="MessageItemAudioaudioBoxWrapper"]')) {
        const own = (object, key) => object && typeof object === 'object' ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
        const keys = Object.getOwnPropertyNames(voice).filter(key => key.startsWith('__reactProps$'));
        if (keys.length === 1) {
          // 仅取这条已渲染语音控件的固定资源字段，不遍历状态、不执行 getter 或播放器回调。
          const children = own(own(own(voice, keys[0]), 'children'), '0');
          const audioChild = own(own(own(children, 'props'), 'children'), '1');
          const data = own(own(audioChild, 'props'), 'data');
          const urls = own(own(data, 'resource_url'), 'url_list');
          const first = own(urls, '0');
          if (typeof first === 'string' && first.length <= 8192) source = first;
          const duration = own(data, 'duration'); if (Number.isFinite(duration) && duration > 0) rendererDuration = duration;
        }
      }
      const durationValue = voice.getAttribute('data-duration') || audio?.getAttribute('data-duration') || '';
      const durationMatch = /^\s*(\d+(?:\.\d+)?)\s*(?:秒|["″])?\s*$/.exec(durationValue || clean(voice.querySelector('[data-e2e="voice-duration"],[class*="duration"],[class*="Duration"]')?.textContent));
      const visibleDuration = durationMatch ? Number(durationMatch[1]) : Number.isFinite(audio?.duration) ? audio.duration : null;
      const durationVerified = visibleDuration !== null && (rendererDuration === null || rendererDuration / 1000 >= visibleDuration && rendererDuration / 1000 < visibleDuration + 1.05);
      const durationSeconds = durationVerified ? rendererDuration === null ? visibleDuration : rendererDuration / 1000 : null;
      media = { type: 'voice', durationSeconds, audioSources: source ? [{ src: source }] : [], requiresTranscription: true, understandingScope: 'single-message-audio' };
    }
    // 只读取本条已渲染消息的可见资料，不打开链接、下载文件或执行卡片动作。
    const notice = ownNode('[data-e2e="message-recalled"],[data-e2e="message-withdrawn"],[class*="MessageItemRecall"],[class*="MessageItemRevoke"]');
    const system = ownNode('[data-e2e="message-system"],[data-e2e="system-notice"],[class*="MessageItemSystem"]');
    let nonReplyableNotice = false;
    if (notice || system) { kind = notice ? 'recalled' : 'system'; text = readableText(notice || system).slice(0, 600); media = null; nonReplyableNotice = true; }
    if (!media && !nonReplyableNotice && text) {
      const urls = [...new Set((text.match(/https:\/\/www\.douyin\.com\/video\/\d{1,64}(?=$|[/?#\s<>"'，。！？])(?:[/?#][^\s<>"'，。！？]*)?/g) || []).map(value => { try { const target = new URL(value), match = /^\/video\/(\d{1,64})\/?$/.exec(target.pathname); return match ? target.origin + '/video/' + match[1] : null; } catch { return null; } }).filter(Boolean))];
      if (urls.length === 1) { const url = urls[0]; media = { type: 'shared-work', videoId: url.split('/').at(-1), url, title: null, author: null, images: [], requiresVisual: true, understandingScope: 'public-work-link-only', publicUrlSource: 'current-message-public-work-link', identityConflict: false, canResolveByOpeningCard: false }; }
    }
    if (!media && !nonReplyableNotice) {
      const cards = [
        ['file', '[data-e2e="message-file"],[class*="MessageItemFile"]'],
        ['location', '[data-e2e="message-location"],[class*="MessageItemLocation"]'],
        ['user-card', '[data-e2e="message-user-card"],[class*="MessageItemShareUser"],[class*="MessageItemUserCard"]'],
        ['live', '[data-e2e="message-live"],[class*="MessageItemShareLive"],[class*="MessageItemLive"]'],
        ['music', '[data-e2e="message-music"],[class*="MessageItemShareMusic"]'],
        ['call', '[data-e2e="message-call"],[class*="MessageItemCall"]'],
        ['gift', '[data-e2e="message-gift"],[class*="MessageItemGift"],[class*="MessageItemRedPacket"]'],
        ['video-attachment', '[data-e2e="message-video"],[class*="MessageItemVideo"]'],
        ['link', '[data-e2e="message-link"],[class*="MessageItemShareLink"],[class*="MessageItemLink"]'],
      ];
      const match = cards.map(([type, selector]) => ({ type, element: ownNode(selector) })).find(item => item.element);
      if (match) {
        kind = match.type;
        media = { type: match.type, title: readableText(match.element).slice(0, 1000) || null, understandingScope: 'visible-message-metadata-only', contentStatus: 'not-opened' };
        const href = match.element.querySelector('a[href]')?.getAttribute('href');
        if (href) { try { const target = new URL(href, location.href); if (['https:', 'http:'].includes(target.protocol) && !target.username && !target.password) media.domain = target.hostname; } catch {} }
      } else if (kind === 'unsupported') {
        const label = clean(node.getAttribute('aria-label') || ownNode('[data-e2e="message-placeholder"]')?.textContent).slice(0, 200);
        kind = 'unknown';
        media = { type: 'unknown', label: label || '未识别的消息附件', understandingScope: 'visible-message-metadata-only', contentStatus: 'unavailable' };
      }
    }
    if (media && ['emoji', 'image'].includes(media.type)) {
      media.animatedHint = (media.images || []).some(item => { try { return /\.gif$/i.test(new URL(item.src, location.href).pathname); } catch { return false; } }) || Boolean(emoji?.matches('[data-animated="true"]'));
    }
    const indexNode = node.closest('[data-index]');
    const rawOrder = indexNode?.getAttribute('data-index');
    const order = rawOrder !== null && rawOrder !== undefined && /^\d+$/.test(rawOrder) ? Number(rawOrder) : null;
    const serverId = modelBound ? dataField(model, 'serverId') : null;
    const rendererClientId = modelBound ? dataField(model, 'clientId') : null;
    const clientId = direction === 'outgoing' && typeof rendererClientId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(rendererClientId) ? rendererClientId : null;
    const nativeId = box.getAttribute('data-message-id') || box.getAttribute('data-msg-id') || node.getAttribute('data-message-id') || (typeof serverId === 'string' && /^[1-9]\d{0,63}$/.test(serverId) ? serverId : null);
    let modelTimestamp = null;
    if (modelBound) { try { const time = Date.prototype.getTime.call(dataField(model, 'createdAt')); if (Number.isFinite(time) && time >= Date.UTC(2000, 0, 1) && time <= Date.now() + 60_000) modelTimestamp = new Date(time).toISOString(); } catch {} }
    const nativeServerMessageBound = modelBound && typeof serverId === 'string' && /^[1-9]\d{0,63}$/.test(serverId) && nativeId === serverId;
    const ownTimestamp = box.getAttribute('data-sent-at') || box.getAttribute('data-timestamp') || node.getAttribute('data-sent-at') || modelTimestamp;
    const ownTimeNode = box.querySelector('[class*="MessageBoxTimetimeLayout"],time');
    const ownTime = ownTimeNode?.getAttribute('datetime') || clean(ownTimeNode?.textContent);
    const dated = ownTimestamp || ownTime || (!newestFirst ? timestamp : null);
    let member = null;
    if (identity.isGroup) {
      const memberNodes = [...box.querySelectorAll('[data-e2e="message-sender"],[data-e2e="sender-name"],[class*="MessageBoxMessageTitleavatarName"]')].filter(element => !element.closest('[class*="MessageItemShareAwemecontainer"],[data-e2e="shared-video-card"]'));
      const memberNode = memberNodes.length === 1 ? memberNodes[0] : null;
      const domSenders = new Set([box.getAttribute('data-sender-id'), memberNode?.getAttribute('data-user-id')].filter(value => typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)));
      const messageBound = modelBound && typeof serverId === 'string' && /^[1-9]\d{0,63}$/.test(serverId) && nativeId === serverId;
      const prototype = model && typeof model === 'object' ? Object.getPrototypeOf(model) : null;
      const senderDeclared = messageBound && Boolean(Object.getOwnPropertyDescriptor(model, 'sender') || prototype && Object.getOwnPropertyDescriptor(prototype, 'sender'));
      const senderValue = messageBound ? dataField(model, 'sender') : undefined;
      const nativeSender = typeof senderValue === 'string' && /^[1-9]\d{0,63}$/.test(senderValue) ? senderValue : null;
      const domSender = domSenders.size === 1 ? [...domSenders][0] : null;
      const conflict = domSenders.size > 1 || senderDeclared && !nativeSender || Boolean(nativeSender && domSender && nativeSender !== domSender);
      member = { nativeId: conflict ? null : nativeSender || domSender, name: clean(memberNode?.textContent) || null };
    }
    const richInfos = own(parsed, 'richTextInfos'), parsedText = own(parsed, 'text');
    const mentionLabels = [...node.querySelectorAll('.TextMessageTextmentionText')].map(element => readableText(element));
    const nativeSelfMention = identity.isGroup && selfUid && typeof parsedText === 'string' && clean(parsedText) === text && mentionLabels.length > 0 && Array.isArray(richInfos) && richInfos.length <= 100 && richInfos.some(entry => {
      const info = own(entry, 'info'), start = own(entry, 'location'), length = own(entry, 'length');
      return own(info, 'uid') === selfUid && own(info, 'con_id') === modelConversationId && Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(length) && length > 0 && start + length <= parsedText.length && /^[@＠]/.test(parsedText.slice(start, start + length)) && mentionLabels.includes(clean(parsedText.slice(start, start + length)));
    });
    const mentionedSelf = Boolean(identity.isGroup && (nativeSelfMention || [...box.querySelectorAll('[data-mention-self="true"],[data-is-self-mention="true"],[data-e2e="mention"][data-self="true"]')].some(element => !element.closest(quoteSelector))));
    messages.push({ nativeId, direction, sender: direction, text, kind, media, timestamp: ownTimestamp || timestamp, order, domIndex: order, domPosition: messages.length, orderMode: list ? 'relative' : 'absolute',
      ...(nativeServerMessageBound && modelTimestamp ? { nativeServerMessageBound: true, nativeCreatedAt: modelTimestamp } : {}),
      ...(clientId ? { clientId } : {}), ...(direction==='outgoing'&&modelBound?{serverConfirmed:typeof serverId==='string'&&/^[1-9]\d{0,63}$/.test(serverId)}:{}),
      ...(reference ? { reference } : {}), ...(nonReplyableNotice ? { nonReplyableNotice: true } : {}),
      ...(identity.isGroup ? { member, mentionedSelf } : {}),
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
  return { ...identity, messages, loading, latestEndVerified, emptyTodayVerified, historyStartVerified, observedAt: new Date().toISOString(), chronology: list && !newestFirst && !emptyTodayVerified ? 'unknown' : 'oldest-first', chronologySource, sourceDomOrder: newestFirst ? 'newest-first' : list ? 'unknown' : 'oldest-first' };
}

export async function readChatIdentityDom() {
  const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
  const headers = [...document.querySelectorAll('[data-e2e="im-dialog"] [class*="StackLayoutStackChatHeaderuser"],[data-e2e="im-dialog"] [data-e2e="chat-header"],[data-e2e="im-dialog"] [data-e2e="group-chat-header"]')].filter(visible);
  const header = headers.length === 1 ? headers[0] : null;
  const root = header?.closest('[class*="StackLayoutpagespageRoot"],[data-e2e="chat-page"]');
  const resource = value => { try { return new URL(value, location.href).pathname.replace(/~[^/]*/g, '').replace(/\/[0-9]+x[0-9]+\//g, '/'); } catch { return ''; } };
  const groupAvatar = header?.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]');
  const isGroup = header?.getAttribute('data-conversation-type') === 'group' || root?.getAttribute('data-conversation-type') === 'group' || header?.getAttribute('data-is-group') === 'true' || Boolean(groupAvatar) || header?.getAttribute('data-e2e') === 'group-chat-header';
  const groupImages = [...(groupAvatar?.querySelectorAll('img') ?? [])].map(image => resource(image.getAttribute('src'))).filter(Boolean).sort();
  const avatar = isGroup ? groupImages.length ? `group-avatar:${JSON.stringify(groupImages)}` : groupAvatar ? 'group-marker' : resource(header?.querySelector('img')?.getAttribute('src')) : resource(header?.querySelector('img')?.getAttribute('src'));
  const nativeId = header?.getAttribute('data-conversation-id') || root?.getAttribute('data-conversation-id') || header?.getAttribute('data-conversation-short-id') || root?.getAttribute('data-conversation-short-id') || null;
  const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const groupPrototypeIdentity = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { id: null, shortId: null, conflict: false, signature: 'absent' };
    const prototype = Object.getPrototypeOf(value), result = { id: null, shortId: null, conflict: false };
    const shape = descriptor => !descriptor ? ['absent'] : !Object.hasOwn(descriptor, 'value') ? ['accessor'] : ['data', typeof descriptor.value, typeof descriptor.value === 'string' || Number.isSafeInteger(descriptor.value) ? String(descriptor.value) : null];
    const signatures = ['conversationId', 'conversationShortId', 'groupId', 'id', 'shortId', 'conversationType', 'type'].map(key => shape(Object.getOwnPropertyDescriptor(value, key)));
    for (const key of ['id', 'shortId']) {
      const ownDescriptor = Object.getOwnPropertyDescriptor(value, key), descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, key);
      signatures.push(shape(descriptor));
      if (ownDescriptor && !Object.hasOwn(ownDescriptor, 'value')) result.conflict = true;
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !/^\d{1,64}$/.test(descriptor.value)) { result.conflict = true; continue; }
      if (ownDescriptor && (!Object.hasOwn(ownDescriptor, 'value') || ownDescriptor.value !== descriptor.value)) { result.conflict = true; continue; }
      result[key] = descriptor.value;
    }
    result.signature = JSON.stringify([result.id, result.shortId, result.conflict, signatures]);
    return result;
  };
  const digest = async value => globalThis.crypto?.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('') : null;
  const identities = new Map(), types = new Set(), add = (family, value) => {
    if (typeof value !== 'string' && !Number.isSafeInteger(value)) return;
    const id = String(value).trim(); if (!id || id.length > 512) return;
    const values = identities.get(family) ?? new Set(); values.add(id); identities.set(family, values);
  };
  // 只读取当前可见会话头部已核实的固定 props 路径，不执行 getter 或访问消息对象。
  const keys = header ? Object.getOwnPropertyNames(header).filter(key => key.startsWith('__reactProps$')) : [];
  const props = keys.length === 1 ? own(header, keys[0]) : null, children = own(props, 'children');
  const conversation = own(own(Array.isArray(children) ? own(children, '0') : children, 'props'), 'conversation');
  for (const [family, fields] of [['conversation', ['conversationId', 'id']], ['conversation-short', ['conversationShortId', 'shortId']], ['group', ['groupId']], ['user', ['secUid', '_toParticipantSecUserId']], ['user-id', ['userId']]]) for (const field of fields) add(family, own(conversation, field));
  for (const field of ['conversationType', 'type']) { const type = own(conversation, field); if (typeof type === 'string' && ['direct', 'single', 'personal', 'group'].includes(type.toLowerCase())) types.add(type.toLowerCase() === 'group' ? 'group' : 'direct'); }
  let profileUrl = null;
  for (const link of header?.querySelectorAll('a[href]') ?? []) {
    try { const url = new URL(link.getAttribute('href'), location.href); if (url.protocol === 'https:' && url.hostname === 'www.douyin.com' && /^\/user\/[^/?#]+\/?$/.test(url.pathname)) { if (profileUrl && profileUrl !== url.origin + url.pathname) types.add('conflict'); profileUrl = url.origin + url.pathname; } } catch {}
  }
  for (const declared of [header?.getAttribute('data-conversation-type'), root?.getAttribute('data-conversation-type')]) if (declared && ['direct', 'single', 'personal', 'group'].includes(declared)) types.add(declared === 'group' ? 'group' : 'direct');
  if (isGroup) types.add('group');
  else if (profileUrl || identities.has('user') || identities.has('user-id') || header?.getAttribute('data-is-group') === 'false') types.add('direct');
  const displayName = header?.querySelector('[class*="StackLayoutStackChatHeadertitle"],[data-e2e="chat-title"],[data-e2e="group-chat-title"]')?.textContent.replace(/\s+/g, ' ').trim();
  const looksLikeGroup = /[,，、]/.test(displayName || '');
  const conversationType = types.size === 1 ? [...types][0] : (isGroup || looksLikeGroup || !profileUrl) ? 'group' : 'direct';
  const groupPrototype = conversationType === 'group' ? groupPrototypeIdentity(conversation) : null;
  const groupPrototypeOwner = groupPrototype && conversation ? Object.getPrototypeOf(conversation) : null;
  if (groupPrototype) { add('conversation', groupPrototype.id); add('conversation-short', groupPrototype.shortId); }
  const conflictingNativeIds = new Set([header?.getAttribute('data-conversation-id'), root?.getAttribute('data-conversation-id'), header?.getAttribute('data-conversation-short-id'), root?.getAttribute('data-conversation-short-id')].filter(Boolean));
  let identityConflict = Boolean(groupPrototype?.conflict) || keys.length > 1 || types.size > 1 || conflictingNativeIds.size > 1 || [...identities.values()].some(values => values.size !== 1);
  const selected = [...identities].find(([family]) => ['conversation', 'conversation-short', 'group'].includes(family)) ?? [...identities].find(([family]) => family === 'user') ?? [...identities][0];
  const metadataSignature = () => JSON.stringify([['conversationId', 'id', 'conversationShortId', 'shortId', 'groupId', 'secUid', '_toParticipantSecUserId', 'userId', 'conversationType', 'type'].map(key => { const value = own(conversation, key); return typeof value === 'string' || Number.isSafeInteger(value) ? String(value) : null; }), conversationType === 'group' ? groupPrototypeIdentity(conversation).signature : null]);
  const domMetadataSignature = () => JSON.stringify([header, root].map(element => element ? ['data-e2e', 'data-conversation-id', 'data-conversation-short-id', 'data-conversation-type', 'data-is-group'].map(key => element.getAttribute(key)) : null).concat(Boolean(header?.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]'))));
  const initialMetadata = metadataSignature(), initialDomMetadata = domMetadataSignature();
  const fingerprint = selected && !identityConflict ? await digest([...selected[1]][0]) : null;
  const currentProps = keys.length === 1 ? own(header, keys[0]) : null;
  const currentChildren = own(currentProps, 'children'), currentConversation = own(own(Array.isArray(currentChildren) ? own(currentChildren, '0') : currentChildren, 'props'), 'conversation');
  const currentHeaders = [...document.querySelectorAll('[data-e2e="im-dialog"] [class*="StackLayoutStackChatHeaderuser"],[data-e2e="im-dialog"] [data-e2e="chat-header"],[data-e2e="im-dialog"] [data-e2e="group-chat-header"]')].filter(visible);
  if (!header?.isConnected || currentHeaders.length !== 1 || currentHeaders[0] !== header || currentProps !== props || currentConversation !== conversation || groupPrototype && conversation && Object.getPrototypeOf(conversation) !== groupPrototypeOwner || metadataSignature() !== initialMetadata || domMetadataSignature() !== initialDomMetadata) identityConflict = true;
  const identityKey = fingerprint && (conversationType !== 'group' || ['conversation', 'conversation-short', 'group'].includes(selected[0])) ? `${selected[0]}:${fingerprint}` : null;
  const rect = header?.getBoundingClientRect();
  return { displayName, avatar, nativeId, identityKey, profileUrl, identityConflict, ...(groupPrototype?.id || groupPrototype?.shortId ? { groupPrototypeIdentity: true } : {}), isGroup: conversationType === 'group', conversationType,
    identityUnavailable: !header || identityConflict || !(nativeId || identityKey || profileUrl), headerCount: headers.length,
    geometry: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null };
}

export class ChatBrowser {
  constructor({ source = 'api-chat', controller, voiceCaptureDir = resolveRuntimePaths().mediaCaptureDir, fetchImpl = voiceAudioResponse, uploadContractHash = UPLOAD_STAGING_CONTRACT } = {}) {
    if (!['api-chat', 'dsh-chat'].includes(source)) throw new TypeError('私信入口须为 api-chat 或 dsh-chat。');
    if (!path.isAbsolute(voiceCaptureDir)) throw new TypeError('消息音频临时目录须为绝对路径。');
    this.controller = controller ?? new BrowserController({ source });
    this.contacts = new Map();
    this.following = null;
    this.relationshipDiscovery = { status: 'unverified', code: 'FOLLOWING_NOT_CHECKED', reason: '尚未核对本人的关注关系。' };
    this.identities = new MessageIdentityTracker();
    this.mediaResources = new Map();
    this.uploadContractHash = uploadContractHash; this.unsentImageDeliveries = new WeakMap();
    this.chatPageAttemptAt = 0;
    this.voiceCaptureDir = path.resolve(voiceCaptureDir); this.voiceCaptures = new Map(); this.fetchImpl = fetchImpl;
    this.incomingBinding = `__deepseekIncoming_${randomUUID().replaceAll('-', '')}`;
    this.incomingPages = new WeakSet(); this.incomingHandlers = new Map(); this.incomingCleanup = new Set();
  }
  withPage(callback, { signal, launch = false, create = launch, authorizePrepare } = {}) {
    return this.controller.withPage(callback, { signal, launch, create, ...(authorizePrepare ? { authorizePrepare } : {}) });
  }
  async isForeground(page) {
    const focused = await page.evaluate(() => document.visibilityState === 'visible' && document.hasFocus()).catch(() => false);
    if (!focused) return false;
    let session;
    try {
      session = await page.context().newCDPSession(page);
      const { targetInfo } = await session.send('Target.getTargetInfo');
      if (!targetInfo?.targetId) return true;
      const { bounds } = await session.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
      // 最小化后网页可能仍保留焦点；只依据浏览器确认的窗口状态排除前台。
      return bounds?.windowState !== 'minimized';
    } catch { return true; }
    finally { await session?.detach().catch(() => {}); }
  }
  async subscribeIncoming(callback, { recipientIds = [], signal } = {}) {
    if (typeof callback !== 'function' || !Array.isArray(recipientIds) || recipientIds.length < 1 || recipientIds.some(id => typeof id !== 'string' || !/^conv:[a-f0-9]{64}$/.test(id))) throw new TypeError('消息唤醒需要已许可会话列表和回调。');
    stop(signal);
    const token = randomUUID(); let page, active = true;
    const cleanup = async () => {
      if (!active) return; active = false;
      signal?.removeEventListener('abort', aborted);
      this.incomingHandlers.delete(token); this.incomingCleanup.delete(cleanup);
      if (page && !page.isClosed()) await page.evaluate(current => { const entry = window.__deepseekIncomingObservers?.[current]; entry?.observer.disconnect(); clearTimeout(entry?.timer); if (window.__deepseekIncomingObservers) delete window.__deepseekIncomingObservers[current]; }, token).catch(() => {});
    };
    const aborted = () => { void cleanup(); };
    this.incomingCleanup.add(cleanup);
    const recipients = new Set(recipientIds);
    this.incomingHandlers.set(token, recipientId => { if (active && !signal?.aborted && recipients.has(recipientId)) { try { Promise.resolve(callback({ type: 'wake', recipientId })).catch(() => {}); } catch {} } });
    try {
      await this.withPage(async current => {
        page = current;
        const flags = await this.dialog(page, signal);
        if (flags.blocked) throw new Error('消息通知需要本人先完成登录或验证。');
        if (!this.incomingPages.has(page)) {
          await page.exposeBinding(this.incomingBinding, (source, id, recipientId) => { if (source.page === page && typeof id === 'string') this.incomingHandlers.get(id)?.(recipientId); });
          this.incomingPages.add(page);
        }
        await page.evaluate(({ currentToken, binding, allowedIds }) => {
          const entries = window.__deepseekIncomingObservers ??= Object.create(null);
          const entry = { observer: null, timer: null }, allowed = new Set(allowedIds), previous = new Map();
          const unreadCounts = () => {
            const counts = new Map();
            for (const row of document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="conversation-item"][data-deepseek-chat-id]')) {
              const id = row.getAttribute('data-deepseek-chat-id'); if (!allowed.has(id)) continue;
              let count = 0;
              for (const badge of row.querySelectorAll('[class*="unread"],[class*="Unread"],[data-e2e="unread-count"]')) {
                const style = getComputedStyle(badge); if (style.display === 'none' || style.visibility === 'hidden') continue;
                const numericBadge = badge.matches('[data-e2e="unread-count"],[class*="unread-count"],[class*="unreadCount"],[class*="UnreadCount"],[class*="unreadBadge"],[class*="UnreadBadge"]');
                const raw = badge.getAttribute('data-unread-count') || badge.getAttribute('data-count') || badge.getAttribute('aria-label') || (numericBadge ? badge.textContent : '') || '';
                const match = /^\s*(\d+)\+?(?:\s*条未读(?:消息)?)?\s*$/.exec(raw);
                count = Math.max(count, match ? Number(match[1]) : 1);
              }
              if (row.getAttribute('data-unread') === 'true') count = Math.max(count, 1);
              counts.set(id, count);
            }
            return counts;
          };
          const check = notify => {
            for (const [id, count] of unreadCounts()) { if (notify && previous.has(id) && count > previous.get(id) && entries[currentToken]) void window[binding]?.(currentToken, id).catch(() => {}); previous.set(id, count); }
          };
          check(false);
          entry.observer = new MutationObserver(records => {
            const relevant = records.some(record => { const element = record.target instanceof Element ? record.target : record.target?.parentElement; return element?.closest('[data-e2e="im-dialog"]') || record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && (node.matches('[data-e2e="im-dialog"]') || node.querySelector('[data-e2e="im-dialog"]'))); });
            if (!relevant) return;
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => check(true), 200);
          });
          // 只比较许可行的未读标记；选中样式、正文和输入框变化不会触发轮询。
          entry.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'data-unread', 'data-unread-count', 'data-count', 'data-deepseek-chat-id', 'aria-label'] });
          entries[currentToken] = entry;
        }, { currentToken: token, binding: this.incomingBinding, allowedIds: recipientIds });
      }, { signal });
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) await cleanup();
      return cleanup;
    } catch (error) { await cleanup(); throw error; }
  }
  async dialog(page, signal, { open = false } = {}) {
    stop(signal);
    const flags = await page.evaluate(readChatBlockers);
    if (flags.loginRequired || flags.verificationRequired) return { ...flags, blocked: true };
    const dialog = page.locator('[data-e2e="im-dialog"]');
    if (!open && !await dialog.isVisible().catch(() => false)) throw Object.assign(new Error('消息页未打开，未在后台打开消息面板。'), { code: 'CHAT_PAGE_NOT_OPEN' });
    await page.evaluate(() => {
      // 本次只暂停背景作品，不留下阻止后续播放的文档监听。
      for (const video of document.querySelectorAll('video')) if (!video.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]')) video.pause();
    });
    if (!await dialog.isVisible().catch(() => false)) {
      if (!open) throw Object.assign(new Error('消息页未打开，未在后台打开消息面板。'), { code: 'CHAT_PAGE_NOT_OPEN' });
      const entry = page.locator('[data-e2e="im-entry"]');
      try { await entry.waitFor({ state: 'visible', timeout: 20_000 }); }
      catch { throw new Error('没有找到抖音消息入口。'); }
      await entry.click();
      await page.locator('[data-e2e="im-dialog"]').waitFor({ state: 'visible' });
    }
    stop(signal);
    return { ...flags, blocked: false };
  }
  async gotoWithRetry(page, url, signal, attempts = 2) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      stop(signal);
      if (page.isClosed()) return false;
      try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }); return true; }
      catch { if (attempt + 1 < attempts) await page.waitForTimeout(500); }
    }
    return false;
  }
  async verifyFollowing(page, signal) {
    // 本人的关注名单仅在首次发现联系人时核对；核对失败不阻断当前会话列表读取。
    this.following = [];
    const onHome = () => { try { const url = new URL(page.url()); return url.hostname === 'www.douyin.com' && url.pathname === '/'; } catch { return false; } };
    this.relationshipDiscovery = { status: 'unavailable', code: 'FOLLOWING_LIST_UNAVAILABLE', reason: '当前抖音网页版未提供可读取的关注列表。关注关系未确认；已有个人会话需由本人核对并单独授权。' };
    try {
      if (!onHome() && !await this.gotoWithRetry(page, HOME, signal)) { this.relationshipDiscovery = { status: 'unavailable', code: 'FOLLOWING_LIST_UNAVAILABLE', reason: '读取关注关系时页面连接中断。未确认关注关系；现有会话需由本人核对并单独授权。' }; return; }
      const my = page.locator('a').filter({ has: page.locator('span').filter({ hasText: /^我的$/ }) });
      if (await my.count() !== 1) return;
      const target = new URL(await my.getAttribute('href'), HOME);
      if (target.protocol !== 'https:' || target.hostname !== 'www.douyin.com' || !/^\/user\/[^/?#]+\/?$/.test(target.pathname)) return;
      if (!await this.gotoWithRetry(page, target.href, signal)) { this.relationshipDiscovery = { status: 'unavailable', code: 'FOLLOWING_LIST_UNAVAILABLE', reason: '读取关注关系时页面连接中断。未确认关注关系；现有会话需由本人核对并单独授权。' }; return; }
      const flags = await page.evaluate(readChatBlockers);
      if (flags.loginRequired || flags.verificationRequired) { this.relationshipDiscovery = { status: 'blocked', code: 'FOLLOWING_REQUIRES_USER', reason: '关注关系核对需要本人完成登录或验证。' }; return; }
      const follow = page.locator('[data-e2e="user-info-follow"]').filter({ visible: true });
      if (await follow.count() !== 1) return;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        stop(signal);
        await follow.click({ timeout: 1800 });
        await page.waitForFunction(() => [...document.querySelectorAll('[data-e2e="user-fans-container"],[data-e2e="following-list"],[data-e2e="follow-list"]')].some(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }), undefined, { timeout: 1800 }).catch(() => {});
        const rows = await page.evaluate(readFollowingDom);
        if (rows.length) { this.following = rows; this.relationshipDiscovery = { status: 'verified', code: 'FOLLOWING_LIST_READ', reason: '已读取当前页面提供的关注列表，逐联系人核对关系。' }; break; }
      }
    } catch (error) {
      stop(signal);
      if (page.isClosed()) return;
      try {
        const flags = await page.evaluate(readChatBlockers);
        if (flags.loginRequired || flags.verificationRequired) this.relationshipDiscovery = { status: 'blocked', code: 'FOLLOWING_REQUIRES_USER', reason: '关注关系核对需要本人完成登录或验证。' };
        else this.relationshipDiscovery = { status: 'unavailable', code: 'FOLLOWING_LIST_UNAVAILABLE', reason: '关注入口被遮挡或当前页面未提供可读取的列表。未确认关注关系；现有会话需由本人核对后单独授权。' };
      } catch { this.relationshipDiscovery = { status: 'unavailable', code: 'FOLLOWING_LIST_UNAVAILABLE', reason: '读取关注关系时页面连接中断。未确认关注关系；现有会话需由本人核对后单独授权。' }; }
    } finally {
      stop(signal);
      if (!page.isClosed() && this.relationshipDiscovery.status !== 'blocked') {
        if (!onHome()) {
          const back = await this.gotoWithRetry(page, HOME, signal);
          if (!back) await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        }
        await this.dialog(page, signal, { open: true }).catch(() => {});
      }
    }
  }
  async ensureChatPage(page, signal) {
    const dialog = page.locator('[data-e2e="im-dialog"]').first();
    if (await dialog.isVisible().catch(() => false)) return;
    const now = Date.now();
    if (this.chatPageAttemptAt && now - this.chatPageAttemptAt < 10000) return;
    this.chatPageAttemptAt = now;
    if (!/^https:\/\/(?:www\.)?douyin\.com(?:[/:]|$)/.test(page.url())) return;
    if (await this.gotoWithRetry(page, HOME, signal)) {
      await page.waitForTimeout(400);
      const entry = page.locator('[data-e2e="im-entry"]').first();
      if (await entry.count() === 1) await entry.click({ timeout: 3000 }).catch(() => {});
      await dialog.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    }
    await this.dialog(page, signal);
  }
  async contactList(page, signal, { enumerate = false, locateId, ensurePage = false } = {}) {
    if (ensurePage) await this.ensureChatPage(page, signal);
    const flags = await this.dialog(page, signal, { open: ensurePage });
    if (!await page.locator('[data-e2e="im-dialog"]').first().isVisible().catch(() => false)) {
      if (!ensurePage) throw Object.assign(new Error('消息页未打开，未读取私信。'), { code: 'CHAT_PAGE_NOT_OPEN' });
      throw new Error('专用浏览器消息页未打开，请点“打开抖音”进入消息页后重试。');
    }
    if (flags.blocked) return { ...flags, contacts: [] };
    await page.locator('[data-e2e="im-dialog"] [data-e2e="conversation-item"]').first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    const collected = new Map(), started = Date.now(); let visibleRows = [], scannedToEnd = false, reason = '', found = false;
    const capture = async () => {
      stop(signal); const rows = await page.evaluate(readContactDom), ids = rows.map(contactOpaqueId);
      if (new Set(ids).size !== ids.length || rows.some(row => !row.displayName || (!row.nativeId && !row.avatar))) throw new Error('联系人身份不完整或存在歧义，已停止读取会话。');
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index], id = ids[index], previous = collected.get(id);
        if (previous && JSON.stringify([previous.nativeId, previous.identityKey, previous.isGroup, previous.conversationType, previous.identityConflict]) !== JSON.stringify([row.nativeId, row.identityKey, row.isGroup, row.conversationType, row.identityConflict])) throw new Error('读取列表期间会话身份发生变化，未合并不一致的名单。');
        collected.set(id, row);
      }
      visibleRows = rows; found = Boolean(locateId && ids.includes(locateId)); return rows;
    };
    await capture();
    const origin = await page.evaluate(readConversationListDom);
    const scroll = async top => {
      stop(signal); const metrics = await page.evaluate(readConversationListDom);
      if (!metrics || origin && (metrics.selector !== origin.selector || metrics.index !== origin.index)) throw new Error('当前会话列表容器发生变化，已停止滚动读取。');
      await page.locator(metrics.selector).nth(metrics.index).evaluate((element, value) => { element.scrollTop = value; }, top);
      await page.waitForTimeout(150); stop(signal);
    };
    try {
      if (origin && (enumerate || locateId && !found)) {
        if (origin.scrollTop > 0) await scroll(0);
        let stableEnd = 0, previousEnd = '';
        while (Date.now() - started < 12_000) {
          await capture(); if (locateId && found) break;
          const metrics = await page.evaluate(readConversationListDom);
          if (!metrics) throw new Error('读取期间会话列表容器已消失。');
          const maximum = Math.max(0, metrics.scrollHeight - metrics.clientHeight), atEnd = metrics.scrollTop >= maximum - 1;
          if (atEnd && !metrics.loading) {
            const signature = JSON.stringify([metrics.scrollHeight, ...visibleRows.map(contactOpaqueId)]);
            stableEnd = previousEnd === signature ? stableEnd + 1 : 0; previousEnd = signature;
            if (stableEnd >= 2) { scannedToEnd = true; break; }
            await page.waitForTimeout(150); continue;
          }
          stableEnd = 0; previousEnd = '';
          if (metrics.loading && atEnd) { await page.waitForTimeout(150); continue; }
          const next = Math.min(maximum, metrics.scrollTop + Math.max(1, Math.floor(metrics.clientHeight * 0.8)));
          if (next <= metrics.scrollTop && !atEnd) { reason = '列表无法继续滚动，只返回已核对的当前会话。'; break; }
          await scroll(next);
        }
        if (!scannedToEnd && !(locateId && found) && !reason) reason = '本次读取已到时间预算，只返回已核对的当前会话；可以稍后重新读取。';
      } else if (!origin) reason = '当前页面没有唯一可遍历的会话列表容器，只读取已挂载会话。';
    } finally {
      if (origin && (enumerate || locateId && !found)) {
        const current = await page.evaluate(readConversationListDom).catch(() => null);
        if (current && Math.abs(current.scrollTop - origin.scrollTop) > 1) await scroll(origin.scrollTop);
        await capture();
      }
    }
    const rows = [...collected.values()];
    const identities = rows.map(contactOpaqueId);
    if (new Set(identities).size !== identities.length || rows.some(row => !row.displayName || (!contactIdentityKey(row) && !row.avatar))) throw new Error('联系人身份不完整或存在歧义，已停止读取会话。');
    const contacts = [];
    this.contacts.clear();
    for (const [index, row] of rows.entries()) {
      const id = identities[index];
      const matching = this.following?.filter(item => item.displayName === row.displayName && item.mutual) ?? [];
      const uniqueName = rows.filter(item => item.displayName === row.displayName).length === 1;
      const directRelationship = Boolean(row.conversationType !== 'group' && row.profileUrl && row.relationshipLabel && uniqueName);
      const followed = row.conversationType === 'direct' && uniqueName && (matching.length === 1 || directRelationship) ? true : null;
      const conversationType = row.conversationType;
      const identityBinding = contactIdentityBinding(row, rows), identityVerified = Boolean(identityBinding);
      const relationshipStatus = conversationType === 'group' ? 'unavailable' : followed ? 'verified' : this.relationshipDiscovery.status === 'unavailable' ? 'unavailable' : 'unverified';
      const contact = { id, displayName: row.displayName, name: row.displayName, unread: row.unread, followed, identityVerified, identityBinding, ...stableIdentityFields(row), identitySource: row.identitySource || (row.nativeId ? 'dom-conversation-id' : row.profileUrl ? 'public-profile-link' : null), relationshipStatus, isGroup: conversationType === 'group' ? true : conversationType === 'direct' ? false : null, conversationType,
        relationshipEvidence: followed ? { source: directRelationship ? 'conversation-profile-label' : 'self-follow-list', label: directRelationship ? row.relationshipLabel : '相互关注', matchedBy: directRelationship ? 'conversation-id-and-profile' : 'unique-display-name', accountIdCrossChecked: directRelationship } : null };
      this.contacts.set(id, { ...contact, avatar: row.avatar, nativeId: row.nativeId, identityKey: row.identityKey, profileUrl: row.profileUrl, identityConflict: row.identityConflict });
      contacts.push(contact);
    }
    await page.evaluate(mapping => {
      const nodes = [...document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="conversation-item"]')];
      if (nodes.length !== mapping.length) throw new Error('标记会话前虚拟列表窗口已经改变。');
      for (const [index, expected] of mapping.entries()) {
        const element = nodes[index], name = element.querySelector('.conversationConversationItemtitle,[data-e2e="conversation-name"]')?.textContent.replace(/\s+/g, ' ').trim();
        const native = element.getAttribute('data-conversation-id') || element.getAttribute('data-conversation-short-id') || null;
        if (name !== expected.displayName || native !== expected.nativeId) throw new Error('标记会话前列表身份已经改变。');
      }
      for (const [index, expected] of mapping.entries()) nodes[index].setAttribute('data-deepseek-chat-id', expected.id);
    }, visibleRows.map(row => ({ id: contactOpaqueId(row), displayName: row.displayName, nativeId: row.nativeId })));
    return { ...flags, contacts, relationshipDiscovery: this.relationshipDiscovery, listDiscovery: { source: 'current-conversation-list', scannedToEnd, count: contacts.length, note: `已读取当前消息列表的 ${contacts.length} 个会话；不代表全部关注好友或所有群聊。`, ...(reason ? { reason } : {}) } };
  }
  async assertAutomaticPrepareSafe(signal, authorizePrepare) {
    stop(signal);
    if (typeof authorizePrepare !== 'function') throw Object.assign(new Error('自动准备缺少可信授权检查，未创建页面。'), { code: 'CHAT_PREPARE_UNSUPPORTED' });
    await authorizePrepare(); stop(signal);
    const browser = await this.controller.connectExistingBrowser?.({ signal });
    if (!browser?.isConnected?.()) throw Object.assign(new Error('专用浏览器未运行，未自动打开回复页。'), { code: 'BROWSER_NOT_RUNNING' });
    const context = browser.contexts()[0];
    if (!context) throw new Error('没有读到专用浏览器上下文，未自动准备。');
    for (const page of context.pages()) {
      stop(signal); if (page.isClosed()) continue;
      const address = page.url();
      let origin; try { origin = new URL(address).origin; } catch { origin = null; }
      if (address !== 'about:blank' && origin !== 'https://www.douyin.com') throw Object.assign(new Error('专用浏览器有页面已离开抖音，未自动读取内容或创建回复页。'), { code: 'CHAT_PAGE_LEFT_DOUYIN' });
      if (await this.isForeground(page)) throw Object.assign(new Error('专用浏览器在前台，稍后自动准备回复通道。'), { code: 'CHAT_FOREGROUND' });
      stop(signal);
      const name = await page.evaluate(() => window.name);
      if (address === 'about:blank') {
        if (name) throw Object.assign(new Error('具名受管页面停留在空白页，未自动导航或创建回复页。'), { code: 'CHAT_PAGE_LEFT_DOUYIN' });
        continue;
      }
      if (!/^deepseek-douyin-(?:launcher|api|dsh|api-chat|dsh-chat)$/.test(name)) continue;
      const flags = await page.evaluate(readChatBlockers);
      if (flags.blocked || flags.loginRequired || flags.verificationRequired) throw Object.assign(new Error('专用浏览器需要登录或验证，未自动准备回复通道。'), { code: 'CHAT_LOGIN_REQUIRED', needsUserAction: true });
      if (name.endsWith('-chat') && await page.evaluate(() => [...document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"],[data-e2e="im-dialog"] [data-e2e="msg-input"] textarea,[data-e2e="im-dialog"] [data-e2e="msg-input"] input')].some(element => String(element.value ?? element.innerText ?? element.textContent ?? '').trim()))) throw Object.assign(new Error('专用聊天页保留了草稿，未自动导航或切换。'), { code: 'CHAT_DRAFT_PRESENT' });
    }
    await authorizePrepare(); stop(signal);
  }

  async prepareChat({ signal, automatic = false, authorizePrepare } = {}) {
    if (automatic) await this.assertAutomaticPrepareSafe(signal, authorizePrepare);
    let page;
    try { page = await this.withPage(async current => current, { signal, launch: !automatic, create: false, ...(automatic ? { authorizePrepare } : {}) }); }
    catch (error) { if (!['CHAT_PAGE_NOT_OPEN', 'CHAT_PAGE_LEFT_DOUYIN'].includes(error.code)) throw error; }
    if (page && await this.isForeground(page)) throw Object.assign(new Error('专用浏览器在前台，未准备回复通道。'), { code: 'CHAT_FOREGROUND' });
    return this.withPage(async current => {
      if (automatic) await this.assertAutomaticPrepareSafe(signal, authorizePrepare);
      if (await this.isForeground(current)) throw Object.assign(new Error('专用浏览器在前台，未准备回复通道。'), { code: 'CHAT_FOREGROUND' });
      const flags = await this.dialog(current, signal, { open: true });
      if (flags.blocked || flags.loginRequired || flags.verificationRequired) return { prepared: false, blocked: flags.blocked === true, loginRequired: flags.loginRequired === true, verificationRequired: flags.verificationRequired === true };
      const list = await this.contactList(current, signal, { enumerate: false, ensurePage: true });
      return { prepared: true, count: Array.isArray(list.contacts) ? list.contacts.length : 0 };
    }, { signal, launch: !automatic, create: true, ...(automatic ? { authorizePrepare } : {}) });
  }
  listContacts({ signal, verifyFollowing = this.following === null, backgroundOnly = false } = {}) {
    return this.withPage(async page => {
      if (backgroundOnly && await this.isForeground(page)) throw Object.assign(new Error('专用浏览器在前台，暂不切换私信页。'), { code: 'CHAT_FOREGROUND' });
      const initial = await this.dialog(page, signal, { open: !backgroundOnly });
      if (initial.blocked) return { ...initial, contacts: [] };
      if (verifyFollowing && !backgroundOnly) {
        try { await this.verifyFollowing(page, signal); }
        catch (error) {
          if (page.isClosed()) throw new Error('专用浏览器页面已关闭，请点击“重新连接专用浏览器”后重试。');
          this.relationshipDiscovery = { status: 'unavailable', code: 'FOLLOWING_LIST_UNAVAILABLE', reason: '读取关注关系失败；未确认关注关系，现有会话需本人核对授权。' };
        }
      }
      if (!backgroundOnly && verifyFollowing && this.relationshipDiscovery.status === 'blocked') return { blocked: true, contacts: [], relationshipDiscovery: this.relationshipDiscovery };
      try { return await this.contactList(page, signal, { enumerate: true, ensurePage: !backgroundOnly }); }
      catch (error) {
        if (page.isClosed() || /ERR_CONNECTION_CLOSED|Target page|browser has been closed/i.test(String(error?.message || ''))) throw new Error('专用浏览器页面连接已断开，请点击“重新连接专用浏览器”后重试。');
        throw error;
      }
    }, { signal, launch: !backgroundOnly, create: !backgroundOnly });
  }
  unreadCounts(recipientIds, { signal } = {}) {
    if (!Array.isArray(recipientIds) || recipientIds.some(id => typeof id !== 'string')) return Promise.reject(new TypeError('需要许可会话列表。'));
    return this.withPage(async page => {
      return page.evaluate(ids => {
        const dialog = document.querySelector('[data-e2e="im-dialog"]');
        const counts = {};
        if (!dialog) return { available: false, rows: 0, counts };
        const rows = [...dialog.querySelectorAll('[data-e2e="conversation-item"][data-deepseek-chat-id]')];
        if (!rows.length) return { available: false, rows: 0, counts };
        const allowed = new Set(ids);
        for (const row of rows) {
          const id = row.getAttribute('data-deepseek-chat-id');
          if (!allowed.has(id)) continue;
          let count = 0;
          for (const badge of row.querySelectorAll('[class*="unread"],[class*="Unread"],[data-e2e="unread-count"]')) {
            const style = getComputedStyle(badge);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const numericBadge = badge.matches('[data-e2e="unread-count"],[class*="unread-count"],[class*="unreadCount"],[class*="UnreadCount"],[class*="unreadBadge"],[class*="UnreadBadge"]');
            const raw = badge.getAttribute('data-unread-count') || badge.getAttribute('data-count') || badge.getAttribute('aria-label') || (numericBadge ? badge.textContent : '') || '';
            const match = /^\s*(\d+)\+?(?:\s*条未读(?:消息)?)?\s*$/.exec(raw);
            count = Math.max(count, match ? Number(match[1]) : 1);
          }
          if (row.getAttribute('data-unread') === 'true') count = Math.max(count, 1);
          counts[id] = count;
        }
        return { available: true, rows: rows.length, counts };
      }, recipientIds);
    }, { signal });
  }
  async returnToConversationList(page) {
    const back = page.locator('[data-stack-layer="chat"] .StackLayoutStackTitleBarbackBtn');
    if (await back.count() === 1 && await back.isVisible().catch(() => false)) {
      await back.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(100);
    }
  }
  async select(page, recipientId, signal, { refresh = false, weak = false } = {}) {
    if (typeof recipientId !== 'string' || !/^conv:[a-f0-9]{64}$/.test(recipientId)) throw new TypeError('需要已发现的精确联系人 ID。');
    const flags = await this.contactList(page, signal, { locateId: recipientId });
    if (flags.blocked) return { flags };
    const contact = this.contacts.get(recipientId);
    if (!contact || contact.conversationType === 'unknown') throw new Error('指定会话已变化或类型尚未核实；请确认专用浏览器已打开消息页后重试。');
    const matches = value => weak ? sameWeakConversation(value, contact) : sameConversationIdentity(value, contact);
    let row = page.locator(`[data-e2e="conversation-item"][data-deepseek-chat-id="${recipientId}"]`);
    if (await row.count() !== 1) throw new Error('指定会话不是唯一匹配，已停止操作。');
    const current = await page.evaluate(readChatIdentityDom);
    if (refresh || !matches(current)) {
      try { await row.click({ timeout: 5000 }); }
      catch {
        await this.returnToConversationList(page);
        await this.contactList(page, signal, { locateId: recipientId });
        row = page.locator(`[data-e2e="conversation-item"][data-deepseek-chat-id="${recipientId}"]`);
        if (await row.count() !== 1) throw new Error('指定会话不是唯一匹配，已停止操作。');
        try { await row.click({ timeout: 5000 }); }
        catch { throw new Error('指定会话未成功打开，未读取正文或点击发送。'); }
      }
    }
    let identity, previous, stableSamples = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      stop(signal);
      const blockers = await page.evaluate(readChatBlockers);
      if (blockers.loginRequired || blockers.verificationRequired) return { flags: { ...flags, ...blockers, blocked: true } };
      identity = await page.evaluate(readChatIdentityDom);
      const geometryStable = previous && identity.geometry && ['x', 'y', 'width', 'height'].every(key => Math.abs(identity.geometry[key] - previous.geometry[key]) <= 0.5);
      stableSamples = matches(identity) ? geometryStable ? stableSamples + 1 : 1 : 0;
      if (stableSamples >= 3) break;
      previous = matches(identity) && identity.geometry ? identity : null;
      await page.waitForTimeout(150);
    }
    if (stableSamples < 3) throw Object.assign(new Error(identity?.identityUnavailable && !weak ? '当前会话缺少可核对的稳定身份信息，或切换动画尚未结束；未读取正文或发送。' : '当前会话的显示名、类型或稳定身份与许可联系人不一致，未读取正文或发送。'), { code: 'CHAT_CONVERSATION_IDENTITY_MISMATCH' });
    stop(signal);
    return { contact, flags };
  }
  async stableConversation(page, contact, signal, { weak = false } = {}) {
    let previous;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      stop(signal);
      const current = await page.evaluate(readConversationDom, { ...expectedDomIdentity(contact), allowWeak: weak });
      if (!(weak ? sameWeakConversation(current, contact) : sameConversationIdentity(current, contact))) throw new Error('读取前会话身份发生变化。');
      const signature = JSON.stringify(current.messages);
      if (!current.loading && previous === signature) return current;
      previous = current.loading ? undefined : signature;
      await page.waitForTimeout(150);
    }
    throw new Error('指定会话的消息列表仍在加载或变化，未确认正文快照。');
  }
  async verifyContactBinding(page, contact, expectedContact, weak = false) {
    const rows = await page.evaluate(readContactDom), matching = rows.filter(row => contactOpaqueId(row) === contact.id);
    if (matching.length !== 1) throw new Error('许可会话的稳定身份已变化，未继续发送。');
    const row = matching[0], binding = contactIdentityBinding(row, rows);
    const current = { ...contact, name: row.displayName, displayName: row.displayName, nativeId: row.nativeId, identityKey: row.identityKey, profileUrl: row.profileUrl, isGroup: row.isGroup, conversationType: row.conversationType, identityVerified: Boolean(binding), identityBinding: binding, ...stableIdentityFields(row) };
    if (!(weak ? sameWeakConversation(row, contact) : sameConversationIdentity(row, contact)) || !weak && contact.identityVerified && binding !== contact.identityBinding || expectedContact && !matchesAuthorizedContact(expectedContact, current)) throw new Error('许可会话的稳定身份、类型或身份绑定已变化，未继续发送。');
    return current;
  }
  publicMessages(recipientId, rawRows) {
    const currentVoiceRefs = new Set();
    const rows = rawRows.map(row => {
      const { member, clientId, ...rest } = row;
      const identified = clientId ? { ...rest, clientMessageKey: hash(`${recipientId}\0${clientId}`) } : rest;
      const base = member ? { ...identified, memberId: member.nativeId ? `member:${hash(`${recipientId}\0${member.nativeId}`)}` : null, memberName: member.name || null, mentionedSelf: row.mentionedSelf === true } : identified;
      if (!row.media) return base;
      const { images = [], audioSources = [], ...media } = row.media;
      const resources = [...images, ...audioSources].filter(image => image.src).map(image => {
        const ref = `media:${hash(image.src.startsWith('data:') ? image.src : (() => { try { return new URL(image.src).pathname; } catch { return image.src; } })())}`;
        if(media.type==='voice'){currentVoiceRefs.add(ref);this.mediaResources.delete(ref);this.mediaResources.set(ref, { src: image.src, label: image.label ?? null, recipientId, type: media.type });}
        return { resourceRef: ref, label: image.label ?? null };
      });
      return { ...base, media: { ...media, ...(media.type === 'voice' ? { sourceCount: resources.length } : { imageCount: resources.length }), resources } };
    });
    for(const [ref,resource] of this.mediaResources)if(resource.recipientId===recipientId&&!currentVoiceRefs.has(ref))this.mediaResources.delete(ref);
    while(this.mediaResources.size>128)this.mediaResources.delete(this.mediaResources.keys().next().value);
    const identified = this.identities.identify(recipientId, rows);
    return identified.map(row => row.media?.type === 'shared-work' ? { ...row, media: { ...row.media,
      safeOpenSelector: `[data-deepseek-message-id="${row.id}"] .MessageItemShareAwemecontainer` } } : row);
  }
  async markMessages(page, messages) {
    const marked = await page.evaluate(mapping => {
      const visible = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
      const header = [...document.querySelectorAll('[data-e2e="im-dialog"] [class*="StackLayoutStackChatHeaderuser"],[data-e2e="im-dialog"] [data-e2e="chat-header"],[data-e2e="im-dialog"] [data-e2e="group-chat-header"]')].filter(visible);
      const root = header.length === 1 ? header[0].closest('[class*="StackLayoutpagespageRoot"],[data-e2e="chat-page"]') : null;
      const selector = '[data-e2e="msg-item-content"],[data-e2e="message-content"],[data-testid="message-content"]';
      const nodes = [...(root?.querySelectorAll(selector) ?? [])].filter(node => !node.parentElement?.closest(selector));
      if (nodes.length !== mapping.length || new Set(mapping.map(item => item.domPosition)).size !== nodes.length) return false;
      if (mapping.some(item => !Number.isSafeInteger(item.domPosition) || item.domPosition < 0 || item.domPosition >= nodes.length)) return false;
      for (const item of mapping) {
        nodes[item.domPosition].setAttribute('data-deepseek-message-id', item.id);
      }
      return true;
    }, messages.map((message, index) => ({ id: message.id, domPosition: message.domPosition ?? index })));
    if (!marked) throw Object.assign(new Error('消息列表正在更新，未使用过期快照。'), { code: 'CHAT_SNAPSHOT_CHANGED' });
  }
  readConversation(recipientId, { allowed = false, signal, refresh = false, weak = false, backgroundOnly = false } = {}) {
    if (allowed !== true) return Promise.reject(new Error('读取正文需要这个指定联系人的明确授权。'));
    return this.withPage(async page => {
      if (backgroundOnly && await this.isForeground(page)) throw Object.assign(new Error('专用浏览器在前台，暂不切换私信页。'), { code: 'CHAT_FOREGROUND' });
      const { contact, flags } = await this.select(page, recipientId, signal, { refresh, weak });
      if (flags.blocked) return { ...flags, conversation: null, contact: null, messages: [] };
      let raw, messages;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        stop(signal);
        raw = await this.stableConversation(page, contact, signal, { weak });
        if (!(weak ? sameWeakConversation(raw, contact) : sameConversationIdentity(raw, contact))) throw new Error('读取前会话身份发生变化。');
        messages = this.publicMessages(recipientId, raw.messages);
        try { await this.markMessages(page, messages); break; }
        catch (error) { if (error.code !== 'CHAT_SNAPSHOT_CHANGED' || attempt === 1) throw error; }
      }
      const { avatar, nativeId: _nativeId, identityKey: _identityKey, profileUrl: _profileUrl, identityConflict: _identityConflict, ...publicContact } = contact;
      return { ...flags, conversation: { id: contact.id, displayName: contact.displayName, isGroup: contact.isGroup, conversationType: contact.conversationType }, contact: publicContact,
        messages, dayEvidence: { observedAt: raw.observedAt, latestEndVerified: raw.latestEndVerified, chronology: raw.chronology, historyStartVerified: raw.historyStartVerified, emptyTodayVerified: raw.emptyTodayVerified } };
    }, { signal, launch: !backgroundOnly, create: !backgroundOnly });
  }
  captureMessage(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('查看画面需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, frames: [], imageStatus: '登录或验证画面未采集。' };
      const raw = await this.stableConversation(page, contact, signal);
      const messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId);
      if (!message?.media || message.unsupported || !['emoji', 'image', 'shared-work'].includes(message.media.type)) throw new Error('该消息没有已识别的图片、表情或分享作品画面。');
      if (message.media.type === 'image' && message.media.imageReady !== true) throw new Error('这条图片仍在加载或未提供实际图像，未把占位符当作图片。');
      await this.markMessages(page, messages);
      const visualSelector = message.media.inline ? '[class*="MessageItemTextcontainer"],[data-e2e="message-text"]' : '.MessageItemEmojiemojiBox,.MessageItemShareAwemecontainer,[class*="MessageItemImagecontainer"],[class*="MessageItemImageimageBox"],[class*="MessageItemImageImageBox"],[data-e2e="message-image"],[data-e2e="message-emoji"],[data-e2e="message-sticker"],[class*="MessageItemSticker"],[data-e2e="shared-video-card"]';
      const quoteSelector = '[data-e2e="message-quote"],[data-e2e="message-reply-preview"],[class*="MessageItemReply"],[class*="MessageItemQuote"],[class*="QuoteMessage"]';
      const frame = page.locator(`[data-e2e="im-dialog"] [data-deepseek-message-id="${messageId}"]`).locator(`:is(${visualSelector}):not(:is(${quoteSelector}) *)`);
      if (await frame.count() !== 1) throw new Error('没有唯一的指定消息画面。');
      const current = await page.evaluate(readChatIdentityDom);
      const protectedScreen = await page.evaluate(readChatBlockers);
      if (protectedScreen.loginRequired || protectedScreen.verificationRequired) return { ...protectedScreen, frames: [], imageStatus: '登录或验证画面未采集。' };
      if (!sameConversationIdentity(current, contact)) throw new Error('截取画面前会话身份发生变化。');
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
      const frames = [{ mimeType: 'image/jpeg', data: data.toString('base64') }];
      if (message.media.animatedHint === true) {
        await new Promise(resolve => setTimeout(resolve, 300)); stop(signal);
        const protection = await page.evaluate(readChatBlockers), identity = await page.evaluate(readChatIdentityDom);
        if (protection.loginRequired || protection.verificationRequired || !sameConversationIdentity(identity, contact)) throw new Error('动图采样期间会话或验证状态改变，画面已丢弃。');
        const middle = this.publicMessages(recipientId, (await this.stableConversation(page, contact, signal)).messages).find(item => item.id === messageId);
        const bounds = await frame.boundingBox();
        if (!middle || messageFingerprint(middle) !== messageFingerprint(message) || !bounds || ['x','y','width','height'].some(key => Math.abs(bounds[key] - rectangle[key]) > 1) || !await frame.evaluate(element => { const r = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(Math.max(1, Math.min(innerWidth - 1, r.x + r.width / 2)), Math.max(1, Math.min(innerHeight - 1, r.y + r.height / 2)))); })) throw new Error('动图采样期间指定消息变化或被遮挡，画面已丢弃。');
        const next = await page.screenshot({ type:'jpeg',quality:70,clip,timeout:5000 });
        frames.push({ mimeType: 'image/jpeg', data: next.toString('base64') });
      }
      const afterRectangle=await frame.boundingBox();
      if(!afterRectangle||['x','y','width','height'].some(key=>Math.abs(afterRectangle[key]-rectangle[key])>1)) throw new Error('截图期间指定消息位置改变，画面已丢弃。');
      const afterIdentity=await page.evaluate(readChatIdentityDom);
      const afterProtection=await page.evaluate(readChatBlockers);
      if(afterProtection.loginRequired||afterProtection.verificationRequired) return {...afterProtection,frames:[],imageStatus:'截图期间出现登录或验证，本次画面已丢弃。'};
      if(!sameConversationIdentity(afterIdentity,contact)) throw new Error('截图期间会话身份发生变化，画面已丢弃。');
      const afterRaw=await this.stableConversation(page,contact,signal);
      const afterMessages=this.publicMessages(recipientId,afterRaw.messages);
      const afterMessage=afterMessages.find(item=>item.id===messageId);
      if(!afterMessage || messageFingerprint(afterMessage)!==messageFingerprint(message)) throw new Error('截图期间指定消息发生变化，画面已丢弃。');
      return { ...flags, conversation: { id: recipientId, displayName: contact.displayName }, messageId,
        media: message.media, understandingScope: frames.length > 1 ? 'single-message-animation-sampling' : message.media.understandingScope,
        frames, ...(frames.length > 1 ? { note: '同一消息按先后顺序采集的两帧，至少间隔300毫秒；可能遗漏快速动作，没有音频，不代表完整动图。' } : {}), imageStatus: '已采集指定消息的实际画面，尚需支持图像的模型读取。' };
    }, { signal });
  }
  captureVoiceMessage(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('读取语音需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) throw new Error('登录或验证尚未完成，未读取语音。');
      await this.verifyContactBinding(page, contact);
      const raw = await this.stableConversation(page, contact, signal), messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId), seconds = message?.media?.durationSeconds;
      if (message?.media?.type !== 'voice' || message.unsupported || !Number.isFinite(seconds) || seconds <= 0 || seconds > 120 || message.media.resources.length !== 1) throw new Error('该语音缺少唯一资源或可靠时长，或超过 120 秒，未采集。');
      const source = this.mediaResources.get(message.media.resources[0].resourceRef);
      if (!source || source.recipientId !== recipientId || source.type !== 'voice' || !allowedAudioUrl(source.src)) throw new Error('指定语音没有可核对的平台 HTTPS 资源，未采集。');
      stop(signal);
      const timeout = AbortSignal.timeout(20_000), bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let bytes;
      try {
        const response = await this.fetchImpl(source.src, { redirect: 'error', credentials: 'omit', signal: bounded });
        if (!response?.ok || response.redirected || !response.body || response.url && response.url !== source.src) throw new Error();
        const advertised = response.headers.get('content-length');
        if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > AUDIO_LIMIT)) { await response.body.cancel(); throw new Error(); }
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
          for (;;) {
            bounded.throwIfAborted(); const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength; if (size > AUDIO_LIMIT) { await reader.cancel(); throw new Error(); } chunks.push(Buffer.from(value));
          }
        } finally { reader.releaseLock(); }
        bytes = Buffer.concat(chunks, size);
      } catch { stop(signal); throw new Error('指定语音下载失败、超时或超过 25 MiB，未采集其他资源。'); }
      stop(signal);
      const format = chatAudioFormat(bytes);
      if (!format) throw new Error('指定资源没有可识别的音频文件头，未交给转写。');
      await this.verifyContactBinding(page, contact);
      const protectedScreen = await page.evaluate(readChatBlockers);
      if (protectedScreen.loginRequired || protectedScreen.verificationRequired) throw new Error('读取语音期间出现登录或验证，数据已丢弃。');
      const after = this.publicMessages(recipientId, (await this.stableConversation(page, contact, signal)).messages).find(item => item.id === messageId);
      if (!after || messageFingerprint(after) !== messageFingerprint(message)) throw new Error('读取语音期间指定消息发生变化，数据已丢弃。');
      fs.mkdirSync(this.voiceCaptureDir, { recursive: true });
      const directory = fs.mkdtempSync(path.join(this.voiceCaptureDir, 'chat-voice-'));
      const target = path.join(directory, `audio.${format.extension}`), captureId = `voice:${hash(`${recipientId}\0${messageId}\0${randomUUID()}`)}`;
      try { fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); stop(signal); }
      catch (error) { try { fs.unlinkSync(target); } catch {} try { fs.rmdirSync(directory); } catch {} throw error; }
      this.voiceCaptures.set(captureId, { target, directory });
      return { conversation: { id: recipientId }, messageId, captureId, media: { type: 'voice', durationSeconds: seconds }, understandingScope: 'single-message-audio', interval: { scope: 'single-message-audio', startSeconds: 0, durationSeconds: seconds }, audio: { path: target, mimeType: format.mimeType, bytes: bytes.length } };
    }, { signal });
  }
  async releaseVoiceCapture(captureId) {
    const capture = this.voiceCaptures.get(captureId); if (!capture) return false;
    try { fs.unlinkSync(capture.target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { fs.rmdirSync(capture.directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.voiceCaptures.delete(captureId);
    return true;
  }
  openSharedVideo(recipientId, messageId, { allowed = false, signal } = {}) {
    if (allowed !== true) return Promise.reject(new Error('打开分享作品需要这个指定联系人的明确授权。'));
    if (typeof messageId !== 'string' || !/^msg:[a-f0-9]{64}$/.test(messageId)) return Promise.reject(new TypeError('需要已读取的精确消息 ID。'));
    return this.withPage(async page => {
      const { contact, flags } = await this.select(page, recipientId, signal);
      if (flags.blocked) return { ...flags, opened: false };
      const raw = await this.stableConversation(page, contact, signal);
      const messages = this.publicMessages(recipientId, raw.messages);
      const message = messages.find(item => item.id === messageId);
      if (message?.media?.type !== 'shared-work') throw new Error('该消息不是已识别的分享作品卡片。');
      if (message.media.identityConflict === true) throw new Error('分享卡片的公开链接与原生作品身份有冲突，未打开。');
      if (message.media.url) {
        let target; try { target = new URL(message.media.url); } catch { throw new Error('分享卡片公开链接格式无效，未打开。'); }
        const id = /^\/video\/(\d{1,64})\/?$/.exec(target.pathname)?.[1];
        if (message.media.url.length > 300 || target.protocol !== 'https:' || target.hostname !== 'www.douyin.com' || target.username || target.password || target.port || !id || message.media.videoId !== id) throw new Error('分享卡片公开链接与作品编号不一致，未打开。');
        return { ...flags, opened: false, videoId: id, url: 'https://www.douyin.com/video/' + id, source: message.media.publicUrlSource || 'dom-link', isPhotoGallery: message.media.isPhotoGallery };
      }
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
  canFallbackFromImage(delivery, recipientId) { return Boolean(delivery && this.unsentImageDeliveries.get(delivery) === recipientId && delivery.confirmed === false && delivery.deliveryUncertain === false); }
  sendImageMessage(recipientId, asset, { allowed = false, expectedContact, expectedMessageIds, expectedMessageContent, expectedMessageEvidence, signal, authorize, weak = false, backgroundOnly = false } = {}) {
    if (allowed !== true || typeof authorize !== 'function' || typeof authorize.beginDispatch !== 'function') return Promise.reject(new Error('图片发送需要当前许可及最终输入授权。'));
    const type = imageFileType(asset?.bytes);
    if (asset.sha256 !== hash(asset.bytes) || type.mimeType !== asset.mimeType || type.extension !== asset.extension) return Promise.reject(new Error('图片内容、摘要或类型不一致。'));
    const name = `dafeiyu-${randomUUID()}.${type.extension}`, token = 'dyImage_' + randomUUID().replaceAll('-', '');
    const authorized = async phase => { stop(signal); if (await authorize({ phase, recipientId }) !== true) throw new Error('图片回复许可已撤回。'); stop(signal); };
    return this.withPage(async page => {
      let staged = false, attempted = false, accepted = 0, release, contact, preview, stage = 'context';
      const unsent = code => { const result = { confirmed: false, deliveryUncertain: false, failureCode: code, failureStage:stage, sendClicks:0,platformSendStarted:false }; this.unsentImageDeliveries.set(result, recipientId); return result; };
      const cleanup = async () => {
        if (!staged || attempted) return !staged;
        await page.evaluate(token => window[token]?.dispose?.(), token).catch(() => {});
        const current = await page.evaluate(readImageUploadPreviewDom, { name, bytes: asset.bytes.length });
        if (!current || preview && current.localId !== preview.localId) return false;
        const cancel = page.locator('.MsgInputSendFileModalbox button.MsgInputSendFileModalbtnCancle');
        if (await cancel.count() !== 1) return false;
        // 仅取消与本次随机文件名、字节数和本地ID一致的自有预览。
        await cancel.click({ timeout: 1500 });
        return await page.locator('.MsgInputSendFileModalbox').count() === 0;
      };
      try {
        if (backgroundOnly && await this.isForeground(page)) return unsent('CHAT_FOREGROUND');
        await authorized('prepare');
        const selected = await this.select(page, recipientId, signal, { weak }); contact = selected.contact;
        if (selected.flags.blocked) return unsent('CHAT_ACCOUNT_ACTION_REQUIRED');
        if (weak && !contactIdentityBinding(contact)) return unsent('CHAT_IMAGE_STABLE_ID_REQUIRED');
        await this.verifyContactBinding(page, contact, expectedContact, weak);
        const matches = value => weak ? sameWeakConversation(value, contact) : sameConversationIdentity(value, contact);
        const read = async () => {
          const raw = await this.stableConversation(page, contact, signal, { weak });
          if (!matches(raw)) throw new Error('图片发送期间会话身份改变。');
          return { raw, messages: this.publicMessages(recipientId, raw.messages) };
        };
        const initial = await read(), expected = expectedMessageContent ?? messageContent(initial.messages), ids = expectedMessageIds ?? initial.messages.map(item => item.id);
        if (JSON.stringify(expected.map(item => item.id)) !== JSON.stringify(ids)) return unsent('CHAT_WATERMARK_CHANGED');
        const watermark = { content: expected, chronology: expectedMessageEvidence?.chronology ?? initial.raw.chronology, latestEndVerified: expectedMessageEvidence?.latestEndVerified ?? messageWatermark(initial.messages, initial.raw).latestEndVerified };
        const currentContext = async () => { await authorized('monitor'); await this.verifyContactBinding(page, contact, expectedContact, weak); const value = await read(); if (!compareMessageWatermark(watermark, value.messages, value.raw).matches) throw new Error('图片准备期间消息已变化。'); return value; };
        if (!compareMessageWatermark(watermark, initial.messages, initial.raw).matches) return unsent('CHAT_WATERMARK_CHANGED');
        const editor = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable=true]');
        if (await editor.count() !== 1 || readableDraft(await editor.innerText()) || await editor.locator('img,video,audio,[data-slate-void=true]').count() || await page.locator('.MsgInputSendFileModalbox').count()) return unsent('CHAT_USER_DRAFT_PRESENT');
        const contract = await page.evaluate(readUploadStagingContractDom);
        if (typeof contract !== 'string' || hash(contract) !== this.uploadContractHash) return unsent('CHAT_UPLOAD_CONTRACT_UNSUPPORTED');
        const input = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] input[type=file][multiple]');
        if (await input.count() !== 1) return unsent('CHAT_UPLOAD_INPUT_UNAVAILABLE');
        await currentContext();
        stage = 'stage-file';
        staged = true;
        await input.setInputFiles({ name, mimeType: type.mimeType, buffer: asset.bytes }, { timeout: 5000 });
        const until = Date.now() + 6000;
        do { stop(signal); preview = await page.evaluate(readImageUploadPreviewDom, { name, bytes: asset.bytes.length }); if (preview) break; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < until);
        if (!preview) throw new Error('没有取得本次图片的唯一发送预览。');
        await currentContext();
        stage = 'install-final-guard';
        const args = JSON.stringify({ token, name, bytes: asset.bytes.length });
        const expression = `(()=>{const readPreview=${readImageUploadPreviewDom.toString()};return (${installImageDispatchGuardDom.toString()})(${args})})()`;
        if (await page.evaluate(expression) !== true) throw new Error('图片最终输入门禁未就绪。');
        stage = 'geometry';
        const button = page.locator('.MsgInputSendFileModalbox button.MsgInputSendFileModalbtnSure');
        if (await button.count() !== 1) throw new Error('图片发送按钮不唯一。');
        const box = await button.boundingBox();
        if (!box || box.width < 2 || box.height < 2) throw new Error('图片发送按钮不可见。');
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        if (!await button.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), point)) throw new Error('图片发送按钮被遮挡。');
        await currentContext();
        stage = 'authorization';
        release = authorize.beginDispatch();
        await authorized('before-click');
        attempted = true;
        stage = 'dispatch';
        await page.mouse.click(point.x, point.y);
        release(); release = undefined;
        const witness = await page.evaluate(token => { const item = window[token]; return item ? { accepted: item.accepted, blocked: item.blocked } : null; }, token);
        accepted = witness?.accepted ?? -1;
        if (accepted === 0 && witness?.blocked === true) { attempted = false; return await cleanup() ? unsent('CHAT_IMAGE_FINAL_GUARD_REJECTED') : { confirmed: false, deliveryUncertain: false, failureCode: 'CHAT_IMAGE_PREVIEW_RETAINED' }; }
        if (accepted !== 1) return { confirmed: false, deliveryUncertain: true, failureCode: 'CHAT_IMAGE_INPUT_UNCERTAIN' };
        stage = 'receipt';
        const baseline = new Set(initial.messages.map(item => item.id)), imageRef = 'media:' + hash(preview.imagePath.startsWith('data:') ? preview.imagePath : new URL(preview.imagePath).pathname), imageMd5 = createHash('md5').update(asset.bytes).digest('hex');
        let clientMessageKey = null;
        const deadline = Date.now() + 15000;
        do {
          stop(signal);
          const flags = await page.evaluate(readChatBlockers); if (flags.blocked || flags.loginRequired || flags.verificationRequired) break;
          const value = await read(), fresh = value.messages.filter(item => item.sender === 'outgoing' && item.media?.type === 'image' && !baseline.has(item.id));
          const stagedMatches = fresh.filter(item => item.clientMessageKey && item.media.resources?.some(resource => resource.resourceRef === imageRef));
          if (stagedMatches.length > 1) break;
          if (stagedMatches.length === 1) { if (clientMessageKey && clientMessageKey !== stagedMatches[0].clientMessageKey) break; clientMessageKey = stagedMatches[0].clientMessageKey; }
          const matches = fresh.filter(item => (item.media.imageMd5===imageMd5 || clientMessageKey && item.clientMessageKey === clientMessageKey || item.media.resources?.some(resource=>resource.resourceRef===imageRef)) && item.serverConfirmed === true && !item.failed && !item.pending);
          if (matches.length === 1) return { confirmed: true, deliveryUncertain: false, messageId: matches[0].id, media: { type: 'image' }, confirmedBy: matches[0].media.imageMd5===imageMd5 ? 'uploaded-image-digest-and-server-message' : clientMessageKey ? 'owned-preview-client-and-server-message' : 'owned-preview-image-and-server-message' };
          if (matches.length > 1 || fresh.some(item => item.clientMessageKey === clientMessageKey && item.failed)) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        return { confirmed: false, deliveryUncertain: true, failureCode: 'CHAT_IMAGE_RECEIPT_UNCONFIRMED' };
      } catch {
        if (!attempted && await cleanup().catch(() => false)) return unsent('CHAT_IMAGE_PRECHECK_REJECTED');
        if (!staged && !attempted) return unsent('CHAT_IMAGE_PRECHECK_REJECTED');
        return { confirmed: false, deliveryUncertain: attempted, failureStage:stage, failureCode: attempted ? 'CHAT_IMAGE_RECEIPT_UNCONFIRMED' : 'CHAT_IMAGE_PREVIEW_RETAINED' };
      } finally {
        release?.();
        await page.evaluate(token => window[token]?.dispose?.(), token).catch(() => {});
      }
    }, { signal });
  }
  sendMessage(recipientId, message, { allowed = false, expectedContact, expectedMessageIds, expectedMessageContent, expectedMessageEvidence, signal: parentSignal, authorize, weak = false, backgroundOnly = false } = {}) {
    if (allowed !== true) return Promise.reject(new Error('发送需要这个指定联系人的明确授权。'));
    if (typeof message !== 'string' || !message.trim() || [...message].length > 1000) return Promise.reject(new TypeError('发送内容须为 1 到 1000 字的非空文字。'));
    if (authorize !== undefined && (typeof authorize !== 'function' || typeof authorize.beginDispatch !== 'function')) return Promise.reject(new TypeError('主动问候需要本机许可检查和最终短输入控制。'));
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const authorized = async phase => { stop(signal); if (authorize && await authorize({ phase, recipientId }) !== true) throw new Error('主动问候许可已撤回，未继续发送。'); stop(signal); };
    return this.withPage(async page => {
      if (backgroundOnly && await this.isForeground(page)) throw Object.assign(new Error('专用浏览器在前台，暂不切换私信页。'), { code: 'CHAT_FOREGROUND' });
      await authorized('prepare');
      const { contact, flags } = await this.select(page, recipientId, signal, { weak });
      if (flags.blocked) return { ...flags, confirmed: false, deliveryUncertain: false };
      const matches = value => weak ? sameWeakConversation(value, contact) : sameConversationIdentity(value, contact);
      await this.verifyContactBinding(page, contact, expectedContact, weak);
      const before = await page.evaluate(readConversationDom, { ...expectedDomIdentity(contact), allowWeak: weak });
      if (!matches(before) || !weak && before.identityUnavailable) throw new Error('填写回复前会话的稳定身份已变化，未填写或发送。');
      const initialMessages = this.publicMessages(recipientId, before.messages);
      const expected = expectedMessageIds ?? initialMessages.map(item => item.id);
      const expectedContent = expectedMessageContent ?? messageContent(initialMessages);
      const exactInitial = JSON.stringify(initialMessages.map(item => item.id)) === JSON.stringify(expected) && JSON.stringify(messageContent(initialMessages)) === JSON.stringify(expectedContent);
      const initialEvidence = messageWatermark(initialMessages, before);
      const expectedWatermark = { content: expectedContent, chronology: expectedMessageEvidence?.chronology ?? (exactInitial ? initialEvidence.chronology : 'unknown'), latestEndVerified: expectedMessageEvidence?.latestEndVerified === true || expectedMessageEvidence === undefined && exactInitial && initialEvidence.latestEndVerified };
      let guardDiagnostic;
      const sameWatermark = (messages, raw) => { const result = compareMessageWatermark(expectedWatermark, messages, raw); guardDiagnostic = result.diagnostic; return result.matches; };
      if (!Array.isArray(expected) || expected.some(id => typeof id !== 'string') || !Array.isArray(expectedContent) || JSON.stringify(expectedContent.map(item => item?.id)) !== JSON.stringify(expected) || !sameWatermark(initialMessages, before)) return { confirmed: false, deliveryUncertain: false, reason: '私信水位或内容已变化，未填写或发送回复。' };
      const receipt = { conversation: { id: contact.id, displayName: contact.displayName }, contact: { id: contact.id, name: contact.displayName } };
      const editor = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]');
      if (await editor.count() !== 1) throw new Error('没有唯一的私信文字输入框。');
      if (readableDraft(await editor.innerText()) || await editor.locator('img,video,audio,[data-slate-void="true"]').count()) throw new Error('当前会话已有草稿，已停止发送以保留原内容。');
      let clicked = false, monitoring = false, monitor, polling, releaseDispatch, failureStage = 'fill', precheckFailureCode;
      const witnessId = `chat-${hash(`${recipientId}:${Date.now()}:${Math.random()}`)}`;
      try {
        await editor.fill(message);
        stop(signal);
        failureStage = 'identity';
        const ready = await page.evaluate(readConversationDom, { ...expectedDomIdentity(contact), allowWeak: weak });
        if (!matches(ready) || readableDraft(await editor.innerText()) !== readableDraft(message)) throw new Error('发送前身份或输入文字回读不一致。');
        await this.verifyContactBinding(page, contact, expectedContact, weak);
        failureStage = 'watermark';
        const readyMessages = this.publicMessages(recipientId, ready.messages);
        if (!sameWatermark(readyMessages, ready)) throw new Error('填写回复期间私信水位或内容发生变化，未点击发送。');
        failureStage = 'button';
        const targetPage = page.locator('[data-e2e="im-dialog"]').locator('[class*="StackLayoutpagespageRoot"],[data-e2e="chat-page"]').filter({ has: page.locator('[data-e2e="msg-input"] [contenteditable="true"]') });
        if (await targetPage.count() !== 1) throw new Error('指定会话输入区域不唯一，未点击发送。');
        const sendMarker = targetPage.locator('.e2e-send-msg-btn,[data-e2e="send-msg-btn"]');
        if (await sendMarker.count() !== 1) throw new Error('没有唯一的指定会话发送按钮。');
        const installed = await sendMarker.evaluate((marker, { token, groupRequired, recipientId }) => {
          const scope = marker.closest('[class*="StackLayoutpagespageRoot"],[data-e2e="chat-page"]');
          if (!scope || scope.querySelectorAll('.e2e-send-msg-btn,[data-e2e="send-msg-btn"]').length !== 1) return false;
          const suitableParent = candidate => {
            if (!candidate || !scope.contains(candidate) || candidate.querySelector('[contenteditable="true"],textarea,input') || candidate.querySelectorAll('.e2e-send-msg-btn,[data-e2e="send-msg-btn"]').length !== 1) return false;
            const box = candidate.getBoundingClientRect(), icon = marker.getBoundingClientRect();
            return box.width >= 2 && box.height >= 2 && box.width <= 192 && box.height <= 96 && box.width * box.height <= Math.max(1, icon.width * icon.height) * 16;
          };
          let button = marker;
          const semantic = marker.closest('button,[role="button"]');
          if (semantic && semantic !== marker && suitableParent(semantic)) button = semantic;
          else if (marker instanceof SVGElement) {
            for (let parent = marker.parentElement, depth = 0; parent && parent !== scope && depth < 3; parent = parent.parentElement, depth++) {
              if (!suitableParent(parent)) continue;
              const keys = Object.getOwnPropertyNames(parent).filter(key => key.startsWith('__reactProps$'));
              const props = keys.length === 1 ? Object.getOwnPropertyDescriptor(parent, keys[0])?.value : null;
              const click = props && typeof props === 'object' ? Object.getOwnPropertyDescriptor(props, 'onClick')?.value : null;
              if (typeof click === 'function') { button = parent; break; }
            }
          }
          const own = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
          const groupPrototypeIdentity = value => {
              if (!value || typeof value !== 'object' || Array.isArray(value)) return { id: null, shortId: null, conflict: false, signature: 'absent' };
              const prototype = Object.getPrototypeOf(value), result = { id: null, shortId: null, conflict: false };
              const shape = descriptor => !descriptor ? ['absent'] : !Object.hasOwn(descriptor, 'value') ? ['accessor'] : ['data', typeof descriptor.value, typeof descriptor.value === 'string' || Number.isSafeInteger(descriptor.value) ? String(descriptor.value) : null];
              const signatures = ['conversationId', 'conversationShortId', 'groupId', 'id', 'shortId', 'conversationType', 'type'].map(key => shape(Object.getOwnPropertyDescriptor(value, key)));
              for (const key of ['id', 'shortId']) {
                const ownDescriptor = Object.getOwnPropertyDescriptor(value, key), descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, key);
                signatures.push(shape(descriptor));
                if (ownDescriptor && !Object.hasOwn(ownDescriptor, 'value')) result.conflict = true;
                if (!descriptor) continue;
                if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !/^\d{1,64}$/.test(descriptor.value)) { result.conflict = true; continue; }
                if (ownDescriptor && (!Object.hasOwn(ownDescriptor, 'value') || ownDescriptor.value !== descriptor.value)) { result.conflict = true; continue; }
                result[key] = descriptor.value;
              }
              result.signature = JSON.stringify([result.id, result.shortId, result.conflict, signatures]);
              return result;
            };
          const groupRowConversations = row => {
              const values = [], seen = new Set();
              const visit = (props, depth) => {
                if (!props || typeof props !== 'object' || seen.has(props)) return;
                seen.add(props);
                for (const key of ['conversation', 'conversationInfo', 'conversationData']) { const value = own(props, key); if (value && typeof value === 'object' && !Array.isArray(value)) values.push(value); }
                if (depth >= 3) return;
                const children = own(props, 'children');
                if (Array.isArray(children)) { for (let index = 0; index < Math.min(100, own(children, 'length') || 0); index++) visit(own(own(children, String(index)), 'props'), depth + 1); }
                else visit(own(children, 'props'), depth + 1);
              };
              const propsKeys = Object.getOwnPropertyNames(row).filter(key => key.startsWith('__reactProps$'));
              if (propsKeys.length === 1) visit(own(row, propsKeys[0]), 0);
              const fiberKeys = Object.getOwnPropertyNames(row).filter(key => key.startsWith('__reactFiber$'));
              if (fiberKeys.length === 1) {
                let fiber = own(row, fiberKeys[0]);
                const fibers = new Set();
                for (let depth = 0; fiber && typeof fiber === 'object' && depth < 4 && !fibers.has(fiber); depth++, fiber = own(fiber, 'return')) {
                  fibers.add(fiber);
                  const props = own(fiber, 'memoizedProps');
                  for (const key of ['conversation', 'conversationInfo', 'conversationData']) { const value = own(props, key); if (value && typeof value === 'object' && !Array.isArray(value)) values.push(value); }
                }
              }
              return [...new Set(values)];
            };
          const groupWitness = () => {
            const headers = [...scope.querySelectorAll('[class*="StackLayoutStackChatHeaderuser"],[data-e2e="chat-header"],[data-e2e="group-chat-header"]')];
            if (headers.length !== 1) return null;
            const header = headers[0], keys = Object.getOwnPropertyNames(header).filter(key => key.startsWith('__reactProps$'));
            if (keys.length !== 1) return null;
            const props = own(header, keys[0]), children = own(props, 'children'), conversation = own(own(Array.isArray(children) ? own(children, '0') : children, 'props'), 'conversation');
            const current = groupPrototypeIdentity(conversation);
            if (current.conflict || !current.id && !current.shortId) return null;
            const dialog = scope.closest('[data-e2e="im-dialog"]');
            if (!scope.isConnected || !dialog) return null;
            const rows = [...dialog.querySelectorAll('[data-e2e="conversation-item"]')].filter(row => row.getAttribute('data-deepseek-chat-id') === recipientId);
            if (rows.length !== 1) return null;
            const rowValues = groupRowConversations(rows[0]).map(groupPrototypeIdentity);
            if (rowValues.some(value => value.conflict) || !rowValues.some(value => value.id === current.id && value.shortId === current.shortId)) return null;
            return JSON.stringify([current.signature, rowValues.map(value => value.signature), header.getAttribute('data-conversation-type'), header.getAttribute('data-is-group'), Boolean(header.querySelector('[class*="GroupAvatar"],[data-e2e="group-avatar"]'))]);
          };
          const safeGroupWitness = () => { try { return groupWitness(); } catch { return null; } };
          const initialGroupWitness = groupRequired ? safeGroupWitness() : null;
          if (groupRequired && initialGroupWitness === null) return false;
          const entries = window.__deepseekChatInputs ??= Object.create(null), entry = { dispatched: false, marker, button, scope, groupBlocked: false };
          marker.setAttribute('data-deepseek-send-marker', token);
          button.setAttribute('data-deepseek-send-token', token);
          const witness = event => {
            if (!event.isTrusted || !(event.target === button || button.contains(event.target))) return;
            if (groupRequired && (entry.groupBlocked || safeGroupWitness() !== initialGroupWitness)) { entry.groupBlocked = true; event.preventDefault(); event.stopImmediatePropagation(); return; }
            if (event.type === 'click') entry.dispatched = true;
          };
          const witnessTypes = ['pointerdown', 'mousedown', 'mouseup', 'click'];
          for (const type of witnessTypes) document.addEventListener(type, witness, true);
          entry.cleanup = () => {
            for (const type of witnessTypes) document.removeEventListener(type, witness, true);
            const marked = new Set([button, marker, ...document.querySelectorAll(`[data-deepseek-send-token="${token}"],[data-deepseek-send-marker="${token}"]`)]);
            for (const element of marked) for (const attribute of ['data-deepseek-send-token', 'data-deepseek-send-marker']) if (element.getAttribute(attribute) === token) element.removeAttribute(attribute);
          }; entries[token] = entry;
          return true;
        }, { token: witnessId, groupRequired: contact.isGroup === true && ready.groupPrototypeIdentity === true, recipientId });
        if (!installed) throw new Error('发送图标没有唯一可核对的会话控件。');
        const send = targetPage.locator(`[data-deepseek-send-token="${witnessId}"]`);
        const inputDispatched = () => page.evaluate(token => window.__deepseekChatInputs?.[token]?.dispatched === true, witnessId);
        const readSendPoint = async () => {
          if (await send.count() !== 1 || !await send.isVisible() || !await send.isEnabled()) return null;
          return send.evaluate((button, token) => {
            const entry = window.__deepseekChatInputs?.[token];
            if (!entry || entry.button !== button || !entry.marker.isConnected || !entry.scope.isConnected || !button.contains(entry.marker) || entry.marker.getAttribute('data-deepseek-send-marker') !== token || entry.scope.querySelectorAll('.e2e-send-msg-btn,[data-e2e="send-msg-btn"]').length !== 1) return null;
            if (button.getAttribute('data-deepseek-send-token') !== token || button.closest('[disabled],[aria-disabled="true"]')) return null;
            const r = button.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
            if (r.width < 2 || r.height < 2 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
            const hit = document.elementFromPoint(x, y);
            if (!hit || hit !== button && !button.contains(hit)) return null;
            return { x: r.x, y: r.y, width: r.width, height: r.height, clickX: x, clickY: y };
          }, witnessId);
        };
        const sameGeometry = (left, right) => left && right && ['x', 'y', 'width', 'height'].every(key => Math.abs(left[key] - right[key]) <= 0.5);
        const checkPendingInput = async () => {
          if (clicked && await inputDispatched()) return;
          await authorized('monitor');
          if (await editor.count() !== 1 || await send.count() !== 1 || readableDraft(await editor.innerText()) !== readableDraft(message)) throw new Error('等待期间发送按钮或草稿发生变化，未发送。');
          const current = await page.evaluate(readConversationDom, { ...expectedDomIdentity(contact), allowWeak: weak }), blockers = await page.evaluate(readChatBlockers);
          if (clicked && await inputDispatched()) return;
          if (blockers.loginRequired || blockers.verificationRequired || !matches(current) || current.displayName !== ready.displayName) throw new Error('等待期间会话身份或页面许可发生变化，未发送。');
          await this.verifyContactBinding(page, contact, expectedContact, weak);
          const messages = this.publicMessages(recipientId, current.messages);
          if (!sameWatermark(messages, current)) throw new Error('等待期间收到新消息或消息内容变化，未发送。');
          stop(signal);
        };
        monitoring = true;
        monitor = setInterval(() => { if (polling || !monitoring) return; polling = checkPendingInput().catch(async error => { if (monitoring && !await inputDispatched().catch(() => false)) { precheckFailureCode = { '等待期间发送按钮或草稿发生变化，未发送。': 'CHAT_DRAFT_OR_BUTTON_CHANGED_DURING_WAIT', '等待期间会话身份或页面许可发生变化，未发送。': 'CHAT_IDENTITY_CHANGED_DURING_WAIT', '等待期间收到新消息或消息内容变化，未发送。': 'CHAT_WATERMARK_CHANGED_DURING_WAIT' }[error.message] || 'CHAT_AUTHORIZATION_CHECK_FAILED_DURING_WAIT'; interrupt.abort(error); } }).finally(() => { polling = null; }); }, 40);
        await checkPendingInput();
        failureStage = 'trial';
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
        if (!stablePoint) throw new Error('发送控件未通过连续几何及命中核对，未点击发送。');
        failureStage = 'identity';
        stop(signal); await checkPendingInput(); await authorized('before-click');
        await this.verifyContactBinding(page, contact, expectedContact, weak);
        if (await inputDispatched()) throw new Error('等待期间已发生发送输入，未再点击一次。');
        failureStage = 'authorization';
        if (authorize) { releaseDispatch = await authorize.beginDispatch(); if (typeof releaseDispatch !== 'function') throw new Error('最终输入控制没有返回可释放的许可。'); }
        await this.verifyContactBinding(page, contact, expectedContact, weak);
        await checkPendingInput();
        const finalPoint = await readSendPoint();
        if (!sameGeometry(finalPoint, stablePoint)) throw new Error('最终输入前发送控件移动、替换或被遮挡，未点击发送。');
        failureStage = 'dispatch';
        stop(signal); clicked = true;
        await page.mouse.click(finalPoint.clickX, finalPoint.clickY);
        releaseDispatch?.(); releaseDispatch = null;
        if (!await inputDispatched()) { if (await page.evaluate(token => window.__deepseekChatInputs?.[token]?.groupBlocked === true, witnessId)) { clicked = false; throw new Error('最终输入时群会话稳定身份已变化，未发送。'); } throw new Error('没有核对到真实发送输入，结果需要核对。'); }
        monitoring = false; clearInterval(monitor); stop(signal);
        failureStage = 'readback';
        const beforeIds = new Set(expected), sentCandidates = new Map();
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (attempt === 3 && !readableDraft(await editor.innerText().catch(() => ''))) {
            // 只重新挂载这个已授权会话一次，不重复输入或点击发送。
            const reopened = await this.select(page, recipientId, signal, { refresh: true, weak });
            if (reopened.flags.blocked || !matches(reopened.contact)) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '发送后无法重新核对原会话，未再次发送。' };
          }
          const after = await page.evaluate(readConversationDom, { ...expectedDomIdentity(contact), allowWeak: weak });
          if (!matches(after)) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '发送后会话发生变化，未再次发送。' };
          const messages = this.publicMessages(recipientId, after.messages);
          for (const item of messages) if (item.direction === 'outgoing' && item.text === message.trim() && item.arrivalClassification === 'new-tail' && !beforeIds.has(item.id) && item.serverConfirmed !== false) sentCandidates.set(item.id, messageFingerprint(item));
          const sent = sentCandidates.size === 1 ? messages.find(item => sentCandidates.has(item.id) && item.direction === 'outgoing' && item.text === message.trim() && sentCandidates.get(item.id) === messageFingerprint(item)) : null;
          if (sent && sent.serverConfirmed !== false && !sent.failed && !sent.pending) return { ...receipt, confirmed: true, messageId: sent.id, deliveryUncertain: false };
          if (sent?.failed) return { ...receipt, confirmed: false, deliveryUncertain: true, reason: '网页显示发送失败，未自动重试。' };
          stop(signal);
          await page.waitForTimeout(200);
        }
        return { ...receipt, confirmed: false, deliveryUncertain: true, failureStage: 'readback', failureCode: 'CHAT_RECEIPT_UNCONFIRMED', reason: '未取得新发出消息的界面回读，未自动重试。' };
      } catch (error) {
        monitoring = false; clearInterval(monitor);
        let draftCleanup = clicked ? 'not-required' : 'preserved';
        if (!clicked) try {
          // 受控编辑器须通过真实输入更新模型；只删除本次完整草稿，保留用户改动。
          if (readableDraft(await editor.innerText()) === readableDraft(message)) {
            await editor.press('ControlOrMeta+A');
            if (readableDraft(await editor.innerText()) === readableDraft(message)) { await editor.press('Backspace'); draftCleanup = readableDraft(await editor.innerText()) ? 'not-cleared' : 'cleared'; }
          }
        } catch { draftCleanup = 'unavailable'; }
        const failureCode = precheckFailureCode || { fill: 'CHAT_INPUT_FILL_FAILED', identity: 'CHAT_IDENTITY_OR_DRAFT_CHECK_FAILED', watermark: 'CHAT_WATERMARK_CHANGED', button: 'CHAT_SEND_BUTTON_UNAVAILABLE', trial: 'CHAT_SEND_BUTTON_NOT_INTERACTABLE', authorization: 'CHAT_FINAL_AUTHORIZATION_REJECTED', dispatch: 'CHAT_SEND_INPUT_UNCERTAIN', readback: 'CHAT_RECEIPT_READBACK_FAILED' }[failureStage] || 'CHAT_PRECHECK_FAILED';
        const detail = String(error?.message || '');
        const failureEvidence = { timeout: error?.name === 'TimeoutError', pointerIntercepted: /intercepts pointer events/.test(detail), elementUnstable: /element is not stable/.test(detail), elementDetached: /not attached to the DOM|detached from the DOM/.test(detail), outsideViewport: /outside of the viewport/.test(detail), notVisible: /element is not visible/.test(detail), disabled: /element is not enabled/.test(detail) };
        return { ...receipt, confirmed: false, deliveryUncertain: clicked, failureStage, failureCode, draftCleanup, failureEvidence, ...(guardDiagnostic ? { guardDiagnostic } : {}), reason: clicked ? '发送动作已尝试但结果不确定，未自动重试。' : '发送前检查未通过，未点击发送。' };
      } finally {
        monitoring = false; clearInterval(monitor); releaseDispatch?.();
        await page.evaluate(token => { const entry = window.__deepseekChatInputs?.[token]; entry?.cleanup(); if (window.__deepseekChatInputs) delete window.__deepseekChatInputs[token]; }, witnessId).catch(() => {});
      }
    }, { signal, launch: !backgroundOnly, create: !backgroundOnly });
  }
  async close() {
    const results = await Promise.allSettled([...this.incomingCleanup].map(cleanup => cleanup()));
    results.push(...await Promise.allSettled([...this.voiceCaptures.keys()].map(id => this.releaseVoiceCapture(id))));
    try { await this.controller.close(); }
    finally { const failed = results.find(result => result.status === 'rejected'); if (failed) throw new Error('部分私信临时资源尚未清理，请关闭占用文件后重试。', { cause: failed.reason }); }
  }
}
