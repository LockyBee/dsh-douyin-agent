import { createRuntimeConversationMemory, memoryContactFromToken } from './runtime-conversation-memory.mjs';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
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
export function sameBrowserProfile(left, right, platform = process.platform) {
  if (typeof left !== 'string' || !left || typeof right !== 'string' || !right) return false;
  const normalize = value => platform === 'win32' ? path.win32.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}
async function processBirthTime(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (pid === process.pid) return Date.now() - process.uptime() * 1000;
  const win = process.platform === 'win32';
  const executable = win ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'ps';
  const args = win ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$p=[System.Diagnostics.Process]::GetProcessById([int]$env:DOUYIN_PROBE_PID); ([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()'] : ['-p', String(pid), '-o', 'lstart='];
  try {
    const stdout = await new Promise((resolve, reject) => execFile(executable, args, { env: { ...process.env, DOUYIN_PROBE_PID: String(pid) }, windowsHide: true, timeout: 8000, maxBuffer: 2048 }, (error, output) => error ? reject(error) : resolve(output)));
    const value = win ? Number(String(stdout).trim()) : Date.parse(String(stdout).trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}
export async function dedicatedHostPlan(state, { profile, port, endpointReady = false, processAlive = alive, readProcessBirth = processBirthTime } = {}) {
  let owned = sameBrowserProfile(state?.profile, profile) && state?.port === port && Number.isSafeInteger(state?.pid) && state.pid > 0 && processAlive(state.pid);
  if (owned) {
    const birth = await readProcessBirth(state.pid);
    if (!Number.isFinite(birth)) return 'unverified';
    if (Number.isFinite(birth) && (!Number.isFinite(state.startedAt) || birth > state.startedAt + 100)) owned = false;
  }
  if (endpointReady) return owned && state.ready === true ? 'connect' : 'foreign';
  return owned ? 'wait' : 'launch';
}
export function dedicatedHostReadiness(state, { pid, profile, port, processAlive = alive } = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !processAlive(pid)) return 'failed';
  // 新宿主写入前可能仍读到旧的已退出记录；只核对本次等待的进程。
  if (!state || state.pid !== pid) return 'pending';
  if (!sameBrowserProfile(state.profile, profile) || state.port !== port) return 'foreign';
  return state.ready === true ? 'ready' : 'pending';
}
async function endpoint(signal) {
  const release = await lock('launch', signal);
  try {
    const stateFile = path.join(CONTROL, 'browser.json');
    let state;
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* 首次运行没有状态。 */ }
    const plan = await dedicatedHostPlan(state, { profile: PROFILE, port: PORT, endpointReady: await version() });
    if (plan === 'unverified') throw Object.assign(new Error('专用浏览器宿主启动时间暂时无法核实，请稍后重试或运行一键自检；未重复打开窗口。'), { code: 'BROWSER_HOST_IDENTITY_UNVERIFIED' });
    if (plan === 'foreign') throw new Error('9227 端口不属于本工具的专用浏览器，请先释放端口。');
    if (plan === 'connect') return `http://127.0.0.1:${PORT}`;
    let hostPid = state?.pid;
    if (plan === 'launch') {
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
  const directLive=location.origin==='https://live.douyin.com'&&/^\/\d{4,30}\/?$/.test(location.pathname);
  if(location.origin!=='https://www.douyin.com'&&!directLive) return {
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
    try { const u = new URL(value, location.href); return /\/(?:video|note)\/(\d+)/.exec(u.pathname)?.[1] || u.searchParams.get('modal_id') || u.searchParams.get('aweme_id'); } catch { return null; }
  };
  const privateArea='[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
  const privateChatVisible=[...document.querySelectorAll('[data-e2e="im-dialog"]')].some(visible);
  const videoVisible = element => {
    if(!visible(element))return false;
    for(let node=element;node;node=node.parentElement)if(Number(getComputedStyle(node).opacity)===0)return false;
    return true;
  };
  const noteRoots=[...document.querySelectorAll('[data-e2e="note-detail"],[data-e2e="image-detail"]')].filter(visible),noteRoot=noteRoots.length===1&&/^\/(?:video|note)\/\d+/.test(location.pathname)?noteRoots[0]:null;
  const notePlayer=noteRoot?.querySelector('[data-e2e="player-container"].note-detail-container')||noteRoot;
  const videoElements = [...document.querySelectorAll('video')].filter(e=>videoVisible(e)&&!e.closest(privateArea)&&(!notePlayer||notePlayer.contains(e))).map(element => {
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
  const recommendFeed = ['/', '/recommend', '/recommend/', '/jingxuan', '/jingxuan/'].includes(route.pathname) && !workId(route.href);
  const feedCards = [...document.querySelectorAll('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"],[data-e2e="note-detail"],[data-e2e="image-detail"]')].filter(e => visible(e) && !e.closest(privateArea));
  if (!activeContainer && feedCards.length === 1) activeContainer = feedCards[0];
  if(!activeContainer&&noteRoot)activeContainer=noteRoot;
  let imagePost=null;
  const imagePostMarker=activeContainer&&(activeContainer.matches('[data-e2e="note-detail"],[data-e2e="image-detail"]')||/^\/note\//.test(route.pathname)||activeContainer.querySelector('.dySwiperSlide,[data-e2e="photo-image"],[data-e2e="note-image"],[class*="ImageSwiper"],[class*="image-post"],[class*="imagePost"],[class*="note-content"]'));
  const declaredLiveCard=activeContainer?.getAttribute('data-live-status')==='live'&&/^\d{4,30}$/.test(activeContainer.getAttribute('data-room-id')||activeContainer.getAttribute('data-live-room-id')||'');
  if(!element&&activeContainer&&imagePostMarker&&!declaredLiveCard&&(feedCards.length===1||activeContainer===noteRoot)&&!privateChatVisible&&!loginRequired&&!verificationRequired){
    const imageContainer=activeContainer===noteRoot?notePlayer:activeContainer;
    const ids=new Set([/(?:^|\s)video_(\d{10,30})(?:\s|$)/.exec(activeContainer.className??'')?.[1],activeContainer.getAttribute('data-aweme-id'),...([...imageContainer.querySelectorAll('a[href]')].filter(link=>visible(link)&&new URL(link.href).origin==='https://www.douyin.com'&&!/\/user\//.test(link.href)).map(link=>workId(link.href))),activeContainer===noteRoot?workId(route.href):/^\/note\//.test(route.pathname)?workId(route.href):null].filter(id=>typeof id==='string'&&/^\d{10,30}$/.test(id)));
    const images=[...imageContainer.querySelectorAll('img')].filter(image=>{
      if(!videoVisible(image)||!image.complete||image.naturalWidth<120||image.naturalHeight<120)return false;
      for(let node=image;node&&node!==activeContainer;node=node.parentElement)if(/blur\(/.test(getComputedStyle(node).filter))return false;
      const r=image.getBoundingClientRect();if(r.width<120||r.height<120)return false;
      const hit=document.elementFromPoint((Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2);
      const slide=image.closest('.dySwiperSlide');
      return Boolean(hit&&(hit===image||image.contains(hit)||slide&&hit.closest('.dySwiperSlide')===slide||slide&&activeContainer.contains(hit)&&hit.closest('.xg-icon-play')));
    });
    if(ids.size===1&&images.length===1){
      const image=images[0],r=image.getBoundingClientRect(),id=[...ids][0];
      const marker=value=>{let a=2166136261,b=2246822519;for(const char of value){a=Math.imul(a^char.charCodeAt(0),16777619);b=Math.imul(b^char.charCodeAt(0),3266489917);}return(a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');};
      const slide=image.closest('.swiper-slide,.dySwiperSlide,[data-e2e="photo-slide"],[data-e2e="image-slide"],[role="tabpanel"]');
      const slideItems=slide?.parentElement?[...slide.parentElement.children].filter(e=>e.matches('.swiper-slide,.dySwiperSlide,[data-e2e="photo-slide"],[data-e2e="image-slide"],[role="tabpanel"]')&&!e.classList.contains('swiper-slide-duplicate')):[];
      const count=value=>/^\d{1,5}$/.test(String(value??''))&&Number(value)>0?Number(value):null;
      const zeroIndex=slide?.getAttribute('data-swiper-slide-index')??slide?.getAttribute('data-index');
      const rawIndex=count(slide?.getAttribute('aria-posinset'))??(/^\d{1,5}$/.test(zeroIndex??'')?Number(zeroIndex)+1:slide?.matches('.dySwiperSlide')?slideItems.indexOf(slide)+1:null);
      const index=rawIndex??count(activeContainer.querySelector('.swiper-pagination-current,[data-e2e="image-current"]')?.textContent?.trim());
      const slides=slideItems;
      const total=count(slide?.getAttribute('aria-setsize'))??count(activeContainer.querySelector('.swiper-pagination-total,[data-e2e="image-total"]')?.textContent?.trim())??(slides.length>1?slides.length:null);
      const nextSelector='[data-e2e="image-next"],[data-e2e="photo-next"],[data-e2e="note-next"],.swiper-button-next,[aria-label="下一张"],[aria-label="下一页"]';
      const next=[...activeContainer.querySelectorAll(nextSelector)].filter(e=>videoVisible(e)&&!e.matches(':disabled,[aria-disabled="true"],.swiper-button-disabled'));
      if(!next.length&&slide?.matches('.dySwiperSlide'))for(const group of activeContainer.querySelectorAll('div')){
        const counter=/^\s*(\d{1,4})\s*\/\s*(\d{1,4})\s*$/.exec(group.textContent||'');if(!counter||Number(counter[1])!==index||Number(counter[2])!==total)continue;
        const arrows=[...group.children].filter(e=>!e.textContent.trim()&&e.querySelectorAll('svg').length===1&&videoVisible(e)).sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left);
        if(arrows.length===2){const a=arrows[0].getBoundingClientRect(),b=arrows[1].getBoundingClientRect();if(a.width>=12&&a.width<=64&&b.width>=12&&b.width<=64&&Math.abs(a.top-b.top)<4&&b.left>a.right&&!next.includes(arrows[1]))next.push(arrows[1]);}
      }
      const validCount=!index||!total||index<=total;
      imagePost={id,url:`https://www.douyin.com/note/${id}`,recognized:true,source:'active-image-element',loaded:true,title:clean(activeContainer.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"],[class*="video-info-detail"]')?.textContent).slice(0,1000)||null,
        width:image.naturalWidth,height:image.naturalHeight,viewport:{x:Math.max(0,r.left),y:Math.max(0,r.top),width:Math.min(innerWidth,r.right)-Math.max(0,r.left),height:Math.min(innerHeight,r.bottom)-Math.max(0,r.top)},imageKey:marker((image.currentSrc||image.src)+'\0'+image.naturalWidth+'x'+image.naturalHeight+'\0'+(index||0)),album:{index:validCount?index:null,total:validCount?total:null,hasNext:validCount&&next.length===1&&!(index&&total&&index>=total),atEnd:Boolean(validCount&&index&&total&&index>=total),source:'visible-carousel-dom'},observationScope:'current-visible-image'};
    }
  }
  let livePreview = null;
  if (recommendFeed && activeContainer?.matches('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"]') && !video?.id && !imagePost && !privateChatVisible && !loginRequired && !verificationRequired) {
    const roomIds = [...(activeContainer.matches('a[href]') ? [activeContainer] : []), ...activeContainer.querySelectorAll('a[href]')].filter(visible).map(link => {
      try { const target = new URL(link.href, location.href); return target.origin === 'https://live.douyin.com' ? /^\/(\d{4,30})\/?$/.exec(target.pathname)?.[1] : null; } catch { return null; }
    }).filter(Boolean);
    const unique = [...new Set(roomIds)];
    const declaredRoom=activeContainer.getAttribute('data-room-id')||activeContainer.getAttribute('data-live-room-id');
    const declaredLive=activeContainer.matches('[data-e2e="feed-live-card"],[data-e2e="feed-live"]')&&activeContainer.getAttribute('data-live-status')==='live'&&/^\d{4,30}$/.test(declaredRoom||'');
    if (unique.length === 1 || unique.length===0&&declaredLive) {
      const r = (element || activeContainer).getBoundingClientRect();
      livePreview = { recognized: true, source: unique.length?'active-feed-live-link':'active-feed-live-room', scope: 'recommend-feed', roomId: unique[0]||declaredRoom,
        video:element?{readyState:element.readyState,paused:element.paused,time:element.currentTime,width:element.videoWidth,height:element.videoHeight,decodedFrames:element.getVideoPlaybackQuality?.().totalVideoFrames??null}:null,
        viewport: { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.min(innerWidth,r.right)-Math.max(0,r.left), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.top) } };
    } else if(unique.length===0&&feedCards.length===1&&element&&element.readyState>=2&&!Number.isFinite(element.duration)&&element.videoWidth>=2&&element.videoHeight>=2){
      const explicit=activeContainer.matches('[data-e2e="feed-live-card"],[data-e2e="feed-live"]'),badges=[...activeContainer.querySelectorAll('span,div,button,a')].filter(e=>!e.childElementCount&&visible(e)&&/^(直播中|进入直播间|点击进入直播间)$/.test(clean(e.textContent)));
      const marker=explicit||[...activeContainer.querySelectorAll('[data-e2e="live-avatar"],[data-e2e="live-enter-room"],[data-e2e="live-player"]')].some(visible);
      const media=element.currentSrc||element.src||(explicit&&element.srcObject instanceof MediaStream&&element.srcObject.active?'stream:'+element.srcObject.id:'');
      if(marker&&badges.length&&media){let a=2166136261,b=2246822519;for(const char of media){a=Math.imul(a^char.charCodeAt(0),16777619);b=Math.imul(b^char.charCodeAt(0),3266489917);}const r=element.getBoundingClientRect();livePreview={recognized:true,source:'active-feed-live-status',scope:'recommend-feed',roomId:null,previewKey:(a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0'),navigation:'skip-only',viewport:{x:Math.max(0,r.left),y:Math.max(0,r.top),width:Math.min(innerWidth,r.right)-Math.max(0,r.left),height:Math.min(innerHeight,r.bottom)-Math.max(0,r.top)}};}
    }
  }
  let liveRoom=null;
  if(directLive&&!privateChatVisible&&!loginRequired&&!verificationRequired){
    const roomId=/^\/(\d{4,30})/.exec(location.pathname)[1],ended=[...document.querySelectorAll('[data-e2e="live-ended"],[data-e2e="room-end"]')].some(visible)||(!element||element.readyState<2||element.ended)&&/直播已结束|直播结束了|主播不在直播|直播间不存在/.test(text);
    const explicit=[...new Set([...document.querySelectorAll('[data-room-id],[data-live-room-id]')].filter(visible).map(e=>e.getAttribute('data-room-id')||e.getAttribute('data-live-room-id')).filter(id=>/^\d{4,30}$/.test(id||'')))];
    if((!explicit.length||explicit.length===1&&explicit[0]===roomId)&&(ended||videoElements.length===1)){
      const r=element?.getBoundingClientRect();liveRoom={recognized:true,source:'direct-live-url-and-player',scope:'live-room',roomId,ended,video:element?{readyState:element.readyState,paused:element.paused,time:element.currentTime,width:element.videoWidth,height:element.videoHeight,decodedFrames:element.getVideoPlaybackQuality?.().totalVideoFrames??null}:null,viewport:r?{x:Math.max(0,r.left),y:Math.max(0,r.top),width:Math.min(innerWidth,r.right)-Math.max(0,r.left),height:Math.min(innerHeight,r.bottom)-Math.max(0,r.top)}:null};
      if(video){video.id=null;video.url=null;video.title=null;video.author=null;}
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
  const u = new URL(location.href);
  for (const key of [...u.searchParams.keys()]) if (!['modal_id','aweme_id','recommend'].includes(key)) u.searchParams.delete(key);
  return { url: u.href, title: document.title, video, imagePost, liveRoom, videoSelection: { candidateCount: videoElements.length, ambiguous: videoElements.length > 1 || videoIdentityConflict, identityConflict: videoIdentityConflict }, pageKind: liveRoom?'live-room':livePreview ? 'live-preview' : imagePost ? 'image-post' : video?.id ? 'video' : location.pathname.startsWith('/search/') ? 'search' : 'unknown', livePreview, searchResults: searchResults.slice(0,20), visibleText: directLive?'':text,
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
        if(!sameBrowserProfile(owner.profile,PROFILE) || owner.port!==PORT || !owner.ready || !alive(owner.pid) || !await version()) return {paused:0,existingPage:false};
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
      .then(([{ChatBrowser},{ChatService},{UsageLedger}])=>{const stateDir=this.limits().stateDir,source=this.source==='dsh'?'dsh':'api';const service=new ChatService({stateDir,browser:new ChatBrowser({source:source==='dsh'?'dsh-chat':'api-chat'}),onPrepared:options=>this.releaseIdlePreparePage(options),observeSharedWork:input=>this.observeSharedWork(input),videoLimits:this.limits()});service.agent.personaMemory=this.getPersonaMemory();service.agent.getMemoryStore=()=>this.store();service.agent.createConversationMemory=({scopeToken,messages})=>{const contact=memoryContactFromToken(scopeToken);return createRuntimeConversationMemory({store:this.store(),contact,messages,host:source==='dsh'?'dsh':'desktop',isAuthorized:()=>service.isMemoryScopeAuthorized(contact)});};service.agent.usageLedger=new UsageLedger({stateDir});service.agent.source=source;return service;})
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
    if (!sameBrowserProfile(owner.profile, PROFILE) || owner.port !== PORT || !owner.ready || !alive(owner.pid) || !await version()) return null;
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
    const eligiblePage = candidate => { const address = candidate.url(); return address === 'about:blank' || /^https:\/\/www\.douyin\.com(?:\/|$)/.test(address)||/^https:\/\/live\.douyin\.com\/\d{4,30}\/?(?:[?#]|$)/.test(address); };
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

  async evaluatePage(reader,arg,signal) {
    for(let attempt=0;;attempt++){aborted(signal);try{return await this.page.evaluate(reader,arg);}catch(error){if(attempt>=5||!/Execution context was destroyed|Cannot find context with specified id|Cannot find context with id/.test(error.message||''))throw error;await wait(150,signal);}}
  }
  async navigate(url, signal) {
    aborted(signal);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.evaluatePage(name => { window.name = name; }, browserPageLabel(this.source),signal);
    if (url === RECOMMEND && this.page.url().includes('/jingxuan')) {
      await this.page.locator('a').filter({hasText:/^推荐$/}).click();
    }
    const targetId=/\/(?:video|note)\/(\d+)/.exec(url)?.[1];
    await this.settle(signal, {kind:targetId?'video':url.includes('/search/')?'search':'recommend',videoId:targetId});
  }
  async settle(signal, {kind='recommend',videoId}={}) {
    for (let i=0;i<=60;i++) {
      aborted(signal);
      const state = await this.evaluatePage(readPageState,undefined,signal);
      aborted(signal);
      if(state.loginRequired||state.verificationRequired) return state;
      const detail=/\/(?:video|note)\/\d+/.test(state.url??'')||/[?&]modal_id=\d+/.test(state.url??'');
      const imageReady=state.pageKind==='image-post'&&state.imagePost?.recognized===true&&state.imagePost.source==='active-image-element'&&state.imagePost.loaded===true;
      if(kind==='search' && state.searchResults.length && !detail) return state;
      if(kind==='search' && /暂无搜索结果|没有找到相关|暂无结果/.test(state.visibleText)) return state;
      if(kind==='video' && detail && (state.video?.id===videoId && state.video.readyState>=2 || imageReady&&state.imagePost.id===videoId)) return state;
      if(kind==='recommend' && (state.video?.id && state.video.readyState>=2 || imageReady || state.livePreview?.recognized === true)) return state;
      if(i<60)await wait(500, signal);
    }
    throw new Error(kind==='search'?'搜索结果未就绪，未确认搜索完成。':kind==='video'?'目标作品尚未加载完成，请读取状态后重试。':'推荐流尚未读到就绪视频。');
  }
  async state({ record = true } = {}) {
    const state = await this.evaluatePage(readPageState);
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
  execute(name, args = {}, { signal, humanAuthorized = false, autonomousRunId, expectedVideoId, expectedImageKey, advanceImage=false, expectedLiveRoomId, expectedLivePreviewKey, enterLive=false, exitLive=false, sharedCaptureMode } = {}) {
    const definition = TOOL_DEFINITIONS.find(tool=>tool.name===name);
    if (!definition) return Promise.reject(new Error('不支持的抖音工具。'));
    if (sharedCaptureMode !== undefined && (sharedCaptureMode !== SHARED_CAPTURE_MODE || name !== 'douyin_observe')) return Promise.reject(new Error('内部分享采样模式未由宿主授权。'));
    try {
      if(sharedCaptureMode===SHARED_CAPTURE_MODE){if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>key!=='seconds')||!Number.isFinite(args.seconds)||args.seconds<0.2||args.seconds>30)throw new TypeError('本机分享视频单批采集参数无效。');}
      else validateToolArguments(definition,args);
    } catch(error) { return Promise.reject(error); }
    if(expectedVideoId!==undefined&&(!['douyin_next','douyin_previous'].includes(name)||typeof expectedVideoId!=='string'||!/^\d{1,64}$/.test(expectedVideoId)))return Promise.reject(new TypeError('预期作品ID只供换片宿主使用，须为纯数字字符串。'));
    if(advanceImage!==false&&(advanceImage!==true||name!=='douyin_next'||!expectedVideoId||typeof expectedImageKey!=='string'||!/^\w{1,64}$/.test(expectedImageKey)))return Promise.reject(new TypeError('图文翻页必须绑定宿主实际观察的作品和当前图片。'));
    if(expectedLiveRoomId!==undefined&&(!['douyin_next','douyin_previous'].includes(name)||typeof expectedLiveRoomId!=='string'||!/^\d{4,30}$/.test(expectedLiveRoomId)))return Promise.reject(new TypeError('直播换片必须绑定实际房间。'));
    if(expectedLivePreviewKey!==undefined&&(!['douyin_next','douyin_previous'].includes(name)||!(/^[a-f0-9]{16}$/.test(expectedLivePreviewKey))||expectedVideoId||expectedLiveRoomId))return Promise.reject(new TypeError('无房间地址的预览换片必须使用宿主当前采样标识。'));
    if((enterLive!==false||exitLive!==false)&&((enterLive!==true&&exitLive!==true)||enterLive===true&&exitLive===true||name!=='douyin_next'||!expectedLiveRoomId))return Promise.reject(new TypeError('直播进出需要宿主绑定的房间和单一动作。'));
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
        if(!['douyin_open','douyin_search','douyin_open_video'].includes(name) && new URL(this.page.url()).origin!=='https://www.douyin.com'&&!/^https:\/\/live\.douyin\.com\/\d{4,30}\/?(?:[?#]|$)/.test(this.page.url())) {
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
        if(advanceImage)return this.advanceImagePage(signal,{expectedVideoId,expectedImageKey});
        if(enterLive)return this.openLiveRoom(signal,{expectedLiveRoomId});
        if(exitLive)return this.exitLiveRoom(signal,{expectedLiveRoomId});
        if (name==='douyin_next'||name==='douyin_previous') return await this.switchVideo(name==='douyin_next'?1:-1,signal,{recordLearning:!autonomousRunId,expectedVideoId,expectedLiveRoomId,expectedLivePreviewKey});
        if (name==='douyin_play'||name==='douyin_pause') {
          await (await this.currentVideo()).evaluate(async(video, play)=>{ if(play) await video.play();else video.pause(); },name==='douyin_play');
          if (name==='douyin_play') await wait(600,signal);
        }
        if (name==='douyin_observe'||name==='douyin_screenshot') {
          const result=await this.capture(name==='douyin_observe'?args.seconds??3:0,signal,{recordLearning:!autonomousRunId,sharedCaptureMode});
          if(sharedCaptureMode===undefined){this.storyboardFrames??=new StoryboardFrameStore();try{const id=this.storyboardFrames.remember(result);if(id)result.storyboardSampleId=id;}catch{this.storyboardFrames.clear();}}
          return result;
        }
        if(name==='douyin_video_zoom'){
          const state=await this.state({record:false});
          if(state.loginRequired||state.verificationRequired||state.privateChatVisible||state.unsupportedPage||state.videoSelection?.identityConflict||state.livePreview?.recognized||state.video?.id!==args.videoId)throw Error('当前页面或作品与原分镜不一致，未返回旧画面。');
          if(!this.storyboardFrames)throw Error('没有本入口的原分镜，请先观察当前作品。');
          return{state,...this.storyboardFrames.zoom(args)};
        }
        if(name==='douyin_listen') return await this.listen(args.seconds??8,signal);
        aborted(signal);
        return this.state();
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
  async switchVideo(direction,signal,{recordLearning=true,expectedVideoId,expectedLiveRoomId,expectedLivePreviewKey}={}) {
    if(![-1,1].includes(direction))throw new TypeError('换片方向须为上一条或下一条。');
    if(expectedVideoId!==undefined&&(typeof expectedVideoId!=='string'||!/^\d{1,64}$/.test(expectedVideoId)))throw new TypeError('预期作品ID须为纯数字字符串。');
    const entry=await this.state({record:false});
    if(expectedLivePreviewKey!==undefined&&entry.livePreview?.previewKey!==expectedLivePreviewKey)return{changed:false,staleObservation:true,reasonCode:'observed-live-preview-changed',state:entry};
    if(entry.livePreview?.source==='active-feed-live-status'&&(expectedVideoId!==undefined||expectedLiveRoomId!==undefined))return{changed:false,staleObservation:true,reasonCode:'observed-video-changed',state:entry};
    if(direction===1&&entry.pageKind==='image-post'&&/^https:\/\/www\.douyin\.com\/(?:note|video)\/\d+/.test(entry.url||'')){
      if(expectedVideoId!==undefined&&entry.imagePost.id!==expectedVideoId)return{changed:false,staleObservation:true,reasonCode:'observed-video-changed',expectedVideoId,state:entry};
      aborted(signal);await this.checkVideoLimits('douyin_next');const fresh=await this.state({record:false});if(fresh.imagePost?.id!==entry.imagePost.id||fresh.privateChatVisible||fresh.loginRequired||fresh.verificationRequired)return{changed:false,staleObservation:true,reasonCode:'observed-video-changed',expectedVideoId,state:fresh};
      await this.navigate(RECOMMEND,signal);const state=await this.state({record:false}),after=state.video?.id||state.imagePost?.id||state.livePreview?.roomId;return{changed:Boolean(after&&after!==entry.imagePost.id),beforePageKind:'image-post',state,reasonCode:after?'image-detail-returned-to-feed':'image-detail-feed-not-ready'};
    }
    const blocked=state=>state.loginRequired||state.verificationRequired||state.privateChatVisible||state.unsupportedPage;
    const inspectSwitchInput=({action,currentToken,expectedIdentity,selector})=>{
      const visible=element=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight&&s.display!=='none'&&s.visibility!=='hidden';};
      const privateArea='[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
      const workId=value=>{try{const url=new URL(value,location.href);return /\/(?:video|note)\/(\d+)/.exec(url.pathname)?.[1]||url.searchParams.get('modal_id')||url.searchParams.get('aweme_id');}catch{return null;}};
      const protectedPage=()=>location.origin!=='https://www.douyin.com'||[...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"],[data-e2e="im-dialog"]')].some(visible)||[...document.querySelectorAll('body *')].some(node=>!node.childElementCount&&visible(node)&&!node.closest(privateArea)&&/扫码登录|验证码登录|登录后即可|手机扫码登录|请完成下方验证|请完成验证|安全验证|拖动滑块/.test(node.textContent||''));
      const currentIdentity=()=>{
        if(protectedPage())return null;
        const notes=[...document.querySelectorAll('[data-e2e="note-detail"],[data-e2e="image-detail"]')].filter(visible),note=notes.length===1&&/^\/(?:note|video)\/\d+/.test(location.pathname)?notes[0]:null,notePlayer=note?.querySelector('[data-e2e="player-container"].note-detail-container')||note;
        const candidates=[...document.querySelectorAll('video')].filter(video=>{if(!visible(video)||video.closest(privateArea)||notePlayer&&!notePlayer.contains(video))return false;for(let node=video;node;node=node.parentElement)if(Number(getComputedStyle(node).opacity)===0)return false;return true;}).map(video=>{
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
        const photoCards=note?[note]:[...document.querySelectorAll('[data-e2e="feed-active-video"],[data-e2e="note-detail"],[data-e2e="image-detail"]')].filter(card=>visible(card)&&!card.closest(privateArea));
        if(!candidates.length&&photoCards.length===1){
          const card=photoCards[0],url=new URL(location.href);
          const imageMarker=card.matches('[data-e2e="note-detail"],[data-e2e="image-detail"]')||/^\/note\//.test(url.pathname)||card.querySelector('.dySwiperSlide,[data-e2e="photo-image"],[data-e2e="note-image"],[class*="ImageSwiper"],[class*="image-post"],[class*="imagePost"],[class*="note-content"]');
          const liveCard=card.getAttribute('data-live-status')==='live'&&/^\d{4,30}$/.test(card.getAttribute('data-room-id')||card.getAttribute('data-live-room-id')||'');
          const ids=new Set([/(?:^|\s)video_(\d{10,30})(?:\s|$)/.exec(card.className??'')?.[1],card.getAttribute('data-aweme-id'),...[...card.querySelectorAll('a[href]')].filter(link=>visible(link)&&new URL(link.href).origin==='https://www.douyin.com'&&!/\/user\//.test(link.href)).map(link=>workId(link.href)),/^\/note\//.test(url.pathname)?workId(url.href):null].filter(id=>typeof id==='string'&&/^\d{10,30}$/.test(id)));
          const images=[...(notePlayer||card).querySelectorAll('img')].filter(image=>{if(!visible(image)||!image.complete||image.naturalWidth<120||image.naturalHeight<120)return false;for(let node=image;node;node=node.parentElement)if(Number(getComputedStyle(node).opacity)===0||/blur\(/.test(getComputedStyle(node).filter))return false;const r=image.getBoundingClientRect();if(r.width<120||r.height<120)return false;const hit=document.elementFromPoint((Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2),slide=image.closest('.dySwiperSlide');return Boolean(hit&&(hit===image||image.contains(hit)||slide&&hit.closest('.dySwiperSlide')===slide||slide&&card.contains(hit)&&hit.closest('.xg-icon-play')));});
          if(imageMarker&&!liveCard&&ids.size===1&&images.length===1)return`image:${[...ids][0]}`;
        }
        const route=new URL(location.href);if(!['/','/recommend','/recommend/','/jingxuan','/jingxuan/'].includes(route.pathname)||workId(route.href))return null;
        const cards=[...document.querySelectorAll('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"]')].filter(card=>visible(card)&&!card.closest(privateArea));if(cards.length!==1)return null;
        const rooms=[...new Set([...(cards[0].matches('a[href]') ? [cards[0]] : []), ...cards[0].querySelectorAll('a[href]')].filter(visible).flatMap(link=>{try{const url=new URL(link.href);const id=url.origin==='https://live.douyin.com'?/^\/(\d{4,30})\/?$/.exec(url.pathname)?.[1]:null;return id?[id]:[];}catch{return[];}}))];
        const declaredRoom=cards[0].getAttribute('data-room-id')||cards[0].getAttribute('data-live-room-id');
        const declaredLive=cards[0].matches('[data-e2e="feed-live-card"],[data-e2e="feed-live"]')&&cards[0].getAttribute('data-live-status')==='live'&&/^\d{4,30}$/.test(declaredRoom||'');
        if(rooms.length===1)return`live:${rooms[0]}`;
        if(rooms.length===0&&declaredLive)return`live:${declaredRoom}`;
        if(rooms.length===0&&candidates.length===1){
          const video=candidates[0].video,card=cards[0],explicit=card.matches('[data-e2e="feed-live-card"],[data-e2e="feed-live"]');
          const badges=[...card.querySelectorAll('span,div,button,a')].some(node=>!node.childElementCount&&visible(node)&&/^(直播中|进入直播间|点击进入直播间)$/.test((node.textContent||'').replace(/\s+/g,' ').trim()));
          const marker=explicit||[...card.querySelectorAll('[data-e2e="live-avatar"],[data-e2e="live-enter-room"],[data-e2e="live-player"]')].some(visible);
          const media=video.currentSrc||video.src||(explicit&&video.srcObject instanceof MediaStream&&video.srcObject.active?'stream:'+video.srcObject.id:'');
          if(card.contains(video)&&video.readyState>=2&&!Number.isFinite(video.duration)&&video.videoWidth>=2&&video.videoHeight>=2&&marker&&badges&&media){let a=2166136261,b=2246822519;for(const char of media){a=Math.imul(a^char.charCodeAt(0),16777619);b=Math.imul(b^char.charCodeAt(0),3266489917);}return'live-unresolved:'+(a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');}
        }
        return null;
      };
      if(action==='read')return currentIdentity();
      const entries=window.__deepseekVideoSwitchInputs??=Object.create(null),elements=selector?[...document.querySelectorAll(selector)].filter(visible):[],element=elements.length===1?elements[0]:null;
      if(selector&&!element)return false;
      const entry={armed:false,dispatched:false,blocked:false};if(element)element.setAttribute('data-deepseek-switch-token',currentToken);
      const types=element?['pointerdown','mousedown','mouseup','click']:['wheel'];
      const listener=event=>{
        if(!entry.armed||!event.isTrusted)return;
        if(entry.expired){entry.blocked=true;event.preventDefault();event.stopImmediatePropagation();if(event.type===(element?'click':'wheel')){entry.armed=false;entry.cleanup();delete entries[currentToken];}return;}
        const target=event.target instanceof Element?event.target:null,targetMatches=element?target&&(target===element||element.contains(target)):target?.closest('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"],[data-e2e="video-detail"],[data-e2e="player-container"]');
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
      if(state.pageKind==='image-post'&&state.imagePost?.recognized===true&&state.imagePost.loaded===true&&/^\d{10,30}$/.test(state.imagePost.id||''))return `image:${state.imagePost.id}`;
      if(state.videoSelection?.candidateCount>1)return null;
      if(state.pageKind==='live-preview'&&state.livePreview?.recognized===true&&/^\d{4,30}$/.test(state.livePreview.roomId||''))return `live:${state.livePreview.roomId}`;
      if(state.pageKind==='live-preview'&&state.livePreview?.recognized===true&&state.livePreview.source==='active-feed-live-status'&&/^[a-f0-9]{16}$/.test(state.livePreview.previewKey||''))return 'live-unresolved:'+state.livePreview.previewKey;
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
    if(expectedLiveRoomId!==undefined&&before.livePreview?.roomId!==expectedLiveRoomId)return{changed:false,staleObservation:true,reasonCode:'observed-live-changed',state:before};
    if(expectedVideoId!==undefined){
      if(beforeLive)return{changed:false,before:before.video,after:before.video,state:before,expectedVideoId,reasonCode:'expected-video-unavailable'};
      if((before.video?.id||before.imagePost?.id)!==expectedVideoId)return{changed:false,staleObservation:true,reasonCode:'observed-video-changed',expectedVideoId,before:before.video,after:before.video,state:before};
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
    const arrowCount=await arrow.count(),token=`video-switch-${randomUUID()}`;
    let control, controlSelector=arrowCount?`[data-e2e="video-switch-${direction>0?'next':'prev'}-arrow"]`:null;
    if (typeof arrow.evaluateAll === 'function') {
      const candidates = await arrow.evaluateAll(nodes => {
        const visible = node => { const r=node.getBoundingClientRect(),s=getComputedStyle(node);return r.width>1&&r.height>1&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight&&s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity)!==0&&!node.closest('[inert],[aria-hidden="true"]'); };
        const videos=[...document.querySelectorAll('video')].filter(visible).sort((a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return y.width*y.height-x.width*x.height;});
        const modal=videos[0]?.closest('[role="dialog"],[data-e2e="video-modal"]');
        return nodes.flatMap((node,index)=>{
          if(!visible(node)||node.closest('[data-e2e="im-dialog"]')||modal&&!modal.contains(node))return [];
          const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
          return x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&hit&&(node===hit||node.contains(hit))?[index]:[];
        });
      });
      if(candidates.length>1)return denied(before,'switch-control-ambiguous');
      control=candidates.length?arrow.nth(candidates[0]):null;
      if(control){await control.evaluate((node,value)=>node.setAttribute('data-deepseek-switch-token',value),token);controlSelector=`[data-deepseek-switch-token="${token}"]`;}
      else controlSelector=null;
    } else {
      if(arrowCount>1)return denied(before,'switch-control-ambiguous');
      control=arrowCount===1?arrow.first():null;
    }
    const sameGeometry=(left,right)=>Boolean(left&&right&&['x','y','width','height'].every(key=>Math.abs(left[key]-right[key])<=0.5));
    const readPoint=async()=>{
      if(control){
        if(await this.page.locator(controlSelector).count()!==1||!await control.isVisible()||!await control.isEnabled())return null;
        return control.evaluate((element,currentToken)=>{
          if(element.getAttribute('data-deepseek-switch-token')!==currentToken||element.closest('[disabled],[aria-disabled="true"]'))return null;
          const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
          if(r.width<2||r.height<2||x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||hit!==element&&!element.contains(hit))return null;
          return{x:r.x,y:r.y,width:r.width,height:r.height,clickX:x,clickY:y};
        },token);
      }
      const box=before.video?.viewport||before.imagePost?.viewport||before.livePreview?.viewport;
      if(!box||box.width<2||box.height<2)return null;
      return this.page.evaluate(rect=>{
        const x=rect.x+rect.width/2,y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y);
        if(x<0||y<0||x>=innerWidth||y>=innerHeight||!hit||hit.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"],#captcha_container')||!hit.closest('[data-e2e="feed-active-video"],[data-e2e="feed-live-card"],[data-e2e="feed-live"],[data-e2e="video-detail"],[data-e2e="player-container"]'))return null;
        return{...rect,clickX:x,clickY:y};
      },box);
    };
    try{
      const installed=await this.page.evaluate(inspectSwitchInput,{currentToken:token,expectedIdentity:beforeIdentity,selector:controlSelector});
      if(installed===false)return denied(before,'switch-control-changed');
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
      await this.page.evaluate(currentToken=>{const entry=window.__deepseekVideoSwitchInputs?.[currentToken];entry?.cleanup();if(window.__deepseekVideoSwitchInputs)delete window.__deepseekVideoSwitchInputs[currentToken];for(const node of document.querySelectorAll('[data-deepseek-switch-token]'))if(node.getAttribute('data-deepseek-switch-token')===currentToken)node.removeAttribute('data-deepseek-switch-token');},token).catch(()=>{});
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
    const changed=Boolean(afterIdentity&&afterIdentity!==beforeIdentity);
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
  async advanceImagePage(signal,{expectedVideoId,expectedImageKey}={}) {
    aborted(signal);await this.checkVideoLimits('douyin_next');const before=await this.state({record:false}),initial=before.imagePost;
    const failed=(reasonCode,state=before)=>({changed:false,pageChanged:false,reasonCode,state});
    if(before.pageKind!=='image-post'||initial?.id!==expectedVideoId||initial.imageKey!==expectedImageKey)return{...failed('observed-image-changed'),staleObservation:true};
    if(initial.album?.atEnd)return{...failed('image-album-end'),atEnd:true};
    if(!initial.album?.hasNext)return failed('image-navigation-unavailable');
    const clip=initial.viewport,token=randomUUID();let image,button,inputStarted=false,inputSettled=false;
    try{
      image=await this.page.evaluateHandle(clip=>{const images=[...document.querySelectorAll('[data-e2e="feed-active-video"] img,[data-e2e="note-detail"] img,[data-e2e="image-detail"] img')].filter(e=>{const r=e.getBoundingClientRect();return e.complete&&e.naturalWidth>=120&&e.naturalHeight>=120&&Math.abs(Math.max(0,r.left)-clip.x)<0.5&&Math.abs(Math.max(0,r.top)-clip.y)<0.5&&Math.abs(Math.min(innerWidth,r.right)-Math.max(0,r.left)-clip.width)<0.5&&Math.abs(Math.min(innerHeight,r.bottom)-Math.max(0,r.top)-clip.height)<0.5&&!/blur\(/.test(getComputedStyle(e).filter);});return images.length===1?images[0]:null;},clip);
      button=await image.evaluateHandle(image=>{const root=image?.closest('[data-e2e="feed-active-video"],[data-e2e="note-detail"],[data-e2e="image-detail"]');if(!root)return null;const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>1&&r.height>1&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight&&s.display!=='none'&&s.visibility!=='hidden'&&!e.matches(':disabled,[aria-disabled="true"],.swiper-button-disabled');};const candidates=[...root.querySelectorAll('[data-e2e="image-next"],[data-e2e="photo-next"],[data-e2e="note-next"],.swiper-button-next,[aria-label="下一张"]')].filter(visible),slide=image.closest('.dySwiperSlide');if(!candidates.length&&slide){const slides=[...slide.parentElement.children].filter(e=>e.matches('.dySwiperSlide')),index=slides.indexOf(slide)+1,total=slides.length;for(const group of root.querySelectorAll('div')){const count=/^\s*(\d{1,4})\s*\/\s*(\d{1,4})\s*$/.exec(group.textContent||'');if(!count||Number(count[1])!==index||Number(count[2])!==total)continue;const arrows=[...group.children].filter(e=>!e.textContent.trim()&&e.querySelectorAll('svg').length===1&&visible(e)).sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left);if(arrows.length===2){const a=arrows[0].getBoundingClientRect(),b=arrows[1].getBoundingClientRect();if(a.width>=12&&a.width<=64&&b.width>=12&&b.width<=64&&Math.abs(a.top-b.top)<4&&b.left>a.right&&!candidates.includes(arrows[1]))candidates.push(arrows[1]);}}}return candidates.length===1?candidates[0]:null;});
      let point,previous,stable=0;
      for(let i=0;i<16;i++){aborted(signal);point=await button.evaluate(e=>{if(!e?.isConnected)return null;const r=e.getBoundingClientRect(),x=(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,y=(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2,hit=document.elementFromPoint(x,y);return hit&&(e===hit||e.contains(hit))?{x,y,left:r.left,top:r.top,width:r.width,height:r.height}:null;});stable=point&&previous&&Object.keys(point).every(k=>Math.abs(point[k]-previous[k])<=0.5)?stable+1:point?1:0;if(stable>=3)break;previous=point;await wait(75,signal);}
      if(stable<3)return failed('image-navigation-not-ready');
      const fresh=await this.state({record:false});if(fresh.imagePost?.id!==expectedVideoId||fresh.imagePost?.imageKey!==expectedImageKey||fresh.privateChatVisible||fresh.loginRequired||fresh.verificationRequired)return{...failed('observed-image-changed',fresh),staleObservation:true};
      await this.checkVideoLimits('douyin_next');aborted(signal);
      await button.evaluate((button,{image,point,token,id})=>{
        const root=image.closest('[data-e2e="feed-active-video"],[data-e2e="note-detail"],[data-e2e="image-detail"]'),src=image.currentSrc||image.src,entries=window.__dafeiyuImageInputs??=Object.create(null),entry={blocked:false,clicked:false,expired:false},types=['pointerdown','mousedown','mouseup','click'];
        const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};
        const listener=event=>{if(!event.isTrusted||entry.clicked)return;const rect=button.getBoundingClientRect(),r=image.getBoundingClientRect(),hit=document.elementFromPoint(event.clientX,event.clientY),picture=document.elementFromPoint((Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2),bound=/(?:^|\s)video_(\d+)(?:\s|$)/.exec(root?.className||'')?.[1]||root?.getAttribute('data-aweme-id')||/^\/(?:note|video)\/(\d+)/.exec(location.pathname)?.[1];
          const slide=image.closest('.dySwiperSlide'),pictureMatches=picture&&(picture===image||slide&&picture.closest('.dySwiperSlide')===slide||slide&&root.contains(picture)&&picture.closest('.xg-icon-play'));
          const valid=!entry.expired&&!entry.blocked&&location.origin==='https://www.douyin.com'&&bound===id&&root?.isConnected&&button.isConnected&&image.isConnected&&(image.currentSrc||image.src)===src&&pictureMatches&&hit&&(hit===button||button.contains(hit))&&(event.target===button||button.contains(event.target))&&!button.matches(':disabled,[aria-disabled="true"],.swiper-button-disabled')&&['left','top','width','height'].every(k=>Math.abs(rect[k]-point[k])<=0.5)&&![...document.querySelectorAll('[data-e2e="im-dialog"],#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"]')].some(visible);
          if(!valid){entry.blocked=true;event.preventDefault();event.stopImmediatePropagation();return;}if(event.type==='click')entry.clicked=true;
        };
        entry.cleanup=()=>{clearTimeout(entry.timer);for(const type of types)document.removeEventListener(type,listener,true);delete entries[token];};entry.timer=setTimeout(entry.cleanup,15000);entries[token]=entry;for(const type of types)document.addEventListener(type,listener,{capture:true,passive:false});
      },{image,point,token,id:expectedVideoId});
      aborted(signal);inputStarted=true;await this.page.mouse.click(point.x,point.y);inputSettled=true;aborted(signal);
      const clicked=await this.page.evaluate(token=>{const e=window.__dafeiyuImageInputs?.[token];return Boolean(e?.clicked&&!e.blocked);},token);if(!clicked)return failed('image-input-rejected');
      let current=before,previousKey,settled=0;
      for(let i=0;i<24;i++){aborted(signal);await this.checkVideoLimits('douyin_next');current=await this.state({record:false});const image=current.imagePost;
        if(current.privateChatVisible||current.loginRequired||current.verificationRequired||image?.id!==expectedVideoId)return{...failed('image-work-changed',current),staleObservation:true};
        const advanced=image.loaded&&image.imageKey!==expectedImageKey&&(!initial.album?.index||!image.album?.index||image.album.index===initial.album.index+1);settled=advanced&&image.imageKey===previousKey?settled+1:advanced?1:0;previousKey=image.imageKey;
        if(settled>=2)return{changed:true,pageChanged:true,fromIndex:initial.album?.index,toIndex:image.album?.index,state:current};await wait(125,signal);
      }
      return failed('image-page-not-confirmed',current);
    }finally{
      await this.page.evaluate(({token,retain})=>{const e=window.__dafeiyuImageInputs?.[token];if(!e)return;if(retain)e.expired=true;else e.cleanup();},{token,retain:inputStarted&&!inputSettled}).catch(()=>{});await button?.dispose();await image?.dispose();
    }
  }
  async openLiveRoom(signal,{expectedLiveRoomId}={}) {
    aborted(signal);await this.checkVideoLimits('douyin_next');const before=await this.state({record:false});
    if(before.pageKind!=='live-preview'||before.livePreview?.roomId!==expectedLiveRoomId||before.privateChatVisible||before.loginRequired||before.verificationRequired)return{changed:false,staleObservation:true,state:before,reasonCode:'observed-live-changed'};
    this.liveReturnUrl=RECOMMEND;this.liveReturnRoomId=expectedLiveRoomId;
    await this.page.goto(`https://live.douyin.com/${expectedLiveRoomId}`,{waitUntil:'domcontentloaded',timeout:25000});aborted(signal);await this.evaluatePage(label=>{window.name=label;},browserPageLabel(this.source),signal);
    for(let i=0;i<50;i++){aborted(signal);await this.checkVideoLimits('douyin_observe');const state=await this.state({record:false});if(state.loginRequired||state.verificationRequired||state.unsupportedPage||state.privateChatVisible)return{changed:false,state};if(state.liveRoom?.roomId===expectedLiveRoomId&&(state.liveRoom.ended||state.liveRoom.video?.readyState>=2))return{changed:true,enteredLive:true,state};await wait(200,signal);}
    return{changed:false,state:await this.state({record:false}),reasonCode:'live-room-not-ready'};
  }
  async exitLiveRoom(signal,{expectedLiveRoomId}={}) {
    aborted(signal);await this.checkVideoLimits('douyin_next');const before=await this.state({record:false});
    if(before.liveRoom?.roomId!==expectedLiveRoomId||before.privateChatVisible||before.loginRequired||before.verificationRequired)return{changed:false,staleObservation:true,state:before,reasonCode:'observed-live-changed'};
    await this.navigate(RECOMMEND,signal);const state=await this.state({record:false});this.liveReturnRoomId=null;
    if(state.livePreview?.roomId===expectedLiveRoomId){const next=await this.switchVideo(1,signal,{recordLearning:false,expectedLiveRoomId});return{...next,exitedLive:true};}
    return{changed:true,exitedLive:true,state};
  }
  async captureViewport(clip,signal) {
    aborted(signal);
    if(!clip||!['x','y','width','height'].every(key=>Number.isFinite(clip[key]))||clip.x<0||clip.y<0||clip.width<2||clip.height<2)throw new Error('画面采样区域无效。');
    let session,timer,onAbort;
    const bounded=pending=>Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('画面采样超时，未采用迟到截图。')),5000);if(signal){onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});}})]).finally(()=>{clearTimeout(timer);if(onAbort)signal.removeEventListener('abort',onAbort);});
    const attaching=this.page.context().newCDPSession(this.page);
    try{try{session=await bounded(attaching);}catch(error){void attaching.then(value=>value.detach()).catch(()=>{});throw error;}
      const captured=await bounded(session.send('Page.captureScreenshot',{format:'jpeg',quality:65,clip:{...clip,scale:1},captureBeyondViewport:false,fromSurface:true}));aborted(signal);
      if(typeof captured.data!=='string'||!captured.data.length||captured.data.length>2666670||!/^[A-Za-z0-9+/]+={0,2}$/.test(captured.data))throw new Error('画面采样未生成有界JPEG。');
      return Buffer.from(captured.data,'base64');
    }finally{await session?.detach().catch(()=>{});}
  }
  async captureLive(state,seconds,signal) {
    const room=state.liveRoom||state.livePreview,workId=`live:${room.roomId}`,empty=(current,note)=>({state:current,frames:[],note});
    if(room.ended||!room.video||room.video.readyState<2||room.video.width<2||room.video.height<2)return empty(state,'当前直播未提供已解码的实际视频，没有把封面当直播画面。');
    aborted(signal);await this.checkVideoLimits('douyin_observe');let handle;
    try{
      handle=await this.page.evaluateHandle(clip=>{const hit=document.elementFromPoint(clip.x+clip.width/2,clip.y+clip.height/2);const videos=[...document.querySelectorAll('video')].filter(v=>{const r=v.getBoundingClientRect();return r.width>0&&r.height>0&&r.left<innerWidth&&r.right>0&&r.top<innerHeight&&r.bottom>0&&!v.closest('[data-e2e="im-dialog"]')});return videos.length===1?videos[0]:hit?.tagName==='VIDEO'?hit:null;},room.viewport);
      const read=()=>handle.evaluate(v=>{if(!(v instanceof HTMLVideoElement)||!v.isConnected)return null;const r=v.getBoundingClientRect();return{src:v.currentSrc||v.src||'srcObject',time:v.currentTime,decoded:v.getVideoPlaybackQuality?.().totalVideoFrames??null,ready:v.readyState,paused:v.paused,width:v.videoWidth,height:v.videoHeight,viewport:{x:Math.max(0,r.left),y:Math.max(0,r.top),width:Math.min(innerWidth,r.right)-Math.max(0,r.left),height:Math.min(innerHeight,r.bottom)-Math.max(0,r.top)}};});
      const first=await read();if(!first||first.ready<2||first.width<2||first.height<2)return empty(state,'直播视频尚未就绪。');
      if(first.paused){await handle.evaluate(v=>v.play());aborted(signal);}
      const frames=[];let last=first;
      for(let i=0;i<2;i++){if(i)await wait(Math.max(200,Math.min(10000,seconds*1000||1000)),signal);await this.checkVideoLimits('douyin_observe');aborted(signal);const current=await this.state({record:false}),live=current.liveRoom||current.livePreview;last=await read();
        if(live?.roomId!==room.roomId||live.ended||current.loginRequired||current.verificationRequired||current.privateChatVisible||current.unsupportedPage||!last||last.src!==first.src||last.ready<2||last.paused||['x','y','width','height'].some(k=>Math.abs(last.viewport[k]-first.viewport[k])>0.5))return empty(current,'直播采样期间房间、播放器或遮挡状态改变，未返回旧画面。');
        const data=await this.captureViewport(last.viewport,signal);if(data.length>2000000)return empty(current,'直播画面超过预算，未提交。');
        frames.push({mimeType:'image/jpeg',data:data.toString('base64'),videoId:workId,time:last.time,mediaKind:'live'});
      }
      const after=await this.state({record:false}),live=after.liveRoom||after.livePreview,final=await read();
      if(live?.roomId!==room.roomId||after.privateChatVisible||after.loginRequired||after.verificationRequired||!final||final.src!==first.src||final.paused||final.time-first.time<0.1||!Number.isFinite(first.decoded)||final.decoded<=first.decoded)return empty(after,'没有核实直播时间与解码帧推进，没有把静态画面当实时直播。');
      return{state:after,frames,observation:{videoId:workId,workKind:'live',roomId:room.roomId,seconds:Math.max(0,final.time-first.time),decodedFramesAdded:final.decoded-first.decoded,note:'仅观察当前直播的有限实时画面，没有音频、完播时长或未采样过程。'}};
    }finally{await handle?.dispose();}
  }
  async captureImagePost(state,signal) {
    const initial=state.imagePost,empty=(current,note)=>({state:current,frames:[],note});
    if(state.pageKind!=='image-post'||initial?.recognized!==true||initial.loaded!==true||!/^\d{10,30}$/.test(initial.id||''))return empty(state,'图文作品尚未就绪。');
    aborted(signal);await this.checkVideoLimits('douyin_observe');
    await this.page.evaluate(({id})=>{const roots=[...document.querySelectorAll('[data-e2e="note-detail"],[data-e2e="image-detail"],[data-e2e="feed-active-video"]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.right>0&&r.left<innerWidth});const root=roots.find(e=>e.matches('[data-e2e="note-detail"],[data-e2e="image-detail"]'))||roots.find(e=>(e.getAttribute('data-aweme-id')||/(?:^|\s)video_(\d+)(?:\s|$)/.exec(e.className||'')?.[1])===id);if(root)for(const media of (root.querySelector('[data-e2e="player-container"].note-detail-container')||root).querySelectorAll('video,audio'))if(!media.closest('[data-e2e="im-dialog"]'))HTMLMediaElement.prototype.pause.call(media);},{id:initial.id});
    const clip=initial.viewport;
    let handle;
    try{
      handle=await this.page.evaluateHandle(({x,y,width,height})=>{
        const images=[...document.querySelectorAll('[data-e2e="feed-active-video"] img,[data-e2e="note-detail"] img,[data-e2e="image-detail"] img')].filter(e=>{const r=e.getBoundingClientRect();return e.complete&&e.naturalWidth>=120&&e.naturalHeight>=120&&!/blur\(/.test(getComputedStyle(e).filter)&&Math.abs(Math.max(0,r.left)-x)<0.5&&Math.abs(Math.max(0,r.top)-y)<0.5&&Math.abs(Math.min(innerWidth,r.right)-Math.max(0,r.left)-width)<0.5&&Math.abs(Math.min(innerHeight,r.bottom)-Math.max(0,r.top)-height)<0.5;});
        return images.length===1?images[0]:null;
      },clip);
      const read=()=>handle.evaluate(image=>{
        if(!image||image.tagName!=='IMG')return null;const r=image.getBoundingClientRect();
        return{connected:image.isConnected,loaded:image.complete&&image.naturalWidth>=120&&image.naturalHeight>=120,src:image.currentSrc||image.src,width:image.naturalWidth,height:image.naturalHeight,viewport:{x:Math.max(0,r.left),y:Math.max(0,r.top),width:Math.min(innerWidth,r.right)-Math.max(0,r.left),height:Math.min(innerHeight,r.bottom)-Math.max(0,r.top)}};
      });
      const before=await read();
      if(!before?.connected||!before.loaded||typeof before.src!=='string'||!before.src||before.src.length>8192||['x','y','width','height'].some(k=>!Number.isFinite(clip?.[k])||Math.abs(before.viewport[k]-clip[k])>0.5))return empty(state,'当前图片已变化，没有采集其他区域。');
      const data=await this.captureViewport(clip,signal);
      aborted(signal);await this.checkVideoLimits('douyin_observe');
      const checked=await this.state(),after=await read();
      if(checked.loginRequired||checked.verificationRequired||checked.privateChatVisible||checked.unsupportedPage||checked.imagePost?.id!==initial.id||!after?.connected||!after.loaded||after.src!==before.src||after.width!==before.width||after.height!==before.height||['x','y','width','height'].some(k=>Math.abs(after.viewport[k]-before.viewport[k])>0.5))return empty(checked,'截图期间作品、图片或遮挡状态改变，已丢弃本次图文画面。');
      if(data.length>2_000_000)return empty(checked,'当前图文截图超过画面预算，未上传。');
      this.lastObservationVideoId=null;this.lastObservationEvidenceId=null;this.lastObservationState=null;
      if(checked.imagePost?.imageKey!==initial.imageKey)return empty(checked,'截图期间图文页改变，已丢弃旧页。');
      return{state:checked,frames:[{mimeType:'image/jpeg',data:data.toString('base64'),videoId:initial.id,time:null,mediaKind:'image-post',imageKey:initial.imageKey}],observation:{videoId:initial.id,workKind:'image-post',imageKey:initial.imageKey,album:initial.album,seconds:0,note:'当前页实际图片；可按可见翻页控件继续阅读，未读页不能补写为事实，没有视频完播率。'}};
    }finally{await handle?.dispose();}
  }
  async capture(seconds,signal,{recordLearning=true,sharedCaptureMode}={}) {
    if (sharedCaptureMode !== undefined) {
      if (sharedCaptureMode !== SHARED_CAPTURE_MODE) throw new Error('共享画面采样不是宿主内部调用。');
      return this.captureSharedFrames(seconds, signal);
    }
    const captureStarted=Date.now();
    let state=await this.state();
    if(state.loginRequired||state.verificationRequired||state.privateChatVisible) return {state,frames:[],note:'登录、验证或私信面板遮挡画面，本次没有采集图片。'};
    if(state.liveRoom?.recognized===true)return this.captureLive(state,seconds,signal);
    if(state.livePreview?.recognized === true) return {state,frames:[],note:'不采集直播预览画面，进入已核对房间后才能观察实时画面。'};
    if(state.pageKind==='image-post')return this.captureImagePost(state,signal);
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
