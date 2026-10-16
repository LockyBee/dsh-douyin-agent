import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveRuntimePaths } from './runtime-paths.mjs';

const kinds = new Set(['spark', 'reply', 'video']);
const identifier = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 500 && !/[\x00-\x1f]/.test(value);
const shanghaiDay = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const failure = (message, code = 'OUTBOUND_INVALID') => Object.assign(new Error(message), { code, status: 409, beforeDelivery: true });

// 三种发送共用同一把本机锁；账本只保存可核对的发出凭据，不保存正文。
export class OutboundCoordinator {
  constructor({ stateDir = resolveRuntimePaths().stateDir, source = 'api', now = Date.now, waitMs = 5000 } = {}) {
    if (!['api', 'dsh'].includes(source) || typeof now !== 'function' || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw new TypeError('发出消息协调器的入口、时钟或等待预算不正确。');
    Object.assign(this, { stateDir, source, now, waitMs });
    this.guardFile = path.join(stateDir, 'outbound-send.guard');
    this.receiptsFile = path.join(stateDir, 'outbound-receipts.json');
  }
  ledger() {
    let value;
    try {
      const stat = fs.lstatSync(this.receiptsFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304) throw failure('共同发出账本类型或大小异常，未继续发送。');
      value = JSON.parse(fs.readFileSync(this.receiptsFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, receipts: [] };
      throw failure('共同发出账本无法核对，未重置记录或继续发送。', 'OUTBOUND_LEDGER_INVALID');
    }
    if (!value || value.version !== 1 || !Array.isArray(value.receipts) || value.receipts.some(item => !item || item.confirmed !== true || !kinds.has(item.kind) || !identifier(item.recipientId) || !identifier(item.messageId) || !['api', 'dsh'].includes(item.source) || !Number.isFinite(Date.parse(item.at)) || item.date !== shanghaiDay(Date.parse(item.at))) || new Set(value.receipts.map(item => `${item.recipientId}\0${item.messageId}`)).size !== value.receipts.length) throw failure('共同发出账本内容异常，未重置记录或继续发送。', 'OUTBOUND_LEDGER_INVALID');
    return value;
  }
  history(recipientId) {
    if (!identifier(recipientId)) throw new TypeError('读取发出凭据需要明确联系人。');
    return this.ledger().receipts.filter(item => item.recipientId === recipientId).map(item => structuredClone(item));
  }
  async acquire(signal) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const started = Date.now(), owner = { pid: process.pid, token: randomUUID(), source: this.source };
    while (true) {
      signal?.throwIfAborted();
      let descriptor;
      try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let current;
        try { const stat = fs.lstatSync(this.guardFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw Error(); current = JSON.parse(fs.readFileSync(this.guardFile, 'utf8')); }
        catch { throw failure('共同发送锁不完整，需要核对；未自动移除。', 'OUTBOUND_RECOVERY_REQUIRED'); }
        if (!Number.isSafeInteger(current?.pid) || current.pid < 1 || !identifier(current.token)) throw failure('共同发送锁身份不明，需要核对；未自动移除。', 'OUTBOUND_RECOVERY_REQUIRED');
        try { process.kill(current.pid, 0); } catch (probe) { if (probe.code !== 'EPERM') throw failure('上次共同发送锁仍在，需要先核对发送结果；未抢锁。', 'OUTBOUND_RECOVERY_REQUIRED'); }
        if (Date.now() - started >= this.waitMs) throw failure('另一项聊天或分享仍在发送，已保留待发内容，请稍后重试。', 'OUTBOUND_BUSY');
        await delay(Math.min(40, Math.max(1, this.waitMs - (Date.now() - started))), undefined, { signal });
        continue;
      }
      try { fs.writeFileSync(descriptor, JSON.stringify(owner)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      return () => { const current = JSON.parse(fs.readFileSync(this.guardFile, 'utf8')); if (current?.pid === owner.pid && current.token === owner.token) fs.unlinkSync(this.guardFile); };
    }
  }
  async run({ recipientId, purpose, signal } = {}, callback) {
    if (!identifier(recipientId) || !kinds.has(purpose) || typeof callback !== 'function') throw new TypeError('共同发送事务需要明确联系人、用途与本机发送函数。');
    const release = await this.acquire(signal);
    try {
      this.ledger(); signal?.throwIfAborted();
      const delivery = await callback();
      if (delivery?.confirmed === true && identifier(delivery.messageId)) {
        const ledger = this.ledger();
        if (!ledger.receipts.some(item => item.recipientId === recipientId && item.messageId === delivery.messageId)) {
          const at = new Date(this.now()).toISOString();
          ledger.receipts.push({ confirmed: true, date: shanghaiDay(Date.parse(at)), at, kind: purpose, recipientId, messageId: delivery.messageId, source: this.source });
          const temporary = `${this.receiptsFile}.${process.pid}.${randomUUID()}.tmp`;
          try { const descriptor = fs.openSync(temporary, 'wx', 0o600); try { fs.writeFileSync(descriptor, JSON.stringify(ledger, null, 2) + '\n'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } fs.renameSync(temporary, this.receiptsFile); }
          catch { throw Object.assign(new Error('消息已得到界面确认，但共同收据保存失败，需要人工核对，未自动重发。'), { code: 'OUTBOUND_RECEIPT_FAILED', deliveryUncertain: true }); }
          finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        }
      }
      return delivery;
    } finally { release(); }
  }
}
