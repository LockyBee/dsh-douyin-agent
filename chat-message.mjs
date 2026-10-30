import { createHash } from 'node:crypto';

const metadataTypes = new Set(['file', 'location', 'user-card', 'live', 'music', 'call', 'gift', 'video-attachment', 'link', 'unknown']);
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
export function messageWatermark(messages, evidence = {}) {
  const source = evidence.dayEvidence ?? evidence;
  return { content: messageContent(messages), chronology: source.chronology ?? 'unknown', latestEndVerified: messages.length > 0 && messages.every(message => message.latestEndVerified === true) && source.latestEndVerified !== false };
}

// 虚拟列表可以补载或移除旧前缀；最新锚点和全部连续重叠内容必须保留。
export function compareMessageWatermark(expected, messages, evidence = {}) {
  const source = evidence.dayEvidence ?? evidence, expectedContent = expected?.content;
  const invalidDirection = message => !['incoming', 'outgoing'].includes(message?.sender || message?.direction) || message?.sender && message?.direction && message.sender !== message.direction;
  const validContent = content => Array.isArray(content) && content.every(item => item && typeof item.id === 'string' && item.id.length > 0 && /^[a-f0-9]{64}$/.test(item.fingerprint ?? '')) && new Set(content.map(item => item.id)).size === content.length;
  if (!validContent(expectedContent) || !Array.isArray(messages) || messages.some(message => !message || typeof message.id !== 'string' || !message.id) || new Set(messages.map(message => message.id)).size !== messages.length) return { matches: false, diagnostic: { invalidWatermark: true } };
  const expectedIds = expectedContent.map(item => item.id), known = new Map(expectedContent.map(item => [item.id, item.fingerprint]));
  const actual = messageContent(messages), anchor = expectedIds.at(-1), anchorIndex = messages.findIndex(item => item.id === anchor);
  const currentLatestEndVerified = messages.length > 0 && messages.every(message => message.latestEndVerified === true) && source.latestEndVerified !== false;
  const diagnostic = { expectedCount: expectedIds.length, currentCount: messages.length, expectedLatestEndVerified: expected.latestEndVerified === true, currentLatestEndVerified, chronology: source.chronology ?? 'unknown', suffixOffset: messages.length <= expectedIds.length ? expectedIds.length - messages.length : null,
    latestAnchorPresent: anchorIndex >= 0, latestAnchorAtEnd: anchorIndex >= 0 && anchorIndex === messages.length - 1, latestAnchorFingerprintMatches: anchorIndex >= 0 && actual[anchorIndex].fingerprint === known.get(anchor), allOverlapContentMatches: actual.filter(item => known.has(item.id)).every(item => item.fingerprint === known.get(item.id)), unknownDirectionCount: messages.filter(invalidDirection).length,
    additionalCount: messages.filter(item => !known.has(item.id)).length, additionalClassifications: Object.fromEntries(['old-history', 'known-old-window', 'new-tail', 'ambiguous-new', 'baseline'].map(kind => [kind, messages.filter(item => !known.has(item.id) && item.arrivalClassification === kind).length])) };
  if (diagnostic.unknownDirectionCount) return { matches: false, diagnostic };
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

export const isOpenBacklogRecord = record => Boolean(record && !record.handledByUserAt && record.autoHandled !== true && !record.autoHandledAt);
const nativeArrivalSource = 'bound-native-after-observed-baseline-v1';
const plainNativeIncoming = message => message?.sender === 'incoming' && (!message.direction || message.direction === 'incoming') && message.kind === 'text' && !message.media && !message.reference && message.identitySource === 'dom-message-id' && message.nativeServerMessageBound === true && typeof message.text === 'string' && message.text.trim() && Number.isFinite(Date.parse(message.nativeCreatedAt));
export function validBacklogQualification(record, item, current) {
  if (item?.qualified !== true || item.message?.sender !== 'incoming' || !/^[a-f0-9]{64}$/.test(item.fingerprint ?? '') || messageFingerprint(item.message) !== item.fingerprint) return false;
  if (item.originalEligibleForReply === true) return true;
  const proof = item.nativeArrivalEvidence, evidence = record?.recoveryEvidence;
  if (record.phase !== 'unqualified' || item.originalEligibleForReply !== false || evidence?.qualificationSource !== nativeArrivalSource || proof?.source !== nativeArrivalSource || evidence.contact?.isGroup !== false || !plainNativeIncoming(item.message)) return false;
  const baseline = Date.parse(proof.observedBaselineAt), created = Date.parse(proof.nativeCreatedAt), detected = Date.parse(proof.detectedAt);
  if (![baseline, created, detected].every(Number.isFinite) || created <= baseline || created > detected || detected - created > 60_000 || proof.detectedAt !== record.at || proof.nativeCreatedAt !== item.message.nativeCreatedAt || proof.fingerprint !== item.fingerprint || !record.incoming?.some(message => message.id === item.message.id && message.text === item.message.text)) return false;
  return !current || plainNativeIncoming(current) && current.id === item.message.id && current.nativeCreatedAt === proof.nativeCreatedAt && messageFingerprint(current) === item.fingerprint;
}

// 仅恢复运行期间漏掉的原生新私信；展示时间、未发过的旧历史和发送不明均不足以放行。
export function qualifyNativeUnanswered(record, previousMark, messages, snapshot, contact, stopRequest, now = Date.now()) {
  if (!isOpenBacklogRecord(record) || record.phase !== 'unqualified' || record.recoveryEvidence || record.autoAttempt || record.legacyUncertain || contact?.isGroup !== false || !Array.isArray(record.incoming) || record.incoming.length !== 1 || !Array.isArray(messages) || !messages.length || messages.length > 512) return null;
  const source = snapshot?.dayEvidence ?? snapshot;
  if (source?.chronology !== 'oldest-first' || source.latestEndVerified !== true || messages.some(message => message.latestEndVerified !== true || !['incoming', 'outgoing'].includes(message.sender) || message.direction && message.direction !== message.sender) || new Set(messages.map(message => message.id)).size !== messages.length) return null;
  const original = record.incoming[0], prior = previousMark?.context?.find(message => message.id === original.id), index = messages.findIndex(message => message.id === original.id), current = messages[index];
  if (!plainNativeIncoming(current) || !prior || prior.sender !== 'incoming' || prior.identitySource !== 'dom-message-id' || prior.eligibleForReply !== false || prior.arrivalClassification !== 'ambiguous-new' || prior.latestEndVerified !== true || prior.text !== original.text || messageFingerprint(prior) !== messageFingerprint(current) || messages.slice(index + 1).some(message => message.sender === 'outgoing')) return null;
  const baseline = Date.parse(previousMark.startedAt), created = Date.parse(current.nativeCreatedAt), detected = Date.parse(record.at), stopAt = Date.parse(stopRequest?.requestedAt);
  if (![baseline, created, detected].every(Number.isFinite) || baseline >= created || created > detected || detected - created > 60_000 || detected > now || Date.parse(prior.timestamp ?? prior.sentAt) !== created || stopRequest?.preservePending !== true && Number.isFinite(stopAt) && stopAt >= detected) return null;
  const fingerprint = messageFingerprint(current), item = { message: structuredClone(current), fingerprint, qualified: true, originalEligibleForReply: false, nativeArrivalEvidence: { source: nativeArrivalSource, observedBaselineAt: previousMark.startedAt, nativeCreatedAt: current.nativeCreatedAt, detectedAt: record.at, fingerprint } };
  const evidence = { version: 1, qualificationSource: nativeArrivalSource, beforeDispatch: true, contact: structuredClone(contact), qualifiedIncoming: [item], expectedContent: messageContent(messages), qualifiedAt: new Date(now).toISOString() };
  return validBacklogQualification({ ...record, recoveryEvidence: evidence }, item, current) ? evidence : null;
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
    const minimum = item.message.identitySource === 'dom-message-id' ? Math.min(3, expected.length) : 3;
    for (let offset = Math.max(0, expected.length - messages.length); offset <= Math.min(targetIndex, expected.length - minimum); offset++) {
      const suffix = expected.slice(offset), sequence = suffix.map(message => message.fingerprint).join('|'), start = joinedCurrent.indexOf(sequence);
      if (start < 0) continue;
      if (start % 65 !== 0 || joinedCurrent.lastIndexOf(sequence) !== start) return { ready: false, reason: 'context-not-unique' };
      const relativeTarget = targetIndex - offset;
      const neighbors = suffix.slice(Math.max(0, relativeTarget - 2), Math.min(suffix.length, relativeTarget + 3)).filter((_, index) => Math.max(0, relativeTarget - 2) + index !== relativeTarget);
      if (item.message.identitySource !== 'dom-message-id' && new Set(neighbors.map(value => value.fingerprint).filter(value => value !== item.fingerprint)).size < 2) return { ready: false, reason: 'legacy-adjacency-insufficient' };
      context = { start: start / 65, end: start / 65 + suffix.length - 1, target: start / 65 + relativeTarget, offset };
      break;
    }
    if (!context) return { ready: false, reason: 'complete-context-suffix-unavailable' };
    if (item.message.identitySource === 'dom-message-id') {
      const index = messages.findIndex(message => message.id === item.message.id);
      if (index < 0 || index !== context.target || messages[index].identitySource !== 'dom-message-id' || messages[index].sender !== 'incoming' || current[index] !== item.fingerprint) return { ready: false, reason: 'native-target-unavailable' };
      targets.push({ index, message: messages[index], fingerprint: item.fingerprint, mapping: 'native-id-fingerprint-context', context });
      continue;
    }
    if (targetIndex < 0 || expected.length < 3) return { ready: false, reason: 'legacy-context-incomplete' };
    const index = context.target;
    if (messages[index].identitySource !== 'dom-message-id' || messages[index].sender !== 'incoming') return { ready: false, reason: 'legacy-native-target-unavailable' };
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
  const candidates = messages.slice(last + 1).filter(message => message.sender === 'outgoing' && message.identitySource === 'dom-message-id' && !known.has(message.id) && message.failed !== true && message.pending !== true && message.sent !== false && (!mapping.uncertain || typeof expectedText === 'string' && message.text?.trim() === expectedText.trim()));
  if (mapping.uncertain) return candidates.length === 1 ? candidates[0] : null;
  return candidates.at(-1) || null;
}
