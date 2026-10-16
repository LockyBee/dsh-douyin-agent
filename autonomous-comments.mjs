import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const day = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const identifier = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const videoPattern = /^\d{1,64}$/, evidencePattern = /^video:[a-f0-9]{64}$/;
const videoIdentity = value => typeof value === 'string' && videoPattern.test(value);
const statuses = new Set(['reserved', 'clicking', 'confirmed', 'not-sent', 'uncertain', 'resolved-confirmed', 'resolved-not-sent']);
function read(file, fallback) {
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4_194_304) throw Error(); return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw fail('自主评论记录无法核对，未重置许可、预算或待核对收据。'); }
}
function write(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { const descriptor = fs.openSync(temporary, 'wx', 0o600); try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function validateCommentText(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 200 || /[\x00-\x1f\x7f\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/.test(value)) throw fail('评论须为 1 至 200 字的单段纯文字。', 400);
  const text = value.trim(), folded = text.normalize('NFKC');
  if (/[@＠]|https?:|www\.|(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|dev|app|me|top|xyz|co|tv)\b|(?:\d[\s-]*){7,}|sk[-_][a-z0-9_-]{6,}|api[\s_-]*key|token|cookie|password|密钥|口令|验证码|身份证|手机号|手机号码|QQ|微信|私信|联系人|好友|账号/iu.test(folded)) throw fail('公开评论不能包含@、链接、联系方式、密钥或私人聊天与好友信息。', 400);
  if (/(?:我|我们|大肥鱼).{0,8}(?:保证|承诺|负责|一定(?:会|帮|给|送)|会(?:联系|见面|到场|付款|购买|送|转账|打钱|帮你))|(?:我|我们).{0,6}(?:亲自|实测|用过|去过|见过|买过|吃过|听完|看完)/u.test(folded)) throw fail('评论只能谈当前有限观察，不能编造现实经历或作现实承诺。', 400);
  return text;
}

// 只在已开始的有限自主观看中评论当前观察作品；共享预算和去重记录不因重启重置。
export class AutonomousComments {
  constructor({ personaMemory, videoLimits, controller, getCommenter, post, stateDir = resolveRuntimePaths().stateDir, source = 'api', now = Date.now } = {}) {
    if (!personaMemory?.snapshot || !videoLimits?.state || !['api', 'dsh'].includes(source) || typeof now !== 'function' || post !== undefined && typeof post !== 'function') throw new TypeError('自主评论缺少观察证据、有限视频时钟或可信发布接口。');
    Object.assign(this, { personaMemory, videoLimits, controller, getCommenter, post, stateDir, source, now });
    this.files = Object.fromEntries(['policy', 'ledger', 'control', 'send'].map(name => [name, path.join(stateDir, `comments-${name}${['control', 'send'].includes(name) ? '.guard' : '.json'}`)]));
    this.active = null; this.closed = false;
  }
  acquireControl() {
    fs.mkdirSync(this.stateDir, { recursive: true }); const owner = { pid: process.pid, token: randomUUID() }; let descriptor;
    try { descriptor = fs.openSync(this.files.control, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fail('自主评论设置或最终输入仍在处理，请稍后重试；未宣称设置已生效。'); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify(owner)); } finally { fs.closeSync(descriptor); }
    let released = false;
    return () => { if (released) return; released = true; const current = read(this.files.control, null); if (current?.pid === owner.pid && current.token === owner.token) fs.unlinkSync(this.files.control); };
  }
  control(action) { const release = this.acquireControl(); try { return action(); } finally { release(); } }
  policy() {
    const value = read(this.files.policy, { version: 1, enabled: false, dailyLimit: 3, perSessionLimit: 1 });
    if (!value || value.version !== 1 || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.dailyLimit) || value.dailyLimit < 1 || value.dailyLimit > 20 || !Number.isSafeInteger(value.perSessionLimit) || value.perSessionLimit < 1 || value.perSessionLimit > 3) throw fail('自主评论许可或次数上限损坏，未继续评论。');
    return value;
  }
  ledger() {
    const value = read(this.files.ledger, { version: 1, days: {}, sessions: {}, operations: [] });
    if (!value || value.version !== 1 || !value.days || typeof value.days !== 'object' || Array.isArray(value.days) || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions) || [...Object.values(value.days), ...Object.values(value.sessions)].some(count => !Number.isSafeInteger(count) || count < 0) || !Array.isArray(value.operations) || value.operations.some(item => !item || !identifier(item.operationId) || !statuses.has(item.status) || !videoIdentity(item.videoId) || !evidencePattern.test(item.evidenceId) || !identifier(item.sessionId) || !identifier(item.runId) || !/^\d{4}-\d{2}-\d{2}$/.test(item.day) || !['api', 'dsh'].includes(item.source) || !Number.isSafeInteger(item.pid) || item.pid < 1 || typeof item.text !== 'string' || [...item.text].length < 1 || [...item.text].length > 200 || item.status === 'confirmed' && !identifier(item.commentId)) || new Set(value.operations.map(item => item.operationId)).size !== value.operations.length || new Set(value.operations.map(item => item.videoId)).size !== value.operations.length) throw fail('自主评论预算或收据损坏，未重新计数。');
    const days = {}, sessions = {};
    for (const operation of value.operations) { days[operation.day] = (days[operation.day] || 0) + 1; sessions[operation.sessionId] = (sessions[operation.sessionId] || 0) + 1; }
    if (Object.entries(days).some(([key, count]) => (value.days[key] || 0) < count) || Object.entries(sessions).some(([key, count]) => (value.sessions[key] || 0) < count)) throw fail('评论预算小于已有处理记录，未重置次数。');
    return value;
  }
  unresolved(ledger = this.ledger(), except) { return ledger.operations.filter(item => item.operationId !== except && ['reserved', 'clicking', 'uncertain'].includes(item.status)); }
  state() {
    const policy = this.policy(), ledger = this.ledger(), date = day(this.now()), time = this.videoLimits.state(), sessionId = time.session?.id || null, guard = read(this.files.send, null);
    if (guard && (!Number.isSafeInteger(guard.pid) || guard.pid < 1 || !identifier(guard.token))) throw fail('评论发送锁损坏，请先核对收据。');
    const recoveryRequired = Boolean(guard && !alive(guard.pid)), unresolved = this.unresolved(ledger);
    return { protocol: 'autonomous-comments-v1', enabled: policy.enabled, policy: { enabled: policy.enabled, dailyLimit: policy.dailyLimit, perSessionLimit: policy.perSessionLimit }, timeZone: 'Asia/Shanghai', daily: { date, attempts: ledger.days[date] || 0, remaining: Math.max(0, policy.dailyLimit - (ledger.days[date] || 0)) }, session: { id: sessionId, attempts: sessionId ? ledger.sessions[sessionId] || 0 : 0, remaining: sessionId ? Math.max(0, policy.perSessionLimit - (ledger.sessions[sessionId] || 0)) : 0 }, paused: unresolved.length > 0 || recoveryRequired, busy: Boolean(guard && alive(guard.pid)), recoveryRequired, needsReview: unresolved.map(({ operationId, videoId, sessionId, status, startedAt, browserOperationId }) => ({ operationId, videoId, sessionId, status, startedAt, browserOperationId })), recent: ledger.operations.slice(-10).map(({ operationId, videoId, sessionId, status, startedAt, completedAt, text, commentId }) => ({ operationId, videoId, sessionId, status, startedAt, completedAt, text, commentId })), receiptsFile: this.files.ledger };
  }
  context() { const state = this.state(); return { enabled: Boolean(state.enabled && !state.paused && state.daily.remaining > 0 && state.session.remaining > 0 && this.videoLimits.state().allowed), remainingDaily: state.daily.remaining, remainingSession: state.session.remaining, paused: state.paused, maxTextLength: 200 }; }
  configure(input = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('自主评论许可只能由用户在本机设置。', 403);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['enabled', 'dailyLimit', 'perSessionLimit'].includes(key)) || typeof input.enabled !== 'boolean' || input.dailyLimit !== undefined && (!Number.isSafeInteger(input.dailyLimit) || input.dailyLimit < 1 || input.dailyLimit > 20) || input.perSessionLimit !== undefined && (!Number.isSafeInteger(input.perSessionLimit) || input.perSessionLimit < 1 || input.perSessionLimit > 3)) throw fail('评论设置只接受总开关、每日 1 至 20 次和单轮 1 至 3 次上限。', 400);
    this.control(() => { const policy = this.policy(); if (input.enabled && (this.unresolved().length || this.state().recoveryRequired)) throw fail('上次评论结果需要核对；重新开关不能清除未确认记录。'); write(this.files.policy, { ...policy, enabled: input.enabled, dailyLimit: input.dailyLimit ?? policy.dailyLimit, perSessionLimit: input.perSessionLimit ?? policy.perSessionLimit }); });
    if (!input.enabled) this.active?.abort.abort(fail('用户关闭了自主评论。'));
    return this.state();
  }
  evidence(input) {
    if (!evidencePattern.test(input.evidenceId) || !videoIdentity(input.videoId)) throw fail('评论必须引用已实际观察的同一抖音作品。', 400);
    const observation = this.personaMemory.snapshot().recentObservations?.find(item => item.id === input.evidenceId);
    if (!observation || observation.videoId !== input.videoId || observation.url !== `https://www.douyin.com/video/${input.videoId}` || !observation.sources?.includes(this.source) || observation.privacy !== 'internal-reference' || observation.visibility !== 'account-visible-unverified') throw fail('没有找到当前入口对同一作品的真实观察，未评论。');
    return observation;
  }
  privateContent(text) {
    const policy = read(path.join(this.stateDir, 'chat-policy.json'), null);
    if (policy && !Array.isArray(policy.allowlist)) throw fail('私人联系人配置无法核对，未允许公开评论。');
    if (policy?.allowlist.some(item => [item?.id, item?.name].some(value => typeof value === 'string' && value.length >= 2 && text.normalize('NFKC').toLocaleLowerCase().includes(value.normalize('NFKC').toLocaleLowerCase())))) throw fail('评论涉及本机联系人信息，未公开发送。', 400);
  }
  allowed(input, { signal, watchRunId, operationId, sessionId } = {}) {
    signal?.throwIfAborted(); if (this.closed) throw fail('此入口已关闭，停止自主评论。');
    const policy = this.policy(), ledger = this.ledger(); if (!policy.enabled) throw fail('自主评论尚未启用。');
    if (this.unresolved(ledger, operationId).length) throw fail('存在未确认评论，已暂停后续发布。');
    const time = this.videoLimits.state();
    if (!time.allowed || !identifier(time.session?.id) || sessionId && time.session.id !== sessionId) throw fail(time.reason || '有限视频轮次已变化，未继续评论。');
    const worker = read(path.join(this.stateDir, 'watch-loop.lock'), null);
    if (!identifier(watchRunId) || !worker || worker.pid !== process.pid || !alive(worker.pid) || worker.runId !== watchRunId || worker.source !== this.source || worker.sessionId !== time.session.id || worker.status !== 'running') throw fail('评论只能绑定当前入口正在运行的同一自主观看与有限轮次。');
    const request = read(path.join(this.stateDir, 'watch-stop.request.json'), null); if (request?.runId === watchRunId) throw fail('用户已停止自主观看，未继续评论。');
    const own = operationId && ledger.operations.find(item => item.operationId === operationId), count = ledger.days[day(this.now())] || 0, sessionCount = ledger.sessions[time.session.id] || 0;
    if (own && own.day !== day(this.now())) throw fail('已跨过上海日期，本次评论预留不转移到新一天。');
    if (count >= policy.dailyLimit && (!own || count > policy.dailyLimit) || sessionCount >= policy.perSessionLimit && (!own || sessionCount > policy.perSessionLimit)) throw fail('自主评论的每日或单轮次数已用完。');
    this.evidence(input); validateCommentText(input.text); this.privateContent(input.text);
    return time;
  }
  update(operationId, patch) { return this.control(() => { const ledger = this.ledger(), item = ledger.operations.find(item => item.operationId === operationId); if (!item) throw fail('评论预留记录丢失，未继续发布。'); Object.assign(item, patch); write(this.files.ledger, ledger); }); }
  async comment(input = {}, { signal, watchRunId } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['evidenceId', 'videoId', 'text'].includes(key))) throw fail('自主评论只接受观察编号、当前作品和纯文字。', 400);
    input = { ...input, text: validateCommentText(input.text) }; this.allowed(input, { signal, watchRunId });
    if (this.active) throw fail('此入口已有评论正在处理。'); fs.mkdirSync(this.stateDir, { recursive: true });
    const token = randomUUID(); let descriptor;
    try { descriptor = fs.openSync(this.files.send, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fail('另一个入口正在评论，或上次评论发送锁需要核对。'); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    const abort = new AbortController(), combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(30_000)]), operationId = randomUUID(), completion = Promise.withResolvers();
    let reserved = false, clicking = false, finished = false, releaseDispatch; this.active = { abort, completion: completion.promise };
    try {
      let sessionId;
      this.control(() => {
        const time = this.allowed(input, { signal: combined, watchRunId }); sessionId = time.session.id; const ledger = this.ledger();
        if (ledger.operations.some(item => item.videoId === input.videoId)) throw fail('同一作品已处理过评论，未跨日或重启后自动重复发布。');
        const date = day(this.now()); ledger.days[date] = (ledger.days[date] || 0) + 1; ledger.sessions[sessionId] = (ledger.sessions[sessionId] || 0) + 1;
        ledger.operations.push({ operationId, evidenceId: input.evidenceId, videoId: input.videoId, text: input.text, day: date, sessionId, runId: watchRunId, source: this.source, pid: process.pid, status: 'reserved', startedAt: new Date(this.now()).toISOString() }); write(this.files.ledger, ledger); reserved = true;
      });
      const authorize = ({ phase, videoId } = {}) => { if (finished || videoId !== input.videoId || !['prepare', 'monitor', 'before-click'].includes(phase)) throw fail('可信评论授权与当前作品不一致。'); this.allowed(input, { signal: combined, watchRunId, operationId, sessionId }); if (phase === 'before-click') { if (clicking) throw fail('这条评论已授权一次发布，未再次点击。'); this.update(operationId, { status: 'clicking' }); clicking = true; } return true; };
      authorize.beginDispatch = () => { if (finished || !clicking || releaseDispatch) throw fail('没有一次有效的评论最终输入许可。'); const release = this.acquireControl(); try { this.allowed(input, { signal: combined, watchRunId, operationId, sessionId }); } catch (error) { release(); throw error; } releaseDispatch = release; return () => { releaseDispatch?.(); releaseDispatch = null; }; };
      let post = this.post;
      if (!post) { let commenter = await (this.getCommenter ? this.getCommenter() : this.controller?.getCommenter?.()); if (!commenter) { const { CommentBrowser } = await import('./comment-browser.mjs'); this.ownedCommenter ??= new CommentBrowser({ source: this.source, videoLimits: this.videoLimits, stateDir: this.stateDir }); commenter = this.ownedCommenter; } if (typeof commenter.post !== 'function') throw fail('当前评论适配尚未提供可核对的发布接口。'); post = commenter.post.bind(commenter); }
      const result = await post({ expectedVideoId: input.videoId, text: input.text }, { signal: combined, authorize, autonomousRunId: watchRunId });
      const confirmed = clicking && result?.confirmed === true && result.videoId === input.videoId && identifier(result.commentId), uncertain = !confirmed && (clicking || result?.deliveryUncertain === true || result?.confirmed === true);
      this.update(operationId, { status: confirmed ? 'confirmed' : uncertain ? 'uncertain' : 'not-sent', completedAt: new Date(this.now()).toISOString(), ...(identifier(result?.operationId) ? { browserOperationId: result.operationId } : {}), ...(confirmed ? { commentId: result.commentId } : {}) });
      return { confirmed, deliveryUncertain: uncertain, operationId, videoId: input.videoId, ...(confirmed ? { commentId: result.commentId } : { reason: uncertain ? '评论发布结果未确认，已暂停后续评论，请在抖音核对。' : result?.reason || '没有发布可核对的新评论，未改用其他发送方式。', ...(result?.needsUserAction ? { needsUserAction: true } : {}) }) };
    } catch (error) {
      if (reserved) try { this.update(operationId, { status: clicking ? 'uncertain' : 'not-sent', completedAt: new Date(this.now()).toISOString() }); } catch { /* 保留原预留记录，不能证明未发出时不重试。 */ }
      if (clicking) return { confirmed: false, deliveryUncertain: true, operationId, videoId: input.videoId, reason: '发布期间中断，原评论结果需人工核对，未再次发送。' }; throw error;
    } finally { finished = true; try { releaseDispatch?.(); const owner = read(this.files.send, null); if (owner?.pid === process.pid && owner.token === token) fs.unlinkSync(this.files.send); } finally { this.active = null; completion.resolve(); } }
  }
  resolve({ operationId, outcome } = {}, { explicit = false } = {}) {
    if (!explicit) throw fail('只有用户核对抖音评论后才能解除暂停。', 403);
    if (!identifier(operationId) || !['confirmed', 'not-sent'].includes(outcome)) throw fail('请提供待核对评论编号和实际发布结果。', 400);
    this.control(() => { const guard = read(this.files.send, null); if (guard && alive(guard.pid)) throw fail('评论仍在处理，请等待停止后再核对。'); const ledger = this.ledger(), item = this.unresolved(ledger).find(item => item.operationId === operationId); if (!item) throw fail('没有这条待核对评论。', 400); item.status = outcome === 'confirmed' ? 'resolved-confirmed' : 'resolved-not-sent'; item.reviewedAt = new Date(this.now()).toISOString(); write(this.files.ledger, ledger); if (guard) fs.unlinkSync(this.files.send); });
    return this.state();
  }
  async close() { this.closed = true; this.active?.abort.abort(fail('入口已关闭，停止其自主评论。')); await this.active?.completion; await this.ownedCommenter?.close(); }
}
