import { createAccessView, recordKey } from './memory-policy.mjs';

// 可审查的概念扩展，仅覆盖这些表达；不是通用向量模型。
export const CONCEPTS = Object.freeze([
  ['过敏','不能吃','不能碰','忌口','吃了不舒服','食物禁忌'],
  ['花生','花生米','落花生'], ['牛奶','乳制品','奶制品','乳糖'],
  ['猫','猫咪','喵星人','小猫'], ['狗','狗狗','汪星人','小狗'],
  ['工作','上班','职场'], ['学校','上学','校园'], ['毕业','离校'],
  ['咖啡','美式','拿铁'], ['茶','茶饮','茗茶'],
  ['喜欢','偏爱','爱好','偏好','最爱'], ['讨厌','不喜欢','反感','不爱'],
  ['难过','伤心','低落','沮丧'], ['开心','高兴','喜悦','快乐'],
  ['考试','测验','测试成绩'], ['搬家','迁居','搬到','住址','住哪','住在','居住','住所','居所'],
  ['生日','出生日期','生辰'], ['周末','双休日','星期六','星期天'],
  ['跑步','慢跑','晨跑'], ['电影','影片','片子'], ['睡觉','睡眠','入睡','失眠'],
  ['退款','退钱','退费'], ['停用','撤销','取消授权'],
]);
const STOP = new Set(['记忆','回忆','记得','之前','什么','哪个','哪些','一下','相关','内容','帮我','请问','告诉','说过','关于','有没有','我们','你们','能否','是否','最近','现在','这个','那个']);
function normalize(text) { return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim(); }
function terms(text) {
  const result = new Set();
  for (const span of normalize(text).match(/[\p{L}\p{N}]+/gu) || []) {
    if (span.length >= 2 && !STOP.has(span)) result.add(span);
    if (/\p{Script=Han}/u.test(span)) for (let n = 2; n <= 3; n++) for (let i = 0; i <= span.length - n; i++) if (!STOP.has(span.slice(i,i+n))) result.add(span.slice(i,i+n));
  }
  return [...result].slice(0,120);
}
function concepts(text) { return new Set(CONCEPTS.flatMap((aliases,index) => aliases.some(alias => text.includes(alias)) ? [index] : [])); }
export function recallHybrid({ records, context, query = '', limit = 8, maxChars = 3000, now = Date.now(), semanticProvider, mode = 'hybrid' } = {}) {
  const started = performance.now();
  if (typeof query !== 'string' || query.length > 200) throw new TypeError('query 最多200字。');
  if(!['hybrid','lexical'].includes(mode))throw new TypeError('检索模式无效。');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isInteger(maxChars) || maxChars < 2 || maxChars > 12000) throw new RangeError('召回数量或字数预算无效。');
  const view = createAccessView(records, context, { now });
  const baseMetrics = { scanned: records.length, authorized: view.records.length, rejected: view.rejected, superseded: view.superseded, sourceWindowLimited:records.sourceWindowLimited===true, semanticMode: mode==='hybrid'?'local-concept-lexicon':'disabled', semanticFallback: false };
  if (!query.trim()) return { entries: [], metrics: { ...baseMetrics, elapsedMs: performance.now() - started, contextChars: 2, tokenUpperBound: 2 } };
  const normalized = normalize(query), words = terms(query), qc = concepts(normalized);
  let scored = view.records.filter(row => !row.superseded).map(row => {
    const text = normalize(`${row.content} ${row.title || ''}`), rc = concepts(text);
    const lexical = (text.includes(normalized) ? 30 : 0) + words.reduce((sum,term) => sum + (text.includes(term) ? Math.min(term.length,8) : 0),0);
    const intersection = [...qc].filter(concept => rc.has(concept)).length;
    const conceptScore = intersection / Math.max(1,qc.size);
    return { row, lexical, semantic: conceptScore, text };
  });
  if (semanticProvider !== undefined && mode==='hybrid') {
    try {
      if (semanticProvider?.localOnly !== true || typeof semanticProvider.score !== 'function') throw new TypeError('仅允许受信宿主提供本地同步评分器。');
      const values = semanticProvider.score({ query, records: scored.map(({row}) => ({ id: row.id, content: row.content })) });
      if (values && typeof values.then === 'function') {
        Promise.resolve(values).catch(() => {});
        throw new TypeError('同步评分器不能返回Promise。');
      }
      if (!Array.isArray(values) || values.length > scored.length) throw new TypeError('语义评分器结果无效。');
      const provided = new Map(values.map(value => [recordKey(value.id),value.score]));
      if (values.some(value => !recordKey(value.id) || !Number.isFinite(value.score) || value.score < 0 || value.score > 1)) throw new TypeError('语义评分超出0至1。');
      scored = scored.map(value => ({ ...value, semantic: Math.max(value.semantic, provided.get(recordKey(value.row.id)) || 0) }));
      baseMetrics.semanticMode = 'host-local-provider+concept-lexicon';
    } catch { baseMetrics.semanticFallback = true; }
  }
  const summaries = scored.filter(value => ['summary','diary','index'].includes(value.row.kind) || value.row.metadata.summaryOnly === true || value.row.metadata.summary === true || value.row.metadata.isSummary === true);
  const summaryKeys = new Set(summaries.map(value => recordKey(value.row.id)));
  const originalScores = new Map(scored.map(value => [recordKey(value.row.id),value]));
  // 摘要只定位已核对版本的原记录，永远不作为原文返回。
  function locate(value, lexical, semantic, path = new Set(), depth = 0) {
    const key=recordKey(value.row.id);
    if(path.has(key)||depth>8)return;
    if(!summaryKeys.has(key)){
      value.lexical=Math.max(value.lexical,lexical);value.semantic=Math.max(value.semantic,semantic);return;
    }
    const next=new Set(path);next.add(key);
    for(const ref of value.row.metadata.sourceMemoryRefs || []){
      const parent=originalScores.get(recordKey(ref.id));
      if(parent)locate(parent,lexical*0.9,semantic*0.9,next,depth+1);
    }
  }
  for (const summary of summaries) locate(summary,summary.lexical,summary.semantic);
  scored = scored.filter(value => !summaryKeys.has(recordKey(value.row.id)));
  const lexicalRank = new Map(scored.filter(x=>x.lexical>0).sort((a,b)=>b.lexical-a.lexical || b.row.updatedAt-a.row.updatedAt).map((x,i)=>[recordKey(x.row.id),i+1]));
  const semanticRank = new Map(scored.filter(x=>mode==='hybrid'&&x.semantic>=0.45).sort((a,b)=>b.semantic-a.semantic || b.row.updatedAt-a.row.updatedAt).map((x,i)=>[recordKey(x.row.id),i+1]));
  const ranked = scored.filter(x=>lexicalRank.has(recordKey(x.row.id)) || semanticRank.has(recordKey(x.row.id))).map(value => {
    const key=recordKey(value.row.id), lr=lexicalRank.get(key), sr=semanticRank.get(key);
    return { ...value, score: (lr ? 1/(20+lr) : 0) + (sr ? 1/(20+sr) : 0) };
  }).sort((a,b)=>b.score-a.score || b.lexical-a.lexical || b.row.updatedAt-a.row.updatedAt || recordKey(a.row.id).localeCompare(recordKey(b.row.id)));
  const entries=[], seen=new Set(); let droppedForBudget=0;
  for (const candidate of ranked) {
    const dedupe = `${candidate.row.subjectId || ''}|${candidate.row.scope?.platform || ''}|${candidate.row.scope?.conversationId || ''}|${candidate.text}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const row = { ...candidate.row, score: Number(candidate.score.toFixed(6)) };
    if (JSON.stringify([...entries,row]).length > maxChars) { droppedForBudget++; continue; }
    entries.push(row); if (entries.length === limit) break;
  }
  const serialized=JSON.stringify(entries);
  return { entries, metrics: { ...baseMetrics, elapsedMs: performance.now()-started, candidates: ranked.length, droppedForBudget, contextChars: serialized.length, tokenUpperBound: Buffer.byteLength(serialized,'utf8') } };
}
