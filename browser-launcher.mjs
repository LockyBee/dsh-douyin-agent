import { findSharedPage } from './browser-pages.mjs';
import { chromium } from './playwright-runtime.mjs';
import { randomUUID } from 'node:crypto';

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
    return await abortable(connect(endpoint, { timeout: CONNECT_TIMEOUT, noDefaults: true }), signal, browser => browser.close().catch(() => {}));
  } catch (error) {
    cancelled(signal);
    throw new Error(error?.name === 'TimeoutError'
      ? '专用 Edge 的调试连接等候30秒仍未就绪。请在本工具的专用窗口关闭无响应标签页后重试。'
      : '无法连接本工具的专用 Edge。请检查专用窗口是否仍可操作，完成系统提示后重试。');
  }
}

function installPreparePause({ label, token, claimInitial = false }) {
  if (location.origin !== 'https://www.douyin.com' && !(claimInitial && location.href === 'about:blank')) return;
  if (window.name !== label && !(claimInitial && !window.name)) return;
  window.name = label;
  if (window.__dafeiyuPreparePauseInstalled) return;
  window.__dafeiyuPreparePauseInstalled = true;
  const nativePause = HTMLMediaElement.prototype.pause;
  const entry = { version:2, token:token || null, label, touched:false, adopted:false };
  const pause = video => { if (window.name !== label || entry.adopted) return; try { nativePause.call(video); } catch {} };
  const pauseAll = () => document.querySelectorAll('video').forEach(pause);
  const played = event => { if (event.target instanceof HTMLVideoElement) pause(event.target); };
  const touched = event => { if (event.isTrusted) entry.touched = true; };
  const types = ['pointerdown','keydown','wheel','touchstart','paste','beforeinput','compositionstart'];
  document.addEventListener('play', played, true);
  for (const type of types) document.addEventListener(type,touched,true);
  const observer = new MutationObserver(pauseAll); observer.observe(document,{childList:true,subtree:true});
  window.addEventListener('pageshow',pauseAll);
  window.addEventListener('popstate',touched);
  document.addEventListener('DOMContentLoaded',pauseAll,{once:true});
  entry.release = () => {
    observer.disconnect(); document.removeEventListener('play',played,true);
    for (const type of types) document.removeEventListener(type,touched,true);
    document.removeEventListener('DOMContentLoaded',pauseAll); window.removeEventListener('pageshow',pauseAll); window.removeEventListener('popstate',touched);
    entry.adopted = true;
  };
  window.__dafeiyuPrepareLease = entry;
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
  constructor({ getBrowser, getWatchState = () => null, homeUrl = PREPARE_HOME, preferExistingWatchPage = false, preferredSource = null } = {}) {
    if (typeof getBrowser !== 'function' || typeof getWatchState !== 'function') throw new Error('打开浏览器缺少专用连接接口。');
    Object.assign(this, { getBrowser, getWatchState, homeUrl, preferExistingWatchPage, preferredSource }); this.installed = new WeakSet(); this.preparedOwnership = new WeakMap();
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
    const page = await findSharedPage(browser, worker.source, signal);
    if (!page) throw new Error('自主观看正在运行，但没有找到它的原入口页。请先从原入口检查或停止这一轮后重试。');
    cancelled(signal); await abortable(page.bringToFront(), signal);
    return { opened: true, mode: 'watch', reused: true, paused: null, watchPreserved: true, sessionChanged: false, message: '已显示当前自主观看窗口，播放和轮次保持原状。' };
  }
  async existingWatchPage(browser, signal) {
    const page=await findSharedPage(browser,this.preferredSource||'api',signal);
    return page?.url()==='about:blank'?null:page;
  }

  async adoptPreparedPage(browser, label, {signal}={}) {
    if(!['deepseek-douyin-api','deepseek-douyin-dsh'].includes(label))return null;
    const candidates=browser.contexts().flatMap(context=>context.pages()).filter(page=>!page.isClosed()&&this.preparedOwnership.has(page));
    if(candidates.length!==1)return null;
    const page=candidates[0],proof=this.preparedOwnership.get(page);cancelled(signal);
    const adopted=await abortable(page.evaluate(({proof,label})=>{
      const entry=window.__dafeiyuPrepareLease;
      if(location.origin!=='https://www.douyin.com'||window.name!=='deepseek-douyin-launcher'||location.href!==proof.url||performance.timeOrigin!==proof.timeOrigin||entry?.version!==2||entry.token!==proof.token||entry.label!==window.name||entry.touched||entry.adopted||typeof entry.release!=='function'||document.hasFocus())return false;
      const visible=element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight&&s.display!=='none'&&s.visibility!=='hidden';};
      if([...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"],[data-e2e="im-dialog"]')].some(visible))return false;
      if([...document.querySelectorAll('body *')].some(node=>!node.childElementCount&&visible(node)&&/扫码登录|验证码登录|登录后即可|手机扫码登录|请完成下方验证|请完成验证|安全验证|拖动滑块/.test(node.textContent||'')))return false;
      if([...document.querySelectorAll('input,textarea,[contenteditable="true"]')].some(element=>element.files?.length||element.type==='file'&&element.value||['INPUT','TEXTAREA'].includes(element.tagName)&&!['button','submit','reset','checkbox','radio'].includes(element.type)&&String(element.value||'').trim()||element.isContentEditable&&String(element.textContent||'').replace(/[\u200B-\u200D\uFEFF]/g,'').trim()))return false;
      if([...document.querySelectorAll('video')].some(video=>!video.paused))return false;
      entry.release();window.name=label;return true;
    },{proof,label}),signal);
    if(!adopted)return null;
    this.preparedOwnership.delete(page);return page;
  }
  async closeIdlePreparedPage(browser,{signal,authorizeClose}={}) {
    cancelled(signal);
    if(typeof authorizeClose!=='function')return{closed:false,reasonCode:'PREPARE_CLOSE_AUTHORIZATION_MISSING'};
    if(this.getWatchState())return{closed:false,reasonCode:'WATCH_ACTIVE'};
    const candidates=browser.contexts().flatMap(context=>context.pages()).filter(page=>!page.isClosed()&&this.preparedOwnership.has(page));
    if(candidates.length!==1)return{closed:false,reasonCode:'OWNED_PREPARE_NOT_UNIQUE'};
    const page=candidates[0],proof=this.preparedOwnership.get(page);
    await authorizeClose();cancelled(signal);
    if(this.getWatchState())return{closed:false,reasonCode:'WATCH_ACTIVE'};
    const eligible=await abortable(page.evaluate(proof=>{
      const entry=window.__dafeiyuPrepareLease;
      if(location.origin!=='https://www.douyin.com'||window.name!=='deepseek-douyin-launcher'||location.href!==proof.url||performance.timeOrigin!==proof.timeOrigin||entry?.version!==2||entry.token!==proof.token||entry.label!==window.name||entry.touched||entry.adopted||typeof entry.release!=='function'||document.hasFocus())return false;
      const visible=element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight&&s.display!=='none'&&s.visibility!=='hidden';};
      if([...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"],[data-e2e="im-dialog"]')].some(visible))return false;
      if([...document.querySelectorAll('body *')].some(node=>!node.childElementCount&&visible(node)&&/扫码登录|验证码登录|登录后即可|手机扫码登录|请完成下方验证|请完成验证|安全验证|拖动滑块/.test(node.textContent||'')))return false;
      if([...document.querySelectorAll('input,textarea,[contenteditable="true"]')].some(element=>element.files?.length||element.type==='file'&&element.value||['INPUT','TEXTAREA'].includes(element.tagName)&&!['button','submit','reset','checkbox','radio'].includes(element.type)&&String(element.value||'').trim()||element.isContentEditable&&String(element.textContent||'').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g,'').trim()))return false;
      return[...document.querySelectorAll('video')].every(video=>video.paused);
    },proof),signal);
    cancelled(signal);if(!eligible)return{closed:false,reasonCode:'PREPARE_NOT_IDLE'};
    await authorizeClose();cancelled(signal);
    if(this.getWatchState())return{closed:false,reasonCode:'WATCH_ACTIVE'};
    await abortable(page.close({runBeforeUnload:false}),signal);
    if(!page.isClosed())return{closed:false,reasonCode:'PREPARE_CLOSE_UNCONFIRMED'};
    this.preparedOwnership.delete(page);this.installed.delete(page);return{closed:true,reasonCode:'OWNED_IDLE_PREPARE_CLOSED'};
  }
  async open({ signal } = {}) {
    cancelled(signal);
    const browser = await this.getBrowser(signal); cancelled(signal);
    let worker = this.getWatchState();
    if (worker) return this.showWatch(browser, worker, signal);
    const context = browser.contexts()[0];
    if (!context) throw new Error('专用 Edge 没有可用资料窗口，请在专用窗口完成系统提示后重试。');
    if(this.preferExistingWatchPage){const existing=await this.existingWatchPage(browser,signal);if(existing){cancelled(signal);await abortable(existing.bringToFront(),signal);return{opened:true,mode:'watch',reused:true,paused:null,watchPreserved:true,activeWatch:false,sessionChanged:false,message:'已显示既有作品页，播放、草稿和页面保持原状。'};}}
    let page = await this.findPage(browser, PREPARE_PAGE_NAME, signal), reused = Boolean(page), claimable = false;
    worker = this.getWatchState(); if (worker) return this.showWatch(browser, worker, signal);
    if (!page) {
      const blank = [];
      for (const candidate of context.pages()) {
        if (candidate.isClosed() || candidate.url() !== 'about:blank') continue;
        if (await abortable(candidate.evaluate(() => !window.name && !document.body?.textContent?.trim() && document.querySelectorAll('body *').length === 0).catch(() => false), signal)) blank.push(candidate);
      }
      if (blank.length === 1) { page = blank[0]; reused = true; claimable = true; }
    }
    if (!page) {page = await abortable(context.newPage(), signal, value => value.close().catch(() => {}));claimable = true;}
    worker = this.getWatchState();
    if (worker) { if (!reused) await page.close().catch(() => {}); return this.showWatch(browser, worker, signal); }
    const token=this.preparedOwnership.get(page)?.token || (claimable?randomUUID():null);
    if (!this.installed.has(page)) { await page.addInitScript(installPreparePause, { label: PREPARE_PAGE_NAME, token }); this.installed.add(page); }
    await abortable(page.evaluate(installPreparePause, { label: PREPARE_PAGE_NAME, token, claimInitial:true }), signal);
    if (page.url() === 'about:blank') { await abortable(page.goto(this.homeUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 }), signal); await abortable(page.evaluate(installPreparePause, { label:PREPARE_PAGE_NAME, token, claimInitial:true }), signal); }
    const paused = await abortable(page.evaluate(pauseResult), signal);
    if (!paused.paused) throw new Error('专用准备页的视频未能暂停，请在该页手动暂停后重试。');
    if(claimable&&token){const proof=await abortable(page.evaluate(()=>({url:location.href,timeOrigin:performance.timeOrigin})),signal);this.preparedOwnership.set(page,{token,...proof});}
    worker = this.getWatchState(); if (worker) return this.showWatch(browser, worker, signal);
    cancelled(signal); await abortable(page.bringToFront(), signal);
    return { opened: true, mode: 'prepare', reused, paused: true, watchPreserved: false, sessionChanged: false, message: '专用抖音入口已打开，入口视频保持暂停。请在此手动登录或完成验证，准备好后再开始有限观看。' };
  }
}
