import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { acquireFriendInteractionDispatch } from './friend-interactions-guard.mjs';

const defaults = () => ({ version: 1, enabled: true });
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const active = value => Boolean(value?.running || value?.starting || value?.busy || value?.worker?.alive);
const workerKey = value => value?.worker ? `${value.worker.pid}:${value.worker.runId}` : active(value) ? 'local-active' : '';
const explain = error => String(error?.message || '好友互动暂未就绪，请查看自检。').replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [凭据已隐藏]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[凭据已隐藏]').slice(0, 600);

// 复用既有回复与作品分享服务；总开关不改名单、收据、旧消息基线或预算。
export class FriendInteractions {
  constructor({ stateDir = resolveRuntimePaths().stateDir, getChat, getShare, getSpark, modelReady = () => false, startChat = (chat, { signal }) => chat.start({ schedule: true, signal }), intervalMs = 3000 } = {}) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || typeof getChat !== 'function' || typeof getShare !== 'function' || getSpark !== undefined && typeof getSpark !== 'function' || typeof modelReady !== 'function' || typeof startChat !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 10) throw new TypeError('好友互动需要本机状态目录、现有服务及有效检查间隔。');
    Object.assign(this, { stateDir, getChat, getShare, getSpark, modelReady, startChat, intervalMs });
    this.policyFile = path.join(stateDir, 'friend-interactions-policy.json');
    this.settingsGuard = path.join(stateDir, 'friend-interactions-settings.guard');
    this.timer = null; this.closed = false; this.inflight = null; this.rerun = false; this.startAbort = null;
    this.chat = null; this.share = null; this.spark = null; this.lastError = ''; this.status = 'waiting'; this.lastCheckedAt = null; this.deferUntil = 0;
    this.waitReason = ''; this.lastErrorCode = ''; this.nextRetryAt = null; this.waitKey = ''; this.prepare = null;
    this.chatStopKey = ''; this.sparkStopKey = '';
    this.autoPrepareJob = null; this.prepareGuard = path.join(stateDir, 'friend-interactions-prepare.guard');
    this.prepareBudgetFile = path.join(stateDir, 'friend-interactions-prepare-budget.json');
  }
  clearError() { if (this.lastError) { this.lastError = ''; if (this.status === 'blocked') this.status = 'waiting'; } }
  waitFor(error) {
    const code = error?.code || 'CHAT_START_FAILED', reason = explain(error), now = Date.now(), next = Number.isSafeInteger(error?.retryAt) && error.retryAt > now && error.retryAt <= now + 600_000 ? error.retryAt : now + 60_000;
    this.status = 'waiting'; this.lastError = ''; this.waitReason = reason; this.lastErrorCode = code;
    this.nextRetryAt = new Date(next).toISOString(); this.deferUntil = next;
    this.waitKey = `${code}:${reason}`;
  }
  clearWait() { this.waitReason = ''; this.lastErrorCode = ''; this.nextRetryAt = null; this.waitKey = ''; }

  policy() {
    let value;
    try { value = JSON.parse(fs.readFileSync(this.policyFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return defaults(); throw fail('好友互动总开关记录损坏，已阻止自动启动。'); }
    if (!value || value.version !== 1 || typeof value.enabled !== 'boolean' || Object.keys(value).some(key => !['version', 'enabled'].includes(key))) throw fail('好友互动总开关记录损坏，已阻止自动启动。');
    return { version: 1, enabled: value.enabled };
  }
  abortStart() { this.startAbort?.abort(fail('好友互动总开关已关闭或入口已退出。')); }
  abortPrepare(reason = fail('回复通道准备已取消。')) { const current = this.prepare; if (current && !current.controller.signal.aborted) current.controller.abort(reason); }
  checkRevocation() {
    let enabled = false;
    try { enabled = this.policy().enabled; } catch { /* 损坏记录按关闭处理，不覆盖原文件。 */ }
    const settings = fs.existsSync(this.settingsGuard);
    if (this.closed || !enabled || settings) { this.abortStart(); this.abortPrepare(); }
    return !this.closed && enabled && !settings;
  }
  state() {
    let policy, error = this.lastError, chat, share;
    try { policy = this.policy(); } catch (failure) { policy = { version: 1, enabled: false }; error = explain(failure); }
    try { chat = this.chat?.state(); share = this.share?.state(); } catch (failure) { error ||= explain(failure); }
    const running = active(chat);
    return {
      protocol: 'friend-interactions-v1', policy, enabled: policy.enabled, replyRunning: running, replyStarting: Boolean(chat?.starting),
      shareEnabled: share?.enabled === true, selectedCount: chat?.policy?.allowlist?.length || 0,
      status: this.closed ? 'closed' : error ? 'blocked' : !policy.enabled ? running || share?.enabled ? 'stopping' : 'disabled' : fs.existsSync(this.settingsGuard) ? 'waiting-settings' : this.status,
      lastError: error, waitReason: this.waitReason, lastErrorCode: this.lastErrorCode, nextRetryAt: this.nextRetryAt,
      canPrepare: !this.closed && policy.enabled === true && Boolean(chat?.policy?.allowlist?.length) && !running && !this.prepare,
      preparing: Boolean(this.prepare),
      lastCheckedAt: this.lastCheckedAt, checking: Boolean(this.inflight),
    };
  }
  async configure(input = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('好友互动总开关只能由本人修改。', 403);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'enabled') || typeof input.enabled !== 'boolean') throw fail('好友互动只接受启用开关。', 400);
    if (this.closed) throw fail('好友互动入口已关闭。');
    const release = acquireFriendInteractionDispatch(this.stateDir);
    try {
      const current = this.policy();
      if (!fs.existsSync(this.policyFile) || current.enabled !== input.enabled) {
        const temporary = `${this.policyFile}.${randomUUID()}.tmp`;
        try { fs.writeFileSync(temporary, JSON.stringify({ version: 1, enabled: input.enabled }) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, this.policyFile); }
        finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      if (!input.enabled) this.abortStart();
    } finally { release(); }
    if (!input.enabled) {
      const chat = await this.getChat();
      if (!this.policy().enabled) await chat?.stop?.({ preservePending: false, reason: 'user-stop' });
    }
    if (input.enabled) this.deferUntil = 0;
    return this.reconcile();
  }
  start() {
    if (this.closed) return Promise.resolve(this.state());
    this.deferUntil = 0;
    if (!this.timer) { this.timer = setInterval(() => { if (Date.now() >= this.deferUntil) void this.reconcile(); }, this.intervalMs); this.timer.unref?.(); }
    return this.reconcile();
  }
  reconcile() {
    this.checkRevocation();
    if (this.closed) return Promise.resolve(this.state());
    this.rerun = true;
    if (this.inflight) return this.inflight.then(() => this.state());
    this.inflight = (async () => {
      while (this.rerun && !this.closed) {
        this.rerun = false;
        try { await this.apply(); } catch (error) { this.lastError = explain(error); this.status = 'blocked'; }
        this.lastCheckedAt = new Date().toISOString();
      }
    })().finally(() => { this.inflight = null; });
    return this.inflight.then(() => this.state());
  }
  async services() {
    const [chat, share, spark] = await Promise.all([this.getChat(), this.getShare(), this.getSpark?.()]);
    this.chat = chat; this.share = share; this.spark = spark;
    return Boolean(chat?.state && chat?.start && chat?.stop && share?.state && share?.configure);
  }
  async retireSpark() {
    if (!this.spark) return;
    const state = this.spark.state(), key = workerKey(state);
    if (active(state) && key !== this.sparkStopKey) { await this.spark.stop({ explicit: true }); this.sparkStopKey = key; }
    if (state.enabled || state.policy?.enabled) await this.spark.configure({ enabled: false }, { explicit: true });
  }
  async disable() {
    if (this.closed) return;
    let enabled = false; try { enabled = this.policy().enabled; } catch { /* 损坏总开关停止外发，但不覆盖记录。 */ }
    if (enabled) { if (!fs.existsSync(this.settingsGuard)) this.rerun = true; this.status = fs.existsSync(this.settingsGuard) ? 'waiting-settings' : 'waiting'; return; }
    this.abortStart();
    const errors = [];
    const chatState = this.chat.state(), key = workerKey(chatState);
    if (active(chatState) && key !== this.chatStopKey) {
      try { await this.chat.stop(); this.chatStopKey = key; } catch (error) { errors.push(error); }
    }
    try { if (!this.closed && !this.checkRevocation() && this.share.state().enabled) await this.share.configure({ enabled: false }, { explicit: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw errors[0];
    this.status = active(this.chat.state()) || this.share.state().enabled ? 'stopping' : 'disabled';
  }
  async apply() {
    if (this.prepare && this.prepare.phase !== 'prepared') { this.status = 'preparing'; return; }
    const ready = await this.services();
    if (this.closed) return;
    let sparkError;
    try { await this.retireSpark(); } catch (error) { sparkError = error; }
    if (!ready) { if (sparkError) throw sparkError; this.status = 'waiting-modules'; this.lastError = ''; return; }
    if (fs.existsSync(this.settingsGuard)) { this.abortStart(); this.status = 'waiting-settings'; this.lastError = ''; return; }
    let policy, policyError;
    try { policy = this.policy(); } catch (error) { policyError = error; policy = { enabled: false }; }
    if (!policy.enabled) {
      await this.disable();
      if (policyError || sparkError) throw policyError || sparkError;
      this.lastError = ''; return;
    }
    if (sparkError) throw sparkError;
    if (!this.checkRevocation()) { await this.disable(); return; }
    this.chatStopKey = '';
    const chatState = this.chat.state();
    if (!chatState.policy?.allowlist?.length) { this.status = 'waiting-contacts'; this.lastError = ''; return; }
    if (!active(chatState) && chatState.contacts?.some(item => ['inflight', 'delivery-uncertain'].includes(item.status))) throw fail('好友互动有未确认发送，请先核对原收据；不会重置或重发。');
    const shareState = this.share.state();
    if (!shareState.enabled && !shareState.paused && !shareState.recoveryRequired) {
      try { await this.share.configure({ enabled: true }, { explicit: true }); }
      catch (error) {
        const latestShareState = this.share.state();
        if (!latestShareState.paused && !latestShareState.recoveryRequired) throw error;
      }
      if (!this.checkRevocation()) { await this.disable(); return; }
    }
    if (active(chatState)) { this.status = chatState.starting ? 'starting' : 'running'; this.lastError = ''; this.deferUntil = 0; this.clearWait(); return; }
    if (Date.now() < this.deferUntil) { this.status = 'waiting'; return; }
    if (chatState.contacts?.some(item => ['inflight', 'delivery-uncertain'].includes(item.status))) throw fail('好友互动有未确认发送，请先核对原收据；不会重置或重发。');
    if (!await this.modelReady()) { this.status = 'waiting-model'; this.lastError = ''; return; }
    if (!this.checkRevocation()) { await this.disable(); return; }
    const abort = new AbortController(); this.startAbort = abort; this.status = 'starting';
    try {
      await this.startChat(this.chat, { signal: abort.signal });
      if (!this.checkRevocation() || abort.signal.aborted) { await this.disable(); return; }
      this.status = active(this.chat.state()) ? 'running' : 'waiting'; this.lastError = ''; this.deferUntil = 0; this.clearWait();
    } catch (error) {
      if (!this.checkRevocation() || abort.signal.aborted) { if (!this.closed) await this.disable(); return; }
      // 另一个入口可能已在同一时刻取得现有worker锁；只接受回读，不重新建立基线。
      if (active(this.chat.state())) { this.status = 'running'; this.lastError = ''; this.clearWait(); return; }
      this.waitFor(error); this.queueAutomaticPrepare(error);
    } finally { if (this.startAbort === abort) this.startAbort = null; }
  }
  async close() {
    this.closed = true; clearInterval(this.timer); this.timer = null; this.abortStart(); this.abortPrepare(fail('好友互动入口已关闭。'));
    const pending = this.prepare?.promise;
    if (pending) await pending.catch(() => {});
    await this.inflight;
    await this.autoPrepareJob;
  }
  async configureContacts(input) { return this.withChatPaused(chat => chat.configure(input)); }
  async resumeContact(id) {
    if (typeof id !== 'string' || !id.trim() || id.length > 500) throw fail('请选择已核对的许可会话。', 400);
    const chat = await this.getChat();
    if (!chat?.state?.()?.policy?.allowlist?.some(item => item.id === id)) throw fail('联系人不在当前许可名单。', 403);
    return this.withChatPaused(service => service.resumeContact(id));
  }
  async resolveUnanswered(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('待处理消息请求无效。', 400);
    const chat = await this.getChat();
    if (!chat?.state || !chat?.stop) throw fail('回复服务尚未就绪。', 503);
    return this.withChatPaused(service => service.markUnansweredHandled(input), { reason: 'unanswered-review', resume: 'preserve' });
  }
  queueAutomaticPrepare(error) {
    if (error?.code !== 'CHAT_PAGE_NOT_OPEN' || this.autoPrepareJob || typeof this.chat?.prepareChat !== 'function' || this.closed) return;
    const current = this.inflight;
    const job = Promise.resolve(current).then(async () => {
      if (!this.checkRevocation() || active(this.chat?.state())) return;
      await this.prepareChat({ automatic: true });
    }).catch(failure => { if (!this.closed && this.checkRevocation()) this.waitFor(failure); })
      .finally(() => { if (this.autoPrepareJob === job) this.autoPrepareJob = null; });
    this.autoPrepareJob = job;
  }
  acquirePrepare({ automatic = false } = {}) {
    const releaseControl = acquireFriendInteractionDispatch(this.stateDir);
    const owner = { version: 1, pid: process.pid, token: randomUUID(), startedAt: Date.now() };
    try {
      if (!this.checkRevocation()) throw Object.assign(fail('好友互动已关闭或正在维护，未取得回复准备租约。', 403), { code: 'CHAT_PREPARE_REVOKED' });
      if (fs.existsSync(this.prepareGuard)) {
        let current;
        try { current = JSON.parse(fs.readFileSync(this.prepareGuard, 'utf8')); } catch { throw fail('回复准备锁无法核对，未新建页面。'); }
        if (current?.version !== 1 || !Number.isSafeInteger(current.pid) || current.pid < 1 || typeof current.token !== 'string' || !/^[a-f0-9-]{36}$/.test(current.token) || !Number.isSafeInteger(current.startedAt) || current.startedAt < 0 || current.startedAt > Date.now() + 1000) throw fail('回复准备锁无法核对，未新建页面。');
        let alive = true;
        try { process.kill(current.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else if (error.code !== 'EPERM') throw error; }
        if (alive) throw Object.assign(fail('另一入口正在准备回复通道，稍后自动检查。'), { code: 'CHAT_PREPARE_BUSY' });
        fs.unlinkSync(this.prepareGuard);
      }
      if (automatic) {
        const now = Date.now(); let budget = { version: 1, windowStartedAt: now, attempts: 0, lastAttemptAt: now };
        if (fs.existsSync(this.prepareBudgetFile)) {
          try { budget = JSON.parse(fs.readFileSync(this.prepareBudgetFile, 'utf8')); } catch { throw fail('自动回复准备次数记录无法读取，未新建页面。'); }
          if (budget?.version !== 1 || !Number.isSafeInteger(budget.windowStartedAt) || budget.windowStartedAt < 0 || !Number.isSafeInteger(budget.lastAttemptAt) || !Number.isSafeInteger(budget.attempts) || budget.attempts < 0 || budget.attempts > 3 || budget.windowStartedAt > now + 1000 || budget.lastAttemptAt < budget.windowStartedAt || budget.lastAttemptAt > now + 1000) throw fail('自动回复准备次数记录无法核对，未新建页面。');
          if (now - budget.windowStartedAt >= 600_000) budget = { version: 1, windowStartedAt: now, attempts: 0, lastAttemptAt: now };
        }
        if (budget.attempts >= 3) throw Object.assign(fail('自动准备已暂缓，稍后自动重试，不会反复新建页面。'), { code: 'CHAT_PREPARE_RATE_LIMITED', retryAt: budget.windowStartedAt + 600_000 });
        const temporary = `${this.prepareBudgetFile}.${randomUUID()}.tmp`;
        try { fs.writeFileSync(temporary, JSON.stringify({ ...budget, attempts: budget.attempts + 1, lastAttemptAt: now }) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, this.prepareBudgetFile); }
        finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
      fs.writeFileSync(this.prepareGuard, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
    } finally { releaseControl(); }
    let released = false;
    return () => {
      if (released) return;
      const current = JSON.parse(fs.readFileSync(this.prepareGuard, 'utf8'));
      if (current.pid !== owner.pid || current.token !== owner.token) throw fail('回复准备锁已变化，未删除其他入口的锁。');
      fs.unlinkSync(this.prepareGuard); released = true;
    };
  }

  async prepareChat({ automatic = false } = {}) {
    if (this.closed) throw fail('好友互动入口已关闭。');
    if (this.prepare) return this.prepare.promise;
    const controller = new AbortController();
    const token = randomUUID();
    const timeout = setTimeout(() => controller.abort(Object.assign(fail('准备回复通道超时，请稍后重试。'), { code: 'CHAT_PREPARE_TIMEOUT' })), 60_000); timeout.unref?.();
    this.prepare = { promise: null, controller, token, phase: 'starting' };
    this.status = 'preparing'; this.waitReason = '受管聊天入口准备中，最多打开一个页面。'; this.lastErrorCode = 'CHAT_PREPARING'; this.nextRetryAt = null;
    const promise = (async () => {
      let releasePrepare;
      try {
        const chat = await this.getChat(); this.chat = chat;
        if (!chat?.state || !chat?.prepareChat) throw fail('回复通道准备入口尚未就绪。', 503);
        if (!this.checkRevocation()) throw fail('好友互动总开关已关闭或正在维护，未准备回复通道。', 403);
        if (active(chat.state())) { this.clearWait(); this.status = 'running'; return this.state(); }
        if (automatic && (!chat.state().policy?.allowlist?.length || !await this.modelReady())) return this.state();
        if (!this.checkRevocation()) throw fail('好友互动设置已变化，未自动准备回复通道。', 403);
        const allowedBefore = JSON.stringify(chat.state().policy?.allowlist || []);
        const authorizePrepare = automatic ? async () => {
          controller.signal.throwIfAborted();
          if (!this.checkRevocation()) throw Object.assign(fail('好友互动已关闭或正在维护，已取消自动准备。', 403), { code: 'CHAT_PREPARE_REVOKED' });
          const configured = await this.modelReady();
          if (!configured || !this.checkRevocation()) throw Object.assign(fail('模型或好友互动设置已变化，已取消自动准备。', 403), { code: 'CHAT_PREPARE_REVOKED' });
          const current = JSON.parse(fs.readFileSync(path.join(this.stateDir, 'chat-policy.json'), 'utf8'));
          if (current?.version !== 1 || !Array.isArray(current.allowlist) || !current.allowlist.length || JSON.stringify(current.allowlist) !== allowedBefore) throw Object.assign(fail('许可名单已变化，已取消自动准备。', 403), { code: 'CHAT_PREPARE_REVOKED' });
          controller.signal.throwIfAborted(); return true;
        } : undefined;
        releasePrepare = this.acquirePrepare({ automatic });
        const prepared = await chat.prepareChat({ signal: controller.signal, ...(automatic ? { automatic: true, authorizePrepare } : {}) });
        if (controller.signal.aborted) throw controller.signal.reason || fail('回复通道准备已取消。');
        if (prepared?.blocked || prepared?.loginRequired || prepared?.verificationRequired) { this.waitFor(Object.assign(new Error('专用聊天页需要登录或验证，未自动操作。'), { code: 'CHAT_LOGIN_REQUIRED' })); throw fail('专用聊天页需要登录或验证，未自动操作。', 409); }
        if (!this.checkRevocation()) throw fail('好友互动总开关已关闭或正在维护，准备已停止。', 409);
        this.deferUntil = 0; this.clearWait();
        if (this.prepare?.token === token) this.prepare.phase = 'prepared';
        const settled = await this.reconcile();
        if (this.closed) throw fail('好友互动入口已关闭。', 409);
        return settled;
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason?.code === 'CHAT_PREPARE_TIMEOUT' && !this.closed) this.waitFor(controller.signal.reason);
        else if (!controller.signal.aborted && !this.closed) this.waitFor(error);
        throw error;
      } finally {
        clearTimeout(timeout);
        try { releasePrepare?.(); }
        finally {
          if (this.prepare?.token === token) this.prepare = null;
          if (this.status === 'preparing') this.status = this.lastError ? 'blocked' : this.waitReason ? 'waiting' : this.closed ? 'closed' : 'waiting';
        }
      }
    })();
    this.prepare.promise = promise;
    return promise;
  }
  async withChatPaused(action, { timeoutMs = 60_000, reason = 'settings-update', resume = 'reconcile' } = {}) {
    if (typeof action !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || typeof reason !== 'string' || !reason || reason.length > 80 || !['reconcile', 'preserve'].includes(resume)) throw new TypeError('暂停回复并执行本机操作需要最多60秒的停止等待。');
    if (this.closed) throw fail('好友互动入口已关闭。');
    const releaseControl = acquireFriendInteractionDispatch(this.stateDir), owner = { pid: process.pid, token: randomUUID() };
    try {
      let descriptor;
      try { descriptor = fs.openSync(this.settingsGuard, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw Object.assign(fail('许可名单正在其他入口保存，或设置锁需要核对；本次草稿未保存。'), { code: 'FRIEND_SETTINGS_BUSY' }); throw error; }
      try { fs.writeFileSync(descriptor, JSON.stringify(owner)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      this.abortStart(); this.abortPrepare(fail('设置维护中，准备回复通道已取消。'));
    } finally { releaseControl(); }
    let saved, failure, wasActive = false;
    try {
      const chat = await this.getChat(); this.chat = chat;
      if (!chat?.state || !chat?.stop || !chat?.configure) throw fail('许可名单服务尚未就绪，草稿未保存。');
      wasActive = active(chat.state());
      const deadline = Date.now() + timeoutMs; let stoppedKey;
      while (active(chat.state())) {
        if (this.closed) throw fail('当前入口已退出，草稿未保存。');
        if (Date.now() >= deadline) throw fail('等待回复任务停止超过60秒，草稿未保存；请核对原任务状态。');
        const key = workerKey(chat.state());
        if (stoppedKey !== key) { await chat.stop({ preservePending: true, reason }); stoppedKey = key; }
        if (active(chat.state())) await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
      if (this.closed) throw fail('当前入口已退出，草稿未保存。');
      saved = await action(chat);
    } catch (error) { failure = error; this.lastError = explain(error); }
    finally {
      let current;
      try { current = JSON.parse(fs.readFileSync(this.settingsGuard, 'utf8')); } catch { /* 锁损坏时保留，不抢占或删除。 */ }
      if (current?.pid === owner.pid && current.token === owner.token) fs.unlinkSync(this.settingsGuard);
      else failure ||= fail('许可设置锁已变化，已保留记录，请核对保存结果。');
    }
    if (failure) {
      if (resume === 'preserve' && wasActive && !this.closed && typeof this.chat?.resumeAfterMaintenance === 'function') {
        try { await this.chat.resumeAfterMaintenance(); }
        catch (error) { this.lastError = explain(error); }
      }
      throw failure;
    }
    if (!this.closed) {
      if (resume === 'preserve' && wasActive && this.policy().enabled) {
        if (typeof this.chat?.resumeAfterMaintenance !== 'function') {
          this.lastError = '回复服务未提供不重建基线的恢复入口，已保留处理结果并停止回复。';
        } else {
          try { await this.chat.resumeAfterMaintenance(); }
          catch (error) {
            const warning = explain(error);
            this.lastError = warning;
            if (saved && typeof saved === 'object') saved = { ...saved, resumeWarning: warning };
          }
        }
      } else if (resume !== 'preserve') {
        await this.reconcile();
      }
    }
    return saved;
  }
}
