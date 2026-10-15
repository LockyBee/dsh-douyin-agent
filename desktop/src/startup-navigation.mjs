import fs from 'node:fs/promises';
import path from 'node:path';
import { request } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const fail = (code, message) => Object.assign(new Error(message), { code });
const TRANSIENT = new Map([[-100, 'ERR_CONNECTION_CLOSED'], [-101, 'ERR_CONNECTION_RESET'], [-102, 'ERR_CONNECTION_REFUSED'], [-21, 'ERR_NETWORK_CHANGED'], [-324, 'ERR_EMPTY_RESPONSE']]);
const SAFE_FIELDS = new Set(['attempt', 'maxAttempts', 'code', 'errno', 'isMainFrame', 'sameDocument', 'target', 'status', 'bytes', 'sha256', 'reason', 'ready', 'exitCode', 'signal', 'stage']);

export function localStartupUrl(value) {
  let url; try { url = new URL(value); } catch { throw fail('STARTUP_TARGET_INVALID', '启动页面地址无效。'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw fail('STARTUP_TARGET_INVALID', '启动导航只允许本机后台首页。');
  return url.href;
}

export function probeStartupPage(value, { signal, timeoutMs = 2500, expectedSha256, maxBytes = 1024 * 1024 } = {}) {
  const url = localStartupUrl(value);
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', signal, headers: { 'cache-control': 'no-cache', accept: 'text/html' } }, response => {
      let bytes = 0; const hash = createHash('sha256');
      response.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) req.destroy(fail('STARTUP_HTTP_INVALID', '本机启动页面超过大小限制。')); else hash.update(chunk); });
      response.once('error', reject);
      response.once('end', () => {
        const sha256 = hash.digest('hex');
        if (response.statusCode !== 200) return reject(fail('STARTUP_HTTP_UNREADY', `本机启动页面尚未就绪（HTTP ${response.statusCode}）。`));
        if (!bytes || !/^text\/html(?:;|$)/i.test(response.headers['content-type'] || '') || (expectedSha256 && sha256 !== expectedSha256)) return reject(fail('STARTUP_HTTP_INVALID', '本机启动页面与软件资源不一致。'));
        resolve({ status: 200, bytes, sha256 });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(fail('STARTUP_HTTP_TIMEOUT', '本机启动页面检查超时。')));
    req.once('error', reject); req.end();
  });
}

function targetKind(value, target) {
  if (value === 'about:blank' || !value) return 'blank';
  try { const url = new URL(value); return url.href === target ? 'startup-root' : url.origin === new URL(target).origin ? 'same-origin' : 'other'; } catch { return 'invalid'; }
}

function errorCode(error) {
  return { code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'STARTUP_NAVIGATION_FAILED', ...(Number.isInteger(error?.errno) ? { errno: error.errno } : {}) };
}

function canRetry(error, evidence) {
  if (evidence.destroyed || evidence.rendererGone || evidence.preloadError || evidence.otherNavigation) return false;
  const { code, errno } = errorCode(error);
  if (code === 'ERR_FAILED' && errno === -2) return evidence.stopped && !evidence.mainFailure;
  return evidence.mainFailure?.target === 'startup-root' && TRANSIENT.get(errno) === code && evidence.mainFailure.errno === errno;
}

async function bounded(operation, { signal, timeoutMs, code, message }) {
  signal?.throwIfAborted();
  let timer, abort;
  const cancelled = new Promise((_, reject) => {
    timer = setTimeout(() => reject(fail(code, message)), timeoutMs);
    abort = () => reject(signal.reason ?? fail('STARTUP_CANCELLED', '启动已取消。'));
    signal?.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), cancelled]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export async function navigateStartup({ window, backend, url, expectedSha256, record = () => {}, checkRenderer = async () => true, probe = probeStartupPage, maxAttempts = 3, retryDelays = [250, 750], timeoutMs = 12_000, signal } = {}) {
  const target = localStartupUrl(url);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw fail('STARTUP_BUDGET_INVALID', '启动重试预算无效。');
  const contents = window.webContents, lifetime = new AbortController();
  const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  let settled = false;
  const windowGone = () => lifetime.abort(fail('STARTUP_WINDOW_CLOSED', '软件窗口已关闭，停止启动导航。'));
  contents.once('destroyed', windowGone);
  backend.exited?.then(() => { if (!settled) lifetime.abort(fail('STARTUP_BACKEND_EXITED', '本机后台已退出，无法加载启动页面。')); });
  const alive = () => {
    combined.throwIfAborted();
    if (window.isDestroyed() || contents.isDestroyed()) throw fail('STARTUP_WINDOW_CLOSED', '软件窗口已关闭，停止启动导航。');
    if (!backend.child?.connected || backend.child.exitCode !== null && backend.child.exitCode !== undefined || backend.child.signalCode) throw fail('STARTUP_BACKEND_EXITED', '本机后台已退出，无法加载启动页面。');
  };
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      alive(); record('navigation.attempt', { attempt, maxAttempts });
      const evidence = { issued: false, stopped: false, destroyed: false, rendererGone: false, preloadError: false, otherNavigation: false, mainFailure: null };
      const listeners = [];
      const on = (event, listener) => { contents.on(event, listener); listeners.push([event, listener]); };
      on('did-start-navigation', (_event, value, sameDocument, isMainFrame) => { const kind = targetKind(value, target); if (evidence.issued && isMainFrame && kind !== 'startup-root' && kind !== 'blank') evidence.otherNavigation = true; record('navigation.started', { attempt, target: kind, sameDocument: Boolean(sameDocument), isMainFrame: Boolean(isMainFrame), stage: evidence.issued ? 'loading' : 'preflight' }); });
      on('did-fail-load', (_event, errno, code, value, isMainFrame) => { const detail = { attempt, ...errorCode({ errno, code }), target: targetKind(value, target), isMainFrame: Boolean(isMainFrame), stage: evidence.issued ? 'loading' : 'preflight' }; if (evidence.issued && isMainFrame) evidence.mainFailure = detail; record('navigation.failed-event', detail); });
      on('did-finish-load', () => record('navigation.finished-event', { attempt }));
      on('did-stop-loading', () => { if (evidence.issued) evidence.stopped = true; record('navigation.stopped-event', { attempt, stage: evidence.issued ? 'loading' : 'preflight' }); });
      on('destroyed', () => { evidence.destroyed = true; record('navigation.destroyed', { attempt }); });
      on('render-process-gone', (_event, details) => { evidence.rendererGone = true; record('renderer.gone', { attempt, reason: /^[a-z-]+$/.test(details?.reason || '') ? details.reason : 'unknown', exitCode: details?.exitCode }); lifetime.abort(fail('STARTUP_RENDERER_GONE', '软件页面进程已退出。')); });
      on('preload-error', () => { evidence.preloadError = true; record('renderer.preload-error', { attempt }); });
      try {
        const page = await bounded(() => probe(target, { signal: combined, expectedSha256 }), { signal: combined, timeoutMs: 3000, code: 'STARTUP_HTTP_TIMEOUT', message: '本机启动页面检查超时。' });
        record('http.ready', { attempt, status: page.status, bytes: page.bytes, sha256: page.sha256 }); alive();
        await bounded(() => { evidence.issued = true; return window.loadURL(target); }, { signal: combined, timeoutMs, code: 'STARTUP_NAVIGATION_TIMEOUT', message: '软件首页加载超时。' }); alive();
        if (evidence.preloadError) throw fail('STARTUP_PRELOAD_FAILED', '软件设置接口未能载入。');
        if (contents.getURL() !== target) throw fail('STARTUP_TARGET_CHANGED', '启动页面偏离本机首页，已停止加载。');
        const ready = await bounded(checkRenderer, { signal: combined, timeoutMs: 3000, code: 'STARTUP_RENDERER_TIMEOUT', message: '软件页面就绪检查超时。' }); alive();
        if (ready !== true) throw fail('STARTUP_RENDERER_UNREADY', '软件页面或桌面设置接口尚未就绪。');
        record('navigation.ready', { attempt, ready: true }); return { ready: true, attempts: attempt };
      } catch (error) {
        alive();
        record('navigation.rejected', { attempt, ...errorCode(error), reason: canRetry(error, evidence) ? 'transient-local-navigation' : 'not-retryable' });
        if (attempt >= maxAttempts || !canRetry(error, evidence)) {
          if (error?.code === 'STARTUP_NAVIGATION_TIMEOUT') contents.stop?.();
          throw error;
        }
        const milliseconds = retryDelays[attempt - 1] ?? 750;
        if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 2000) throw fail('STARTUP_BUDGET_INVALID', '启动重试等待时间无效。');
        record('navigation.retry', { attempt }); await delay(milliseconds, undefined, { signal: combined });
      } finally { for (const [event, listener] of listeners) contents.removeListener(event, listener); }
    }
  } finally { settled = true; contents.removeListener('destroyed', windowGone); }
}

export async function createStartupTimeline(directory, { now = () => new Date(), runId = randomUUID() } = {}) {
  if (!path.isAbsolute(directory) || !/^[a-zA-Z0-9-]{1,80}$/.test(runId)) throw fail('STARTUP_LOG_INVALID', '启动诊断位置无效。');
  const logs = path.join(directory, 'startup-diagnostics'), errors = path.join(directory, 'startup-errors');
  await fs.mkdir(logs, { recursive: true }); await fs.mkdir(errors, { recursive: true });
  const file = path.join(logs, `${now().toISOString().replaceAll(':', '-')}-${runId}.jsonl`);
  let queue = Promise.resolve(), seq = 0;
  const record = (event, detail = {}) => {
    if (!/^[a-z.-]{1,60}$/.test(event) || seq >= 300) return;
    const fields = Object.fromEntries(Object.entries(detail).filter(([key, value]) => SAFE_FIELDS.has(key) && (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 100 && /^[a-zA-Z0-9_. -]+$/.test(value))));
    const line = JSON.stringify({ protocol: 'startup-navigation-v1', seq: ++seq, at: now().toISOString(), event, ...fields }) + '\n';
    queue = queue.then(() => fs.appendFile(file, line, { mode: 0o600 }));
    queue.catch(() => {});
  };
  const active = path.join(directory, 'startup-error.txt');
  return { file, record, flush: () => queue,
    async fail(message) { await fs.writeFile(path.join(errors, `${runId}.txt`), message + '\n', { mode: 0o600 }); await fs.writeFile(active, message + '\n', { mode: 0o600 }); record('startup.failed'); await queue; },
    async success() {
      try { await fs.copyFile(active, path.join(errors, `${runId}-previous.txt`)); await fs.unlink(active); record('startup.previous-error-archived'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      record('startup.ready'); await queue;
    },
  };
}
