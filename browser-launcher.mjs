import { chromium } from './playwright-runtime.mjs';

export const PREPARE_PAGE_NAME = 'deepseek-douyin-launcher';
export const PREPARE_HOME = 'https://www.douyin.com/?recommend=1&from_nav=1';
const CONNECT_TIMEOUT = 30_000;

function cancelled(signal) { signal?.throwIfAborted(); }
function abortable(pending, signal, lateResult) {
  if (!signal) return pending;
  let aborted = signal.aborted;
  const onAbort = () => { aborted = true; };
  signal.addEventListener('abort', onAbort, { once: true });
  return new Promise((resolve, reject) => {
    const rejectAbort = () => reject(signal.reason || new Error('打开浏览器已取消。'));
    const cleanup = () => { signal.removeEventListener('abort', onAbort); signal.removeEventListener('abort', rejectAbort); };
    signal.addEventListener('abort', rejectAbort, { once: true });
    if (aborted) rejectAbort();
    Promise.resolve(pending).then(value => { cleanup(); if (aborted) void lateResult?.(value); else resolve(value); }, error => { cleanup(); if (!aborted) reject(error); });
  });
}

// 连接仍只指向已核对归属的专用 CDP；取消时仅断开新建连接，不关闭 Edge 进程。
export async function connectDedicatedBrowser(endpoint, { signal, connect = (url, options) => chromium.connectOverCDP(url, options) } = {}) {
  cancelled(signal);
  try {
    return await abortable(connect(endpoint, { timeout: CONNECT_TIMEOUT }), signal, browser => browser.close().catch(() => {}));
  } catch (error) {
    cancelled(signal);
    throw new Error(error?.name === 'TimeoutError'
      ? '专用 Edge 的调试连接等候30秒仍未就绪。请在本工具的专用窗口关闭无响应标签页后重试。'
      : '无法连接本工具的专用 Edge。请检查专用窗口是否仍可操作，完成系统提示后重试。');
  }
}

function installPreparePause({ label }) {
  window.name = label;
  if (window.__dafeiyuPreparePauseInstalled) return;
  window.__dafeiyuPreparePauseInstalled = true;
  const nativePause = HTMLMediaElement.prototype.pause;
  const pause = video => { try { nativePause.call(video); } catch {} };
  const pauseAll = () => document.querySelectorAll('video').forEach(pause);
  document.addEventListener('play', event => { if (event.target instanceof HTMLVideoElement) pause(event.target); }, true);
  new MutationObserver(pauseAll).observe(document, { childList: true, subtree: true });
  window.addEventListener('pageshow', pauseAll);
  document.addEventListener('DOMContentLoaded', pauseAll, { once: true });
  pauseAll();
}
function pauseResult() {
  const videos = [...document.querySelectorAll('video')];
  videos.forEach(video => video.pause());
  return { paused: videos.every(video => video.paused), videos: videos.length };
}
function allowedPage(url) { try { return url === 'about:blank' || new URL(url).origin === 'https://www.douyin.com'; } catch { return false; } }

// 准备入口只暂停自己命名的页；自主观看存在时只显示原入口。
export class BrowserLauncher {
  constructor({ getBrowser, getWatchState = () => null, homeUrl = PREPARE_HOME } = {}) {
    if (typeof getBrowser !== 'function' || typeof getWatchState !== 'function') throw new Error('打开浏览器缺少专用连接接口。');
    Object.assign(this, { getBrowser, getWatchState, homeUrl }); this.installed = new WeakSet();
  }
  async findPage(browser, label, signal) {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      cancelled(signal);
      if (page.isClosed() || !allowedPage(page.url())) continue;
      if (await abortable(page.evaluate(() => window.name).catch(() => ''), signal) === label) return page;
    }
    return null;
  }
  async showWatch(browser, worker, signal) {
    if (!['api', 'dsh'].includes(worker.source)) throw new Error('自主观看入口无效，未改动浏览器。');
    const page = await this.findPage(browser, `deepseek-douyin-${worker.source}`, signal);
    if (!page) throw new Error('自主观看正在运行，但没有找到它的原入口页。请先从原入口检查或停止这一轮后重试。');
    cancelled(signal); await abortable(page.bringToFront(), signal);
    return { opened: true, mode: 'watch', reused: true, paused: null, watchPreserved: true, sessionChanged: false, message: '已显示当前自主观看窗口，播放和轮次保持原状。' };
  }
  async open({ signal } = {}) {
    cancelled(signal);
    const browser = await this.getBrowser(signal); cancelled(signal);
    let worker = this.getWatchState();
    if (worker) return this.showWatch(browser, worker, signal);
    const context = browser.contexts()[0];
    if (!context) throw new Error('专用 Edge 没有可用资料窗口，请在专用窗口完成系统提示后重试。');
    let page = await this.findPage(browser, PREPARE_PAGE_NAME, signal), reused = Boolean(page);
    worker = this.getWatchState(); if (worker) return this.showWatch(browser, worker, signal);
    if (!page) {
      const blank = [];
      for (const candidate of context.pages()) {
        if (candidate.isClosed() || candidate.url() !== 'about:blank') continue;
        if (await abortable(candidate.evaluate(() => !window.name && !document.body?.textContent?.trim() && document.querySelectorAll('body *').length === 0).catch(() => false), signal)) blank.push(candidate);
      }
      if (blank.length === 1) { page = blank[0]; reused = true; }
    }
    if (!page) page = await abortable(context.newPage(), signal, value => value.close().catch(() => {}));
    worker = this.getWatchState();
    if (worker) { if (!reused) await page.close().catch(() => {}); return this.showWatch(browser, worker, signal); }
    if (!this.installed.has(page)) { await page.addInitScript(installPreparePause, { label: PREPARE_PAGE_NAME }); this.installed.add(page); }
    await abortable(page.evaluate(installPreparePause, { label: PREPARE_PAGE_NAME }), signal);
    if (page.url() === 'about:blank') await abortable(page.goto(this.homeUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }), signal);
    const paused = await abortable(page.evaluate(pauseResult), signal);
    if (!paused.paused) throw new Error('专用准备页的视频未能暂停，请在该页手动暂停后重试。');
    worker = this.getWatchState(); if (worker) return this.showWatch(browser, worker, signal);
    cancelled(signal); await abortable(page.bringToFront(), signal);
    return { opened: true, mode: 'prepare', reused, paused: true, watchPreserved: false, sessionChanged: false, message: '专用抖音入口已打开，入口视频保持暂停。请在此手动登录或完成验证，准备好后再开始有限观看。' };
  }
}
