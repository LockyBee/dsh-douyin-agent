import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { randomUUID } from 'node:crypto';
import { ChatAgent } from './chat-agent.mjs?v=9';
import { loadApiConfig, redact } from './api-agent.mjs';
import { messageFingerprint } from './chat-message.mjs';
import { OutboundCoordinator } from './outbound-send.mjs';

const basePolicy = () => ({ version: 1, enabled: false, allowlist: [], dailyReplyLimit: 40 });
const dayKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const load = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
const alive = (pid) => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
function save(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file); }
function initialize(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); let descriptor; try { descriptor = fs.openSync(file, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return; throw error; } try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2)); } finally { fs.closeSync(descriptor); } }
function recentEvents(file) {
  if (!fs.existsSync(file)) return [];
  const descriptor = fs.openSync(file, 'r');
  try { const size = fs.fstatSync(descriptor).size; const length = Math.min(size, 65_536); const buffer = Buffer.alloc(length); fs.readSync(descriptor, buffer, 0, length, size - length); const lines = buffer.toString('utf8').split('\n'); if (size > length) lines.shift(); return lines.filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).slice(-30); }
  finally { fs.closeSync(descriptor); }
}
function validatePolicy(policy) {
  if (!Number.isSafeInteger(policy.dailyReplyLimit) || policy.dailyReplyLimit < 1 || policy.dailyReplyLimit > 200) throw new Error('私信每日请求上限须在 1 至 200 之间。');
  if (!Array.isArray(policy.allowlist) || policy.allowlist.length > 2 || new Set(policy.allowlist.map((item) => item.id)).size !== policy.allowlist.length) throw new Error('白名单最多两个不同联系人。');
  for (const item of policy.allowlist) if (typeof item.id !== 'string' || !item.id || item.id.length > 500 || item.followed !== true || item.isGroup !== false || !item.verifiedAt) throw new Error('白名单联系人必须已有关注关系与非群聊核对记录。');
  return policy;
}
function messagesOf(snapshot) {
  if (snapshot?.loginRequired || snapshot?.verificationRequired || snapshot?.blocked) throw new Error('抖音私信需要手动登录、验证或解除页面限制。');
  if (!Array.isArray(snapshot?.messages)) throw new Error('没有读到可靠的私信消息列表。');
  const messages = snapshot.messages.map((message) => ({ ...structuredClone(message), sender: message.sender || message.direction }));
  if (messages.some((message) => typeof message.id !== 'string' || !message.id || !['incoming', 'outgoing', 'unknown'].includes(message.sender))) throw new Error('私信消息缺少稳定 ID 或方向，未回复。');
  return messages;
}

// 沿用视频工具的本机配置与直接 API 请求；私信状态及正文只写本机 state。
export class ChatService {
  constructor({ browser, config = loadApiConfig(), agent = new ChatAgent({ config }), stateDir = resolveRuntimePaths().stateDir, pollIntervalMs = 15_000, outboundCoordinator } = {}) {
    if (!browser?.listContacts || !browser?.readConversation || !browser?.sendMessage) throw new Error('缺少私信浏览器控制器。');
    Object.assign(this, { browser, config, agent, stateDir, pollIntervalMs });
    this.outbound = outboundCoordinator ?? new OutboundCoordinator({ stateDir, source: browser.controller?.source === 'dsh-chat' ? 'dsh' : 'api' });
    this.policyFile = path.join(stateDir, 'chat-policy.json');
    this.watermarkFile = path.join(stateDir, 'chat-watermarks.json');
    this.logFile = path.join(stateDir, 'chat-events.jsonl');
    this.lockFile = path.join(stateDir, 'chat-loop.lock'); this.stopFile = path.join(stateDir, 'chat-stop.request.json'); this.guardFile = path.join(stateDir, 'chat-control.guard');
    this.policy = validatePolicy(load(this.policyFile, basePolicy()));
    this.watermarks = load(this.watermarkFile, { version: 1, contacts: {}, days: {} });
    this.running = false; this.busy = false; this.timer = null; this.abort = null; this.starting = null; this.runId = null; this.heartbeat = null; this.ownershipLost = false;
    this.events = [];
    if (!fs.existsSync(this.watermarkFile)) initialize(this.watermarkFile, this.watermarks);
    if (!fs.existsSync(this.policyFile)) initialize(this.policyFile, this.policy);
  }

  log(type, value = {}) {
    const event = redact({ at: new Date().toISOString(), type, ...value }, [this.config?.apiKey]);
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.appendFileSync(this.logFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    this.events.push(event); if (this.events.length > 100) this.events.shift();
  }
  persist() { if (this.ownershipLost) throw new Error('回复进程已失去锁，未覆盖其他入口的水位。'); if (this.runId) this.assertOwned(); save(this.watermarkFile, this.watermarks); }
  control(action) {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const token = randomUUID(); let descriptor;
    try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('另一个入口正在更新回复锁，或控制锁需要人工核对；未自动删除控制锁。'), { code: 'CHAT_CONTROL_BUSY' }); throw error; }
    try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); }
    finally { fs.closeSync(descriptor); }
    try { return action(); }
    finally { const current = load(this.guardFile, null); if (current?.token === token && current.pid === process.pid) fs.unlinkSync(this.guardFile); }
  }
  loseOwnership() {
    if (this.ownershipLost) return;
    this.ownershipLost = true; this.running = false;
    clearInterval(this.timer); clearInterval(this.heartbeat); this.timer = null; this.heartbeat = null;
    this.abort?.abort(new Error('回复进程已失去 worker 锁，已停止操作。'));
    this.runId = null;
    this.log('worker.ownership_lost', { message: '已停止旧入口，不改新入口的锁、配置或水位。' });
  }
  assertOwned() { const worker = this.worker(); if (!this.runId || worker?.owned !== true || worker.pid !== process.pid) { this.loseOwnership(); throw new Error('回复进程已失去 worker 锁，未继续操作。'); } return worker; }
  worker() {
    try { const worker = load(this.lockFile, null); return worker ? { ...worker, alive: alive(worker.pid), heartbeatFresh: Date.now() - Date.parse(worker.heartbeatAt) < 10_000, owned: worker.runId === this.runId } : null; }
    catch { return fs.existsSync(this.lockFile) ? { alive: Date.now() - fs.statSync(this.lockFile).mtimeMs < 30_000, owned: false, status: 'starting', note: '锁文件尚未写完，暂不启动第二个回复进程。' } : null; }
  }
  acquire() {
    this.control(() => {
      const existing = this.worker();
      if (existing?.alive) throw new Error('另一个入口已经运行私信自动回复；请使用状态或停止工具。');
      if (existing) fs.unlinkSync(this.lockFile);
      const descriptor = fs.openSync(this.lockFile, 'wx', 0o600);
      this.runId = randomUUID(); this.ownershipLost = false;
      try { fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, runId: this.runId, heartbeatAt: new Date().toISOString(), status: 'starting' })); }
      finally { fs.closeSync(descriptor); }
      this.watermarks = load(this.watermarkFile, { version: 1, contacts: {}, days: {} });
      for (const mark of Object.values(this.watermarks.contacts)) if (mark.status === 'inflight') { mark.status = 'delivery-uncertain'; mark.reason = '上次进程在发送确认前结束，请人工核对。'; }
      this.persist();
    });
    this.heartbeat = setInterval(() => {
      try {
        this.assertOwned();
        const request = load(this.stopFile, null);
        if (request?.targetRunId === this.runId && (this.running || this.starting)) this.stop();
        if (this.runId) this.control(() => { this.assertOwned(); save(this.lockFile, { pid: process.pid, runId: this.runId, heartbeatAt: new Date().toISOString(), status: this.running ? 'running' : this.starting ? 'starting' : 'stopping' }); });
        if (!this.running && !this.busy && !this.starting) this.release();
      } catch (error) { if (error.code !== 'CHAT_CONTROL_BUSY') this.log('worker.control_error', { message: error.message }); }
    }, 1000); this.heartbeat.unref?.();
  }
  release() {
    if (!this.runId || this.busy || this.starting) return;
    try { this.control(() => { this.assertOwned(); const policy = validatePolicy(load(this.policyFile, this.policy)); policy.enabled = false; save(this.policyFile, policy); fs.unlinkSync(this.lockFile); }); }
    catch (error) { if (error.code === 'CHAT_CONTROL_BUSY') return; if (this.ownershipLost) return; throw error; }
    clearInterval(this.heartbeat); this.heartbeat = null; this.runId = null;
  }
  state() {
    const worker = this.worker();
    if (!worker?.owned) { this.policy = validatePolicy(load(this.policyFile, this.policy)); this.watermarks = load(this.watermarkFile, this.watermarks); this.events = recentEvents(this.logFile); }
    return { running: this.running || Boolean(worker?.alive && worker.status === 'running'), starting: Boolean(this.starting || worker?.status === 'starting'), busy: this.busy, worker, coordination: { protocol: 'guard-v1', guardPresent: fs.existsSync(this.guardFile) }, pollSeconds: this.pollIntervalMs / 1000, replyTokens: this.agent.replyTokens ?? 512, policy: this.policy, daily: { date: dayKey(), requests: this.watermarks.days[dayKey()] ?? 0, limit: this.policy.dailyReplyLimit }, contacts: Object.entries(this.watermarks.contacts).filter(([id]) => this.policy.allowlist.some((item) => item.id === id)).map(([id, mark]) => ({ id, status: mark.status, reason: mark.reason || '', pending: mark.pending || null, unanswered: mark.unanswered || [], lastCheckedAt: mark.lastCheckedAt })), events: this.events.slice(-30) };
  }
  async listContacts({ signal } = {}) { return this.browser.listContacts({ verifyFollowing: true, signal }); }
  async readConversation(id, { signal } = {}) {
    const policy = validatePolicy(load(this.policyFile, this.policy));
    if (!policy.allowlist.some((item) => item.id === id)) throw new Error('联系人不在已核对白名单，未读取私信。');
    return this.browser.readConversation(id, { allowed: true, signal });
  }
  async videoInspector() {
    this.inspectorPromise??=import('./core.mjs?v=9').then(({BrowserController})=>new BrowserController({source:this.browser.controller?.source==='dsh-chat'?'dsh':'api'}));
    return this.inspectorPromise;
  }
  async observeMessage(id,messageId,{signal,includeWork=true}={}) {
    const snapshot=await this.readConversation(id,{signal});
    const message=messagesOf(snapshot).find(item=>item.id===messageId);
    if(!message?.media || message.unsupported) throw new Error('指定消息没有可识别的表情或作品卡片。');
    if(typeof this.browser.captureMessage!=='function') throw new Error('私信画面适配尚未加载，请重新加载插件。');
    const captured=await this.browser.captureMessage(id,messageId,{allowed:true,signal});
    if(captured.loginRequired||captured.verificationRequired||!captured.frames?.length) throw new Error('没有取得指定消息的画面，请核对登录或验证。');
    const result={...captured,messageId,frames:captured.frames.slice(0,1)};
    if(includeWork && message.media.type==='shared-work') {
      const inspector=await this.videoInspector();
      const limits=inspector.limits().state();
      if(!limits.allowed) {result.note=`当前只读取分享卡片封面和网页元数据，未播放作品：${limits.reason}`;return result;}
      try {
        const resolved=await this.browser.openSharedVideo(id,messageId,{allowed:true,signal});
        result.sharedWork=resolved;
        if(!resolved.url) {result.note=resolved.reason||'分享作品链接未核实，只读取卡片。';return result;}
        if(resolved.isPhotoGallery===true) {result.note='分享的是图文作品；本次只读取卡片封面及核实公开链接，没有播放视频。';return result;}
        await inspector.execute('douyin_open_video',{url:resolved.url},{signal});
        const observed=await inspector.execute('douyin_observe',{seconds:3},{signal});
        if(observed.state?.video?.id!==resolved.videoId || observed.observation?.videoId!==resolved.videoId) throw new Error('作品采样身份与分享消息不一致。');
        result.frames.push(...(observed.frames??[]).slice(0,3));
        result.sharedWork={...resolved,state:observed.state,observation:observed.observation};
        result.understandingScope='card-cover-and-three-second-video-sampling';
        result.note='第一张是分享卡片，其余是实际作品三秒内的采样；没有音频，不代表看完整条作品。';
        await inspector.execute('douyin_pause',{}, {signal});
      }catch(error) {signal?.throwIfAborted();result.note=`分享卡片已读取，作品观察未完成：${redact(error.message,[this.config.apiKey])}`;await inspector.pauseForLimits().catch(()=>{});}
    }
    return result;
  }

  async configure({ recipientIds, dailyReplyLimit = this.policy.dailyReplyLimit } = {}) {
    if (this.running || this.starting || this.busy || this.worker()?.alive) throw new Error('请先停止私信自动回复，再修改白名单或预算。');
    if (!Array.isArray(recipientIds) || recipientIds.length > 2 || recipientIds.some((id) => typeof id !== 'string')) throw new Error('请选择最多两个已关注联系人。');
    const result = await this.browser.listContacts({ verifyFollowing: true });
    if (result.blocked || result.loginRequired || result.verificationRequired) throw new Error('请在专用 Edge 完成登录或验证。');
    const allowlist = recipientIds.map((id) => {
      const contact = result.contacts?.find((item) => item.id === id);
      if (!contact || contact.followed !== true || contact.isGroup !== false) throw new Error('所选联系人尚未核对为已关注的个人联系人。');
      return { id, name: contact.name || contact.displayName || '联系人', followed: true, isGroup: false, verifiedAt: new Date().toISOString(), relationshipEvidence: contact.relationshipEvidence || '浏览器关系回读' };
    });
    const policy = validatePolicy({ version: 1, enabled: false, allowlist, dailyReplyLimit });
    this.acquire();
    try { this.control(() => { this.assertOwned(); this.policy = policy; save(this.policyFile, this.policy); }); this.log('policy.updated', { recipientIds, dailyReplyLimit }); }
    finally { this.release(); }
    return this.state();
  }

  async start({ schedule = true, signal } = {}) {
    signal?.throwIfAborted();
    if (this.running) return this.state();
    if (this.starting) return this.starting;
    this.starting = this.begin(schedule, signal);
    try { return await this.starting; } finally { this.starting = null; if (!this.running) this.release(); }
  }
  setReplyProvider(provider) {
    if (provider !== undefined && typeof provider !== 'function') throw new TypeError('私信回复提供器必须是本机函数。');
    if (this.running || this.starting || this.busy) throw new Error('请先停止私信自动回复，再修改回复提供器。');
    this.agent.replyProvider = provider;
  }
  async begin(schedule, externalSignal) {
    if (!this.config?.apiKey && typeof this.agent.replyProvider !== 'function') throw new Error('没有找到 DeepSeek API Key。');
    this.acquire();
    this.policy = validatePolicy(load(this.policyFile, this.policy));
    if (!this.policy.allowlist.length) throw new Error('请先保存核对后的白名单。');
    this.abort = new AbortController();
    const externalAbort = () => this.abort.abort(externalSignal.reason || new Error('启动任务已停止。'));
    if (externalSignal?.aborted) externalAbort(); else externalSignal?.addEventListener('abort', externalAbort, { once: true });
    const signal = this.abort.signal;
    try {
      const contacts = await this.browser.listContacts({ signal, verifyFollowing: true }); signal.throwIfAborted();
      if (contacts.blocked || contacts.loginRequired || contacts.verificationRequired) throw new Error('抖音私信页面需要手动处理。');
      for (const contact of this.policy.allowlist) {
        const current = contacts.contacts?.find((item) => item.id === contact.id);
        if (!current || current.followed !== true || current.isGroup !== false) throw new Error('白名单关系当前未确认，未启用自动回复。');
        const old = this.watermarks.contacts[contact.id];
        if (['inflight', 'delivery-uncertain'].includes(old?.status)) throw new Error('有发送未确认的联系人，请先人工核对并解除暂停。');
        const snapshot = await this.browser.readConversation(contact.id, { allowed: true, signal }); signal.throwIfAborted();
        const messages = messagesOf(snapshot);
        if ((snapshot.contact?.id || snapshot.conversation?.id) !== contact.id) throw new Error('私信会话身份回读不一致，未启用。');
        const unanswered = [...(old?.unanswered || [])];
        if (old?.pending?.incoming?.length && old.pending.phase !== 'handled-by-user') { unanswered.push({ ...old.pending, skippedAt: new Date().toISOString(), reason: '重新启动时设为旧消息基线，不自动补发，请人工处理。' }); this.log('baseline.skipped_pending', { recipientId: contact.id, pending: old.pending, message: '未答消息保留在本机清单，不自动补发。' }); }
        this.watermarks.contacts[contact.id] = { status: 'ready', seen: messages.map((item) => item.id).slice(-2000), context: [], unanswered: unanswered.slice(-60), startedAt: new Date().toISOString(), lastCheckedAt: new Date().toISOString() };
      }
      this.persist(); signal.throwIfAborted();
      this.control(() => { this.assertOwned(); this.policy.enabled = true; save(this.policyFile, this.policy); save(this.lockFile, { pid: process.pid, runId: this.runId, heartbeatAt: new Date().toISOString(), status: 'running' }); }); this.running = true;
      this.log('service.started', { message: '已建立现有消息基线，只回复此后新收到的私信。' });
      if (schedule) { this.timer = setInterval(() => void this.poll().catch(() => {}), this.pollIntervalMs); this.timer.unref?.(); }
      return this.state();
    } catch (error) { this.running = false; this.policy.enabled = false; this.log('service.start_failed', { message: error.message }); throw error; }
    finally { externalSignal?.removeEventListener('abort', externalAbort); }
  }
  stop() {
    if (this.ownershipLost) return this.state();
    const worker = this.worker();
    if (this.runId && worker?.owned !== true) { this.loseOwnership(); return this.state(); }
    if (worker?.alive && !worker.owned) {
      if (!worker.runId) throw new Error('另一个入口正在取得锁，请稍后停止。');
      save(this.stopFile, { targetRunId: worker.runId, requestId: randomUUID(), requestedAt: new Date().toISOString() });
      return { ...this.state(), stopping: true, message: '已向当前回复进程发送停止请求。' };
    }
    this.running = false; clearInterval(this.timer); this.timer = null; this.abort?.abort(new Error('用户停止私信自动回复。')); this.policy.enabled = false; this.log('service.stopped'); this.release(); return this.state();
  }
  resumeContact(id) {
    if (this.running || this.starting || this.busy || this.worker()?.alive) throw new Error('请先停止自动回复，再人工解除联系人暂停。');
    this.acquire();
    try { this.control(() => { this.assertOwned(); this.policy = validatePolicy(load(this.policyFile, this.policy)); this.watermarks = load(this.watermarkFile, this.watermarks);
      if (!this.policy.allowlist.some((item) => item.id === id)) throw new Error('联系人不在白名单。');
      const mark = this.watermarks.contacts[id]; if (mark) { mark.status = 'ready'; mark.reason = ''; this.persist(); }
    }); this.log('contact.manually_resolved', { recipientId: id, message: '用户确认已核对发送结果；下次启动将重新建立基线，不重发旧消息。' }); }
    finally { this.release(); }
    return this.state();
  }

  async deliverReply(contact, mark, reply, latest, signal) {
    const expectedContent = latest.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
    let entered = false, delivery;
    try {
      delivery = await this.outbound.run({ recipientId: contact.id, purpose: 'reply', signal }, async () => {
        signal.throwIfAborted(); this.assertOwned();
        const current = await this.browser.readConversation(contact.id, { allowed: true, signal });
        const messages = messagesOf(current);
        if ((current.contact?.id || current.conversation?.id) !== contact.id || JSON.stringify(messages.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }))) !== JSON.stringify(expectedContent)) {
          mark.pending.phase = 'superseded'; this.persist();
          return { confirmed: false, deliveryUncertain: false, superseded: true };
        }
        entered = true; mark.status = 'inflight'; mark.pending = { ...mark.pending, phase: 'sending', text: reply.text, at: new Date().toISOString() }; this.persist();
        return this.browser.sendMessage(contact.id, reply.text, { allowed: true, signal, expectedMessageIds: latest.map(item => item.id), expectedMessageContent: expectedContent });
      });
    } catch (error) {
      if (!entered && error.beforeDelivery && error.code === 'OUTBOUND_BUSY') {
        mark.status = 'ready'; mark.pending = { ...mark.pending, phase: 'outbound-wait', generatedText: reply.text, expectedContent, usage: reply.usage, at: new Date().toISOString() }; this.persist(); this.log('reply.waiting_for_sender', { recipientId: contact.id }); return;
      }
      if (!entered) throw error;
      mark.status = 'delivery-uncertain'; mark.reason = '发送中断或失败，需人工核对；不会自动重发。'; this.persist(); this.log('delivery.uncertain', { recipientId: contact.id, message: error.message }); return;
    }
    if (delivery?.superseded) { this.log('reply.superseded', { recipientId: contact.id }); return; }
    if (delivery?.confirmed !== true || typeof delivery.messageId !== 'string' || !delivery.messageId.trim()) { mark.status = 'delivery-uncertain'; mark.reason = '未取得发送确认，需人工核对；不会自动重发。'; this.persist(); this.log('delivery.uncertain', { recipientId: contact.id }); return; }
    mark.status = 'ready'; mark.reason = ''; mark.context.push({ id: delivery.messageId, sender: 'outgoing', text: reply.text }); mark.context = mark.context.slice(-12);
    mark.seen.push(delivery.messageId); delete mark.pending; this.persist();
    this.log('reply.sent', { recipientId: contact.id, text: reply.text, messageId: delivery.messageId, usage: reply.usage });
  }
  async poll() {
    if (!this.running || this.busy) return;
    this.assertOwned();
    this.busy = true; const signal = this.abort.signal;
    try {
      for (const contact of this.policy.allowlist) {
        signal.throwIfAborted(); this.assertOwned(); const mark = this.watermarks.contacts[contact.id];
        if (!mark || mark.status !== 'ready') continue;
        try {
          const snapshot = await this.browser.readConversation(contact.id, { allowed: true, signal }); signal.throwIfAborted();
          if ((snapshot.contact?.id || snapshot.conversation?.id) !== contact.id) throw new Error('会话身份回读不一致。');
          if (mark.pending?.phase === 'outbound-wait') {
            const latest = messagesOf(snapshot), content = latest.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
            if (JSON.stringify(content) === JSON.stringify(mark.pending.expectedContent)) {
              await this.deliverReply(contact, mark, { text: mark.pending.generatedText, usage: mark.pending.usage }, latest, signal); continue;
            }
            mark.pending.phase = 'superseded'; this.persist();
          }
          const messages = messagesOf(snapshot); const seen = new Set(mark.seen);
          const discovered = messages.filter((item) => !seen.has(item.id));
          const oldHistory = discovered.filter((item) => ['baseline', 'known-old-window', 'old-history'].includes(item.arrivalClassification));
          const fresh = discovered.filter((item) => !oldHistory.includes(item));
          if (fresh.some((item) => item.sender === 'unknown')) { mark.pending = { phase: 'unclassified', incoming: fresh.map((item) => ({ id: item.id, sender: item.sender, text: item.text || '' })), at: new Date().toISOString() }; throw new Error('新消息方向未确认，联系人已暂停，消息未计入已处理水位。'); }
          mark.seen = [...seen, ...discovered.map((item) => item.id)].slice(-2000); mark.lastCheckedAt = new Date().toISOString(); this.persist();
          if (oldHistory.length) this.log('message.old_history_skipped', { recipientId: contact.id, messageIds: oldHistory.map((item) => item.id), message: '已知旧窗口或加载的历史行只更新水位，不回复。' });
          if (!fresh.length) continue;
          const supported=item=>item.unsupported!==true && (item.media && ['emoji','shared-work'].includes(item.media.type) || (!item.kind||item.kind==='text') && (!item.type||item.type==='text') && typeof item.text==='string' && item.text.trim());
          const unsupported = fresh.filter((item) => item.sender === 'incoming' && !supported(item));
          if (unsupported.length) this.log('message.unsupported', { recipientId: contact.id, messageIds: unsupported.map((item) => item.id), message: '图片、语音、撤回等非文本消息未理解，已跳过。' });
          mark.context = [...mark.context, ...fresh.filter((item) => ['incoming', 'outgoing'].includes(item.sender) && !unsupported.includes(item) && supported(item))].slice(-12); this.persist();
          const incoming = fresh.filter((item) => item.sender === 'incoming' && !unsupported.includes(item));
          if (!incoming.length) { if (fresh.some((item) => item.sender === 'outgoing') && mark.pending?.phase === 'superseded') { mark.pending.phase = 'handled-by-user'; this.persist(); this.log('reply.handled_by_user', { recipientId: contact.id }); } continue; }
          if (incoming.some((item) => item.eligibleForReply !== true)) { mark.pending = { phase: 'unqualified', incoming: incoming.map((item) => ({ id: item.id, text: item.text })), at: new Date().toISOString() }; throw new Error('新消息尚未取得可靠的新到达资格，联系人已暂停。'); }
          const lastIncoming = messages.findLastIndex((item) => incoming.some((freshItem) => freshItem.id === item.id));
          if (messages.slice(lastIncoming + 1).some((item) => item.sender === 'outgoing')) { this.log('message.handled_by_user', { recipientId: contact.id, messageIds: incoming.map((item) => item.id) }); mark.pending = { phase: 'handled-by-user', incoming: incoming.map((item) => ({ id: item.id, text: item.text })), at: new Date().toISOString() }; this.persist(); continue; }
          const date = dayKey();
          if ((this.watermarks.days[date] ?? 0) >= this.policy.dailyReplyLimit) { mark.status = 'budget-paused'; mark.reason = '已达到每日模型请求上限；旧消息不自动补发。'; mark.pending = { phase: 'budget', incoming: incoming.map((item) => ({ id: item.id, text: item.text })), at: new Date().toISOString() }; this.persist(); this.log('budget.reached', { recipientId: contact.id }); continue; }
          const mediaObservations=[];
          if(incoming.some(item=>item.media)) {mark.pending={phase:'observing',incoming:incoming.map(item=>({id:item.id,text:item.text,kind:item.kind,media:item.media})),at:new Date().toISOString()};this.persist();}
          for(const item of incoming.filter(item=>item.media)) {
            if(mediaObservations.reduce((count,entry)=>count+entry.frames.length,0)>=4) throw new Error('同时收到的媒体消息超过本次四张采样预算，联系人已暂停，请人工查看。');
            const observed=await this.observeMessage(contact.id,item.id,{signal});
            const remaining=4-mediaObservations.reduce((count,entry)=>count+entry.frames.length,0);
            mediaObservations.push({...observed,frames:observed.frames.slice(0,remaining)});
          }
          this.watermarks.days[date] = (this.watermarks.days[date] ?? 0) + 1;
          mark.pending = { phase: 'model', incoming: incoming.map((item) => ({ id: item.id, text: item.text })), at: new Date().toISOString() }; this.persist();
          this.log('message.received', { recipientId: contact.id, messages: incoming.map((item) => ({ id: item.id, text: item.text })) });
          const reply = await this.agent.reply({ messages: mark.context, mediaObservations, signal }); signal.throwIfAborted();
          mark.pending.generatedText = reply.text; this.persist();
          // 生成期间若用户已经回复，或对方又发消息，跳过本次发送。
          const latestSnapshot = await this.browser.readConversation(contact.id, { allowed: true, signal }); signal.throwIfAborted();
          if ((latestSnapshot.contact?.id || latestSnapshot.conversation?.id) !== contact.id) throw new Error('发送前会话身份回读不一致。');
          const latest = messagesOf(latestSnapshot);
          if (latest.some((item) => item.sender === 'unknown') || incoming.some((item) => !latest.some((current) => current.id === item.id && current.sender === 'incoming' && messageFingerprint(current)===messageFingerprint(item)))) { mark.pending.phase = 'superseded'; mark.pending.readback = latest.filter((item) => incoming.some((before) => before.id === item.id)).map((item) => ({ id: item.id, sender: item.sender, kind: item.kind, text: item.text })); throw new Error('待回复消息在生成期间被撤回、改动或方向不明，未发送。'); }
          if (latest.some((item) => !mark.seen.includes(item.id))) { mark.pending.phase = 'superseded'; mark.pending.reason = '生成期间到达新消息或人工回复，本次未发送。'; this.persist(); this.log('reply.superseded', { recipientId: contact.id }); continue; }
          await this.deliverReply(contact, mark, reply, latest, signal);
        } catch (error) {
          if (mark.status === 'inflight') { mark.status = 'delivery-uncertain'; mark.reason = '发送被中断，需要人工核对。'; }
          else { mark.status = 'paused'; mark.reason = signal.aborted ? '用户停止时有未答消息，已保留在本机，未发送。' : redact(error.message, [this.config?.apiKey]); if (signal.aborted && mark.pending) mark.pending.phase = 'stopped-before-send'; }
          this.persist(); if (!signal.aborted) this.log('contact.paused', { recipientId: contact.id, message: mark.reason });
        }
      }
    } finally { this.busy = false; if (!this.running) this.release(); }
  }
  async close() { if (this.runId) this.stop(); while (this.busy || this.starting) await new Promise((resolve) => setTimeout(resolve, 20)); await this.browser.close?.(); if(this.inspectorPromise) await this.inspectorPromise.then(inspector=>inspector.close()).catch(()=>{}); }
}
