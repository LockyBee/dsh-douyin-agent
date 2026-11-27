import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolveRuntimePaths } from './runtime-paths.mjs';

const modes = new Set(['visible', 'background']);
export function validateBrowserMode(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !modes.has(input.mode)) {
    throw Object.assign(new TypeError('浏览器运行方式只接受 visible 或 background。'), { status: 400 });
  }
  return input.mode;
}
function read(file, fallback) {
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw Error(); return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('浏览器运行方式无法核对，未覆盖设置。'); }
}
export class BrowserMode {
  constructor({ controlDir = resolveRuntimePaths().browserControlDir } = {}) {
    this.directory = controlDir; this.file = path.join(controlDir, 'browser-mode.json'); this.guard = path.join(controlDir, 'browser-mode.guard');
  }
  policy() {
    const value = read(this.file, { version: 1, mode: 'visible' });
    if (value?.version !== 1 || !modes.has(value.mode) || Object.keys(value).some(key => !['version', 'mode'].includes(key))) throw new Error('浏览器运行方式设置损坏，未继续启动。');
    return value;
  }
  state() {
    const policy = this.policy(), host = read(path.join(this.directory, 'browser.json'), null);
    let running = false; if (Number.isSafeInteger(host?.pid) && host.pid > 0) try { process.kill(host.pid, 0); running = true; } catch (error) { running = error.code === 'EPERM'; }
    const recordedMode = running && host.ready === true && modes.has(host.mode) ? host.mode : null;
    return { protocol: 'browser-mode-v1', mode: policy.mode, recordedMode, running, restartRequired: running && recordedMode !== policy.mode };
  }
  configure(input, { explicit = false } = {}) {
    if (!explicit) throw new Error('浏览器运行方式只能由用户修改。');
    const mode = validateBrowserMode(input);
    fs.mkdirSync(this.directory, { recursive: true }); const token = randomUUID(); let descriptor;
    try { descriptor = fs.openSync(this.guard, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw new Error('浏览器运行方式正在更新，请稍后再试。'); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token })); } finally { fs.closeSync(descriptor); }
    const temporary = `${this.file}.${token}.tmp`;
    try {
      this.policy(); const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, mode }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file); return this.state();
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); const owner = read(this.guard, null); if (owner?.token === token && owner.pid === process.pid) fs.unlinkSync(this.guard); }
  }
}

const verified = new WeakMap();
// 读取浏览器自己的启动参数，不根据网页焦点、页面脚本或缺少窗口推断后台模式。
export async function browserExecutionMode(browser) {
  if (!browser || typeof browser.newBrowserCDPSession !== 'function') return 'unknown';
  const cached = verified.get(browser);
  if (cached && (cached.mode !== 'unknown' || Date.now() - cached.at < 5000)) return cached.promise;
  const entry = { at: Date.now(), mode: 'unknown', promise: null };
  entry.promise = (async () => {
    let session, timer;
    try {
      const work = (async () => {
        session = await browser.newBrowserCDPSession();
        try { const value = await session.send('Browser.getBrowserCommandLine'); if (Array.isArray(value?.arguments) && value.arguments.every(item => typeof item === 'string')) return value.arguments.some(item => /^--headless(?:=|$)/.test(item)) ? 'background' : 'visible'; } catch { /* 某些 Edge 仅在明确启用 automation 时返回启动参数。 */ }
        const version = await session.send('Browser.getVersion');
        return typeof version?.userAgent === 'string' && /\bHeadless(?:Chrome|Edg)\//.test(version.userAgent) ? 'background' : 'unknown';
      })();
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('unknown'), 3000); });
      entry.mode = await Promise.race([work, timeout]);
      void work.then(() => session?.detach().catch(() => {}), () => session?.detach().catch(() => {}));
      return entry.mode;
    } catch { return 'unknown'; }
    finally { clearTimeout(timer); }
  })();
  verified.set(browser, entry); return entry.promise;
}

export async function ownedBrowserExecutionMode(browser, owner, signal) {
  const mode = await browserExecutionMode(browser);
  signal?.throwIfAborted();
  if (mode !== 'unknown' || process.platform !== 'win32' || owner?.mode !== 'visible'
    || owner.headless !== false || owner.ready !== true || !Number.isSafeInteger(owner.pid)
    || !Number.isSafeInteger(owner.port) || !path.isAbsolute(owner.profile || '')) return mode;

  // 有窗口的 Edge 可能不提供启动参数。以连接返回的 PID 核对 Windows 进程及其宿主。
  let session;
  try {
    session = await browser.newBrowserCDPSession();
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const candidates = processInfo.filter(item => item.type === 'browser');
    if (candidates.length !== 1 || !Number.isSafeInteger(candidates[0].id) || candidates[0].id < 1) return mode;
    signal?.throwIfAborted();
    const shell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = String.raw`
      $edge=Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$env:DOUYIN_MODE_EDGE_PID)
      $argsLine=$edge.CommandLine
      if (!$argsLine) { exit }
      $profile=[regex]::Match($argsLine, '(?:^|\s)(?:"--user-data-dir=(?<dir>[^"]+)"|--user-data-dir="(?<dir>[^"]+)"|--user-data-dir=(?<dir>[^\s"]+))(?=\s|$)').Groups['dir'].Value
      $portPattern='(?:^|\s)--remote-debugging-port='+$env:DOUYIN_MODE_PORT+'(?=\s|$)'
      if ($edge.Name -eq 'msedge.exe' -and $edge.ParentProcessId -eq [int]$env:DOUYIN_MODE_HOST_PID -and
          $profile -eq $env:DOUYIN_MODE_PROFILE -and $argsLine -match $portPattern -and
          $argsLine -notmatch '(?:^|\s)"?--headless(?:=|\s|"|$)') { [Console]::Write('visible') }
    `;
    const result = await new Promise((resolve, reject) => {
      execFile(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        env: { ...process.env, DOUYIN_MODE_EDGE_PID: String(candidates[0].id), DOUYIN_MODE_HOST_PID: String(owner.pid),
          DOUYIN_MODE_PROFILE: owner.profile, DOUYIN_MODE_PORT: String(owner.port) },
        signal, windowsHide: true, timeout: 5000, maxBuffer: 2048,
      }, (error, output) => error ? reject(error) : resolve(output.trim()));
    });
    return result === 'visible' ? 'visible' : mode;
  } catch {
    signal?.throwIfAborted();
    return mode;
  } finally {
    await session?.detach().catch(() => {});
  }
}
