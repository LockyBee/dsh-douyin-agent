import { readFriendInteractionsEnabled, acquireFriendInteractionDispatch } from './friend-interactions-guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { hasStableConversationIdentity, isStoredContactAuthorized } from './contact-authorization.mjs';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const day = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw fail('自主分享记录无法读取，未重置许可、预算或未确认收据。'); } };
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } };
const recipientPattern = /^conv:[a-f0-9]{64}$/;
const evidencePattern = /^video:[a-f0-9]{64}$/;
const statuses = new Set(['reserved', 'clicking', 'confirmed', 'not-sent', 'uncertain', 'resolved-confirmed', 'resolved-not-sent']);
const processedStatuses = new Set(['confirmed', 'not-sent', 'resolved-confirmed', 'resolved-not-sent']);
const failureOf = value => {
  const source = value?.failure || value || {};
  return { code: /^[A-Z][A-Z0-9_]{1,79}$/.test(source.code || '') ? source.code : 'SHARE_FAILED', stage: /^[a-z][a-z0-9-]{0,39}$/.test(source.stage || '') ? source.stage : 'sharing', message: String(source.message || '分享未完成，请核对当前页面。').split('\n')[0].replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [凭据已隐藏]').replace(/\b(?:token|api[-_]?key|cookie|authorization)\s*[:=]\s*[^\s，。；]+/gi, '[凭据已隐藏]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[凭据已隐藏]').replace(/https?:\/\/[^\s，。；]+/gi, '[地址]').replace(/\b[A-Za-z]:\\[^\s，。；]+/g, '[本地路径]').replace(/\b(?:conv:|binding:)?[a-f0-9]{64}\b|MS4[A-Za-z0-9_-]+|\b\d{10,}\b/g, '[平台标识]').slice(0, 300) };
};

export function isRecoverableSharePreflight(code, stage) {
  if (['CHAT_PAGE_NOT_OPEN', 'CHAT_FOREGROUND'].includes(code)) return ['contact-identity', 'conversation-baseline'].includes(stage);
  if (code === 'OUTBOUND_BUSY') return stage === 'outbound-wait';
  return stage === 'recipient' && ['FORWARD_RECIPIENT_IDENTITY_MISMATCH', 'FORWARD_BUTTON_TARGET_MISMATCH', 'FORWARD_BUTTON_UNAVAILABLE'].includes(code)
    || stage === 'geometry' && code === 'FORWARD_GEOMETRY_FAILED'
    || stage === 'open-panel' && code === 'FORWARD_SHARE_PANEL_UNAVAILABLE';
}
export function isSharePreflightNotSent(value, { videoId, recipientId } = {}) {
  const proof = value?.preflight;
  return Boolean(proof?.protocol === 'share-preflight-v1' && proof.outcome === 'not-sent'
    && proof.videoId === videoId && proof.recipientId === recipientId && proof.sendClicks === 0 && proof.dispatchAuthorized === false
    && typeof proof.forwardOperationId === 'string' && proof.forwardOperationId.length > 0 && proof.forwardOperationId === value.forwardOperationId
    && isRecoverableSharePreflight(proof.failureCode, proof.failureStage)
    && value.failure?.code === proof.failureCode && value.failure?.stage === proof.failureStage);
}

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
    const value = read(this.files.policy, { version: 1, enabled: false, dailyLimit: null });
    if (!value || value.version !== 1 || typeof value.enabled !== 'boolean') throw fail('自主分享许可损坏，未启用发送。');
    return {...value,dailyLimit:null};
  }
  ledger() {
    const value = read(this.files.ledger, { version: 1, days: {}, operations: [] });
    if (!value || value.version !== 1 || !value.days || typeof value.days !== 'object' || Array.isArray(value.days) || Object.values(value.days).some(count => !Number.isSafeInteger(count) || count < 0) || !Array.isArray(value.operations) || value.operations.some(item => !item || typeof item.operationId !== 'string' || !statuses.has(item.status) || !recipientPattern.test(item.recipientId) || !/^\d{1,64}$/.test(item.videoId) || !evidencePattern.test(item.evidenceId) || !/^\d{4}-\d{2}-\d{2}$/.test(item.day) || !['api', 'dsh'].includes(item.source) || !Number.isSafeInteger(item.pid)) || new Set(value.operations.map(item => item.operationId)).size !== value.operations.length) throw fail('自主分享预算或收据损坏，未重新计数。');
    const counts = {};
    for (const item of value.operations) counts[item.day] = (counts[item.day] || 0) + 1;
    if (Object.entries(counts).some(([date, count]) => (value.days[date] || 0) < count)) throw fail('自主分享预算小于已有处理记录，未重置计数。');
    return value;
  }
  policyContacts() {
    const policy = read(path.join(this.stateDir, 'chat-policy.json'), { allowlist: [] });
    if (!Array.isArray(policy?.allowlist) || new Set(policy.allowlist.map(item => item?.id)).size !== policy.allowlist.length || policy.allowlist.some(item => !item || !recipientPattern.test(item.id) || !isStoredContactAuthorized(item))) throw fail('个人与群聊许可名单未通过核对，未允许自主分享。');
    return policy.allowlist;
  }
  recipients() {
    return this.policyContacts().map(({ id, name, isGroup }) => ({ id, name, isGroup }));
  }
  shareableRecipients() {
    return this.policyContacts().filter(item => hasStableConversationIdentity(item)).map(({ id, name, isGroup }) => ({ id, name, isGroup }));
  }
  unavailableRecipients() {
    return this.policyContacts().filter(item => !hasStableConversationIdentity(item)).map(({ id, name, isGroup }) => ({ id, name, isGroup, reason: '缺少稳定会话身份，不能发送原生作品卡片；仍保留在许可名单，不影响观看或回复。' }));
  }
  unresolved(ledger = this.ledger(), except) {
    return ledger.operations.filter(item => item.operationId !== except && ['uncertain', 'reserved', 'clicking'].includes(item.status));
  }
  state() {
    const policy = this.policy(), ledger = this.ledger(), recipients = this.recipients(), shareableRecipients = this.shareableRecipients(), unavailableRecipients = this.unavailableRecipients(), date = day(this.now());
    const unresolved = this.unresolved(ledger), guard = read(this.files.send, null);
    if (guard && (!Number.isSafeInteger(guard.pid) || typeof guard.token !== 'string')) throw fail('自主分享发送锁损坏，请先核对收据。');
    const recoveryRequired = Boolean(guard && !alive(guard.pid)), busy = Boolean(guard && alive(guard.pid));
    const activeOperation = busy && typeof guard.operationId === 'string' && unresolved.find(item => item.operationId === guard.operationId && item.pid === guard.pid && ['reserved', 'clicking'].includes(item.status));
    const needsReview = unresolved.filter(item => item !== activeOperation), inProgress = Boolean(activeOperation);
    const activity = needsReview.length || recoveryRequired ? { status: 'needs-review' } : inProgress ? { status: 'sending', phase: activeOperation.status, operationId: activeOperation.operationId } : { status: 'idle' };
    return { protocol: 'autonomous-share-v1', enabled: policy.enabled, dailyLimit: null, timeZone: 'Asia/Shanghai', daily: { date, attempts: ledger.days[date] || 0, limit: null, remaining: null }, recipients, shareableRecipients, unavailableRecipients, paused: needsReview.length > 0 || recoveryRequired, busy, inProgress, activity, needsReview: needsReview.map(({ operationId, videoId, recipientId, status, forwardOperationId, startedAt, failure }) => ({ operationId, videoId, recipientId, status, forwardOperationId, startedAt, ...(failure ? { failure: failureOf(failure) } : {}) })), recoveryRequired, receiptsFile: this.files.ledger, recent: ledger.operations.slice(-10).map(({ operationId, videoId, recipientId, status, forwardOperationId, messageId, startedAt, completedAt, failure }) => ({ operationId, videoId, recipientId, status, forwardOperationId, messageId, startedAt, completedAt, ...(failure ? { failure: failureOf(failure) } : {}) })) };
  }
  context({ videoId } = {}) {
    const state = this.state();
    const permitted = new Set(state.shareableRecipients.map(item => item.id));
    const processedRecipients = typeof videoId === 'string' && /^\d{1,64}$/.test(videoId) ? [...new Map(this.ledger().operations.filter(item => item.videoId === videoId && permitted.has(item.recipientId) && processedStatuses.has(item.status)).map(({ recipientId, status }) => [recipientId, { recipientId, status }])).values()] : [];
    return { enabled: readFriendInteractionsEnabled(this.stateDir) && state.enabled && !state.paused && !state.busy && !state.inProgress && state.shareableRecipients.length>0, dailyRemaining: null, paused: state.paused, recipients: state.shareableRecipients, unavailableRecipients: state.unavailableRecipients, processedRecipients, deliveryType: 'native-card', currentObservedVideoOnly: true };
  }
  configure(input = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('自主分享许可只能由用户在本机设置。', 403);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['enabled', 'dailyLimit'].includes(key)) || typeof input.enabled !== 'boolean') throw fail('自主分享只接受开关；旧版每日上限参数不再限制次数。', 400);
    this.control(() => {
      const policy = this.policy();
      if (input.enabled) { if (!this.recipients().length) throw fail('请先保存已核对的个人或群聊许可名单，再开启自主分享。'); if (this.unresolved().length || this.state().recoveryRequired) throw fail('上次分享结果需要核对；重新开关不会清除未确认记录。'); }
      write(this.files.policy, { ...policy, enabled: input.enabled, dailyLimit: null });
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
    if(!readFriendInteractionsEnabled(this.stateDir))throw fail('好友互动总开关已关闭，未继续自主分享。');
    const policy = this.policy(), ledger = this.ledger();
    if (!policy.enabled) throw fail('自主分享尚未启用。');
    if (this.unresolved(ledger, operationId).length) throw fail('存在未确认的自主分享，已暂停后续发送。');
    const own = operationId && ledger.operations.find(item => item.operationId === operationId);
    if (own && own.day !== day(this.now())) throw fail('已跨过上海日期，本次预留不转移到新一天，未继续分享。');
    if (!this.shareableRecipients().some(item => item.id === input.recipientId)) throw fail('收件人没有可用于原生作品卡片的稳定身份，未继续分享。', 403);
    this.evidence(input);
    const time = this.videoLimits.state();
    if (!time.allowed || time.session&&time.session.status!=='active' || sessionId && time.session?.id !== sessionId) throw fail(time.reason || '内部观看运行已结束或改变，停止自主分享。');
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
    const token = randomUUID(), operationId = randomUUID(); let descriptor;
    try { descriptor = fs.openSync(this.files.send, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fail('另一个入口正在分享，或上次发送锁需要人工核对。'); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, operationId })); } finally { fs.closeSync(descriptor); }
    const abort = new AbortController(), combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(60_000)]);
    let reserved = false, clicked = false, finished = false, releaseDispatch, sessionId;
    const completion = Promise.withResolvers(); this.active = { abort, completion: completion.promise };
    try {
      const skipped = this.control(() => {
        const time = this.allowed(input, { signal: combined, watchRunId }); sessionId = time.session?.id;
        const ledger = this.ledger();
        const previous = ledger.operations.find(item => item.recipientId === input.recipientId && item.videoId === input.videoId);
        if (previous) {
          if (!processedStatuses.has(previous.status)) throw fail('同一作品对这位好友的分享收据尚未确认，未继续处理。');
          return { status: 'skipped', code: 'SHARE_ALREADY_PROCESSED', skipped: true, confirmed: false, deliveryUncertain: false, videoId: input.videoId, recipientId: input.recipientId, previousStatus: previous.status, reason: '同一作品已为此许可会话处理过，本次跳过分享，继续观看。' };
        }
        const date = day(this.now()); ledger.days[date] = (ledger.days[date] || 0) + 1;
        ledger.operations.push({ operationId, evidenceId: input.evidenceId, videoId: input.videoId, recipientId: input.recipientId, reason: input.reason || '', day: date, source: this.source, pid: process.pid, sessionId, status: 'reserved', startedAt: new Date(this.now()).toISOString() });
        write(this.files.ledger, ledger); reserved = true;
      });
      if (skipped) return skipped;
      const authorize = ({ phase, videoId, recipientId } = {}) => {
        if (finished || recipientId !== input.recipientId || videoId !== input.videoId || !['prepare', 'monitor', 'before-click'].includes(phase)) throw fail('可信分享授权与当前作品或收件人不一致。');
        this.allowed(input, { signal: combined, watchRunId, operationId, sessionId });
        if (phase === 'before-click') { if (clicked) throw fail('这项分享已授权一次点击，未再次发送。'); this.update(operationId, { status: 'clicking' }); clicked = true; }
        return true;
      };
      // 最终短输入与设置写入互斥；设置若遇到此阶段会明确返回忙，不能先报关闭成功再发送。
      authorize.beginDispatch = () => {
        if (finished || !clicked || releaseDispatch) throw fail('当前分享未获得一次有效的最终输入授权。');
        const release = this.acquireControl();let releaseInteractions;
        try { releaseInteractions=acquireFriendInteractionDispatch(this.stateDir);this.allowed(input, { signal: combined, watchRunId, operationId, sessionId }); }
        catch (error) { releaseInteractions?.();release(); throw error; }
        releaseDispatch = ()=>{try{releaseInteractions();}finally{release();}};
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
      const failure = !confirmed ? failureOf(result?.failure || { code: uncertain ? 'SHARE_DELIVERY_UNCERTAIN' : 'SHARE_NOT_SENT', stage: uncertain ? 'receipt' : 'send', message: result?.reason || (uncertain ? '分享结果未确认，请核对收据。' : '没有发出可核对的作品卡片。') }) : null;
      this.update(operationId, { status: confirmed ? 'confirmed' : uncertain ? 'uncertain' : 'not-sent', completedAt: new Date(this.now()).toISOString(), ...(typeof result?.operationId === 'string' ? { forwardOperationId: result.operationId } : {}), ...(confirmed ? { messageId: result.messageId } : { failure }) });
      return { confirmed, deliveryUncertain: uncertain, deliveryType: 'native-card', operationId, videoId: input.videoId, recipientId: input.recipientId, ...(confirmed ? { messageId: result.messageId } : { failure, reason: failure.message }) };
    } catch (error) {
      const failure = failureOf(error);
      const recoverable = reserved && !clicked && !combined.aborted && !error.receiptWarning && error.deliveryUncertain !== true && error.confirmed !== true && isSharePreflightNotSent({ ...error, failure }, input);
      let recorded = false;
      if (reserved) { try { this.update(operationId, { status: clicked ? 'uncertain' : 'not-sent', completedAt: new Date(this.now()).toISOString(), failure, ...(typeof error.forwardOperationId === 'string' ? { forwardOperationId: error.forwardOperationId } : {}), ...(recoverable ? { preflight: error.preflight } : {}) }); recorded = true; } catch { /* 保留预留记录，不能证明未发送时不重试。 */ } }
      if (clicked) return { confirmed: false, deliveryUncertain: true, deliveryType: 'native-card', operationId, videoId: input.videoId, recipientId: input.recipientId, failure, reason: failure.message };
      if (recoverable && recorded) {
        this.allowed(input, { signal: combined, watchRunId, operationId, sessionId });
        return { status: 'not-sent', code: 'SHARE_PREFLIGHT_NOT_SENT', confirmed: false, deliveryUncertain: false, deliveryType: 'native-card', operationId, forwardOperationId: error.forwardOperationId, videoId: input.videoId, recipientId: input.recipientId, preflight: error.preflight, failure, reason: failure.message };
      }
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
