import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const day = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw fail('自主分享记录无法读取，未重置许可、预算或未确认收据。'); } };
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } };
const recipientPattern = /^conv:[a-f0-9]{64}$/;
const evidencePattern = /^video:[a-f0-9]{64}$/;
const statuses = new Set(['reserved', 'clicking', 'confirmed', 'not-sent', 'uncertain', 'resolved-confirmed', 'resolved-not-sent']);

// 共享许可只允许发送当前已观察作品的官方卡片；选择理由留在本机，不进入私信正文。
export class AutonomousShare {
  constructor({ personaMemory, videoLimits, controller, getForwarder, send, stateDir = resolveRuntimePaths().stateDir, source = 'api', now = Date.now } = {}) {
    if (!personaMemory?.snapshot || !videoLimits?.state || !['api', 'dsh'].includes(source) || (send !== undefined && typeof send !== 'function')) throw new TypeError('自主分享缺少共同观察证据、有限时钟或可信发送接口。');
    Object.assign(this, { personaMemory, videoLimits, controller, getForwarder, send, stateDir, source, now });
    this.files = Object.fromEntries(['policy', 'ledger', 'control', 'send'].map(name => [name, path.join(stateDir, `share-${name}${['control', 'send'].includes(name) ? '.guard' : '.json'}`)]));
    this.active = null; this.closed = false;
  }
  acquireControl() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    let descriptor; const owner = { pid: process.pid, token: randomUUID() };
    try { descriptor = fs.openSync(this.files.control, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fail('自主分享设置正在更新，或控制记录需要核对，请稍后重试。'); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify(owner)); } finally { fs.closeSync(descriptor); }
    let released = false;
    return () => { if (released) return; released = true; const current = read(this.files.control, null); if (current?.pid === owner.pid && current.token === owner.token) fs.unlinkSync(this.files.control); };
  }
  control(action) {
    const release = this.acquireControl();
    try { return action(); } finally { release(); }
  }
  policy() {
    const value = read(this.files.policy, { version: 1, enabled: false, dailyLimit: 3 });
    if (!value || value.version !== 1 || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.dailyLimit) || value.dailyLimit < 1 || value.dailyLimit > 20) throw fail('自主分享许可损坏，未启用发送。');
    return value;
  }
  ledger() {
    const value = read(this.files.ledger, { version: 1, days: {}, operations: [] });
    if (!value || value.version !== 1 || !value.days || typeof value.days !== 'object' || Array.isArray(value.days) || Object.values(value.days).some(count => !Number.isSafeInteger(count) || count < 0) || !Array.isArray(value.operations) || value.operations.some(item => !item || typeof item.operationId !== 'string' || !statuses.has(item.status) || !recipientPattern.test(item.recipientId) || !/^\d{1,64}$/.test(item.videoId) || !evidencePattern.test(item.evidenceId) || !/^\d{4}-\d{2}-\d{2}$/.test(item.day) || !['api', 'dsh'].includes(item.source) || !Number.isSafeInteger(item.pid)) || new Set(value.operations.map(item => item.operationId)).size !== value.operations.length) throw fail('自主分享预算或收据损坏，未重新计数。');
    const counts = {};
    for (const item of value.operations) counts[item.day] = (counts[item.day] || 0) + 1;
    if (Object.entries(counts).some(([date, count]) => (value.days[date] || 0) < count)) throw fail('自主分享预算小于已有处理记录，未重置计数。');
    return value;
  }
  recipients() {
    const policy = read(path.join(this.stateDir, 'chat-policy.json'), { allowlist: [] });
    if (!Array.isArray(policy?.allowlist) || policy.allowlist.length > 2 || new Set(policy.allowlist.map(item => item?.id)).size !== policy.allowlist.length || policy.allowlist.some(item => !item || !recipientPattern.test(item.id) || item.followed !== true || item.isGroup !== false || typeof item.verifiedAt !== 'string' || !Number.isFinite(Date.parse(item.verifiedAt)) || typeof item.name !== 'string' || !item.name.trim())) throw fail('现有两位好友白名单未通过核对，未允许自主分享。');
    return policy.allowlist.map(({ id, name }) => ({ id, name }));
  }
  unresolved(ledger = this.ledger(), except) {
    return ledger.operations.filter(item => item.operationId !== except && ['uncertain', 'reserved', 'clicking'].includes(item.status));
  }
  state() {
    const policy = this.policy(), ledger = this.ledger(), recipients = this.recipients(), date = day(this.now());
    const unresolved = this.unresolved(ledger), guard = read(this.files.send, null);
    if (guard && (!Number.isSafeInteger(guard.pid) || typeof guard.token !== 'string')) throw fail('自主分享发送锁损坏，请先核对收据。');
    const recoveryRequired = Boolean(guard && !alive(guard.pid));
    return { protocol: 'autonomous-share-v1', enabled: policy.enabled, dailyLimit: policy.dailyLimit, timeZone: 'Asia/Shanghai', daily: { date, attempts: ledger.days[date] || 0, remaining: Math.max(0, policy.dailyLimit - (ledger.days[date] || 0)) }, recipients, paused: unresolved.length > 0 || recoveryRequired, busy: Boolean(guard && alive(guard.pid)), needsReview: unresolved.map(({ operationId, videoId, recipientId, status, forwardOperationId, startedAt }) => ({ operationId, videoId, recipientId, status, forwardOperationId, startedAt })), recoveryRequired, receiptsFile: this.files.ledger, recent: ledger.operations.slice(-10).map(({ operationId, videoId, recipientId, status, forwardOperationId, messageId, startedAt, completedAt }) => ({ operationId, videoId, recipientId, status, forwardOperationId, messageId, startedAt, completedAt })) };
  }
  context() {
    const state = this.state();
    return { enabled: state.enabled && !state.paused && state.daily.remaining > 0, dailyRemaining: state.daily.remaining, paused: state.paused, recipients: state.recipients, deliveryType: 'native-card', currentObservedVideoOnly: true };
  }
  configure(input = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('自主分享许可只能由用户在本机设置。', 403);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['enabled', 'dailyLimit'].includes(key)) || typeof input.enabled !== 'boolean' || input.dailyLimit !== undefined && (!Number.isSafeInteger(input.dailyLimit) || input.dailyLimit < 1 || input.dailyLimit > 20)) throw fail('自主分享只接受开关和 1 至 20 的每日上限。', 400);
    this.control(() => {
      const policy = this.policy();
      if (input.enabled) { if (!this.recipients().length) throw fail('请先保存最多两位已验证好友，再开启自主分享。'); if (this.unresolved().length || this.state().recoveryRequired) throw fail('上次分享结果需要核对；重新开关不会清除未确认记录。'); }
      write(this.files.policy, { ...policy, enabled: input.enabled, dailyLimit: input.dailyLimit ?? policy.dailyLimit });
    });
    if (!input.enabled) this.active?.abort.abort(fail('用户关闭了自主分享。'));
    return this.state();
  }
  evidence({ evidenceId, videoId }) {
    if (!evidencePattern.test(evidenceId) || typeof videoId !== 'string' || !/^\d{1,64}$/.test(videoId)) throw fail('自主分享必须引用当前作品的真实观察证据。', 400);
    const observation = this.personaMemory.snapshot().recentObservations.find(item => item.id === evidenceId);
    if (!observation || observation.videoId !== videoId || observation.url !== `https://www.douyin.com/video/${videoId}` || !observation.sources?.includes(this.source) || observation.privacy !== 'internal-reference' || observation.visibility !== 'account-visible-unverified') throw fail('自主分享没有找到该入口实际记录的同一作品观察。');
    return observation;
  }
  allowed(input, { signal, watchRunId, operationId, sessionId } = {}) {
    signal?.throwIfAborted();
    if (this.closed) throw fail('此入口已关闭，停止自主分享。');
    const policy = this.policy(), ledger = this.ledger();
    if (!policy.enabled) throw fail('自主分享尚未启用。');
    if (this.unresolved(ledger, operationId).length) throw fail('存在未确认的自主分享，已暂停后续发送。');
    const count = ledger.days[day(this.now())] || 0;
    const own = operationId && ledger.operations.find(item => item.operationId === operationId);
    if (own && own.day !== day(this.now())) throw fail('已跨过上海日期，本次预留不转移到新一天，未继续分享。');
    if (count >= policy.dailyLimit && (!own || count > policy.dailyLimit || own.day !== day(this.now()))) throw fail('今天的自主分享上限已用完。');
    if (!this.recipients().some(item => item.id === input.recipientId)) throw fail('收件人不在现有已验证好友白名单内。', 403);
    this.evidence(input);
    const time = this.videoLimits.state();
    if (!time.allowed || sessionId && time.session?.id !== sessionId) throw fail(time.reason || '视频轮次已改变，停止自主分享。');
    const worker = read(path.join(this.stateDir, 'watch-loop.lock'), null);
    if (worker) {
      if (!alive(worker.pid) || !watchRunId || worker.runId !== watchRunId || worker.source !== this.source || worker.pid !== process.pid || worker.sessionId !== time.session?.id) throw fail('自主分享与当前共享观看入口或轮次不一致。');
    } else if (watchRunId) throw fail('原自主观看已停止，未继续分享。');
    const stopRequest = read(path.join(this.stateDir, 'watch-stop.request.json'), null);
    if (watchRunId && stopRequest?.runId === watchRunId) throw fail('用户已停止自主观看，停止分享。');
    return time;
  }
  update(operationId, updates) {
    return this.control(() => { const ledger = this.ledger(), item = ledger.operations.find(item => item.operationId === operationId); if (!item) throw fail('自主分享预留记录丢失，未继续发送。'); Object.assign(item, updates); write(this.files.ledger, ledger); return item; });
  }
  async share(input = {}, { signal, watchRunId } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['evidenceId', 'videoId', 'recipientId', 'reason'].includes(key)) || !recipientPattern.test(input.recipientId) || input.reason !== undefined && (typeof input.reason !== 'string' || input.reason.length > 600 || /\0/.test(input.reason))) throw fail('自主分享只接受观察编号、当前作品、白名单好友和本地选择理由。', 400);
    this.allowed(input, { signal, watchRunId });
    if (this.active) throw fail('当前入口已有自主分享正在处理。');
    fs.mkdirSync(this.stateDir, { recursive: true });
    const token = randomUUID(); let descriptor;
    try { descriptor = fs.openSync(this.files.send, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fail('另一个入口正在分享，或上次发送锁需要人工核对。'); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    const abort = new AbortController(), combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
    const operationId = randomUUID(); let reserved = false, clicked = false, finished = false, releaseDispatch;
    const completion = Promise.withResolvers(); this.active = { abort, completion: completion.promise };
    try {
      let sessionId;
      this.control(() => {
        const time = this.allowed(input, { signal: combined, watchRunId }); sessionId = time.session?.id;
        const ledger = this.ledger();
        if (ledger.operations.some(item => item.recipientId === input.recipientId && item.videoId === input.videoId)) throw fail('同一作品已经为这位好友处理过，未自动重复发送。');
        const date = day(this.now()); ledger.days[date] = (ledger.days[date] || 0) + 1;
        ledger.operations.push({ operationId, evidenceId: input.evidenceId, videoId: input.videoId, recipientId: input.recipientId, reason: input.reason || '', day: date, source: this.source, pid: process.pid, sessionId, status: 'reserved', startedAt: new Date(this.now()).toISOString() });
        write(this.files.ledger, ledger); reserved = true;
      });
      const authorize = ({ phase, videoId, recipientId } = {}) => {
        if (finished || recipientId !== input.recipientId || videoId !== input.videoId || !['prepare', 'monitor', 'before-click'].includes(phase)) throw fail('可信分享授权与当前作品或收件人不一致。');
        this.allowed(input, { signal: combined, watchRunId, operationId, sessionId });
        if (phase === 'before-click') { if (clicked) throw fail('这项分享已授权一次点击，未再次发送。'); this.update(operationId, { status: 'clicking' }); clicked = true; }
        return true;
      };
      // 最终短输入与设置写入互斥；设置若遇到此阶段会明确返回忙，不能先报关闭成功再发送。
      authorize.beginDispatch = () => {
        if (finished || !clicked || releaseDispatch) throw fail('当前分享未获得一次有效的最终输入授权。');
        const release = this.acquireControl();
        try { this.allowed(input, { signal: combined, watchRunId, operationId, sessionId }); }
        catch (error) { release(); throw error; }
        releaseDispatch = release;
        return () => { releaseDispatch?.(); releaseDispatch = null; };
      };
      let send = this.send;
      if (!send) {
        const forwarder = await (this.getForwarder ? this.getForwarder() : this.controller?.getForwarder?.());
        if (!forwarder?.forwardAutonomous) throw fail('当前转发器尚未提供可信自主分享入口。');
        send = forwarder.forwardAutonomous.bind(forwarder);
      }
      const result = await send({ recipientId: input.recipientId, expectedVideoId: input.videoId }, { signal: combined, authorize, autonomousRunId: watchRunId });
      const confirmed = clicked && result?.confirmed === true && result.deliveryType === 'native-card' && result.videoId === input.videoId && typeof result.messageId === 'string' && !!result.messageId;
      const uncertain = !confirmed && (clicked || result?.deliveryUncertain === true || result?.confirmed === true);
      this.update(operationId, { status: confirmed ? 'confirmed' : uncertain ? 'uncertain' : 'not-sent', completedAt: new Date(this.now()).toISOString(), ...(typeof result?.operationId === 'string' ? { forwardOperationId: result.operationId } : {}), ...(confirmed ? { messageId: result.messageId } : {}) });
      return { confirmed, deliveryUncertain: uncertain, deliveryType: 'native-card', operationId, videoId: input.videoId, recipientId: input.recipientId, ...(confirmed ? { messageId: result.messageId } : {}), ...(!confirmed ? { reason: uncertain ? '分享结果未确认，已暂停后续自主分享，请在抖音核对收据。' : '没有发出可核对的作品卡片，未发送文字链接。' } : {}) };
    } catch (error) {
      if (reserved) { try { this.update(operationId, { status: clicked ? 'uncertain' : 'not-sent', completedAt: new Date(this.now()).toISOString() }); } catch { /* 保留预留记录，不能证明未发送时不重试。 */ } }
      if (clicked) return { confirmed: false, deliveryUncertain: true, deliveryType: 'native-card', operationId, videoId: input.videoId, recipientId: input.recipientId, reason: '发送期间中断，已暂停自主分享，需核对原收据。' };
      throw error;
    } finally {
      finished = true;
      try { releaseDispatch?.(); const owner = read(this.files.send, null); if (owner?.pid === process.pid && owner.token === token) fs.unlinkSync(this.files.send); }
      finally { this.active = null; completion.resolve(); }
    }
  }
  resolve({ operationId, outcome } = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('只有用户核对抖音收据后才能解除暂停。', 403);
    if (typeof operationId !== 'string' || !['confirmed', 'not-sent'].includes(outcome)) throw fail('请提供待核对记录及实际发送结果。', 400);
    this.control(() => {
      const guard = read(this.files.send, null); if (guard && alive(guard.pid)) throw fail('分享仍在执行，请先等待停止后再核对。');
      const ledger = this.ledger(), item = this.unresolved(ledger).find(item => item.operationId === operationId);
      if (!item) throw fail('没有这条待核对记录。', 400);
      item.status = outcome === 'confirmed' ? 'resolved-confirmed' : 'resolved-not-sent'; item.reviewedAt = new Date(this.now()).toISOString();
      write(this.files.ledger, ledger); if (guard) fs.unlinkSync(this.files.send);
    });
    return this.state();
  }
  async close() { this.closed = true; this.active?.abort.abort(fail('软件入口已关闭，停止其自主分享。')); await this.active?.completion; }
}
