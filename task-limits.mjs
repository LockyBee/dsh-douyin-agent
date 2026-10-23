import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';

export const DEFAULT_TASK_POLICY = Object.freeze({ maxSteps: 20, maxToolCalls: 20, timeoutSeconds: 180 });
export const TASK_LIMIT_BOUNDS = Object.freeze({
  maxSteps: Object.freeze({ minimum: 1, maximum: 10000 }),
  maxToolCalls: Object.freeze({ minimum: 1, maximum: 10000 }),
  timeoutSeconds: Object.freeze({ minimum: 10, maximum: 604800 }),
});
const MAX_POLICY_BYTES = 4096;
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function validateTaskPolicy(value) {
  if (!plainObject(value) || Object.keys(value).some(key => !Object.hasOwn(TASK_LIMIT_BOUNDS, key))) throw error('TASK_POLICY_ARGUMENT', '手动任务预算只接受步数、工具调用数和超时秒数。');
  const labels = { maxSteps: '任务步数', maxToolCalls: '工具调用数', timeoutSeconds: '超时秒数' };
  for (const [key, { minimum, maximum }] of Object.entries(TASK_LIMIT_BOUNDS)) if (!Object.hasOwn(value, key) || !Number.isSafeInteger(value[key]) || value[key] < minimum || value[key] > maximum) throw error('TASK_POLICY_ARGUMENT', `${labels[key]}须为 ${minimum} 至 ${maximum} 的整数。`);
  return Object.fromEntries(Object.keys(TASK_LIMIT_BOUNDS).map(key => [key, value[key]]));
}

export class TaskLimits {
  constructor({ stateDir = resolveRuntimePaths().stateDir } = {}) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || /[\0\r\n]/.test(stateDir)) throw error('TASK_POLICY_PATH', '手动任务设置目录必须是绝对路径。');
    this.stateDir = path.normalize(stateDir);
    fs.mkdirSync(this.stateDir, { recursive: true });
    this.policyFile = path.join(this.stateDir, 'task-policy.json');
    this.guardFile = path.join(this.stateDir, 'task-control.guard');
  }
  read() {
    let stat;
    try { stat = fs.lstatSync(this.policyFile); } catch (failure) { if (failure.code === 'ENOENT') return null; throw error('TASK_POLICY_FILE', '手动任务预算文件无法读取，未恢复默认值。'); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_POLICY_BYTES) throw error('TASK_POLICY_FILE', '手动任务预算须为有界普通文件，未改写原记录。');
    try {
      const bytes = fs.readFileSync(this.policyFile);
      if (bytes.length > MAX_POLICY_BYTES || bytes.includes(0)) throw new Error();
      const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!plainObject(record) || record.version !== 1 || Object.keys(record).some(key => !['version', 'policy'].includes(key))) throw new Error();
      return validateTaskPolicy(record.policy);
    } catch { throw error('TASK_POLICY_FILE', '手动任务预算损坏或格式无效，未重置或覆盖原记录。'); }
  }
  state() {
    const stored = this.read();
    return { protocol: 'task-limits-v1', policy: stored ?? { ...DEFAULT_TASK_POLICY }, hardLimits: structuredClone(TASK_LIMIT_BOUNDS), configured: stored !== null };
  }
  configure(body, { explicit = false } = {}) {
    if (explicit !== true) throw error('TASK_POLICY_EXPLICIT', '手动任务预算只能由用户明确保存。', 403);
    const policy = validateTaskPolicy(body), nonce = randomUUID();
    let descriptor;
    try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); }
    catch (failure) { if (failure.code === 'EEXIST') throw error('TASK_POLICY_BUSY', '手动任务预算正在更新，或原控制锁需要人工核对；未抢占或删除。', 409); throw failure; }
    const temporary = `${this.policyFile}.${process.pid}.${nonce}.tmp`;
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce })); fs.closeSync(descriptor); descriptor = undefined;
      this.read();
      const bytes = Buffer.from(JSON.stringify({ version: 1, policy }, null, 2) + '\n');
      if (bytes.length > MAX_POLICY_BYTES) throw error('TASK_POLICY_CAPACITY', '手动任务预算文件超过大小限制。');
      const output = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(output, bytes); fs.fsyncSync(output); } finally { fs.closeSync(output); }
      fs.renameSync(temporary, this.policyFile);
      return this.state();
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
      let owner; try { owner = JSON.parse(fs.readFileSync(this.guardFile, 'utf8')); } catch {}
      if (owner?.pid === process.pid && owner?.nonce === nonce) fs.unlinkSync(this.guardFile);
    }
  }
}

export default TaskLimits;
