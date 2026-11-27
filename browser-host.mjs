import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium } from './playwright-runtime.mjs';
import { connectDedicatedBrowser } from './browser-launcher.mjs';

const execute = promisify(execFile);
const versionOf = value => /^\d+\.\d+\.\d+\.\d+$/.exec(String(value || '').trim())?.[0] || null;
export function sanitizeBrowserFailure(value) {
  return String(value || '').replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [凭据已隐藏]')
    .replace(/\b(?:token|api[-_]?key|cookie|authorization)\s*[:=]\s*[^\s，。；]+/gi, '[凭据已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[凭据已隐藏]').replace(/https?:\/\/[^\s，。；]+/gi, '[地址]')
    .replace(/[A-Za-z]:[\\/][^\r\n"'<>]*/g, '[本地路径]').replace(/\/(?:Users|home)\/[^\r\n"'<>]*/g, '[本地路径]')
    .split('\n').slice(0, 5).join('\n').slice(0, 1200);
}
export function classifyBrowserLaunchError(error, { version } = {}) {
  const raw = String(error?.message || error || ''), browserVersion = versionOf(version), details = sanitizeBrowserFailure(error?.stack || raw);
  let code = 'EDGE_LAUNCH_FAILED', message = '专用 Microsoft Edge 启动后退出或未能就绪。请更新 Microsoft Edge 和抖音助手后重试；若仍失败，请提交自检中的启动详情。';
  if (/ProcessSingleton|user data directory|profile.*(?:in use|already)|资料目录.*占用/i.test(raw)) { code = 'BROWSER_PROFILE_IN_USE'; message = '专用资料目录正在被其他浏览器使用，请正常关闭旧专用窗口后重试；不要删除个人资料或重复启动。'; }
  else if (/EACCES|EPERM|access is denied|permission denied/i.test(raw)) { code = 'EDGE_ACCESS_DENIED'; message = '系统权限或安全软件阻止了专用 Edge 启动，请检查浏览器及专用资料目录权限，不要删除原资料。'; }
  else if (/ENOENT|Executable.*(?:does not exist|doesn.t exist|not found)|executable.*找不到/i.test(raw)) { code = 'EDGE_MISSING'; message = '未找到可启动的 Microsoft Edge，请核对 Edge 安装，再重新自检；本次没有安装或切换浏览器。'; }
  else if (/unsupported.*(?:browser|version)|(?:browser|version).*(?:not supported|incompatible)|protocol.*(?:unsupported|not supported|unknown method)/i.test(raw)) { code = 'EDGE_VERSION_INCOMPATIBLE'; message = '启动异常明确报告浏览器版本或协议不兼容，请更新 Microsoft Edge 和抖音助手后重试。'; }
  return { code, message: (browserVersion ? `标准路径 Edge 版本 ${browserVersion}。` : '未读取到标准路径 Edge 版本。') + message, browserVersion, details };
}
async function readEdgeFileVersion(file) {
  if (process.platform !== 'win32' || !process.env.SystemRoot) return null;
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(shell)) return null;
  const env = { ...process.env, DOUYIN_EDGE_VERSION_FILE: file };
  const result = await execute(shell, ['-NoProfile', '-NonInteractive', '-Command', '[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:DOUYIN_EDGE_VERSION_FILE).ProductVersion'], { env, timeout: 3000, windowsHide: true, maxBuffer: 2048 });
  return versionOf(result.stdout);
}
function findEdgeExecutable({ env = process.env, candidates, exists = existsSync } = {}) {
  const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)'], ...(env.HOMEDRIVE ? [path.join(env.HOMEDRIVE + path.sep, 'Program Files'), path.join(env.HOMEDRIVE + path.sep, 'Program Files (x86)')] : [])].filter(Boolean);
  const files = candidates || roots.map(root => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  return files.find(candidate => exists(candidate));
}
export async function probeEdgeInstallation({ env, candidates, exists, readVersion = readEdgeFileVersion } = {}) {
  const file = findEdgeExecutable({ env, candidates, exists });
  if (!file) return { installed: false, version: null, channel: 'msedge' };
  let version = null; try { version = versionOf(await readVersion(file)); } catch {}
  return { installed: true, version, channel: 'msedge' };
}

export async function launchWindowsVisibleEdge({ profile, port, spawnEdge = spawn } = {}) {
  const executable = findEdgeExecutable();
  if (!executable) throw Object.assign(new Error('未找到可启动的 Microsoft Edge。'), { code: 'ENOENT' });
  // 原生启动保留 Edge 的真实标签焦点，后续 CDP 连接使用 noDefaults。
  const child = spawnEdge(executable, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
    '--disable-background-mode', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--disable-extensions', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const host = new EventEmitter();
  let launchFailure, exited = false, socket;
  child.once('error', error => { launchFailure = error; });
  const finished = new Promise(resolve => child.once('exit', () => {
    exited = true;
    host.emit('close');
    resolve();
  }));
  const useVerifiedBrowser = async (signal, action) => {
    const browser = await connectDedicatedBrowser(socket, { signal });
    let session;
    try {
      session = await browser.newBrowserCDPSession();
      const { processInfo } = await session.send('SystemInfo.getProcessInfo');
      const owners = processInfo.filter(item => item.type === 'browser');
      if (exited || owners.length !== 1 || owners[0].id !== child.pid) throw new Error('调试端口没有绑定本次启动的专用 Edge。');
      signal.throwIfAborted();
      return await action?.(session, browser);
    } finally {
      await session?.detach().catch(() => {});
      await browser.close().catch(() => {});
    }
  };
  try {
    const signal = AbortSignal.timeout(20_000), endpoint = `http://127.0.0.1:${port}/json/version`;
    while (!socket) {
      signal.throwIfAborted();
      if (launchFailure) throw launchFailure;
      if (exited) throw new Error('专用 Edge 启动进程已退出，请检查资料目录是否被占用。');
      const response = await fetch(endpoint, { signal: AbortSignal.any([signal, AbortSignal.timeout(750)]), redirect: 'error' }).catch(() => null);
      if (response?.ok) {
        const value = (await response.json()).webSocketDebuggerUrl;
        const prefix = `ws://127.0.0.1:${port}/devtools/browser/`;
        if (typeof value !== 'string' || !value.startsWith(prefix) || !/^[a-f0-9-]{36}$/i.test(value.slice(prefix.length))) throw new Error('专用 Edge 的调试地址无效。');
        socket = value;
      } else await delay(100, undefined, { signal });
    }
    await useVerifiedBrowser(signal);
    if (exited) throw new Error('专用 Edge 已退出。');
    host.close = async () => {
      if (exited) return;
      await useVerifiedBrowser(AbortSignal.timeout(5000), async (session, browser) => {
        try { await session.send('Browser.close'); } catch (error) { if (browser.isConnected()) throw error; }
      });
      if (!exited) await Promise.race([finished, delay(5000, undefined, { ref: false })]);
    };
    return host;
  } catch (error) {
    if (!exited && child.pid) child.kill();
    throw error;
  }
}
const focusFailure = error => Object.assign(new Error('专用 Edge 未能清除焦点模拟，已保留窗口和草稿，请重新自检。', { cause: error }), { code: 'EDGE_FOCUS_RESET_FAILED' });

// 只清除宿主自己引入的模拟，不激活窗口、不填写输入框。
export async function installNativeFocusReset(context, { onFailure = () => {}, timeoutMs = 5000 } = {}) {
  if (!context?.pages || !context?.on || !context?.off || !context?.newCDPSession || typeof onFailure !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw focusFailure(new Error('宿主缺少可核对的页面焦点接口。'));
  let active = true, fault = null, closing;
  const tracked = new Map(), pending = new Set();
  function removePage(page) {
    const state = tracked.get(page); if (!state) return;
    state.closed = true;
    page.off('framenavigated', state.onNavigation); page.off('domcontentloaded', state.onLoaded); page.off('close', state.onClose);
    tracked.delete(page);
  }
  async function close() {
    if (closing) return closing;
    active = false; context.off('page', onPage); context.off('close', onContextClose);
    for (const page of tracked.keys()) removePage(page);
    closing = Promise.allSettled([...pending]).then(() => {}); return closing;
  }
  function report(error) {
    if (fault || !active) return;
    fault = focusFailure(error);
    try { onFailure(fault); } catch { /* 焦点失败仍由启动检查或状态记录返回。 */ }
    void close();
  }
  async function bounded(promise, late) {
    let expired = false, timer;
    const source = Promise.resolve(promise);
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('宿主焦点清除超时。')); }, timeoutMs); });
    source.then(value => { if (expired) void late?.(value); }, () => {});
    try { return await Promise.race([source, timeout]); } finally { clearTimeout(timer); }
  }
  function schedule(page) {
    if (!active || page.isClosed()) return Promise.resolve();
    let state = tracked.get(page);
    if (!state) {
      state = { closed: false, dirty: false, task: null };
      state.onNavigation = frame => { if (frame === page.mainFrame()) void schedule(page).catch(() => {}); };
      state.onLoaded = () => { void schedule(page).catch(() => {}); };
      state.onClose = () => removePage(page);
      tracked.set(page, state);
      page.on('framenavigated', state.onNavigation); page.on('domcontentloaded', state.onLoaded); page.on('close', state.onClose);
    }
    state.dirty = true; if (state.task) return state.task;
    const work = async () => {
      while (active && !state.closed && !page.isClosed() && state.dirty) {
        state.dirty = false; let session;
        try {
          session = await bounded(context.newCDPSession(page), value => value.detach().catch(() => {}));
          if (active && !state.closed && !page.isClosed()) await bounded(session.send('Emulation.setFocusEmulationEnabled', { enabled: false }));
        } catch (error) { if (active && !state.closed && !page.isClosed()) { report(error); throw fault; } }
        finally {
          if (session) try { await bounded(session.detach()); } catch (error) { if (active && !state.closed && !page.isClosed()) { report(error); throw fault; } }
        }
      }
    };
    const task = work().finally(() => { state.task = null; pending.delete(task); });
    state.task = task; pending.add(task); return task;
  }
  const onPage = page => { void schedule(page).catch(() => {}); };
  const onContextClose = () => { void close(); };
  context.on('page', onPage); context.on('close', onContextClose);
  try {
    await Promise.all(context.pages().map(schedule));
    if (fault) throw fault;
    if (!active) throw focusFailure(new Error('宿主在焦点检查完成前已退出。'));
    const assertHealthy = () => { if (fault) throw fault; if (!active) throw focusFailure(new Error('宿主焦点检查已结束。')); };
    return { close, flush: async page => { assertHealthy(); await schedule(page); assertHealthy(); }, assertHealthy };
  } catch (error) { await close(); throw fault || focusFailure(error); }
}

export async function runBrowserHost({ profile, controlDir, port, mode = 'visible', launchVisible, chromiumImpl = chromium, probeInstallation = probeEdgeInstallation, logger = console, processImpl = process } = {}) {
  if (!profile || !controlDir || !Number.isInteger(port) || port < 1024 || port > 65535 || !['visible', 'background'].includes(mode)) return { started: false, exitCode: 2 };
  mkdirSync(controlDir, { recursive: true });
  const stateFile = path.join(controlDir, 'browser.json'), startedAt = Date.now(), instanceId = randomUUID(); let context, installation, focusFailed = false, closed = false, exited = false, readyPublished = false;
  const writeState = (ready, extra = {}, initial = false) => {
    if (!initial) {
      let owner; try { owner = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return false; }
      if (owner.instanceId !== instanceId || owner.pid !== processImpl.pid || owner.profile !== profile || owner.port !== port) return false;
    }
    const temporary = `${stateFile}.${processImpl.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ pid: processImpl.pid, profile, port, mode, headless: mode === 'background', ready, startedAt, instanceId, ...extra }));
    renameSync(temporary, stateFile);
    return true;
  };
  const exit = code => { if (!exited) { exited = true; processImpl.exit(code); } };
  try {
    writeState(false, {}, true);
    try { installation = await probeInstallation(); } catch {}
    const nativeVisible = mode === 'visible' && typeof launchVisible === 'function';
    context = nativeVisible ? await launchVisible({ profile, port }) : await chromiumImpl.launchPersistentContext(profile, {
      channel: 'msedge', headless: mode === 'background', viewport: mode === 'background' ? { width: 1440, height: 900 } : null, ignoreDefaultArgs: ['--mute-audio'],
      args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--autoplay-policy=no-user-gesture-required', ...(mode === 'background' ? ['--enable-automation', '--disable-gpu'] : [])],
    });
    context.on('close', () => {
      closed = true;
      try { writeState(false, { closedAt: Date.now(), ...(focusFailed ? { launchFailure: { code: 'EDGE_FOCUS_RESET_FAILED', message: '宿主焦点检查失败，专用浏览器已退出。' } } : {}) }); } catch {}
      exit(focusFailed || !readyPublished ? 1 : 0);
    });
    const nativeFocus = nativeVisible ? null : await installNativeFocusReset(context, { onFailure: error => {
      focusFailed = true;
      const failure = { code: 'EDGE_FOCUS_RESET_FAILED', message: error.message, browserVersion: versionOf(installation?.version), details: sanitizeBrowserFailure(error.cause?.stack || error.cause?.message || error.message) };
      void (async () => {
        let persisted = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          try { if (writeState(false, { launchFailure: { ...failure, at: Date.now() } })) { persisted = true; break; } } catch {}
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        try { logger.error(failure.message + (failure.details ? '\n' + failure.details : '')); } catch {}
        if (!persisted) { try { logger.error('焦点故障无法写入状态，正常结束专用浏览器，避免继续使用旧 ready 状态。'); } catch {} await context.close().catch(() => {}); }
      })().catch(() => {});
    } });
    nativeFocus?.assertHealthy();
    if (closed || !writeState(true, { browserVersion: versionOf(installation?.version) })) throw new Error('专用浏览器已退出或宿主归属已变化。');
    readyPublished = true;
    logger.log(mode === 'background' ? '专用抖音 Edge 已在后台启动。' : '专用抖音 Edge 已启动。');
    for (const signal of ['SIGINT', 'SIGTERM']) processImpl.on(signal, () => context.close().finally(() => exit(0)));
    return { started: true, exitCode: 0 };
  } catch (error) {
    try { await context?.close(); } catch {}
    const failure = error.code === 'EDGE_FOCUS_RESET_FAILED' ? { code: error.code, message: error.message, browserVersion: versionOf(installation?.version), details: sanitizeBrowserFailure(error.cause?.stack || error.message) } : classifyBrowserLaunchError(error, { version: installation?.version });
    try { writeState(false, { launchFailure: { ...failure, at: Date.now() } }); } catch {}
    logger.error(failure.message + (failure.details ? '\n' + failure.details : ''));
    return { started: false, exitCode: 1, failure };
  }
}
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const [profile, controlDir, portText, mode = 'visible'] = process.argv.slice(2);
  const result = await runBrowserHost({ profile, controlDir, port: Number(portText), mode,
    launchVisible: process.platform === 'win32' ? launchWindowsVisibleEdge : undefined });
  if (!result.started) process.exit(result.exitCode);
}
