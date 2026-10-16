import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { allowedWindow, validateVideoPolicy } from './video-limits.mjs';
import { messageFingerprint } from './chat-message.mjs';
import { analyzeConversationDay } from './chat-browser.mjs?v=9';
import { OutboundCoordinator } from './outbound-send.mjs';
import { SparkAgent } from './spark-agent.mjs?v=9';
import { loadApiConfig, redact } from './api-agent.mjs';

const defaults = () => ({ version: 1, enabled: false, timeZone: 'Asia/Shanghai', windows: ['09:00-22:00'], dailyLimit: 2 });
const emptyLedger = () => ({ version: 1, operations: [], contacts: {}, lastError: '' });
const states = new Set(['reserved', 'sending', 'confirmed', 'uncertain', 'not-sent']);
const recipientPattern = /^conv:[a-f0-9]{64}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const day = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const fail = (message, code = 'SPARK_BLOCKED', status = 409) => Object.assign(new Error(message), { code, status });
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const read = (file, fallback) => { try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304) throw Error(); return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw fail('续火花状态无法读取，未重新计数或发送。', 'SPARK_STATE_INVALID'); } };
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function validatePolicy(value) {
  if (!value || value.version !== 1 || typeof value.enabled !== 'boolean' || value.timeZone !== 'Asia/Shanghai' || !Number.isSafeInteger(value.dailyLimit) || value.dailyLimit < 1 || value.dailyLimit > 2) throw fail('续火花许可或每日次数损坏，未启用发送。', 'SPARK_POLICY_INVALID');
  const time = validateVideoPolicy({ windows: value.windows, sessionMinutes: 1, timeZone: value.timeZone });
  return { version: 1, enabled: value.enabled, timeZone: value.timeZone, windows: time.windows, dailyLimit: value.dailyLimit };
}
function snapshotMessages(snapshot, recipientId) {
  if (snapshot?.blocked || snapshot?.loginRequired || snapshot?.verificationRequired || (snapshot?.conversation?.id || snapshot?.contact?.id) !== recipientId || !Array.isArray(snapshot?.messages)) throw fail('私信登录状态或会话身份未通过核对，未发送问候。');
  const messages = snapshot.messages;
  if (messages.some(item => !item || typeof item.id !== 'string' || !item.id || !['incoming', 'outgoing'].includes(item.sender || item.direction)) || new Set(messages.map(item => item.id)).size !== messages.length) throw fail('私信消息身份或方向不可靠，未发送问候。');
  return messages;
}
const signature = messages => JSON.stringify(messages.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) })));

// 与自动回复共用联系人和浏览器能力；问候许可、日期收据和调度另存本机。
export class SparkService {
  constructor({ browser, config = loadApiConfig(), personaMemory, greetingProvider, stateDir = resolveRuntimePaths().stateDir, source = 'api', now = Date.now, pollIntervalMs = 60_000 } = {}) {
    if (!browser?.listContacts || !browser?.readConversation || !browser?.sendMessage || !['api', 'dsh'].includes(source) || typeof now !== 'function') throw new TypeError('续火花缺少可信私信浏览器或本机入口。');
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1000 || pollIntervalMs > 3_600_000) throw new TypeError('续火花检查间隔须为 1 至 3600 秒。');
    Object.assign(this, { browser, config, personaMemory, greetingProvider, stateDir, source, now, pollIntervalMs });
    this.files = Object.fromEntries(['policy', 'ledger', 'control', 'loop', 'stop'].map(name => [name, path.join(stateDir, name === 'loop' ? 'spark-loop.lock' : name === 'control' ? 'spark-control.guard' : name === 'stop' ? 'spark-stop.request.json' : `spark-${name}.json`)]));
    this.coordinator = new OutboundCoordinator({ stateDir, source, now });
    this.agent = new SparkAgent({ config, personaMemory, greetingProvider });
    this.running = false; this.busy = false; this.starting = false; this.closed = false; this.runId = null; this.active = null; this.timer = null; this.heartbeat = null; this.abort = null;
  }
  setGreetingProvider(provider) {
    if (provider !== undefined && typeof provider !== 'function') throw new TypeError('问候模型接口必须是函数。');
    if (this.running || this.starting || this.busy) throw fail('请先停止当前入口的续火花调度，再更换模型接口。');
    this.greetingProvider = provider; this.agent.greetingProvider = provider;
    return this.state();
  }
  policy() { return validatePolicy(read(this.files.policy, defaults())); }
  ledger() {
    const value = read(this.files.ledger, emptyLedger());
    if (!value || value.version !== 1 || !Array.isArray(value.operations) || !value.contacts || typeof value.contacts !== 'object' || Array.isArray(value.contacts) || typeof value.lastError !== 'string') throw fail('续火花收据损坏，未重新计数。', 'SPARK_LEDGER_INVALID');
    const unique = new Set();
    for (const item of value.operations) {
      if (!item || typeof item.operationId !== 'string' || !item.operationId || !recipientPattern.test(item.recipientId) || !datePattern.test(item.day) || !states.has(item.status) || !['api', 'dsh'].includes(item.source) || !Number.isSafeInteger(item.pid) || item.pid < 1 || typeof item.runId !== 'string' || !Number.isFinite(Date.parse(item.startedAt))) throw fail('续火花收据格式错误，未重新计数。', 'SPARK_LEDGER_INVALID');
      const key = `${item.recipientId}:${item.day}`;
      if (unique.has(key)) throw fail('同一好友和日期存在重复问候记录，需要人工核对。', 'SPARK_LEDGER_INVALID');
      unique.add(key);
    }
    if (new Set(value.operations.map(item => item.operationId)).size !== value.operations.length) throw fail('问候操作标识重复，需要人工核对。', 'SPARK_LEDGER_INVALID');
    return value;
  }
  recipients() {
    const policy = read(path.join(this.stateDir, 'chat-policy.json'), { allowlist: [] });
    const list = policy?.allowlist;
    if (!Array.isArray(list) || list.length > 2 || new Set(list.map(item => item?.id)).size !== list.length || list.some(item => !item || !recipientPattern.test(item.id) || item.followed !== true || item.isGroup !== false || !Number.isFinite(Date.parse(item.verifiedAt)) || typeof item.name !== 'string' || !item.name.trim())) throw fail('现有两位好友许可名单未通过核对。');
    return list.map(({ id, name }) => ({ id, name }));
  }
  acquireControl() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const owner = { pid: process.pid, token: randomUUID() }; let descriptor;
    try { descriptor = fs.openSync(this.files.control, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fail('续火花设置或最终发送正在处理，请稍后重试；当前设置未改变。', 'SPARK_CONTROL_BUSY'); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify(owner)); } finally { fs.closeSync(descriptor); }
    let released = false;
    return () => { if (released) return; released = true; const current = read(this.files.control, null); if (current?.pid === owner.pid && current.token === owner.token) fs.unlinkSync(this.files.control); };
  }
  control(action) { const release = this.acquireControl(); try { return action(); } finally { release(); } }
  worker() {
    const value = read(this.files.loop, null);
    if (!value) return null;
    if (!Number.isSafeInteger(value.pid) || value.pid < 1 || !['api', 'dsh'].includes(value.source) || typeof value.runId !== 'string' || !value.runId || !['running', 'starting', 'stopping'].includes(value.status)) throw fail('续火花进程锁无法核对，未启动另一个入口。', 'SPARK_WORKER_INVALID');
    return { ...value, alive: alive(value.pid), owned: value.pid === process.pid && value.runId === this.runId && value.source === this.source };
  }
  assertOwned() {
    const worker = this.worker();
    if (!this.runId || !worker?.owned || !worker.alive) { this.running = false; this.abort?.abort(fail('续火花已失去共享进程锁。')); throw fail('续火花已失去共享进程锁，未继续发送。'); }
    return worker;
  }
  unresolved(ledger, worker = this.worker()) {
    return ledger.operations.filter(item => item.status === 'uncertain' || (['reserved', 'sending'].includes(item.status) && !(worker?.alive && worker.runId === item.runId && worker.pid === item.pid && worker.source === item.source)));
  }
  state() {
    const policy = this.policy(), ledger = this.ledger(), worker = this.worker(), recipients = this.recipients(), date = day(this.now());
    const operations = ledger.operations.filter(item => item.day === date), needsReview = this.unresolved(ledger, worker);
    const stopping = Boolean(worker?.alive && (worker.status === 'stopping' || read(this.files.stop, null)?.targetRunId === worker.runId));
    return { protocol: 'spark-v1', enabled: policy.enabled, modelReady: Boolean(this.config?.apiKey || this.greetingProvider), running: Boolean(worker?.alive && worker.status === 'running' && !stopping), starting: Boolean(this.starting || worker?.alive && worker.status === 'starting'), stopping, busy: this.busy, worker, timeZone: 'Asia/Shanghai', policy, pollSeconds: this.pollIntervalMs / 1000, inWindow: Boolean(allowedWindow(policy, this.now())), daily: { date, attempts: operations.length, confirmed: operations.filter(item => item.status === 'confirmed').length, limit: policy.dailyLimit, remaining: Math.max(0, policy.dailyLimit - operations.length) }, paused: needsReview.length > 0, lastError: ledger.lastError, recipients: recipients.map(contact => { const operation = operations.find(item => item.recipientId === contact.id), check = ledger.contacts[contact.id]; return { ...contact, status: operation?.status || (check?.day === date ? check.status : 'waiting'), reason: operation?.reason || (check?.day === date ? check.reason : '') || '', lastConfirmedAt: ledger.operations.findLast(item => item.recipientId === contact.id && item.status === 'confirmed')?.completedAt || null }; }), needsReview: needsReview.map(({ operationId, recipientId, day, status, startedAt, reason }) => ({ operationId, recipientId, day, status, startedAt, reason })), recent: ledger.operations.slice(-10).map(({ operationId, recipientId, day, status, startedAt, completedAt, messageId, reason }) => ({ operationId, recipientId, day, status, startedAt, completedAt, messageId, reason })) };
  }
  configure(input = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('续火花设置只能由用户明确修改。');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['enabled', 'windows', 'dailyLimit'].includes(key))) throw new TypeError('续火花只接收总开关、时间段和每日次数。');
    const policy = validatePolicy({ ...this.policy(), ...input });
    this.control(() => {
      this.ledger();
      const worker = this.worker();
      write(this.files.policy, policy);
      if (!policy.enabled && worker?.alive) write(this.files.stop, { targetRunId: worker.runId, requestId: randomUUID(), requestedAt: new Date(this.now()).toISOString() });
    });
    if (!policy.enabled && this.runId) this.halt('用户关闭自动续火花。');
    return this.state();
  }
  recover(ledger) {
    for (const item of ledger.operations) if (['reserved', 'sending'].includes(item.status)) { item.status = 'uncertain'; item.reason = '上次问候在确认前结束，需要人工核对，不会自动重发。'; item.completedAt = new Date(this.now()).toISOString(); }
    return ledger;
  }
  async start({ schedule = true, explicit = false } = {}) {
    if (!explicit) throw fail('开始问候调度需要用户明确操作。');
    if (this.closed) throw fail('续火花入口已关闭。');
    if (this.running && this.worker()?.owned) return this.state();
    if (this.starting || this.busy) throw fail('续火花正在启动或停止，请稍后重试。');
    if (!this.policy().enabled) throw fail('请先在本机开启自动续火花许可。');
    if (!this.config?.apiKey && !this.greetingProvider) throw fail('未配置问候模型或 API Key。');
    const recipients = this.recipients(); if (recipients.length !== 2) throw fail('续火花仅沿用当前已核对的两位许可好友，请先核对名单。');
    this.control(() => {
      const worker = this.worker(); if (worker?.alive) throw fail('另一个入口已经运行续火花调度，请使用状态或停止入口。');
      const ledger = this.recover(this.ledger()); write(this.files.ledger, ledger);
      if (this.unresolved(ledger, null).length) throw fail('有问候发送结果需要人工核对，未开始新的调度。');
      if (ledger.lastError) { ledger.lastError = ''; write(this.files.ledger, ledger); }
      if (worker) fs.unlinkSync(this.files.loop);
      this.runId = randomUUID();
      write(this.files.loop, { pid: process.pid, source: this.source, runId: this.runId, status: 'starting', heartbeatAt: new Date(this.now()).toISOString() });
    });
    this.starting = true; this.abort = new AbortController(); this.startHeartbeat();
    try {
      const list = await this.browser.listContacts({ verifyFollowing: true, signal: this.abort.signal });
      this.abort.signal.throwIfAborted(); this.assertOwned();
      if (list.blocked || list.loginRequired || list.verificationRequired || recipients.some(contact => !list.contacts?.some(item => item.id === contact.id && (item.name || item.displayName) === contact.name && item.followed === true && item.isGroup === false))) throw fail('当前好友身份或关注关系未通过核对，未开始调度。');
      this.control(() => { this.assertOwned(); if (!this.policy().enabled || read(this.files.stop, null)?.targetRunId === this.runId) throw fail('续火花启动许可已撤回。'); write(this.files.loop, { pid: process.pid, source: this.source, runId: this.runId, status: 'running', heartbeatAt: new Date(this.now()).toISOString() }); });
      this.running = true;
      if (schedule) { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.pollIntervalMs); this.timer.unref?.(); }
      this.starting = false;
      return this.state();
    } catch (error) { this.halt(error.message); throw error; }
    finally { this.starting = false; if (!this.running && !this.busy) this.releaseWorker(); }
  }
  startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      try {
        this.assertOwned();
        if (!this.running && !this.starting && !this.busy) { this.releaseWorker(); return; }
        if (!this.policy().enabled || read(this.files.stop, null)?.targetRunId === this.runId) this.halt('收到续火花停止请求。');
        else this.control(() => { const worker = this.assertOwned(); write(this.files.loop, { pid: worker.pid, source: worker.source, runId: worker.runId, status: this.starting ? 'starting' : this.running ? 'running' : 'stopping', heartbeatAt: new Date(this.now()).toISOString() }); });
      } catch (error) { if (error.code !== 'SPARK_CONTROL_BUSY') { try { this.halt(error.message); } catch { /* 锁损坏时保留文件，不让后台计时器覆盖或抢占。 */ } } }
    }, 1000);
    this.heartbeat.unref?.();
  }
  halt(reason) {
    this.running = false; clearInterval(this.timer); this.timer = null;
    this.abort?.abort(fail(reason));
    if (!this.busy && !this.starting) this.releaseWorker();
  }
  releaseWorker() {
    if (!this.runId || this.busy || this.starting) return;
    try { this.control(() => { const worker = this.worker(); if (worker?.owned) fs.unlinkSync(this.files.loop); }); }
    catch (error) { if (error.code === 'SPARK_CONTROL_BUSY') return; throw error; }
    this.runId = null; clearInterval(this.heartbeat); this.heartbeat = null;
  }
  stop({ explicit = false } = {}) {
    if (!explicit) throw fail('停止续火花需要用户明确操作。');
    this.control(() => { const worker = this.worker(); if (worker?.alive) write(this.files.stop, { targetRunId: worker.runId, requestId: randomUUID(), requestedAt: new Date(this.now()).toISOString() }); });
    if (this.runId) this.halt('用户停止续火花调度。');
    return this.state();
  }
  unresolvedOtherSend(recipientId) {
    const marks = read(path.join(this.stateDir, 'chat-watermarks.json'), { contacts: {} });
    if (!marks || !marks.contacts || typeof marks.contacts !== 'object') throw fail('自动回复水位不可读，未发送问候。');
    const mark = marks.contacts[recipientId];
    if (['inflight', 'delivery-uncertain'].includes(mark?.status) || mark?.pending?.phase === 'sending') throw fail('这位好友有未确认的私信发送，需要先人工核对。');
    const forward = read(path.join(this.stateDir, 'video-forward-receipts.json'), { operations: [] });
    if (!Array.isArray(forward?.operations)) throw fail('视频转发收据不可读，未发送问候。');
    if (forward.operations.some(item => item.recipientId === recipientId && ['clicking', 'uncertain'].includes(item.status))) throw fail('这位好友有未确认的视频转发，需要先人工核对。');
  }
  allowed(recipientId, operationId, signal) {
    signal?.throwIfAborted(); this.assertOwned();
    if (!this.running || read(this.files.stop, null)?.targetRunId === this.runId) throw fail('续火花调度已停止，未继续发送。');
    const policy = this.policy(), ledger = this.ledger();
    if (!policy.enabled || !allowedWindow(policy, this.now())) throw fail('当前未获续火花许可或不在允许时间段。');
    if (!this.recipients().some(item => item.id === recipientId)) throw fail('好友已不在许可名单。');
    if (this.unresolved(ledger).length) throw fail('有发送结果需要人工核对，未继续问候。');
    const date = day(this.now()), own = operationId && ledger.operations.find(item => item.operationId === operationId);
    if (own && (own.day !== date || own.recipientId !== recipientId || own.runId !== this.runId || !['reserved', 'sending'].includes(own.status))) throw fail('问候预留与当前日期或调度不一致。');
    const today = ledger.operations.filter(item => item.day === date);
    if ((today.length >= policy.dailyLimit && !own) || today.length > policy.dailyLimit || today.some(item => item.recipientId === recipientId && item !== own)) throw fail('今天的问候次数已用完，不会重复发送。');
    this.unresolvedOtherSend(recipientId);
    return { policy, ledger, date, own };
  }
  check(recipientId, status, reason = '') {
    this.control(() => { const ledger = this.ledger(); ledger.contacts[recipientId] = { day: day(this.now()), status, reason, checkedAt: new Date(this.now()).toISOString() }; write(this.files.ledger, ledger); });
  }
  update(operationId, value) {
    this.control(() => { this.assertOwned(); const ledger = this.ledger(), operation = ledger.operations.find(item => item.operationId === operationId); if (!operation || operation.runId !== this.runId) throw fail('问候预留记录丢失或归属改变，未继续发送。'); Object.assign(operation, value); write(this.files.ledger, ledger); });
  }
  tick() {
    if (!this.running || this.busy) return Promise.resolve(this.state());
    this.busy = true;
    this.active = this.performTick().catch(error => {
      try { this.control(() => { this.assertOwned(); const ledger = this.ledger(); ledger.lastError = redact(error.message || String(error), [this.config?.apiKey || '']); write(this.files.ledger, ledger); }); } catch { /* 原状态不可写或归属改变时不重置收据。 */ }
      this.halt(error.message || '续火花已停止。'); throw error;
    }).finally(() => { this.busy = false; this.active = null; if (!this.running) this.releaseWorker(); });
    return this.active;
  }
  async performTick() {
    const signal = this.abort.signal;
    this.assertOwned();
    const policy = this.policy();
    if (!policy.enabled || read(this.files.stop, null)?.targetRunId === this.runId) { this.halt('续火花许可已撤回。'); return this.state(); }
    if (!allowedWindow(policy, this.now())) return this.state();
    if (this.unresolved(this.ledger()).length) throw fail('有未确认问候，需要人工核对。');
    for (const contact of this.recipients()) {
      signal.throwIfAborted();
      if (this.ledger().operations.some(item => item.recipientId === contact.id && item.day === day(this.now()))) continue;
      if (this.ledger().operations.filter(item => item.day === day(this.now())).length >= this.policy().dailyLimit) break;
      this.allowed(contact.id, null, signal);
      const history = this.coordinator.history(contact.id);
      const before = await this.browser.readConversation(contact.id, { allowed: true, signal });
      const messages = snapshotMessages(before, contact.id);
      const analysis = analyzeConversationDay(before, { now: this.now, confirmedHistory: history });
      if (analysis.status !== 'eligible') { this.check(contact.id, analysis.status, analysis.reason); continue; }
      let operationId;
      this.control(() => {
        const { ledger, date } = this.allowed(contact.id, null, signal);
        operationId = randomUUID(); ledger.operations.push({ operationId, recipientId: contact.id, day: date, status: 'reserved', source: this.source, pid: process.pid, runId: this.runId, startedAt: new Date(this.now()).toISOString() }); write(this.files.ledger, ledger);
      });
      try {
        Object.assign(this.agent, { config: this.config, personaMemory: this.personaMemory, greetingProvider: this.greetingProvider });
        const greeting = await this.agent.greet({ date: day(this.now()), signal });
        this.allowed(contact.id, operationId, signal);
        const delivery = await this.coordinator.run({ recipientId: contact.id, purpose: 'spark', signal }, async () => {
          this.allowed(contact.id, operationId, signal);
          const latest = await this.browser.readConversation(contact.id, { allowed: true, signal });
          const current = snapshotMessages(latest, contact.id);
          const checked = analyzeConversationDay(latest, { now: this.now, confirmedHistory: this.coordinator.history(contact.id) });
          if (checked.status !== 'eligible' || signature(current) !== signature(messages)) return { confirmed: false, deliveryUncertain: false, reason: checked.status === 'eligible' ? '生成问候期间消息发生变化，本次未发送。' : checked.reason };
          const authorize = async () => { this.allowed(contact.id, operationId, signal); return true; };
          authorize.beginDispatch = () => { const release = this.acquireControl(); try { this.allowed(contact.id, operationId, signal); return release; } catch (error) { release(); throw error; } };
          this.update(operationId, { status: 'sending' });
          const result = await this.browser.sendMessage(contact.id, greeting.text, { allowed: true, signal, authorize, expectedMessageIds: current.map(item => item.id), expectedMessageContent: current.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) })) });
          if (result?.confirmed === true && (result.deliveryUncertain === true || typeof result.messageId !== 'string' || !result.messageId.trim() || (result.conversation?.id || result.contact?.id) !== contact.id)) return { confirmed: false, deliveryUncertain: true, reason: '问候回执的联系人或消息凭据不完整，需要人工核对。' };
          return result;
        });
        const confirmed = delivery?.confirmed === true && typeof delivery.messageId === 'string' && delivery.messageId.length > 0 && (delivery.conversation?.id || delivery.contact?.id) === contact.id;
        this.update(operationId, { status: confirmed ? 'confirmed' : delivery?.deliveryUncertain ? 'uncertain' : 'not-sent', completedAt: new Date(this.now()).toISOString(), ...(confirmed ? { messageId: delivery.messageId } : {}), reason: confirmed ? '今日问候已确认发送，平台火花状态未验证。' : delivery?.reason || '问候没有取得发送确认，不会自动重发。' });
        if (!confirmed && delivery?.deliveryUncertain) throw fail('问候发送结果不确定，需要人工核对，不会自动重发。');
      } catch (error) {
        const operation = this.ledger().operations.find(item => item.operationId === operationId);
        if (operation && ['reserved', 'sending'].includes(operation.status)) this.update(operationId, { status: operation.status === 'sending' && error.beforeDelivery !== true || error.deliveryUncertain ? 'uncertain' : 'not-sent', completedAt: new Date(this.now()).toISOString(), reason: redact(error.message || String(error), [this.config?.apiKey || '']) });
        throw error;
      }
    }
    return this.state();
  }
  resolve({ operationId, outcome } = {}, { explicit = false } = {}) {
    if (!explicit || typeof operationId !== 'string' || !['confirmed', 'not-sent'].includes(outcome)) throw fail('解除暂停需要用户明确核对结果。');
    this.control(() => {
      if (this.worker()?.alive || this.busy || this.starting) throw fail('请先停止续火花调度，再核对发送结果。');
      const ledger = this.ledger(), operation = ledger.operations.find(item => item.operationId === operationId);
      if (!operation || !['reserved', 'sending', 'uncertain'].includes(operation.status)) throw fail('这条问候不处于需要人工核对的状态。');
      operation.status = outcome; operation.reviewedAt = new Date(this.now()).toISOString(); operation.completedAt ||= operation.reviewedAt; operation.reason = outcome === 'confirmed' ? '用户已核对问候已发送，火花状态未验证。' : '用户已核对未发送；保留本日尝试，不会自动补发。'; ledger.lastError = ''; write(this.files.ledger, ledger);
    });
    return this.state();
  }
  async close() {
    this.closed = true;
    if (this.runId && this.worker()?.owned) this.halt('当前续火花入口已关闭。');
    await this.active?.catch(() => {});
    while (this.starting) await new Promise(resolve => setTimeout(resolve, 20));
    if (this.runId) this.releaseWorker();
  }
}
