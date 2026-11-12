import { createHash } from 'node:crypto';
import { createAccessView } from './memory-policy.mjs';

const MAX_SCAN = 200;
const CURSOR_RESERVE = 320;
const PLATFORMS = new Set(['qq', 'douyin', 'dsh']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const named = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/u.test(value);
const time = value => Number.isSafeInteger(value) && value >= 0;

function scopeContext(context) {
  if (!context || !PLATFORMS.has(context.platform) || !named(context.conversationId) || typeof context.isGroup !== 'boolean' || typeof context.sharedEnabled !== 'boolean') {
    throw new TypeError('原文回溯需要已核对的平台、会话标识、会话类型和共享开关。');
  }
  if (context.subjectId !== undefined && !named(context.subjectId)) throw new TypeError('当前主体标识无效。');
  const links = (Array.isArray(context.verifiedLinks) ? context.verifiedLinks : []).filter(link =>
    link?.verified === true && link.isGroup !== false && PLATFORMS.has(link.platform) && named(link.conversationId) && named(link.proofId) && named(context.subjectId) && link.subjectId === context.subjectId
  ).map(link => ({ platform: link.platform, conversationId: link.conversationId, subjectId: link.subjectId, proofId: link.proofId }));
  links.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  return { ...context, links, fingerprint: digest([context.platform, context.conversationId, context.isGroup, context.sharedEnabled, context.subjectId ?? null, links]) };
}

function conversationMatches(record, context) {
  const scope = record.scope;
  if (!scope || !PLATFORMS.has(scope.platform) || !named(scope.conversationId) || typeof scope.isGroup !== 'boolean') return false;
  if (scope.platform === context.platform && scope.conversationId === context.conversationId && scope.isGroup === context.isGroup) return true;
  if (!context.sharedEnabled || !context.isGroup || !scope.isGroup || record.metadata?.sourceType === 'private' || record.metadata?.privacy === 'internal-reference' || String(record.metadata?.visibility || '').startsWith('private')) return false;
  return context.links.some(link => link.platform === scope.platform && link.conversationId === scope.conversationId);
}

function original(record) {
  if (['summary', 'diary', 'index'].includes(record.kind) || record.metadata?.summary === true || record.metadata?.isSummary === true) return null;
  if (!(record.kind === 'history' || record.origin === 'qq-history') || !['user', 'assistant'].includes(record.metadata?.role) || typeof record.content !== 'string' || !record.content.trim()) return null;
  if (!(typeof record.id === 'string' && named(record.id) || Number.isSafeInteger(record.id) && record.id >= 0) || !time(record.updatedAt) || !time(record.createdAt) || !named(record.origin)) return null;
  return {
    id: record.id, updatedAt: record.updatedAt, createdAt: record.createdAt, origin: record.origin,
    role: record.metadata.role, content: record.content,
    ...(typeof record.metadata.speaker==='string'&&record.metadata.speaker.length<=80?{speaker:record.metadata.speaker}:{}),
    source: { platform: record.scope.platform, conversationId: record.scope.conversationId, isGroup: record.scope.isGroup },
  };
}

function tie(record) { return digest([typeof record.id, record.id, record.origin, record.scope]); }
function encodeCursor(context, boundary) {
  return Buffer.from(JSON.stringify({ v: 1, c: context.fingerprint, t: boundary.createdAt, k: boundary.key })).toString('base64url');
}
function decodeCursor(cursor, context) {
  if (typeof cursor !== 'string' || cursor.length > CURSOR_RESERVE || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new TypeError('原文分页游标无效。');
  let value;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    value = JSON.parse(bytes.toString('utf8'));
  } catch { throw new TypeError('原文分页游标无效。'); }
  if (value?.v !== 1 || value.c !== context.fingerprint || !time(value.t) || typeof value.k !== 'string' || !/^[a-f0-9]{64}$/u.test(value.k)) throw new TypeError('原文分页游标与当前会话或许可不符。');
  return value;
}

/** 按原始消息时间向前分页。游标只定位，权限与来源链在每次调用时重新核对。 */
export function recallConversationHistory({ records, context, before, cursor, limit = 12, maxChars = 3000 } = {}) {
  const checked = scopeContext(context);
  if (!Array.isArray(records)) throw new TypeError('原文记录必须是数组。');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('原文回溯每页需要 1 至 50 条。');
  if (!Number.isInteger(maxChars) || maxChars < 512 || maxChars > 20000) throw new RangeError('原文回溯预算需要 512 至 20000 个字符。');
  if (before !== undefined && !time(before)) throw new TypeError('before 必须是非负整数时间戳。');
  if (before !== undefined && cursor !== undefined) throw new TypeError('before 和 cursor 不能同时使用。');
  const boundary = cursor === undefined ? null : decodeCursor(cursor, checked);
  const view = createAccessView(records, context);
  const seen = new Set();
  const rows = view.records.filter(record => conversationMatches(record, checked)).map(record => ({ record, quote: original(record), key: tie(record), createdAt: record.createdAt }))
    .filter(row => row.quote && (before === undefined || row.createdAt < before) && (!boundary || row.createdAt < boundary.t || row.createdAt === boundary.t && row.key < boundary.k))
    .sort((a, b) => b.createdAt - a.createdAt || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
    .filter(row => { const key = `${row.key}:${row.record.updatedAt}`; if (seen.has(key)) return false; seen.add(key); return true; });
  const entries = [];
  let scanned = 0, omitted = 0;
  // 固定预留游标和计数字段，保证整个返回 JSON 也在预算内。
  const fits = values => JSON.stringify({ entries: values, nextCursor: 'x'.repeat(CURSOR_RESERVE), hasMore: true, truncated: true, omitted: MAX_SCAN, scanned: MAX_SCAN }).length <= maxChars;
  while (scanned < rows.length && scanned < MAX_SCAN && entries.length < limit) {
    const item = rows[scanned].quote;
    if (fits([...entries, item])) { entries.push(item); scanned++; }
    else if (!entries.length) { omitted++; scanned++; }
    else break;
  }
  const hasMore = scanned < rows.length;
  return { entries, nextCursor: hasMore && scanned ? encodeCursor(checked, rows[scanned - 1]) : null,
    hasMore, truncated: hasMore || omitted > 0, omitted, scanned };
}
