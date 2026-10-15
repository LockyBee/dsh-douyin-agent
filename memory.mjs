import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SHARED_MEMORY_PATH, sharedMemoryPath, openCentralDatabase, loadQQMemoryConfig, syncQQToCentral, recallCentralMemory, centralEntry, sourceAwareEntry, resolveMemorySources, MAX_SOURCE_MEMORY_REFS, scrubMemoryText, scrubMetadataStrings } from './qq-sync.mjs';

export const DEFAULT_MEMORY_PATH = DEFAULT_SHARED_MEMORY_PATH;
const QQ_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '聊天机器人');
export const DEFAULT_QQ_MEMORY_PATH = path.join(QQ_ROOT, 'state', 'bridge.db');
const MAX_CONTENT = 8_000;
const MAX_METADATA = 8_000;

function text(value, name, max, optional = false) {
  if (value == null && optional) return null;
  if (typeof value !== 'string') throw new TypeError(`${name} 必须是字符串`);
  const result = value.trim();
  if ((!result && !optional) || result.length > max) throw new RangeError(`${name} 长度必须在 ${optional ? 0 : 1}–${max} 之间`);
  return result || null;
}

function limitValue(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new RangeError('limit 必须是 1–100 的整数');
  return value;
}

function metadataValue(value = {}, observation = false) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('metadata 必须是对象');
  const result = scrubMetadataStrings({ ...value, confirmed: false, inferred: observation ? false : value.inferred !== false, isUserFact: false });
  if (JSON.stringify(result).length > MAX_METADATA) throw new RangeError('metadata 内容过长');
  return result;
}

function videoUrl(value, id = null) {
  if (!value && id && /^\d+$/.test(id)) return `https://www.douyin.com/video/${id}`;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !(url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))) return null;
    const found = /\/video\/(\d+)/.exec(url.pathname)?.[1] || url.searchParams.get('modal_id') || url.searchParams.get('aweme_id') || id;
    if (found && /^\d+$/.test(found)) return `https://www.douyin.com/video/${found}`;
    return `${url.origin}${url.pathname}`;
  } catch { return null; }
}

/** DSH、独立 API 与 QQ 共用集中库；QQ 资料经过授权范围核对后增量镜像。 */
export class MemoryStore {
  constructor(dbPath = sharedMemoryPath(), options = {}) {
    this.dbPath = dbPath;
    this.qqMemoryPath = options.qqMemoryPath === undefined ? DEFAULT_QQ_MEMORY_PATH : options.qqMemoryPath;
    this.qqConfigPath = options.qqConfigPath ?? (this.qqMemoryPath ? path.join(path.dirname(path.dirname(this.qqMemoryPath)), 'config.yaml') : null);
    this.qqConfig = options.qqConfig;
    this.trackRecallSources = options.trackRecallSources !== false;
    this.recalledSources = new Map();
    this.recalledSourcesOverflow = false;
    this.qqConnection = { available: false, note: '尚未核对 QQ 共享记忆。' };
    this.db = openCentralDatabase(dbPath);
    try {
      this.insert = this.db.prepare(`INSERT INTO memory_entries(kind,content,source,sources_json,video_id,url,author,title,metadata_json,created_at,updated_at,origin,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'video',?)`);
      this.byId = this.db.prepare('SELECT * FROM memory_entries WHERE id = ?');
      this.byVideo = this.db.prepare("SELECT * FROM memory_entries WHERE origin='video' AND kind='video' AND video_id=?");
      this.updateVideo = this.db.prepare(`UPDATE memory_entries SET content=?,source=?,sources_json=?,url=?,author=?,title=?,metadata_json=?,updated_at=?,status=? WHERE id=?`);
      this.recent = this.db.prepare("SELECT * FROM memory_entries WHERE origin='video' AND (? IS NULL OR kind=?) ORDER BY updated_at DESC,id DESC LIMIT ?");
      this.clearDependencies = this.db.prepare('DELETE FROM memory_dependencies WHERE entry_id=?');
      this.putDependency = this.db.prepare('INSERT INTO memory_dependencies(entry_id,parent_id,parent_updated_at) VALUES (?,?,?)');
    } catch (error) { this.db.close(); throw error; }
  }

  remember({ kind = 'note', content, source = 'api', videoId, url, author, title, metadata } = {}) {
    if (this.recalledSourcesOverflow) throw new RangeError(`已读取的记忆来源超过 ${MAX_SOURCE_MEMORY_REFS} 项，请在新会话中重新检索后保存`);
    const normalizedMetadata = metadataValue(metadata);
    const explicitRefs = normalizedMetadata.sourceMemoryRefs;
    if (explicitRefs !== undefined && !Array.isArray(explicitRefs)) throw new TypeError('sourceMemoryRefs 必须是数组');
    const refs = [...this.recalledSources.values(), ...(explicitRefs || [])];
    const unique = new Map();
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object') throw new TypeError('sourceMemoryRefs 无效');
      unique.set(`${ref.id}:${ref.updatedAt}`, ref);
    }
    if (unique.size) normalizedMetadata.sourceMemoryRefs = [...unique.values()];
    return this.write({
      kind: scrubMemoryText(text(kind, 'kind', 40)), content: scrubMemoryText(text(content, 'content', MAX_CONTENT)), source: scrubMemoryText(text(source, 'source', 64)),
      videoId: text(videoId, 'videoId', 128, true), url: videoUrl(text(url, 'url', 2_048, true)),
      author: scrubMemoryText(text(author, 'author', 256, true)) || null, title: scrubMemoryText(text(title, 'title', 1_000, true)) || null,
      metadata: normalizedMetadata, status: 'recorded-note',
    });
  }

  write(item) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = item.kind === 'video' && item.videoId ? this.byVideo.get(item.videoId) : null;
      const now = old ? Math.max(Date.now(), Number(old.updated_at) + 1) : Date.now();
      const oldMetadata = old ? JSON.parse(old.metadata_json) : {};
      const mergedMetadata = { ...oldMetadata, ...item.metadata };
      const refs = [...(oldMetadata.sourceMemoryRefs || []), ...(item.metadata.sourceMemoryRefs || [])];
      const unique = new Map();
      for (const ref of refs) unique.set(`${ref.id}:${ref.updatedAt}`, ref);
      const resolved = resolveMemorySources(this.db, [...unique.values()]);
      if (resolved.refs.length) mergedMetadata.sourceMemoryRefs = resolved.refs;
      else delete mergedMetadata.sourceMemoryRefs;
      mergedMetadata.derivedFromQQ = resolved.qqDerived;
      if (resolved.private || oldMetadata.sourceType === 'private' || oldMetadata.privacy === 'internal-reference' || item.metadata.sourceType === 'private' || item.metadata.privacy === 'internal-reference') Object.assign(mergedMetadata, { sourceType: 'private', privacy: 'internal-reference' });
      if (JSON.stringify(mergedMetadata).length > MAX_METADATA) throw new RangeError('metadata 内容过长');
      let id;
      if (old) {
        const sources = [...new Set([...JSON.parse(old.sources_json), item.source])];
        this.updateVideo.run(item.content, item.source, JSON.stringify(sources), item.url || old.url, item.author || old.author,
          item.title || old.title, JSON.stringify(mergedMetadata), now, item.status, old.id);
        id = old.id;
      } else {
        id = this.insert.run(item.kind, item.content, item.source, JSON.stringify([item.source]), item.videoId,
          item.url, item.author, item.title, JSON.stringify(mergedMetadata), now, now, item.status).lastInsertRowid;
      }
      this.clearDependencies.run(id);
      for (const ref of resolved.refs) this.putDependency.run(id, ref.id, ref.updatedAt);
      const saved = centralEntry(this.byId.get(id));
      this.db.exec('COMMIT');
      return saved;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  syncQQ(options = {}) {
    if (!this.qqMemoryPath || !existsSync(this.qqMemoryPath)) {
      this.qqConnection = { available: false, note: '未找到 QQ 记忆库；视频记忆仍可使用。' };
      return { ...this.qqConnection, processed: 0, imported: 0, updated: 0, removed: 0, pending: false };
    }
    try {
      const config = this.qqConfig || loadQQMemoryConfig(this.qqMemoryPath, this.qqConfigPath);
      const result = syncQQToCentral({ qqPath: this.qqMemoryPath, config, centralDb: this.db, ...options });
      this.qqConnection = { ...result, note: result.shared
        ? '已连接 QQ；确认记忆与相关历史保留不同标记，历史仅随查询返回。'
        : 'QQ 已关闭跨应用共享，对应镜像已撤除。' };
      return this.qqConnection;
    } catch {
      this.qqConnection = { available: false, note: 'QQ 共享范围暂时不可核对；本次不返回 QQ 记忆。' };
      return { ...this.qqConnection, processed: 0, imported: 0, updated: 0, removed: 0, pending: false };
    }
  }

  recall({ query = '', limit = 10, kind } = {}) {
    const normalizedQuery = text(query, 'query', 200, true) || '';
    const normalizedKind = text(kind, 'kind', 40, true);
    limitValue(limit);
    const qq = this.syncQQ();
    const entries = normalizedQuery
      ? recallCentralMemory({ centralDb: this.db, query: normalizedQuery, limit, kind: normalizedKind, origins: qq.available && qq.shared ? ['video', 'qq', 'qq-history'] : ['video'], allowQQSources: qq.available && qq.shared })
      : this.recent.all(normalizedKind, normalizedKind, limit).map(row => sourceAwareEntry(this.db, row, { allowQQSources: qq.available && qq.shared })).filter(Boolean);
    if (this.trackRecallSources) for (const item of entries) {
      let refs = item.metadata.sourceMemoryRefs || [];
      if (['qq', 'qq-history'].includes(item.origin) || item.metadata.sourceType === 'private' || item.metadata.privacy === 'internal-reference') refs = refs.length ? refs : [{ id: item.id, updatedAt: item.updatedAt }];
      for (const ref of refs) {
        const key = `${ref.id}:${ref.updatedAt}`;
        if (!this.recalledSources.has(key) && this.recalledSources.size >= MAX_SOURCE_MEMORY_REFS) this.recalledSourcesOverflow = true;
        else this.recalledSources.set(key, { id: ref.id, updatedAt: ref.updatedAt });
      }
    }
    return { entries, connections: { qq: this.qqConnection, video: { available: true } } };
  }

  recordVideo(observation, source = 'api') {
    if (!observation || typeof observation !== 'object' || !observation.video || typeof observation.video !== 'object') return null;
    const video = observation.video;
    const url = videoUrl(video.url || observation.url, video.id == null ? null : String(video.id));
    const id = video.id == null ? /\/video\/(\d+)/.exec(url || '')?.[1] : String(video.id);
    if (!id || !/^\d{1,64}$/.test(id)) return null;
    const title = typeof video.title === 'string' ? scrubMemoryText(video.title.trim().slice(0, 1_000)) : '';
    const author = typeof video.author === 'string' ? scrubMemoryText(video.author.trim().slice(0, 256)) : '';
    if (!title && !author) return null;
    const metadata = { observedAt: Date.now(), observationOnly: true };
    for (const field of ['time', 'duration']) if (typeof video[field] === 'number' && Number.isFinite(video[field]) && video[field] >= 0) metadata[field] = video[field];
    if (typeof video.paused === 'boolean') metadata.paused = video.paused;
    return this.write({ kind: 'video', content: [title, author ? `作者：${author}` : ''].filter(Boolean).join('\n'),
      source: scrubMemoryText(text(source, 'source', 64)), videoId: id, url: url || videoUrl(null, id), author: author || null, title: title || null,
      metadata: metadataValue(metadata, true), status: 'observed-video' });
  }

  close() { this.db.close(); }
}
