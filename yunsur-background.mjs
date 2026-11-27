import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {BrowserController} from './core.mjs';
import { decimalId, YunsurMcpClient } from './yunsur-mcp.mjs';
import { BackgroundVideoSampler, isImageWork } from './yunsur-video.mjs';
import {YunsurChatBrowser} from './yunsur-chat.mjs';
import { YunsurVideoForwarder } from './yunsur-share.mjs';
import { reactionTools, YunsurVideoInteractions } from './yunsur-interactions.mjs';
import { liveRoomCandidate, liveUnavailable, resolveLiveRoom } from './yunsur-live.mjs';
import { AutonomousWatch, WATCH_LIMITS } from './autonomous-watch.mjs';
import {prepareVideoFrames} from './video-storyboard.mjs';
import { isLiveRoom, readyImagePost } from './video-limits.mjs';
import { playbackWatchDecision, redact } from './api-agent.mjs';
import { checkPrivateVideoAccess } from './chat-message.mjs';

const workId = id => typeof id === 'string' && /^\d{10,30}$/.test(id);
const workLink = (id, kind) => 'https://www.douyin.com/' + kind + '/' + id;
const LOCAL_TOOLS = new Set(['douyin_recall', 'douyin_remember', 'douyin_persona_status', 'douyin_interest_record', 'douyin_video_limits_status', 'douyin_watch_status', 'douyin_report_status', 'douyin_report_generate', 'douyin_read_comments']);
const canSkipEntry = error => ['BACKGROUND_MEDIA_UNAVAILABLE', 'BACKGROUND_LIVE_UNAVAILABLE'].includes(error.code);

function publicComment(comment, videoId) {
  const commentId = decimalId(comment?.cid);
  const text = typeof comment?.text === 'string' ? comment.text.trim().slice(0, 512) : '';
  if (!commentId || !text || comment.aweme_id != null && decimalId(comment.aweme_id) !== videoId) return null;
  const count = Number(decimalId(comment.digg_count) ?? NaN);
  const likeCount = Number.isSafeInteger(count) ? count : null;
  return { commentId, text, likeCount, ...(likeCount !== null ? { likeCountText: String(likeCount) } : {}) };
}

export class YunsurBackgroundController extends BrowserController{
  constructor({connectionFile,...options}={}){
    super(options);if(!path.isAbsolute(connectionFile)||fs.statSync(connectionFile).size>16000)throw Error('后台连接配置无效。');
    const connection=JSON.parse(fs.readFileSync(connectionFile,'utf8'));this.client=new YunsurMcpClient(connection);
    this.backend='yunsur-mcp';this.cacheRoot=path.join(path.dirname(connectionFile),'video-cache');this.sampler=this.createSampler();this.feed=[];this.refreshIndex=0;this.recent=[];this.pendingAbort=null;
  }
  get ready() {
    this.initialization ??= this.client.initialize().catch(error => { this.initialization = null; throw error; });
    return this.initialization;
  }
  executionMode(){return Promise.resolve('background');}
  async withPage(){throw Object.assign(Error('后台 MCP 不连接浏览器页面。'),{code:'BACKGROUND_NOT_BROWSER'});}
  async connectExistingBrowser(){throw Object.assign(Error('后台 MCP 不连接浏览器页面。'),{code:'BACKGROUND_NOT_BROWSER'});}
  async supportedTools({ signal } = {}) {
    signal?.throwIfAborted();
    if (this.toolCapabilities?.expiresAt > Date.now()) return this.toolCapabilities.names;
    const deadline = AbortSignal.timeout(3000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let names = new Set();
    try { await this.ready; names = await this.client.listToolNames({ signal: combined }); }
    catch { signal?.throwIfAborted(); }
    this.toolCapabilities = { names, expiresAt: Date.now() + 30_000 };
    return names;
  }
  async supportsNativeShare(options) {
    return (await this.supportedTools(options)).has('share_conversation_aweme');
  }
  currentVideoId() {
    const current = this.sampler.current;
    return current && !['image-post', 'live-room'].includes(current.kind) ? current.id : null;
  }
  getCommenter() { return this.interactions ??= new YunsurVideoInteractions(this); }
  reactToVideo(request, controls) { return this.getCommenter().react(request, controls); }
  getForwarder() {
    return this.backgroundForwarder ??= new YunsurVideoForwarder({
      chat: this.createChatBrowser(), stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api',
      currentVideoId: () => this.sampler.current?.id,
      supportsNativeShare: options => this.supportsNativeShare(options),
    });
  }
  state(){return Promise.resolve({...this.sampler.state(), searchResults: this.pendingSearch?.items || []});}
  createChatBrowser() {
    const stateDir = this.limits().stateDir;
    const client = { call: async (...args) => { await this.ready; return this.client.call(...args); } };
    return new YunsurChatBrowser({ client, getPolicy: () => JSON.parse(fs.readFileSync(path.join(stateDir, 'chat-policy.json'), 'utf8')), journalDir: path.join(path.dirname(this.cacheRoot), 'dispatch') });
  }
  createWatchService(options){return new YunsurAutonomousWatch(options);}
  createSampler() { return new BackgroundVideoSampler({ cacheDir: this.cacheRoot }); }
  videoGuard(){return this.backgroundGuard??=new AutonomousWatch({controller:this,videoLimits:this.limits(),personaMemory:this.getPersonaMemory(),source:this.source,stateDir:this.limits().stateDir});}
  async sampleWithUsage(sampler,{seconds,signal,ownerId,includeAudio}){
    const abort=new AbortController(),combined=AbortSignal.any([abort.signal,...(signal?[signal]:[])]);this.pendingAbort=abort;
    const onProgress=state=>{try{const usage=this.limits().notePlayback(this.source,state,{ownerId});if(!usage.allowed)abort.abort(Object.assign(Error(usage.reason),{watchStatus:'limited'}));}catch(error){abort.abort(error);}};
    try{const result=await sampler.observe({seconds,signal:combined,onProgress,includeAudio});combined.throwIfAborted();return result;}
    finally{if(this.pendingAbort===abort)this.pendingAbort=null;this.limits().settleWatching(this.source,{ownerId});}
  }
  async getWork(id, signal) {
    if (!workId(id)) throw new TypeError('后台作品标识无效。');
    await this.ready;
    const detail = await this.client.call('get_video_detail', { video: id }, { signal });
    const work = detail.aweme_detail || detail.data?.aweme_detail;
    if (work?.aweme_id !== id) throw new Error('后台作品详情与目标作品不匹配。');
    return work;
  }
  async readPublicComments({ videoId = this.sampler.current?.id, limit = 5, signal } = {}) {
    if (!workId(videoId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new TypeError('请先打开抖音视频，每次读取 1 到 10 条热评。');
    return this.readWorkDiscussion(await this.getWork(videoId, signal), { signal, limit });
  }
  async readCommentPage(videoId, cursor, signal) {
    const data = await this.client.call('get_video_comments', { video: videoId, cursor }, { signal });
    if (data?.status_code !== 0 || !Array.isArray(data.comments) && !(data.comments === null && data.total === 0)) throw new Error('未取得对应作品的公开评论。');
    return data;
  }
  async readWorkDiscussion(work, { signal, limit = 5 } = {}) {
    const videoId = work.aweme_id;
    const authorId = decimalId(work.author?.uid);
    const readPage = cursor => this.readCommentPage(videoId, cursor, signal);
    const candidates = new Map();
    const addPage = data => {
      for (const entry of (data.comments ?? []).slice(0, 40)) {
        const comment = publicComment(entry, videoId);
        if (comment && !candidates.has(comment.commentId)) candidates.set(comment.commentId, { entry, comment });
      }
    };
    const first = await readPage('0');
    addPage(first);
    let pagesRead = 1;
    const cursor = decimalId(first.cursor);
    if (candidates.size < limit && cursor && cursor !== '0' && (first.has_more === 1 || first.has_more === true)) {
      try { addPage(await readPage(cursor)); pagesRead++; }
      catch { signal?.throwIfAborted(); }
    }
    const hot = [...candidates.values()].sort((a, b) => (b.comment.likeCount ?? -1) - (a.comment.likeCount ?? -1)).slice(0, limit);
    const timeout = AbortSignal.timeout(9000);
    const replySignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const rows = await Promise.all(hot.map(async ({ entry, comment }) => {
      const replies = new Map();
      const add = values => {
        if (!Array.isArray(values) || !authorId) return;
        for (const item of values.slice(0, 20)) {
          if (decimalId(item?.user?.uid) !== authorId || item.reply_id != null && decimalId(item.reply_id) !== comment.commentId) continue;
          const reply = publicComment(item, videoId);
          if (reply && reply.commentId !== comment.commentId) replies.set(reply.commentId, reply);
        }
      };
      add(entry.reply_comment);
      if (authorId && Number(entry.reply_comment_total) > (entry.reply_comment?.length ?? 0)) {
        try {
          const more = await this.client.call('get_sub_comments', { video: videoId, comment_id: comment.commentId, cursor: '0', count: '10' }, { signal: replySignal });
          if (more?.status_code === 0) add(more.comments);
        } catch { signal?.throwIfAborted(); }
      }
      const { commentId, ...result } = comment;
      return { ...result, authorReplies: [...replies.values()].slice(0, 5).map(({ commentId: _id, ...reply }) => reply) };
    }));
    signal?.throwIfAborted();
    return { videoId, status: 'ready', scope: pagesRead === 1 ? 'first-comment-page' : 'first-two-comment-pages', rows };
  }
  async openWork(id, signal, kind) {
    const work = await this.getWork(id, signal);
    if (kind === 'note' && !isImageWork(work)) throw new Error('已核对的作品不是图文。');
    const permission = this.limits().state();
    if (!permission.allowed) throw Object.assign(new Error(permission.reason), { watchStatus: 'limited' });
    await this.sampler.open(work, { signal });
    this.recent.push(id);
    if (this.recent.length > 128) this.recent.shift();
  }
  async openEntry(entry, signal) {
    if (entry.kind !== 'live-room') return this.openWork(entry.id, signal, entry.kind);
    const args = { web_rid: entry.webRid }, names = await this.supportedTools({ signal });
    if (!names.has('get_live_info') || !names.has('live_room_enter')) throw liveUnavailable('后台连接器未提供直播进房接口。');
    this.recent.push(`live:${entry.webRid}`);
    if (this.recent.length > 128) this.recent.shift();
    let room;
    try {
      const info = await this.client.call('get_live_info', args, { signal });
      if (!decimalId(info?.room_id) || info.room_status != null && ![2, '2'].includes(info.room_status)) throw liveUnavailable('该房间未开播。');
      const time = this.limits().state();
      if (!time.allowed) throw Object.assign(Error(time.reason), { watchStatus: 'limited' });
      room = resolveLiveRoom(entry, info, await this.client.call('live_room_enter', args, { signal, control: true }));
    } catch (error) {
      signal?.throwIfAborted();
      if (error.watchStatus || error.code === 'BACKGROUND_LIVE_UNAVAILABLE') throw error;
      throw liveUnavailable('未取得同一直播间的画面地址。');
    }
    await this.sampler.openLive(room, { signal });
  }
  async searchPage(query, offset, signal) {
    const result = await this.client.call('search_videos', { keyword: query, channel: 'general', offset: String(offset) }, { signal });
    if (result?.status_code !== 0 || !Array.isArray(result.data)) throw new Error('未取得可核对的抖音搜索结果。');
    const items = [], seen = new Set();
    for (const row of result.data.slice(0, 30)) {
      const live = liveRoomCandidate(row) ?? liveRoomCandidate(row?.aweme_info);
      if (live) {
        const key = `live:${live.webRid}`;
        if (!seen.has(key)) items.push({ ...live, index: items.length, url: `https://live.douyin.com/${live.webRid}` });
        seen.add(key);
        continue;
      }
      const work = row?.aweme_info;
      if (!workId(work?.aweme_id) || seen.has(work.aweme_id)) continue;
      seen.add(work.aweme_id);
      const id = work.aweme_id;
      items.push({ id, index: items.length, title: String(work.desc || '').slice(0, 1000), url: workLink(id, isImageWork(work) ? 'note' : 'video') });
    }
    return { query, items, offset: offset + result.data.length, hasMore: result.data.length > 0 && (result.has_more === 1 || result.has_more === true) };
  }
  async nextWork(signal) {
    await this.ready;
    for (let attempt = 0; attempt < 12; attempt++) {
      signal?.throwIfAborted();
      const search = this.activeSearch;
      if (search && !search.items.length) {
        if (!search.hasMore) throw Object.assign(new Error('本次主题搜索可用作品已浏览完。'), { watchStatus: 'completed' });
        this.activeSearch = await this.searchPage(search.query, search.offset, signal);
        continue;
      }
      if (!search && !this.feed.length) {
        const feed = await this.client.call('get_homefeed', { count: '6', refresh_index: String(++this.refreshIndex) }, { signal });
        if (feed.status_code !== 0 || !Array.isArray(feed.aweme_list) || !feed.aweme_list.length) throw new Error('后台推荐流没有可用作品。');
        this.feed = feed.aweme_list.slice(0, 20).map(item => liveRoomCandidate(item) ?? { id: item?.aweme_id });
      }
      const entry = (search?.items || this.feed).shift();
      const live = entry.kind === 'live-room';
      if (live ? this.recent.includes(`live:${entry.webRid}`) : !workId(entry.id) || this.recent.includes(entry.id)) continue;
      try { await this.openEntry(entry, signal); return this.state(); }
      catch (error) { if (!canSkipEntry(error)) throw error; }
    }
    throw new Error('这一批作品没有取得可解码的画面。');
  }
  async execute(name,args={}, options={}){
    const {signal,autonomousRunId}=options;
    if (LOCAL_TOOLS.has(name) || name.startsWith('douyin_chat_')) return super.execute(name, args, options);
    if(name==='douyin_status')return{state:await this.state()};
    if(name==='douyin_pause'){await this.videoGuard().stop({explicit:true});await this.pauseForLimits();return{state:await this.state()};}
    const operation=this.queue.catch(()=>{}).then(async()=>{
      signal?.throwIfAborted();const guard=this.videoGuard();let release;
      if(autonomousRunId){const owner=guard.worker();if(!owner?.alive||owner.pid!==process.pid||owner.source!==this.source||owner.runId!==autonomousRunId)throw Object.assign(Error('后台观看锁已改变，未操作视频。'),{status:409});}
      else release=guard.claimManual('mcp-video');
      try{return await this.executeVideo(name,args,options);}finally{await release?.();}
    });this.queue=operation;return operation;
  }
  async executeVideo(name,args={}, {signal,expectedVideoId,expectedImageKey,advanceImage,expectedLiveRoomId,autonomousRunId}={}){
    await this.ready;signal?.throwIfAborted();
    if(name==='douyin_status')return{state:await this.state()};
    if(name==='douyin_pause'){await this.pauseForLimits();return{state:await this.state()};}
    const permission=this.limits().beforeAction(this.source,name);if(!permission.allowed)throw Object.assign(Error(permission.reason),{watchStatus:'limited'});
    if(expectedVideoId&&this.sampler.current?.id!==expectedVideoId)return{changed:false,staleObservation:true,reasonCode:'observed-video-changed',state:await this.state()};
    if (expectedLiveRoomId && (this.sampler.current?.kind !== 'live-room' || this.sampler.current.id !== expectedLiveRoomId)) {
      return { changed: false, staleObservation: true, reasonCode: 'observed-live-room-changed', state: await this.state() };
    }
    if (name === 'douyin_search') {
      this.pendingSearch = null;
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query || query.length > 300 || /[\p{Cc}\p{Cf}]/u.test(query)) throw new TypeError('请提供有效的搜索关键词。');
      this.pendingSearch = await this.searchPage(query, 0, signal);
      return { state: await this.state() };
    }
    if (name === 'douyin_open_video') {
      const { index, url } = args;
      if (Number.isSafeInteger(index) && index >= 0 && url === undefined) {
        const search = this.pendingSearch, item = search?.items[index];
        if (!item) throw new Error('此搜索结果已失效，请重新搜索。');
        await this.openEntry(item, signal);
        this.activeSearch = { ...search, items: search.items.slice(index + 1) };
      } else {
        const route = typeof url === 'string' && /^https:\/\/www\.douyin\.com\/(video|note)\/(\d{10,30})\/?$/.exec(url);
        if (!route || index !== undefined) throw new TypeError('作品链接或搜索序号无效。');
        await this.openWork(route[2], signal, route[1]);
        this.activeSearch = null;
      }
      this.pendingSearch = null;
      return { state: await this.state() };
    }
    if (advanceImage === true) {
      const current = await this.state();
      if (name !== 'douyin_next' || !expectedVideoId || !expectedImageKey || !readyImagePost(current)) throw new Error('后台图文翻页缺少当前作品和图片。');
      if (current.imagePost.imageKey !== expectedImageKey) return { changed: false, staleObservation: true, state: current };
      await this.sampler.advanceImage({ signal });
      return { changed: false, pageChanged: true, state: await this.state() };
    }
    if(name==='douyin_open'){this.activeSearch=null;this.pendingSearch=null;if(!this.sampler.current)await this.nextWork(signal);return{state:await this.state()};}
    if(name==='douyin_next'){
      const before = this.sampler.current;
      await this.nextWork(signal);
      return { changed: this.sampler.current.id !== before?.id || this.sampler.current.kind !== before?.kind, state: await this.state() };
    }
    if(name==='douyin_play')return{state:await this.state(),playbackBackend:'local-decoder'};
    if(name==='douyin_observe'){
      return this.sampleWithUsage(this.sampler,{seconds:args.seconds??12,signal,ownerId:autonomousRunId||`manual:${randomUUID()}`});
    }
    throw Object.assign(Error('当前后台候选尚未接入此操作，未切回浏览器执行。'),{code:'BACKGROUND_ACTION_UNSUPPORTED'});
  }
  async pauseForLimits(){
    this.pendingAbort?.abort(Object.assign(Error('后台观看已暂停。'),{watchStatus:'stopped'}));
    if (this.sampler?.current?.kind === 'live-room' && !this.sampler.busy) await this.sampler.close();
    return{paused:true,backend:this.backend};
  }
  async applyWatchMode(){return{applied:true,backend:this.backend,background:true,minimized:false};}
  async observeSharedWork({ url, videoId, signal, onObservation, includeComments = false, privateVideoAccess } = {}) {
    if (!workId(videoId) || url !== workLink(videoId, 'video')) throw new Error('分享作品标识无法核对。');
    if (onObservation !== undefined && typeof onObservation !== 'function') throw new TypeError('分享作品续看需要本机决策回调。');
    const check = () => {
      signal?.throwIfAborted();
      if (checkPrivateVideoAccess(privateVideoAccess, videoId)) return;
      const time = this.limits().state();
      if (!time.allowed) throw Object.assign(new Error(time.reason), { code: 'GROUP_VIDEO_WAIT_BUDGET' });
    };
    check();
    const observe = () => this.#sampleSharedWork({ videoId, signal, onObservation, includeComments, check, privateVideo: Boolean(privateVideoAccess) });
    if (privateVideoAccess) return this.withSharedWorkViewer(signal, observe);
    const guard = this.videoGuard();
    if (guard.state().running) {
      await guard.stop({ explicit: true });
      for (let attempt = 0; guard.state().running; attempt++) {
        check();
        if (attempt >= 150) throw Object.assign(new Error('自主观看尚未让出播放通道。'), { code: 'CHAT_VIDEO_BUSY' });
        await delay(100, undefined, { signal });
      }
    }
    const release = guard.claimManual('mcp-chat-shared-video');
    try {
      const permission = this.limits().beforeAction(this.source, 'douyin_observe');
      if (!permission.allowed) throw Object.assign(new Error(permission.reason), { code: 'GROUP_VIDEO_WAIT_BUDGET' });
      return await observe();
    } finally { await release(); }
  }
  async #sampleSharedWork({ videoId, signal, onObservation, includeComments, check, privateVideo }) {
    const ownerId = 'shared:' + randomUUID();
    let sampler;
    try {
      check();
      const work = await this.getWork(videoId, signal);
      if (isImageWork(work)) throw new Error('这是图文分享，当前只读取卡片。');
      check();
      sampler = this.createSampler();
      await sampler.open(work, { signal, includeAudio: false, privateVideo });
      let seconds = 12, segments = 0, frames = 0, playbackProgressSeconds = 0;
      while (true) {
        check();
        const sample = privateVideo ? await sampler.observe({ seconds, signal, includeAudio: false })
          : await this.sampleWithUsage(sampler, { seconds, signal, ownerId, includeAudio: false });
        if (privateVideo) check();
        segments++;
        frames += sample.frames.length;
        playbackProgressSeconds += sample.observation.playbackProgressSeconds;
        const reachedEnd = sample.state.video.ended === true;
        const progress = { segments, frames, playbackProgressSeconds, reachedEnd };
        const choice = onObservation ? await onObservation(sample, progress) : null;
        signal?.throwIfAborted();
        if (!onObservation || reachedEnd || choice?.action === 'stop') {
          if (includeComments) {
            try { sample.comments = await this.readWorkDiscussion(work, { signal }); }
            catch { signal?.throwIfAborted(); sample.comments = { videoId, status: 'unavailable', rows: [] }; }
          }
          return { ...sample, ...(onObservation ? { watchOutcome: { ...progress, fullVideoObserved: false, stopReason: reachedEnd ? 'video-ended' : 'model-choice' } } : {}) };
        }
        if (choice?.action !== 'continue' || !Number.isFinite(choice.seconds) || choice.seconds < 0.2 || choice.seconds > 30) throw new Error('分享视频续看选择无效。');
        seconds = choice.seconds;
      }
    } finally { await sampler?.close(); }
  }
  async close() {
    await this.pauseForLimits();
    try { await super.close(); }
    finally { if (this.sampler && !this.sampler.busy) await this.sampler.close(); }
  }
}

// 复用原观看锁、预算、停止与收尾；模型选择下一段长度或换片。
export class YunsurAutonomousWatch extends AutonomousWatch{
  constructor(options) {
    super(options);
    this.agent.maxFrames = 12;
  }
  stayOnImage(seconds) { return this.execute('douyin_observe', { seconds }); }
  async openTopic(query, options) {
    const found = await this.execute('douyin_search', { query });
    for (const item of found.state.searchResults) {
      if (options.exclude.some(word => item.title.toLocaleLowerCase().includes(word.toLocaleLowerCase()))) continue;
      try { return await this.execute('douyin_open_video', { index: item.index }); }
      catch (error) { if (!canSkipEntry(error)) throw error; }
    }
    return null;
  }
  async videoDecision(observation, started, options) {
    const signal = this.abort.signal;
    const packed = prepareVideoFrames(observation.frames, { signal });
    let evidence;
    try {
      evidence = this.personaMemory.recordObservation({ ...observation, frames: packed.frames }, { source: this.source, kind: 'visual' });
    } catch (error) {
      if (error.code !== 'PERSONA_CAPACITY') throw error;
      this.save({ memoryWarning: error.message });
      this.onEvent({ type: 'watch.memory-warning', code: error.code, message: '人格观察记录已满，本次继续观看。' });
    }
    const before = { state: { ...observation.state, video: { ...observation.state.video, time: observation.observation.beforeTime, paused: false } } };
    let viewing;
    if (evidence) {
      try { viewing = this.viewing(evidence.evidenceId, before, { state: observation.intervalState }, started, 'watch:' + this.runId + ':decoder:' + randomUUID()); }
      catch (error) { if (!['PERSONA_EVIDENCE', 'PERSONA_ARGUMENT'].includes(error.code)) throw error; }
    }
    let shareContext = { enabled: false, recipients: [] };
    let commentContext = { enabled: false };
    let reactionContext = { like: false, favorite: false };
    if (evidence?.evidenceId) {
      const videoId = observation.state.video.id, local = this.shareContext(videoId);
      const processed = new Set(local.processedRecipients?.map(item => item.recipientId));
      const recipients = local.recipients.filter(item => !processed.has(item.id));
      if (local.enabled && recipients.length && await this.controller.supportsNativeShare({ signal })) shareContext = { ...local, recipients };
      const comments = this.commentContext(videoId), reactions = await this.reactionContext(videoId);
      const commentAllowed = comments.enabled && this.commentAttemptedVideo !== videoId;
      commentContext = { ...comments, enabled: false };
      if (commentAllowed || reactions.like || reactions.favorite) {
        const tools = await this.controller.supportedTools({ signal });
        commentContext = { ...comments, enabled: commentAllowed && tools.has('post_video_comment') };
        reactionContext = Object.fromEntries(Object.entries(reactionTools).map(([action, tool]) => [action, reactions[action] === true && tools.has(tool)]));
      }
    }
    this.assertAllowed();
    this.phase = 'model';
    this.pendingRequests = 1;
    this.save({ phase: this.phase, pendingRequests: 1 });
    try {
      this.reserveRequest();
      const result = await this.agent.decideWatch({
        observation: { ...observation, viewing, observation: { ...observation.observation, audioTranscript: observation.audio?.ok ? observation.audio.text : null, limitations: observation.limitations } },
        context: this.personaMemory.context(), watchOptions: options,
        shareContext, commentContext, reactionContext,
        signal, decisionProvider: this.decisionProvider,
      });
      const checked = playbackWatchDecision(result.decision, { shareContext, commentContext, reactionContext, mediaKind: 'video' });
      return { ...result, ...checked, evidenceId: evidence?.evidenceId };
    } finally {
      this.phase = 'waiting';
      this.pendingRequests = 0;
      this.save({ phase: this.phase, pendingRequests: 0 });
    }
  }
  async interact(decision, observation, evidenceId) {
    const videoId = observation.state.video.id, action = decision.action;
    const current = await this.execute('douyin_status');
    if (!evidenceId || (current.state || current).video?.id !== videoId) return;
    try {
      if (action === 'comment') {
        this.commentAttemptedVideo = videoId;
        if (!this.commentContext(videoId).enabled) return;
        const delivery = await this.publishCommentDecision(observation, { evidenceId, videoId });
        if (delivery?.deliveryUncertain) this.onEvent({ type: 'watch.comment-paused', code: 'COMMENT_UNCERTAIN', message: '本次公开评论待核对，暂停发评，继续观看。' });
      } else {
        if (!(await this.reactionContext(videoId))[action]) return;
        const delivery = await (await this.getReactionService()).react({ action, evidenceId, videoId }, { signal: this.abort.signal, watchRunId: this.runId });
        this.onEvent({ type: 'watch.reaction', delivery });
        if (delivery.deliveryUncertain) this.onEvent({ type: 'watch.reaction-paused', code: 'REACTION_UNCERTAIN', message: '本次点赞或收藏待核对，暂停互动，继续观看。' });
      }
    } catch (error) {
      if (error.watchStatus) throw error;
      this.assertAllowed();
      this.onEvent({ type: 'watch.interaction-skipped', action, code: 'BACKGROUND_INTERACTION_NOT_CONFIRMED' });
    }
  }
  async run() {
    let status = 'stopped', lastError = '', seconds = 12, liveSeconds = WATCH_LIMITS.sampleSeconds, current;
    this.shareProgress = null;
    this.commentAttemptedVideo = null;
    this.invalidDecisionStreak = 0;
    try {
      this.save({ status: 'running', phase: 'preparing', shareProgress: null, backend: 'yunsur-mcp-local-decoder' });
      const initial = this.optionsService.state().policy;
      if (initial.mode === 'topic') {
        for (const query of initial.topics) {
          current = await this.openTopic(query, initial);
          if (current) break;
        }
        if (!current) throw new Error('主题搜索没有可解码的作品。');
      } else current = await this.execute('douyin_open');
      while (true) {
        this.assertAllowed();
        const options = this.optionsService.state().policy;
        const state = current.state || current;
        if (isLiveRoom(state)) {
          const title = state.liveRoom.title.toLocaleLowerCase();
          if (options.exclude.some(word => title.includes(word))) {
            current = await this.execute('douyin_next', {}, { expectedLiveRoomId: state.liveRoom.roomId, exitLive: true });
            liveSeconds = WATCH_LIMITS.sampleSeconds;
            continue;
          }
          const result = await this.watchLiveRoom(current, { seconds: liveSeconds, continuousPlayback: false });
          current = result.current;
          if (result.stopRequested) { status = 'completed'; break; }
          liveSeconds = result.nextSeconds ?? WATCH_LIMITS.sampleSeconds;
          seconds = 12;
          continue;
        }
        if (readyImagePost(state)) {
          const result = await this.watchImagePost(current, options);
          current = result.current;
          if (result.stopRequested) { status = 'completed'; break; }
          seconds = 12;
          continue;
        }
        const video = state.video;
        if (!video || video.ended || options.exclude.some(word => String(video.title || '').toLocaleLowerCase().includes(word.toLocaleLowerCase()))) {
          current = await this.execute('douyin_next');
          seconds = 12;
          continue;
        }
        this.phase = 'observing';
        this.save({ phase: this.phase, pendingRequests: 0 });
        const started = this.now();
        const observation = await this.execute('douyin_observe', { seconds });
        let result;
        try { result = await this.videoDecision(observation, started, options); }
        catch (error) { current = await this.recoverDecision(error); continue; }
        this.assertAllowed();
        this.invalidDecisionStreak = 0;
        const decision = result.decision;
        this.reportSkippedReaction(result.skippedReaction);
        this.save({ lastDecision: decision, usage: result.usage, decisionRetry: null });
        this.onEvent({ type: 'watch.background-decision', action: decision.action, frames: observation.frames.length, progress: observation.observation.playbackProgressSeconds, audioStatus: observation.audio?.ok ? 'transcribed' : observation.audio?.status || null });
        if (decision.action === 'stop') { status = 'completed'; break; }
        if (decision.action === 'search') {
          current = await this.openTopic(decision.query, options) || observation;
          seconds = 12;
        } else if (decision.action === 'share') {
          const learned = await this.shareDecision(decision, { evidenceId: result.evidenceId, videoId: observation.state.video.id });
          if (learned && decision.topics.length) this.personaMemory.updateAgentInterests({ evidenceId: result.evidenceId, topics: decision.topics, reflection: decision.reflection }, { source: this.source });
          current = await this.execute('douyin_status');
          seconds = 12;
        } else if (['like', 'favorite', 'comment'].includes(decision.action)) {
          await this.interact(decision, observation, result.evidenceId);
          current = await this.execute('douyin_status');
          seconds = 12;
        } else if (decision.action === 'skip' || observation.state.video.ended) {
          current = await this.execute('douyin_next', {}, { expectedVideoId: observation.state.video.id });
          seconds = 12;
        } else if (decision.action === 'stay') {
          current = observation;
          seconds = decision.seconds;
        } else throw new Error('后台观看没有执行未接入的互动。');
      }
    } catch (error) {
      const reason = this.abort?.signal.aborted ? this.abort.signal.reason || error : error;
      status = reason.watchStatus || 'failed';
      lastError = redact(reason.message, [this.config.apiKey]);
    } finally {
      await this.finishRun(status, lastError);
    }
    return this.state();
  }
}
