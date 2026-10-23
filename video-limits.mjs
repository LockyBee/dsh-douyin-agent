import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { randomUUID } from 'node:crypto';

const DAY = 86_400_000;
const deadline = (...values) => { const finite = values.filter(value => value !== null); return finite.length ? Math.min(...finite) : null; };
const durationEnd = (start, minutes) => minutes === null ? null : start + minutes * 60_000;
const SOURCES = ['api', 'dsh'];
const READ_ACTIONS = new Set(['douyin_status', 'douyin_pause', 'douyin_recall', 'douyin_remember', 'douyin_video_limits_status']);
export const DEFAULT_VIDEO_POLICY = Object.freeze({ version: 1, timeZone: 'Asia/Shanghai', windows: ['00:00-24:00'], sessionMinutes: 10 });
const shanghai = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, value) { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file); }
function initialize(file, value) { let descriptor; try { descriptor = fs.openSync(file, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return; throw error; } try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2)); } finally { fs.closeSync(descriptor); } }
function sourceName(source) { if (!SOURCES.includes(source)) throw new Error('刷视频入口只能是 api 或 dsh。'); return source; }
function parseWindow(value) {
  if (typeof value !== 'string' || value.length > 11 || !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(value)) throw new Error('时间段请使用 HH:MM-HH:MM，例如 20:00-21:00。');
  const [startHour, startMinute, endHour, endMinute] = value.split(/[:-]/).map(Number);
  if (startHour > 23 || endHour > 24 || startMinute > 59 || endMinute > 59 || (endHour === 24 && endMinute !== 0)) throw new Error('开始时间须在 00:00 至 23:59，结束时间可使用 24:00。');
  const start = startHour * 60 + startMinute; let end = endHour * 60 + endMinute;
  if (start === end) throw new Error('时间段不能为零长度；全天请用 00:00-24:00。');
  if (end < start) end += 1440;
  return { start, end };
}
export function validateVideoPolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('视频时间设置必须是对象。');
  for (const key of Object.keys(input)) if (!['version','timeZone','windows','weekendWindows','sessionMinutes'].includes(key)) throw new Error(`不支持的视频设置：${key}`);
  if (input.timeZone !== undefined && input.timeZone !== 'Asia/Shanghai') throw new Error('时间段固定按 Asia/Shanghai 计算。');
  if (input.sessionMinutes !== null && (!Number.isSafeInteger(input.sessionMinutes) || input.sessionMinutes < 1 || input.sessionMinutes > 1_000_000)) throw new Error('单轮时长须为1至1000000分钟，或选择不限单轮时长。');
  if (!Array.isArray(input.windows) || input.windows.length < 1 || input.windows.length > 16) throw new Error('请设置 1 至 16 个每日时间段，不能关闭全部时间限制。');
  for (const value of input.windows) parseWindow(value);
  if (input.weekendWindows !== undefined && input.weekendWindows !== null) { if (!Array.isArray(input.weekendWindows) || input.weekendWindows.length < 1 || input.weekendWindows.length > 16) throw new Error('周末时段须设置1至16项。'); for (const value of input.weekendWindows) parseWindow(value); }
  return { version: 1, timeZone: 'Asia/Shanghai', windows: [...new Set(input.windows)], sessionMinutes: input.sessionMinutes, ...(input.weekendWindows ? { weekendWindows: [...new Set(input.weekendWindows)] } : {}) };
}
export function allowedWindow(policy, now) {
  if (!Number.isFinite(now)) throw new Error('当前时间无效。');
  const parts = Object.fromEntries(shanghai.formatToParts(new Date(now)).filter((item) => item.type !== 'literal').map((item) => [item.type, Number(item.value)]));
  const midnight = Date.UTC(parts.year, parts.month - 1, parts.day) - 8 * 3600_000;
  const intervals = [];
  for (let offset = -8; offset <= 8; offset++) { const day = new Date(midnight + offset * DAY + 8 * 3600_000).getUTCDay(); for (const value of ([0,6].includes(day) ? policy.weekendWindows || policy.windows : policy.windows)) { const { start, end } = parseWindow(value); intervals.push({ startAt: midnight + offset * DAY + start * 60_000, expiresAt: midnight + offset * DAY + end * 60_000 }); } }
  intervals.sort((a, b) => a.startAt - b.startAt);
  const merged = [];
  for (const interval of intervals) { const previous = merged.at(-1); if (previous && interval.startAt <= previous.expiresAt) previous.expiresAt = Math.max(previous.expiresAt, interval.expiresAt); else merged.push({ ...interval }); }
  const current = merged.find((interval) => now >= interval.startAt && now < interval.expiresAt);
  return current && current.expiresAt - current.startAt >= 7 * DAY ? { startAt: null, expiresAt: null } : current || null;
}

// 复用 Node.js 时间、文件与定时器，以及本项目的本机持久状态方式，无新增依赖。
export class VideoLimits {
  constructor({ stateDir = resolveRuntimePaths().stateDir, now = Date.now } = {}) {
    Object.assign(this, { stateDir, now }); fs.mkdirSync(stateDir, { recursive: true });
    this.policyFile = path.join(stateDir, 'video-policy.json'); this.sessionsFile = path.join(stateDir, 'video-sessions.json'); this.guardFile = path.join(stateDir, 'video-control.guard');
    initialize(this.policyFile, DEFAULT_VIDEO_POLICY); initialize(this.sessionsFile, { version: 1, current: null });
    this.enforcing = false;
  }
  control(action) {
    let descriptor; const token = randomUUID();
    try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('视频设置正在更新，或控制锁需要人工核对；未自动删除。'), { status: 409 }); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    try { return action(); } finally { const guard = read(this.guardFile); if (guard.token === token && guard.pid === process.pid) fs.unlinkSync(this.guardFile); }
  }
  state() {
    const policy = validateVideoPolicy(read(this.policyFile)); const sessions = read(this.sessionsFile); const now = this.now();
    if (!Number.isFinite(now)) throw new Error('当前时间无效，未允许刷视频。');
    const window = allowedWindow(policy, now); const session = sessions.current;
    if (session && (!Number.isFinite(session.startAt) || session.expiresAt !== null && (!Number.isFinite(session.expiresAt) || session.expiresAt < session.startAt || session.expiresAt > session.startAt + 1_000_000 * 60_000))) throw new Error('视频会话时间无效，未允许刷视频。');
    const expiresAt = session ? deadline(session.expiresAt, durationEnd(session.startAt, policy.sessionMinutes), window ? window.expiresAt : now) : null;
    let reason = '';
    if (!window) reason = '当前不在允许刷视频的时间段。';
    else if (!session) reason = `请点击“开始新一轮”，${policy.sessionMinutes === null ? '本轮不限单轮时长，仍受每日时段控制' : `本轮上限 ${policy.sessionMinutes} 分钟`}。`;
    else if (session.status !== 'active') reason = session.reason || '当前这轮已经结束，请显式开始新一轮。';
    else if (now < session.startAt || expiresAt !== null && now >= expiresAt) reason = '本轮刷视频时间已用完，请显式开始新一轮。';
    return { protocol: 'video-limits-v1', timeZone: 'Asia/Shanghai', now, policy, session: session ? { ...session, expiresAt } : null, window, allowed: !reason, reason, remainingSeconds: !reason ? expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0 };
  }
  savePolicy(input, { explicit = false } = {}) {
    if (!explicit) throw new Error('视频时间设置只能由用户在控制台明确修改。');
    const policy = validateVideoPolicy(input);
    return this.control(() => { write(this.policyFile, policy); const sessions = read(this.sessionsFile); if (sessions.current?.status === 'active') { const now = this.now(); const window = allowedWindow(policy, now); sessions.current.expiresAt = deadline(sessions.current.expiresAt, durationEnd(sessions.current.startAt, policy.sessionMinutes), window ? window.expiresAt : now); if (!window || sessions.current.expiresAt !== null && now >= sessions.current.expiresAt) { sessions.current.status = 'expired'; sessions.current.reason = '保存后的时间设置已结束当前这轮。'; } write(this.sessionsFile, sessions); } return this.state(); });
  }
  markSession(source, { explicit = false } = {}) {
    sourceName(source); if (!explicit) throw new Error('不能由视频工具自动重置时钟，请在控制台显式开始新一轮。');
    return this.control(() => {
      const policy = validateVideoPolicy(read(this.policyFile)); const now = this.now(); const window = allowedWindow(policy, now);
      if (!window) throw Object.assign(new Error('当前不在允许时间段，未开始新一轮。'), { status: 409 });
      const expiresAt = deadline(durationEnd(now, policy.sessionMinutes), window.expiresAt);
      write(this.sessionsFile, { version: 1, current: { id: randomUUID(), startAt: now, expiresAt, startedBy: source, status: 'active', sources: { [source]: { startAt: now, expiresAt } } } });
      return this.state();
    });
  }
  endSession({ explicit = false, reason = '用户结束当前这轮。' } = {}) {
    if (!explicit) throw new Error('结束当前这轮需要用户明确操作。');
    return this.control(() => { const sessions = read(this.sessionsFile); if (sessions.current) { sessions.current.status = 'ended'; sessions.current.reason = reason; sessions.current.endedAt = this.now(); write(this.sessionsFile, sessions); } return this.state(); });
  }
  beforeAction(source, name) {
    sourceName(source);
    if (name.startsWith('douyin_chat_')) return { allowed: true };
    if (READ_ACTIONS.has(name)) { try { return { allowed: true, state: this.state() }; } catch (error) { return { allowed: true, state: { allowed: false, reason: error.message } }; } }
    return this.control(() => {
      const state = this.state(); const sessions = read(this.sessionsFile);
      if (!state.allowed) { if (sessions.current?.status === 'active') { sessions.current.status = 'expired'; sessions.current.reason = state.reason; write(this.sessionsFile, sessions); } return { allowed: false, reason: state.reason, state: this.state() }; }
      sessions.current.sources[source] ||= { startAt: sessions.current.startAt, expiresAt: state.session.expiresAt };
      sessions.current.sources[source].expiresAt = state.session.expiresAt; sessions.current.sources[source].lastActionAt = this.now();
      write(this.sessionsFile, sessions); const updated = this.state(); return { allowed: updated.allowed, ...(updated.allowed ? {} : { reason: updated.reason }), state: updated };
    });
  }
  async enforce({ sources = SOURCES, pause, onDeny = () => {} } = {}) {
    if (this.enforcing) return;
    this.enforcing = true;
    try {
      let state; try { state = this.state(); } catch (error) { state = { allowed: false, reason: `视频时间状态不可读：${error.message}` }; }
      if (state.allowed) return state;
      if (state.session?.status === 'active') { try { state = this.control(() => { const current = this.state(); if (!current.allowed) { const sessions = read(this.sessionsFile); sessions.current.status = 'expired'; sessions.current.reason = current.reason; write(this.sessionsFile, sessions); } return this.state(); }); } catch {} }
      if (state.allowed) return state;
      onDeny(state);
      const pauseResults = await Promise.allSettled(sources.map((source) => { sourceName(source); return pause?.(source, state); }));
      return { ...state, pauseResults: pauseResults.map((result) => ({ status: result.status, ...(result.status === 'fulfilled' ? { result: result.value } : { message: result.reason?.message || String(result.reason) }) })) };
    } finally { this.enforcing = false; }
  }
  watch({ intervalMs = 1000, ...options } = {}) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 1000) throw new Error('视频时限检查间隔须为 10 至 1000 毫秒。');
    const timer = setInterval(() => { void this.enforce(options).catch(() => {}); }, intervalMs); timer.unref?.();
    return () => clearInterval(timer);
  }
}
