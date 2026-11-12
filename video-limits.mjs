import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { randomUUID } from 'node:crypto';

const DAY = 86_400_000;
const SOURCES = ['api', 'dsh'];
const READ_ACTIONS = new Set(['douyin_status', 'douyin_pause', 'douyin_recall', 'douyin_remember', 'douyin_video_limits_status']);
export const DEFAULT_VIDEO_POLICY = Object.freeze({ version: 1, timeZone: 'Asia/Shanghai', enabled:false, windows: ['00:00-24:00'], dailyMinutes: 10, dailyRequests:30 });
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
  for (const key of Object.keys(input)) if (!['version','timeZone','enabled','windows','weekendWindows','sessionMinutes','dailyMinutes','dailyRequests'].includes(key)) throw new Error(`不支持的视频设置：${key}`);
  if (input.timeZone !== undefined && input.timeZone !== 'Asia/Shanghai') throw new Error('时间段固定按 Asia/Shanghai 计算。');
  const minutes=input.dailyMinutes!==undefined?input.dailyMinutes:input.sessionMinutes!==undefined?input.sessionMinutes:10,requests=input.dailyRequests===undefined?30:input.dailyRequests;
  for(const [name,value]of [['每日观看分钟',minutes],['每日模型请求次数',requests]])if(value!==null&&(!Number.isSafeInteger(value)||value<1))throw new Error(`${name}须为正整数或null（不限）。`);
  if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new Error('允许观看须使用开关。');
  if (!Array.isArray(input.windows) || input.windows.length < 1 || input.windows.length > 16) throw new Error('请设置 1 至 16 个每日时间段，不能关闭全部时间限制。');
  for (const value of input.windows) parseWindow(value);
  if (input.weekendWindows !== undefined && input.weekendWindows !== null) { if (!Array.isArray(input.weekendWindows) || input.weekendWindows.length < 1 || input.weekendWindows.length > 16) throw new Error('周末时段须设置1至16项。'); for (const value of input.weekendWindows) parseWindow(value); }
  return { version: 1, timeZone: 'Asia/Shanghai', enabled:input.enabled===true, windows: [...new Set(input.windows)], dailyMinutes:minutes,dailyRequests:requests, ...(input.weekendWindows ? { weekendWindows: [...new Set(input.weekendWindows)] } : {}) };
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

// 时长账本只记录实际播放的活动区间，入口与进程重启不清除当天用量。
const dateKey=now=>new Date(now+8*3600_000).toISOString().slice(0,10);
const nextMidnight=now=>Date.parse(`${dateKey(now)}T00:00:00+08:00`)+DAY;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const optional=(file,fallback)=>{try{return read(file);}catch(error){if(error.code==='ENOENT')return fallback;throw error;}};
export class VideoLimits {
  constructor({stateDir=resolveRuntimePaths().stateDir,now=Date.now}={}) {
    Object.assign(this,{stateDir,now});fs.mkdirSync(stateDir,{recursive:true});
    this.policyFile=path.join(stateDir,'video-policy.json');this.sessionsFile=path.join(stateDir,'video-sessions.json');this.guardFile=path.join(stateDir,'video-control.guard');this.usageFile=path.join(stateDir,'video-usage.json');this.budgetFile=path.join(stateDir,'watch-budget.json');this.scheduleFile=path.join(stateDir,'watch-schedule-policy.json');
    const legacySchedule=optional(this.scheduleFile,null);initialize(this.policyFile,{...DEFAULT_VIDEO_POLICY,...(legacySchedule?.maxRequests!==undefined?{dailyRequests:legacySchedule.maxRequests}:{})});initialize(this.sessionsFile,{version:1,current:null});initialize(this.usageFile,{version:1,days:{},active:null});this.enforcing=false;
  }
  control(action) {
    let descriptor;const token=randomUUID();try{descriptor=fs.openSync(this.guardFile,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Object.assign(new Error('视频设置正在更新，或控制锁需要人工核对；未自动删除。'),{status:409,code:'VIDEO_CONTROL_BUSY'});throw error;}
    try{fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,token}));}finally{fs.closeSync(descriptor);}
    try{return action();}finally{const guard=read(this.guardFile);if(guard.token===token&&guard.pid===process.pid)fs.unlinkSync(this.guardFile);}
  }
  policy() {
    const raw=read(this.policyFile),schedule=optional(this.scheduleFile,null);
    if(schedule&&typeof schedule.enabled!=='boolean')throw new Error('允许观看开关损坏，未继续观看。');
    const input={...raw};if(raw.dailyRequests===undefined&&schedule?.maxRequests!==undefined)input.dailyRequests=schedule.maxRequests;
    if(schedule)input.enabled=schedule.enabled;
    return validateVideoPolicy(input);
  }
  usage() {
    const value=read(this.usageFile);
    const invalid=()=>{throw new Error('每日观看时长账本损坏，未重新计数。');};
    if(value?.version!==1||!value.days||Array.isArray(value.days)||typeof value.days!=='object'||Object.entries(value.days).some(([key,n])=>!/^\d{4}-\d{2}-\d{2}$/.test(key)||!Number.isFinite(n)||n<0)||value.active&&(!SOURCES.includes(value.active.source)||!Number.isSafeInteger(value.active.pid)||value.active.pid<1||typeof value.active.ownerId!=='string'||!value.active.ownerId||![value.active.fromAt,value.active.verifiedAt,value.active.expiresAt].every(Number.isFinite)||value.active.expiresAt<value.active.fromAt||value.active.expiresAt<value.active.verifiedAt))invalid();
    if(value.active&&value.active.expiresAt-value.active.verifiedAt>2000){
      const active=value.active,lease=active.expiresAt-active.verifiedAt,offset=active.verifiedAt-active.fromAt;
      if(![active.fromAt,active.verifiedAt,active.expiresAt].every(Number.isSafeInteger)||offset<0||offset>5||lease>2005)invalid();
      // 旧版三次取时可能多出1至5毫秒；只收短内存租约，不重写文件或增加已记用量。
      value.active={...active,expiresAt:active.verifiedAt+2000};
    }
    return value;
  }
  budget() {
    const value=optional(this.budgetFile,{version:1,sessions:{},days:{}});
    if(value?.version!==1||!value.sessions||Array.isArray(value.sessions)||typeof value.sessions!=='object'||!value.days||Array.isArray(value.days)||typeof value.days!=='object'||Object.entries(value.days).some(([key,n])=>!/^\d{4}-\d{2}-\d{2}$/.test(key)||!Number.isSafeInteger(n)||n<0)||Object.values(value.sessions).some(item=>!item||!Number.isSafeInteger(item.requests)||item.requests<0))throw new Error('每日观看请求账本损坏，未重新计数。');
    return value;
  }
  accrue(usage,policy,now) {
    const active=usage.active;if(!active)return usage;
    let end=Math.min(now,active.expiresAt);if(!alive(active.pid))end=Math.min(end,active.verifiedAt);
    const window=allowedWindow(policy,active.fromAt);if(!window)end=active.fromAt;else if(window.expiresAt!==null)end=Math.min(end,window.expiresAt);
    let from=active.fromAt;
    while(from<end){const until=Math.min(end,nextMidnight(from)),key=dateKey(from),seconds=(until-from)/1000,used=usage.days[key]||0;usage.days[key]=used+(policy.dailyMinutes===null?seconds:Math.min(seconds,Math.max(0,policy.dailyMinutes*60-used)));from=until;}
    active.fromAt=Math.max(active.fromAt,end);return usage;
  }
  state(now=this.now()) {
    const policy=this.policy(),sessions=read(this.sessionsFile);if(!Number.isFinite(now))throw new Error('当前时间无效，未允许刷视频。');
    if(sessions.version!==1||sessions.current&&(!Number.isFinite(sessions.current.startAt)||typeof sessions.current.id!=='string'||!['active','ended','expired'].includes(sessions.current.status)||sessions.current.expiresAt!==null&&!Number.isFinite(sessions.current.expiresAt)))throw new Error('视频运行记录损坏，未继续观看。');
    const usage=this.accrue(this.usage(),policy,now),budget=this.budget(),date=dateKey(now),usedSeconds=usage.days[date]||0,requests=budget.days[date]||0;
    const remainingSeconds=policy.dailyMinutes===null?null:Math.max(0,policy.dailyMinutes*60-usedSeconds),remainingRequests=policy.dailyRequests===null?null:Math.max(0,policy.dailyRequests-requests),window=allowedWindow(policy,now);
    const worker=optional(path.join(this.stateDir,'watch-loop.lock'),null),saved=optional(path.join(this.stateDir,'watch-state.json'),null),lastRequestPending=worker&&Number.isSafeInteger(worker.pid)&&worker.pid>0&&alive(worker.pid)&&Number.isFinite(worker.heartbeatAt)&&now-worker.heartbeatAt>=0&&now-worker.heartbeatAt<5000&&saved?.pendingRequests===1&&['model','comment-model'].includes(saved.phase)&&typeof worker.runId==='string'&&saved.runId===worker.runId&&saved.sessionId===worker.sessionId&&saved.source===worker.source;
    let reason='',reasonCode='';if(!policy.enabled){reason='允许观看已关闭。';reasonCode='disabled';}else if(!window){reason='当前不在允许刷视频的时间段。';reasonCode='outside-window';}else if(remainingSeconds!==null&&remainingSeconds<=0){reason='今天的观看时长已用完，等待上海时间次日恢复。';reasonCode='daily-time';}else if(remainingRequests!==null&&remainingRequests<=0&&!lastRequestPending){reason='今天的观看模型请求次数已用完，等待上海时间次日恢复。';reasonCode='daily-requests';}
    const expiresAt=window?window.expiresAt:null,session=sessions.current?{...sessions.current,expiresAt}:null;
    return{protocol:'video-limits-v2',timeZone:'Asia/Shanghai',now,policy,session,window,allowed:!reason,reason,reasonCode,daily:{date,usedSeconds,remainingSeconds,requests,remainingRequests,timeLimitMinutes:policy.dailyMinutes,requestLimit:policy.dailyRequests},remainingSeconds:reason?0:remainingSeconds===null?expiresAt===null?null:Math.max(0,(expiresAt-now)/1000):expiresAt===null?remainingSeconds:Math.min(remainingSeconds,Math.max(0,(expiresAt-now)/1000))};
  }
  savePolicy(input,{explicit=false}={}) {
    if(!explicit)throw new Error('视频时间设置只能由用户在控制台明确修改。');
    const current=this.policy(),policy=validateVideoPolicy({...current,...input,...(input.sessionMinutes!==undefined&&input.dailyMinutes===undefined?{dailyMinutes:input.sessionMinutes}:{})});
    return this.control(()=>{const usage=this.accrue(this.usage(),current,this.now());write(this.policyFile,policy);if(!this.state().allowed)usage.active=null;write(this.usageFile,usage);return this.state();});
  }
  markSession(source,{explicit=false}={}) {
    sourceName(source);if(!explicit)throw new Error('内部观看运行需要明确启动许可。');
    return this.control(()=>{let policy=this.policy();if(!fs.existsSync(this.scheduleFile)&&!policy.enabled){policy={...policy,enabled:true};write(this.policyFile,policy);}const time=this.state();if(!time.allowed)throw Object.assign(new Error(time.reason),{status:409});const sessions=read(this.sessionsFile);
      if(sessions.current?.status==='active')return time;
      if(sessions.current){sessions.history||=[];if(!sessions.history.some(item=>item.id===sessions.current.id))sessions.history.push(sessions.current);}
      sessions.current={id:randomUUID(),startAt:this.now(),expiresAt:time.window?.expiresAt??null,startedBy:source,status:'active',sources:{[source]:{startAt:this.now()}}};write(this.sessionsFile,sessions);return this.state();});
  }
  endSession({explicit=false,reason='观看已停止。'}={}) {
    if(!explicit)throw new Error('结束观看需要明确操作。');return this.control(()=>{const usage=this.accrue(this.usage(),this.policy(),this.now());usage.active=null;write(this.usageFile,usage);const sessions=read(this.sessionsFile);if(sessions.current?.status==='active'){sessions.current.status='ended';sessions.current.reason=reason;sessions.current.endedAt=this.now();write(this.sessionsFile,sessions);}return this.state();});
  }
  notePlayback(source,browserState,{ownerId=source}={}) {
    sourceName(source);const state=browserState?.state||browserState;
    const image=state?.imagePost,imageVisible=state?.pageKind==='image-post'&&!state.video&&image?.recognized===true&&image.source==='active-image-element'&&image.loaded===true&&/^\d{10,30}$/.test(image.id||'')&&image.viewport&&['x','y','width','height'].every(key=>Number.isFinite(image.viewport[key]))&&image.viewport.width>=120&&image.viewport.height>=120;
    const room=state?.liveRoom,livePlaying=state?.pageKind==='live-room'&&room?.recognized===true&&room.source==='direct-live-url-and-player'&&/^\d{4,30}$/.test(room.roomId||'')&&!room.ended&&room.video?.paused===false&&room.video.readyState>=2&&room.video.width>=2&&room.video.height>=2;
    const playing=(state?.pageKind!=='live-room'&&state?.video?.paused===false&&state.video.readyState>=2||imageVisible||livePlaying)&&!state.privateChatVisible&&!state.loginRequired&&!state.verificationRequired&&!state.unsupportedPage;
    const now=this.now();
    try{return this.control(()=>{const policy=this.policy(),usage=this.accrue(this.usage(),policy,now);usage.active=null;const current=this.state(now);if(playing&&current.allowed)usage.active={source,ownerId:String(ownerId),pid:process.pid,fromAt:now,verifiedAt:now,expiresAt:now+2000};write(this.usageFile,usage);return this.state(now);});}
    catch(error){if(error.code!=='VIDEO_CONTROL_BUSY')throw error;return{...this.state(now),accountingDeferred:true};}
  }
  settleWatching(source,{ownerId}={}) {
    if(source!==undefined)sourceName(source);return this.control(()=>{const usage=this.accrue(this.usage(),this.policy(),this.now());if(!source||usage.active?.source===source&&(!ownerId||usage.active.ownerId===ownerId))usage.active=null;write(this.usageFile,usage);return this.state();});
  }
  reserveRequest({sessionId,source='api'}={}) {
    sourceName(source);return this.control(()=>{const state=this.state();if(!state.allowed||state.daily.remainingRequests===0)throw Object.assign(new Error(state.reason||'今天的观看模型请求次数已用完。'),{watchStatus:'limited',status:409});const budget=this.budget(),key=state.daily.date;budget.days[key]=(budget.days[key]||0)+1;if(sessionId){budget.sessions[sessionId]||={requests:0,maxRequests:null};budget.sessions[sessionId].requests++;}write(this.budgetFile,budget);return{date:key,requests:budget.days[key],remaining:state.policy.dailyRequests===null?null:Math.max(0,state.policy.dailyRequests-budget.days[key])};});
  }
  beforeAction(source,name) {
    sourceName(source);if(name.startsWith('douyin_chat_'))return{allowed:true};if(READ_ACTIONS.has(name)){try{return{allowed:true,state:this.state()};}catch(error){return{allowed:true,state:{allowed:false,reason:error.message}};}}
    let state=this.state();if(!state.allowed)return{allowed:false,reason:state.reason,state};if(!state.session||state.session.status!=='active')state=this.markSession(source,{explicit:true});return{allowed:state.allowed,state};
  }
  async enforce({sources=SOURCES,pause,onDeny=()=>{}}={}) {
    if(this.enforcing)return;this.enforcing=true;try{let state;try{state=this.state();}catch(error){state={allowed:false,reason:`视频时间状态不可读：${error.message}`};}if(state.allowed)return state;try{this.settleWatching();}catch{}onDeny(state);const results=await Promise.allSettled(sources.map(source=>{sourceName(source);return pause?.(source,state);}));return{...state,pauseResults:results.map(item=>({status:item.status,...(item.status==='fulfilled'?{result:item.value}:{message:item.reason?.message||String(item.reason)})}))};}finally{this.enforcing=false;}
  }
  watch({intervalMs=1000,...options}={}) {if(!Number.isSafeInteger(intervalMs)||intervalMs<10||intervalMs>1000)throw new Error('视频时限检查间隔须为10至1000毫秒。');const timer=setInterval(()=>{void this.enforce(options).catch(()=>{});},intervalMs);timer.unref?.();return()=>clearInterval(timer);}
}
