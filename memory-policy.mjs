// 本模块的 context 只接受可信宿主解析的会话资料，不能直接使用聊天正文或模型参数。
export const MAX_MEMORY_RECORDS = 5000;
const ACTIVE = new Set(['confirmed', 'observed-history', 'recorded-note', 'observed-video']);
const PLATFORMS = new Set(['qq', 'douyin', 'dsh']);
const opaque = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
export const recordKey = id => Number.isSafeInteger(id) && id > 0 ? `n:${id}` : opaque(id) ? `s:${id}` : null;
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
export function validScope(scope) {
  return !!scope && PLATFORMS.has(scope.platform) && opaque(scope.conversationId) && typeof scope.isGroup === 'boolean';
}
export function sameScope(a, b) {
  return validScope(a) && validScope(b) && a.platform === b.platform && a.conversationId === b.conversationId && a.isGroup === b.isGroup;
}
export function validateMemoryContext(context) {
  if (!validScope(context) || typeof context.sharedEnabled !== 'boolean' || context.subjectId !== undefined && !opaque(context.subjectId)) throw new TypeError('需要可信宿主提供完整会话范围与共享开关。');
  if (context.verifiedLinks !== undefined && (!Array.isArray(context.verifiedLinks) || context.verifiedLinks.length > 32)) throw new TypeError('可信身份映射最多32项。');
  return context;
}
function privateRecord(record) {
  const m = record.metadata || {};
  return record.scope?.isGroup === false || m.sourceType === 'private' || m.privacy === 'internal-reference' || String(m.visibility || '').startsWith('private');
}
export function mappedScope(scope, context) {
  if (!validScope(scope) || scope.isGroup !== true || context.isGroup !== true || context.sharedEnabled !== true || !opaque(context.subjectId)) return false;
  return (context.verifiedLinks || []).some(link => link?.verified === true && opaque(link.proofId) && link.subjectId === context.subjectId && link.platform === scope.platform && link.conversationId === scope.conversationId && link.isGroup !== false);
}
function allowed(record, context) {
  const m = record.metadata || {}, scope = record.scope;
  if (m.revoked === true || m.deleted === true || m.denied === true || record.revoked === true || record.deleted === true || record.denied === true) return false;
  if (record.subjectId !== undefined || record.factKey !== undefined || m.isUserFact === true) {
    if (!opaque(record.subjectId) || record.subjectId !== context.subjectId || !validScope(scope) || record.factKey!==undefined && !opaque(record.factKey)) return false;
  }
  if (privateRecord(record)) return sameScope(scope, context) && context.isGroup === false;
  if (record.subjectId !== undefined || record.factKey !== undefined || m.isUserFact === true) {
    if (!opaque(record.subjectId) || record.subjectId !== context.subjectId || !validScope(scope)) return false;
    return sameScope(scope, context) || mappedScope(scope, context);
  }
  if (validScope(scope)) return sameScope(scope, context) || mappedScope(scope, context);
  // 没有会话键的旧公共条目只能作一般资料；不能用于辨认联系人或回溯私聊。
  if (scope !== undefined || m.sourceType === 'private') return false;
  const localVideo = record.origin === 'video' && context.platform === 'douyin';
  return (context.sharedEnabled || localVideo) && (record.origin === 'video' || ['qq','qq-history'].includes(record.origin) && m.sourceType === 'group');
}
export function createAccessView(records, context, { now = Date.now() } = {}) {
  validateMemoryContext(context);
  if (!timestamp(now)) throw new TypeError('now 必须是毫秒时间戳。');
  if (!Array.isArray(records) || records.length > MAX_MEMORY_RECORDS) throw new RangeError(`单次来源窗口最多${MAX_MEMORY_RECORDS}条，不能静默截断。`);
  const byId = new Map(), duplicates = new Set();
  for (const row of records) {
    const key = recordKey(row?.id); if (!key) continue;
    if (byId.has(key)) duplicates.add(key); else byId.set(key, row);
  }
  function visit(row, ancestors = new Set(), depth = 0, budget = { nodes: 0 }) {
    const key = recordKey(row?.id);
    if (!key || duplicates.has(key) || ancestors.has(key) || depth > 8 || ++budget.nodes > 128) return null;
    if (!ACTIVE.has(row.status) || !timestamp(row.updatedAt) || !timestamp(row.createdAt) || typeof row.content !== 'string' || !row.content.trim() || row.content.length > 8000 || !row.metadata || typeof row.metadata !== 'object' || Array.isArray(row.metadata)) return null;
    if (['sourceType','privacy','visibility'].some(field=>row.metadata[field]!==undefined && typeof row.metadata[field]!=='string') || ['revoked','deleted','denied','isUserFact','derivedFromQQ'].some(field=>row.metadata[field]!==undefined && typeof row.metadata[field]!=='boolean')) return null;
    if (['revoked','deleted','denied'].some(field=>row[field]!==undefined && typeof row[field]!=='boolean') || !allowed(row, context)) return null;
    if (row.validFrom !== undefined && (!timestamp(row.validFrom) || row.validFrom > now) || row.validUntil !== undefined && (!timestamp(row.validUntil) || row.validUntil <= now)) return null;
    const refs = row.metadata.sourceMemoryRefs;
    if (refs !== undefined && (!Array.isArray(refs) || refs.length > 32) || row.metadata.derivedFromQQ === true && !refs?.length) return null;
    const path = new Set(ancestors); path.add(key);
    let inheritedPrivate = privateRecord(row);
    for (const ref of refs || []) {
      const parent = byId.get(recordKey(ref?.id));
      if (!parent || !timestamp(ref?.updatedAt) || parent.updatedAt !== ref.updatedAt) return null;
      const checked = visit(parent, path, depth + 1, budget);
      if (!checked) return null;
      inheritedPrivate ||= privateRecord(checked);
    }
    if (inheritedPrivate && (!sameScope(row.scope, context) || context.isGroup !== false)) return null;
    const checked = { ...row, metadata: { ...row.metadata, ...(inheritedPrivate ? { sourceType: 'private', privacy: 'internal-reference' } : {}) } };
    return checked;
  }
  const accessible = records.map(row => visit(row)).filter(Boolean), superseded = new Set();
  const accessibleById = new Map(accessible.map(row => [recordKey(row.id), row]));
  for (const row of accessible) {
    if (row.status !== 'confirmed' || !opaque(row.subjectId) || !opaque(row.factKey) || !Array.isArray(row.supersedes) || row.supersedes.length > 32) continue;
    for (const ref of row.supersedes) {
      const old = accessibleById.get(recordKey(ref?.id));
      if (old && old.status === 'confirmed' && old.updatedAt === ref.updatedAt && old.updatedAt < row.updatedAt && old.subjectId === row.subjectId && old.factKey === row.factKey && sameScope(old.scope, row.scope)) superseded.add(recordKey(old.id));
    }
  }
  // 原话保留在历史接口中，明确被纠正的事实只从事实召回中排除。
  const outdated = (row, path = new Set()) => {
    const key = recordKey(row.id); if (superseded.has(key)) return true;
    if (path.has(key)) return true;
    const next = new Set(path); next.add(key);
    return (row.metadata.sourceMemoryRefs || []).some(ref => {
      const parent = accessibleById.get(recordKey(ref.id));
      return !parent || outdated(parent,next);
    });
  };
  const result = accessible.map(row => outdated(row) ? { ...row, superseded: true } : row);
  const facts=new Map();
  for(const row of result)if(!row.superseded && row.status==='confirmed' && opaque(row.factKey)){
    const key=JSON.stringify([row.scope,row.subjectId,row.factKey]);
    if(!facts.has(key))facts.set(key,new Set());facts.get(key).add(row.content.trim());
  }
  for(const row of result)if(!row.superseded && row.factKey && facts.get(JSON.stringify([row.scope,row.subjectId,row.factKey]))?.size>1)row.conflict=true;
  return { records: result, rejected: records.length - result.length, superseded: superseded.size };
}
