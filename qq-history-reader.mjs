import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scrubMemoryText } from './qq-sync.mjs';
import { validateMemoryContext, validScope, sameScope, mappedScope } from './memory-policy.mjs';

const WINDOW = 200, TURN_ROWS = 128, RAW_CHARS = 65536, CURSOR_CHARS = 320;
const LOCAL_TOOLS = new Set(['read_workspace_file', 'list_workspace_files', 'write_workspace_file', 'run_workspace_command', 'manage_allowed_process', 'start_allowed_process', 'stop_tracked_process']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

function empty(reason, sharedEnabled = false) {
  return { entries: [], nextCursor: null, hasMore: false, truncated: false, omitted: 0, scanned: 0, sharedEnabled, reason };
}

function effectivePolicy(db, loadPolicy) {
  const config = loadPolicy();
  if (!plain(config)) throw new Error();
  const row = db.prepare("SELECT value_json FROM runtime_settings WHERE key='console-overrides'").get();
  const override = row ? JSON.parse(row.value_json) : {};
  if (!plain(override)) throw new Error();
  if ([config, override].some(value => value.memory !== undefined && !plain(value.memory) || value.deny !== undefined && !plain(value.deny))) throw new Error();
  const shared = override.memory?.shared ?? config.memory?.shared ?? false;
  if (typeof shared !== 'boolean') throw new Error();
  const groups = override.deny?.groups ?? config.deny?.groups ?? [], privateIds = override.deny?.private ?? config.deny?.private ?? [];
  if (![groups, privateIds].every(values => Array.isArray(values) && values.length <= 10000 && values.every(value => /^(?:0|[1-9]\d{0,19})$/u.test(String(value))))) throw new Error();
  return { shared, denied: new Set([...groups.map(id => `group:${id}`), ...privateIds.map(id => `private:${id}`)]), ownerQQ: config.ownerQQ };
}

function parsed(row) {
  if (typeof row.content_json !== 'string') return null;
  let value; try { value = JSON.parse(row.content_json); } catch { return null; }
  return plain(value) && value.role === row.role ? value : null;
}

function textBody(row) {
  const value = parsed(row);
  if (!value || !['user', 'assistant'].includes(row.role)) return null;
  if (typeof value.content === 'string') return { text: value.content, textOnly: true };
  if (!Array.isArray(value.content) || value.content.length > 128) return null;
  const parts = []; let textOnly = true;
  for (const part of value.content) {
    if (plain(part) && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string') parts.push(part.text);
    else if (plain(part) && ['image_url', 'input_image', 'input_audio', 'audio'].includes(part.type)) textOnly = false;
    else return null;
  }
  return { text: parts.join('\n'), textOnly };
}

function cleanOriginal(text, identities) {
  let value = text.replace(/(?:^|\n)发送者：[^\n]*\n(?:消息：)?/gu, '\n')
    .replace(/(?:群聊旁听消息，|离线期间群聊记录[^\n]*?，)发送者[^：\n]*：/gu, '');
  for (const identity of identities) {
    const name = String(identity ?? '').trim();
    if (name) value = value.split(name).join('[身份已隐藏]');
  }
  return scrubMemoryText(value);
}

function boundaryCursor(fingerprint, row) {
  return Buffer.from(JSON.stringify({ v: 1, c: fingerprint, t: row.created_at, i: row.id })).toString('base64url');
}
function cursorValue(cursor, fingerprint) {
  if (typeof cursor !== 'string' || cursor.length > CURSOR_CHARS || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new TypeError('QQ 原文分页游标无效。');
  let value;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    value = JSON.parse(bytes.toString('utf8'));
  } catch { throw new TypeError('QQ 原文分页游标无效。'); }
  if (value?.v !== 1 || value.c !== fingerprint || !timestamp(value.t) || !Number.isSafeInteger(value.i) || value.i < 1) throw new TypeError('QQ 原文分页游标与当前会话不符。');
  return value;
}

/** 只接受可信宿主提供的路径、会话映射和配置读取器；不发现数据库，也不写源数据库。 */
export function readQQConversationHistory({ qqPath, context, scope = context, resolveConversationKey, loadPolicy, before, cursor, limit = 12, maxChars = 3000 } = {}) {
  validateMemoryContext(context);
  if (!validScope(scope) || scope.platform !== 'qq') throw new TypeError('QQ 原文读取需要可信 QQ 会话范围。');
  if (typeof qqPath !== 'string' || !path.isAbsolute(qqPath) || /[\u0000\r\n]/u.test(qqPath)) throw new TypeError('QQ 原文读取需要显式绝对路径。');
  if (typeof resolveConversationKey !== 'function' || typeof loadPolicy !== 'function') throw new TypeError('QQ 原文读取需要可信会话映射与配置读取器。');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(maxChars) || maxChars < 512 || maxChars > 20000) throw new RangeError('QQ 原文分页或字符预算超出范围。');
  if (before !== undefined && !timestamp(before) || before !== undefined && cursor !== undefined) throw new TypeError('QQ 原文 before 无效，或与 cursor 同时提供。');
  const local = sameScope(scope, context);
  if (!local && !(scope.isGroup === true && context.isGroup === true && mappedScope(scope, context))) return empty('scope-denied');
  const sourceScope = { platform: scope.platform, conversationId: scope.conversationId, isGroup: scope.isGroup };
  let key;
  try { key = resolveConversationKey(sourceScope); }
  catch { throw new TypeError('可信 QQ 会话映射暂不可用。'); }
  if (typeof key !== 'string' || !/^(group|private):[1-9]\d{0,19}$/u.test(key) || key.startsWith('group:') !== scope.isGroup) throw new TypeError('可信 QQ 会话映射未返回匹配的源会话。');
  const namespace = hash(path.resolve(qqPath).toLowerCase());
  const fingerprint = hash([namespace, key, sourceScope, context.platform, context.conversationId, context.isGroup, context.subjectId ?? null]);
  const boundary = cursor === undefined ? null : cursorValue(cursor, fingerprint);
  let db;
  try {
    const stat = lstatSync(qqPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    db = new DatabaseSync(qqPath, { readOnly: true });
    db.exec('PRAGMA query_only = ON'); db.exec('PRAGMA busy_timeout = 1000'); db.exec('BEGIN');
    const policy = effectivePolicy(db, loadPolicy);
    if (policy.denied.has(key)) return empty('source-denied', policy.shared);
    if (!local && !policy.shared) return empty('shared-off', false);
    const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(row => row.name));
    if (!['id', 'conversation_key', 'role', 'content_json', 'created_at'].every(name => columns.has(name))) throw new Error();
    const projection = `id,role,created_at,${columns.has('updated_at') ? 'updated_at' : 'created_at AS updated_at'},${columns.has('sender_id') ? 'CASE WHEN length(sender_id)<=128 THEN sender_id ELSE NULL END AS sender_id' : 'NULL AS sender_id'},${columns.has('sender_name') ? 'CASE WHEN length(sender_name)<=256 THEN sender_name ELSE NULL END AS sender_name' : 'NULL AS sender_name'},CASE WHEN length(content_json)<=${RAW_CHARS} THEN content_json ELSE NULL END AS content_json`;
    const clauses = ["conversation_key=?", "role IN ('user','assistant')", 'created_at>=0'], args = [key];
    if (before !== undefined) { clauses.push('created_at<?'); args.push(before); }
    if (boundary) { clauses.push('(created_at<? OR (created_at=? AND id<?))'); args.push(boundary.t, boundary.t, boundary.i); }
    const candidates = db.prepare(`SELECT ${projection} FROM messages WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ${WINDOW + 1}`).all(...args);
    const rows = candidates.slice(0, WINDOW), moreInSource = candidates.length > WINDOW;
    const bounds = db.prepare(`SELECT COALESCE((SELECT MAX(id) FROM messages WHERE conversation_key=? AND role='user' AND id<=?),?) AS start,
      (SELECT MIN(id) FROM messages WHERE conversation_key=? AND role='user' AND id>?) AS end`);
    const turn = db.prepare(`SELECT ${projection} FROM messages WHERE conversation_key=? AND id>=? AND (? IS NULL OR id<?) ORDER BY id LIMIT ${TURN_ROWS + 1}`);
    const turns = new Map();
    function inspect(row) {
      const range = bounds.get(key, row.id, row.id, key, row.id), cacheKey = `${range.start}:${range.end}`;
      if (turns.has(cacheKey)) return turns.get(cacheKey);
      const messages = turn.all(key, range.start, range.end, range.end), identities = new Set([policy.ownerQQ, key.split(':')[1]]);
      let sensitive = messages.length > TURN_ROWS;
      for (const item of messages) {
        identities.add(item.sender_id); identities.add(item.sender_name);
        const value = parsed(item);
        if (!value || !['user', 'assistant'].includes(item.role)) { sensitive = true; continue; }
        const names = [value.name, value.function_call?.name, ...(Array.isArray(value.tool_calls) ? value.tool_calls.map(call => call?.function?.name || call?.name) : [])].filter(Boolean);
        if (names.some(name => LOCAL_TOOLS.has(name)) || item.role === 'assistant' && (names.length || value.tool_calls !== undefined || value.function_call !== undefined)) sensitive = true;
      }
      const result = { sensitive, identities: [...identities].filter(value => value != null).sort((a, b) => String(b).length - String(a).length) };
      turns.set(cacheKey, result); return result;
    }
    const entries = [];
    let scanned = 0, omitted = 0;
    const fits = values => JSON.stringify({ entries: values, nextCursor: 'x'.repeat(CURSOR_CHARS), hasMore: true, truncated: true, omitted: WINDOW, scanned: WINDOW, sharedEnabled: policy.shared, reason: 'ok' }).length <= maxChars;
    while (scanned < rows.length && entries.length < limit) {
      const row = rows[scanned], checked = inspect(row), body = checked.sensitive ? null : textBody(row);
      const content = body ? cleanOriginal(body.text, checked.identities) : '';
      if (!body || !content.trim() || body.text.length > 8000 || content.length > 8000 || !timestamp(row.created_at) || !timestamp(row.updated_at)) { omitted++; scanned++; continue; }
      const entry = { id: `qqraw:${hash([namespace, key, row.id])}`, updatedAt: row.updated_at, createdAt: row.created_at, origin: 'qq-history', role: row.role,
        content, source: sourceScope, sourceRevision: hash([row.id, row.role, row.content_json, row.created_at, row.updated_at, row.sender_id, row.sender_name]),
        contentTreatment: 'redacted-original', complete: true, textOnly: body.textOnly };
      if (fits([...entries, entry])) { entries.push(entry); scanned++; }
      else if (!entries.length) { omitted++; scanned++; }
      else break;
    }
    const hasMore = scanned < rows.length || moreInSource;
    return { entries, nextCursor: hasMore && scanned ? boundaryCursor(fingerprint, rows[scanned - 1]) : null, hasMore,
      truncated: hasMore || omitted > 0, omitted, scanned, sharedEnabled: policy.shared, reason: 'ok' };
  } catch { throw new Error('QQ 原文只读读取失败，未返回历史。'); }
  finally { if (db) { try { db.exec('ROLLBACK'); } catch {} db.close(); } }
}
