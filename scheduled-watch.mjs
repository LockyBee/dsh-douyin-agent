import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths } from './runtime-paths.mjs';

const DAY=86400000, defaultPolicy={enabled:false,maxRequests:30};
const load=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw new Error('自动启动记录无法读取，未重置原记录。');}};
const write=(file,value)=>{const temporary=`${file}.${randomUUID()}.tmp`;try{fs.writeFileSync(temporary,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}};
export function scheduledSlot(policy,now) {
  const shifted=new Date(now+8*3600000), midnight=Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),shifted.getUTCDate())-8*3600000, intervals=[];
  for(const offset of [-1,0,1]){const day=new Date(midnight+offset*DAY+8*3600000).getUTCDay();for(const value of ([0,6].includes(day)?policy.weekendWindows||policy.windows:policy.windows)) {const[a,b,c,d]=value.split(/[:-]/).map(Number),start=a*60+b;let end=c*60+d;if(end<start)end+=1440;intervals.push({startAt:midnight+offset*DAY+start*60000,expiresAt:midnight+offset*DAY+end*60000});}}
  const merged=[];for(const interval of intervals.sort((a,b)=>a.startAt-b.startAt)){const old=merged.at(-1);if(old&&interval.startAt<old.expiresAt)old.expiresAt=Math.max(old.expiresAt,interval.expiresAt);else merged.push({...interval});}
  const slot=merged.find(item=>item.startAt<=now&&now<item.expiresAt);return slot?{...slot,key:`${slot.startAt}:${slot.expiresAt}`}:null;
}
function policyOf(value){if(!value||Array.isArray(value)||Object.keys(value).some(key=>!['enabled','maxRequests'].includes(key))||typeof value.enabled!=='boolean'||!Number.isSafeInteger(value.maxRequests)||value.maxRequests<1||value.maxRequests>10000)throw new Error('自动启动只接受开关及1至10000次请求上限。');return{enabled:value.enabled,maxRequests:value.maxRequests};}

// 软件和插件用同一份时段回执占位，两个入口不会分别再开一轮。
export class ScheduledWatch {
  constructor({stateDir=resolveRuntimePaths().stateDir,getVideoLimits,getWatchState,startRound,source='api',now=Date.now,intervalMs=5000}={}){Object.assign(this,{stateDir,getVideoLimits,getWatchState,startRound,source,now,intervalMs});this.policyFile=path.join(stateDir,'watch-schedule-policy.json');this.ledgerFile=path.join(stateDir,'watch-schedule-runs.json');this.guardFile=path.join(stateDir,'watch-schedule.guard');this.closed=false;}
  policy(){return policyOf(load(this.policyFile,{...defaultPolicy}));}
  ledger(){const value=load(this.ledgerFile,{version:1,runs:[]});if(value?.version!==1||!Array.isArray(value.runs)||value.runs.length>1000||value.runs.some(item=>!item?.key||!['starting','started','failed','occupied'].includes(item.status)))throw new Error('自动启动回执损坏，未覆盖或重试。');return value;}
  state(){const policy=this.policy(),last=this.ledger().runs.at(-1)||null;return{protocol:'scheduled-watch-v1',policy,last,busy:Boolean(this.pending),lastError:this.error||'',note:'应用保持运行时，每个允许时段自动开始一轮；全天按每天一轮。不会补开同一时段，登录、验证或启动失败后需人工处理。关闭自动启动不结束已经开始的观看。'};}
  control(action){fs.mkdirSync(this.stateDir,{recursive:true});let fd;try{fd=fs.openSync(this.guardFile,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw Object.assign(new Error('另一个入口正在检查自动启动。'),{code:'SCHEDULE_BUSY'});throw error;}try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));return action();}finally{fs.closeSync(fd);fs.unlinkSync(this.guardFile);}}
  configure(value,{explicit=false}={}){if(!explicit)throw new Error('自动启动需要本人明确保存。');const policy=policyOf(value);this.control(()=>{this.policy();write(this.policyFile,policy);});if(!policy.enabled)this.abort?.abort(new Error('已撤回自动启动许可。'));return this.state();}
  start(){if(!this.timer){this.timer=setInterval(()=>{void this.tick();},this.intervalMs);this.timer.unref?.();void this.tick();}return this;}
  tick(){if(this.closed||this.pending)return this.pending||Promise.resolve(this.state());this.pending=this.perform().catch(error=>{if(error.code!=='SCHEDULE_BUSY')this.error='自动启动未完成，请核对模型、浏览器和原运行记录。';}).finally(()=>{this.pending=null;});return this.pending;}
  async perform(){if(!this.policy().enabled)return;const limits=await this.getVideoLimits(),time=limits.state(),slot=scheduledSlot(time.policy,this.now());if(!slot)return;
    const watch=await this.getWatchState();let operation;
    this.control(()=>{if(!this.policy().enabled)return;const ledger=this.ledger();if(ledger.runs.some(item=>item.key===slot.key))return;operation={...slot,id:randomUUID(),source:this.source,pid:process.pid,startedAt:new Date(this.now()).toISOString(),status:watch?.running?'occupied':'starting'};ledger.runs.push(operation);ledger.runs=ledger.runs.slice(-1000);write(this.ledgerFile,ledger);});
    if(!operation||operation.status==='occupied')return;this.abort=new AbortController();
    try{if(!this.policy().enabled)throw new Error('许可已撤回');const result=await this.startRound({maxRequests:this.policy().maxRequests,signal:this.abort.signal});this.finish(operation.id,'started',result?.sessionId||null);this.error='';}
    catch(error){this.finish(operation.id,'failed',null);throw error;}finally{this.abort=null;}
  }
  finish(id,status,sessionId){this.control(()=>{const ledger=this.ledger(),entry=ledger.runs.find(item=>item.id===id);if(!entry)throw new Error('自动启动回执丢失');Object.assign(entry,{status,sessionId,completedAt:new Date(this.now()).toISOString()});write(this.ledgerFile,ledger);});}
  async close(){this.closed=true;clearInterval(this.timer);this.abort?.abort(new Error('自动启动入口已关闭。'));await this.pending;}
}
