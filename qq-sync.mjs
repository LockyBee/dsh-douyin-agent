import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SHARED_MEMORY_PATH = 'D:/codex分局/大肥鱼/memory/shared.sqlite';
const QQ_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '聊天机器人');
const LOCAL_TOOLS = ['read_workspace_file', 'list_workspace_files', 'write_workspace_file', 'run_workspace_command', 'manage_allowed_process', 'start_allowed_process', 'stop_tracked_process'];
const IMPORT_VERSION = 5;
const identityCaches = new Map();
export const MAX_SOURCE_MEMORY_REFS = 64;
const MAX_DEPENDENCY_DEPTH = 16;
const MAX_DEPENDENCY_NODES = 256;
const hash = value => createHash('sha256').update(value).digest('hex');
const secretKey = /cookie|token|secret|password|api[_-]?key|authorization|credential|session[_-]?id|sender[_-]?(?:id|name)|(?:qq|group|account|user)[_-]?id|(?:user|nick)[_-]?name|ownerQQ|qqnumber/i;

export function sharedMemoryPath() { return process.env.DEEPSEEK_SHARED_MEMORY_DB || DEFAULT_SHARED_MEMORY_PATH; }

export function scrubMemoryText(value) {
  return String(value ?? '')
    .replace(/\[CQ:[^\]\r\n]*\]/gi, '[附件或提及已隐藏]')
    .replace(/data:[^\s"'<>]+/gi, '[附件已隐藏]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '***')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer ***')
    .replace(/(\bcookie\s*["']?\s*[:=：]\s*)[^\r\n]+/gi, '$1***')
    .replace(/((?:access[_-]?token|api[_-]?key|console[_-]?token|token|password|secret|cookie|authorization|密码|口令)\s*["']?\s*[:=：]\s*["']?)[^\s,;，；"']+/gi, '$1***')
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>|;，；]+/g, '[本机路径已隐藏]')
    .replace(/\\\\[^\r\n"'<>|;，；]+/g, '[本机路径已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      try {
        const url = new URL(raw);
        if (/(?:^|\.)(?:qpic\.cn|qlogo\.cn|gtimg\.cn|multimedia\.nt\.qq\.com)$/.test(url.hostname)) return '[附件链接已隐藏]';
        url.username = ''; url.password = '';
        for (const key of [...url.searchParams.keys()]) if (/token|key|secret|sign|auth|cookie|ticket|session|credential|expires/i.test(key)) url.searchParams.set(key, '***');
        if (/token|key|secret|sign|auth|cookie|ticket|session/i.test(url.hash)) url.hash = '';
        return url.href;
      } catch { return '[无效链接]'; }
    })
    .replace(/\b\d{5,12}\b/g, '[号码已隐藏]');
}

/** 逐字符串清理，不对序列化后的 JSON 做替换。 */
export function scrubMetadataStrings(value) {
  const seen = new Set();
  const visit = (item, depth) => {
    if (depth > 20) throw new RangeError('metadata 嵌套过深');
    if (typeof item === 'string') return scrubMemoryText(item);
    if (item == null || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('metadata 数字必须有限');
      return item;
    }
    if (typeof item !== 'object') throw new TypeError('metadata 必须是 JSON 数据');
    if (seen.has(item)) throw new TypeError('metadata 不能循环引用');
    seen.add(item);
    let result;
    if (Array.isArray(item)) result = item.map(nested => visit(nested, depth + 1));
    else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new TypeError('metadata 必须是 JSON 对象');
      result = Object.fromEntries(Object.entries(item).filter(([key, nested]) => !secretKey.test(key) && nested !== undefined)
        .map(([key, nested]) => [scrubMemoryText(key), visit(nested, depth + 1)]));
    }
    seen.delete(item);
    return result;
  };
  return visit(value, 0);
}

export function openCentralDatabase(file = sharedMemoryPath()) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memory_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL,
        sources_json TEXT NOT NULL, video_id TEXT, url TEXT, author TEXT, title TEXT, metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, origin TEXT NOT NULL DEFAULT 'video',
        status TEXT NOT NULL DEFAULT 'recorded-note', external_key TEXT UNIQUE
      );
      CREATE TABLE IF NOT EXISTS qq_sync_state (
        namespace TEXT PRIMARY KEY, policy_hash TEXT NOT NULL, last_message_id INTEGER NOT NULL DEFAULT 0, synced_at INTEGER NOT NULL,
        last_reconciled_id INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS memory_dependencies (
        entry_id INTEGER NOT NULL, parent_id INTEGER NOT NULL, parent_updated_at INTEGER NOT NULL,
        PRIMARY KEY(entry_id,parent_id)
      );
      CREATE TABLE IF NOT EXISTS memory_source_times(entry_id INTEGER PRIMARY KEY,source_updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_dependency_parent ON memory_dependencies(parent_id);`);
    const columns = new Set(db.prepare('PRAGMA table_info(memory_entries)').all().map(row => row.name));
    for (const [column, declaration] of [['origin', "TEXT NOT NULL DEFAULT 'video'"], ['status', "TEXT NOT NULL DEFAULT 'recorded-note'"], ['external_key', 'TEXT']]) {
      if (!columns.has(column)) db.exec(`ALTER TABLE memory_entries ADD COLUMN ${column} ${declaration}`);
    }
    if (!db.prepare('PRAGMA table_info(qq_sync_state)').all().some(row => row.name === 'last_reconciled_id')) db.exec('ALTER TABLE qq_sync_state ADD COLUMN last_reconciled_id INTEGER NOT NULL DEFAULT 0');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS memory_external_key ON memory_entries(external_key);
      CREATE UNIQUE INDEX IF NOT EXISTS memory_video_id ON memory_entries(video_id) WHERE kind='video' AND video_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS memory_recent ON memory_entries(updated_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS memory_derived ON memory_entries(id)
        WHERE json_type(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,'$.sourceMemoryRefs')='array';`);
    const changed = ['kind', 'content', 'source', 'sources_json', 'video_id', 'url', 'author', 'title', 'created_at', 'origin', 'status', 'external_key']
      .map(column => `NEW.${column} IS NOT OLD.${column}`).join(' OR ') + ` OR
        json_remove(CASE WHEN json_valid(NEW.metadata_json) THEN NEW.metadata_json ELSE '{}' END,'$.sourceUpdatedAt')
        IS NOT json_remove(CASE WHEN json_valid(OLD.metadata_json) THEN OLD.metadata_json ELSE '{}' END,'$.sourceUpdatedAt')`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS memory_source_revision AFTER UPDATE ON memory_entries BEGIN
      UPDATE memory_entries SET updated_at=CASE WHEN (${changed}) THEN MAX(NEW.updated_at,OLD.updated_at+1)
        ELSE MAX(NEW.updated_at,OLD.updated_at) END WHERE id=NEW.id AND updated_at!=CASE WHEN (${changed})
        THEN MAX(NEW.updated_at,OLD.updated_at+1) ELSE MAX(NEW.updated_at,OLD.updated_at) END;
      DELETE FROM memory_entries WHERE id IN (SELECT entry_id FROM memory_dependencies WHERE parent_id=NEW.id
        AND parent_updated_at!=(SELECT updated_at FROM memory_entries WHERE id=NEW.id));
    END;
    CREATE TRIGGER IF NOT EXISTS memory_source_deleted AFTER DELETE ON memory_entries BEGIN
      DELETE FROM memory_entries WHERE id IN (SELECT entry_id FROM memory_dependencies WHERE parent_id=OLD.id);
      DELETE FROM memory_dependencies WHERE entry_id=OLD.id OR parent_id=OLD.id;
      DELETE FROM memory_source_times WHERE entry_id=OLD.id;
    END;`);
    return db;
  } catch (error) { db.close(); throw error; }
}

export function loadQQMemoryConfig(qqPath, configPath) {
  const file = configPath || path.join(path.dirname(path.dirname(qqPath)), 'config.yaml');
  if (!existsSync(file)) throw new Error('未找到 QQ 共享范围配置');
  let yaml;
  try { yaml = createRequire(import.meta.url)('yaml'); }
  catch { yaml = createRequire(path.join(QQ_ROOT, 'package.json'))('yaml'); }
  const config = yaml.parse(readFileSync(file, 'utf8'));
  if (!config || typeof config !== 'object') throw new Error('QQ 共享范围配置无效');
  return { ownerQQ: config.ownerQQ, memory: config.memory || {}, deny: config.deny || {}, allow: config.allow || {} };
}

function itemText(row) {
  let item;
  try { item = JSON.parse(row.content_json); } catch { return ''; }
  if (!item || item.role !== row.role || !['user', 'assistant'].includes(item.role)) return '';
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) return '';
  return item.content.filter(part => ['input_text', 'output_text', 'text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('\n');
}

function headerNames(text) {
  return [
    ...text.matchAll(/(?:^|\n)发送者：([^\n（]+)(?:（QQ\s*\d+）)?\n/g),
    ...text.matchAll(/(?:群聊旁听消息，|离线期间群聊记录[^\n]*?，)发送者\s*([^：\n（]+)(?:（QQ\s*\d+）)?：/g),
  ].map(match => match[1].trim()).filter(Boolean);
}

function anonymousCleaner(qqDb, tables, config, namespace) {
  let cache = identityCaches.get(namespace);
  const maxId = tables.has('messages') ? Number(qqDb.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages').get().id) : 0;
  if (!cache || maxId < cache.watermark) {
    cache = { identities: new Set(), watermark: 0 };
    if (identityCaches.size >= 100) identityCaches.delete(identityCaches.keys().next().value);
    identityCaches.set(namespace, cache);
  }
  const identities = cache.identities;
  const add = value => { if (value != null && String(value).trim()) identities.add(String(value).trim()); };
  add(config.ownerQQ);
  for (const row of qqDb.prepare('SELECT key FROM conversations').all()) add(String(row.key).split(':')[1]);
  if (tables.has('messages')) {
    for (const row of qqDb.prepare("SELECT id,sender_id,sender_name,role,CASE WHEN role='user' AND instr(content_json,'发送者')>0 THEN content_json ELSE NULL END AS content_json FROM messages WHERE id>? ORDER BY id").all(cache.watermark)) {
      add(row.sender_id); add(row.sender_name);
      for (const name of headerNames(itemText(row))) add(name);
      cache.watermark = Number(row.id);
    }
  }
  const escaped = [...identities].sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const patterns = [];
  for (let index = 0; index < escaped.length; index += 500) patterns.push(new RegExp(escaped.slice(index, index + 500).join('|'), 'g'));
  return value => {
    let text = String(value ?? '')
      .replace(/(?:^|\n)发送者：[^\n]*\n(?:消息：)?/g, '\n')
      .replace(/(?:群聊旁听消息，|离线期间群聊记录[^\n]*?，)发送者[^：\n]*：/g, '');
    for (const pattern of patterns) text = text.replace(pattern, '[身份已隐藏]');
    return scrubMemoryText(text).trim();
  };
}

function sourceTables(db) { return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)); }
function privacyMetadata(key) { return { sourceType: key.startsWith('private:') ? 'private' : 'group', ...(key.startsWith('private:') ? { privacy: 'internal-reference' } : {}) }; }

function privateMetadata(metadata) { return metadata.sourceType === 'private' || metadata.privacy === 'internal-reference'; }
function sourceReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(value.id) || value.id < 1 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) throw new TypeError('sourceMemoryRefs 必须包含有效 id 和 updatedAt');
  return { id: value.id, updatedAt: value.updatedAt };
}

/** 引用按中央行核对并展开到根来源；任何失效引用都会使整次保存失败。 */
export function resolveMemorySources(db, sourceMemoryRefs = [], { allowQQSources = true } = {}) {
  if (!Array.isArray(sourceMemoryRefs) || sourceMemoryRefs.length > MAX_SOURCE_MEMORY_REFS) throw new RangeError(`sourceMemoryRefs 最多 ${MAX_SOURCE_MEMORY_REFS} 项`);
  const get = db.prepare('SELECT * FROM memory_entries WHERE id=?');
  const roots = new Map(), cache = new Map();
  let nodes = 0, isPrivate = false, qqDerived = false;
  const visit = (raw, depth, ancestors) => {
    const ref = sourceReference(raw);
    if (depth > MAX_DEPENDENCY_DEPTH || ++nodes > MAX_DEPENDENCY_NODES) throw new RangeError('记忆来源层级或数量超过核对上限');
    if (ancestors.has(ref.id)) throw new Error('记忆来源不能循环引用');
    const cacheKey = `${ref.id}:${ref.updatedAt}`;
    if (cache.has(cacheKey)) return;
    const row = get.get(ref.id);
    if (!row || Number(row.updated_at) !== ref.updatedAt || !['confirmed', 'observed-history', 'recorded-note', 'observed-video'].includes(row.status)) throw new Error('记忆来源已失效或更新，请重新检索后保存');
    let metadata;
    try { metadata = JSON.parse(row.metadata_json); } catch { throw new Error('记忆来源元数据无效'); }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('记忆来源元数据无效');
    isPrivate ||= privateMetadata(metadata);
    const qq = ['qq', 'qq-history'].includes(row.origin);
    qqDerived ||= qq;
    if (qq && !allowQQSources) throw new Error('QQ 来源当前无法核对共享范围');
    const nested = metadata.sourceMemoryRefs;
    if (nested !== undefined && (!Array.isArray(nested) || nested.length > MAX_SOURCE_MEMORY_REFS)) throw new Error('记忆来源引用无效');
    if (metadata.derivedFromQQ === true && !nested?.length) throw new Error('QQ 派生记忆缺少来源引用');
    if (nested?.length) {
      const path = new Set(ancestors); path.add(ref.id);
      for (const child of nested) visit(child, depth + 1, path);
    } else {
      if (roots.has(ref.id) && roots.get(ref.id).updatedAt !== ref.updatedAt) throw new Error('记忆来源版本冲突');
      roots.set(ref.id, ref);
      if (roots.size > MAX_SOURCE_MEMORY_REFS) throw new RangeError(`sourceMemoryRefs 最多 ${MAX_SOURCE_MEMORY_REFS} 个根来源`);
    }
    cache.set(cacheKey, true);
  };
  for (const ref of sourceMemoryRefs) visit(ref, 0, new Set());
  return { refs: [...roots.values()].sort((a, b) => a.id - b.id), private: isPrivate, qqDerived };
}

export function sourceAwareEntry(db, row, { allowQQSources = true } = {}) {
  try {
    const result = resolveMemorySources(db, [{ id: Number(row.id), updatedAt: Number(row.updated_at) }], { allowQQSources });
    const item = centralEntry(row);
    if (['qq', 'qq-history'].includes(item.origin)) {
      const sourceTime = db.prepare('SELECT source_updated_at FROM memory_source_times WHERE entry_id=?').get(item.id);
      if (sourceTime) item.metadata.sourceUpdatedAt = Number(sourceTime.source_updated_at);
    }
    if (item.metadata.sourceMemoryRefs?.length) item.metadata.sourceMemoryRefs = result.refs;
    if (result.private) Object.assign(item.metadata, { sourceType: 'private', privacy: 'internal-reference' });
    if (item.metadata.sourceMemoryRefs?.length) item.metadata.derivedFromQQ = result.qqDerived;
    return item;
  } catch { return null; }
}

/** 在同一写事务中清理失效派生项。根展开有深度与数量上限，不会在循环中反复删除。 */
export function pruneDerivedMemories(db) {
  const before = Number(db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n);
  let removed = 0;
  const candidates = db.prepare(`SELECT * FROM memory_entries WHERE json_type(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END,'$.sourceMemoryRefs')='array'`).all();
  const remove = db.prepare('DELETE FROM memory_entries WHERE id=?');
  const removeDependencies = db.prepare('DELETE FROM memory_dependencies WHERE entry_id=?');
  const putDependency = db.prepare('INSERT INTO memory_dependencies(entry_id,parent_id,parent_updated_at) VALUES (?,?,?) ON CONFLICT(entry_id,parent_id) DO UPDATE SET parent_updated_at=excluded.parent_updated_at');
  for (const row of candidates) {
    const item = sourceAwareEntry(db, row);
    removeDependencies.run(row.id);
    if (!item) { removed += Number(remove.run(row.id).changes); continue; }
    for (const ref of item.metadata.sourceMemoryRefs || []) putDependency.run(row.id, ref.id, ref.updatedAt);
  }
  // 新版保存的引用已是根引用。补录旧链时，使用索引把刚删除的节点继续传播到子项。
  const invalid = db.prepare(`SELECT DISTINCT d.entry_id FROM memory_dependencies d LEFT JOIN memory_entries p ON p.id=d.parent_id
    WHERE p.id IS NULL OR p.updated_at!=d.parent_updated_at OR p.status NOT IN ('confirmed','observed-history','recorded-note','observed-video')`);
  for (let depth = 0; depth <= MAX_DEPENDENCY_DEPTH; depth += 1) {
    const rows = invalid.all();
    if (!rows.length) break;
    for (const row of rows) { removed += Number(remove.run(row.entry_id).changes); removeDependencies.run(row.entry_id); }
    if (depth === MAX_DEPENDENCY_DEPTH && invalid.all().length) throw new RangeError('记忆级联清理超过层级上限');
  }
  db.exec('DELETE FROM memory_dependencies WHERE entry_id NOT IN (SELECT id FROM memory_entries)');
  return before - Number(db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n);
}

/** 只读 QQ 源库，事务写入集中库。源行 ID 仅用于幂等，不保存身份、附件或完整协议对象。 */
export function syncQQToCentral({ qqDb, qqPath, config, centralDb, centralPath, batchSize = 500, maxBatches = 1, reconcileLimit = batchSize } = {}) {
  if (!qqPath || typeof qqPath !== 'string') throw new TypeError('同步需要 QQ 源库路径作为来源标识');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2_000 || !Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) throw new RangeError('同步批次超出范围');
  if (!Number.isInteger(reconcileLimit) || reconcileLimit < 1 || reconcileLimit > 2_000) throw new RangeError('核对批次超出范围');
  const ownSource = !qqDb;
  const ownDestination = !centralDb;
  let source = qqDb, dest = centralDb, transactionOpen = false;
  try {
    if (!source) {
      if (!existsSync(qqPath)) throw new Error('未找到 QQ 记忆库');
      source = new DatabaseSync(qqPath, { readOnly: true });
      source.exec('PRAGMA busy_timeout = 10000');
    }
    dest ||= openCentralDatabase(centralPath);
    dest.exec('BEGIN IMMEDIATE'); transactionOpen = true;
    if (ownSource) source.exec('BEGIN');
    else if (source.isTransaction === true || source.inTransaction === true) throw new Error('同步不能读取未提交的 QQ 来源事务');
    config ||= loadQQMemoryConfig(qqPath);
    const tables = sourceTables(source);
    if (!tables.has('conversations') || !tables.has('memories')) throw new Error('不支持的 QQ 记忆结构');
    const overrideRow = tables.has('runtime_settings') ? source.prepare("SELECT value_json FROM runtime_settings WHERE key='console-overrides'").get() : null;
    const overrides = overrideRow ? JSON.parse(overrideRow.value_json) : {};
    const shared = (overrides.memory?.shared ?? config.memory?.shared ?? false) === true;
    const deny = { groups: overrides.deny?.groups ?? config.deny?.groups ?? [], private: overrides.deny?.private ?? config.deny?.private ?? [] };
    if (![deny.groups ?? [], deny.private ?? []].every(Array.isArray)) throw new Error('QQ 共享范围配置无效');
    const denied = new Set([...(deny.groups || []).map(id => `group:${id}`), ...(deny.private || []).map(id => `private:${id}`)]);
    const keysSql = `SELECT key FROM conversations UNION SELECT conversation_key AS key FROM memories${tables.has('messages') ? ' UNION SELECT conversation_key AS key FROM messages' : ''}`;
    const allowedKeys = new Set(source.prepare(keysSql).all().map(row => row.key).filter(key => shared && /^(group|private):/.test(key) && !denied.has(key)));
    const namespace = `qq-${hash(path.resolve(qqPath).toLowerCase()).slice(0, 20)}`;
    const policyHash = hash(JSON.stringify({ version: IMPORT_VERSION, shared, allowedKeys: [...allowedKeys].sort() }));
    const clean = shared ? anonymousCleaner(source, tables, config, namespace) : value => scrubMemoryText(value);
    let processed = 0, imported = 0, updated = 0, removed = 0, pending = false, watermark = 0, confirmed = 0, reconciled = 0, reconciliationPending = false;
    const existing = dest.prepare('SELECT * FROM memory_entries WHERE external_key=?');
    const sourceTime = dest.prepare('SELECT source_updated_at FROM memory_source_times WHERE entry_id=?');
    const putSourceTime = dest.prepare('INSERT INTO memory_source_times(entry_id,source_updated_at) VALUES (?,?) ON CONFLICT(entry_id) DO UPDATE SET source_updated_at=excluded.source_updated_at');
    const remove = dest.prepare('DELETE FROM memory_entries WHERE external_key=?');
    const put = dest.prepare(`INSERT INTO memory_entries(kind,content,source,sources_json,video_id,url,author,title,metadata_json,created_at,updated_at,origin,status,external_key)
      VALUES (?,?,'qq','["qq"]',NULL,NULL,NULL,?,?,?,?,?,?,?) ON CONFLICT(external_key) DO UPDATE SET
      content=excluded.content,title=excluded.title,metadata_json=excluded.metadata_json,created_at=excluded.created_at,updated_at=excluded.updated_at,status=excluded.status`);
    const save = (kind, content, title, metadata, createdAt, updatedAt, origin, status, key) => {
      const old = existing.get(key), oldMetadata = old ? JSON.parse(old.metadata_json) : {};
      let adjustedMetadata = metadata;
      if (Object.hasOwn(oldMetadata, 'sourceUpdatedAt')) adjustedMetadata = { ...metadata, sourceUpdatedAt: updatedAt };
      let json = JSON.stringify(adjustedMetadata);
      const sourceUpdatedAt = old ? sourceTime.get(old.id)?.source_updated_at ?? oldMetadata.sourceUpdatedAt ?? old.updated_at : updatedAt;
      if (old && old.content === content && old.title === title && old.metadata_json === json && old.created_at === createdAt && sourceUpdatedAt === updatedAt && old.status === status) return;
      const revision = old ? Math.max(updatedAt, Number(old.updated_at) + 1) : updatedAt;
      if (revision !== updatedAt) json = JSON.stringify({ ...adjustedMetadata, sourceUpdatedAt: updatedAt });
      put.run(kind, content, title, json, createdAt, revision, origin, status, key);
      putSourceTime.run(existing.get(key).id, updatedAt);
      if (old) updated += 1; else imported += 1;
    };
    const hasMessages = tables.has('messages');
    const sourceRow = hasMessages ? source.prepare('SELECT id,conversation_key,sender_id,sender_name,role,content_json,created_at FROM messages WHERE id=?') : null;
    const readBatch = hasMessages ? source.prepare('SELECT id,conversation_key,sender_id,sender_name,role,content_json,created_at FROM messages WHERE id>? ORDER BY id LIMIT ?') : null;
    const turnBounds = hasMessages ? source.prepare(`SELECT
      COALESCE((SELECT MAX(id) FROM messages WHERE conversation_key=? AND role='user' AND id<=?),?) AS start,
      (SELECT MIN(id) FROM messages WHERE conversation_key=? AND role='user' AND id>?) AS end`) : null;
    const closedTurnRows = hasMessages ? source.prepare('SELECT id,role,content_json FROM messages WHERE conversation_key=? AND id>=? AND id<?') : null;
    const openTurnRows = hasMessages ? source.prepare('SELECT id,role,content_json FROM messages WHERE conversation_key=? AND id>=?') : null;
    const sensitiveCache = new Map();
    const getTurn = row => {
      const bounds = turnBounds.get(row.conversation_key, row.id, row.id, row.conversation_key, row.id);
      const key = `${row.conversation_key}:${bounds.start}:${bounds.end}`;
      if (!sensitiveCache.has(key)) {
        const rows = bounds.end == null ? openTurnRows.all(row.conversation_key, bounds.start) : closedTurnRows.all(row.conversation_key, bounds.start, bounds.end);
        const sensitive = rows.some(turn => {
          if (!['tool', 'assistant'].includes(turn.role)) return false;
          let item; try { item = JSON.parse(turn.content_json); } catch { return true; }
          const names = [item?.name, item?.function_call?.name, ...(Array.isArray(item?.tool_calls) ? item.tool_calls.map(call => call?.function?.name || call?.name) : [])];
          return names.some(name => LOCAL_TOOLS.includes(name));
        });
        sensitiveCache.set(key, { rows, sensitive, purged: false });
      }
      return sensitiveCache.get(key);
    };
    const purgeTurn = turn => {
      if (!turn.sensitive || turn.purged) return;
      for (const row of turn.rows) removed += Number(remove.run(`${namespace}:message:${row.id}`).changes);
      turn.purged = true;
    };
    const saveHistory = row => {
      const key = `${namespace}:message:${row.id}`;
      if (!allowedKeys.has(row.conversation_key) || !['user', 'assistant'].includes(row.role)) return false;
      const turn = getTurn(row);
      if (turn.sensitive) { purgeTurn(turn); return false; }
      const content = clean(itemText(row)).slice(0, 1_200);
      if (!content) return false;
      save('qq-history', content, null, { confirmed: false, inferred: false, isUserFact: false, role: row.role, ...privacyMetadata(row.conversation_key) }, row.created_at, row.created_at, 'qq-history', 'observed-history', key);
      return true;
    };
    try {
      const entriesBefore = Number(dest.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n);
      const state = dest.prepare('SELECT * FROM qq_sync_state WHERE namespace=?').get(namespace);
      watermark = Number(state?.last_message_id || 0);
      let reconcileCursor = Number(state?.last_reconciled_id || 0);
      const maxId = hasMessages ? Number(source.prepare('SELECT COALESCE(MAX(id),0) AS id FROM messages').get().id) : 0;
      if (state && (state.policy_hash !== policyHash || maxId < watermark)) {
        removed += Number(dest.prepare('DELETE FROM memory_entries WHERE external_key LIKE ?').run(`${namespace}:%`).changes);
        watermark = 0;
        reconcileCursor = 0;
      }
      const activeKeys = new Set();
      for (const row of source.prepare("SELECT id,conversation_key,subject,content,confidence,created_at,updated_at FROM memories WHERE status='active'").all()) {
        if (!allowedKeys.has(row.conversation_key)) continue;
        const key = `${namespace}:memory:${row.id}`, content = clean(row.content).slice(0, 1_200);
        if (!content) continue;
        activeKeys.add(key); confirmed += 1;
        save('qq-memory', content, clean(row.subject).slice(0, 256) || null, { confirmed: true, inferred: false, isUserFact: false, confidence: row.confidence, ...privacyMetadata(row.conversation_key) }, row.created_at, row.updated_at, 'qq', 'confirmed', key);
      }
      for (const row of dest.prepare('SELECT external_key FROM memory_entries WHERE external_key LIKE ?').all(`${namespace}:memory:%`)) {
        if (!activeKeys.has(row.external_key)) removed += Number(remove.run(row.external_key).changes);
      }
      // 旧历史按有限批次循环核对；新到的敏感工具另外立即撤除对应回合。
      const mirrored = dest.prepare('SELECT id,external_key FROM memory_entries WHERE id>? AND external_key LIKE ? ORDER BY id LIMIT ?').all(reconcileCursor, `${namespace}:message:%`, reconcileLimit);
      for (const row of mirrored) {
        reconciled += 1; reconcileCursor = Number(row.id);
        const original = sourceRow?.get(Number(row.external_key.split(':').at(-1)));
        if (!original || !saveHistory(original)) removed += Number(remove.run(row.external_key).changes);
      }
      reconciliationPending = Boolean(dest.prepare('SELECT id FROM memory_entries WHERE id>? AND external_key LIKE ? LIMIT 1').get(reconcileCursor, `${namespace}:message:%`));
      if (!reconciliationPending) reconcileCursor = 0;
      if (readBatch) for (let batch = 0; batch < maxBatches; batch += 1) {
        const rows = readBatch.all(watermark, batchSize);
        for (const row of rows) {
          watermark = Math.max(watermark, Number(row.id)); processed += 1;
          if (allowedKeys.has(row.conversation_key) && ['tool', 'assistant'].includes(row.role)) purgeTurn(getTurn(row));
          saveHistory(row);
        }
        if (rows.length < batchSize) break;
      }
      pending = hasMessages && Boolean(source.prepare('SELECT id FROM messages WHERE id>? LIMIT 1').get(watermark));
      dest.prepare(`INSERT INTO qq_sync_state(namespace,policy_hash,last_message_id,synced_at,last_reconciled_id) VALUES (?,?,?,?,?)
        ON CONFLICT(namespace) DO UPDATE SET policy_hash=excluded.policy_hash,last_message_id=excluded.last_message_id,synced_at=excluded.synced_at,last_reconciled_id=excluded.last_reconciled_id`)
        .run(namespace, policyHash, watermark, Date.now(), reconcileCursor);
      removed += pruneDerivedMemories(dest);
      removed = Math.max(removed, entriesBefore + imported - Number(dest.prepare('SELECT COUNT(*) AS n FROM memory_entries').get().n));
      dest.exec('COMMIT'); transactionOpen = false;
    } catch (error) { dest.exec('ROLLBACK'); transactionOpen = false; throw error; }
    return { processed, imported, updated, removed, watermark, pending, confirmed, shared, available: true, reconciled, reconciliationPending };
  } finally {
    if (transactionOpen) { try { dest.exec('ROLLBACK'); } catch {} }
    if (ownSource) source?.close();
    if (ownDestination) dest?.close();
  }
}

export function centralEntry(row) {
  return {
    id: Number(row.id), kind: row.kind, content: row.content, source: row.source,
    sources: JSON.parse(row.sources_json), origin: row.origin, status: row.status,
    videoId: row.video_id, url: row.url, author: row.author, title: row.title,
    metadata: JSON.parse(row.metadata_json), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function queryTerms(query) {
  const normalized = scrubMemoryText(query).replace(/\[[^\]]*已隐藏\]/g, ' ').replace(/\*{3}/g, '').toLowerCase().trim();
  const terms = new Set([normalized]);
  const stop = new Set(['记忆', '回忆', '记得', '之前', '什么', '哪个', '哪些', '一下', '相关', '内容', '帮我', '请问', '告诉', '说过', '关于', '有没有', '我在', '我们', '你们', '能否', '是否']);
  for (const span of normalized.match(/[\p{L}\p{N}]+/gu) || []) {
    if (span.length >= 2 && !stop.has(span)) terms.add(span);
    if (/\p{Script=Han}/u.test(span)) for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index <= span.length - size; index += 1) {
        const part = span.slice(index, index + size);
        if (!stop.has(part)) terms.add(part);
      }
    }
  }
  return [...terms].filter(term => term.length > 0 && !/已隐藏|^\[|^\]$/.test(term)).slice(0, 120);
}

/** 跨来源检索必须有查询词；结果不包含内部幂等键或源库路径。 */
export function recallCentralMemory({ centralDb, centralPath, query = '', limit = 10, kind, origins, allowQQSources = true } = {}) {
  if (typeof query !== 'string' || query.length > 200) throw new TypeError('query 必须是最多 200 字的字符串');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit 必须是 1–100 的整数');
  if (kind != null && (typeof kind !== 'string' || kind.length > 40)) throw new TypeError('kind 无效');
  if (origins != null && (!Array.isArray(origins) || !origins.every(origin => ['video', 'qq', 'qq-history'].includes(origin)))) throw new TypeError('origins 无效');
  if (!query.trim() || origins?.length === 0) return [];
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const own = !centralDb;
  if (own && !existsSync(centralPath || sharedMemoryPath())) return [];
  const db = centralDb || openCentralDatabase(centralPath);
  try {
    const clauses = [], args = [];
    if (kind) { clauses.push('kind=?'); args.push(kind); }
    if (origins) { clauses.push(`origin IN (${origins.map(() => '?').join(',')})`); args.push(...origins); }
    clauses.push(`(${terms.map(() => "instr(lower(content || ' ' || COALESCE(title,'') || ' ' || COALESCE(author,'')),?)>0").join(' OR ')})`);
    args.push(...terms);
    const rows = db.prepare(`SELECT * FROM memory_entries WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC,id DESC LIMIT 1000`).all(...args);
    const full = scrubMemoryText(query).toLowerCase();
    const ranked = rows.map(row => {
      const item = sourceAwareEntry(db, row, { allowQQSources });
      if (!item) return null;
      const haystack = `${row.content} ${row.title || ''} ${row.author || ''}`.toLowerCase();
      return { row, item, score: (haystack.includes(full) ? 50 : 0) + terms.reduce((sum, term) => sum + (haystack.includes(term) ? Math.min(term.length, 8) : 0), 0) };
    }).filter(Boolean).sort((a, b) => b.score - a.score || Number(b.row.updated_at) - Number(a.row.updated_at) || Number(b.row.id) - Number(a.row.id));
    return ranked.slice(0, limit).map(({ item }) => item);
  } finally { if (own) db.close(); }
}
