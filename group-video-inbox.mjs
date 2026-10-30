import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { messageFingerprint } from './chat-message.mjs';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const stamp = contact => hash(JSON.stringify([contact.id, contact.isGroup, contact.identityVersion, contact.identityKind, contact.identityHash, contact.identityBinding, contact.authorizationKind, contact.identityHash ? null : contact.name]));
const keyOf = (contact, message) => hash(JSON.stringify([contact.id, message.id, messageFingerprint(message)]));
const waiting = item => ['queued', 'deferred', 'observing', 'model'].includes(item.status);
const error = code => Object.assign(new Error(code), { code });
const valid = data => data?.version === 1 && Array.isArray(data.items) && Number.isSafeInteger(data.completed) && data.completed >= 0 && data.items.every(item => item && /^[a-f0-9]{64}$/.test(item.key || '') && typeof item.recipientId === 'string' && typeof item.messageId === 'string' && ['queued','deferred','observing','model','completed','unavailable','cancelled'].includes(item.status));

export function sharedVideoProof(observation) {
  const work = observation?.sharedWork, sampled = work?.observation;
  const frames = (observation?.frames || []).filter(frame => frame.videoId === work?.videoId && Number.isFinite(frame.time));
  if (observation?.understandingScope !== 'card-cover-and-timed-video-sampling' || !/^\d{1,64}$/.test(work?.videoId || '') || frames.length < 2 || !Number.isFinite(sampled?.actualWallSeconds) || sampled.actualWallSeconds <= 0 || !Number.isFinite(sampled?.playbackProgressSeconds) || sampled.playbackProgressSeconds <= 0.1) throw error('GROUP_VIDEO_NO_VERIFIED_FRAMES');
  return { videoHash: hash(work.videoId), frames: frames.length, actualWallSeconds: sampled.actualWallSeconds, playbackProgressSeconds: sampled.playbackProgressSeconds, audioObserved: false, fullVideoObserved: false };
}

// 队列由唯一聊天 worker 处理；只保存会话内笔记，不写跨会话记忆或发送消息。
export class GroupVideoInbox {
  constructor({ stateDir, now = Date.now } = {}) {
    this.file = path.join(stateDir, 'group-video-inbox.json'); this.now = now; this.running = false; this.promise = null; this.abort = null;
    try {
      const stat = fs.existsSync(this.file) ? fs.lstatSync(this.file) : null;
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024)) throw error('GROUP_VIDEO_JOURNAL_INVALID');
      this.data = stat ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, completed: 0, items: [] };
      if (!valid(this.data)) throw error('GROUP_VIDEO_JOURNAL_INVALID');
    } catch { this.invalid = true; this.data = { version: 1, completed: 0, items: [] }; }
  }
  refresh() {
    if(this.running || this.invalid || !fs.existsSync(this.file))return;
    try{const stat=fs.lstatSync(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>10*1024*1024)throw error('GROUP_VIDEO_JOURNAL_INVALID');const data=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!valid(data))throw error('GROUP_VIDEO_JOURNAL_INVALID');this.data=data;}catch{this.invalid=true;}
  }
  persist() {
    if (this.invalid) throw error('GROUP_VIDEO_JOURNAL_INVALID');
    if (this.canPersist && !this.canPersist()) throw error('GROUP_VIDEO_OWNERSHIP_LOST');
    const completed = this.data.items.filter(item => !waiting(item)).slice(-500), pending = this.data.items.filter(waiting);
    this.data.items = [...completed, ...pending]; fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 }); fs.renameSync(temporary, this.file);
  }
  state() {
    let data = this.data;
    if (!this.running) { this.refresh();data=this.data; }
    const active=data.items.find(item=>['observing','model'].includes(item.status)&&Number.isSafeInteger(item.activePid)&&this.now()-item.updatedAt<120000&&(()=>{try{process.kill(item.activePid,0);return true}catch{return false}})());
    return { protocol: 'group-video-inbox-v1', running: this.running || Boolean(active), phase: this.active?.status || active?.status || 'idle', pending: data.items.filter(waiting).length, completed: data.completed, lastCompletedAt: data.items.filter(item => item.status === 'completed').at(-1)?.completedAt || null, waitingReasonCode: this.waitingReasonCode || '', ...(this.invalid ? { errorCode: 'GROUP_VIDEO_JOURNAL_INVALID' } : {}) };
  }
  enqueue(contact, messages, { explicit = false } = {}) {
    this.refresh();
    if (typeof explicit !== 'boolean') throw error('GROUP_VIDEO_EXPLICIT_INVALID');
    if (this.invalid) return 0;
    if (contact?.isGroup !== true || typeof contact.id !== 'string') return 0;
    let added = 0;
    for (const message of messages) {
      if (message.sender !== 'incoming' || message.media?.type !== 'shared-work' || message.unsupported || !/^member:[a-f0-9]{64}$/.test(message.memberId || '') || (!explicit && message.eligibleForReply !== true)) continue;
      if (this.data.items.some(item => item.recipientId === contact.id && item.messageId === message.id)) continue;
      this.data.items.push({ key: keyOf(contact, message), recipientId: contact.id, messageId: message.id, fingerprint: messageFingerprint(message), memberId: message.memberId, authorization: stamp(contact), status: 'queued', at: new Date(this.now()).toISOString(), attempts: 0, explicit: explicit === true }); added++;
    }
    if (added) this.persist(); return added;
  }
  previousObservation(contact, message) {
    const item = this.data.items.find(item => item.key === keyOf(contact, message) && item.authorization === stamp(contact));
    if (!item?.summary) return null;
    return { messageId: message.id, frames: [], understandingScope: 'previously-sampled-shared-video', media: { type: 'shared-work' }, note: `此前在同一许可群中观察过这张卡片的实际分时画面。${item.stopReason==='video-ended'?'有播放到结尾的回执，但理解仍基于分时画面。':item.stopReason==='model-choice'?'大肥鱼根据已见内容自主停止，未宣称看完整条。':'只看了部分，尚无自主停止或播放到结尾的回执。'}以下是会话内笔记，不是本轮新采样，也没有音轨证据：${item.summary.slice(0, 420)}` };
  }
  adoptReplyObservation(contact, message, observation, summary) {
    let proof; try { proof = sharedVideoProof(observation); } catch { return false; }
    const item = this.data.items.find(item => item.key === keyOf(contact, message) && item.authorization === stamp(contact));
    if (!item || item.status === 'completed' || typeof summary !== 'string' || !summary.trim()) return false;
    if (this.active === item) this.interrupt();
    Object.assign(item, { summary: summary.slice(0, 1000), proof, method: 'partial-observed-in-reply' }); this.persist(); return true;
  }
  reconsider(contact,message,{explicit=false}={}) {
    this.refresh();if(explicit!==true)throw error('GROUP_VIDEO_EXPLICIT_REQUIRED');
    const item=this.data.items.find(item=>item.key===keyOf(contact,message)&&item.authorization===stamp(contact));
    if(!item||item.status!=='completed'||item.stopReason)return false;
    item.previousCompletion={completedAt:item.completedAt,method:item.method,proof:item.proof};
    item.status='queued';delete item.completedAt;delete item.nextRetryAt;this.persist();return true;
  }
  interrupt() { this.abort?.abort(error('GROUP_VIDEO_CHAT_PRIORITY')); }
  async drain({ signal, canRun, resolve, observe, inspect, reserve, authorize, canPersist = () => true, log = () => {} }) {
    this.refresh();
    if (this.running || this.invalid || signal?.aborted) return;
    const item = this.data.items.find(item => waiting(item) && (!item.nextRetryAt || item.nextRetryAt <= this.now()));
    if (!item) return;
    const allowed = canRun();
    if (allowed?.allowed !== true) { this.waitingReasonCode = allowed?.reasonCode || 'not-ready'; return; }
    this.waitingReasonCode = ''; this.canPersist = canPersist;this.running = true; this.active = item; this.abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    const pending = (async () => {
      try {
        authorize(); Object.assign(item,{status:'observing',activePid:process.pid,updatedAt:this.now()}); this.persist();
        const { contact, message } = await resolve(item, combined); combined.throwIfAborted(); authorize();
        if (stamp(contact) !== item.authorization || keyOf(contact, message) !== item.key || message.memberId !== item.memberId) throw error('GROUP_VIDEO_SOURCE_CHANGED');
        let lastDecision,observedBatches=0;
        const onObservation=async(observation,progress)=>{
          combined.throwIfAborted();authorize();const proof=sharedVideoProof(observation),current=await resolve(item,combined);
          if(stamp(current.contact)!==item.authorization||keyOf(current.contact,current.message)!==item.key)throw error('GROUP_VIDEO_SOURCE_CHANGED');
          if(canRun()?.allowed!==true)throw error('GROUP_VIDEO_WAIT_BUDGET');
          authorize();reserve();item.status='model';item.attempts++;item.updatedAt=this.now();this.persist();
          const watching={previousNote:item.summary||'',segments:progress?.segments||observedBatches+1,playbackProgressSeconds:progress?.playbackProgressSeconds||proof.playbackProgressSeconds,frames:progress?.frames||proof.frames,reachedEnd:progress?.reachedEnd===true};
          const generated=await inspect(message,observation,combined,watching);combined.throwIfAborted();authorize();
          const final=await resolve(item,combined);combined.throwIfAborted();authorize();
          if(stamp(final.contact)!==item.authorization||keyOf(final.contact,final.message)!==item.key)throw error('GROUP_VIDEO_SOURCE_CHANGED');
          if(typeof generated?.text!=='string'||!generated.text.trim()||generated.text.length>1200)throw error('GROUP_VIDEO_NOTE_INVALID');
          const decision=generated.watchDecision;
          if(!decision||!['continue','stop'].includes(decision.action)||decision.action==='continue'&&(!Number.isFinite(decision.seconds)||decision.seconds<0.2||decision.seconds>30))throw error('GROUP_VIDEO_DECISION_INVALID');
          observedBatches++;lastDecision={action:decision.action,...(decision.action==='continue'?{seconds:decision.seconds}:{} )};
          Object.assign(item,{status:'observing',summary:generated.text,proof,watching:{segments:watching.segments,frames:watching.frames,playbackProgressSeconds:watching.playbackProgressSeconds},lastDecision,updatedAt:this.now()});this.persist();
          log('group_video.decision',{action:decision.action,segments:watching.segments,frames:watching.frames,seconds:watching.playbackProgressSeconds});return lastDecision;
        };
        const observation=await observe(contact,message,combined,{onObservation});combined.throwIfAborted();authorize();
        const proof=sharedVideoProof(observation);
        if(!observedBatches){const decision=await onObservation(observation);if(decision.action==='continue')throw error('GROUP_VIDEO_CONTINUATION_UNAVAILABLE');}
        const outcome=observation.watchOutcome,reason=outcome?.stopReason||(lastDecision?.action==='stop'?'model-choice':null);
        if(!['model-choice','video-ended'].includes(reason)||reason==='video-ended'&&outcome?.reachedEnd!==true)throw error('GROUP_VIDEO_OUTCOME_INVALID');
        const final=await resolve(item,combined);combined.throwIfAborted();authorize();
        if(stamp(final.contact)!==item.authorization||keyOf(final.contact,final.message)!==item.key)throw error('GROUP_VIDEO_SOURCE_CHANGED');
        Object.assign(item,{status:'completed',proof,stopReason:reason,reachedEnd:reason==='video-ended',fullVideoObserved:false,completedAt:new Date(this.now()).toISOString(),method:'autonomous-video-observation'});this.data.completed++;this.persist();
        log('group_video.observed',{frames:item.watching?.frames||proof.frames,seconds:item.watching?.playbackProgressSeconds||proof.playbackProgressSeconds,stopReason:reason});
      } catch (reason) {
        if (item.status === 'completed') return;
        if (!canPersist()) return;
        const code = typeof reason?.code === 'string' && /^[A-Z0-9_-]{1,80}$/.test(reason.code) ? reason.code : 'GROUP_VIDEO_OBSERVATION_FAILED';
        if (['GROUP_VIDEO_SOURCE_CHANGED','GROUP_VIDEO_REVOKED'].includes(code)) item.status = 'cancelled';
        else { if(!combined.aborted&&code!=='GROUP_VIDEO_WAIT_BUDGET')item.failures=(item.failures||0)+1;item.status = item.failures >= 3 ? 'unavailable' : 'deferred'; item.nextRetryAt = this.now() + (combined.aborted ? 15000 : 60000); }
        item.reasonCode = code; this.persist(); log('group_video.deferred', { code });
      } finally { this.running = false; this.active = null; this.abort = null; this.canPersist = null; }
    })();
    this.promise = pending;
    try { await pending; } finally { if (this.promise === pending) this.promise = null; }
  }
}
