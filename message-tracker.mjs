import { createHash } from 'node:crypto';
import { messageFingerprint } from './chat-message.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const reliableOrder = row => Number.isSafeInteger(row.order) && row.order >= 0;
const nativeId = row => typeof row.nativeId === 'string' && row.nativeId.length > 0 ? row.nativeId : null;
const sameMessage = (left, right) => nativeId(left) || nativeId(right)
  ? Boolean(nativeId(left) && nativeId(right) && nativeId(left) === nativeId(right)) : left.signature === right.signature;

function occurrences(window, sequence) {
  const found = [];
  for (let start = 0; start + sequence.length <= window.length; start += 1) {
    if (sequence.every((row, offset) => sameMessage(row, window[start + offset]))) found.push(start);
  }
  return found;
}

function relativeOverlap(previous, current) {
  // 只有上一窗口末尾仍在当前窗口，并且连续重叠位置唯一，才有可靠新增边界。
  for (let count = Math.min(previous.length, current.length); count > 0; count -= 1) {
    const previousStart = previous.length - count, suffix = previous.slice(previousStart);
    const positions = occurrences(current, suffix);
    if (!positions.length) continue;
    if (positions.length !== 1 || occurrences(previous, suffix).length !== 1) return null;
    return { previousStart, currentStart: positions[0], count, end: positions[0] + count - 1 };
  }
  return null;
}

function knownWindow(snapshots, current) {
  if (!current.length) return null;
  const candidates = [];
  for (const window of snapshots) {
    for (const start of occurrences(window, current)) candidates.push(window.slice(start, start + current.length));
  }
  if (!candidates.length) return null;
  const ids = JSON.stringify(candidates[0].map(row => row.id));
  return candidates.every(candidate => JSON.stringify(candidate.map(row => row.id)) === ids) ? candidates[0] : null;
}

// 输入按时间从旧到新排列。relative序号只是窗口位置，不是永久消息ID，也不是新消息水位。
// relative只有latestEndVerified明确为true、可信最新锚点仍重叠，才允许新增尾部消息自动回复。
// 稳定的初始空基线之后，首条还须处于已核实最新端且具有nativeId或可靠序号；否则保持ambiguous。
// 完全相同、没有nativeId的重复窗口无法证明发生过替换，不自动回复不可区分的重复消息。
export class MessageIdentityTracker {
  constructor() {
    this.windows = new Map(); this.known = new Map(); this.frontiers = new Map();
    this.snapshots = new Map(); this.nativeIds = new Map(); this.counters = new Map(); this.modes = new Map(); this.emptyBaselines = new Map(); this.latestWindows = new Map();
  }
  identify(conversationId, rows) {
    if (!Array.isArray(rows)) throw new TypeError('消息窗口须为数组。');
    const current = rows.map(row => ({ ...row, signature: messageFingerprint(row) }));
    const natives = current.map(nativeId).filter(Boolean);
    if (new Set(natives).size !== natives.length) throw new Error('网页消息身份重复，已停止自动回复以避免误判水位。');
    const relative = current.some(row => row.orderMode === 'relative');
    if (relative && current.some(row => row.orderMode !== 'relative')) throw new Error('同一消息窗口的顺序模式不一致，未判断新私信。');
    if (relative) {
      const orders = current.filter(reliableOrder).map(row => row.order);
      if (new Set(orders).size !== orders.length) throw new Error('网页消息身份重复，相对窗口序号不可唯一核对。');
    }
    const mode = current.length ? (relative ? 'relative' : 'absolute') : this.modes.get(conversationId);
    const modeChanged = current.length && this.modes.has(conversationId) && this.modes.get(conversationId) !== mode;
    const initialized = this.windows.has(conversationId) && !modeChanged;
    const previous = initialized ? this.windows.get(conversationId) : [];
    if (!this.windows.has(conversationId)) this.emptyBaselines.set(conversationId, current.length === 0);
    if (modeChanged) { this.known.delete(conversationId); this.frontiers.delete(conversationId); this.snapshots.delete(conversationId); this.latestWindows.delete(conversationId); this.emptyBaselines.set(conversationId, false); }
    const identified = mode === 'relative'
      ? this.identifyRelative(conversationId, current, previous, initialized)
      : this.identifyAbsolute(conversationId, current, previous, initialized);
    if (new Set(identified.map(row => row.id)).size !== identified.length) throw new Error('网页消息身份重复，已停止自动回复以避免误判水位。');
    this.windows.set(conversationId, identified);
    if (current.length) { this.modes.set(conversationId, mode); this.emptyBaselines.set(conversationId, false); }
    const nativeArchive = this.nativeIds.get(conversationId) ?? new Map();
    for (const row of identified) if (nativeId(row)) nativeArchive.set(nativeId(row), row.id);
    while (nativeArchive.size > 5000) nativeArchive.delete(nativeArchive.keys().next().value);
    this.nativeIds.set(conversationId, nativeArchive);
    if (mode === 'relative' && identified.length) {
      const snapshots = this.snapshots.get(conversationId) ?? [];
      const identities = JSON.stringify(identified.map(row => row.id));
      const prior = snapshots.findIndex(window => JSON.stringify(window.map(row => row.id)) === identities);
      if (prior >= 0) snapshots.splice(prior, 1);
      snapshots.push(identified);
      while (snapshots.length > 128 || (snapshots.length > 1 && snapshots.reduce((sum, window) => sum + window.length, 0) > 5000)) snapshots.shift();
      this.snapshots.set(conversationId, snapshots);
    }
    return identified.map(({ nativeId: _native, signature, fingerprint, ...row }) => row);
  }
  nativeIdentity(conversationId, row) {
    const value = nativeId(row);
    if (!value) return null;
    return this.nativeIds.get(conversationId)?.get(value) ?? `msg:${hash(JSON.stringify([conversationId, `native:${value}`]))}`;
  }
  allocate(conversationId, row) {
    const ordinal = (this.counters.get(conversationId) ?? 0) + 1;
    this.counters.set(conversationId, ordinal);
    return `msg:${hash(JSON.stringify([conversationId, 'relative-occurrence', ordinal, row.signature]))}`;
  }
  result(row, id, arrivalClassification, identitySource) {
    return { ...row, id, arrivalClassification, eligibleForReply: arrivalClassification === 'new-tail',
      unsupported: row.kind !== 'text' && !row.media, identitySource, displayTimeNotUsedForIdentity: true, sentAt: row.timestamp };
  }
  identifyRelative(conversationId, current, previous, initialized) {
    const latestVerified = current.length > 0 && current.every(row => row.latestEndVerified === true);
    const trusted = this.latestWindows.get(conversationId) ?? [];
    const trustedOverlap = initialized && trusted.length ? relativeOverlap(trusted, current) : null;
    const previousOverlap = initialized && previous.length ? relativeOverlap(previous, current) : null;
    const matched = new Map(), overlap = trustedOverlap ?? previousOverlap;
    if (overlap) {
      const reference = trustedOverlap ? trusted : previous;
      for (let offset = 0; offset < overlap.count; offset += 1) matched.set(overlap.currentStart + offset, reference[overlap.previousStart + offset]);
      // 重叠之前的消息可能是补载历史，只在前后两边均唯一时回用旧ID。
      let oldCursor = 0;
      for (let index = 0; index < overlap.currentStart; index += 1) {
        const row = current[index], candidates = previous.slice(0, overlap.previousStart).map((old, n) => n >= oldCursor && sameMessage(row, old) ? n : -1).filter(n => n >= 0);
        if (candidates.length === 1 && current.slice(0, overlap.currentStart).filter(item => sameMessage(item, row)).length === 1) {
          matched.set(index, previous[candidates[0]]); oldCursor = candidates[0] + 1;
        }
      }
      if (previousOverlap) {
        for (let offset = 0; offset < previousOverlap.count; offset += 1) {
          const index = previousOverlap.currentStart + offset;
          if (!matched.has(index)) matched.set(index, previous[previousOverlap.previousStart + offset]);
        }
      }
    } else if (initialized) {
      const known = knownWindow(this.snapshots.get(conversationId) ?? [], current);
      if (known) known.forEach((row, index) => matched.set(index, row));
    }
    const nativeArchive = this.nativeIds.get(conversationId) ?? new Map();
    const emptyFirst = initialized && !previous.length && this.emptyBaselines.get(conversationId) && latestVerified;
    const identified = current.map((row, index) => {
      const old = matched.get(index), knownNative = nativeId(row) && nativeArchive.has(nativeId(row));
      const id = old?.id ?? this.nativeIdentity(conversationId, row) ?? this.allocate(conversationId, row);
      let classification;
      if (!initialized) classification = 'baseline';
      else if (old || knownNative) classification = 'known-old-window';
      else if (!previous.length) classification = emptyFirst && (nativeId(row) || reliableOrder(row)) ? 'new-tail' : 'ambiguous-new';
      else if (overlap && index < overlap.currentStart) classification = 'old-history';
      else if (trustedOverlap && latestVerified && index > trustedOverlap.end && (nativeId(row) || reliableOrder(row))) classification = 'new-tail';
      else classification = 'ambiguous-new';
      return this.result(row, id, classification, nativeId(row) ? 'dom-message-id' : 'chronological-window-overlap');
    });
    // 陌生历史窗口不能替换此前可信的最新锚点，即使调用方误标了latestEndVerified。
    if (latestVerified && identified.length && (nativeId(identified.at(-1)) || reliableOrder(identified.at(-1)))
      && (!initialized || emptyFirst || trustedOverlap)) this.latestWindows.set(conversationId, identified);
    return identified;
  }
  identifyAbsolute(conversationId, current, previous, initialized) {
    // 兼容已有具有绝对序号的测试页和调用方；真实抖音页面必须明确标注relative。
    const archive = this.known.get(conversationId) ?? new Map(), frontier = this.frontiers.get(conversationId) ?? null;
    const matched = new Map(); let lastOld = -1;
    for (let index = 0; index < current.length; index += 1) {
      const row = current[index];
      let oldIndex = nativeId(row) ? previous.findIndex((old, n) => n > lastOld && nativeId(old) === nativeId(row)) : -1;
      if (oldIndex < 0) oldIndex = previous.findIndex((old, n) => n > lastOld && sameMessage(row, old) && old.order === row.order);
      if (oldIndex < 0) { const candidates = previous.map((old, n) => sameMessage(row, old) && n > lastOld ? n : -1).filter(n => n >= 0); if (candidates.length === 1) oldIndex = candidates[0]; }
      if (oldIndex >= 0) { matched.set(index, previous[oldIndex]); lastOld = oldIndex; }
    }
    const firstMatch = Math.min(Infinity, ...matched.keys());
    const insertedPrefix = firstMatch > 0 && firstMatch < Infinity && current.length > previous.length && current.slice(0, firstMatch).every(row => !previous.some(old => sameMessage(row, old)));
    if (insertedPrefix) {
      matched.clear(); let cursor = 0;
      for (let index = 0; index < current.length && cursor < previous.length; index += 1) if (sameMessage(current[index], previous[cursor])) { matched.set(index, previous[cursor]); cursor += 1; }
    }
    const lastMatch = Math.max(-1, ...matched.keys());
    const identified = current.map((row, index) => {
      const old = matched.get(index), fingerprint = nativeId(row) ? `native:${nativeId(row)}` : `content:${row.order ?? index}:${row.signature}`, known = archive.get(fingerprint);
      const appended = lastMatch >= 0 && index > lastMatch && ((reliableOrder(row) && frontier !== null && row.order > frontier) || Boolean(nativeId(row)));
      let classification;
      if (!initialized) classification = 'baseline';
      else if (old || known) classification = 'known-old-window';
      else if (!previous.length) classification = this.emptyBaselines.get(conversationId) && (nativeId(row) || reliableOrder(row)) ? 'new-tail' : 'ambiguous-new';
      else if (lastMatch >= 0 && index < lastMatch) classification = 'old-history';
      else if (reliableOrder(row) && frontier !== null && row.order <= frontier) classification = 'old-history';
      else if (appended) classification = 'new-tail';
      else classification = 'ambiguous-new';
      const id = old?.id ?? known?.id ?? this.nativeIdentity(conversationId, row) ?? `msg:${hash(JSON.stringify([conversationId, fingerprint]))}`;
      return { ...this.result(row, id, classification, nativeId(row) ? 'dom-message-id' : 'dom-order-content-fingerprint'), fingerprint };
    });
    for (const row of identified) archive.set(row.fingerprint, { id: row.id });
    while (archive.size > 5000) archive.delete(archive.keys().next().value);
    this.known.set(conversationId, archive);
    const orders = current.filter(reliableOrder).map(row => row.order);
    if (orders.length) this.frontiers.set(conversationId, Math.max(frontier ?? -1, ...orders));
    return identified;
  }
}
