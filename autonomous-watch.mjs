import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiAgent, redact, watchDecisionMessages } from './api-agent.mjs?v=6';
import { resolveRuntimePaths } from './runtime-paths.mjs';

export const WATCH_LIMITS = Object.freeze({ maxRequests: 30, hardMaxRequests: 100, dailyLimit: 200, sampleSeconds: 3 });
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('自主观看状态文件损坏，未重置预算或运行锁。'); } };
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } };
const day = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const failure = (message, watchStatus = 'failed') => Object.assign(new Error(message), { watchStatus });

// API 与原生入口通过同一锁、有限视频轮次和持久预算协调，不在重启时恢复循环。
export class AutonomousWatch {
  constructor({ controller, config = {}, videoLimits, personaMemory, agent, decisionProvider, stateDir = resolveRuntimePaths().stateDir, source = 'api', fetchImpl = fetch, now = Date.now, delayImpl = (ms, signal) => delay(ms, undefined, { signal }), onEvent = () => {} } = {}) {
    if (!controller?.execute || !videoLimits?.state || !personaMemory?.context || !['api', 'dsh'].includes(source)) throw new Error('自主观看缺少浏览器、时限或共同人格接口。');
    Object.assign(this, { controller, config, videoLimits, personaMemory, decisionProvider, stateDir, source, now, delayImpl, onEvent });
    this.agent = agent || new ApiAgent({ controller, config, personaMemory, fetchImpl });
    fs.mkdirSync(stateDir, { recursive: true });
    this.files = Object.fromEntries(['lock', 'guard', 'budget', 'state', 'stop'].map(name => [name, path.join(stateDir, `watch-${name === 'lock' ? 'loop.lock' : name === 'guard' ? 'control.guard' : name === 'stop' ? 'stop.request.json' : name + '.json'}`)]));
    this.files.manual = path.join(stateDir, 'watch-manual.lock');
    this.running = false; this.completion = null; this.abort = null; this.runId = null; this.sessionId = null;
  }
  control(action) {
    let descriptor; const token = randomUUID();
    try { descriptor = fs.openSync(this.files.guard, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('自主观看控制记录正被使用，请稍后重试。'), { status: 409, code: 'WATCH_CONTROL_BUSY' }); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    try { return action(); } finally { const current = read(this.files.guard, null); if (current?.token === token && current.pid === process.pid) fs.unlinkSync(this.files.guard); }
  }
  worker() {
    const worker = read(this.files.lock, null);
    if (!worker) return null;
    if (worker.version !== 1 || typeof worker.runId !== 'string' || typeof worker.sessionId !== 'string' || !['api', 'dsh'].includes(worker.source) || !Number.isSafeInteger(worker.pid)) throw new Error('自主观看锁格式无效，请核对原记录。');
    return { ...worker, alive: alive(worker.pid), owned: worker.runId === this.runId && worker.pid === process.pid };
  }
  budget() {
    const value = read(this.files.budget, { version: 1, sessions: {}, days: {} });
    if (!value || value.version !== 1 || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions) || !value.days || typeof value.days !== 'object' || Array.isArray(value.days) || Object.values(value.sessions).some(item => !item || !Number.isSafeInteger(item.requests) || item.requests < 0 || !Number.isSafeInteger(item.maxRequests) || item.maxRequests < 1 || item.maxRequests > WATCH_LIMITS.hardMaxRequests) || Object.values(value.days).some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error('自主观看预算损坏，未重新计数。');
    return value;
  }
  state() {
    const worker = this.worker(), saved = read(this.files.state, {}), time = this.videoLimits.state();
    const sessionId = worker?.sessionId || time.session?.id || saved.sessionId || null;
    const budget = this.budget(), counts = budget.sessions[sessionId] || { requests: 0, maxRequests: WATCH_LIMITS.maxRequests };
    const request = read(this.files.stop, null), stopping = worker?.alive && request?.runId === worker.runId;
    return redact({ protocol: 'autonomous-watch-v1', running: Boolean(worker?.alive), owned: Boolean(worker?.owned), worker, status: stopping ? 'stopping' : worker?.alive ? 'running' : ['running', 'stopping'].includes(saved.status) ? 'stopped' : saved.status || 'stopped', sessionId, counts: { ...counts, dailyRequests: budget.days[day(this.now())] || 0, dailyLimit: WATCH_LIMITS.dailyLimit }, lastDecision: saved.lastDecision || null, lastError: saved.lastError || '', remainingSeconds: time.allowed && time.session?.id === sessionId ? time.remainingSeconds : 0 }, [this.config.apiKey]);
  }
  save(value) { write(this.files.state, redact({ ...read(this.files.state, {}), ...value, source: this.source, sessionId: this.sessionId, updatedAt: new Date(this.now()).toISOString() }, [this.config.apiKey])); }
  assertAllowed() {
    this.abort?.signal.throwIfAborted();
    const worker = this.worker(); if (!worker?.owned) throw failure('自主观看已失去运行锁，停止操作。');
    const time = this.videoLimits.state();
    if (!time.allowed || time.session?.id !== this.sessionId) throw failure(time.reason || '视频轮次已变化，原自主观看已停止。', 'limited');
    return time;
  }
  reserveRequest() {
    return this.control(() => {
      this.assertAllowed(); const budget = this.budget(), session = budget.sessions[this.sessionId];
      if (!session || session.requests >= session.maxRequests) throw failure('本轮自主观看模型请求预算已用完；停止或重启不会重置预算。', 'limited');
      const key = day(this.now()); if ((budget.days[key] || 0) >= WATCH_LIMITS.dailyLimit) throw failure('今天的自主观看请求预算已用完。', 'limited');
      session.requests++; budget.days[key] = (budget.days[key] || 0) + 1; write(this.files.budget, budget); return session.requests;
    });
  }
  claimManual(kind) {
    const token = randomUUID();
    this.control(() => {
      if (this.worker()) throw Object.assign(new Error('请先停止共享自主观看，再执行手动任务。'), { status: 409 });
      const manual = read(this.files.manual, null);
      if (manual && alive(manual.pid)) throw Object.assign(new Error('另一个入口的手动任务或转发仍在执行。'), { status: 409 });
      write(this.files.manual, { pid: process.pid, token, kind });
    });
    return async () => {
      for (let attempt = 0; ; attempt++) {
        try { return this.control(() => { const manual = read(this.files.manual, null); if (manual?.pid === process.pid && manual.token === token) fs.unlinkSync(this.files.manual); }); }
        catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY' || attempt >= 100) throw error; await delay(20); }
      }
    };
  }
  start({ startSession = false, maxRequests = WATCH_LIMITS.maxRequests } = {}, { explicit = false } = {}) {
    if (!explicit) throw Object.assign(new Error('自主观看只能由用户明确启动。'), { status: 403 });
    if (typeof startSession !== 'boolean' || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > WATCH_LIMITS.hardMaxRequests) throw Object.assign(new Error('自主观看请求上限须为1至100的整数。'), { status: 400 });
    if (!this.decisionProvider && !this.config.apiKey) throw Object.assign(new Error('请先配置 API Key，再启动自主观看。'), { status: 400 });
    if (this.running || this.completion) throw Object.assign(new Error('当前自主观看正在执行或结束。'), { status: 409 });
    read(this.files.state, {});
    this.control(() => {
      const worker = this.worker(); if (worker) throw Object.assign(new Error(worker.alive ? '另一个入口已有自主观看运行。' : '上次自主观看留下运行锁，请先点击停止清理残留。'), { status: 409 });
      const manual = read(this.files.manual, null); if (manual && alive(manual.pid)) throw Object.assign(new Error('另一个入口正在运行手动任务或转发。'), { status: 409 });
      if ((this.budget().days[day(this.now())] || 0) >= WATCH_LIMITS.dailyLimit) throw Object.assign(failure('今天的自主观看预算已用完。', 'limited'), { status: 409 });
      let time = this.videoLimits.state();
      if (!time.allowed && startSession) time = this.videoLimits.markSession(this.source, { explicit: true });
      if (!time.allowed) throw Object.assign(new Error(time.reason || '请先开启有限视频轮次。'), { status: 409 });
      const budget = this.budget(), session = budget.sessions[time.session.id];
      if (session) session.maxRequests = Math.min(session.maxRequests, maxRequests);
      else budget.sessions[time.session.id] = { requests: 0, maxRequests };
      if (budget.sessions[time.session.id].requests >= budget.sessions[time.session.id].maxRequests || (budget.days[day(this.now())] || 0) >= WATCH_LIMITS.dailyLimit) throw Object.assign(failure('当前自主观看预算已用完，未重新开始或重置预算。', 'limited'), { status: 409 });
      this.personaMemory.initialize?.({ importLegacy: false });
      write(this.files.budget, budget);
      this.runId = randomUUID(); this.sessionId = time.session.id;
      write(this.files.lock, { version: 1, pid: process.pid, runId: this.runId, sessionId: this.sessionId, source: this.source, status: 'running', heartbeatAt: this.now() });
    });
    this.abort = new AbortController(); this.running = true;
    try {
    this.save({ status: 'running', lastError: '', lastDecision: null });
    this.heartbeat = setInterval(() => {
      try {
        const request = read(this.files.stop, null); if (request?.runId === this.runId) this.abort.abort(failure('用户停止自主观看。', 'stopped'));
        this.assertAllowed();
        this.control(() => { const worker = this.worker(); if (!worker?.owned) throw failure('自主观看锁已改变。'); write(this.files.lock, { ...worker, heartbeatAt: this.now() }); });
      } catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY') this.abort.abort(error); }
    }, 500); this.heartbeat.unref?.();
    const remaining = this.videoLimits.state().session.expiresAt - this.now();
    this.deadline = setTimeout(() => this.abort.abort(failure('本轮刷视频时间已用完。', 'limited')), Math.max(1, Math.min(remaining, 2_147_483_647))); this.deadline.unref?.();
    this.completion = Promise.resolve().then(() => this.run()).catch(error => { this.onEvent({ type: 'watch.failed', message: redact(error.message || String(error), [this.config.apiKey]) }); return { running: false, status: 'failed' }; }).finally(() => { this.completion = null; });
    return this.state();
    } catch (error) {
      clearInterval(this.heartbeat); clearTimeout(this.deadline); this.running = false;
      this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); this.runId = null;
      throw error;
    }
  }
  async execute(name, args = {}) {
    this.assertAllowed();
    const output = await this.controller.execute(name, args, { signal: this.abort.signal, autonomousRunId: this.runId }); this.assertAllowed();
    const state = output?.state || output;
    if (state?.loginRequired || state?.verificationRequired || state?.blocked || state?.privateChatVisible || state?.unsupportedPage) throw failure('抖音页面需要手动处理，已停止自主观看。', 'needs_user');
    this.onEvent(redact({ type: 'watch.tool', tool: name, result: output }, [this.config.apiKey]));
    return output;
  }
  cancel(reason = failure('自主观看已取消。', 'stopped')) { if (this.worker()?.owned) this.abort?.abort(reason); }
  async run() {
    let status = 'stopped', lastError = '';
    try {
      let current = await this.execute('douyin_status');
      if (!(current.state || current).video?.id) current = await this.execute('douyin_open');
      while (true) {
        this.assertAllowed();
        const budget = this.budget();
        if (budget.sessions[this.sessionId].requests >= budget.sessions[this.sessionId].maxRequests || (budget.days[day(this.now())] || 0) >= WATCH_LIMITS.dailyLimit) throw failure('自主观看请求预算已用完。', 'limited');
        if ((current.state || current).video?.paused !== false) await this.execute('douyin_play');
        const observation = await this.execute('douyin_observe', { seconds: WATCH_LIMITS.sampleSeconds });
        const context = this.personaMemory.context();
        watchDecisionMessages(observation, { context });
        const evidenceId = observation.personaEvidenceId || observation.state?.personaEvidenceId || this.personaMemory.recordObservation(observation, { source: this.source, kind: 'visual' }).evidenceId;
        this.reserveRequest();
        const result = await this.agent.decideWatch({ observation, context, signal: this.abort.signal, decisionProvider: this.decisionProvider });
        this.assertAllowed();
        const decision = redact(result.decision, [this.config.apiKey]);
        if (decision.topics.length) this.personaMemory.updateAgentInterests({ evidenceId, topics: decision.topics, reflection: decision.reflection }, { source: this.source });
        this.save({ lastDecision: decision, usage: result.usage }); this.onEvent({ type: 'watch.decision', decision, usage: result.usage });
        if (decision.action === 'stop') break;
        if (decision.action === 'skip') {
          current = await this.execute('douyin_next'); if (current.changed !== true) throw failure('未确认切换到另一条作品，已停止自主观看。');
        } else if (decision.action === 'search') {
          const found = await this.execute('douyin_search', { query: decision.query });
          const first = (found.state || found).searchResults?.find(item => Number.isSafeInteger(item.index) && item.index >= 0);
          if (!first) throw failure('搜索没有返回可核对的作品，已停止自主观看。');
          current = await this.execute('douyin_open_video', { index: first.index });
        } else {
          await this.delayImpl(decision.seconds * 1000, this.abort.signal); this.assertAllowed(); current = observation;
        }
      }
    } catch (error) {
      const reason = this.abort?.signal.aborted ? this.abort.signal.reason || error : error;
      status = reason.watchStatus || 'failed'; lastError = redact(reason.message || String(reason), [this.config.apiKey]);
    } finally {
      clearInterval(this.heartbeat); clearTimeout(this.deadline);
      try { if (this.worker()?.owned) await this.controller.pauseForLimits?.(); } catch (error) { status = 'failed'; lastError ||= redact(error.message, [this.config.apiKey]); }
      try {
        for (let attempt = 0; ; attempt++) {
          try { this.control(() => { const worker = this.worker(); if (worker?.owned) { this.save({ status, lastError }); fs.unlinkSync(this.files.lock); const request = read(this.files.stop, null); if (request?.runId === this.runId) fs.unlinkSync(this.files.stop); } }); break; }
          catch (error) { if (error.code !== 'WATCH_CONTROL_BUSY' || attempt >= 100) throw error; await delay(20); }
        }
      } catch (error) { status = 'failed'; lastError ||= error.message; }
      this.running = false; if (!this.worker()?.owned) this.runId = null;
      this.onEvent({ type: `watch.${status}`, message: lastError || '自主观看已停止。' });
    }
    return this.state();
  }
  async stop({ explicit = false } = {}) {
    if (!explicit) throw Object.assign(new Error('停止共享自主观看需要用户明确操作。'), { status: 403 });
    const worker = this.worker();
    if (worker?.owned) { this.abort?.abort(failure('用户停止自主观看。', 'stopped')); await this.completion; if (!this.running && this.worker()?.owned) this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); }
    else if (worker?.alive) this.control(() => { const current = this.worker(); if (current?.runId === worker.runId) write(this.files.stop, { runId: worker.runId, requestedAt: this.now() }); });
    else if (worker) this.control(() => { if (this.worker()?.runId === worker.runId) { fs.unlinkSync(this.files.lock); write(this.files.state, { status: 'stopped', sessionId: worker.sessionId, source: worker.source, lastError: '已清理退出进程的残留锁，预算继续保留。' }); } });
    return this.state();
  }
  async close() { if (this.worker()?.owned) { this.abort?.abort(failure('本入口已关闭。', 'stopped')); await this.completion; if (!this.running && this.worker()?.owned) this.control(() => { if (this.worker()?.owned) fs.unlinkSync(this.files.lock); }); } }
}
