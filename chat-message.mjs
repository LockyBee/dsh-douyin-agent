import { createHash } from 'node:crypto';

const metadataTypes = new Set(['file', 'location', 'user-card', 'live', 'music', 'call', 'gift', 'video-attachment', 'link', 'unknown']);
const privateVideoAccess = new WeakMap();

export function grantPrivateVideoAccess(message, authorize) {
  if (message?.sender !== 'incoming' || message.media?.type !== 'shared-work' || typeof authorize !== 'function') {
    throw new TypeError('私信观看需要已核对的来信作品。');
  }
  const access = Object.freeze({});
  privateVideoAccess.set(access, { authorize, videoId: message.media.videoId });
  return access;
}

export function bindPrivateVideoAccess(access, videoId) {
  if (access === undefined) return;
  const entry = privateVideoAccess.get(access);
  if (!entry || typeof videoId !== 'string' || !/^\d{1,64}$/.test(videoId) || entry.videoId && entry.videoId !== videoId) {
    throw new Error('私信作品身份回读不一致。');
  }
  entry.authorize();
  entry.videoId = videoId;
}

export function checkPrivateVideoAccess(access, videoId) {
  if (access === undefined) return false;
  const entry = privateVideoAccess.get(access);
  if (!entry || videoId !== undefined && entry.videoId !== videoId) throw new Error('私信作品观看许可无效。');
  entry.authorize();
  return true;
}

export function releasePrivateVideoAccess(access) { privateVideoAccess.delete(access); }

export const isMetadataMessage = message => metadataTypes.has(message?.media?.type) && message.media.understandingScope === 'visible-message-metadata-only';
export function isReplyableMessage(message) {
  if (!message || message.nonReplyableNotice === true || ['recalled', 'withdrawn', 'system', 'system-notice'].some(kind => kind === message.kind || kind === message.type) || message.unsupported === true) return false;
  return Boolean(isMetadataMessage(message) || message.media && ['emoji', 'shared-work', 'image', 'voice'].includes(message.media.type)
    || (!message.kind || ['text', 'quote'].includes(message.kind)) && (message.text?.trim() || message.reference?.text?.trim()));
}

// 只投影已采集的消息资料，资源地址、DOM 选择器和任意附加字段不进入模型。
export function chatMessageSummary(message) {
  const bounded = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined;
  const media = message.media;
  return { messageId: message.id, text: bounded(message.text, 6000),
    ...(message.reference ? { reference: { text: bounded(message.reference.text, 1200), scope: 'visible-quoted-message', contentStatus: 'preview-only' } } : {}),
    ...(media ? { media: { type: bounded(media.type, 40), label: bounded(media.label, 200), title: bounded(media.title, 1000), author: bounded(media.author, 120),
      domain: bounded(media.domain, 253), durationSeconds: Number.isFinite(media.durationSeconds) ? media.durationSeconds : undefined,
      animatedHint: media.animatedHint === true, isPhotoGallery: media.isPhotoGallery === true,
      understandingScope: bounded(media.understandingScope, 100), contentStatus: bounded(media.contentStatus, 40) } } : {}) };
}

// 展示时间和 DOM 选择器会变化；核对真正的消息内容及媒体资源。
export function messageFingerprint(message) {
  const media=message.media;
  const value=[message.sender||message.direction,message.kind||'text',message.text||'',media?{
    type:media.type,label:media.label,title:media.title,author:media.author,durationSeconds:media.durationSeconds,
    videoId:media.videoId,url:media.url,isPhotoGallery:media.isPhotoGallery,
    domain:media.domain,contentStatus:media.contentStatus,imageMd5:media.imageMd5,...(media.animatedHint ? {animatedHint:true} : {}),
    resources:media.resources?.map(resource=>({resourceRef:resource.resourceRef,label:resource.label})),
  }:null];
  if (message.reference) value.push({ reference: { text: message.reference.text, scope: message.reference.scope } });
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export const messageContent = messages => messages.map(message => ({ id: message.id, fingerprint: messageFingerprint(message) }));
const invalidDirection = message => !['incoming', 'outgoing'].includes(message?.sender || message?.direction) || message?.sender && message?.direction && message.sender !== message.direction;
function historicalUnknownPrefix(messages) {
  const prefix = [];
  for (const message of messages) {
    if (!invalidDirection(message)) break;
    if ((message.sender || message.direction) !== 'unknown' || message.sender && message.direction && message.sender !== message.direction || message.eligibleForReply === true || !['baseline', 'known-old-window', 'old-history'].includes(message.arrivalClassification)) return [];
    prefix.push({ id: message.id, fingerprint: messageFingerprint(message) });
  }
  return prefix.length < messages.length ? prefix : [];
}
export function messageWatermark(messages, evidence = {}) {
  const source = evidence.dayEvidence ?? evidence;
  const latestEndVerified = messages.length > 0 && messages.every(message => message.latestEndVerified === true) && source.latestEndVerified !== false;
  const unknownPrefix = source.chronology === 'oldest-first' && latestEndVerified ? historicalUnknownPrefix(messages) : [];
  return { content: messageContent(messages), chronology: source.chronology ?? 'unknown', latestEndVerified, ...(unknownPrefix.length ? { unknownPrefix } : {}) };
}

// 虚拟列表可以补载或移除旧前缀；最新锚点和全部连续重叠内容必须保留。
export function compareMessageWatermark(expected, messages, evidence = {}) {
  const source = evidence.dayEvidence ?? evidence, expectedContent = expected?.content;
  const validContent = content => Array.isArray(content) && content.every(item => item && typeof item.id === 'string' && item.id.length > 0 && /^[a-f0-9]{64}$/.test(item.fingerprint ?? '')) && new Set(content.map(item => item.id)).size === content.length;
  if (!validContent(expectedContent) || !Array.isArray(messages) || messages.some(message => !message || typeof message.id !== 'string' || !message.id) || new Set(messages.map(message => message.id)).size !== messages.length) return { matches: false, diagnostic: { invalidWatermark: true } };
  const expectedIds = expectedContent.map(item => item.id), known = new Map(expectedContent.map(item => [item.id, item.fingerprint]));
  const actual = messageContent(messages), anchor = expectedIds.at(-1), anchorIndex = messages.findIndex(item => item.id === anchor);
  const currentLatestEndVerified = messages.length > 0 && messages.every(message => message.latestEndVerified === true) && source.latestEndVerified !== false;
  const diagnostic = { expectedCount: expectedIds.length, currentCount: messages.length, expectedLatestEndVerified: expected.latestEndVerified === true, currentLatestEndVerified, chronology: source.chronology ?? 'unknown', suffixOffset: messages.length <= expectedIds.length ? expectedIds.length - messages.length : null,
    latestAnchorPresent: anchorIndex >= 0, latestAnchorAtEnd: anchorIndex >= 0 && anchorIndex === messages.length - 1, latestAnchorFingerprintMatches: anchorIndex >= 0 && actual[anchorIndex].fingerprint === known.get(anchor), allOverlapContentMatches: actual.filter(item => known.has(item.id)).every(item => item.fingerprint === known.get(item.id)), unknownDirectionCount: messages.filter(invalidDirection).length,
    additionalCount: messages.filter(item => !known.has(item.id)).length, additionalClassifications: Object.fromEntries(['old-history', 'known-old-window', 'new-tail', 'ambiguous-new', 'baseline'].map(kind => [kind, messages.filter(item => !known.has(item.id) && item.arrivalClassification === kind).length])) };
  if (diagnostic.unknownDirectionCount) {
    const prefix = historicalUnknownPrefix(messages), saved = expected.unknownPrefix;
    const proven = expected.chronology === 'oldest-first' && source.chronology === 'oldest-first' && expected.latestEndVerified === true && currentLatestEndVerified && validContent(saved) && saved.length > 0 && saved.length < expectedContent.length && saved.every((item,index) => item.id === expectedContent[index]?.id && item.fingerprint === expectedContent[index]?.fingerprint);
    const stable = proven ? prefix.filter(item => saved.some(previous => previous.id === item.id && previous.fingerprint === item.fingerprint)) : [];
    diagnostic.historicalUnknownPrefixCount = stable.length;
    diagnostic.unknownDirectionCount -= stable.length;
    if (diagnostic.unknownDirectionCount) return { matches: false, diagnostic };
  }
  if (JSON.stringify(actual) === JSON.stringify(expectedContent)) return { matches: true, diagnostic };
  if (!messages.length || expected.chronology !== 'oldest-first' || source.chronology !== 'oldest-first' || expected.latestEndVerified !== true || !currentLatestEndVerified || !diagnostic.latestAnchorAtEnd || !diagnostic.latestAnchorFingerprintMatches || !diagnostic.allOverlapContentMatches) return { matches: false, diagnostic };
  const firstOverlap = messages.findIndex(item => known.has(item.id)), expectedOffset = expectedIds.indexOf(messages[firstOverlap]?.id);
  if (firstOverlap < 0 || expectedOffset < 0) return { matches: false, diagnostic };
  const overlap = actual.slice(firstOverlap), prefix = messages.slice(0, firstOverlap);
  diagnostic.suffixOffset = expectedOffset; diagnostic.additionalPrefixCount = prefix.length;
  const matches = JSON.stringify(overlap) === JSON.stringify(expectedContent.slice(expectedOffset))
    && prefix.every(item => !known.has(item.id) && ['old-history', 'known-old-window'].includes(item.arrivalClassification) && item.eligibleForReply !== true);
  return { matches, diagnostic };
}

export const isOpenBacklogRecord = record => Boolean(record && record.phase !== 'handled-by-user' && !record.handledByUserAt && record.autoHandled !== true && !record.autoHandledAt);
const nativeArrivalSource = 'bound-native-after-observed-baseline-v1';
const isNativeReplyId = message => message?.identitySource === 'dom-message-id'
  || message?.identitySource === 'api-message-id' && message.apiServerMessageBound === true && message.serverConfirmed === true;
const nativeCreation = message => message?.identitySource === 'api-message-id' ? message.createdAt : message.nativeCreatedAt;
const boundNativeIncoming = message => message?.sender === 'incoming' && (!message.direction || message.direction === 'incoming')
  && isReplyableMessage(message) && isNativeReplyId(message) && Number.isFinite(Date.parse(nativeCreation(message)))
  && (message.identitySource === 'api-message-id' ? message.timestampMs === Date.parse(message.createdAt) : message.nativeServerMessageBound === true);
function matchesArchivedNative(archived, message) {
  if (archived?.id !== message.id || archived.text !== message.text) return false;
  if (archived.fingerprint !== undefined) return archived.fingerprint === messageFingerprint(message);
  return message.kind === 'text' && !message.media && !message.reference;
}
export function validBacklogQualification(record, item, current) {
  if (item?.qualified !== true || item.message?.sender !== 'incoming' || !/^[a-f0-9]{64}$/.test(item.fingerprint ?? '') || messageFingerprint(item.message) !== item.fingerprint) return false;
  if (item.originalEligibleForReply === true) return true;
  const proof = item.nativeArrivalEvidence, evidence = record?.recoveryEvidence;
  if (record.phase !== 'unqualified' || item.originalEligibleForReply !== false || evidence?.qualificationSource !== nativeArrivalSource || proof?.source !== nativeArrivalSource || evidence.contact?.isGroup !== false || !boundNativeIncoming(item.message)) return false;
  const baseline = Date.parse(proof.observedBaselineAt), created = Date.parse(proof.nativeCreatedAt), detected = Date.parse(proof.detectedAt);
  if (![baseline, created, detected].every(Number.isFinite) || created <= baseline || created > detected || detected - created > 60_000 || proof.detectedAt !== record.at || proof.nativeCreatedAt !== nativeCreation(item.message) || proof.fingerprint !== item.fingerprint || !record.incoming?.some(message => matchesArchivedNative(message, item.message))) return false;
  return !current || boundNativeIncoming(current) && current.id === item.message.id && nativeCreation(current) === proof.nativeCreatedAt && messageFingerprint(current) === item.fingerprint;
}

// 仅恢复运行期间漏掉的原生新私信；展示时间、未发过的旧历史和发送不明均不足以放行。
export function qualifyNativeUnanswered(record, previousMark, messages, snapshot, contact, stopRequest, now = Date.now()) {
  if (!isOpenBacklogRecord(record) || record.phase !== 'unqualified' || record.recoveryEvidence || record.autoAttempt || record.legacyUncertain || contact?.isGroup !== false || !Array.isArray(record.incoming) || !record.incoming.length || record.incoming.length > 8 || !Array.isArray(messages) || !messages.length || messages.length > 512) return null;
  const source = snapshot?.dayEvidence ?? snapshot;
  if (source?.chronology !== 'oldest-first' || source.latestEndVerified !== true || messages.some(message => message.latestEndVerified !== true || !['incoming', 'outgoing'].includes(message.sender) || message.direction && message.direction !== message.sender) || new Set(messages.map(message => message.id)).size !== messages.length) return null;
  if (new Set(record.incoming.map(message => message?.id)).size !== record.incoming.length) return null;
  const baseline = Date.parse(previousMark?.startedAt), detected = Date.parse(record.at), stopAt = Date.parse(stopRequest?.requestedAt);
  if (![baseline, detected].every(Number.isFinite) || detected > now
    || stopRequest?.preservePending !== true && Number.isFinite(stopAt) && stopAt >= detected) return null;
  const lastOutgoing = messages.findLastIndex(message => message.sender === 'outgoing');
  const qualified = [];
  for (const original of record.incoming) {
    if (typeof original?.id !== 'string') return null;
    const prior = previousMark?.context?.find(message => message.id === original.id);
    const index = messages.findIndex(message => message.id === original.id), current = messages[index];
    if (!boundNativeIncoming(current) || !matchesArchivedNative(original, current) || index <= lastOutgoing
      || !prior || prior.sender !== 'incoming' || !isNativeReplyId(prior) || prior.identitySource !== current.identitySource || prior.eligibleForReply !== false
      || prior.arrivalClassification !== 'ambiguous-new' || prior.latestEndVerified !== true
      || messageFingerprint(prior) !== messageFingerprint(current)) return null;
    const created = Date.parse(nativeCreation(current));
    const previousTime = prior.timestampMs ?? Date.parse(prior.timestamp ?? prior.sentAt);
    if (baseline >= created || created > detected || detected - created > 60_000 || previousTime !== created) return null;
    const fingerprint = messageFingerprint(current);
    qualified.push({ message: structuredClone(current), fingerprint, qualified: true, originalEligibleForReply: false,
      nativeArrivalEvidence: { source: nativeArrivalSource, observedBaselineAt: previousMark.startedAt,
        nativeCreatedAt: nativeCreation(current), detectedAt: record.at, fingerprint } });
  }
  const evidence = { version: 1, qualificationSource: nativeArrivalSource, beforeDispatch: true, contact: structuredClone(contact), qualifiedIncoming: qualified, expectedContent: messageContent(messages), qualifiedAt: new Date(now).toISOString() };
  return qualified.every(item => validBacklogQualification({ ...record, recoveryEvidence: evidence }, item)) ? evidence : null;
}
export function mapBacklogMessages(record, messages) {
  const evidence = record?.recoveryEvidence, qualified = evidence?.qualifiedIncoming;
  if (!Array.isArray(messages) || messages.length > 512 || messages.some(message => !message || typeof message.id !== 'string' || !message.id || !['incoming', 'outgoing'].includes(message.sender || message.direction) || message.sender && message.direction && message.sender !== message.direction) || new Set(messages.map(message => message.id)).size !== messages.length) return { ready: false, reason: 'current-direction-or-identity' };
  if (evidence?.version !== 1 || !Array.isArray(qualified) || !qualified.length || qualified.length > 8 || qualified.some(item => !validBacklogQualification(record, item, item.originalEligibleForReply === false ? messages.find(message => message.id === item.message?.id) ?? {} : undefined))) return { ready: false, reason: 'qualification-evidence-unavailable' };
  const expected = evidence.expectedContent;
  if (!Array.isArray(expected) || !expected.length || expected.length > 2000 || expected.some(item => !item || typeof item.id !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint ?? '')) || new Set(expected.map(item => item.id)).size !== expected.length) return { ready: false, reason: 'context-evidence-unavailable' };
  const current = messages.map(message => messageFingerprint(message)), joinedCurrent = current.join('|'), targets = [];
  for (const item of qualified) {
    const targetIndex = expected.findIndex(message => message.id === item.message.id && message.fingerprint === item.fingerprint);
    if (targetIndex < 0) return { ready: false, reason: 'target-context-unavailable' };
    let context;
    const native = isNativeReplyId(item.message);
    if (!native && item.message.identitySource === 'api-message-id') return { ready: false, reason: 'api-target-not-bound' };
    const minimum = native ? Math.min(3, expected.length) : 3;
    for (let offset = Math.max(0, expected.length - messages.length); offset <= Math.min(targetIndex, expected.length - minimum); offset++) {
      const suffix = expected.slice(offset), sequence = suffix.map(message => message.fingerprint).join('|'), start = joinedCurrent.indexOf(sequence);
      if (start < 0) continue;
      if (start % 65 !== 0 || joinedCurrent.lastIndexOf(sequence) !== start) return { ready: false, reason: 'context-not-unique' };
      const relativeTarget = targetIndex - offset;
      const neighbors = suffix.slice(Math.max(0, relativeTarget - 2), Math.min(suffix.length, relativeTarget + 3)).filter((_, index) => Math.max(0, relativeTarget - 2) + index !== relativeTarget);
      if (!native && new Set(neighbors.map(value => value.fingerprint).filter(value => value !== item.fingerprint)).size < 2) return { ready: false, reason: 'legacy-adjacency-insufficient' };
      context = { start: start / 65, end: start / 65 + suffix.length - 1, target: start / 65 + relativeTarget, offset };
      break;
    }
    if (!context) return { ready: false, reason: 'complete-context-suffix-unavailable' };
    if (native) {
      const index = messages.findIndex(message => message.id === item.message.id);
      if (index < 0 || index !== context.target || !isNativeReplyId(messages[index]) || messages[index].identitySource !== item.message.identitySource || messages[index].sender !== 'incoming' || current[index] !== item.fingerprint
        || item.message.memberId && item.message.memberId !== messages[index].memberId) return { ready: false, reason: 'native-target-unavailable' };
      targets.push({ index, message: messages[index], fingerprint: item.fingerprint, mapping: 'native-id-fingerprint-context', context });
      continue;
    }
    if (targetIndex < 0 || expected.length < 3) return { ready: false, reason: 'legacy-context-incomplete' };
    const index = context.target;
    if (!isNativeReplyId(messages[index]) || messages[index].sender !== 'incoming'
      || item.message.memberId && item.message.memberId !== messages[index].memberId) return { ready: false, reason: 'legacy-native-target-unavailable' };
    targets.push({ index, message: messages[index], fingerprint: item.fingerprint, mapping: 'unique-complete-context-suffix-adjacency', context });
  }
  if (new Set(targets.map(item => item.message.id)).size !== targets.length) return { ready: false, reason: 'duplicate-target' };
  const uncertain = ['reserved', 'uncertain'].includes(record.autoAttempt?.state) || record.recoveryEvidence.beforeDispatch === false || ['sending', 'delivery-uncertain'].includes(record.phase);
  const laterOutgoing = messages.slice(Math.max(...targets.map(item => item.index)) + 1).some(message => message.sender === 'outgoing');
  return { ready: true, targets, uncertain, laterOutgoing, canSend: !uncertain && !laterOutgoing && (['not-sent', 'model', 'observing', 'superseded', 'stopped-before-send'].includes(record.phase) || record.phase === 'unqualified' && evidence.qualificationSource === nativeArrivalSource) && record.recoveryEvidence.beforeDispatch === true };
}

export function backlogOutgoingReadback(record, mapping, messages, expectedText) {
  if (!mapping?.ready) return null;
  const last = Math.max(...mapping.targets.map(item => item.context.end)), known = new Set(record.recoveryEvidence.expectedContent.map(item => item.id));
  const candidates = messages.slice(last + 1).filter(message => message.sender === 'outgoing' && isNativeReplyId(message) && !known.has(message.id) && message.failed !== true && message.pending !== true && message.sent !== false && (!mapping.uncertain || typeof expectedText === 'string' && message.text?.trim() === expectedText.trim()));
  if (mapping.uncertain) return candidates.length === 1 ? candidates[0] : null;
  return candidates.at(-1) || null;
}
