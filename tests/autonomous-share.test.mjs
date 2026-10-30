import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AutonomousShare } from '../autonomous-share.mjs';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';
import { acquireFriendInteractionDispatch, readFriendInteractionsEnabled } from '../friend-interactions-guard.mjs';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const nativeFriend = 'synthetic-person-1', nativeOther = 'synthetic-person-2';
const stableContact = nativeId => ({ id: `conv:${hash(`native:${nativeId}`)}`, nativeId, isGroup: false, identityVersion: 2, identityVerified: true, identityKind: 'native-conversation', identityHash: hash(`native:${nativeId}`), identityBinding: `binding:${hash(`direct\0native:${nativeId}`)}` });
const friend = stableContact(nativeFriend).id, other = stableContact(nativeOther).id;
const stateFor = (videoId = '12345') => ({ url: `https://www.douyin.com/video/${videoId}`, loginRequired: false, verificationRequired: false, privateChatVisible: false, video: { id: videoId, url: `https://www.douyin.com/video/${videoId}`, title: '合成作品', author: '合成作者', time: 3, duration: 60, paused: false, readyState: 4 } });
const receipt = videoId => ({ confirmed: true, deliveryUncertain: false, deliveryType: 'native-card', videoId, operationId: 'synthetic-forward-receipt', messageId: 'synthetic-card-message' });
const preflightError = (input, code = 'CHAT_PAGE_NOT_OPEN', stage = 'contact-identity') => Object.assign(new Error('合成后台消息页暂不可用，未发送'), {
  code, forwardOperationId: 'synthetic-preflight-forward', failure: { code, stage, message: '合成后台消息页暂不可用，未发送' },
  preflight: { protocol: 'share-preflight-v1', outcome: 'not-sent', forwardOperationId: 'synthetic-preflight-forward', recipientId: input.recipientId, videoId: input.expectedVideoId, sendClicks: 0, dispatchAuthorized: false, failureCode: code, failureStage: stage },
});

test('其他回复占用共同发送锁时转发器未进入发送事务，正式零点击证明让观看可跳过',async t=>{
  const f=fixture(t);f.service.configure({enabled:true},{explicit:true});
  const {VideoForwarder}=await import('../video-forward.mjs');
  let entered=0;
  const forwarder=new VideoForwarder({stateDir:f.stateDir,videoLimits:f.videoLimits,controller:{source:'api',withPage:async()=>{entered++;throw new Error('不应进入作品页');}},chatBrowser:{listContacts:async()=>{entered++;throw new Error('不应读取联系人');}}});
  forwarder.outbound.waitMs=0;const release=await forwarder.outbound.acquire();
  try{
    f.service.send=undefined;f.service.getForwarder=async()=>forwarder;
    const result=await f.service.share(f.evidence());assert.equal(result.code,'SHARE_PREFLIGHT_NOT_SENT');assert.equal(result.failure.code,'OUTBOUND_BUSY');assert.equal(result.preflight.failureStage,'outbound-wait');assert.equal(result.preflight.sendClicks,0);assert.equal(result.preflight.dispatchAuthorized,false);assert.equal(entered,0);assert.equal(f.service.state().paused,false);assert.equal(f.service.ledger().operations[0].status,'not-sent');
  }finally{release();}
});

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-auto-share-')), stateDir = path.join(root, 'state');
  let now = Date.parse('2026-10-15T04:00:00Z');
  const clock = () => now;
  const personaMemory = new PersonaMemory({ memoryDir: path.join(root, 'memory'), legacyRoleCardFile: path.join(root, 'absent-role.md'), clock }); personaMemory.initialize();
  const videoLimits = new VideoLimits({ stateDir, now: clock });
  videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 60 }, { explicit: true }); videoLimits.markSession('api', { explicit: true });
  const contacts = [nativeFriend, nativeOther].map((nativeId, index) => ({ ...stableContact(nativeId), name: `合成好友${index + 1}`, followed: true, verifiedAt: '2026-10-15T01:00:00Z' }));
  fs.writeFileSync(path.join(stateDir, 'chat-policy.json'), JSON.stringify({ version: 1, enabled: false, allowlist: contacts }));
  const calls = [];
  const send = options.send || (async (input, controls) => { calls.push({ input, controls }); assert.deepEqual(Object.keys(input).sort(), ['expectedVideoId', 'recipientId']); controls.authorize({ phase: 'prepare', recipientId: input.recipientId, videoId: input.expectedVideoId }); controls.authorize({ phase: 'before-click', recipientId: input.recipientId, videoId: input.expectedVideoId }); return receipt(input.expectedVideoId); });
  const service = new AutonomousShare({ personaMemory, videoLimits, send, stateDir, now: clock });
  const evidence = (videoId = '12345') => ({ evidenceId: personaMemory.recordObservation(stateFor(videoId), { source: 'api' }).evidenceId, videoId, recipientId: friend, reason: '合成选择理由，只存本机。' });
  t.after(async () => { await service.close(); const target = path.resolve(root); assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(target, { recursive: true, force: true }); });
  return { root, stateDir, personaMemory, videoLimits, service, evidence, calls, contacts, clock, setNow: value => { now = value; } };
}

test('自主分享默认关闭，模型不能改策略，只显示当前已核对的许可会话', async t => {
  const f = fixture(t), input = f.evidence();
  assert.equal(f.service.state().enabled, false); assert.equal(f.service.state().dailyLimit, null);assert.equal(f.service.state().daily.remaining,null);
  assert.equal(f.service.context().enabled, false); assert.equal(f.service.context().recipients.length, 2);
  assert.throws(() => f.service.configure({ enabled: true }), /用户/);
  for (const body of [{ enabled: true, recipientId: friend }, { enabled: 'true' }]) assert.throws(() => f.service.configure(body, { explicit: true }));
  await assert.rejects(f.service.share(input), /尚未启用/); assert.equal(f.calls.length, 0);
  f.service.configure({ enabled: true }, { explicit: true });
  assert.deepEqual(f.service.context().recipients, f.contacts.map(({ id, name, isGroup }) => ({ id, name, isGroup })));
  assert.equal(fs.existsSync(path.join(f.stateDir, 'share-ledger.json')), false);
});

test('仅精确的零点击后台缺页或前台回执可恢复为 not-sent，保留原因且同片不重试', async t => {
  for (const code of ['CHAT_PAGE_NOT_OPEN', 'CHAT_FOREGROUND']) for (const stage of ['contact-identity', 'conversation-baseline']) {
    let calls = 0;
    const f = fixture(t, { send: async (input, controls) => { calls++; controls.authorize({ phase: 'prepare', recipientId: input.recipientId, videoId: input.expectedVideoId }); throw preflightError(input, code, stage); } });
    f.service.configure({ enabled: true }, { explicit: true }); const input = f.evidence(), result = await f.service.share(input);
    assert.equal(result.status, 'not-sent'); assert.equal(result.code, 'SHARE_PREFLIGHT_NOT_SENT'); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(result.preflight.sendClicks, 0);
    const record = f.service.ledger().operations.at(-1); assert.equal(record.status, 'not-sent'); assert.equal(record.failure.code, code); assert.equal(record.failure.stage, stage); assert.deepEqual(record.preflight, result.preflight);
    assert.equal(f.service.state().paused, false); assert.equal((await f.service.share(input)).code, 'SHARE_ALREADY_PROCESSED'); assert.equal(calls, 1);
  }
});

test('未知、身份、缺证明和撤权取消不能伪装成可恢复缺页，点击后的同码仍 uncertain', async t => {
  for (const mode of ['unknown', 'identity', 'missing-proof', 'clicked', 'wrong-video', 'wrong-recipient', 'wrong-stage', 'one-click', 'dispatch', 'receipt-failed', 'uncertain-claim', 'confirmed-claim', 'disabled', 'closed', 'cancelled']) {
    const abort = new AbortController(); let f, sends = 0;
    f = fixture(t, { send: async (input, controls) => {
      controls.authorize({ phase: 'prepare', recipientId: input.recipientId, videoId: input.expectedVideoId });
      if (mode === 'clicked') { controls.authorize({ phase: 'before-click', recipientId: input.recipientId, videoId: input.expectedVideoId }); sends++; }
      const error = preflightError(input, mode === 'unknown' ? 'SYNTHETIC_UNKNOWN' : mode === 'identity' ? 'CHAT_CONVERSATION_IDENTITY_MISMATCH' : 'CHAT_PAGE_NOT_OPEN');
      if (mode === 'missing-proof') delete error.preflight;
      if (mode === 'wrong-video') error.preflight.videoId = '99999'; if (mode === 'wrong-recipient') error.preflight.recipientId = other;
      if (mode === 'wrong-stage') { error.failure.stage = 'receipt'; error.preflight.failureStage = 'receipt'; }
      if (mode === 'one-click') error.preflight.sendClicks = 1; if (mode === 'dispatch') error.preflight.dispatchAuthorized = true;
      if (mode === 'receipt-failed') error.receiptWarning = '合成诊断收据保存失败';
      if (mode === 'uncertain-claim') error.deliveryUncertain = true; if (mode === 'confirmed-claim') error.confirmed = true;
      if (mode === 'disabled') f.service.configure({ enabled: false }, { explicit: true });
      if (mode === 'closed') { f.service.closed = true; }
      if (mode === 'cancelled') abort.abort(new Error('合成用户取消'));
      throw error;
    } });
    f.service.configure({ enabled: true }, { explicit: true });
    if (mode === 'clicked') { const result = await f.service.share(f.evidence(), { signal: abort.signal }); assert.equal(result.deliveryUncertain, true); assert.equal(f.service.state().paused, true); assert.equal(result.preflight, undefined); }
    else { await assert.rejects(f.service.share(f.evidence(), { signal: abort.signal })); assert.equal(sends, 0, mode); }
    assert.equal(f.service.ledger().operations.length, 1); assert.equal(f.service.ledger().operations[0].status, mode === 'clicked' ? 'uncertain' : 'not-sent');
  }
});

test('稳定个人与人工群混合时只把稳定个人交给分享模型，人工群保留并说明暂不能分享', async t => {
  const f = fixture(t), manual = { id: `conv:${'c'.repeat(64)}`, name: '合成人工群', isGroup: true, identityVerified: false, authorizationKind: 'manual', verifiedAt: '2026-10-15T01:00:00Z', relationshipStatus: 'unavailable' };
  fs.writeFileSync(path.join(f.stateDir, 'chat-policy.json'), JSON.stringify({ version: 1, enabled: false, allowlist: [{ ...f.contacts[0], verifiedAt: '2026-10-15T01:00:00Z' }, manual] }));
  f.service.configure({ enabled: true }, { explicit: true });
  const context = f.service.context(); assert.deepEqual(context.recipients.map(item => item.id), [f.contacts[0].id]);
  assert.equal(context.unavailableRecipients.length, 1); assert.match(context.unavailableRecipients[0].reason, /稳定会话身份/);
  assert.equal(f.service.state().unavailableRecipients.length, 1);
  await assert.rejects(f.service.share({ ...f.evidence(), recipientId: manual.id }), error => error.status === 403 && /稳定身份/.test(error.message));
  assert.equal(f.calls.length, 0);
});

test('全是人工且缺少稳定身份时保留分享意愿，但不生成候选也不阻断状态', async t => {
  const f = fixture(t), manual = { id: `conv:${'d'.repeat(64)}`, name: '合成人工群', isGroup: true, identityVerified: false, authorizationKind: 'manual', verifiedAt: '2026-10-15T01:00:00Z', relationshipStatus: 'unavailable' };
  fs.writeFileSync(path.join(f.stateDir, 'chat-policy.json'), JSON.stringify({ version: 1, enabled: false, allowlist: [manual] }));
  f.service.configure({ enabled: true }, { explicit: true });
  const state = f.service.state(), context = f.service.context();
  assert.equal(state.enabled, true); assert.equal(state.paused, false); assert.equal(state.recipients.length, 1);
  assert.deepEqual(context.recipients, []); assert.equal(context.enabled, false); assert.equal(context.paused, false);
  assert.equal(context.unavailableRecipients.length, 1);
});

test('观察证据、同一作品及现有白名单是发送前提，不接受任意链接或正文', async t => {
  const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true }, { explicit: true });
  for (const changed of [{ ...input, videoId: '999' }, { ...input, evidenceId: `video:${'0'.repeat(64)}` }, { ...input, recipientId: `conv:${'c'.repeat(64)}` }, { ...input, url: 'https://www.douyin.com/video/999' }, { ...input, text: '不能附带正文' }]) await assert.rejects(f.service.share(changed));
  assert.equal(f.calls.length, 0); assert.equal(f.service.state().daily.attempts, 0);
  const record = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'chat-policy.json'))); record.allowlist.push({ ...record.allowlist[0] }); fs.writeFileSync(path.join(f.stateDir, 'chat-policy.json'), JSON.stringify(record));
  await assert.rejects(f.service.share(input), /许可名单/); assert.equal(f.calls.length, 0);
});

test('启用后无需逐次确认即可发送作品卡片，跨入口持续计数并按好友与作品去重', async t => {
  const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true, dailyLimit: 2 }, { explicit: true });
  const sessionsBefore = fs.readFileSync(f.videoLimits.sessionsFile, 'utf8');
  const sent = await f.service.share(input); assert.equal(sent.confirmed, true); assert.equal(sent.messageId, 'synthetic-card-message'); assert.ok(sent.operationId); assert.equal(f.calls[0].controls.humanAuthorized, undefined);
  assert.equal(JSON.stringify(f.calls[0].input).includes(input.reason), false);
  const beforeDuplicate = fs.readFileSync(f.service.files.ledger, 'utf8'); const skipped = await f.service.share(input); assert.equal(skipped.code, 'SHARE_ALREADY_PROCESSED'); assert.equal(skipped.skipped, true); assert.equal(skipped.confirmed, false); assert.equal(skipped.deliveryUncertain, false); assert.equal(skipped.operationId, undefined); assert.equal(fs.readFileSync(f.service.files.ledger, 'utf8'), beforeDuplicate); assert.equal(f.calls.length, 1);
  const second = new AutonomousShare({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, send: async () => { throw new Error('不应进入第三次发送'); }, stateDir: f.stateDir, now: f.clock });
  assert.equal(second.state().daily.attempts, 1); await second.close();
  await f.service.share({ ...input, recipientId: other }); assert.equal(f.service.state().daily.remaining, null);
  assert.equal((await f.service.share(f.evidence('67890'))).confirmed,true); assert.equal(f.calls.length, 3);
  f.service.configure({ enabled: false }, { explicit: true }); f.service.configure({ enabled: true }, { explicit: true }); assert.equal(f.service.state().daily.attempts, 3);
  assert.equal(fs.readFileSync(f.videoLimits.sessionsFile, 'utf8'), sessionsBefore);
});

test('旧分享上限读取即归一无限，超过20次仍核对许可、观察证据和一次发送',async t=>{
  const f=fixture(t);fs.writeFileSync(f.service.files.policy,JSON.stringify({version:1,enabled:true,dailyLimit:3}));
  assert.equal(f.service.policy().dailyLimit,null);assert.equal(f.service.context().dailyRemaining,null);assert.equal(f.service.context().enabled,true);
  for(let i=0;i<25;i++)assert.equal((await f.service.share(f.evidence(String(30000+i)))).confirmed,true);
  assert.equal(f.calls.length,25);assert.equal(f.service.state().daily.attempts,25);assert.equal(f.service.state().daily.limit,null);assert.equal(f.service.state().daily.remaining,null);
  f.service.configure({enabled:false,dailyLimit:0},{explicit:true});f.service.configure({enabled:true,dailyLimit:1},{explicit:true});assert.equal(f.service.state().daily.attempts,25);
  assert.equal((await f.service.share(f.evidence('40000'))).confirmed,true);assert.equal(f.calls.length,26);
  assert.equal((await f.service.share(f.evidence('40000'))).code,'SHARE_ALREADY_PROCESSED');assert.equal(f.calls.length,26);
});

test('只有确定终态的同片同人处理记录返回typed跳过，账本、次数和发送均不改变', async t => {
  for (const status of ['confirmed', 'not-sent', 'resolved-confirmed', 'resolved-not-sent']) {
    const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true }, { explicit: true }); await f.service.share(input);
    const ledger = f.service.ledger(); ledger.operations[0].status = status; fs.writeFileSync(f.service.files.ledger, JSON.stringify(ledger)); const before = fs.readFileSync(f.service.files.ledger, 'utf8');
    const result = await f.service.share(input); assert.deepEqual({ status: result.status, code: result.code, skipped: result.skipped, confirmed: result.confirmed, deliveryUncertain: result.deliveryUncertain, videoId: result.videoId, recipientId: result.recipientId, previousStatus: result.previousStatus }, { status: 'skipped', code: 'SHARE_ALREADY_PROCESSED', skipped: true, confirmed: false, deliveryUncertain: false, videoId: input.videoId, recipientId: input.recipientId, previousStatus: status });
    assert.equal(result.operationId, undefined); assert.equal(result.messageId, undefined); assert.equal(fs.readFileSync(f.service.files.ledger, 'utf8'), before); assert.equal(f.service.state().daily.attempts, 1); assert.equal(f.calls.length, 1); assert.equal(f.service.state().busy, false);
  }
});

test('已处理作品仍先核对许可、证据、时段及未知收据，失败不能伪装成正常去重', async t => {
  for (const mutation of ['disabled', 'master-off', 'allowlist', 'evidence', 'ended', 'unresolved']) {
    const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true }, { explicit: true }); await f.service.share(input);
    if (mutation === 'disabled') f.service.configure({ enabled: false }, { explicit: true });
    if (mutation === 'master-off') fs.writeFileSync(path.join(f.stateDir, 'friend-interactions-policy.json'), JSON.stringify({ version: 1, enabled: false }));
    if (mutation === 'allowlist') fs.writeFileSync(path.join(f.stateDir, 'chat-policy.json'), JSON.stringify({ version: 1, allowlist: [] }));
    if (mutation === 'evidence') f.personaMemory.snapshot = () => ({ recentObservations: [] });
    if (mutation === 'ended') f.videoLimits.endSession({ explicit: true });
    if (mutation === 'unresolved') { const ledger = f.service.ledger(); ledger.operations.push({ ...ledger.operations[0], operationId: 'synthetic-unresolved-other', videoId: '67890', status: 'uncertain' }); ledger.days[ledger.operations[0].day]++; fs.writeFileSync(f.service.files.ledger, JSON.stringify(ledger)); }
    const before = fs.readFileSync(f.service.files.ledger, 'utf8'); await assert.rejects(f.service.share(input)); assert.equal(fs.readFileSync(f.service.files.ledger, 'utf8'), before); assert.equal(f.calls.length, 1);
  }
  for (const status of ['reserved', 'clicking', 'uncertain']) {
    const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true }, { explicit: true }); await f.service.share(input); const ledger = f.service.ledger(); ledger.operations[0].status = status; fs.writeFileSync(f.service.files.ledger, JSON.stringify(ledger));
    await assert.rejects(f.service.share(input), /未确认/); assert.equal(f.calls.length, 1); assert.equal(f.service.state().paused, true);
  }
});

test('模型去重摘要仅包含当前作品且仍获许可的收件人终态，不带理由或历史正文', async t => {
  const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true }, { explicit: true }); await f.service.share(input); await f.service.share({ ...input, recipientId: other }); await f.service.share(f.evidence('67890'));
  const ledger = f.service.ledger(); ledger.operations[0].reason = 'PRIVATE_LOCAL_REASON'; ledger.operations[0].messageId = 'PRIVATE_OLD_MESSAGE'; fs.writeFileSync(f.service.files.ledger, JSON.stringify(ledger));
  fs.writeFileSync(path.join(f.stateDir, 'chat-policy.json'), JSON.stringify({ version: 1, allowlist: [f.contacts[0]] }));
  const context = f.service.context({ videoId: input.videoId }); assert.deepEqual(context.processedRecipients, [{ recipientId: friend, status: 'confirmed' }]); assert.equal(context.recipients.length, 1); assert.doesNotMatch(JSON.stringify(context), /PRIVATE_LOCAL_REASON|PRIVATE_OLD_MESSAGE|67890/); assert.deepEqual(f.service.context().processedRecipients, []);
});

test('分享支持超过50个已核对会话，不放宽重复或失去身份的名单',async t=>{
  const f=fixture(t),allowlist=Array.from({length:251},(_,i)=>({...stableContact(`bulk-${i}`),name:`合成更多许可会话${i}`,followed:true,verifiedAt:'2026-10-15T01:00:00Z'}));
  fs.writeFileSync(path.join(f.stateDir,'chat-policy.json'),JSON.stringify({version:1,allowlist}));assert.equal(f.service.recipients().length,251);f.service.configure({enabled:true},{explicit:true});assert.equal(f.service.context().recipients.length,251);
  allowlist[250].followed=false;fs.writeFileSync(path.join(f.stateDir,'chat-policy.json'),JSON.stringify({version:1,allowlist}));assert.throws(()=>f.service.recipients(),/许可名单/);
});

test('好友互动总开关关闭或损坏时分享拒绝，即使旧分享开关仍开启',async t=>{
  const f=fixture(t);f.service.configure({enabled:true},{explicit:true});const file=path.join(f.stateDir,'friend-interactions-policy.json');
  fs.writeFileSync(file,JSON.stringify({version:1,enabled:false}));assert.equal(f.service.context().enabled,false);await assert.rejects(f.service.share(f.evidence()),/总开关/);assert.equal(f.calls.length,0);
  fs.writeFileSync(file,'损坏的总开关');await assert.rejects(f.service.share(f.evidence()),/总开关记录损坏/);assert.equal(f.calls.length,0);
});

test('分享最终短输入与总开关共用控制锁，持锁期间其他入口不能报关闭成功',async t=>{
  let f;f=fixture(t,{send:async(input,{authorize})=>{
    authorize({phase:'before-click',recipientId:input.recipientId,videoId:input.expectedVideoId});const release=authorize.beginDispatch();
    try{assert.throws(()=>acquireFriendInteractionDispatch(f.stateDir),error=>error.code==='FRIEND_INTERACTIONS_BUSY');assert.equal(readFriendInteractionsEnabled(f.stateDir),true);}finally{release();}
    return receipt(input.expectedVideoId);
  }});f.service.configure({enabled:true},{explicit:true});assert.equal((await f.service.share(f.evidence())).confirmed,true);assert.equal(fs.existsSync(path.join(f.stateDir,'friend-interactions-control.guard')),false);
});

test('发送前重新读取开关、时限、白名单和证据，取消时不点击', async t => {
  for (const mutation of ['disabled', 'expired', 'allowlist', 'evidence']) {
    let f;
    f = fixture(t, { send: async (input, controls) => {
      controls.authorize({ phase: 'prepare', recipientId: input.recipientId, videoId: input.expectedVideoId });
      if (mutation === 'disabled') new AutonomousShare({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, send: async () => {}, stateDir: f.stateDir, now: f.clock }).configure({ enabled: false }, { explicit: true });
      if (mutation === 'expired') f.setNow(f.clock() + 61 * 60_000);
      if (mutation === 'allowlist') fs.writeFileSync(path.join(f.stateDir, 'chat-policy.json'), JSON.stringify({ allowlist: [] }));
      if (mutation === 'evidence') f.personaMemory.snapshot = () => ({ recentObservations: [] });
      controls.authorize({ phase: 'before-click', recipientId: input.recipientId, videoId: input.expectedVideoId });
      assert.fail('核验失败后不得点击');
    } });
    f.videoLimits.savePolicy({windows:['12:00-13:00']},{explicit:true});f.service.configure({ enabled: true }, { explicit: true }); await assert.rejects(f.service.share(f.evidence()));
    assert.equal(f.service.ledger().operations[0].status, 'not-sent'); assert.equal(f.service.state().busy, false);
  }
});

test('未确认结果跨重启保持暂停；人工核对只解除暂停，不退预算或重发旧片', async t => {
  const f = fixture(t, { send: async (input, controls) => { controls.authorize({ phase: 'before-click', recipientId: input.recipientId, videoId: input.expectedVideoId }); return { confirmed: false, deliveryUncertain: true, deliveryType: 'native-card', operationId: 'synthetic-uncertain' }; } });
  f.service.configure({ enabled: true }, { explicit: true }); const input = f.evidence(), result = await f.service.share(input);
  assert.equal(result.deliveryUncertain, true); assert.equal(f.service.state().paused, true);
  const restarted = new AutonomousShare({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, stateDir: f.stateDir, now: f.clock });
  assert.equal(restarted.state().paused, true); assert.equal(restarted.state().needsReview[0].forwardOperationId, 'synthetic-uncertain');
  await assert.rejects(restarted.share(f.evidence('67890')), /未确认/);
  restarted.configure({ enabled: false }, { explicit: true }); assert.throws(() => restarted.configure({ enabled: true }, { explicit: true }), /核对/);
  assert.throws(() => restarted.resolve({ operationId: result.operationId, outcome: 'not-sent' }), /用户/);
  restarted.resolve({ operationId: result.operationId, outcome: 'not-sent' }, { explicit: true }); assert.equal(restarted.state().paused, false); assert.equal(restarted.state().daily.attempts, 1);
  restarted.configure({ enabled: true }, { explicit: true }); assert.equal((await restarted.share(input)).code, 'SHARE_ALREADY_PROCESSED'); await restarted.close();
});

test('自主观看运行编号和有限轮次必须一致，停止请求禁止发送', async t => {
  const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true }, { explicit: true });
  const lock = { version: 1, pid: process.pid, source: 'api', runId: 'synthetic-watch', sessionId: f.videoLimits.state().session.id };
  fs.writeFileSync(path.join(f.stateDir, 'watch-loop.lock'), JSON.stringify(lock));
  await assert.rejects(f.service.share(input), /共享观看/); await assert.rejects(f.service.share(input, { watchRunId: 'wrong-run' }), /共享观看/);
  fs.writeFileSync(path.join(f.stateDir, 'watch-stop.request.json'), JSON.stringify({ runId: lock.runId })); await assert.rejects(f.service.share(input, { watchRunId: lock.runId }), /停止/);
  fs.unlinkSync(path.join(f.stateDir, 'watch-stop.request.json'));
  assert.equal((await f.service.share(input, { watchRunId: lock.runId })).confirmed, true); assert.equal(f.calls[0].controls.autonomousRunId, lock.runId);
});

test('上海日期更新只重置新日计数，旧日同片同人去重和不确定暂停保留', async t => {
  const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true, dailyLimit: 1 }, { explicit: true });
  f.setNow(Date.parse('2026-10-15T15:59:00Z')); f.videoLimits.markSession('api', { explicit: true }); await f.service.share(input); assert.equal(f.service.state().daily.date, '2026-10-15');
  f.setNow(Date.parse('2026-10-15T16:01:00Z')); assert.equal(f.service.state().daily.date, '2026-10-16'); assert.equal(f.service.state().daily.remaining, null);
  assert.equal((await f.service.share(input)).code, 'SHARE_ALREADY_PROCESSED'); await f.service.share(f.evidence('67890')); assert.equal(f.service.state().daily.attempts, 1);
});

test('没有官方卡片或可信点击检查时不宣称成功，不向联系人发送解释或链接', async t => {
  for (const outcome of [{ needsFallback: true, confirmed: false, deliveryUncertain: false }, receipt('12345')]) {
    const f = fixture(t, { send: async (input, controls) => { if (outcome.needsFallback) controls.authorize({ phase: 'prepare', videoId: input.expectedVideoId, recipientId: input.recipientId }); return outcome; } });
    f.service.configure({ enabled: true }, { explicit: true }); const result = await f.service.share(f.evidence());
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, !outcome.needsFallback);
  }
});

test('真实子进程持有共享发送锁时另一入口不能分享，关闭只取消自己的发送', { timeout: 15000 }, async t => {
  const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true }, { explicit: true });
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../autonomous-share.mjs', import.meta.url))).href;
  const workerFile = path.join(f.root, 'synthetic-share-worker.mjs');
  fs.writeFileSync(workerFile, `import {AutonomousShare} from ${JSON.stringify(moduleUrl)};\nconst service=new AutonomousShare({stateDir:process.env.TEST_SHARE_STATE,personaMemory:{snapshot:()=>({recentObservations:JSON.parse(process.env.TEST_SHARE_EVIDENCE)})},videoLimits:{state:()=>JSON.parse(process.env.TEST_SHARE_TIME)},now:()=>Number(process.env.TEST_SHARE_NOW),send:async(input,{authorize,signal})=>{authorize({phase:'prepare',videoId:input.expectedVideoId,recipientId:input.recipientId});process.send({ready:true});await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});\nprocess.on('message',async message=>{if(message==='stop'){await service.close();process.exit(0);}});\nservice.share(JSON.parse(process.env.TEST_SHARE_INPUT)).catch(()=>{});`);
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|comspec|pathext)$/i.test(key)));
  const child = fork(workerFile, [], { env: { ...childEnv, TEST_SHARE_STATE: f.stateDir, TEST_SHARE_EVIDENCE: JSON.stringify(f.personaMemory.snapshot().recentObservations), TEST_SHARE_TIME: JSON.stringify(f.videoLimits.state()), TEST_SHARE_NOW: String(f.clock()), TEST_SHARE_INPUT: JSON.stringify(input) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child, 'message'); assert.equal(f.service.state().busy, true);
  await assert.rejects(f.service.share(f.evidence('67890')), /未确认|分享/); await f.service.close(); assert.equal(child.exitCode, null);
  child.send('stop'); const [exitCode] = await once(child, 'exit'); assert.equal(exitCode, 0); assert.equal(f.service.state().busy, false); assert.equal(f.service.state().daily.attempts, 1);
});

test('异常退出遗留预留收据会暂停，损坏账本和发送锁不会自动清除', async t => {
  const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true }, { explicit: true });
  fs.writeFileSync(f.service.files.send, JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
  fs.writeFileSync(f.service.files.ledger, JSON.stringify({ version: 1, days: { '2026-10-15': 1 }, operations: [{ operationId: 'interrupted-send', ...input, source: 'api', pid: 2147483647, status: 'reserved', day: '2026-10-15' }] }));
  assert.equal(f.service.state().paused, true); assert.equal(f.service.state().recoveryRequired, true);
  f.service.resolve({ operationId: 'interrupted-send', outcome: 'not-sent' }, { explicit: true }); assert.equal(f.service.state().paused, false); assert.equal(f.service.state().daily.attempts, 1);
  fs.writeFileSync(f.service.files.ledger, '{broken'); await assert.rejects(f.service.share(f.evidence('67890')), /记录/); assert.equal(fs.readFileSync(f.service.files.ledger, 'utf8'), '{broken');
});

test('只有存活发送锁精确绑定的预留和点击记录显示进行中，不误报需要人工核对', async t => {
  const entered = Promise.withResolvers(), proceed = Promise.withResolvers(); let f;
  f = fixture(t, { send: async (input, { authorize }) => {
    authorize({ phase: 'prepare', recipientId: input.recipientId, videoId: input.expectedVideoId }); entered.resolve(); await proceed.promise;
    authorize({ phase: 'before-click', recipientId: input.recipientId, videoId: input.expectedVideoId });
    const clicking = f.service.state(); assert.equal(clicking.activity.status, 'sending'); assert.equal(clicking.activity.phase, 'clicking'); assert.equal(clicking.inProgress, true); assert.equal(clicking.paused, false);
    return receipt(input.expectedVideoId);
  } });
  f.service.configure({ enabled: true }, { explicit: true }); const pending = f.service.share(f.evidence());
  await entered.promise;
  try {
    const state = f.service.state(), owner = JSON.parse(fs.readFileSync(f.service.files.send));
    assert.equal(owner.operationId, state.activity.operationId); assert.equal(owner.pid, process.pid);
    assert.equal(state.activity.status, 'sending'); assert.equal(state.activity.phase, 'reserved'); assert.equal(state.inProgress, true); assert.equal(state.paused, false); assert.deepEqual(state.needsReview, []);
    assert.equal(f.service.context().enabled, false); await assert.rejects(f.service.share(f.evidence('67890')), /未确认|正在处理/);
  } finally { proceed.resolve(); }
  assert.equal((await pending).confirmed, true); assert.deepEqual(f.service.state().activity, { status: 'idle' }); assert.equal(f.service.state().inProgress, false);
});

test('同进程旧预留、错误或缺失operationId、死亡发送锁和uncertain记录始终保留人工核对', async t => {
  for (const mode of ['other-operation', 'other-pid', 'missing-operation', 'missing-guard', 'dead', 'uncertain']) {
    const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true }, { explicit: true });
    const operation = { operationId: 'synthetic-guarded-operation', ...input, source: 'api', pid: mode === 'other-pid' ? 2147483647 : process.pid, status: mode === 'uncertain' ? 'uncertain' : 'reserved', day: '2026-10-15' };
    fs.writeFileSync(f.service.files.ledger, JSON.stringify({ version: 1, days: { '2026-10-15': 1 }, operations: [operation] }));
    if (mode !== 'missing-guard') fs.writeFileSync(f.service.files.send, JSON.stringify({ pid: mode === 'dead' ? 2147483647 : process.pid, token: 'synthetic-owner', ...(mode === 'missing-operation' ? {} : { operationId: mode === 'other-operation' ? 'different-operation' : operation.operationId }) }));
    const state = f.service.state(); assert.equal(state.inProgress, false, mode); assert.equal(state.paused, true, mode); assert.equal(state.needsReview.length, 1, mode); assert.deepEqual(state.activity, { status: 'needs-review' }, mode); assert.equal(f.service.context().enabled, false, mode);
    await assert.rejects(f.service.share(input), /未确认/, mode);
  }
});

test('具体未发送原因贯穿转发收据和自主分享看板，未确认不被当作跳过', async t => {
  for (const clicked of [false, true]) {
    const f = fixture(t, { send: async (input, { authorize }) => {
      if (clicked) authorize({ phase: 'before-click', recipientId: input.recipientId, videoId: input.expectedVideoId });
      return { confirmed: false, deliveryUncertain: clicked, operationId: 'synthetic-forward-specific', failure: { code: clicked ? 'FORWARD_RECEIPT_UNCONFIRMED' : 'FORWARD_RECIPIENT_IDENTITY_MISMATCH', stage: clicked ? 'receipt' : 'recipient', message: '合成失败原因 token=private-token MS4PrivateAccount https://private.invalid' } };
    } });
    f.service.configure({ enabled: true }, { explicit: true }); const result = await f.service.share(f.evidence());
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, clicked); assert.equal(result.skipped, undefined);
    const state = f.service.state(), record = state.recent.at(-1); assert.equal(record.status, clicked ? 'uncertain' : 'not-sent'); assert.equal(record.forwardOperationId, 'synthetic-forward-specific'); assert.equal(record.failure.stage, clicked ? 'receipt' : 'recipient'); assert.equal(record.failure.code, result.failure.code);
    assert.equal(record.failure.message.includes('private-token'), false); assert.equal(record.failure.message.includes('MS4PrivateAccount'), false); assert.equal(record.failure.message.includes('private.invalid'), false);
    if (clicked) { assert.equal(state.needsReview.length, 1); await assert.rejects(f.service.share(f.evidence('67890')), /未确认/); }
  }
});

test('真实合成分享面板通过可信授权发送官方卡片，撤回授权与JSON伪造不能点击', { timeout: 15000 }, async t => {
  const [{ chromium }, { VideoForwarder }, { readPageState }] = await Promise.all([import('../playwright-runtime.mjs'), import('../video-forward.mjs'), import('../core.mjs?v=9')]);
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  for (const revoked of [true, false]) {
    const f = fixture(t), page = await browser.newPage();
    await page.route('**/*', route => route.fulfill(route.request().resourceType() === 'document' ? { contentType: 'text/html', body: '<!doctype html><html><body></body></html>' } : { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>' }));
    await page.goto('https://www.douyin.com/video/12345');
    await page.setContent('<div data-e2e="video-share-icon-container" style="width:300px;height:100px">分享<div data-e2e="video-share-container"><div data-e2e="share-friend-row" data-conversation-type="direct" data-conversation-id="synthetic-person-1"><img src="https://synthetic.invalid/aweme-avatar/friend.png" width="24" height="24"><span data-e2e="share-friend-name">合成好友1</span><button data-e2e="share-friend-send">分享</button></div></div></div>');
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<section data-e2e="feed-active-video" class="video_12345"><video style="position:fixed;left:700px;top:10px;width:80px;height:50px"></video></section>'); Object.defineProperty(document.querySelector('video'), 'readyState', { value: 4 }); window.sendCount = 0; document.querySelector('button').addEventListener('click', () => { window.sendCount++; }); });
    const realEvaluate = page.evaluate.bind(page); page.evaluate = (fn, arg) => fn === readPageState ? Promise.resolve(stateFor()) : realEvaluate(fn, arg);
    let gates = 0, verified = 0;
    const controller = { source: 'api', withPage: async (action, options) => { assert.equal(options.autonomousRunId, undefined); return action(page); }, pauseForLimits: async () => {}, settle: async () => { throw new Error('自主分享不能导航另一作品'); } };
    const contact = { ...f.contacts[0], displayName: '合成好友1', avatar: 'https://synthetic.invalid/aweme-avatar/friend.png' };
    const chatBrowser = { contacts: new Map([[friend, contact]]), listContacts: async ({ verifyFollowing, backgroundOnly }) => { assert.equal(verifyFollowing, false); assert.equal(backgroundOnly, true); verified++; return { contacts: [contact] }; }, readConversation: async () => ({ conversation: { id: friend }, messages: await realEvaluate(() => window.sendCount) ? [{ id: 'synthetic-real-dom-card', sender: 'outgoing', arrivalClassification: 'new-tail', media: { type: 'shared-work', videoId: '12345' } }] : [] }), sendMessage: async () => { throw new Error('不能发送正文或链接'); } };
    const forwarder = new VideoForwarder({ controller, chatBrowser, stateDir: f.stateDir, videoLimits: { beforeAction: () => { gates++; if (revoked && gates === 4) f.service.configure({ enabled: false }, { explicit: true }); return { allowed: true }; } } });
    const forged = await forwarder.forwardAutonomous({ recipientId: friend, expectedVideoId: '12345' }, { authorize: true }); assert.equal(forged.confirmed, false); assert.equal(verified, 0);
    await assert.rejects(forwarder.forwardAutonomous({ recipientId: friend, expectedVideoId: '12345', url: 'https://www.douyin.com/video/999' }, { authorize: () => true }), /不能指定/);
    f.service.send = undefined; f.service.getForwarder = async () => forwarder; f.service.configure({ enabled: true }, { explicit: true });
    if (revoked) { await assert.rejects(f.service.share(f.evidence()), /关闭|启用/); assert.equal(await realEvaluate(() => window.sendCount), 0); }
    else { const result = await f.service.share(f.evidence()); assert.equal(result.confirmed, true); assert.equal(result.messageId, 'synthetic-real-dom-card'); assert.equal(await realEvaluate(() => window.sendCount), 1); assert.equal(f.service.ledger().operations[0].forwardOperationId, forwarder.receipts().operations[0].operationId); }
    assert.equal(verified, 1); await page.close();
  }
});

test('真实临时 Edge：几何等待和最终核验期间跨入口关闭、换作品或换好友均不点击', { timeout: 60000 }, async t => {
  const [{ chromium }, { VideoForwarder }] = await Promise.all([import('../playwright-runtime.mjs'), import('../video-forward.mjs')]);
  for (const stage of ['geometry-wait', 'before-click']) for (const mutation of ['disabled', 'video', 'recipient']) {
    const f = fixture(t), profile = path.join(f.root, 'isolated-edge-profile');
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), disconnected = Promise.withResolvers();
    let owner, client, latched = false;
    try {
      owner = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
      await owner.route('**/*', route => route.fulfill(route.request().resourceType() === 'document' ? { contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>
        <section data-e2e="feed-active-video"><div data-e2e="player-container" class="video_12345"><video muted autoplay style="width:240px;height:320px"></video></div><span data-e2e="video-desc">合成测试作品</span></section>
        <div data-e2e="video-share-icon-container" style="position:fixed;left:300px;top:30px;width:500px;height:250px"><span class="s7K4YLGp" style="display:block;width:50px;height:40px">分享</span><div data-e2e="video-share-container"><div data-e2e="share-friend-row" data-conversation-type="direct" data-conversation-id="synthetic-person-1"><img src="https://synthetic.invalid/aweme-avatar/friend.png" width="24" height="24"><span data-e2e="share-friend-name">合成好友1</span><button data-e2e="share-friend-send">分享</button></div></div></div>
        <script>window.sendCount=0;document.querySelector('button').onclick=()=>window.sendCount++;const canvas=document.createElement('canvas');canvas.width=240;canvas.height=320;const draw=()=>{const c=canvas.getContext('2d');c.fillStyle='#143447';c.fillRect(0,0,240,320)};draw();const video=document.querySelector('video');video.srcObject=canvas.captureStream(15);void video.play();setInterval(draw,60);</script></body></html>` } : { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>' }));
      const inspectionPage = owner.pages()[0]; await inspectionPage.goto('https://www.douyin.com/video/12345');
      await inspectionPage.waitForFunction(() => document.querySelector('video').readyState >= 2);
      const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      assert.ok(port >= 1024 && port !== 9227, '只连接本测试自动分配的临时 CDP 端口');
      client = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = client.contexts()[0].pages().find(page => page.url().includes('/video/12345'));
      const controller = { source: 'api', pauseForLimits: async () => {}, withPage: async (action, { signal }) => {
        signal.throwIfAborted();
        const cancel = () => { void client.close().then(() => disconnected.resolve(), error => disconnected.reject(error)); };
        signal.addEventListener('abort', cancel, { once: true });
        try { return await action(page); } finally { signal.removeEventListener('abort', cancel); }
      } };
      const wait = page.waitForTimeout.bind(page);
      page.waitForTimeout = async milliseconds => {
        if (stage === 'geometry-wait' && milliseconds === 75 && !latched) { latched = true; entered.resolve(); await release.promise; }
        return wait(milliseconds);
      };
      const contact = { ...f.contacts[0], displayName: '合成好友1', avatar: 'https://synthetic.invalid/aweme-avatar/friend.png' };
      const chatBrowser = { contacts: new Map([[friend, contact]]), listContacts: async () => ({ contacts: [contact] }), readConversation: async () => ({ conversation: { id: friend }, messages: [] }) };
      const forwarder = new VideoForwarder({ controller, chatBrowser, stateDir: f.stateDir, videoLimits: f.videoLimits });
      const foreign = new AutonomousShare({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, stateDir: f.stateDir, now: f.clock });
      let successfullyDisabled = false;
      f.service.send = async (input, controls) => {
        const authorize = async request => {
          const result = controls.authorize(request);
          if (stage === 'before-click' && request.phase === stage && !latched) { latched = true; entered.resolve(); await release.promise; }
          return result;
        };
        authorize.beginDispatch = controls.authorize.beginDispatch;
        return forwarder.forwardAutonomous(input, { ...controls, authorize });
      };
      f.service.configure({ enabled: true }, { explicit: true });
      const forwarding = f.service.share(f.evidence()).then(result => ({ result }), error => ({ error }));
      const waitStage = async (pending, message) => {
        let deadline;
        try { return await Promise.race([pending, forwarding.then(output => { throw new Error(`${message}前转发已结束：${output.error?.message || JSON.stringify(output.result)}`); }), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(message)), 2500); })]); }
        finally { clearTimeout(deadline); }
      };
      await waitStage(entered.promise, `合成转发未进入${stage}门闩`);
      assert.equal(latched, true); assert.equal(await inspectionPage.evaluate(() => window.sendCount), 0);
      assert.equal(await inspectionPage.locator('button').getAttribute('data-deepseek-forward-token') !== null, true, '真实输入见证已安装，测试确实进入控件核验阶段');
      if (mutation === 'disabled') successfullyDisabled = foreign.configure({ enabled: false }, { explicit: true }).enabled === false;
      else await inspectionPage.evaluate(kind => {
        if (kind === 'video') { document.querySelector('[data-e2e="player-container"]').className = 'video_67890'; history.replaceState(null, '', '/video/67890'); }
        else { document.querySelector('[data-e2e="share-friend-row"]').setAttribute('data-conversation-id', 'another-stable-account'); }
      }, mutation);
      await waitStage(disconnected.promise, `${stage}/${mutation}变更后监测未取消当前输入`);
      release.resolve(); const output = await forwarding;
      if (mutation === 'disabled') assert.equal(successfullyDisabled, true, '另一个入口已经成功关闭许可');
      if (stage === 'geometry-wait') assert.ok(output.error, '取得最终输入授权前中止，不发出卡片');
      else { assert.equal(output.result?.confirmed, false); assert.equal(output.result?.deliveryUncertain, true, '已取得最终输入授权的中断按保守收据暂停，不能自动重试'); }
      assert.equal(client.isConnected(), false, '取消只断开这项操作的 CDP 客户端');
      assert.equal(inspectionPage.isClosed(), false, '临时 Edge 与页面仍可由独立检查连接读取');
      await inspectionPage.waitForTimeout(350);
      assert.equal(await inspectionPage.evaluate(() => window.sendCount), 0, `${stage}/${mutation} 后也不能出现延迟发送`);
      assert.equal(f.service.ledger().operations[0].status, stage === 'geometry-wait' ? 'not-sent' : 'uncertain');
      await foreign.close();
    } finally { release.resolve(); await client?.close().catch(() => {}); await owner?.close(); }
  }
});

test('最终短输入与设置互斥，忙时不伪报关闭成功，释放后正常撤回', async t => {
  let f;
  f = fixture(t, { send: async (input, { authorize }) => {
    authorize({ phase: 'before-click', recipientId: input.recipientId, videoId: input.expectedVideoId });
    const release = authorize.beginDispatch();
    const foreign = new AutonomousShare({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, stateDir: f.stateDir, now: f.clock });
    try { assert.throws(() => foreign.configure({ enabled: false }, { explicit: true }), /正在更新/); assert.equal(f.service.policy().enabled, true); }
    finally { release(); }
    assert.equal(foreign.configure({ enabled: false }, { explicit: true }).enabled, false);
    return { confirmed: false, deliveryUncertain: true };
  } });
  f.service.configure({ enabled: true }, { explicit: true });
  const result = await f.service.share(f.evidence());
  assert.equal(result.deliveryUncertain, true); assert.equal(f.service.state().enabled, false); assert.equal(f.service.state().paused, true);
  assert.equal(fs.existsSync(f.service.files.control), false);
});

test('真实合成输入：点击后正常禁用按钮仍可核对卡片，缺少回执则保留 uncertain', { timeout: 15000 }, async t => {
  const [{ chromium }, { VideoForwarder }, { readPageState }] = await Promise.all([import('../playwright-runtime.mjs'), import('../video-forward.mjs'), import('../core.mjs?v=9')]);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const hasReceipt of [true, false]) {
      const f = fixture(t), page = await browser.newPage();
      await page.route('**/*', route => route.fulfill(route.request().resourceType() === 'document' ? { contentType: 'text/html', body: '<!doctype html><html><body></body></html>' } : { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>' }));
      await page.goto('https://www.douyin.com/video/12345');
      await page.setContent('<div data-e2e="video-share-icon-container" style="width:400px;height:200px">分享<div data-e2e="video-share-container"><div data-e2e="share-friend-row" data-conversation-type="direct" data-conversation-id="synthetic-person-1"><img src="https://synthetic.invalid/aweme-avatar/friend.png" width="24" height="24"><span data-e2e="share-friend-name">合成好友1</span><button data-e2e="share-friend-send">分享</button></div></div></div>');
      await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<section data-e2e="feed-active-video" class="video_12345"><video style="position:fixed;left:700px;top:10px;width:80px;height:50px"></video></section>'); Object.defineProperty(document.querySelector('video'), 'readyState', { value: 4 }); });
      await page.evaluate(() => {
        window.sendCount = 0;
        document.querySelector('button').onclick = event => {
          window.sendCount++; window.trustedClick = event.isTrusted;
          event.currentTarget.textContent = '已发送'; event.currentTarget.disabled = true;
          const end = performance.now() + 120; while (performance.now() < end) {}
        };
      });
      const realEvaluate = page.evaluate.bind(page); page.evaluate = (fn, arg) => fn === readPageState ? Promise.resolve(stateFor()) : realEvaluate(fn, arg);
      const controller = { source: 'api', pauseForLimits: async () => {}, withPage: async (action, { signal }) => {
        const cancel = () => { void page.close(); }; signal.addEventListener('abort', cancel, { once: true });
        try { return await action(page); } finally { signal.removeEventListener('abort', cancel); }
      } };
      const contact = { ...f.contacts[0], displayName: '合成好友1', avatar: 'https://synthetic.invalid/aweme-avatar/friend.png' };
      const chatBrowser = { contacts: new Map([[friend, contact]]), listContacts: async () => ({ contacts: [contact] }), readConversation: async () => ({ conversation: { id: friend }, messages: hasReceipt && await realEvaluate(() => window.sendCount) ? [{ id: 'synthetic-confirmed-after-ui-change', sender: 'outgoing', arrivalClassification: 'new-tail', media: { type: 'shared-work', videoId: '12345' } }] : [] }) };
      const forwarder = new VideoForwarder({ controller, chatBrowser, stateDir: f.stateDir, videoLimits: f.videoLimits });
      f.service.send = undefined; f.service.getForwarder = async () => forwarder; f.service.configure({ enabled: true }, { explicit: true });
      const input = f.evidence(), result = await f.service.share(input);
      assert.equal(result.confirmed, hasReceipt); assert.equal(result.deliveryUncertain, !hasReceipt);
      assert.equal(await realEvaluate(() => window.sendCount), 1); assert.equal(await realEvaluate(() => window.trustedClick), true);
      assert.equal(await page.locator('button').isDisabled(), true);
      assert.equal(fs.existsSync(f.service.files.control), false);
      if (hasReceipt) assert.equal((await f.service.share(input)).code, 'SHARE_ALREADY_PROCESSED'); else await assert.rejects(f.service.share(input), /未确认/);
      assert.equal(await realEvaluate(() => window.sendCount), 1);
      await page.close();
    }
  } finally { await browser.close(); }
});
