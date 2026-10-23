import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';

export const DEFAULT_WATCH_OPTIONS = Object.freeze({ mode: 'recommend', topics: [], exclude: [] });
export function validateWatchOptions(value) {
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !['mode', 'topics', 'exclude'].includes(key)) || !['recommend', 'topic'].includes(value.mode)) throw new Error('请选择推荐观看或主题观看。');
  for (const key of ['topics', 'exclude']) if (!Array.isArray(value[key]) || value[key].length > 20 || value[key].some(item => typeof item !== 'string' || !item.trim() || item.length > 100 || /[\0\r\n]/.test(item))) throw new Error('主题和排除词各最多20项，每项1至100字。');
  if (value.mode === 'topic' && !value.topics.length) throw new Error('主题观看至少填写一个主题。');
  return { mode: value.mode, topics: [...new Set(value.topics.map(item => item.trim()))], exclude: [...new Set(value.exclude.map(item => item.trim()))] };
}
export class WatchOptions {
  constructor({ stateDir = resolveRuntimePaths().stateDir } = {}) { this.file = path.join(stateDir, 'watch-options.json'); }
  state() { try { return { protocol: 'watch-options-v1', policy: validateWatchOptions(JSON.parse(fs.readFileSync(this.file, 'utf8'))) }; } catch (error) { if (error.code === 'ENOENT') return { protocol: 'watch-options-v1', policy: structuredClone(DEFAULT_WATCH_OPTIONS) }; throw new Error('主题观看设置无法读取，未覆盖原文件。'); } }
  configure(value, { explicit = false } = {}) {
    if (!explicit) throw new Error('主题观看设置需要明确保存。');
    const policy = validateWatchOptions(value); this.state(); fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(policy, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, this.file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return this.state();
  }
}
