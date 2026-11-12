import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MemoryStore } from './memory.mjs?v=2';
import { TOOL_DEFINITIONS, validateToolArguments } from './tool-definitions.mjs?v=18';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths, resolveNodeExecutable } from './runtime-paths.mjs?v=10';
import { PersonaMemory } from './persona-memory.mjs?v=10';
import { BrowserLauncher, connectDedicatedBrowser } from './browser-launcher.mjs';
import { pauseExistingVideoPages } from './browser-pause.mjs';
import { browserPageLabel, browserPageLock, findSharedPage, adoptSharedPreparePage } from './browser-pages.mjs';
import { StoryboardFrameStore } from './video-storyboard.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SHARED_CAPTURE_MODE = Symbol('shared-video-frame-capture');
const SHARED_PROOFS = globalThis[Symbol.for('dafeiyu.shared-video-frame-proofs.v1')] ||= new WeakMap();
const SHARED_PROOF_ISSUER = 'dafeiyu-shared-video-capture-v1';
const sharedHash = value => createHash('sha256').update(value).digest('hex');
const sharedSignature = value => sharedHash(JSON.stringify({ proof: value.frameProof, observation: value.observation,
  state: { video: value.state?.video && { id: value.state.video.id, time: value.state.video.time, duration: value.state.video.duration, paused: value.state.video.paused, readyState: value.state.video.readyState }, blocked: Boolean(value.state?.loginRequired || value.state?.verificationRequired || value.state?.privateChatVisible || value.state?.unsupportedPage || value.state?.livePreview?.recognized === true || value.state?.videoSelection?.identityConflict) },
  frames: value.frames.map(frame => ({ videoId: frame.videoId, time: frame.time, timeSemantics: frame.timeSemantics, captureMethod: frame.captureMethod, captureSize: frame.captureSize, captureInterval: frame.captureInterval, mimeType: frame.mimeType, imageHash: sharedHash(frame.data) })) }));
function sharedProgress(before, after) {
  if (!before || !after || before.videoId !== after.videoId || before.elementToken !== after.elementToken || before.sourceHash !== after.sourceHash || before.documentTimeOrigin !== after.documentTimeOrigin
    || before.paused !== false || after.paused !== false || before.seeking !== false || after.seeking !== false || before.readyState < 2 || after.readyState < 2
    || !Number.isFinite(before.duration) || before.duration <= 0 || Math.abs(before.duration - after.duration) > 0.05 || before.loop !== after.loop
    || !Number.isFinite(before.playbackRate) || before.playbackRate <= 0 || before.playbackRate > 4 || before.playbackRate !== after.playbackRate) return null;
  const wall = (after.hostTimeMs - before.hostTimeMs) / 1000, pageWall = (after.pageTimeMs - before.pageTimeMs) / 1000;
  if (!Number.isFinite(wall) || wall < 0 || wall > 40 || !Number.isFinite(pageWall) || pageWall < 0 || Math.abs(wall - pageWall) > 0.35) return null;
  const expected = pageWall * before.playbackRate, direct = after.time - before.time;
  if (![before.time, after.time].every(time => Number.isFinite(time) && time >= 0 && time <= before.duration + 0.05)) return null;
  const turns = before.loop ? Math.max(0, Math.round((expected - direct) / before.duration)) : 0;
  const advanced = direct + turns * before.duration;
  return advanced >= -0.04 && Math.abs(advanced - expected) <= Math.max(0.2, expected * 0.15) ? Math.max(0, advanced) : null;
}
export function verifySharedVideoFrameProof(value, videoId) {
  try {
    const registered = value && SHARED_PROOFS.get(value), proof = value?.frameProof, frames = value?.frames;
    const age = registered ? performance.now() - registered.issuedHostMs : NaN;
    if (!registered || !Number.isFinite(age) || age < 0 || age > 60_000 || proof?.issuer !== SHARED_PROOF_ISSUER || proof.version !== 1 || proof.videoId !== videoId || value.state?.video?.id !== videoId || value.observation?.videoId !== videoId
      || value.state.video.paused !== false || value.state.video.readyState < 2 || value.state.loginRequired || value.state.verificationRequired || value.state.privateChatVisible || value.state.unsupportedPage || value.state.livePreview?.recognized === true || value.state.videoSelection?.identityConflict
      || proof.captureId !== registered.captureId || proof.signatureVersion !== 1 || !Array.isArray(frames) || frames.length < 2 || frames.length > 3 || frames.length !== proof.frameCount
      || !Number.isFinite(proof.requestedSeconds) || proof.requestedSeconds < 0.2 || proof.requestedSeconds > 30
      || !Number.isFinite(proof.actualWallSeconds) || proof.actualWallSeconds < 0.1 || proof.actualWallSeconds > Math.max(10,proof.requestedSeconds+7) || value.observation.actualWallSeconds !== proof.actualWallSeconds
      || !Array.isArray(proof.frameHashes) || proof.frameHashes.length !== frames.length || sharedSignature(value) !== registered.signature) return false;
    const first = frames[0].captureInterval?.before, last = frames.at(-1).captureInterval?.after;
    const total = sharedProgress(first, last);
    if (total === null || total <= 0.1 || last.decodedFrames <= first.decodedFrames || Math.abs((last.hostTimeMs - proof.startedHostMs) / 1000 - proof.actualWallSeconds) > 0.001) return false;
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index], interval = frame.captureInterval, before = interval?.before, after = interval?.after;
      if (frame.videoId !== videoId || frame.mimeType !== 'image/jpeg' || typeof frame.data !== 'string' || frame.time !== before?.time || frame.timeSemantics !== 'capture-before-boundary'
        || !['video-canvas-jpeg-v1', 'cdp-page-screenshot-interval-v1'].includes(frame.captureMethod) || proof.captureMethods?.[index] !== frame.captureMethod
        || frame.captureMethod === 'video-canvas-jpeg-v1' && (!Number.isInteger(frame.captureSize?.width) || !Number.isInteger(frame.captureSize?.height) || frame.captureSize.width < 2 || frame.captureSize.height < 2 || Math.max(frame.captureSize.width, frame.captureSize.height) > 960 || frame.captureSize.width * frame.captureSize.height > 921600)
        || interval.index !== index || before.videoId !== videoId || after.videoId !== videoId || sharedProgress(before, after) === null
        || before.hostTimeMs > interval.screenshotStartedHostMs || interval.screenshotStartedHostMs > interval.screenshotEndedHostMs || interval.screenshotEndedHostMs > after.hostTimeMs
        || before.hostTimeMs < proof.startedHostMs || after.hostTimeMs > proof.endedHostMs || proof.frameHashes[index] !== sharedHash(frame.data)
        || !Number.isSafeInteger(before.decodedFrames) || !Number.isSafeInteger(after.decodedFrames) || after.decodedFrames < before.decodedFrames) return false;
      if (index && sharedProgress(frames[index - 1].captureInterval.after, before) === null) return false;
    }
    return true;
  } catch { return false; }
}
const VIDEO_ACTIONS=new Set(['douyin_open','douyin_search','douyin_open_video','douyin_next','douyin_previous','douyin_observe','douyin_screenshot','douyin_video_zoom','douyin_play','douyin_listen']);
const processAlive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)throw new Error('共享视频操作锁无效。');try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const optionalRecord=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('共享视频操作记录无法读取，未操作视频。');}};
async function watchControl(directory,action,signal) {
  const file=path.join(directory,'watch-control.guard'),token=randomUUID();
  for(let attempt=0;;attempt++) {
    signal?.throwIfAborted(); let descriptor;
    try {descriptor=openSync(file,'wx',0o600);}
    catch(error){if(error.code!=='EEXIST'||attempt>=100)throw Object.assign(new Error('共享视频控制正在更新，请稍后重试。'),{status:409});await wait(20,signal);continue;}
    try {writeFileSync(descriptor,JSON.stringify({pid:process.pid,token}));}
    finally {closeSync(descriptor);}
    try{return action();}finally{if(optionalRecord(file)?.token===token)unlinkSync(file);}
  }
}
async function acquireNativeVideoLease(directory,signal) {
  const file=path.join(directory,'watch-manual.lock'),token=randomUUID();
  await watchControl(directory,()=>{
    const owner=optionalRecord(path.join(directory,'watch-loop.lock'));
    if(owner)throw Object.assign(new Error('自主观看正在运行或需要清理残留，请先停止它再手动操作视频。'),{status:409});
    const manual=optionalRecord(file);
    if(manual&&processAlive(manual.pid))throw Object.assign(new Error('另一个入口正在手动操作视频，请等待完成。'),{status:409});
    writeFileSync(file,JSON.stringify({pid:process.pid,token,kind:'native-tool'}),{mode:0o600});
  },signal);
  return ()=>watchControl(directory,()=>{const manual=optionalRecord(file);if(manual?.pid===process.pid&&manual.token===token)unlinkSync(file);});
}
const { browserProfileDir: PROFILE, browserControlDir: CONTROL } = resolveRuntimePaths();
const RECOMMEND = 'https://www.douyin.com/?recommend=1&from_nav=1';
const PORT = 9227;

export async function observeChatSharedWork({ url, videoId, signal, videoLimits, createInspector, createWatch, onObservation }) {
  if (typeof videoId !== 'string' || !/^\d{1,64}$/.test(videoId) || url !== `https://www.douyin.com/video/${videoId}`) throw new Error('分享作品的公开地址未通过核对。');
  if(onObservation!==undefined&&typeof onObservation!=='function')throw new TypeError('视频续看决策须为本机回调。');
  const check = () => { signal?.throwIfAborted(); const state = videoLimits.state(); if (!state.allowed) throw Object.assign(new Error(state.reason || '当前不在允许观看的时段或额度内。'),{code:'GROUP_VIDEO_WAIT_BUDGET'}); };
  check();
  const inspector = createInspector(), watch = createWatch(inspector);
  let releaseManual, opened = false;
  try {
    if (watch.state().running) {
      await watch.stop({ explicit: true });
      for (let attempt = 0; watch.state().running; attempt++) {
        check();
        if (attempt >= 150) throw Object.assign(new Error('自主观看尚未让出视频页面，分享作品暂未播放。'), { code: 'CHAT_VIDEO_BUSY' });
        await wait(100, signal);
      }
    }
    check();
    releaseManual = watch.claimManual('chat-shared-video');
    await inspector.execute('douyin_open_video', { url }, { signal });
    opened = true;
    check();
    await inspector.execute('douyin_play', {}, { signal });
    if(!onObservation)return await inspector.execute('douyin_observe', { seconds: 3 }, { signal, sharedCaptureMode: SHARED_CAPTURE_MODE });
    let seconds=3,last,segments=0,progress=0,frameCount=0,tailStarted=0;
    const current=async()=>{
      const result=await inspector.execute('douyin_status',{}, {signal}),state=result.state||result;
      if(state.video?.id!==videoId||state.loginRequired||state.verificationRequired||state.privateChatVisible||state.unsupportedPage||state.livePreview?.recognized)throw new Error('续看期间作品或页面状态改变，未继续采用旧视频。');
      return state;
    };
    const finish=reason=>Object.assign(last,{watchOutcome:{stopReason:reason,segments,playbackProgressSeconds:progress,frames:frameCount,reachedEnd:reason==='video-ended',fullVideoObserved:false}});
    for(;;){
      check();let state=await current();
      if(last&&state.video.ended===true)return finish('video-ended');
      let remaining=Number.isFinite(state.video.duration)?state.video.duration-state.video.time:null;
      if(last&&state.video.loop===false&&remaining!==null&&remaining<0.5){
        tailStarted||=performance.now();if(performance.now()-tailStarted>5000)throw Object.assign(new Error('视频尾部没有继续推进，保留已看部分等待恢复。'),{code:'GROUP_VIDEO_PLAYBACK_STALLED'});
        await wait(100,signal);continue;
      }
      tailStarted=0;
      const sampleSeconds=remaining!==null&&remaining>0.4?Math.max(0.2,Math.min(seconds,remaining-0.25)):seconds;
      let observed;
      try{observed=await inspector.execute('douyin_observe',{seconds:sampleSeconds},{signal,sharedCaptureMode:SHARED_CAPTURE_MODE});}
      catch(error){if(last&&(await current()).video.ended===true)return finish('video-ended');throw error;}
      segments++;progress+=observed.observation?.playbackProgressSeconds||0;frameCount+=observed.frames?.length||0;last=observed;
      const first=observed.frames?.[0]?.captureInterval?.before,atEnd=observed.state?.video?.ended===true||Boolean(first?.loop&&observed.observation.playbackProgressSeconds>=first.duration-first.time);
      await inspector.execute('douyin_pause',{}, {signal});
      const decision=await onObservation(observed,{segments,playbackProgressSeconds:progress,frames:frameCount,reachedEnd:atEnd});
      signal?.throwIfAborted();
      if(!decision||!['continue','stop'].includes(decision.action)||decision.action==='continue'&&(!Number.isFinite(decision.seconds)||decision.seconds<0.2||decision.seconds>30))throw new Error('分享视频续看决策格式无效，未擅自结束或续看。');
      if(atEnd)return finish('video-ended');
      if(decision.action==='stop')return finish('model-choice');
      check();seconds=decision.seconds;await current();
      await inspector.execute('douyin_play',{}, {signal});
    }
  } finally {
    try {
      if (opened) await inspector.execute('douyin_pause', {});
    } finally {
      inspector.limitsEnabled = false;
      try { await inspector.close(); }
      finally { try { await watch.close(); } finally { await releaseManual?.(); } }
    }
  }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function aborted(signal) { signal?.throwIfAborted(); }
async function wait(ms, signal) { await delay(ms, undefined, { signal }); }

const QUEUES = Symbol.for('dafeiyu.browser-operation-queues.v1');
const localQueues = globalThis[QUEUES] ||= new Map();
const lockFailure = name => Object.assign(new Error(`${name.endsWith('-chat') ? '聊天窗口' : '浏览器窗口'}排队等待超时，请检查当前操作。`), { code:'BROWSER_LOCK_BUSY', lockName:name, status:409 });
async function localTurn(key, signal, timeoutMs, name) {
  const previous=localQueues.get(key)||Promise.resolve();let finish;
  const gate=new Promise(resolve=>{finish=resolve;}),tail=previous.catch(()=>{}).then(()=>gate);
  localQueues.set(key,tail);void tail.then(()=>{if(localQueues.get(key)===tail)localQueues.delete(key);});
  let timer,onAbort;
  try {
    aborted(signal);
    await Promise.race([previous.catch(()=>{}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(lockFailure(name)),timeoutMs);if(signal){onAbort=()=>reject(signal.reason||new Error('已取消排队。'));signal.addEventListener('abort',onAbort,{once:true});}})]);
    aborted(signal);return finish;
  } catch(error) {finish();throw error;}
  finally {clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);}
}

export async function acquireBrowserOperationLock(name,{signal,directory=CONTROL,timeoutMs=35_000}={}) {
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(name)||!path.isAbsolute(directory)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new TypeError('浏览器操作锁参数无效。');
  const started=Date.now(),key=path.resolve(directory)+String.fromCharCode(0)+name,releaseTurn=await localTurn(process.platform==='win32'?key.toLowerCase():key,signal,timeoutMs,name);
  const file=path.join(directory,`${name}.lock`),token=randomUUID(),deadline=started+timeoutMs;
  try {
    mkdirSync(directory,{recursive:true});
    while(true) {
      aborted(signal);let descriptor;
      try {descriptor=openSync(file,'wx',0o600);}
      catch(error) {
        if(error.code!=='EEXIST')throw error;
        let raw,owner;
        try {raw=readFileSync(file,'utf8');owner=JSON.parse(raw);}
        catch(failure) {
          if(failure.code==='ENOENT')continue;
          let fresh=false;
          try{fresh=Date.now()-statSync(file).mtimeMs<2000;}catch(error){if(error.code==='ENOENT')continue;throw error;}
          if(failure instanceof SyntaxError&&fresh&&Date.now()<deadline){await wait(Math.min(50,timeoutMs),signal);continue;}
          throw Object.assign(new Error('浏览器操作锁记录无法核对，请运行自检。'),{code:'BROWSER_LOCK_RECOVERY',lockName:name,status:409});
        }
        if(!Number.isSafeInteger(owner?.pid)||owner.pid<1)throw Object.assign(new Error('浏览器操作锁归属不明，请运行自检。'),{code:'BROWSER_LOCK_RECOVERY',lockName:name,status:409});
        let ownerAlive;
        try{process.kill(owner.pid,0);ownerAlive=true;}catch(error){if(error.code==='ESRCH')ownerAlive=false;else if(error.code==='EPERM')ownerAlive=true;else throw Object.assign(new Error('浏览器操作锁进程无法核实，请运行自检。'),{code:'BROWSER_LOCK_RECOVERY',lockName:name,status:409});}
        if(!ownerAlive) {
          try{if(readFileSync(file,'utf8')===raw){unlinkSync(file);continue;}}
          catch(error){if(error.code==='ENOENT')continue;throw error;}
        }
        if(Date.now()>=deadline)throw lockFailure(name);
        await wait(Math.min(50,timeoutMs),signal);continue;
      }
      try{writeFileSync(descriptor,JSON.stringify({pid:process.pid,token,createdAt:Date.now()}));}finally{closeSync(descriptor);}
      let released=false;
      return ()=>{if(released)return;released=true;try{const owner=JSON.parse(readFileSync(file,'utf8'));if(owner.pid!==process.pid||owner.token!==token)throw Object.assign(new Error('浏览器操作锁归属已经变化，未删除其他操作的锁。'),{code:'BROWSER_LOCK_CHANGED',lockName:name,status:409});unlinkSync(file);}finally{releaseTurn();}};
    }
  }catch(error){releaseTurn();throw error;}
}
const lock=(name,signal,directory=CONTROL)=>acquireBrowserOperationLock(name,{signal,directory});

async function version() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) });
    return response.ok && /(?:Edg|Chrome)/.test((await response.json()).Browser ?? '');
  } catch { return false; }
}
export function dedicatedHostReadiness(state, { pid, profile, port, processAlive = alive } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !processAlive(pid)) return 'failed';
  // 新宿主写入前可能仍读到旧的已退出记录；只核对本次等待的进程。
  if (!state || state.pid !== pid) return 'pending';
  if (state.profile !== profile || state.port !== port) return 'foreign';
  return state.ready === true ? 'ready' : 'pending';
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
    let hostPid = state?.pid;
    if (!owned) {
      const output = openSync(path.join(CONTROL, 'browser-host.log'), 'a');
      try {
        const child = spawn(resolveNodeExecutable(), [path.join(ROOT, 'browser-host.mjs'), PROFILE, CONTROL, String(PORT)], {
          detached: true, windowsHide: true, stdio: ['ignore', output, output],
        });
        hostPid = child.pid;
        child.unref();
      } finally { closeSync(output); }
    }
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      aborted(signal);
      await wait(250, signal);
      try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { state = null; }
      const readiness = dedicatedHostReadiness(state, { pid: hostPid, profile: PROFILE, port: PORT });
      if (readiness === 'failed') throw new Error('专用浏览器启动失败；请正常关闭仍使用 cli-profile 的旧专用窗口后重试。');
      if (readiness === 'foreign') throw new Error('专用浏览器宿主归属无法核对，未连接该端口。');
      if (readiness === 'ready' && await version()) return `http://127.0.0.1:${PORT}`;
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
  const boundedAuthor = value => { const name = clean(value).replace(/^@\s*/, ''); return name && name.length <= 256 && !name.includes('\0') ? name : null; };
  const workId = value => {
    try { const u = new URL(value, location.href); return /\/video\/(\d+)/.exec(u.pathname)?.[1] || u.searchParams.get('modal_id') || u.searchParams.get('aweme_id'); } catch { return null; }
  };
  const privateArea='[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
  const privateChatVisible=[...document.querySelectorAll('[data-e2e="im-dialog"]')].some(visible);
  const videoVisible = element => {
    if(!visible(element))return false;
    for(let node=element;node;node=node.parentElement)if(Number(getComputedStyle(node).opacity)===0)return false;
    return true;
  };
  const videoElements = [...document.querySelectorAll('video')].filter(e=>videoVisible(e)&&!e.closest(privateArea)).map(element => {
    const r = element.getBoundingClientRect();
    return { element, area: Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) * Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) };
  }).sort((a,b) => b.area - a.area);
  const element = videoElements[0]?.element;
  const text = [...document.querySelectorAll('body *')].filter(e => e.childElementCount === 0 && visible(e) && !e.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]')).map(e => clean(e.innerText || e.textContent)).filter(Boolean).join('\n').slice(-9000);
  const loginRequired = /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(text);
  const verificationRequired = [...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"]')].some(visible) || /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(text);
  let video = null, activeContainer = null, videoIdentityConflict = false;
  if (element) {
    let container = element.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"]');
    activeContainer = container;
    if(!container) {
      container=element.parentElement;
      for(let i=0;container?.parentElement&&i<8;i++) {
        if(container.querySelector('[class*="video-info-detail"]')) break;
        container=container.parentElement;
      }
    }
    const links = [...(container?.querySelectorAll('a[href]') ?? [])].filter(e=>visible(e)&&!e.closest(privateArea));
    const playerId=/(?:^|\s)video_(\d+)(?:\s|$)/.exec(element.closest('[data-e2e="player-container"]')?.className??'')?.[1],activeId=/(?:^|\s)video_(\d+)(?:\s|$)/.exec(activeContainer?.className??'')?.[1];
    videoIdentityConflict=Boolean(playerId&&activeId&&playerId!==activeId);
    const id = videoIdentityConflict?null:playerId || activeId || links.map(e=>workId(e.href)).find(Boolean) || workId(location.href) || null;
    const authorElement = links.find(e => /\/user\//.test(e.href)) || [...(container?.querySelectorAll('span,div')??[])].find(e=>e.childElementCount===0 && /^@/.test(clean(e.textContent)) && visible(e));
    const titleElement = container?.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"],[data-e2e="detail-video-info"],[class*="video-info-detail"]');
    const detailAuthor=container?.querySelector('[data-e2e="related-video"]')?.innerText?.split('\n').map(clean).find(Boolean);
    const captionAuthor=/@([^·\n]+)·/.exec(titleElement?.textContent??'')?.[1]?.trim();
    const r = element.getBoundingClientRect();
    video = { id, url: id ? `https://www.douyin.com/video/${id}` : null,
      author: boundedAuthor(authorElement?.textContent) || boundedAuthor(detailAuthor) || boundedAuthor(captionAuthor),
      title: (clean(titleElement?.getAttribute('data-e2e')==='detail-video-info'?titleElement.innerText.split('\n')[0]:titleElement?.textContent) || clean(links.find(e=>workId(e.href))?.textContent)).slice(0, 1000) || null,
      time: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : null,
      paused: element.paused, muted: element.muted, readyState: element.readyState, ended:element.ended, loop:element.loop,
      width: element.videoWidth, height: element.videoHeight,
      viewport: { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.min(innerWidth,r.right)-Math.max(0,r.left), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.top) } };
  }
  const route = new URL(location.href);
  const recommendFeed = ['/', '/recommend', '/recommend/'].includes(route.pathname) && !workId(route.href);
  const feedCards = [...document.querySelectorAll('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"]')].filter(e => visible(e) && !e.closest(privateArea));
  if (!activeContainer && feedCards.length === 1) activeContainer = feedCards[0];
  let livePreview = null;
  if (recommendFeed && activeContainer?.matches('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"]') && !video?.id && !privateChatVisible && !loginRequired && !verificationRequired) {
    const roomIds = [...activeContainer.querySelectorAll('a[href]')].filter(visible).map(link => {
      try { const target = new URL(link.href, location.href); return target.origin === 'https://live.douyin.com' ? /^\/(\d{4,30})\/?$/.exec(target.pathname)?.[1] : null; } catch { return null; }
    }).filter(Boolean);
    const unique = [...new Set(roomIds)];
    if (unique.length === 1) {
      const r = (element || activeContainer).getBoundingClientRect();
      livePreview = { recognized: true, source: 'active-feed-live-link', scope: 'recommend-feed', roomId: unique[0],
        viewport: { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.min(innerWidth,r.right)-Math.max(0,r.left), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.top) } };
    }
  }
  if (!livePreview && !video?.id && !privateChatVisible && !loginRequired && !verificationRequired && recommendFeed) {
    const hasLiveAvatar = [...document.querySelectorAll('[data-e2e="live-avatar"]')].some(visible);
    const hasLiveTag = [...document.querySelectorAll('div,span')].some(el => visible(el) && el.childElementCount === 0 && (el.textContent || '').trim() === '直播中' && (!activeContainer || activeContainer.contains(el)));
    if (hasLiveAvatar || hasLiveTag) {
      const seed = (document.body?.innerText || '').slice(0, 200);
      let hash = 0; for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 10000000000;
      const host = element || activeContainer;
      const r = host ? host.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      livePreview = { recognized: true, source: 'active-feed-live-avatar', scope: 'recommend-feed', roomId: String(1000000000 + (hash % 9000000000)),
        viewport: { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.min(innerWidth,r.right)-Math.max(0,r.left), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.top) } };
    }
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
        title: title.slice(0,1000), author: boundedAuthor(card.querySelector('a[href*="/user/"]')?.textContent) || boundedAuthor(/@([^\n·]+)/.exec(card.innerText)?.[1]) });
    }
  }
  let identityDiagnostics = null;
  if (!video?.id && !livePreview) {
    try {
      const attr = el => el ? { tag: el.tagName, id: el.id || null, cls: String(el.className || '').slice(0, 120), e2e: el.getAttribute('data-e2e') || null } : null;
      const cards = [...document.querySelectorAll('[data-e2e]')].filter(visible).slice(0, 12).map(attr);
      const links = [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 10).map(el => ({ href: el.getAttribute('href'), text: (el.textContent || '').trim().slice(0, 30) }));
      const liveLike = [...document.querySelectorAll('*')].filter(el => visible(el) && el.childElementCount === 0 && /直播/.test(el.textContent || '')).slice(0, 6).map(el => ({ text: (el.textContent || '').trim().slice(0, 20), ...attr(el) }));
      identityDiagnostics = { cards, links, liveLike, path: location.pathname, search: location.search.slice(0, 200) };
    } catch (error) { identityDiagnostics = { error: String((error && error.message) || error) }; }
  }
  const u = new URL(location.href);
  for (const key of [...u.searchParams.keys()]) if (!['modal_id','aweme_id','recommend'].includes(key)) u.searchParams.delete(key);
  return { url: u.href, title: document.title, video, ...(identityDiagnostics ? { identityDiagnostics } : {}), videoSelection: { candidateCount: videoElements.length, ambiguous: videoElements.length > 1 || videoIdentityConflict, identityConflict: videoIdentityConflict }, pageKind: livePreview ? 'live-preview' : video?.id ? 'video' : location.pathname.startsWith('/search/') ? 'search' : 'unknown', livePreview, searchResults: searchResults.slice(0,20), visibleText: text,
    loginRequired, verificationRequired, privateChatVisible, documentReadyState: document.readyState };
}

export async function createBackgroundPage(browser, context, {signal, authorizePrepare, timeoutMs = 5000} = {}) {
  aborted(signal);
  if (typeof authorizePrepare !== 'function' || typeof browser?.newBrowserCDPSession !== 'function' || typeof context?.newCDPSession !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw Object.assign(new Error('缺少后台建页或授权接口，未自动打开页面。'), {code:'CHAT_BACKGROUND_PAGE_UNSUPPORTED'});
  const timeout = AbortSignal.timeout(timeoutMs), boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const markerUrl = 'about:blank#dafeiyu-background-' + randomUUID(), initial = new Set(context.pages());
  let session, targetId, mappedTarget = false, complete = false;
  const bounded = pending => new Promise((resolve, reject) => {
    const stop = () => { cleanup(); reject(boundedSignal.reason); }, cleanup = () => boundedSignal.removeEventListener('abort', stop);
    boundedSignal.addEventListener('abort', stop, {once:true});
    if (boundedSignal.aborted) stop();
    Promise.resolve(pending).then(value => { cleanup(); boundedSignal.aborted ? reject(boundedSignal.reason) : resolve(value); }, error => { cleanup(); reject(error); });
  });
  const authorize = async () => { boundedSignal.throwIfAborted(); await bounded(authorizePrepare()); boundedSignal.throwIfAborted(); };
  const cleanupTarget = async channel => {
    const targets = (await channel.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page' && (info.url === markerUrl || mappedTarget && info.targetId === targetId && info.url === 'about:blank') && (!targetId || info.targetId === targetId));
    if (targets.length > 1) throw new Error('后台空白页标记不唯一，未关闭其他页面。');
    if (targets.length === 1) await channel.send('Target.closeTarget', {targetId:targets[0].targetId});
  };
  try {
    await authorize();
    const opening = browser.newBrowserCDPSession();
    opening.then(value => { if (boundedSignal.aborted && session !== value) void value.detach().catch(() => {}); }, () => {});
    session = await bounded(opening);
    const witness = [...initial].find(page => !page.isClosed());
    if (!witness) throw Object.assign(new Error('没有可核对的既有浏览器上下文，未自动建页。'), {code:'CHAT_BACKGROUND_CONTEXT_UNVERIFIED'});
    let contextSession, browserContextId;
    try {
      contextSession = await bounded(context.newCDPSession(witness));
      const info = (await bounded(contextSession.send('Target.getTargetInfo'))).targetInfo;
      if (typeof info?.targetId !== 'string' || !info.targetId) throw new Error('既有浏览器上下文无法核对。');
      browserContextId = info.browserContextId;
      if (browserContextId !== undefined && (typeof browserContextId !== 'string' || !browserContextId)) throw new Error('浏览器上下文标识无效。');
    } finally { await contextSession?.detach(); }
    await authorize();
    const creating = session.send('Target.createTarget', {url:markerUrl, background:true, ...(browserContextId ? {browserContextId} : {})});
    creating.then(value => { if (value?.targetId) targetId = value.targetId; }, () => {});
    const created = await bounded(creating); targetId = created.targetId;
    if (typeof targetId !== 'string' || !targetId) throw new Error('后台建页没有返回可核对的targetId。');
    for (;;) {
      boundedSignal.throwIfAborted();
      const candidates = context.pages().filter(page => !initial.has(page) && !page.isClosed());
      if (candidates.length > 8) throw new Error('同时出现过多新页面，未认领回复页。');
      for (const page of candidates) {
        let pageSession;
        try {
          pageSession = await bounded(context.newCDPSession(page));
          const info = (await bounded(pageSession.send('Target.getTargetInfo'))).targetInfo;
          if (info?.targetId !== targetId) continue;
          if (page.url() !== markerUrl) throw new Error('新建后台页已被改动，未继续自动准备。');
          mappedTarget = true;
          await authorize();
          if (page.isClosed() || page.url() !== markerUrl) throw new Error('授权等候期间新建后台页已被改动，未导航。');
          await bounded(page.goto('about:blank', {waitUntil:'domcontentloaded', timeout:timeoutMs}));
          await authorize();
          if (page.isClosed() || page.url() !== 'about:blank') throw new Error('后台空白页已变化，未认领。');
          complete = true; return page;
        } finally { await pageSession?.detach(); }
      }
      await delay(20, undefined, {signal:boundedSignal});
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw Object.assign(new Error('后台建页等待超时，未继续自动准备。', {cause:error}), {code:'CHAT_BACKGROUND_PAGE_TIMEOUT'});
    throw error;
  } finally {
    try {
      if (!complete && session) await cleanupTarget(session);
    } finally { await session?.detach(); }
  }
}

export class BrowserController {
  constructor({ source = 'api', memory, videoLimits, personaMemory, controlDirectory = CONTROL } = {}) {
    if (!['api','dsh','verification','api-chat','dsh-chat'].includes(source)) throw new TypeError('不支持这个浏览器入口。');
    if(!path.isAbsolute(controlDirectory))throw new TypeError('浏览器控制目录须为绝对路径。');
    this.controlDirectory=controlDirectory;
    this.source = source; this.memory = memory; this.personaMemory = personaMemory; this.browser = null; this.page = null;
    this.queue = Promise.resolve();
    this.videoLimits = videoLimits;
    this.limitsEnabled = ['api','dsh'].includes(source);
  }
  limits() { return this.videoLimits ??= new VideoLimits(); }
  getMediaAdapter() { return this.mediaPromise??=import('./media/index.mjs?v=10').then(({MediaAdapter})=>new MediaAdapter()); }
  getForwarder() { return this.forwarderPromise??=import('./video-forward.mjs?v=10').then(({VideoForwarder})=>new VideoForwarder({videoLimits:this.limits(),source:this.source==='dsh'?'dsh':'api'})); }
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
  pauseForLimits() {
    return this.pauseInFlight ??= this.pauseForLimitsOnce().finally(() => { this.pauseInFlight = null; });
  }
  async pauseForLimitsOnce() {
    if (!['api','dsh'].includes(this.source)) return { paused:0, existingPage:false };
    let accountingError;
    try { this.limits().settleWatching?.(this.source); } catch(error) { if(error.code!=='VIDEO_CONTROL_BUSY')accountingError=error; }
    const connection=this.browser;
    try {
      if(!connection?.isConnected()) {
        let owner;
        try { owner=JSON.parse(readFileSync(path.join(this.controlDirectory,'browser.json'),'utf8')); } catch { return {paused:0,existingPage:false}; }
        if(owner.profile!==PROFILE || owner.port!==PORT || !owner.ready || !alive(owner.pid) || !await version()) return {paused:0,existingPage:false};
        return await pauseExistingVideoPages({ endpoint:`http://127.0.0.1:${PORT}`,source:this.source });
      }
      let paused=0,existingPage=false;
      for(const candidate of connection.contexts().flatMap(context=>context.pages())) {
        if(candidate.isClosed()) continue;
        const result=await candidate.evaluate(label=>{
          if(location.origin!=='https://www.douyin.com'||window.name!==label) return {matched:false,paused:0};
          let count=0;
          for(const video of document.querySelectorAll('video')) {if(!video.paused) count++;HTMLMediaElement.prototype.pause.call(video);}
          return {matched:true,paused:count};
        },browserPageLabel(this.source)).catch(()=>({matched:false,paused:0}));
        existingPage ||=result.matched;paused+=result.paused;
      }
      return {paused,existingPage};
    } finally {
      for(let attempt=0;attempt<5;attempt++){try{this.limits().settleWatching?.(this.source);break;}catch(error){if(error.code!=='VIDEO_CONTROL_BUSY'){accountingError ||=error;break;}if(attempt<4)await new Promise(resolve=>setTimeout(resolve,25));}}
      if(accountingError)throw accountingError;
    }
  }
  store() { return this.memory ??= new MemoryStore(resolveRuntimePaths().memoryDbPath); }
  async observeSharedWork(input) {
    const { AutonomousWatch } = await import('./autonomous-watch.mjs?v=10');
    const release = await lock('chat-shared-video', input.signal, this.controlDirectory);
    try {
      return await observeChatSharedWork({ ...input, videoLimits: this.limits(),
        createInspector: () => new BrowserController({ source: 'api', videoLimits: this.limits(), controlDirectory: this.controlDirectory }),
        createWatch: controller => new AutonomousWatch({ controller, config: {}, videoLimits: this.limits(), personaMemory: this.getPersonaMemory(), stateDir: this.limits().stateDir, source: 'api' }),
      });
    } finally { release(); }
  }
  getPersonaMemory() {
    if (!this.personaMemory) {
      this.personaMemory = new PersonaMemory({ memoryDir: path.dirname(this.memory?.dbPath || resolveRuntimePaths().memoryDbPath) });
      this.personaMemory.initialize({ importLegacy: false });
    }
    return this.personaMemory;
  }
  getChatService() {
    this.chatPromise??=Promise.all([import('./chat-browser.mjs?v=18'),import('./chat-service.mjs?v=18'),import('./usage-ledger.mjs')])
      .then(([{ChatBrowser},{ChatService},{UsageLedger}])=>{const stateDir=this.limits().stateDir,source=this.source==='dsh'?'dsh':'api';const service=new ChatService({stateDir,browser:new ChatBrowser({source:source==='dsh'?'dsh-chat':'api-chat'}),onPrepared:options=>this.releaseIdlePreparePage(options),observeSharedWork:input=>this.observeSharedWork(input),videoLimits:this.limits()});service.agent.personaMemory=this.getPersonaMemory();service.agent.getMemoryStore=()=>this.store();service.agent.usageLedger=new UsageLedger({stateDir});service.agent.source=source;return service;})
      .catch(error=>{this.chatPromise=null;throw error;});
    return this.chatPromise;
  }
  getSparkService() {
    this.sparkPromise ??= Promise.all([this.getChatService(), import('./spark-service.mjs?v=18')]).then(([chat, { SparkService }]) => new SparkService({ browser: chat.browser, config: chat.config, personaMemory: this.getPersonaMemory(), stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' })).catch(error => { this.sparkPromise = null; throw error; });
    return this.sparkPromise;
  }
  getCommenter() {
    this.commenterPromise ??= import('./comment-browser.mjs?v=18').then(({ CommentBrowser }) => new CommentBrowser({ source: this.source === 'dsh' ? 'dsh' : 'api', videoLimits: this.limits(), stateDir: this.limits().stateDir })).catch(error => { this.commenterPromise = null; throw error; });
    return this.commenterPromise;
  }
  getComments() {
    this.commentsPromise ??= import('./autonomous-comments.mjs?v=10').then(({ AutonomousComments }) => new AutonomousComments({ controller: this, personaMemory: this.getPersonaMemory(), videoLimits: this.limits(), stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' })).catch(error => { this.commentsPromise = null; throw error; });
    return this.commentsPromise;
  }
  getReport() {
    this.reportPromise ??= import('./daily-report.mjs?v=10').then(({ DailyReport }) => new DailyReport({ personaMemory: this.getPersonaMemory() })).catch(error => { this.reportPromise = null; throw error; });
    return this.reportPromise;
  }
  getWatchMode() {
    this.modePromise ??= import('./watch-mode.mjs?v=18').then(({ WatchMode }) => new WatchMode({ stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' }));
    return this.modePromise;
  }
  async applyWatchMode({ minimize = false } = {}) {
    if (!['api', 'dsh'].includes(this.source)) return { applied: false, reason: '当前入口不管理视频静默设置。' };
    const mode = await this.getWatchMode();
    return mode.applyBrowser(await this.connectExistingBrowser(), { minimize });
  }
  async connectExistingBrowser({ signal } = {}) {
    if (this.browser?.isConnected()) return this.browser;
    let owner;
    try { owner = JSON.parse(readFileSync(path.join(this.controlDirectory, 'browser.json'), 'utf8')); } catch { return null; }
    if (owner.profile !== PROFILE || owner.port !== PORT || !owner.ready || !alive(owner.pid) || !await version()) return null;
    // 保存静默设置只重新连接已经存在的专用浏览器，不启动窗口或新建标签。
    this.browser = await connectDedicatedBrowser(`http://127.0.0.1:${PORT}`, { signal });
    this.page = null;
    return this.browser;
  }
  releaseIdlePreparePage({signal,authorizePrepare}={}) {
    const operation=this.queue.catch(()=>{}).then(async()=>{
      aborted(signal);
      if(!this.browser?.isConnected()||!this.browserLauncher?.closeIdlePreparedPage)return{closed:false,reasonCode:'PREPARE_OWNER_UNAVAILABLE'};
      const releaseClaim=await lock('tab-claim',signal,this.controlDirectory);
      try{
        const releaseLauncher=await lock('browser-launcher',signal,this.controlDirectory);
        try{
          const result=await this.browserLauncher.closeIdlePreparedPage(this.browser,{signal,authorizeClose:authorizePrepare});
          if(this.page?.isClosed())this.page=null;return result;
        }finally{releaseLauncher();}
      }finally{releaseClaim();}
    });
    this.queue=operation;return operation;
  }

  openBrowser({ signal } = {}) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const release = await lock('browser-launcher', signal,this.controlDirectory);
      try {
        this.browserLauncher ??= new BrowserLauncher({
          preferExistingWatchPage:true, preferredSource:this.source,
          getBrowser: async currentSignal => { if (!this.browser?.isConnected()) { this.browser = await connectDedicatedBrowser(await endpoint(currentSignal), { signal: currentSignal }); this.page = null; } return this.browser; },
          getWatchState: () => { const worker = optionalRecord(path.join(this.limits().stateDir, 'watch-loop.lock')); if (!worker) return null; if (!Number.isSafeInteger(worker.pid) || worker.pid < 1 || !['api', 'dsh'].includes(worker.source) || typeof worker.runId !== 'string') throw new Error('自主观看锁无法核对，未打开或改动入口页。'); return alive(worker.pid) ? worker : null; },
        });
        return await this.browserLauncher.open({ signal });
      } finally { release(); }
    });
    this.queue = operation; return operation;
  }
  async connect(signal, { launch = true, create = true, authorizePrepare } = {}) {
    aborted(signal);
    const label=browserPageLabel(this.source);
    let createdPage = null;
    const eligiblePage = candidate => { const address = candidate.url(); return address === 'about:blank' || /^https:\/\/www\.douyin\.com(?:\/|$)/.test(address); };
    try {
    if(this.browser?.isConnected()&&this.page&&!this.page.isClosed()) {
      if(this.source==='verification')return this.page;
      if(await this.page.evaluate(()=>window.name).catch(()=>null)===label) {
        let owned=0;
        for(const candidate of this.browser.contexts()[0].pages()){aborted(signal);if(!candidate.isClosed()&&await candidate.evaluate(()=>window.name).catch(()=>null)===label&&eligiblePage(candidate))owned++;}
        if(owned>1)throw new Error('发现多个归属相同的专用标签，请保留一个后再试。');
        if(owned===1 && eligiblePage(this.page) && this.page.url()!=='about:blank')return this.page;
      }
      this.page=null;
    }
    if(!this.browser?.isConnected()){
      if (!launch) {
        if (!await this.connectExistingBrowser({ signal })) throw Object.assign(new Error('专用浏览器未运行，未自动打开。'), { code: 'BROWSER_NOT_RUNNING' });
      } else { this.browser=await connectDedicatedBrowser(await endpoint(signal),{signal});this.page=null; }
    }
    const releaseClaim=await lock('tab-claim',signal,this.controlDirectory);
    try {
      const context=this.browser.contexts()[0];
      this.page=await findSharedPage(this.browser,this.source,signal);
      if(this.page && await this.page.evaluate(()=>window.name)!==label)await this.page.evaluate(name=>{window.name=name;},label);
      if(!this.page&&create&&['api','dsh'].includes(this.source)){
        const releaseLauncher=await lock('browser-launcher',signal,this.controlDirectory);
        try{if(authorizePrepare){await authorizePrepare();aborted(signal);}this.page=await adoptSharedPreparePage(this.browser,{signal});}finally{releaseLauncher();}
      }
      if(!this.page){
        if (!create) throw Object.assign(new Error('消息页未打开，未在后台新建标签。'), { code: 'CHAT_PAGE_NOT_OPEN' });
        const initial=[];
        for(const candidate of context.pages()){if(candidate.isClosed()||candidate.url()!=='about:blank')continue;if(await candidate.evaluate(()=>!window.name&&!document.body?.textContent?.trim()&&document.querySelectorAll('body *').length===0).catch(()=>false))initial.push(candidate);}
        if (authorizePrepare) { await authorizePrepare(); aborted(signal); }
        this.page=initial.length===1?initial[0]:(createdPage=authorizePrepare?await createBackgroundPage(this.browser,context,{signal,authorizePrepare}):await context.newPage());
        await this.page.evaluate(name=>{window.name=name;},label);
      }
      this.page.setDefaultTimeout(10_000);this.page.setDefaultNavigationTimeout(25_000);aborted(signal);
      if(await this.page.evaluate(()=>window.name)!==label)throw new Error('专用标签页归属未通过核对，未继续操作。');
    }finally{releaseClaim();}
    if(this.page.url()==='about:blank') {
      if (!create) throw Object.assign(new Error('消息页未打开，未在后台导航空白标签。'), { code: 'CHAT_PAGE_NOT_OPEN' });
      if (authorizePrepare) { await authorizePrepare(); aborted(signal); }
      if(this.source.endsWith('-chat')){await this.page.goto(RECOMMEND,{waitUntil:'domcontentloaded'});await this.page.evaluate(name=>{window.name=name;},label);await this.page.locator('[data-e2e="im-entry"]').waitFor({state:'visible',timeout:15_000});}
      else await this.navigate(RECOMMEND,signal);
    }
    aborted(signal);
    return this.page;
    } catch (error) {
      if (createdPage && !createdPage.isClosed()) {
        const name = await createdPage.evaluate(() => window.name).catch(() => null);
        const address = createdPage.url();
        const managedAddress = address === 'about:blank' || address.startsWith('chrome-error://') || /^https:\/\/www\.douyin\.com(?:\/|$)/.test(address);
        const state = managedAddress ? await createdPage.evaluate(readPageState).catch(() => null) : null;
        if (managedAddress && (name === label || name === '') && !state?.loginRequired && !state?.verificationRequired) {
          await createdPage.close().catch(() => {});
          if (this.page === createdPage) this.page = null;
        }
      }
      throw error;
    }
  }

  async navigate(url, signal) {
    aborted(signal);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.evaluate(name => { window.name = name; }, browserPageLabel(this.source));
    if (url === RECOMMEND && this.page.url().includes('/jingxuan')) {
      await this.page.locator('a').filter({hasText:/^推荐$/}).click();
    }
    const targetId=/\/video\/(\d+)/.exec(url)?.[1];
    await this.settle(signal, {kind:targetId?'video':url.includes('/search/')?'search':'recommend',videoId:targetId});
  }
  async settle(signal, {kind='recommend',videoId}={}) {
    for (let i=0;i<=60;i++) {
      aborted(signal);
      const state = await this.page.evaluate(readPageState);
      aborted(signal);
      if(state.loginRequired||state.verificationRequired) return state;
      const detail=/\/video\/\d+/.test(state.url??'')||/[?&]modal_id=\d+/.test(state.url??'');
      if(kind==='search' && state.searchResults.length && !detail) return state;
      if(kind==='search' && /暂无搜索结果|没有找到相关|暂无结果/.test(state.visibleText)) return state;
      if(kind==='video' && detail && state.video?.id===videoId && state.video.readyState>=2) return state;
      if(kind==='recommend' && (state.video?.id && state.video.readyState>=2 || state.livePreview?.recognized === true)) return state;
      if(i<60)await wait(500, signal);
    }
    throw new Error(kind==='search'?'搜索结果未就绪，未确认搜索完成。':kind==='video'?'目标作品尚未加载完成，请读取状态后重试。':'推荐流尚未读到就绪视频。');
  }
  async state({ record = true } = {}) {
    const state = await this.page.evaluate(readPageState);
    if (['api','dsh'].includes(this.source)) this.limits().notePlayback?.(this.source,state);
    if (record && state.video?.id) {
      try { this.store().recordVideo(state, this.source); } catch { state.memoryWarning = '视频状态已读取，记忆记录暂不可用。'; }
    }
    return state;
  }
  withPage(callback,{signal,launch=true,create=true,authorizePrepare}={}) {
    const operation=this.queue.catch(()=>{}).then(async()=>{
      const release=await lock(browserPageLock(this.source),signal,this.controlDirectory);
      const onAbort=()=>{this.browser?.close().catch(()=>{});};
      signal?.addEventListener('abort',onAbort,{once:true});
      try {
        aborted(signal);
        if (authorizePrepare) { await authorizePrepare(); aborted(signal); }
        const page=await this.connect(signal,{launch,create,authorizePrepare});
        aborted(signal);
        if (['api', 'dsh'].includes(this.source)) await (await this.getWatchMode()).apply(page);
        if(new URL(page.url()).origin!=='https://www.douyin.com') throw Object.assign(new Error('专用标签页已离开抖音，请重新打开抖音或准备回复通道后操作。'), { code: 'CHAT_PAGE_LEFT_DOUYIN' });
        return await callback(page,signal);
      }finally{signal?.removeEventListener('abort',onAbort);release();}
    });
    this.queue=operation;return operation;
  }
  async hoverByText(label, signal) {
    const allowed = ['筛选', '视频', '用户', '直播', '综合', '最新', '最多点赞', '一天内', '一周内', '多列', '单列', '综合排序', '最新发布', '半年内', '1分钟以下', '1-5分钟', '5分钟以上', '关注的人', '最近看过', '还未看过', '图文', '不限', '排序依据', '发布时间', '视频时长', '搜索范围', '内容形式'];
    if (!allowed.includes(label)) return { ok: false, reason: 'not-allowed' };
    const target = this.page.getByText(label, { exact: true });
    const count = await target.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 4); i++) {
      const loc = target.nth(i);
      try {
        if (!(await loc.isVisible())) continue;
        await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        await loc.hover({ timeout: 2000 });
        await wait(700, signal);
        return { ok: true, hovered: i, label };
      } catch (error) { continue; }
    }
    return { ok: false, reason: 'not-found', label };
  }
  async tapByText(label, signal) {
    const pickMatch = /^(.+)#(\d+)$/.exec(label);
    const wantIndex = pickMatch ? Math.max(0, Number(pickMatch[2]) - 1) : 0;
    if (pickMatch) label = pickMatch[1];
    const allowed = ['筛选', '视频', '用户', '直播', '综合', '最新', '最多点赞', '一天内', '一周内', '多列', '单列', '综合排序', '最新发布', '半年内', '1分钟以下', '1-5分钟', '5分钟以上', '关注的人', '最近看过', '还未看过', '图文', '不限', '排序依据', '发布时间', '视频时长', '搜索范围', '内容形式'];
    if (!allowed.includes(label)) return { ok: false, reason: 'not-allowed' };
    const fingerprint = () => this.page.evaluate(() => (document.body ? document.body.innerText.slice(0, 200) + '|' + document.body.innerText.length : '')).catch(() => '');
    const before = await fingerprint();
    const attempts = [];
    let clicked = false;
    try {
      const target = this.page.getByText(label, { exact: true });
      const count = await target.count();
      for (let i = wantIndex; i < Math.min(count, wantIndex + 2); i++) {
        const loc = target.nth(i);
        try {
          if (!(await loc.isVisible())) continue;
          await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
          let done = false;
          const btnBox = loc.locator('xpath=ancestor-or-self::button[1]');
          try {
            if (await btnBox.count()) {
              await btnBox.first().hover({ timeout: 1200 }).catch(() => {});
              await btnBox.first().click({ timeout: 2500 });
              attempts.push('button#' + i); done = true;
            }
          } catch (error) { attempts.push('button#' + i + ':' + String((error && error.message) || error).slice(0, 60)); }
          if (!done && label === '筛选') {
            const box = await loc.boundingBox().catch(() => null);
            if (box && box.width > 0) {
              try {
                await this.page.mouse.click(box.x + box.width + 14, box.y + box.height / 2);
                attempts.push('arrow-right#' + i); done = true;
              } catch (error) { attempts.push('arrow-right#' + i + ':' + String((error && error.message) || error).slice(0, 60)); }
            }
          }
          if (!done) {
            await loc.hover({ timeout: 1200 }).catch(() => {});
            await loc.click({ timeout: 2500 });
            attempts.push('playwright#' + i); done = true;
          }
          clicked = done; if (done) break;
        } catch (error) {
          attempts.push('playwright#' + i + ':' + String((error && error.message) || error).slice(0, 70));
          try {
            const btn = loc.locator('xpath=ancestor-or-self::button[1]');
            if (await btn.count()) { await btn.first().click({ timeout: 2000, force: true }); attempts.push('button-force#' + i); clicked = true; break; }
          } catch (inner) { attempts.push('button-force#' + i + ':' + String((inner && inner.message) || inner).slice(0, 70)); }
        }
      }
    } catch (error) { attempts.push('locator:' + String((error && error.message) || error).slice(0, 70)); }
    await wait(1500, signal);
    let after = await fingerprint();
    if (!clicked && before === after) {
      const dom = await this.page.evaluate(text => {
        const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const all = [...document.querySelectorAll('button,span,div,a')].filter(el => visible(el) && (el.textContent || '').trim().length > 0 && (el.textContent || '').trim().length <= 20);
        const textOf = el => (el.textContent || '').trim();
        const exact = all.filter(el => textOf(el) === text);
        const contains = all.filter(el => textOf(el).includes(text));
        const hit = exact[0] || contains.sort((a, b) => textOf(a).length - textOf(b).length)[0];
        if (!hit) return { ok: false, reason: 'not-found', nearby: [...new Set(all.map(textOf).filter(Boolean))].slice(0, 30) };
        (hit.closest('button') || hit).click();
        return { ok: true };
      }, label).catch(error => ({ ok: false, reason: String((error && error.message) || error) }));
      attempts.push('dom:' + (dom && dom.ok ? 'ok' : (dom && dom.reason) || 'fail'));
      if (dom && dom.ok) clicked = true;
      await wait(800, signal);
      after = await fingerprint();
    }
    return { ok: clicked, changed: before !== after, label, attempts };
  }
  async scrollSearchResults(signal, pages = 1) {
    for (let i = 0; i < pages; i++) {
      aborted(signal);
      try {
        await this.page.evaluate(() => {
          const card = document.querySelector('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"]');
          let node = card;
          while (node && node !== document.body) {
            const style = getComputedStyle(node);
            if (/(auto|scroll)/.test(String(style.overflowY))) {
              const step = Math.round(node.clientHeight * 0.85);
              if (step > 0 && node.scrollHeight - node.scrollTop - node.clientHeight > 40) { node.scrollBy(0, step); return; }
              break;
            }
            node = node.parentElement;
          }
          window.scrollBy(0, Math.round(innerHeight * 0.85));
        });
      } catch (error) { /* 滚动失败不影响搜索 */ }
      await wait(700, signal);
    }
  }
  execute(name, args = {}, { signal, humanAuthorized = false, autonomousRunId, expectedVideoId, sharedCaptureMode } = {}) {
    const definition = TOOL_DEFINITIONS.find(tool=>tool.name===name);
    if (!definition) return Promise.reject(new Error('不支持的抖音工具。'));
    if (sharedCaptureMode !== undefined && (sharedCaptureMode !== SHARED_CAPTURE_MODE || name !== 'douyin_observe')) return Promise.reject(new Error('内部分享采样模式未由宿主授权。'));
    try {
      if(sharedCaptureMode===SHARED_CAPTURE_MODE){if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>key!=='seconds')||!Number.isFinite(args.seconds)||args.seconds<0.2||args.seconds>30)throw new TypeError('本机分享视频单批采集参数无效。');}
      else validateToolArguments(definition,args);
    } catch(error) { return Promise.reject(error); }
    if(expectedVideoId!==undefined&&(!['douyin_next','douyin_previous'].includes(name)||typeof expectedVideoId!=='string'||!/^\d{1,64}$/.test(expectedVideoId)))return Promise.reject(new TypeError('预期作品ID只供换片宿主使用，须为纯数字字符串。'));
    if (name.startsWith('douyin_diagnostics')) {
      if (!this.diagnosticsService) return Promise.reject(new Error('诊断服务尚未加载，请更新插件或软件。'));
      signal?.throwIfAborted();
      return name === 'douyin_diagnostics' ? this.diagnosticsService.run() : this.diagnosticsService.repair(args, { signal });
    }
    if (name === 'douyin_chat_observe') return this.getChatService().then(chat => { aborted(signal); return chat.observeMessage(args.recipientId, args.messageId, { signal }); });
    const operation = this.queue.catch(()=>{}).then(async()=>{
      let releaseNativeLease;
      try {
      aborted(signal);
      if(this.source==='dsh'&&!autonomousRunId&&VIDEO_ACTIONS.has(name)) releaseNativeLease=await acquireNativeVideoLease(this.limits().stateDir,signal);
      if (this.limitsEnabled && ['douyin_open','douyin_search','douyin_open_video','douyin_next','douyin_previous','douyin_observe','douyin_screenshot','douyin_video_zoom','douyin_play','douyin_listen','douyin_pause'].includes(name)) {
        let owner;
        try { owner=JSON.parse(readFileSync(path.join(this.limits().stateDir,'watch-loop.lock'),'utf8')); }
        catch(error) { if(error.code!=='ENOENT' && name!=='douyin_pause') throw new Error('自主观看锁无法核对，未操作视频。'); }
        if(owner) {
          let living=false;
          if(!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.runId!=='string') { if(name!=='douyin_pause')throw new Error('自主观看锁无效，未操作视频。'); }
          else { try {process.kill(owner.pid,0);living=true;}catch(error){living=error.code==='EPERM';} }
          if(living && owner.runId!==autonomousRunId) {
            if(name!=='douyin_pause') throw Object.assign(new Error('自主观看正在运行，请先停止它再手动操作视频。'),{status:409});
            const requestFile=path.join(this.limits().stateDir,'watch-stop.request.json'),temporary=`${requestFile}.${randomUUID()}.tmp`;
            try {writeFileSync(temporary,JSON.stringify({runId:owner.runId,requestedAt:Date.now()}),{flag:'wx'});renameSync(temporary,requestFile);}
            finally {try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
          }
        }
      }
      if(name.startsWith('douyin_chat_')) {
        const chat=await this.getChatService();aborted(signal);
        if(name==='douyin_chat_contacts') return chat.listContacts({signal});
        if(name==='douyin_chat_status') return chat.state();
        if(name==='douyin_chat_start') return chat.start({signal});
        if(name==='douyin_chat_stop') return chat.stop();
        if(name==='douyin_chat_read') return chat.readConversation(args.recipientId,{signal});
        if(name==='douyin_chat_observe') return chat.observeMessage(args.recipientId,args.messageId,{signal});
      }
      if (name.startsWith('douyin_spark_')) {
        if(name==='douyin_spark_start') throw new Error('自动续火花功能已移除。');
        const spark = await this.getSparkService(); aborted(signal);
        if (name === 'douyin_spark_status') return spark.state();
        if (name === 'douyin_spark_start') return spark.start({ schedule: true, explicit: true });
        if (name === 'douyin_spark_stop') return spark.stop({ explicit: true });
      }
      if (name === 'douyin_report_status') return (await this.getReport()).state();
      if (name === 'douyin_report_generate') return (await this.getReport()).generate({ reason: 'manual' });
      if(name==='douyin_media_status') return (await this.getMediaAdapter()).status();
      if(name==='douyin_forward_video') {
        if(humanAuthorized!==true) return {sent:false,requiresUserAction:true,note:'请在本机控制台选择这位好友并点击转发；此工具不会代替人类按钮授权。',recipientId:args.recipientId,url:args.url??null};
        return (await this.getForwarder()).forward(args,{signal,humanAuthorized:true});
      }
      if (name==='douyin_recall') return this.store().recall({query:args.query??'',limit:args.limit??10});
      if (name==='douyin_persona_status') return this.getPersonaMemory().snapshot();
      if (name==='douyin_watch_status') {
        const {AutonomousWatch}=await import('./autonomous-watch.mjs?v=10');
        this.watchStatusReader??=new AutonomousWatch({controller:this,config:{},videoLimits:this.limits(),personaMemory:this.getPersonaMemory(),source:this.source==='dsh'?'dsh':'api',stateDir:this.limits().stateDir});
        return this.watchStatusReader.state();
      }
      if (name==='douyin_interest_record') return this.getPersonaMemory().updateAgentInterests({ evidenceId:args.evidenceId,topics:[{topic:args.topic,signal:args.signal}],reflection:args.reflection },{source:this.source==='dsh'?'dsh':'api'});
      if (name==='douyin_remember') {
        const state = this.page && !this.page.isClosed() ? await this.state({record:false}) : null;
        return this.store().remember({content:args.content,kind:args.kind??'note',source:this.source,
          videoId:state?.video?.id,url:state?.video?.url,author:state?.video?.author,title:state?.video?.title});
      }
      if(name==='douyin_video_limits_status') return this.limits().state();
      this.watchVideoLimits();
      await this.checkVideoLimits(name);
      const release = await lock(browserPageLock(this.source),signal,this.controlDirectory);
      let onAbort;
      try {
        onAbort = () => { this.browser?.close().catch(()=>{}); };
        signal?.addEventListener('abort',onAbort,{once:true});
        await this.connect(signal);
        aborted(signal);
        if (['api', 'dsh'].includes(this.source)) {
          const mode = await this.getWatchMode();
          await mode.apply(this.page);
          if (mode.state().silent) {
            await mode.applyBrowser(this.browser, { minimize: true });
          }
        }
        await this.checkVideoLimits(name);
        if(this.limitsEnabled && !this.limits().state().allowed) await this.pauseForLimits();
        if(!['douyin_open','douyin_search','douyin_open_video'].includes(name) && new URL(this.page.url()).origin!=='https://www.douyin.com') {
          return this.page.evaluate(readPageState);
        }
        if (name==='douyin_open') await this.navigate(RECOMMEND,signal);
        if (name==='douyin_search') {
          await this.navigate(`https://www.douyin.com/search/${encodeURIComponent(args.query)}`,signal);
          await this.scrollSearchResults(signal, 1);
          if (args.hover) this.lastHoverResult = await this.hoverByText(args.hover, signal);
          const rawTap = Array.isArray(args.taps) && args.taps.length ? args.taps : (typeof args.tap === 'string' ? args.tap.split('|') : []);
          const tapLabels = rawTap.map(item => String(item).trim()).filter(Boolean).slice(0, 3);
          this.lastTapResults = [];
          for (const label of tapLabels) { this.lastTapResult = await this.tapByText(label, signal); this.lastTapResults.push(this.lastTapResult); }
        }
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
        if (name==='douyin_next'||name==='douyin_previous') return await this.switchVideo(name==='douyin_next'?1:-1,signal,{recordLearning:!autonomousRunId,expectedVideoId});
        if (name==='douyin_play'||name==='douyin_pause') {
          await (await this.currentVideo()).evaluate(async(video, play)=>{ if(play) await video.play();else video.pause(); },name==='douyin_play');
          if (name==='douyin_play') await wait(600,signal);
        }
        if (name==='douyin_observe'||name==='douyin_screenshot') {
          const result=await this.capture(name==='douyin_observe'?args.seconds??3:0,signal,{recordLearning:!autonomousRunId,sharedCaptureMode});
          if(sharedCaptureMode===undefined){this.storyboardFrames??=new StoryboardFrameStore();try{const id=this.storyboardFrames.remember(result);if(id)result.storyboardSampleId=id;}catch{this.storyboardFrames.clear();}}
          return result;
        }
        if (name==='douyin_more') {
          const before = await this.state({ record: false });
          const beforeText = String(before.visibleText || '');
          let opened = false;
          const moreBtn = this.page.locator('[data-e2e*="more"], [aria-label*="更多"], [aria-label*="more"]').filter({ visible: true });
          if (await moreBtn.count()) {
            try { await moreBtn.first().click({ timeout: 2500 }); opened = true; } catch (error) { /* 退到长按 */ }
          }
          await wait(600, signal);
          let after = await this.state({ record: false });
          if (!opened || String(after.visibleText || '') === beforeText) {
            const targetForRight = await this.currentVideo().catch(() => null);
            if (targetForRight) {
              const boxRight = await targetForRight.boundingBox().catch(() => null);
              if (boxRight) {
                try {
                  await this.page.mouse.click(boxRight.x + boxRight.width / 2, boxRight.y + boxRight.height / 2, { button: 'right' });
                  opened = true;
                  await wait(900, signal);
                  const rightAfter = await this.state({ record: false });
                  if (String(rightAfter.visibleText || '') !== beforeText) after = rightAfter;
                } catch (error) { /* 右键失败再试长按 */ }
              }
            }
          }
          if (!opened || String(after.visibleText || '') === beforeText) {
            const target = await this.currentVideo().catch(() => null);
            if (target) {
              const box = await target.boundingBox().catch(() => null);
              if (box) {
                try {
                  await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                  await this.page.mouse.down();
                  await wait(900, signal);
                  await this.page.mouse.up();
                  opened = true;
                } catch (error) { /* 长按失败也不影响读取 */ }
              }
            }
            await wait(800, signal);
            after = await this.state({ record: false });
          }
          let pressed = null;
          if (args.press !== undefined) {
            const key = String(args.press).toUpperCase();
            if (!['R', 'X', 'Z', 'J', 'F', 'P', 'V'].includes(key)) throw new Error('不支持的菜单快捷键。');
            await this.page.keyboard.press(key).catch(() => {});
            pressed = key;
            await wait(900, signal);
            after = await this.state({ record: false });
          }
          return { ...after, moreOpened: opened, ...(pressed ? { pressed } : {}) };
        }
        if(name==='douyin_video_zoom'){
          const state=await this.state({record:false});
          if(state.loginRequired||state.verificationRequired||state.privateChatVisible||state.unsupportedPage||state.videoSelection?.identityConflict||state.livePreview?.recognized||state.video?.id!==args.videoId)throw Error('当前页面或作品与原分镜不一致，未返回旧画面。');
          if(!this.storyboardFrames)throw Error('没有本入口的原分镜，请先观察当前作品。');
          return{state,...this.storyboardFrames.zoom(args)};
        }
        if(name==='douyin_listen') return await this.listen(args.seconds??8,signal);
        aborted(signal);
        const finalState = await this.state();
        if (this.lastTapResult) { finalState.tapResult = this.lastTapResult; this.lastTapResult = null; }
        if (Array.isArray(this.lastTapResults) && this.lastTapResults.length) { finalState.tapResults = this.lastTapResults.slice(); this.lastTapResults = []; }
        if (this.lastHoverResult) { finalState.hoverResult = this.lastHoverResult; this.lastHoverResult = null; }
        return finalState;
      } finally { signal?.removeEventListener('abort',onAbort); release(); }
      } finally { await releaseNativeLease?.(); }
    });
    this.queue=operation; return operation;
  }
  async currentVideo() {
    const index = await this.page.locator('video').evaluateAll(videos=>videos.map((video,index)=>{
      const r=video.getBoundingClientRect(),style=getComputedStyle(video);
      let painted=style.display!=='none'&&style.visibility!=='hidden'&&!video.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]');
      for(let node=video;node&&painted;node=node.parentElement)if(Number(getComputedStyle(node).opacity)===0)painted=false;
      return {index,area:painted?Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))*Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top)):0};
    }).filter(item=>item.area>0).sort((a,b)=>b.area-a.area)[0]?.index);
    if(index===undefined) throw new Error('没有在视口内找到视频。');
    return this.page.locator('video').nth(index);
  }
  async switchVideo(direction,signal,{recordLearning=true,expectedVideoId}={}) {
    if(![-1,1].includes(direction))throw new TypeError('换片方向须为上一条或下一条。');
    if(expectedVideoId!==undefined&&(typeof expectedVideoId!=='string'||!/^\d{1,64}$/.test(expectedVideoId)))throw new TypeError('预期作品ID须为纯数字字符串。');
    const blocked=state=>state.loginRequired||state.verificationRequired||state.privateChatVisible||state.unsupportedPage;
    const inspectSwitchInput=({action,currentToken,expectedIdentity,selector})=>{
      const visible=element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight&&s.display!=='none'&&s.visibility!=='hidden';};
      const privateArea='[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
      const workId=value=>{try{const url=new URL(value,location.href);return /\/video\/(\d+)/.exec(url.pathname)?.[1]||url.searchParams.get('modal_id')||url.searchParams.get('aweme_id');}catch{return null;}};
      const protectedPage=()=>location.origin!=='https://www.douyin.com'||[...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"],[data-e2e="im-dialog"]')].some(visible)||[...document.querySelectorAll('body *')].some(node=>!node.childElementCount&&visible(node)&&!node.closest(privateArea)&&/扫码登录|验证码登录|登录后即可|手机扫码登录|请完成下方验证|请完成验证|安全验证|拖动滑块/.test(node.textContent||''));
      const currentIdentity=()=>{
        if(protectedPage())return null;
        const candidates=[...document.querySelectorAll('video')].filter(video=>{if(!visible(video)||video.closest(privateArea))return false;for(let node=video;node;node=node.parentElement)if(Number(getComputedStyle(node).opacity)===0)return false;return true;}).map(video=>{
          const active=video.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"]');let root=active;
          if(!root){root=video.parentElement;for(let i=0;root?.parentElement&&i<8;i++){if(root.querySelector('[class*="video-info-detail"]'))break;root=root.parentElement;}}
          const playerId=/(?:^|\s)video_(\d+)(?:\s|$)/.exec(video.closest('[data-e2e="player-container"]')?.className??'')?.[1],activeId=/(?:^|\s)video_(\d+)(?:\s|$)/.exec(active?.className??'')?.[1];
          const id=playerId&&activeId&&playerId!==activeId?null:playerId||activeId||[...(root?.querySelectorAll('a[href]')??[])].filter(link=>visible(link)&&!link.closest(privateArea)).map(link=>workId(link.href)).find(Boolean)||workId(location.href);
          const r=video.getBoundingClientRect(),area=Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))*Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top));
          return{video,id:typeof id==='string'&&/^\d{1,64}$/.test(id)?id:null,area};
        });
        if(candidates.length){
          const wanted=/^video:(\d{1,64})$/.exec(expectedIdentity||'')?.[1];
          if(wanted){
            const matches=candidates.filter(candidate=>candidate.id===wanted);
            if(matches.length!==1||matches[0].video.readyState<2)return null;
            // 连续观察确定当前作品；预载可共存，但同 ID 多元素和面积并列不能唯一绑定。
            if(candidates.some(candidate=>candidate!==matches[0]&&candidate.area>=matches[0].area))return null;
            return`video:${wanted}`;
          }
          if(candidates.length>1||candidates[0].id)return null;
        }
        const route=new URL(location.href);if(!['/','/recommend','/recommend/'].includes(route.pathname)||workId(route.href))return null;
        const cards=[...document.querySelectorAll('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"]')].filter(card=>visible(card)&&!card.closest(privateArea));if(cards.length!==1)return null;
        const rooms=[...new Set([...cards[0].querySelectorAll('a[href]')].filter(visible).flatMap(link=>{try{const url=new URL(link.href);const id=url.origin==='https://live.douyin.com'?/^\/(\d{4,30})\/?$/.exec(url.pathname)?.[1]:null;return id?[id]:[];}catch{return[];}}))];
        if(rooms.length===1)return `live:${rooms[0]}`;
        const hasLiveAvatar=[...document.querySelectorAll('[data-e2e="live-avatar"]')].some(visible);
        const hasLiveTag=[...document.querySelectorAll('div,span')].some(el=>visible(el)&&!el.childElementCount&&(el.textContent||'').trim()==='直播中');
        if(hasLiveAvatar||hasLiveTag){
          const seed=(document.body?.innerText||'').slice(0,200);
          let h=0;for(let i=0;i<seed.length;i++)h=(h*31+seed.charCodeAt(i))%10000000000;
          return `live:${1000000000+(h%9000000000)}`;
        }
        return null;
      };
      if(action==='read')return currentIdentity();
      const entries=window.__deepseekVideoSwitchInputs??=Object.create(null),elements=selector?[...document.querySelectorAll(selector)].filter(visible):[],element=elements.length===1?elements[0]:null;
      if(selector&&!element)throw new Error('换片控件已变化，未安装输入核对。');
      const entry={armed:false,dispatched:false,blocked:false};if(element)element.setAttribute('data-deepseek-switch-token',currentToken);
      const types=element?['pointerdown','mousedown','mouseup','click']:['wheel'];
      const listener=event=>{
        if(!entry.armed||!event.isTrusted)return;
        if(entry.expired){entry.blocked=true;event.preventDefault();event.stopImmediatePropagation();if(event.type===(element?'click':'wheel')){entry.armed=false;entry.cleanup();delete entries[currentToken];}return;}
        const target=event.target instanceof Element?event.target:null,targetMatches=element?target&&(target===element||element.contains(target)):target?.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"],[data-e2e="player-container"]');
        if(!targetMatches||currentIdentity()!==expectedIdentity){entry.blocked=true;event.preventDefault();event.stopImmediatePropagation();return;}
        if(event.type===(element?'click':'wheel')){entry.dispatched=true;entry.armed=false;}
      };
      for(const type of types)document.addEventListener(type,listener,{capture:true,passive:false});
      entry.cleanup=()=>{clearTimeout(entry.timer);for(const type of types)document.removeEventListener(type,listener,true);if(element?.getAttribute('data-deepseek-switch-token')===currentToken)element.removeAttribute('data-deepseek-switch-token');};
      entries[currentToken]=entry;
    };
    const identity=state=>{
      if(blocked(state)||state.videoSelection?.identityConflict||state.videoSelection?.ambiguous&&!(state.videoSelection?.candidateCount>1))return null;
      if(typeof state.video?.id==='string'&&/^\d{1,64}$/.test(state.video.id)&&state.video.readyState>=2)return `video:${state.video.id}`;
      if(state.videoSelection?.candidateCount>1)return null;
      if(state.pageKind==='live-preview'&&state.livePreview?.recognized===true&&/^\d{4,30}$/.test(state.livePreview.roomId||''))return `live:${state.livePreview.roomId}`;
      return null;
    };
    const readIdentity=async state=>{
      const currentIdentity=identity(state);
      if(!currentIdentity||!(state.videoSelection?.candidateCount>1))return currentIdentity;
      return await this.page.evaluate(inspectSwitchInput,{action:'read',expectedIdentity:currentIdentity})===currentIdentity?currentIdentity:null;
    };
    let before,previousIdentity=null,stableSamples=0,beforeIdentity=null;
    for(let attempt=0;attempt<18;attempt++){
      aborted(signal);before=await this.state();
      if(blocked(before))return{changed:false,before:before.video,after:before.video,state:before,reasonCode:'switch-blocked'};
      const currentIdentity=await readIdentity(before);aborted(signal);stableSamples=currentIdentity&&currentIdentity===previousIdentity?stableSamples+1:currentIdentity?1:0;
      previousIdentity=currentIdentity;
      if(stableSamples>=2){beforeIdentity=currentIdentity;break;}
      if(attempt<17)await wait(300,signal);
    }
    if(!beforeIdentity)return{changed:false,before:before?.video,after:before?.video,state:before,reasonCode:'video-identity-not-ready'};
    const beforeLive=beforeIdentity.startsWith('live:');
    if(expectedVideoId!==undefined){
      if(beforeLive)return{changed:false,before:before.video,after:before.video,state:before,expectedVideoId,reasonCode:'expected-video-unavailable'};
      if(before.video.id!==expectedVideoId)return{changed:false,staleObservation:true,reasonCode:'observed-video-changed',expectedVideoId,before:before.video,after:before.video,state:before};
    }
    let skipEvidenceId=null;
    if(recordLearning && direction>0 && before.video?.id && this.lastObservationVideoId===before.video.id && this.lastObservationEvidenceId && this.lastObservationState?.video?.id===before.video.id) {
      const wallSeconds=(Date.now()-this.lastObservationAt)/1000;
      if(Number.isFinite(wallSeconds) && wallSeconds>0 && wallSeconds<=30) {
        try {
          const viewing=this.getPersonaMemory().recordViewing?.({evidenceId:this.lastObservationEvidenceId,from:this.lastObservationState,to:before,wallSeconds,sampleId:randomUUID()},{source:this.source});
          if(viewing?.accepted===true) skipEvidenceId=this.lastObservationEvidenceId;
        }catch{/* 不能核实等待期间的进度时不补记快划偏好，换片仍按原操作执行。 */}
      }
    }
    const arrow=this.page.locator(`[data-e2e="video-switch-${direction>0?'next':'prev'}-arrow"]`).filter({visible:true});
    let inputDenied=null;
    const denied=(state,reasonCode)=>({changed:false,before:state.video,after:state.video,state,reasonCode});
    const checkPendingInput=async()=>{
      aborted(signal);await this.checkVideoLimits(direction>0?'douyin_next':'douyin_previous');aborted(signal);
      const current=await this.state(),currentIdentity=await readIdentity(current);aborted(signal);
      if(blocked(current)){inputDenied=denied(current,'switch-blocked');return false;}
      if(currentIdentity!==beforeIdentity){
        if(expectedVideoId!==undefined&&currentIdentity?.startsWith('video:')&&current.video.id!==expectedVideoId){
          await wait(300,signal);await this.checkVideoLimits(direction>0?'douyin_next':'douyin_previous');const confirmed=await this.state();
          const confirmedIdentity=await readIdentity(confirmed);aborted(signal);
          inputDenied=confirmedIdentity===currentIdentity?{...denied(confirmed,'observed-video-changed'),staleObservation:true,expectedVideoId}:denied(confirmed,'video-changed-before-input');
        }else inputDenied=denied(current,'video-changed-before-input');
        return false;
      }
      before=current;return true;
    };
    if(!await checkPendingInput())return inputDenied;
    const arrowCount=await arrow.count();
    if(arrowCount>1)return denied(before,'switch-control-ambiguous');
    const control=arrowCount===1?arrow.first():null,token=`video-switch-${randomUUID()}`;
    const sameGeometry=(left,right)=>Boolean(left&&right&&['x','y','width','height'].every(key=>Math.abs(left[key]-right[key])<=0.5));
    const readPoint=async()=>{
      if(control){
        if(await arrow.count()!==1||!await control.isVisible()||!await control.isEnabled())return null;
        return control.evaluate((element,currentToken)=>{
          if(element.getAttribute('data-deepseek-switch-token')!==currentToken||element.closest('[disabled],[aria-disabled="true"]'))return null;
          const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
          if(r.width<2||r.height<2||x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||hit!==element&&!element.contains(hit))return null;
          return{x:r.x,y:r.y,width:r.width,height:r.height,clickX:x,clickY:y};
        },token);
      }
      const box=before.video?.viewport||before.livePreview?.viewport;
      if(!box||box.width<2||box.height<2)return null;
      return this.page.evaluate(rect=>{
        const x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y);
        if(x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||hit.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"],#captcha_container')||!hit.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"],[data-e2e="player-container"]'))return null;
        return{...rect,clickX:x,clickY:y};
      },box);
    };
    try{
      await this.page.evaluate(inspectSwitchInput,{currentToken:token,expectedIdentity:beforeIdentity,selector:control?`[data-e2e="video-switch-${direction>0?'next':'prev'}-arrow"]`:null});
      let stablePoint,previousPoint,geometrySamples=0;
      const deadline=performance.now()+4000;
      while(performance.now()<deadline){
        if(!await checkPendingInput())return inputDenied;
        const point=await readPoint();geometrySamples=sameGeometry(point,previousPoint)?geometrySamples+1:point?1:0;previousPoint=point;
        if(geometrySamples>=3){stablePoint=point;break;}
        await wait(75,signal);
      }
      if(!stablePoint)return denied(before,'switch-control-not-interactable');
      if(!await checkPendingInput())return inputDenied;
      const finalPoint=await readPoint();if(!sameGeometry(stablePoint,finalPoint))return denied(before,'switch-control-changed');
      aborted(signal);
      const armInput=()=>this.page.evaluate(currentToken=>{const entry=window.__deepseekVideoSwitchInputs?.[currentToken];if(!entry)return false;entry.armed=true;entry.timer=setTimeout(()=>{entry.expired=true;},1500);return true;},token);
      if(control){
        if(!await armInput())return denied(before,'switch-control-changed');
        aborted(signal);
        await this.page.mouse.click(finalPoint.clickX,finalPoint.clickY);
      }else{
        await this.page.mouse.move(finalPoint.clickX,finalPoint.clickY);
        if(!await checkPendingInput())return inputDenied;
        const wheelPoint=await readPoint();if(!sameGeometry(finalPoint,wheelPoint))return denied(before,'switch-control-changed');
        if(!await armInput())return denied(before,'switch-control-changed');
        aborted(signal);await this.page.mouse.wheel(0,direction*700);
      }
      const receipt=await this.page.evaluate(currentToken=>{const entry=window.__deepseekVideoSwitchInputs?.[currentToken];return{blocked:entry?.blocked===true,dispatched:entry?.dispatched===true};},token);
      if(receipt.blocked){if(!await checkPendingInput())return inputDenied;return denied(before,'switch-input-blocked');}
      if(!receipt.dispatched){if(!await checkPendingInput())return inputDenied;return denied(before,'switch-input-unconfirmed');}
    }finally{
      await this.page.evaluate(currentToken=>{const entry=window.__deepseekVideoSwitchInputs?.[currentToken];entry?.cleanup();if(window.__deepseekVideoSwitchInputs)delete window.__deepseekVideoSwitchInputs[currentToken];},token).catch(()=>{});
    }
    let after=before,afterIdentity=null,lastAfterIdentity=null,previousAfter=null,readySamples=0;
    // 一次输入后只回读，不在加载慢或身份暂缺时重复点击，避免连续跳过多条。
    for(let i=0;i<40;i++) {
      await wait(300,signal); after=await this.state();
      if(blocked(after))break;
      const currentIdentity=await readIdentity(after);aborted(signal);
      const different=currentIdentity&&currentIdentity!==beforeIdentity;lastAfterIdentity=currentIdentity;
      readySamples=different?currentIdentity===previousAfter?readySamples+1:1:0;previousAfter=different?currentIdentity:null;
      if(readySamples>=2){afterIdentity=currentIdentity;break;}
    }
    let changed=Boolean(afterIdentity&&afterIdentity!==beforeIdentity);
    // 从直播卡离开就算成功：直播卡没有作品 ID，落点又常被预加载判成歧义，不能只靠身份比对
    if(!changed && before.pageKind==='live-preview' && after.pageKind!=='live-preview' && !blocked(after)) changed=true;
    if(skipEvidenceId && changed && after.video?.id && after.video.id!==before.video?.id && after.video.readyState>=2) {
      try {this.getPersonaMemory().recordBehavior?.({evidenceId:skipEvidenceId,action:'skip',sampleId:randomUUID(),confirmed:true},{source:this.source});}catch{/* 学习失败不改变已确认的切片结果。 */}
    }
    return {changed,switchConfirm:changed?'stable':!blocked(after)&&lastAfterIdentity&&lastAfterIdentity!==beforeIdentity?'id-seen':null,before:before.video,beforePageKind:before.pageKind,after:after.video,state:after,...(!changed?{reasonCode:blocked(after)?'switch-blocked':'switch-not-confirmed'}:{})};
  }
  async captureSharedFrames(seconds, signal) {
    if (!Number.isFinite(seconds) || seconds < 0.2 || seconds > 30) throw new Error('单批内部分享画面采集须在0.2至30秒之间；整条观看由续看决策决定。');
    const startedHostMs = performance.now(), deadline = startedHostMs + Math.max(10_000,(seconds+7)*1000), captureId = randomUUID(), elementToken = randomUUID();
    let handle, session;
    const bounded = async pending => {
      aborted(signal);
      const remaining = Math.min(4000, deadline - performance.now());
      if (remaining <= 0) throw new Error('分享画面采样超过十秒宿主边界，未采用超时画面。');
      const stepDeadline = performance.now() + remaining; let timer, abort;
      try {
        const value = await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('分享画面采样单步超时。')), remaining); if (signal) { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); } })]);
        aborted(signal); if (performance.now() > stepDeadline) throw new Error('分享画面采样回读已超时，未采用迟到画面。'); return value;
      }
      finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
    };
    const resource = async (pending, dispose) => {
      try { return await bounded(pending); }
      catch (error) { void Promise.resolve(pending).then(dispose).catch(() => {}); throw error; }
    };
    const blocked = state => state.loginRequired || state.verificationRequired || state.privateChatVisible || state.unsupportedPage || state.livePreview?.recognized === true || state.videoSelection?.identityConflict;
    try {
      aborted(signal); await this.checkVideoLimits('douyin_observe');
      const initial = await bounded(this.state({ record: false })), videoId = initial.video?.id;
      if (!videoId || blocked(initial)) throw new Error('分享采样没有可核对的公开视频，或页面被登录、验证、私信遮挡。');
      const videoLocator = await bounded(this.currentVideo());
      handle = await resource(videoLocator.elementHandle(), value => value?.dispose());
      if (!handle) throw new Error('分享视频元素已变化，未采样。');
      const read = async () => {
        aborted(signal); await this.checkVideoLimits('douyin_observe');
        const state = await bounded(this.state({ record: false }));
        if (blocked(state) || state.video?.id !== videoId) throw new Error('分享截图前后作品身份或页面遮挡状态改变，未采用画面。');
        const value = await bounded(handle.evaluate(video => {
          const get = key => Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, key)?.get?.call(video);
          const rectangle = Element.prototype.getBoundingClientRect.call(video), quality = HTMLVideoElement.prototype.getVideoPlaybackQuality?.call(video);
          return { connected: video.isConnected && video.ownerDocument === document, time: get('currentTime'), duration: get('duration'), paused: get('paused'), readyState: get('readyState'), loop: get('loop'), playbackRate: get('playbackRate'), seeking: get('seeking'), source: get('currentSrc'),
            decodedFrames: quality?.totalVideoFrames, documentTimeOrigin: performance.timeOrigin, pageTimeMs: performance.now(),
            viewport: { x: Math.max(0, rectangle.x), y: Math.max(0, rectangle.y), width: Math.max(0, Math.min(innerWidth, rectangle.right) - Math.max(0, rectangle.x)), height: Math.max(0, Math.min(innerHeight, rectangle.bottom) - Math.max(0, rectangle.y)) } };
        }));
        if (value.connected !== true || value.paused !== false || value.seeking !== false || !Number.isInteger(value.readyState) || value.readyState < 2 || !Number.isFinite(value.duration) || value.duration <= 0
          || !Number.isFinite(value.time) || !Number.isFinite(value.playbackRate) || value.playbackRate <= 0 || value.playbackRate > 4 || typeof value.loop !== 'boolean' || !Number.isFinite(value.documentTimeOrigin) || !Number.isFinite(value.pageTimeMs)
          || typeof value.source !== 'string' || !value.source || value.source.length > 8192 || !Number.isSafeInteger(value.decodedFrames) || value.decodedFrames < 0) throw new Error('分享视频的播放、解码或采样身份状态无效。');
        const { source, connected, ...metadata } = value;
        return { state, bound: { ...metadata, videoId, elementToken, sourceHash: sharedHash(source), hostTimeMs: performance.now() } };
      };
      const frames = []; let sampledState = initial;
      for (let index = 0; index < 3; index++) {
        const due = startedHostMs + index * seconds * 1000 / 2 - performance.now();
        if (due > 0) await wait(due, signal);
        const before = await read(), viewport = before.bound.viewport;
        if (!viewport || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(viewport[key])) || viewport.width < 2 || viewport.height < 2) throw new Error('分享视频采样区域不可见。');
        if (frames.length && sharedProgress(frames.at(-1).captureInterval.after, before.bound) === null) throw new Error('分享采样间的播放推进与宿主时间不符，可能发生跳转或seek，未采用画面。');
        const screenshotStartedHostMs = performance.now();
        let captured = await bounded(handle.evaluate(function videoCanvasFrame(video) {
          const get = key => Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, key)?.get?.call(video);
          const dimension = key => Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, key)?.get?.call(video);
          if (!video.isConnected || video.ownerDocument !== document || get('paused') !== false || get('seeking') !== false || get('readyState') < 2) throw new Error('分享视频画面采集时元素、播放或seek状态改变。');
          const width = dimension('videoWidth'), height = dimension('videoHeight');
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 32768 || height > 32768) throw new Error('分享视频没有可靠的原始画面尺寸。');
          const ratio = Math.min(1, 960 / width, 960 / height, Math.sqrt(921600 / (width * height)));
          const canvas = document.createElement('canvas'); canvas.width = Math.max(2, Math.floor(width * ratio)); canvas.height = Math.max(2, Math.floor(height * ratio));
          try {
            const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器没有提供分享画布上下文。');
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const encoded = canvas.toDataURL('image/jpeg', 0.65);
            if (!encoded.startsWith('data:image/jpeg;base64,')) throw new Error('分享画布没有生成JPEG视频画面。');
            return { data: encoded.slice('data:image/jpeg;base64,'.length), width: canvas.width, height: canvas.height, method: 'video-canvas-jpeg-v1' };
          } catch (error) { if (error?.name === 'SecurityError') return { corsBlocked: true }; throw error; }
          finally { canvas.width = 0; canvas.height = 0; }
        }));
        if (captured?.corsBlocked === true) {
          if (!session) session = await resource(this.page.context().newCDPSession(this.page), value => value?.detach());
          const fallback = await bounded(session.send('Page.captureScreenshot', { format: 'jpeg', quality: 65, clip: { ...viewport, scale: 1 }, captureBeyondViewport: false, fromSurface: true }));
          captured = { ...fallback, width: viewport.width, height: viewport.height, method: 'cdp-page-screenshot-interval-v1' };
        }
        const screenshotEndedHostMs = performance.now(), after = await read();
        if (sharedProgress(before.bound, after.bound) === null) throw new Error('分享截图期间视频暂停、换源、跳转或播放推进异常，未采用画面。');
        if (typeof captured.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(captured.data) || captured.data.length % 4 || Buffer.byteLength(captured.data, 'base64') < 1 || Buffer.byteLength(captured.data, 'base64') > 2_000_000) throw new Error('分享截图没有生成有界实际画面。');
        frames.push({ mimeType: 'image/jpeg', data: captured.data, videoId, time: before.bound.time, timeSemantics: 'capture-before-boundary', captureMethod: captured.method, captureSize: { width: captured.width, height: captured.height }, captureInterval: { index, before: before.bound, after: after.bound, screenshotStartedHostMs, screenshotEndedHostMs } });
        sampledState = after.state;
      }
      const endedHostMs = frames.at(-1).captureInterval.after.hostTimeMs, actualWallSeconds = (endedHostMs - startedHostMs) / 1000;
      const first = frames[0].captureInterval.before, last = frames.at(-1).captureInterval.after, progressed = sharedProgress(first, last);
    if (progressed === null || progressed <= 0.1 || last.decodedFrames <= first.decodedFrames || actualWallSeconds > Math.max(10,seconds+7)) throw new Error('分享采样未取得可靠的视频推进和解码证据，未把静止画面当视频。');
      const methods = frames.map(frame => frame.captureMethod), captureMethod = new Set(methods).size === 1 ? methods[0] : 'mixed-video-canvas-and-cdp-v1';
      const result = { state: sampledState, frames, observation: { seconds, requestedSeconds: seconds, actualWallSeconds, captureMethod, frameCount: frames.length, videoId, beforeTime: first.time, afterTime: last.time, beforePaused: first.paused, paused: last.paused, playbackProgressSeconds: progressed, note: '分时视频画面采样；时间标记是截图前边界，不是图片精确时点；没有音频，不代表看完整条。' },
        frameProof: { issuer: SHARED_PROOF_ISSUER, version: 1, signatureVersion: 1, captureId, videoId, frameCount: frames.length, captureMethods: methods, frameHashes: frames.map(frame => sharedHash(frame.data)), requestedSeconds: seconds, actualWallSeconds, startedHostMs, endedHostMs } };
      SHARED_PROOFS.set(result, { captureId, issuedHostMs: performance.now(), signature: sharedSignature(result) });
      if (!verifySharedVideoFrameProof(result, videoId)) throw new Error('宿主分享画面proof未通过完整核对，未返回视频画面。');
      return result;
    } finally { try { await session?.detach(); } finally { await handle?.dispose(); } }
  }
  async capture(seconds,signal,{recordLearning=true,sharedCaptureMode}={}) {
    if (sharedCaptureMode !== undefined) {
      if (sharedCaptureMode !== SHARED_CAPTURE_MODE) throw new Error('共享画面采样不是宿主内部调用。');
      return this.captureSharedFrames(seconds, signal);
    }
    const captureStarted=Date.now();
    let state=await this.state();
    if(state.loginRequired||state.verificationRequired||state.privateChatVisible) return {state,frames:[],note:'登录、验证或私信面板遮挡画面，本次没有采集图片。'};
    if(state.livePreview?.recognized === true) return {state,frames:[],note:'当前是推荐流直播预览，不采集直播画面。'};
    if(!state.video) return {state,frames:[],note:'没有可见视频画面，请先打开作品。'};
    const frames=[],samples=seconds?3:1;
    const before={...state.video}, firstState=structuredClone(state);
    let sampledState=state,sampledAt=captureStarted,stoppedReason=null;
    for(let index=0;index<samples;index++) {
      aborted(signal);
      if(index) await wait(seconds*1000/(samples-1),signal);
      state=await this.state();
      await this.checkVideoLimits('douyin_observe');
      if(state.loginRequired||state.verificationRequired||state.unsupportedPage||state.privateChatVisible||state.livePreview?.recognized === true) return {state,frames:[],note:'出现登录、验证、私信、直播预览或离开抖音，已丢弃本次画面。'};
      if(state.video?.id!==before.id) {stoppedReason='采样期间切换作品，保留的画面只属于此前作品。';break;}
      const {x,y,width,height}=state.video.viewport;
      if(width<2||height<2) break;
      // 采样保留动画和光标，避免截图期间改写播放器页面的样式。
      const data=await this.page.screenshot({type:'jpeg',quality:65,clip:{x,y,width,height},animations:'allow',caret:'initial',timeout:10_000});
      aborted(signal);
      const checked=await this.state();
      if(checked.loginRequired||checked.verificationRequired||checked.unsupportedPage||checked.privateChatVisible||checked.livePreview?.recognized === true) return {state:checked,frames:[],note:'截图期间出现登录、验证、私信、直播预览或离开抖音，已丢弃本次画面。'};
      if(checked.video?.id!==before.id) {stoppedReason='截图期间切换作品，本帧已丢弃。';break;}
      frames.push({mimeType:'image/jpeg',data:data.toString('base64'),time:state.video.time,videoId:state.video.id});
      sampledState=checked;sampledAt=Date.now();
    }
    const result={state:sampledState,frames,observation:{seconds,videoId:before.id,stoppedReason,beforeTime:before.time,beforePaused:before.paused,afterTime:sampledState.video?.time,paused:sampledState.video?.paused,
      note:'采集的是实际视频视口画面；没有音频，只能说明这些采样时刻。'}};
    if (frames.length && ['api','dsh'].includes(this.source)) {
      try {
        const persona=this.getPersonaMemory(),origin={source:this.source};
        result.personaEvidenceId=persona.recordObservation(result,{...origin,kind:'visual'}).evidenceId;
        const wallSeconds=(sampledAt-captureStarted)/1000,sampleId=randomUUID();
        if(persona.recordViewing && wallSeconds<=30) {
          result.viewing={evidenceId:result.personaEvidenceId,sampleId,...persona.recordViewing({evidenceId:result.personaEvidenceId,from:firstState,to:sampledState,wallSeconds,sampleId},origin)};
          if(recordLearning && this.lastObservationVideoId===before.id && result.viewing.creditedSeconds>0) persona.recordBehavior?.({evidenceId:result.personaEvidenceId,action:'stay',sampleId,confirmed:true},origin);
        }
        this.lastObservationVideoId=before.id;this.lastObservationEvidenceId=result.personaEvidenceId;
        this.lastObservationState=structuredClone(sampledState);this.lastObservationAt=sampledAt;
      }
      catch { result.personaWarning='本次画面未登记为兴趣证据，不能据此更新人格兴趣。'; }
    }
    return result;
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
    const errors=[];
    this.storyboardFrames?.clear();
    try {this.cancelLimitsWatch?.();}catch(error){errors.push(error);}this.cancelLimitsWatch=null;
    if(this.limitsEnabled)try{
      const limits=this.limits(),owner=typeof limits.stateDir==='string'?optionalRecord(path.join(limits.stateDir,'watch-loop.lock')):null;
      const otherWatching=owner&&['api','dsh'].includes(owner.source)&&owner.source!==this.source&&Number.isSafeInteger(owner.pid)&&owner.pid>0&&alive(owner.pid)&&limits.state().allowed;
      if(!otherWatching)await this.pauseForLimits();
    }catch(error){errors.push(error);}
    await this.queue.catch(()=>{});
    try{await this.browser?.close();}catch(error){errors.push(error);}
    for(const [pending,method] of [[this.sparkPromise,'close'],[this.commentsPromise,'close'],[this.commenterPromise,'close'],[this.chatPromise,'close'],[this.forwarderPromise,'close']]) {
      if(pending)try{await pending.then(service=>service[method]?.());}catch(error){errors.push(error);}
    }
    try{this.memory?.close();}catch(error){errors.push(error);}finally{this.browser=null;this.page=null;this.memory=null;}
    if(errors.length)throw new AggregateError(errors,'专用浏览器暂停或退出清理未全部成功。');
  }
}
