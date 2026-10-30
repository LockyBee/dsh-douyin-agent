import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ChatAgent } from '../chat-agent.mjs';
import { ChatService } from '../chat-service.mjs';
import { OutboundCoordinator } from '../outbound-send.mjs';
import { acquireFriendInteractionDispatch, readFriendInteractionsEnabled } from '../friend-interactions-guard.mjs';
const config = { apiKey: 'fixture-chat-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
const contact = { id: `conv:${'1'.repeat(64)}`, name: '合成联系人', followed: true, isGroup: false, identityVerified: true, identityBinding: `binding:${'2'.repeat(64)}`, identityVersion: 2, identityKind: 'rendered-user', identityHash: '1'.repeat(64) };
const message = (id, text, sender = 'incoming') => ({ id, text, sender, eligibleForReply: true });
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chat-test-'));
  const messages = [message('old', '启动前的旧消息，不应回复')]; const sent = []; const inputs = [];
  const browser = { listContacts: async () => ({ contacts: [contact] }), readConversation: async (id, args) => { assert.equal(args.allowed, true); assert.equal(id, contact.id); return { conversation: { id }, contact: { ...contact }, messages: [...messages] }; }, sendMessage: async (id, text, args) => { assert.equal(args.allowed, true); sent.push({ id, text }); return { confirmed: true, messageId: `sent-${sent.length}` }; }, ...options.browser };
  const agent = { replyTokens: 512, reply: async (value) => { inputs.push(value.messages.map((item) => ({ ...item }))); return { text: '[自动回复] 合成测试回复' }; }, ...options.agent };
  const service = new ChatService({ browser, config, agent, stateDir: directory });
  t.after(async () => { await service.close(); const target = path.resolve(directory); if (!target.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('测试清理目录越界。'); fs.rmSync(target, { recursive: true, force: true }); });
  return { service, messages, sent, inputs, directory, browser, agent };
}
const prepare = async (f, limit = 40) => { await f.service.configure({ recipientIds: [contact.id], dailyReplyLimit: limit }); await f.service.start({ schedule: false }); };
const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPEkAAAAASUVORK5CYII=';

test('列表重绘未取得快照时保留水位并等待，下次可靠新消息只回复一次', async t => {
  const f = fixture(t); await prepare(f);
  const read = f.browser.readConversation, before = JSON.parse(fs.readFileSync(f.service.watermarkFile, 'utf8'));
  f.browser.readConversation = async () => { throw Object.assign(new Error('合成列表重绘'), { code: 'CHAT_SNAPSHOT_CHANGED' }); };
  f.messages.push(message('after-layout-update', '合成新消息')); await f.service.poll();
  assert.equal(f.service.state().contacts[0].status, 'ready'); assert.equal(f.sent.length, 0); assert.equal(f.inputs.length, 0);
  assert.deepEqual(f.service.watermarks.contacts[contact.id].seen, before.contacts[contact.id].seen);
  f.browser.readConversation = read; await f.service.poll(); await f.service.poll();
  assert.equal(f.sent.length, 1); assert.equal(f.inputs.length, 1);
});

test('单个许可群身份不符只暂停该群，保留全部许可和历史，已核实好友继续接收', async t => {
  const f = fixture(t), group = { id: 'conv:' + 'a'.repeat(64), name: '合成许可群', isGroup: true, followed: null, authorizationKind: 'manual', verifiedAt: new Date().toISOString() };
  let groupReads = 0;
  f.browser.listContacts = async () => ({ contacts: [contact, group] });
  const read = f.browser.readConversation;
  f.browser.readConversation = async (id, options) => { if (id === group.id) { groupReads++; throw Object.assign(new Error('合成群聊身份不一致'), { code: 'CHAT_CONVERSATION_IDENTITY_MISMATCH' }); } return read(id, options); };
  fs.writeFileSync(f.service.policyFile, JSON.stringify({ version: 1, enabled: false, allowlist: [{ ...contact, verifiedAt: new Date().toISOString() }, group] }));
  await f.service.start({ schedule: false });
  assert.equal(f.service.state().running, true); assert.equal(f.service.state().policy.allowlist.length, 2);
  assert.equal(f.service.state().contacts.find(row => row.id === group.id).identityReviewRequired, true);
  f.messages.push(message('new-while-group-paused', '合成新消息')); await f.service.poll();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].id, contact.id); assert.equal(groupReads, 1);
  f.service.stop({ preservePending: true, reason: 'maintenance' }); await f.service.start({ schedule: false });
  assert.equal(groupReads, 1, '重启和轮询不能自动解除身份暂停');
  assert.equal(f.service.state().policy.allowlist.length, 2); assert.equal(f.service.state().contacts.find(row => row.id === group.id).status, 'paused');
  f.service.stop({ preservePending: true, reason: 'maintenance' }); f.service.resumeContact(group.id);
  assert.equal(f.service.state().contacts.find(row => row.id === group.id).identityReviewRequired, undefined);
});

test('未知启动故障不冒充单个身份暂停或运行成功', async t => {
  const f = fixture(t, { browser: { readConversation: async () => { throw new Error('合成未知连接故障'); } } });
  await f.service.configure({ recipientIds: [contact.id] });
  await assert.rejects(f.service.start({ schedule: false }), /合成未知连接故障/);
  assert.equal(f.service.state().running, false);
});

test('浏览器确认尚未点击时保留零点击审计，证据不足只自动等待', async t => {
  const f = fixture(t, { browser: { sendMessage: async () => { f.sent.push({ attempted: true }); return { confirmed: false, deliveryUncertain: false, failureStage: 'trial', failureCode: 'CHAT_SEND_INPUT_UNAVAILABLE' }; } } });
  await prepare(f); f.messages.push(message('new-before-click', '合成未点击检查')); await f.service.poll();
  const row = f.service.state().contacts[0]; assert.equal(row.status, 'paused'); assert.equal(row.pending.phase, 'not-sent'); assert.match(row.reason, /未点击发送/); assert.equal(f.sent.length, 1); assert.equal(f.inputs.length, 1);
  await f.service.poll();assert.equal(f.service.state().contacts[0].status,'ready');assert.equal(f.service.state().recovery.autoPendingCount,1);assert.equal(f.sent.length,1);
});

test('新表情只截取指定消息再交模型，重复轮询不重复发送',async t=>{
  let received;
  const f=fixture(t,{browser:{captureMessage:async(id,messageId,args)=>{assert.equal(id,contact.id);assert.equal(args.allowed,true);return{messageId,media:{type:'emoji'},frames:[{mimeType:'image/png',data:pixel}],understandingScope:'single-message-image'};}},agent:{reply:async value=>{received=value;return{text:'[自动回复] 合成表情回复'};}}});
  await prepare(f);f.messages.push({...message('emoji-new',''),kind:'emoji',media:{type:'emoji',requiresVisual:true,label:null,resources:[{resourceRef:'media:fixture'}]}});
  await f.service.poll();await f.service.poll();assert.equal(f.sent.length,1);assert.equal(received.mediaObservations[0].messageId,'emoji-new');assert.equal(received.mediaObservations[0].frames.length,1);
  assert.equal(fs.readFileSync(path.join(f.directory,'chat-watermarks.json'),'utf8').includes(pixel),false);
});

test('同ID媒体在生成期间被替换，回复不会发送',async t=>{
  let f;f=fixture(t,{browser:{captureMessage:async(id,messageId)=>({messageId,frames:[{mimeType:'image/png',data:pixel}],media:{type:'emoji'}})},agent:{reply:async()=>{f.messages.at(-1).media.resources=[{resourceRef:'media:changed'}];return{text:'[自动回复] 不应发送'};}}});
  await prepare(f);f.messages.push({...message('emoji-new',''),kind:'emoji',media:{type:'emoji',resources:[{resourceRef:'media:original'}]}});await f.service.poll();assert.equal(f.sent.length,0);assert.equal(f.service.state().contacts[0].status,'paused');
});

test('私信模型接收指定表情图像，不接收其他消息的图片',async()=>{
  let body;const agent=new ChatAgent({config,fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'这是合成表情测试。'}}]}),{headers:{'content-type':'application/json'}});}});
  const messages=[{...message('emoji',''),media:{type:'emoji',label:null}}];
  await agent.reply({messages,mediaObservations:[{messageId:'emoji',media:{type:'emoji'},frames:[{mimeType:'image/png',data:pixel}]}]});
  assert.ok(body.messages.at(-1).content.some(part=>part.type==='image_url'));
  await assert.rejects(agent.reply({messages,mediaObservations:[{messageId:'other',frames:[{mimeType:'image/png',data:pixel}]}]}),/不属于/);
});

test('旧消息建立基线；只有启动后的新消息触发一次模型和一次发送，重复轮询不重发', async (t) => {
  const f = fixture(t); await prepare(f); await f.service.poll(); assert.equal(f.inputs.length, 0);
  f.messages.push(message('new', '你好，这是新消息')); await f.service.poll(); await f.service.poll();
  assert.equal(f.inputs.length, 1); assert.equal(f.sent.length, 1); assert.deepEqual(f.inputs[0].map((item) => item.text), ['你好，这是新消息']);
  assert.equal(f.service.state().daily.requests, 1);
});
test('共同发送锁忙时保留生成回复，下次发送无需再次调用模型或消费水位', async t => {
  const f = fixture(t); await prepare(f);
  f.service.outbound = new OutboundCoordinator({ stateDir: f.directory, waitMs: 20 });
  const guard = path.join(f.directory, 'outbound-send.guard'); fs.writeFileSync(guard, JSON.stringify({ pid: process.pid, token: '合成分享占用' }));
  f.messages.push(message('new', '待发送问题')); await f.service.poll();
  assert.equal(f.sent.length, 0); assert.equal(f.inputs.length, 1); assert.equal(f.service.state().contacts[0].pending.phase, 'outbound-wait');
  assert.equal(f.service.state().contacts[0].status, 'ready'); fs.unlinkSync(guard);
  await f.service.poll(); await f.service.poll(); assert.equal(f.sent.length, 1); assert.equal(f.inputs.length, 1); assert.equal(f.service.state().daily.requests, 1);
  assert.equal(f.service.outbound.history(contact.id)[0].kind, 'reply'); assert.equal(f.service.state().contacts[0].pending, null);
});
test('等共同发送锁期间本人已经回复，原生成回复不会补发', async t => {
  const f = fixture(t); await prepare(f); f.service.outbound = new OutboundCoordinator({ stateDir: f.directory, waitMs: 20 });
  const guard = path.join(f.directory, 'outbound-send.guard'); fs.writeFileSync(guard, JSON.stringify({ pid: process.pid, token: '合成分享占用' }));
  f.messages.push(message('new', '待回复问题')); await f.service.poll(); fs.unlinkSync(guard);
  f.messages.push(message('human', '本人已回复', 'outgoing')); await f.service.poll(); await f.service.poll();
  assert.equal(f.sent.length, 0); assert.equal(f.inputs.length, 1); assert.equal(f.service.state().contacts[0].pending.phase, 'handled-by-user');
  assert.equal(f.service.state().recovery.pendingManualCount, 0); assert.equal(f.service.state().contacts[0].unanswered.length, 0);
  f.service.stop({ preservePending: true, reason: 'settings-update' }); await f.service.start({ schedule: false }); await f.service.poll();
  assert.equal(f.sent.length, 0); assert.equal(f.inputs.length, 1); assert.equal(f.service.state().recovery.pendingManualCount, 0);
});
test('白名单须先核对，未核对会话和名单外只读请求均拒绝', async (t) => {
  const f = fixture(t, { browser: { listContacts: async () => ({ contacts: [{ ...contact, followed: null }] }) } });
  await assert.rejects(f.service.configure({ recipientIds: [contact.id] }), /核对/);
  await assert.rejects(f.service.configure({ recipientIds: Array.from({ length: 51 }, (_, index) => `synthetic-${index}`) }), /核对/);
  await assert.rejects(f.service.readConversation('other-person'), /白名单/);
  await assert.rejects(f.service.start({ schedule: false }), /白名单/);
});
test('用户已发出回复时不再自动回复；发出的消息不会触发模型循环', async (t) => {
  const f = fixture(t); await prepare(f);
  f.messages.push(message('incoming-new', '请问在吗'), message('human-reply', '本人已经回复', 'outgoing'));
  await f.service.poll(); assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0);
});
test('生成回复期间有人手动发送消息时取消本次自动发送', async (t) => {
  let f; f = fixture(t, { agent: { reply: async () => { f.messages.push(message('human-late', '本人已处理', 'outgoing')); return { text: '[自动回复] 不应发送' }; } } });
  await prepare(f); f.messages.push(message('new', '新问题')); await f.service.poll(); await f.service.poll(); assert.equal(f.sent.length, 0);
});
test('发送未确认后自动读回，重启和重复轮询均不盲目重发', async (t) => {
  const f = fixture(t, { browser: { sendMessage: async () => ({ confirmed: false, deliveryUncertain: true }) } });
  await prepare(f); f.messages.push(message('new', '新问题')); await f.service.poll(); await f.service.poll();
  assert.equal(f.inputs.length, 1); assert.equal(f.service.state().contacts[0].status, 'ready'); assert.ok(f.service.watermarks.contacts[contact.id].unanswered.some(item=>item.phase==='sending'||item.phase==='delivery-uncertain'));
  f.service.stop(); await f.service.start({ schedule: false }); await f.service.poll(); assert.equal(f.inputs.length,1); assert.equal(f.service.state().recovery.pendingManualCount,0); assert.ok(f.service.state().recovery.autoPendingCount>0); assert.equal(f.service.outbound.history(contact.id).length,0);
  f.service.stop(); f.service.resumeContact(contact.id); await f.service.start({ schedule: false }); await f.service.poll(); assert.equal(f.inputs.length, 1);
});
test('旧每日上限不再限制请求，超过200次后仍计数并正常回复', async (t) => {
  const f = fixture(t); await prepare(f, 1);const date=f.service.state().daily.date;
  f.service.watermarks.days[date]=200;f.service.persist();
  f.messages.push(message('new-1', '第一个问题')); await f.service.poll();
  f.messages.push(message('new-2', '第二个问题')); await f.service.poll(); assert.equal(f.inputs.length, 2); assert.equal(f.service.state().contacts[0].status, 'ready');
  assert.deepEqual(f.service.state().daily,{date,requests:202,limit:null,remaining:null});
});

test('旧policy的40次限制读取即归一无限，不修改已有计数',async t=>{
  const f=fixture(t);await f.service.configure({recipientIds:[contact.id]});
  const policy=JSON.parse(fs.readFileSync(f.service.policyFile,'utf8'));policy.dailyReplyLimit=40;fs.writeFileSync(f.service.policyFile,JSON.stringify(policy));
  assert.equal(f.service.state().policy.dailyReplyLimit,null);await f.service.start({schedule:false});
  const date=f.service.state().daily.date;f.service.watermarks.days[date]=201;f.service.persist();f.messages.push(message('after-legacy-cap','合成旧限制迁移后新消息'));await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.service.state().daily.requests,202);
});
test('好友互动总开关默认开启，关闭后停止轮询且拒绝重新启动',async t=>{
  const f=fixture(t);assert.equal(readFriendInteractionsEnabled(f.directory),true);await prepare(f);f.messages.push(message('new','合成未处理消息'));
  fs.writeFileSync(path.join(f.directory,'friend-interactions-policy.json'),JSON.stringify({version:1,enabled:false}));await f.service.poll();assert.equal(f.inputs.length,0);assert.equal(f.sent.length,0);assert.equal(f.service.state().running,false);
  await assert.rejects(f.service.start({schedule:false}),/总开关/);
});

test('生成过程中另一入口关闭总开关，最终核对不发送迟到回复',async t=>{
  let f;f=fixture(t,{agent:{reply:async()=>{fs.writeFileSync(path.join(f.directory,'friend-interactions-policy.json'),JSON.stringify({version:1,enabled:false}));return{text:'合成迟到回复'};}}});
  await prepare(f);f.messages.push(message('new','合成待回复'));await f.service.poll();assert.equal(f.sent.length,0);assert.equal(f.service.state().contacts[0].status,'paused');
});

test('总开关损坏时不启动，不把损坏内容当默认开启',async t=>{
  const f=fixture(t);await f.service.configure({recipientIds:[contact.id]});fs.writeFileSync(path.join(f.directory,'friend-interactions-policy.json'),'损坏的总开关');await assert.rejects(f.service.start({schedule:false}),/总开关记录损坏/);assert.equal(f.sent.length,0);
});

test('回复最终短输入核对总开关并持有共用guard，其他入口不能同时写关闭',async t=>{
  let f;f=fixture(t,{browser:{sendMessage:async(id,text,{authorize})=>{
    assert.equal(authorize({phase:'prepare',recipientId:id}),true);assert.equal(authorize({phase:'before-click',recipientId:id}),true);const release=authorize.beginDispatch();
    try{assert.throws(()=>acquireFriendInteractionDispatch(f.directory),error=>error.code==='FRIEND_INTERACTIONS_BUSY');assert.equal(readFriendInteractionsEnabled(f.directory),true);}finally{release();}
    f.sent.push({id,text});return{confirmed:true,messageId:'synthetic-final-confirmed'};
  }}});await prepare(f);f.messages.push(message('new','合成最终许可'));await f.service.poll();assert.equal(f.sent.length,1);assert.equal(fs.existsSync(path.join(f.directory,'friend-interactions-control.guard')),false);
});

test('暂停能中断模型请求，不进入发送', async (t) => {
  let started; const startedPromise = new Promise((resolve) => { started = resolve; });
  const f = fixture(t, { agent: { reply: ({ signal }) => new Promise((_resolve, reject) => { started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) } });
  await prepare(f); f.messages.push(message('new', '新消息')); const polling = f.service.poll(); await startedPromise; f.service.stop(); await polling; assert.equal(f.sent.length, 0); assert.equal(fs.existsSync(path.join(f.directory, 'chat-loop.lock')), false);
});
test('只有方向未知的新消息也会暂停，保留待核对内容且不提前消费水位', async (t) => {
  const f = fixture(t); await prepare(f); f.messages.push(message('unknown-new', '方向待核对', 'unknown')); await f.service.poll();
  assert.equal(f.inputs.length, 0); assert.equal(f.service.state().contacts[0].status, 'paused');
  const stored = JSON.parse(fs.readFileSync(path.join(f.directory, 'chat-watermarks.json'), 'utf8')).contacts[contact.id];
  assert.equal(stored.seen.includes('unknown-new'), false); assert.equal(stored.pending.phase, 'unclassified');
});
test('适配器明确标成未支持的附件只记录跳过，不调用模型或假装已理解', async (t) => {
  const f = fixture(t); await prepare(f); f.messages.push({ ...message('picture-new', '[图片]'), kind: 'image', unsupported: true }); await f.service.poll();
  assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0); assert.equal(f.service.state().contacts[0].status, 'ready');
  assert.ok(f.service.state().events.some((item) => item.type === 'message.unsupported'));
});
test('模型调用失败保留待回复内容并暂停，不在下一次轮询盲目重试', async (t) => {
  const f = fixture(t, { agent: { reply: async () => { throw new Error('合成模型失败'); } } }); await prepare(f); f.messages.push(message('new-failed', '不能丢失的待核对消息')); await f.service.poll();
  const state = f.service.state(); assert.equal(state.contacts[0].status, 'paused'); assert.equal(state.contacts[0].pending.incoming[0].text, '不能丢失的待核对消息'); assert.equal(state.daily.requests, 1);
  await f.service.poll(); assert.equal(f.service.state().daily.requests, 1); assert.equal(f.sent.length, 0);
});
test('DOM tracker 没有确认新到达资格的消息会暂停，不发给模型', async (t) => {
  const f = fixture(t); await prepare(f); f.messages.push({ ...message('old-dom-row', '滚动加载的旧行'), eligibleForReply: false }); await f.service.poll();
  assert.equal(f.inputs.length, 0); assert.equal(f.service.state().contacts[0].status, 'paused'); assert.equal(f.service.state().contacts[0].pending.phase, 'unqualified');
});
test('旧窗口与历史分类只更新水位，不暂停、不进入后续新私信上下文', async (t) => {
  const f = fixture(t); await prepare(f);
  f.messages.push({ ...message('old-window', '相对时间变化的旧行'), arrivalClassification: 'known-old-window', eligibleForReply: false }, { ...message('old-history', '滚动加载的历史', 'unknown'), arrivalClassification: 'old-history', eligibleForReply: false });
  await f.service.poll(); assert.equal(f.service.state().contacts[0].status, 'ready'); assert.equal(f.inputs.length, 0);
  f.messages.push({ ...message('actual-new', '真正的新消息'), arrivalClassification: 'new-tail' }); await f.service.poll();
  assert.equal(f.inputs.length, 1); assert.deepEqual(f.inputs[0].map((item) => item.text), ['真正的新消息']);
});
test('跨进程仅一个回复 worker；另一个入口可按当前 runId 请求停止，旧请求不影响新一轮', async (t) => {
  const f = fixture(t); await f.service.configure({ recipientIds: [contact.id] });
  const moduleUrl = new URL('../chat-service.mjs', import.meta.url).href;
  const script = `import { ChatService } from ${JSON.stringify(moduleUrl)}; const contact=${JSON.stringify(contact)};const service=new ChatService({config:${JSON.stringify(config)},stateDir:${JSON.stringify(f.directory)},agent:{replyTokens:512,reply:async()=>({text:'合成回复'})},browser:{listContacts:async()=>({contacts:[contact]}),readConversation:async(id)=>({conversation:{id},contact:{...contact},messages:[]}),sendMessage:async()=>({confirmed:true})}});await service.start({schedule:false});process.send({ready:true});process.on('message',async()=>{await service.close();process.exit(0)});`;
  const child = spawn(process.execPath, ['--input-type=module','-e',script], { stdio: ['ignore','ignore','pipe','ipc'], windowsHide: true });
  t.after(async () => { if (child.exitCode === null) { const ended = once(child, 'exit'); child.send('退出'); await ended; } });
  const [ready] = await once(child, 'message'); assert.equal(ready.ready, true);
  assert.equal(f.service.state().worker.pid, child.pid); assert.equal(f.service.state().running, true);
  await assert.rejects(f.service.start({ schedule: false }), /另一个入口/);
  assert.equal(f.service.stop().stopping, true);
  const deadline = Date.now() + 5000; while (f.service.state().worker && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.service.state().worker, null);
  await f.service.start({ schedule: false }); await new Promise((resolve) => setTimeout(resolve, 1100)); assert.equal(f.service.state().running, true);
});
test('私信模型请求格式只含本会话消息，关闭工具与推理；拒绝截断或现实承诺', async () => {
  const requests = [];
  const agent = new ChatAgent({ config, fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '你好，收到你的消息了。' } }] })); } });
  assert.equal((await agent.reply({ messages: [message('one', '你好')] })).text, '你好，收到你的消息了。');
  assert.equal(requests[0].max_tokens, 512); assert.equal(requests[0].thinking.type, 'disabled'); assert.equal(requests[0].tools, undefined); assert.equal(JSON.stringify(requests[0]).includes(config.apiKey), false);
  for (const value of [{ finish_reason: 'length', message: { content: '截断' } }, { message: { content: '未给结束状态' } }, { finish_reason: 'stop', message: { content: '我会帮你转账。' } }]) {
    const bad = new ChatAgent({ config, fetchImpl: async () => new Response(JSON.stringify({ choices: [value] })) }); await assert.rejects(bad.reply({ messages: [message('one', '你好')] }));
  }
});
test('生成期间原私信被撤回或同 ID 正文改变时不发送', async (t) => {
  for (const change of ['撤回', '改正文']) { let f; f = fixture(t, { agent: { reply: async () => { if (change === '撤回') f.messages.pop(); else f.messages.at(-1).text = '修改后的正文'; return { text: '[自动回复] 不应发送' }; } } }); await prepare(f); f.messages.push(message('changed', '原始正文')); await f.service.poll(); assert.equal(f.sent.length, 0); assert.equal(f.service.state().contacts[0].status, 'paused'); }
});
test('重新启动保留模型失败的待答记录，明确设为基线跳过且不自动补发', async (t) => {
  const f = fixture(t, { agent: { reply: async () => { throw new Error('合成模型失败'); } } }); await prepare(f); f.messages.push(message('failed', '需要人工处理')); await f.service.poll(); f.service.stop(); await f.service.start({ schedule: false }); await f.service.poll();
  assert.equal(f.service.state().contacts[0].unanswered[0].incoming[0].text, '需要人工处理'); assert.equal(f.service.state().daily.requests, 1); assert.ok(f.service.state().events.some((item) => item.type === 'baseline.skipped_pending'));
});
test('配置回读等待期间另一个入口启动时不能覆盖正在运行的白名单', async (t) => {
  const f = fixture(t); await f.service.configure({ recipientIds: [contact.id] }); let release;
  const waiting = new Promise((resolve) => { release = resolve; }); const other = new ChatService({ config, agent: f.agent, stateDir: f.directory, browser: { ...f.browser, listContacts: async () => waiting } });
  const replacement = { ...contact, id: `conv:${'3'.repeat(64)}`, identityHash: '3'.repeat(64), identityBinding: `binding:${'4'.repeat(64)}` };
  t.after(() => other.close()); const changing = other.configure({ recipientIds: [replacement.id] }); await f.service.start({ schedule: false }); release({ contacts: [replacement] }); await assert.rejects(changing, /另一个入口/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'chat-policy.json'), 'utf8')).allowlist[0].id, contact.id);
});
test('启动基线接受外部停止信号，完成后回复服务不绑定普通任务信号', async (t) => {
  let calls = 0; const f = fixture(t, { browser: { listContacts: async ({ signal }) => { if (++calls === 1) return { contacts: [contact] }; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } } });
  await f.service.configure({ recipientIds: [contact.id] }); const abort = new AbortController(); const starting = f.service.start({ signal: abort.signal, schedule: false }); setTimeout(() => abort.abort(new Error('合成启动停止')), 5); await assert.rejects(starting, /停止/); assert.equal(fs.existsSync(path.join(f.directory, 'chat-loop.lock')), false);
  const g = fixture(t); await g.service.configure({ recipientIds: [contact.id] }); const completed = new AbortController(); await g.service.start({ signal: completed.signal, schedule: false }); completed.abort(new Error('普通任务已结束')); assert.equal(g.service.state().running, true);
});
test('两个真实 Node 入口同时恢复死 worker 时仅一个取得新锁，后来的入口不删除新 owner', async (t) => {
  const f = fixture(t); await f.service.configure({ recipientIds: [contact.id] });
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true, stdio: 'ignore' }); await once(dead, 'exit');
  assert.throws(() => process.kill(dead.pid, 0));
  const moduleUrl = new URL('../chat-service.mjs', import.meta.url).href;
  const script = `import {ChatService} from ${JSON.stringify(moduleUrl)};const contact=${JSON.stringify(contact)};const service=new ChatService({config:${JSON.stringify(config)},stateDir:${JSON.stringify(f.directory)},agent:{replyTokens:512,reply:async()=>({text:'合成回复'})},browser:{listContacts:async()=>({contacts:[contact]}),readConversation:async(id)=>({conversation:{id},contact:{...contact},messages:[]}),sendMessage:async()=>{throw new Error('本测试禁止发送')}}});process.on('message',async command=>{if(command==='start'){try{await service.start({schedule:false});process.send({ok:true,pid:process.pid,runId:service.runId})}catch(error){process.send({ok:false,message:error.message})}}else{await service.close();process.exit(0)}});process.send({ready:true});`;
  for (let round = 0; round < 4; round++) {
    fs.writeFileSync(path.join(f.directory, 'chat-loop.lock'), JSON.stringify({ pid: dead.pid, runId: `dead-fixture-${round}`, heartbeatAt: '2000-01-01T00:00:00Z', status: 'running' }));
    const children = Array.from({ length: 2 }, () => spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore','ignore','pipe','ipc'] }));
    try {
      await Promise.all(children.map((child) => once(child, 'message')));
      const responses = children.map((child) => once(child, 'message')); children.forEach((child) => child.send('start'));
      const results = (await Promise.all(responses)).map(([result]) => result);
      assert.equal(results.filter((item) => item.ok).length, 1);
      const winner = results.find((item) => item.ok); const stored = JSON.parse(fs.readFileSync(path.join(f.directory, 'chat-loop.lock'), 'utf8'));
      assert.equal(stored.pid, winner.pid); assert.equal(stored.runId, winner.runId);
      await new Promise((resolve) => setTimeout(resolve, 40)); assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'chat-loop.lock'), 'utf8')).runId, winner.runId);
    } finally { await Promise.all(children.map(async (child) => { if (child.exitCode === null) { const ended = once(child, 'exit'); child.send('exit'); await ended; } })); }
    assert.equal(fs.existsSync(path.join(f.directory, 'chat-loop.lock')), false);
    assert.equal(fs.existsSync(path.join(f.directory, 'chat-control.guard')), false);
  }
});
test('坏的或死进程控制 guard 不被自动清理，保持拒绝启动和原有白名单', async (t) => {
  const f = fixture(t); await f.service.configure({ recipientIds: [contact.id] }); const file = path.join(f.directory, 'chat-control.guard');
  for (const content of ['损坏的控制锁', JSON.stringify({ pid: 0, token: 'dead-fixture-token' })]) { fs.writeFileSync(file, content); await assert.rejects(f.service.start({ schedule: false }), /控制锁/); assert.equal(fs.readFileSync(file, 'utf8'), content); assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'chat-policy.json'), 'utf8')).allowlist[0].id, contact.id); fs.unlinkSync(file); }
});
test('heartbeat 发现 worker 所有权变化后停掉旧入口，不覆盖或停止新 owner', async (t) => {
  const f = fixture(t); await prepare(f); const replacement = { pid: process.pid, runId: 'synthetic-replacement', heartbeatAt: new Date().toISOString(), status: 'running' };
  fs.writeFileSync(path.join(f.directory, 'chat-loop.lock'), JSON.stringify(replacement)); await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(f.service.running, false); assert.equal(f.service.ownershipLost, true); assert.equal(f.service.runId, null); assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory, 'chat-loop.lock'), 'utf8')).runId, replacement.runId); assert.equal(fs.existsSync(path.join(f.directory, 'chat-stop.request.json')), false);
});
test('poll 与发送前检查所有权，锁被替换后不发消息也不覆盖新入口水位', async (t) => {
  const f = fixture(t); await prepare(f); f.messages.push(message('new-ownership', '合成新消息')); const replacement = { pid: process.pid, runId: 'synthetic-replacement', heartbeatAt: new Date().toISOString(), status: 'running' };
  fs.writeFileSync(path.join(f.directory, 'chat-loop.lock'), JSON.stringify(replacement)); await assert.rejects(f.service.poll(), /失去/); assert.equal(f.inputs.length, 0); assert.equal(f.sent.length, 0);
  const g = fixture(t); await prepare(g); g.messages.push(message('new-before-send', '合成新消息')); const originalRead = g.browser.readConversation; let reads = 0;
  g.browser.readConversation = async (...args) => { const result = await originalRead(...args); if (++reads === 2) fs.writeFileSync(path.join(g.directory, 'chat-loop.lock'), JSON.stringify(replacement)); return result; };
  await assert.rejects(g.service.poll(), /失去/); assert.equal(g.inputs.length, 1); assert.equal(g.sent.length, 0); assert.equal(JSON.parse(fs.readFileSync(path.join(g.directory, 'chat-loop.lock'), 'utf8')).runId, replacement.runId);
});

test('分享卡片没有可核对画面时跳过观察，不暂停联系人', async t => {
  const f = fixture(t); await prepare(f);
  f.messages.push({ ...message('shared-without-frame', '', 'incoming'), media: { type: 'shared-work', author: '陌生人', imageCount: 0, resources: [], requiresVisual: true } });
  await f.service.poll();
  assert.equal(f.service.state().contacts[0].status, 'ready');
  assert.equal(f.inputs.length, 1); assert.equal(f.sent.length, 1);
});

test('人工勾选后未取得稳定身份的群聊可保存为manual', async t => {
  const manual = { id: `conv:${'5'.repeat(64)}`, name: '合成人工群', isGroup: true, followed: null, identityVerified: false, identityBinding: null, conversationType: 'group' };
  const f = fixture(t, { browser: { listContacts: async () => ({ contacts: [manual] }) } });
  await f.service.configure({ recipientIds: [manual.id], allowConversationOnly: true });
  const saved = f.service.state().policy.allowlist[0];
  assert.equal(saved.authorizationKind, 'manual'); assert.equal(saved.isGroup, true);
});

test('生成期间到达新消息时，被替代的旧消息与新消息一起重答', async t => {
  const calls = []; let f, first = true;
  f = fixture(t, { agent: { reply: async value => { calls.push(value.messages.map(item => ({ ...item }))); if (first) { first = false; f.messages.push(message('late-new', '生成期间的新问题')); } return { text: '[自动回复] 合成重答' }; } } });
  await prepare(f); f.messages.push(message('first-question', '第一个问题'));
  await f.service.poll();
  assert.equal(f.sent.length, 0);
  await f.service.poll();
  assert.equal(calls.length, 2); assert.equal(f.sent.length, 1);
  assert.deepEqual(calls.at(-1).map(item => item.text), ['第一个问题', '生成期间的新问题']);
});
