import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';

const actions = ['like', 'favorite'];
const fail = (message, code = 'REACTION_BLOCKED') => Object.assign(new Error(message), { status: 409, code });
const id = value => typeof value === 'string' && /^\d{1,64}$/.test(value);
function read(file, fallback) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304) throw fail('点赞收藏记录无法核对。');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw fail('点赞收藏记录无法核对，未清空历史。'); }
}
function write(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export class VideoReactions {
  constructor({ controller, personaMemory, videoLimits, stateDir = resolveRuntimePaths().stateDir, source = 'api', react, now = Date.now } = {}) {
    if (!personaMemory?.snapshot || !videoLimits?.state || !['api', 'dsh'].includes(source)) throw new TypeError('点赞收藏缺少作品证据或观看时限。');
    Object.assign(this, { controller, personaMemory, videoLimits, stateDir, source, reactImpl: react, now });
    this.files = Object.fromEntries(['policy', 'ledger', 'control', 'send'].map(name => [name, path.join(stateDir, `reactions-${name}.${['control', 'send'].includes(name) ? 'guard' : 'json'}`)]));
    this.active = null; this.closed = false;
  }
  acquireControl() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const token = randomUUID(); let descriptor;
    try { descriptor = fs.openSync(this.files.control, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fail('点赞收藏正在处理，请稍后再试。'); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    let released = false;
    return () => { if (released) return; released = true; const current = read(this.files.control, null); if (current?.token === token && current.pid === process.pid) fs.unlinkSync(this.files.control); };
  }
  control(action) { const release = this.acquireControl(); try { return action(); } finally { release(); } }
  policy() {
    const policy = read(this.files.policy, { version: 1, like: false, favorite: false });
    if (policy?.version !== 1 || actions.some(key => typeof policy[key] !== 'boolean')) throw fail('点赞收藏设置无效，未启用互动。');
    return policy;
  }
  ledger() {
    const ledger = read(this.files.ledger, { version: 1, operations: [] });
    if (ledger?.version !== 1 || !Array.isArray(ledger.operations) || ledger.operations.some(item => !item || !id(item.videoId) || !actions.includes(item.action) || !['reserved', 'clicking', 'confirmed', 'already-active', 'not-sent', 'uncertain'].includes(item.status) || typeof item.operationId !== 'string') || new Set(ledger.operations.map(item => `${item.videoId}:${item.action}`)).size !== ledger.operations.length) throw fail('点赞收藏回执损坏，未重置历史。');
    return ledger;
  }
  state() {
    const policy = this.policy(), ledger = this.ledger();
    return { protocol: 'video-reactions-v1', policy: { like: policy.like, favorite: policy.favorite }, paused: ledger.operations.some(item => ['reserved', 'clicking', 'uncertain'].includes(item.status)) || Boolean(read(this.files.send, null)), recent: ledger.operations.slice(-20).map(({ action, videoId, status, operationId }) => ({ action, videoId, status, operationId })) };
  }
  context(videoId) {
    const state = this.state(), operations = this.ledger().operations;
    return Object.fromEntries(actions.map(action => [action, state.policy[action] && !state.paused && !operations.some(item => item.videoId === videoId && item.action === action)]));
  }
  configure(input, { explicit = false } = {}) {
    if (!explicit) throw fail('点赞收藏开关只能由用户设置。');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || actions.some(key => typeof input[key] !== 'boolean') || Object.keys(input).some(key => !actions.includes(key))) throw Object.assign(fail('点赞收藏只接受两个布尔开关。'), { status: 400 });
    this.control(() => write(this.files.policy, { version: 1, ...input }));
    if (this.active && !input[this.active.action]) this.active.abort.abort(fail('用户已关闭这项互动。', 'REACTION_DISABLED'));
    return this.state();
  }
  allowed(input, { watchRunId, operationId, signal, sessionId } = {}) {
    signal?.throwIfAborted();
    if (this.closed || !this.policy()[input.action]) throw fail('点赞收藏未启用或入口已关闭。', 'REACTION_DISABLED');
    const time = this.videoLimits.state(), worker = read(path.join(this.stateDir, 'watch-loop.lock'), null);
    if (!time.allowed || time.session?.status !== 'active' || !time.session.id || sessionId && time.session.id !== sessionId || !watchRunId || worker?.pid !== process.pid || worker.source !== this.source || worker.runId !== watchRunId || worker.sessionId !== time.session.id || worker.status !== 'running') throw fail('点赞收藏只作用于当前入口正在运行的同一自主观看。');
    if (read(path.join(this.stateDir, 'watch-stop.request.json'), null)?.runId === watchRunId) throw fail('用户已停止观看。');
    if (this.ledger().operations.some(item => item.operationId !== operationId && ['reserved', 'clicking', 'uncertain'].includes(item.status))) throw fail('上次互动尚未确认，不自动重试。');
    const observation = this.personaMemory.snapshot().recentObservations?.find(item => item.id === input.evidenceId);
    if (!observation || observation.videoId !== input.videoId || observation.url !== `https://www.douyin.com/video/${input.videoId}` || !observation.sources?.includes(this.source) || observation.privacy !== 'internal-reference' || observation.visibility !== 'account-visible-unverified') throw fail('没有当前入口对同一作品的真实观察。');
    return time.session.id;
  }
  update(operationId, patch) {
    this.control(() => { const ledger = this.ledger(), item = ledger.operations.find(item => item.operationId === operationId); if (!item) throw fail('互动预留记录丢失。'); Object.assign(item, patch); write(this.files.ledger, ledger); });
  }
  async react(input, { signal, watchRunId } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'videoId', 'evidenceId'].includes(key)) || !actions.includes(input.action) || !id(input.videoId) || !/^video:[a-f0-9]{64}$/.test(input.evidenceId || '')) throw fail('点赞收藏必须绑定宿主实际观察的作品。');
    input = { ...input };
    this.allowed(input, { signal, watchRunId });
    const existing = this.ledger().operations.find(item => item.videoId === input.videoId && item.action === input.action);
    if (existing) return { confirmed: false, skipped: true, code: 'REACTION_ALREADY_PROCESSED', status: existing.status };
    fs.mkdirSync(this.stateDir, { recursive: true });
    const operationId = randomUUID(); let descriptor;
    try { descriptor = fs.openSync(this.files.send, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fail('另一个入口正在互动，未重复执行。'); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token: operationId })); } finally { fs.closeSync(descriptor); }
    const abort = new AbortController(), combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(20_000)]), completion = Promise.withResolvers();
    let reserved = false, clicking = false, finished = false, sessionId, releaseDispatch;
    this.active = { action: input.action, abort, completion: completion.promise };
    try {
      this.control(() => {
        sessionId = this.allowed(input, { signal: combined, watchRunId });
        const ledger = this.ledger();
        if (ledger.operations.some(item => item.videoId === input.videoId && item.action === input.action)) throw fail('同一作品已处理，未重复点击。');
        ledger.operations.push({ ...input, operationId, status: 'reserved', source: this.source, sessionId, startedAt: new Date(this.now()).toISOString() });
        write(this.files.ledger, ledger); reserved = true;
      });
      const authorize = ({ phase, videoId, action } = {}) => {
        if (finished || videoId !== input.videoId || action !== input.action || !['prepare', 'before-click', 'monitor'].includes(phase)) throw fail('互动授权与当前作品不一致。');
        this.allowed(input, { signal: combined, watchRunId, operationId, sessionId });
        if (phase === 'before-click') { if (clicking) throw fail('本次互动已授权一次点击。'); this.update(operationId, { status: 'clicking' }); clicking = true; }
        return true;
      };
      authorize.beginDispatch = () => {
        if (finished || !clicking || releaseDispatch) throw fail('互动缺少唯一的最终点击许可。');
        const release = this.acquireControl();
        try { this.allowed(input, { signal: combined, watchRunId, operationId, sessionId }); } catch (error) { release(); throw error; }
        releaseDispatch = release;
        return () => { releaseDispatch?.(); releaseDispatch = null; };
      };
      const react = this.reactImpl || (async (request, controls) => {
        const { reactToVideo } = await import('./reaction-browser.mjs');
        return reactToVideo(this.controller, request, controls);
      });
      const result = await react({ action: input.action, expectedVideoId: input.videoId }, { signal: combined, authorize });
      const valid = result?.videoId === input.videoId && result.action === input.action && result.active === true && result.verified === true;
      const confirmed = clicking && valid && result.alreadyActive !== true;
      const already = !clicking && valid && result.alreadyActive === true;
      const uncertain = !confirmed && !already && (clicking || result?.deliveryUncertain === true);
      this.update(operationId, { status: confirmed ? 'confirmed' : already ? 'already-active' : uncertain ? 'uncertain' : 'not-sent', completedAt: new Date(this.now()).toISOString() });
      return { confirmed, alreadyActive: already, deliveryUncertain: uncertain, operationId, action: input.action, videoId: input.videoId };
    } catch (error) {
      if (reserved) this.update(operationId, { status: clicking ? 'uncertain' : 'not-sent', completedAt: new Date(this.now()).toISOString() });
      if (clicking) return { confirmed: false, deliveryUncertain: true, operationId, action: input.action, videoId: input.videoId };
      throw error;
    } finally {
      finished = true;
      try { releaseDispatch?.(); const owner = read(this.files.send, null); if (owner?.token === operationId) fs.unlinkSync(this.files.send); }
      finally { this.active = null; completion.resolve(); }
    }
  }
  async close() { this.closed = true; this.active?.abort.abort(fail('入口已关闭。')); await this.active?.completion; }
}
