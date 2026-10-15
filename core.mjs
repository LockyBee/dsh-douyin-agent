import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from './playwright-runtime.mjs';
import { MemoryStore } from './memory.mjs?v=2';
import { TOOL_DEFINITIONS, validateToolArguments } from './tool-definitions.mjs?v=5';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths, resolveNodeExecutable } from './runtime-paths.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { browserProfileDir: PROFILE, browserControlDir: CONTROL } = resolveRuntimePaths();
const RECOMMEND = 'https://www.douyin.com/?recommend=1&from_nav=1';
const PORT = 9227;

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function aborted(signal) { signal?.throwIfAborted(); }
async function wait(ms, signal) { await delay(ms, undefined, { signal }); }

async function lock(name, signal) {
  mkdirSync(CONTROL, { recursive: true });
  const file = path.join(CONTROL, `${name}.lock`);
  const deadline = Date.now() + 35_000;
  while (true) {
    aborted(signal);
    try {
      const descriptor = openSync(file, 'wx');
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      closeSync(descriptor);
      return () => { try { unlinkSync(file); } catch { /* 已释放的锁无需处理。 */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(readFileSync(file, 'utf8'));
        if (!alive(owner.pid)) { unlinkSync(file); continue; }
      } catch {
        // 空锁只在超过两秒且内容再次一致时释放，给刚启动的持有者留出写入时间。
        try {
          const content=readFileSync(file,'utf8');
          if(Date.now()-statSync(file).mtimeMs>2000) {
            try { JSON.parse(content); } catch {
              if(readFileSync(file,'utf8')===content) unlinkSync(file);
            }
          }
        } catch { /* 其他进程已经释放。 */ }
      }
      if (Date.now() > deadline) throw new Error('同一入口仍在操作浏览器，请稍后重试。');
      await wait(150, signal);
    }
  }
}

async function version() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) });
    return response.ok && /(?:Edg|Chrome)/.test((await response.json()).Browser ?? '');
  } catch { return false; }
}
async function endpoint(signal) {
  const release = await lock('launch', signal);
  try {
    const stateFile = path.join(CONTROL, 'browser.json');
    let state;
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* 首次运行没有状态。 */ }
    const owned = state?.profile === PROFILE && state.port === PORT && alive(state.pid);
    if (await version()) {
      if (!owned || !state.ready) throw new Error('9227 端口不属于本工具的专用浏览器，请先释放端口。');
      return `http://127.0.0.1:${PORT}`;
    }
    if (!owned) {
      const output = openSync(path.join(CONTROL, 'browser-host.log'), 'a');
      try {
        const child = spawn(resolveNodeExecutable(), [path.join(ROOT, 'browser-host.mjs'), PROFILE, CONTROL, String(PORT)], {
          detached: true, windowsHide: true, stdio: ['ignore', output, output],
        });
        child.unref();
      } finally { closeSync(output); }
    }
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      aborted(signal);
      await wait(250, signal);
      try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { continue; }
      if (!alive(state.pid)) throw new Error('专用浏览器启动失败；请正常关闭仍使用 cli-profile 的旧专用窗口后重试。');
      if (state.ready && state.profile === PROFILE && state.port === PORT && await version()) return `http://127.0.0.1:${PORT}`;
    }
    throw new Error('专用浏览器启动超时，请查看本机 browser-host.log。');
  } finally { release(); }
}

// 此函数仅读取网页 DOM 和 HTMLVideoElement，不调用抖音私有接口。
export function readPageState() {
  if(location.origin!=='https://www.douyin.com') return {
    url:null,title:null,video:null,searchResults:[],visibleText:'',loginRequired:false,verificationRequired:false,
    unsupportedPage:true,note:'当前专用标签页已离开抖音，没有读取该页面内容。',
  };
  const visible = element => {
    const r = element.getBoundingClientRect(), s = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const workId = value => {
    try { const u = new URL(value, location.href); return /\/video\/(\d+)/.exec(u.pathname)?.[1] || u.searchParams.get('modal_id') || u.searchParams.get('aweme_id'); } catch { return null; }
  };
  const privateArea='[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
  const privateChatVisible=[...document.querySelectorAll('[data-e2e="im-dialog"]')].some(visible);
  const videoElements = [...document.querySelectorAll('video')].filter(e=>visible(e)&&!e.closest(privateArea)).map(element => {
    const r = element.getBoundingClientRect();
    return { element, area: Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) * Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) };
  }).sort((a,b) => b.area - a.area);
  const element = videoElements[0]?.element;
  const text = [...document.querySelectorAll('body *')].filter(e => e.childElementCount === 0 && visible(e) && !e.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]')).map(e => clean(e.innerText || e.textContent)).filter(Boolean).join('\n').slice(-9000);
  const loginRequired = /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(text);
  const verificationRequired = /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(text);
  let video = null;
  if (element) {
    let container = element.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"]');
    if(!container) {
      container=element.parentElement;
      for(let i=0;container?.parentElement&&i<8;i++) {
        if(container.querySelector('[class*="video-info-detail"]')) break;
        container=container.parentElement;
      }
    }
    const links = [...(container?.querySelectorAll('a[href]') ?? [])].filter(e=>visible(e)&&!e.closest(privateArea));
    const id = /(?:^|\s)video_(\d+)(?:\s|$)/.exec(element.closest('[data-e2e="player-container"]')?.className??'')?.[1] || links.map(e=>workId(e.href)).find(Boolean) || workId(location.href) || null;
    const authorElement = links.find(e => /\/user\//.test(e.href)) || [...(container?.querySelectorAll('span,div')??[])].find(e=>e.childElementCount===0 && /^@/.test(clean(e.textContent)) && visible(e));
    const titleElement = container?.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"],[data-e2e="detail-video-info"],[class*="video-info-detail"]');
    const detailAuthor=container?.querySelector('[data-e2e="related-video"]')?.innerText?.split('\n').map(clean).find(Boolean);
    const captionAuthor=/@([^·\n]+)·/.exec(titleElement?.textContent??'')?.[1]?.trim();
    const r = element.getBoundingClientRect();
    video = { id, url: id ? `https://www.douyin.com/video/${id}` : null,
      author: clean(authorElement?.textContent).replace(/^@\s*/, '') || detailAuthor || captionAuthor || null,
      title: clean(titleElement?.getAttribute('data-e2e')==='detail-video-info'?titleElement.innerText.split('\n')[0]:titleElement?.textContent) || clean(links.find(e=>workId(e.href))?.textContent) || null,
      time: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : null,
      paused: element.paused, muted: element.muted, readyState: element.readyState,
      width: element.videoWidth, height: element.videoHeight,
      viewport: { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.min(innerWidth,r.right)-Math.max(0,r.left), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.top) } };
  }
  const searchResults = [];
  if (location.pathname.startsWith('/search/')) {
    const candidates = [...document.querySelectorAll('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"],a[href*="/video/"],a[href*="modal_id="]')].filter(visible);
    const used = new Set();
    for (const candidate of candidates) {
      const anchor = candidate.matches('a') ? candidate : candidate.querySelector('a[href*="/video/"],a[href*="modal_id="]');
      const id = workId(anchor?.href) || candidate.getAttribute('data-aweme-id') || /waterfall_item_(\d+)/.exec(candidate.closest('[id^="waterfall_item_"]')?.id??'')?.[1];
      const card = candidate.closest('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"]') || candidate;
      const leaves = [...card.querySelectorAll('div,span')].filter(e=>!e.childElementCount).map(e=>clean(e.textContent));
      const title = clean(card.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"]')?.textContent) || leaves.sort((a,b)=>b.length-a.length)[0] || clean(card.textContent);
      if (!title || used.has(id || title)) continue;
      used.add(id || title);
      searchResults.push({ index: searchResults.length, id: id || null, url: id ? `https://www.douyin.com/video/${id}` : null,
        title: title.slice(0,1000), author: clean(card.querySelector('a[href*="/user/"]')?.textContent).replace(/^@\s*/, '') || /@([^\n·]+)/.exec(card.innerText)?.[1]?.trim() || null });
    }
  }
  const u = new URL(location.href);
  for (const key of [...u.searchParams.keys()]) if (!['modal_id','aweme_id','recommend'].includes(key)) u.searchParams.delete(key);
  return { url: u.href, title: document.title, video, searchResults: searchResults.slice(0,20), visibleText: text,
    loginRequired, verificationRequired, privateChatVisible, documentReadyState: document.readyState };
}

export class BrowserController {
  constructor({ source = 'api', memory, videoLimits } = {}) {
    if (!['api','dsh','verification','api-chat','dsh-chat'].includes(source)) throw new TypeError('不支持这个浏览器入口。');
    this.source = source; this.memory = memory; this.browser = null; this.page = null;
    this.queue = Promise.resolve();
    this.videoLimits = videoLimits;
    this.limitsEnabled = ['api','dsh'].includes(source);
  }
  limits() { return this.videoLimits ??= new VideoLimits(); }
  getMediaAdapter() { return this.mediaPromise??=import('./media/index.mjs').then(({MediaAdapter})=>new MediaAdapter()); }
  getForwarder() { return this.forwarderPromise??=import('./video-forward.mjs').then(({VideoForwarder})=>new VideoForwarder({videoLimits:this.limits(),source:this.source==='dsh'?'dsh':'api'})); }
  watchVideoLimits() {
    if (!this.limitsEnabled || this.cancelLimitsWatch) return;
    this.cancelLimitsWatch = this.limits().watch({ sources:[this.source], pause:()=>this.pauseForLimits() });
  }
  async checkVideoLimits(name) {
    if (!this.limitsEnabled) return;
    const decision=this.limits().beforeAction(this.source,name);
    if (!decision.allowed) {
      await this.pauseForLimits();
      throw new Error(decision.reason || '当前不在允许的刷视频时间内，请在本机设置开始一轮。');
    }
  }
  async pauseForLimits() {
    if (!['api','dsh'].includes(this.source)) return { paused:0, existingPage:false };
    let connection=this.browser, temporary=false;
    try {
      if(!connection?.isConnected()) {
        let owner;
        try { owner=JSON.parse(readFileSync(path.join(CONTROL,'browser.json'),'utf8')); } catch { return {paused:0,existingPage:false}; }
        if(owner.profile!==PROFILE || owner.port!==PORT || !owner.ready || !alive(owner.pid) || !await version()) return {paused:0,existingPage:false};
        connection=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`,{timeout:3000}); temporary=true;
      }
      let paused=0,existingPage=false;
      for(const candidate of connection.contexts().flatMap(context=>context.pages())) {
        if(candidate.isClosed() || await candidate.evaluate(()=>window.name).catch(()=>'')!==`deepseek-douyin-${this.source}`) continue;
        existingPage=true;
        paused+=await candidate.evaluate(()=>{
          if(location.origin!=='https://www.douyin.com') return 0;
          let count=0;
          for(const video of document.querySelectorAll('video')) {if(!video.paused) count++;video.pause();}
          return count;
        }).catch(()=>0);
      }
      return {paused,existingPage};
    } finally { if(temporary) await connection?.close().catch(()=>{}); }
  }
  store() { return this.memory ??= new MemoryStore(resolveRuntimePaths().memoryDbPath); }
  getChatService() {
    this.chatPromise??=Promise.all([import('./chat-browser.mjs?v=5'),import('./chat-service.mjs?v=5')])
      .then(([{ChatBrowser},{ChatService}])=>new ChatService({browser:new ChatBrowser({source:this.source==='dsh'?'dsh-chat':'api-chat'})}))
      .catch(error=>{this.chatPromise=null;throw error;});
    return this.chatPromise;
  }
  async connect(signal) {
    aborted(signal);
    if (this.browser?.isConnected() && this.page && !this.page.isClosed()) return this.page;
    this.browser = await chromium.connectOverCDP(await endpoint(signal), { timeout: 7000 });
    const context = this.browser.contexts()[0];
    const label = `deepseek-douyin-${this.source}`;
    for (const candidate of context.pages()) {
      if (await candidate.evaluate(() => window.name).catch(()=>'') === label) { this.page = candidate; break; }
    }
    if (!this.page || this.page.isClosed()) this.page = await context.newPage();
    this.page.setDefaultTimeout(10_000); this.page.setDefaultNavigationTimeout(25_000);
    await this.page.evaluate(name => { window.name = name; }, label);
    aborted(signal);
    if (this.page.url() === 'about:blank') {
      if(this.source.endsWith('-chat')) {
        await this.page.goto(RECOMMEND,{waitUntil:'domcontentloaded'});
        await this.page.evaluate(name=>{window.name=name;},label);
        await this.page.locator('[data-e2e="im-entry"]').waitFor({state:'visible',timeout:15_000});
      }else await this.navigate(RECOMMEND, signal);
    }
    return this.page;
  }
  async navigate(url, signal) {
    aborted(signal);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.evaluate(name => { window.name = name; }, `deepseek-douyin-${this.source}`);
    if (url === RECOMMEND && this.page.url().includes('/jingxuan')) {
      await this.page.locator('a').filter({hasText:/^推荐$/}).click();
    }
    const targetId=/\/video\/(\d+)/.exec(url)?.[1];
    await this.settle(signal, {kind:targetId?'video':url.includes('/search/')?'search':'recommend',videoId:targetId});
  }
  async settle(signal, {kind='recommend',videoId}={}) {
    for (let i=0;i<16;i++) {
      aborted(signal);
      const state = await this.page.evaluate(readPageState);
      if(state.loginRequired||state.verificationRequired) return state;
      const detail=/\/video\/\d+/.test(state.url??'')||/[?&]modal_id=\d+/.test(state.url??'');
      if(kind==='search' && state.searchResults.length && !detail) return state;
      if(kind==='search' && /暂无搜索结果|没有找到相关|暂无结果/.test(state.visibleText)) return state;
      if(kind==='video' && detail && state.video?.id===videoId && state.video.readyState>=2) return state;
      if(kind==='recommend' && state.video?.id && state.video.readyState>=2) return state;
      await wait(500, signal);
    }
    throw new Error(kind==='search'?'搜索结果未就绪，未确认搜索完成。':kind==='video'?'目标作品尚未加载完成，请读取状态后重试。':'推荐流尚未读到就绪视频。');
  }
  async state({ record = true } = {}) {
    const state = await this.page.evaluate(readPageState);
    if (record && state.video?.id) {
      try { this.store().recordVideo(state, this.source); } catch { state.memoryWarning = '视频状态已读取，记忆记录暂不可用。'; }
    }
    return state;
  }
  withPage(callback,{signal}={}) {
    const operation=this.queue.catch(()=>{}).then(async()=>{
      const release=await lock(`tab-${this.source}`,signal);
      const onAbort=()=>{this.browser?.close().catch(()=>{});};
      signal?.addEventListener('abort',onAbort,{once:true});
      try {
        aborted(signal);
        const page=await this.connect(signal);
        aborted(signal);
        if(new URL(page.url()).origin!=='https://www.douyin.com') throw new Error('专用标签页已离开抖音，请重新打开抖音后操作。');
        return await callback(page,signal);
      }finally{signal?.removeEventListener('abort',onAbort);release();}
    });
    this.queue=operation;return operation;
  }
  execute(name, args = {}, { signal, humanAuthorized = false } = {}) {
    const definition = TOOL_DEFINITIONS.find(tool=>tool.name===name);
    if (!definition) return Promise.reject(new Error('不支持的抖音工具。'));
    try { validateToolArguments(definition,args); } catch(error) { return Promise.reject(error); }
    const operation = this.queue.catch(()=>{}).then(async()=>{
      aborted(signal);
      if(name.startsWith('douyin_chat_')) {
        const chat=await this.getChatService();aborted(signal);
        if(name==='douyin_chat_contacts') return chat.listContacts({signal});
        if(name==='douyin_chat_status') return chat.state();
        if(name==='douyin_chat_start') return chat.start({signal});
        if(name==='douyin_chat_stop') return chat.stop();
        if(name==='douyin_chat_read') return chat.readConversation(args.recipientId,{signal});
        if(name==='douyin_chat_observe') return chat.observeMessage(args.recipientId,args.messageId,{signal});
      }
      if(name==='douyin_media_status') return (await this.getMediaAdapter()).status();
      if(name==='douyin_forward_video') {
        if(humanAuthorized!==true) return {sent:false,requiresUserAction:true,note:'请在本机控制台选择这位好友并点击转发；此工具不会代替人类按钮授权。',recipientId:args.recipientId,url:args.url??null};
        return (await this.getForwarder()).forward(args,{signal,humanAuthorized:true});
      }
      if (name==='douyin_recall') return this.store().recall({query:args.query??'',limit:args.limit??10});
      if (name==='douyin_remember') {
        const state = this.page && !this.page.isClosed() ? await this.state({record:false}) : null;
        return this.store().remember({content:args.content,kind:args.kind??'note',source:this.source,
          videoId:state?.video?.id,url:state?.video?.url,author:state?.video?.author,title:state?.video?.title});
      }
      if(name==='douyin_video_limits_status') return this.limits().state();
      this.watchVideoLimits();
      await this.checkVideoLimits(name);
      const release = await lock(`tab-${this.source}`,signal);
      let onAbort;
      try {
        onAbort = () => { this.browser?.close().catch(()=>{}); };
        signal?.addEventListener('abort',onAbort,{once:true});
        await this.connect(signal);
        aborted(signal);
        await this.checkVideoLimits(name);
        if(this.limitsEnabled && !this.limits().state().allowed) await this.pauseForLimits();
        if(!['douyin_open','douyin_search','douyin_open_video'].includes(name) && new URL(this.page.url()).origin!=='https://www.douyin.com') {
          return this.page.evaluate(readPageState);
        }
        if (name==='douyin_open') await this.navigate(RECOMMEND,signal);
        if (name==='douyin_search') await this.navigate(`https://www.douyin.com/search/${encodeURIComponent(args.query)}`,signal);
        if (name==='douyin_open_video') {
          if (args.url) await this.navigate(`https://www.douyin.com/video/${/\/video\/(\d+)/.exec(args.url)[1]}`,signal);
          else {
            const before = await this.state();
            const result = before.searchResults.find(item=>item.index===args.index);
            if (!result) throw new Error('这个 index 不在当前可见搜索结果内，请重新搜索。');
            const card = result.id ? this.page.locator(`[id="waterfall_item_${result.id}"] .search-result-card`) : this.page.locator('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"]').filter({visible:true}).nth(args.index);
            if(await card.count()) { await card.click(); await this.settle(signal,{kind:'video',videoId:result.id}); }
            else if(result.url) await this.navigate(result.url,signal);
            else throw new Error('搜索结果卡片已变化，请重新搜索。');
          }
        }
        if (name==='douyin_next'||name==='douyin_previous') return await this.switchVideo(name==='douyin_next'?1:-1,signal);
        if (name==='douyin_play'||name==='douyin_pause') {
          await (await this.currentVideo()).evaluate(async(video, play)=>{ if(play) await video.play();else video.pause(); },name==='douyin_play');
          if (name==='douyin_play') await wait(600,signal);
        }
        if (name==='douyin_observe'||name==='douyin_screenshot') return await this.capture(name==='douyin_observe'?args.seconds??3:0,signal);
        if(name==='douyin_listen') return await this.listen(args.seconds??8,signal);
        aborted(signal);
        return this.state();
      } finally { signal?.removeEventListener('abort',onAbort); release(); }
    });
    this.queue=operation; return operation;
  }
  async currentVideo() {
    const index = await this.page.locator('video').evaluateAll(videos=>videos.map((video,index)=>{
      const r=video.getBoundingClientRect();
      return {index,area:Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))*Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top))};
    }).filter(item=>item.area>0).sort((a,b)=>b.area-a.area)[0]?.index);
    if(index===undefined) throw new Error('没有在视口内找到视频。');
    return this.page.locator('video').nth(index);
  }
  async switchVideo(direction,signal) {
    const before = await this.state();
    if (!before.video) throw new Error('当前没有可见视频，请先打开推荐或搜索作品。');
    if(before.loginRequired||before.verificationRequired) return {changed:false,before:before.video,state:before};
    const arrow=this.page.locator(`[data-e2e="video-switch-${direction>0?'next':'prev'}-arrow"]`).filter({visible:true});
    if(await arrow.count()) await arrow.first().click();
    else {
      const box=before.video.viewport;
      await this.page.mouse.move(box.x+box.width/2,box.y+box.height/2);
      await this.page.mouse.wheel(0,direction*700);
    }
    let after;
    for(let i=0;i<12;i++) {
      await wait(300,signal); after=await this.state();
      if(after.video?.id&&before.video.id&&after.video.id!==before.video.id&&after.video.readyState>=2) break;
    }
    return {changed:before.video.id&&after.video?.id?before.video.id!==after.video.id:null,
      before:before.video,after:after.video,state:after};
  }
  async capture(seconds,signal) {
    let state=await this.state();
    if(state.loginRequired||state.verificationRequired||state.privateChatVisible) return {state,frames:[],note:'登录、验证或私信面板遮挡画面，本次没有采集图片。'};
    if(!state.video) return {state,frames:[],note:'没有可见视频画面，请先打开作品。'};
    const frames=[],samples=seconds?3:1;
    const before={...state.video};
    let sampledState=state,stoppedReason=null;
    for(let index=0;index<samples;index++) {
      aborted(signal);
      if(index) await wait(seconds*1000/(samples-1),signal);
      state=await this.state();
      await this.checkVideoLimits('douyin_observe');
      if(state.loginRequired||state.verificationRequired||state.unsupportedPage||state.privateChatVisible) return {state,frames:[],note:'出现登录、验证、私信面板或离开抖音，已丢弃本次画面。'};
      if(state.video?.id!==before.id) {stoppedReason='采样期间切换作品，保留的画面只属于此前作品。';break;}
      const {x,y,width,height}=state.video.viewport;
      if(width<2||height<2) break;
      const data=await this.page.screenshot({type:'jpeg',quality:65,clip:{x,y,width,height},timeout:10_000});
      const checked=await this.state();
      if(checked.loginRequired||checked.verificationRequired||checked.unsupportedPage||checked.privateChatVisible) return {state:checked,frames:[],note:'截图期间出现登录、验证、私信面板或离开抖音，已丢弃本次画面。'};
      if(checked.video?.id!==before.id) {stoppedReason='截图期间切换作品，本帧已丢弃。';break;}
      frames.push({mimeType:'image/jpeg',data:data.toString('base64'),time:state.video.time,videoId:state.video.id});
      sampledState=checked;
    }
    return {state:sampledState,frames,observation:{seconds,videoId:before.id,stoppedReason,beforeTime:before.time,afterTime:sampledState.video?.time,paused:sampledState.video?.paused,
      note:'采集的是实际视频视口画面；没有音频，只能说明这些采样时刻。'}};
  }
  async captureAudio(seconds,signal) {
    await this.checkVideoLimits('douyin_listen');
    const before=await this.state({record:false});
    if(before.loginRequired||before.verificationRequired||before.privateChatVisible||!before.video?.id) throw new Error('当前没有可录取的公开作品，或登录、验证、私信面板遮挡页面。');
    const result=await (await this.currentVideo()).evaluate(async(video,seconds)=>{
      if(typeof video.captureStream!=='function' || typeof MediaRecorder==='undefined') throw new Error('浏览器没有提供当前视频的可用音轨采集接口。');
      const wasPaused=video.paused; await video.play();
      const stream=video.captureStream();
      const tracks=stream.getAudioTracks().map(track=>track.clone());
      if(!tracks.length) {if(wasPaused)video.pause();throw new Error('当前作品没有向浏览器暴露可采集音轨，未录取其他声音。');}
      const audio=new MediaStream(tracks),chunks=[];
      const mimeType=['audio/webm;codecs=opus','audio/webm'].find(type=>MediaRecorder.isTypeSupported(type));
      if(!mimeType) {tracks.forEach(track=>track.stop());if(wasPaused)video.pause();throw new Error('浏览器不支持音轨录取格式。');}
      try {
        const recorder=new MediaRecorder(audio,{mimeType,audioBitsPerSecond:64000});
        await new Promise((resolve,reject)=>{
          let size=0; const timer=setTimeout(()=>recorder.state!=='inactive'&&recorder.stop(),seconds*1000);
          recorder.ondataavailable=event=>{size+=event.data.size;if(size>2_000_000){clearTimeout(timer);recorder.stop();reject(new Error('音轨超过2MB采集预算。'));}else chunks.push(event.data);};
          recorder.onerror=()=>{clearTimeout(timer);reject(new Error('当前视频音轨采集失败。'));};
          recorder.onstop=()=>{clearTimeout(timer);resolve();};recorder.start(250);
        });
        const bytes=new Uint8Array(await new Blob(chunks,{type:mimeType}).arrayBuffer());
        if(!bytes.length) throw new Error('当前音轨没有生成可用数据。');
        let encoded='';for(let offset=0;offset<bytes.length;offset+=32768) encoded+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
        return {data:btoa(encoded),mimeType,bytes:bytes.length};
      }finally{tracks.forEach(track=>track.stop());if(wasPaused)video.pause();}
    },seconds);
    aborted(signal);await this.checkVideoLimits('douyin_listen');
    const after=await this.state({record:false});
    if(after.loginRequired||after.verificationRequired||after.privateChatVisible||after.unsupportedPage||after.video?.id!==before.video.id) throw new Error('录音期间页面或作品身份改变，音轨已丢弃。');
    return {...result,videoId:before.video.id,beforeTime:before.video.time,afterTime:after.video.time,seconds,state:after};
  }
  async listen(seconds,signal) {
    const media=await this.getMediaAdapter(),settings=await media.settings();
    if(!settings.enabled) return {ok:true,audioAvailable:false,note:'音频能力默认关闭，请由用户在本机控制台选择开启。'};
    const captured=await this.captureAudio(seconds,signal);
    const directory=resolveRuntimePaths().mediaCaptureDir;mkdirSync(directory,{recursive:true});
    const target=path.join(directory,`${randomUUID()}.webm`);writeFileSync(target,Buffer.from(captured.data,'base64'));
    try {
      const result=await media.transcribeAudio({source:target,backend:settings.backend,durationSeconds:seconds},{signal});
      return {ok:true,audioAvailable:result.ok===true,state:captured.state,audio:{...result,videoId:captured.videoId,beforeTime:captured.beforeTime,afterTime:captured.afterTime,seconds},note:'只采集当前视频这一小段实际音轨；转写不能代替音乐或环境声理解。'};
    }finally{try{unlinkSync(target);}catch{}}
  }
  async close() {
    this.cancelLimitsWatch?.(); this.cancelLimitsWatch=null;
    if(this.limitsEnabled) await this.pauseForLimits();
    await this.queue.catch(()=>{});
    await this.browser?.close().catch(()=>{});
    if(this.chatPromise) await this.chatPromise.then(chat=>chat.close()).catch(()=>{});
    if(this.forwarderPromise) await this.forwarderPromise.then(forwarder=>forwarder.close?.()).catch(()=>{});
    this.memory?.close(); this.browser=null; this.page=null; this.memory=null;
  }
}
