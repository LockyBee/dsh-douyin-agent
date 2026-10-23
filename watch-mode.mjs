import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';

const fail = (message, code = 'WATCH_MODE_INVALID') => Object.assign(new Error(message), { code, status: 409 });
const names = new Set(['deepseek-douyin-api', 'deepseek-douyin-dsh', 'deepseek-douyin-launcher', 'deepseek-douyin-api-chat', 'deepseek-douyin-dsh-chat']);
const read = (file, fallback) => { try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) throw Error(); return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw fail('静默观看设置或窗口凭据无法核对，未重置设置或操作窗口。'); } };
function write(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { const descriptor = fs.openSync(temporary, 'wx', 0o600); try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); } fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function pageIdentity() {
  const visible = element => { const box = element.getBoundingClientRect(), style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const text = [...document.querySelectorAll('body *')].filter(element => !element.childElementCount && visible(element) && !element.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]')).map(element => element.textContent || '').join('\n').slice(-9000);
  return { origin: location.origin, name: window.name, loginRequired: /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(text), verificationRequired: /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(text) };
}
// 不改播放、音量、visibility 或计时；只管理本专用视频页的静音属性。
function installSilentMode({ key, label }) {
  if (location.origin !== 'https://www.douyin.com' || window.name !== label) return { applied: false, reason: '页面不属于指定抖音入口。' };
  let enabled = false;
  try { enabled = sessionStorage.getItem(key) === 'true'; } catch { return { applied: false, reason: '专用页无法保存可回收的静默状态。' }; }
  const property = '__dafeiyuSilentVideoMode';
  const current = window[property];
  if (current && current.label !== label) return { applied: false, reason: '已有其他入口的静默监听，未接管。' };
  if (!enabled) return current?.dispose() || { applied: true, muted: false, mediaCount: 0, restoredMedia: 0, visibility: document.visibilityState };
  if (current) return current.refresh();
  const owned = new Map();
  const allowed = media => media instanceof HTMLMediaElement && !media.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]');
  const restore = (media, value) => { if (value.changed && media.muted === true) { media.muted = value.muted; return true; } return false; };
  const mute = media => {
    if (!allowed(media)) return;
    let value = owned.get(media);
    if (!value) { value = { muted: media.muted, changed: false }; owned.set(media, value); }
    if (!media.muted) { value.changed = true; media.muted = true; }
  };
  const refresh = () => {
    for (const [media, value] of owned) if (!media.isConnected) { restore(media, value); owned.delete(media); }
    document.querySelectorAll('video,audio').forEach(mute);
    return { applied: true, muted: [...owned.keys()].every(media => media.muted), mediaCount: owned.size, restoredMedia: 0, visibility: document.visibilityState };
  };
  const onMedia = event => mute(event.target);
  const observer = new MutationObserver(refresh);
  observer.observe(document, { subtree: true, childList: true });
  document.addEventListener('play', onMedia, true); document.addEventListener('volumechange', onMedia, true);
  const dispose = () => {
    observer.disconnect(); document.removeEventListener('play', onMedia, true); document.removeEventListener('volumechange', onMedia, true);
    let restoredMedia = 0; for (const [media, value] of owned) if (restore(media, value)) restoredMedia++;
    const mediaCount = owned.size; owned.clear(); if (window[property]?.dispose === dispose) delete window[property];
    return { applied: true, muted: false, restoredMedia, mediaCount, visibility: document.visibilityState };
  };
  window[property] = { label, refresh, dispose };
  return refresh();
}

export class WatchMode {
  constructor({ stateDir = resolveRuntimePaths().stateDir, source = 'api', now = Date.now } = {}) {
    if (!['api', 'dsh'].includes(source) || typeof now !== 'function') throw new TypeError('静默观看只适用于 API 或 DSH 视频入口。');
    Object.assign(this, { stateDir, source, now });
    this.policyFile = path.join(stateDir, 'watch-mode.json'); this.controlFile = path.join(stateDir, 'watch-mode-control.guard'); this.windowsFile = path.join(stateDir, 'watch-mode-windows.json');
    this.installed = new WeakSet(); this.lastApplied = null;
  }
  policy() { const value = read(this.policyFile, { version: 1, silent: false }); if (value?.version !== 1 || typeof value.silent !== 'boolean') throw fail('静默观看设置损坏，未用默认值覆盖。'); return value; }
  state() { const policy = this.policy(); return { protocol: 'watch-mode-v1', silent: policy.silent, source: this.source, configured: fs.existsSync(this.policyFile), lastApplied: this.lastApplied, application: this.application || null, capabilities: { headless: false, persistentMute: true, visibilityEmulation: false, minimizeManagedWindow: true, windowRestoreRequiresExplicit: true }, note: '静默模式会静音作品视频并最小化已核对的专用窗口；登录验证时保留显示。后台能否持续播放以实际进度为准。' }; }
  acquireControl() {
    fs.mkdirSync(this.stateDir, { recursive: true }); const owner = { pid: process.pid, token: randomUUID() }; let descriptor;
    try { descriptor = fs.openSync(this.controlFile, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw fail('静默设置或专用窗口操作正在处理，请稍后重试；设置尚未改变。', 'WATCH_MODE_BUSY'); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify(owner)); } finally { fs.closeSync(descriptor); }
    let released = false;
    return () => { if (released) return; released = true; const current = read(this.controlFile, null); if (current?.pid === owner.pid && current.token === owner.token) fs.unlinkSync(this.controlFile); };
  }
  configure(input, { explicit = false } = {}) {
    if (!explicit) throw fail('静默观看开关只能由用户明确修改。');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || typeof input.silent !== 'boolean') throw new TypeError('静默观看只接收 silent 布尔开关。');
    const release = this.acquireControl();
    try { this.policy(); write(this.policyFile, { version: 1, silent: input.silent }); return this.state(); } finally { release(); }
  }
  async identity(page, anyManaged = false) {
    if (!page || page.isClosed()) return { managed: false, blocked: true, reason: '专用页已关闭。' };
    const identity = await page.evaluate(pageIdentity);
    const managed = identity.origin === 'https://www.douyin.com' && (anyManaged ? names.has(identity.name) : identity.name === `deepseek-douyin-${this.source}`);
    return { ...identity, managed, blocked: !managed || identity.loginRequired || identity.verificationRequired };
  }
  async apply(page, { anyVideoSource = false } = {}) {
    const identity = await this.identity(page, anyVideoSource);
    if (anyVideoSource && !['deepseek-douyin-api', 'deepseek-douyin-dsh'].includes(identity.name)) return { applied: false, reason: '此专用页不是作品视频页，未修改媒体。' };
    if (identity.blocked && (!identity.managed || this.policy().silent)) return { silent: this.policy().silent, applied: false, blocked: true, loginRequired: Boolean(identity.loginRequired), verificationRequired: Boolean(identity.verificationRequired), focusRequested: false, reason: identity.managed ? '登录或验证需要手动处理，未新增静默监听或隐藏窗口。' : '未操作非指定的抖音视频页。' };
    const release = this.acquireControl();
    try {
      const silent = this.policy().silent, label = anyVideoSource ? identity.name : `deepseek-douyin-${this.source}`, key = `dafeiyu-watch-mode:${label.replace('deepseek-douyin-', '')}`;
      if (!this.installed.has(page)) { await page.addInitScript(installSilentMode, { key, label }); this.installed.add(page); }
      await page.evaluate(({ key, silent }) => { sessionStorage.setItem(key, String(silent)); }, { key, silent });
      const result = await page.evaluate(installSilentMode, { key, label });
      this.lastApplied = { silent, ...result, at: new Date(this.now()).toISOString(), focusRequested: false, playbackChanged: false, visibilityEmulated: false };
      return this.lastApplied;
    } finally { release(); }
  }
  windows() {
    const value = read(this.windowsFile, { version: 1, windows: [] });
    if (value?.version !== 1 || !Array.isArray(value.windows) || value.windows.length > 32 || value.windows.some(item => !Number.isSafeInteger(item.windowId) || typeof item.targetId !== 'string' || !item.targetId || !['normal', 'maximized', 'fullscreen'].includes(item.previousState) || typeof item.minimizedConfirmed !== 'boolean' || !sourcesValid(item.source)) || new Set(value.windows.map(item => item.windowId)).size !== value.windows.length) throw fail('专用窗口变更凭据损坏，未操作窗口。');
    return value;
  }
  async target(page) {
    const session = await page.context().newCDPSession(page);
    try { const { targetInfo } = await session.send('Target.getTargetInfo'); const { windowId, bounds } = await session.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId }); return { targetId: targetInfo.targetId, windowId, bounds }; }
    finally { await session.detach(); }
  }
  async inspectBrowser(browser) {
    const silent = this.policy().silent;
    if (!browser?.isConnected()) return { silent, connected: false, managedPages: 0, windows: [], mediaCount: 0, unmutedMedia: 0 };
    const pages = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
    if (pages.length > 32) throw fail('专用浏览器标签页过多，无法完整核对。');
    const windows = new Map();
    let managedPages = 0, mediaCount = 0, unmutedMedia = 0, loginRequired = false, verificationRequired = false;
    for (const page of pages) {
      const identity = await this.identity(page, true), target = await this.target(page);
      if (!windows.has(target.windowId)) windows.set(target.windowId, { state: target.bounds.windowState, managedPages: 0, blocked: false });
      const window = windows.get(target.windowId);
      window.blocked ||= identity.blocked;
      if (!identity.managed) continue;
      managedPages++; window.managedPages++;
      loginRequired ||= identity.loginRequired; verificationRequired ||= identity.verificationRequired;
      if (!identity.blocked && ['deepseek-douyin-api', 'deepseek-douyin-dsh'].includes(identity.name)) {
        const media = await page.evaluate(() => {
          const items = [...document.querySelectorAll('video,audio')].filter(item => !item.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]'));
          return { count: items.length, unmuted: items.filter(item => !item.muted).length };
        });
        mediaCount += media.count; unmutedMedia += media.unmuted;
      }
    }
    // 只返回数量和窗口状态，不把网址、页面文字或联系人写进诊断报告。
    return { silent, connected: true, managedPages, mediaCount, unmutedMedia, loginRequired, verificationRequired,
      windows: [...windows.values()].filter(window => window.managedPages).map(window => ({ ...window, manageable: !window.blocked && ['normal', 'maximized', 'minimized'].includes(window.state) })) };
  }
  async managedWindow(page, anyManaged = false) {
    const identity = await this.identity(page, anyManaged);
    if (identity.blocked) throw fail('当前不是可隐藏的专用作品页，或登录验证尚待手动处理。');
    const target = await this.target(page), browser = page.context().browser();
    if (!browser) throw fail('无法核对专用浏览器窗口归属，未隐藏窗口。');
    const pages = browser.contexts().flatMap(context => context.pages()).filter(candidate => !candidate.isClosed());
    if (pages.length > 32) throw fail('专用浏览器标签页过多，未自动改动窗口。');
    let present = false;
    for (const candidate of pages) {
      const other = await this.target(candidate);
      if (other.windowId !== target.windowId) continue;
      if (other.targetId === target.targetId) present = true;
      const checked = await this.identity(candidate, true);
      if (checked.blocked) throw fail('同一窗口包含非受管页面或登录验证，未隐藏窗口。');
    }
    if (!present) throw fail('目标作品页没有出现在已核对的专用窗口中。');
    return target;
  }
  async minimizeManagedWindow(page, { anyManaged = false } = {}) {
    if (!this.policy().silent) return { minimized: false, changed: false, reason: '静默观看尚未开启。', focusRequested: false };
    const release = this.acquireControl();
    try {
      const target = await this.managedWindow(page, anyManaged), value = this.windows();
      if (target.bounds.windowState === 'minimized') return { minimized: true, changed: false, focusRequested: false };
      if (!['normal', 'maximized', 'fullscreen'].includes(target.bounds.windowState)) throw fail('专用窗口状态无法核对，未隐藏窗口。');
      if (target.bounds.windowState === 'fullscreen') throw fail('专用窗口处于全屏，保留用户状态；退出全屏后才能请求静默最小化。');
      value.windows = value.windows.filter(item => item.windowId !== target.windowId);
      const operation = { windowId: target.windowId, targetId: target.targetId, previousState: target.bounds.windowState, source: this.source, minimizedConfirmed: false, at: new Date(this.now()).toISOString() };
      value.windows.push(operation);
      write(this.windowsFile, value);
      const session = await page.context().newCDPSession(page);
      try {
        const checked = await this.managedWindow(page, anyManaged);
        if (checked.targetId !== target.targetId || checked.windowId !== target.windowId || !this.policy().silent) throw fail('隐藏窗口前页面、窗口或许可已改变。');
        await session.send('Browser.setWindowBounds', { windowId: target.windowId, bounds: { windowState: 'minimized' } });
        const after = await session.send('Browser.getWindowForTarget', { targetId: target.targetId });
        if (after.windowId !== target.windowId || after.bounds.windowState !== 'minimized') throw fail('没有确认专用窗口已最小化。');
        operation.minimizedConfirmed = true; write(this.windowsFile, value);
      } finally { await session.detach(); }
      return { minimized: true, changed: true, focusRequested: false, headless: false };
    } finally { release(); }
  }
  async applyBrowser(browser, { minimize = false } = {}) {
    const silent = this.policy().silent, pages = [];
    if (!browser?.isConnected()) return this.application = { applied: false, silent, minimized: false, pendingNextVideoAction: true, message: '静默设置已保存；尚无已连接的专用浏览器，下次浏览时应用。', focusRequested: false };
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      if (page.isClosed()) continue;
      let identity;
      try { identity = await this.identity(page, true); }
      catch { pages.push({ applied: false, window: { minimized: false, reason: '有页面正在切换或无法核对，未改动其窗口。' } }); continue; }
      if (!identity.managed) continue;
      const result = { entry: identity.name, applied: false };
      if (['deepseek-douyin-api', 'deepseek-douyin-dsh'].includes(identity.name)) Object.assign(result, await this.apply(page, { anyVideoSource: true }));
      if (minimize && silent) {
        try { result.window = await this.minimizeManagedWindow(page, { anyManaged: true }); }
        catch (error) { result.window = { minimized: false, reason: error.message }; }
      }
      pages.push(result);
    }
    const minimized = pages.some(item => item.window?.minimized), failures = pages.filter(item => item.window && !item.window.minimized);
    const message = !silent ? '静默观看已关闭；保留当前窗口状态。' : minimized && !failures.length ? '专用浏览器已最小化。' : failures.length ? `静默设置已保存，窗口未全部最小化：${failures[0].window.reason}` : '没有找到可处理的专用抖音页面；下次浏览时应用。';
    return this.application = { applied: minimized || pages.some(item => item.applied), silent, minimized, pages, message, at: new Date(this.now()).toISOString(), focusRequested: false };
  }
  async restoreManagedWindow(page, { explicit = false } = {}) {
    if (!explicit) throw fail('恢复显示专用窗口需要用户明确操作。');
    const release = this.acquireControl();
    try {
      const target = await this.managedWindow(page), value = this.windows(), own = value.windows.find(item => item.windowId === target.windowId && item.targetId === target.targetId && item.minimizedConfirmed);
      if (!own) return { restored: false, changed: false, reason: '没有与当前专用页匹配的自有窗口变更，未接管窗口。', focusRequested: false };
      if (target.bounds.windowState !== 'minimized') { value.windows = value.windows.filter(item => item !== own); write(this.windowsFile, value); return { restored: false, changed: false, reason: '窗口已由用户改变，保留当前状态。', focusRequested: false }; }
      const session = await page.context().newCDPSession(page);
      try {
        await session.send('Browser.setWindowBounds', { windowId: target.windowId, bounds: { windowState: own.previousState } });
        const after = await session.send('Browser.getWindowForTarget', { targetId: target.targetId });
        if (after.windowId !== target.windowId || after.bounds.windowState !== own.previousState) throw fail('没有确认专用窗口已恢复原状态，已保留窗口凭据。');
      }
      finally { await session.detach(); }
      value.windows = value.windows.filter(item => item !== own); write(this.windowsFile, value);
      return { restored: true, changed: true, focusRequested: false, note: '这是用户明确要求的窗口恢复；操作系统可能显示该窗口。' };
    } finally { release(); }
  }
}
function sourcesValid(value) { return value === 'api' || value === 'dsh'; }
