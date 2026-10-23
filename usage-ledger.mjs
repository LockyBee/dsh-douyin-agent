import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';

const count = (...values) => values.find(value => Number.isSafeInteger(value) && value >= 0) ?? null;
const summaries = new Map();
export function normalizeUsage(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  const promptTokens = count(value.promptTokens, value.prompt_tokens, value.inputTokens);
  const completionTokens = count(value.completionTokens, value.completion_tokens, value.outputTokens);
  return { promptTokens, completionTokens, totalTokens: count(value.totalTokens, value.total_tokens, promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null), cachedTokens: count(value.cachedTokens, value.cacheReadTokens, value.prompt_cache_hit_tokens, value.prompt_tokens_details?.cached_tokens, value.inputTokenDetails?.cacheReadTokens, value.inputTokensDetails?.cacheReadTokens) };
}
const date = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
const empty = () => ({ requests: 0, reportedRequests: 0, unknownRequests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheReportedRequests: 0 });
function add(target, record) { target.requests++; if (record.usage.totalTokens === null) target.unknownRequests++; else target.reportedRequests++; for (const key of ['promptTokens','completionTokens','totalTokens','cachedTokens']) target[key] += record.usage[key] ?? 0; if (record.usage.cachedTokens !== null) target.cacheReportedRequests++; }

// 两个入口追加同一份按日用量记录；只保存计数，不保存提示词、联系人或凭据。
export class UsageLedger {
  constructor({ stateDir = resolveRuntimePaths().stateDir, now = Date.now } = {}) { this.directory = path.join(stateDir, 'usage'); this.now = now; }
  record({ id = randomUUID(), source = 'api', kind = 'watch', model = '', usage } = {}) {
    if (!['api','dsh'].includes(source) || !['watch','task','comment','spark','chat'].includes(kind) || typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(id)) throw new Error('用量记录来源或编号无效。');
    const record = { id, source, kind, model: /^[a-zA-Z0-9._:/-]{1,128}$/.test(model) ? model : '未报告模型', at: new Date(this.now()).toISOString(), usage: normalizeUsage(usage) };
    fs.mkdirSync(this.directory, { recursive: true });
    fs.appendFileSync(path.join(this.directory, `${date(this.now())}.jsonl`), JSON.stringify(record) + '\n', { mode: 0o600 });
    return record;
  }
  state() {
    const todayKey = date(this.now()), total = empty(), today = empty(), groups = new Map(), days = new Map(), seen = new Set(); let damagedRecords = 0;
    const files = fs.existsSync(this.directory) ? fs.readdirSync(this.directory).filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort().slice(-30) : [];
    const signature = todayKey + files.map(file => { const stat = fs.lstatSync(path.join(this.directory, file)); return `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }).join('|');
    const previous = summaries.get(this.directory); if (previous?.signature === signature) return structuredClone(previous.value);
    for (const file of files) {
      const full = path.join(this.directory, file), stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) { damagedRecords++; continue; }
      for (const line of fs.readFileSync(full, 'utf8').split('\n').filter(Boolean)) {
        let record; try { record = JSON.parse(line); if (!record?.id || !['api','dsh'].includes(record.source) || !['watch','task','comment','spark','chat'].includes(record.kind) || date(Date.parse(record.at)) !== file.slice(0, 10)) throw 0; record.usage = normalizeUsage(record.usage); } catch { damagedRecords++; continue; }
        if (seen.has(record.id)) continue; seen.add(record.id);
        add(total, record); const key = file.slice(0, 10); if (key === todayKey) add(today, record);
        if (!days.has(key)) days.set(key, { date: key, ...empty() }); add(days.get(key), record);
        const group = `${record.source}|${record.kind}|${record.model}`;
        if (!groups.has(group)) groups.set(group, { source: record.source, kind: record.kind, model: record.model, ...empty() }); add(groups.get(group), record);
      }
    }
    const value = { protocol: 'usage-ledger-v1', date: todayKey, today, total, days: [...days.values()], groups: [...groups.values()], damagedRecords, period: '最近30个有记录的日期', note: '从本版开始记录本助手发起的模型响应；DSH 普通会话、失败且未返回用量的请求和云端音频不计入。未报告的用量标为未知，不能据此当作零消耗。' };
    if (summaries.size >= 20) summaries.delete(summaries.keys().next().value);
    summaries.set(this.directory, { signature, value }); return structuredClone(value);
  }
}
