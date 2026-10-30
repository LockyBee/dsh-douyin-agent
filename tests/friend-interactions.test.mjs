import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FriendInteractions } from '../friend-interactions.mjs';
import { acquireFriendInteractionDispatch } from '../friend-interactions-guard.mjs';
import { interactionPresence } from '../interaction-status.mjs';

function fixture(t, options = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-friend-interactions-'));
  const calls = [], current = { running: false, busy: false, policy: { allowlist: [{ id: 'synthetic-original' }] }, contacts: [] }, shared = { enabled: false, paused: false };
  const chat = { state: () => structuredClone(current), start: async controls => { calls.push('chat.start'); controls.signal.throwIfAborted(); current.running = true; }, stop: () => { calls.push('chat.stop'); current.running = false; } };
  const share = { state: () => ({ ...shared }), configure: (input, controls) => { assert.equal(controls.explicit, true); calls.push(`share.${input.enabled}`); shared.enabled = input.enabled; } };
  const coordinator = new FriendInteractions({ stateDir, getChat: () => chat, getShare: () => share, modelReady: () => options.ready !== false, ...options });
  if (!options.missingPolicy) fs.writeFileSync(coordinator.policyFile, JSON.stringify({ version: 1, enabled: true }));
  t.after(async () => { await coordinator.close(); assert.equal(path.dirname(path.resolve(stateDir)), path.resolve(os.tmpdir())); assert.match(path.basename(stateDir), /^douyin-friend-interactions-/); fs.rmSync(stateDir, { recursive: true, force: true }); });
  return { stateDir, calls, current, shared, chat, share, coordinator };
}

test('另一入口恢复真实worker后清除旧等待原因，原入口不重复启动或重建基线', async t => {
  const f = fixture(t); let starts = 0;
  f.chat.start = async () => { starts++; throw Object.assign(new Error('消息页未打开'), { code: 'CHAT_PAGE_NOT_OPEN' }); };
  await f.coordinator.reconcile(); assert.equal(f.coordinator.state().lastErrorCode, 'CHAT_PAGE_NOT_OPEN');
  const now = Date.now(); f.current.running = true; f.current.worker = { alive: true, status: 'running', heartbeatAt: now };
  f.current.contacts = [{ id: 'synthetic-original', status: 'ready', lastCheckedAt: now }];
  const other = new FriendInteractions({ stateDir: f.stateDir, getChat: () => f.chat, getShare: () => f.share });
  try {
    await other.reconcile(); await f.coordinator.reconcile();
    const state = f.coordinator.state();
    assert.equal(state.status, 'running'); assert.equal(state.waitReason, ''); assert.equal(state.lastErrorCode, ''); assert.equal(state.nextRetryAt, null);
    assert.equal(interactionPresence({ friend: state, chat: f.current, modelReady: true, now }).online, true);
    assert.equal(starts, 1); assert.equal(f.calls.includes('chat.stop'), false);
    await f.coordinator.configure({ enabled: false }, { explicit: true });
    assert.equal(f.coordinator.state().enabled, false); assert.equal(f.current.running, false);
  } finally { await other.close(); }
});

test('缺少总开关记录时沿用默认开启，仍只重用原许可名单启动一次', async t => {
  const f = fixture(t, { missingPolicy: true }); assert.equal(f.coordinator.state().policy.enabled, true);
  assert.equal(fs.existsSync(f.coordinator.policyFile), false);
  await f.coordinator.reconcile(); await f.coordinator.reconcile();
  assert.deepEqual(f.calls, ['share.true', 'chat.start']); assert.equal(f.coordinator.state().status, 'running');
  assert.deepEqual(f.current.policy.allowlist, [{ id: 'synthetic-original' }]);
});

test('前台退避期间重复检查不再次启动，显式关闭仍立即生效', async t => {
  const f = fixture(t); let starts = 0;
  f.chat.start = async () => { starts++; throw Object.assign(new Error('合成前台状态'), { code: 'CHAT_FOREGROUND' }); };
  await f.coordinator.reconcile();
  for (let i = 0; i < 50; i++) await f.coordinator.reconcile();
  assert.equal(starts, 1); assert.equal(f.coordinator.state().status, 'waiting');
  await f.coordinator.configure({ enabled: true }, { explicit: true }); assert.equal(starts, 2);
  await f.coordinator.configure({ enabled: false }, { explicit: true });
  assert.equal(f.coordinator.state().enabled, false); assert.equal(starts, 2);
});
test('没有名单或模型时等待，不创建名单、不启动回复', async t => {
  const f = fixture(t, { ready: false }); f.current.policy.allowlist = [];
  await f.coordinator.reconcile(); assert.equal(f.coordinator.state().status, 'waiting-contacts'); assert.deepEqual(f.calls, []);
  f.current.policy.allowlist = [{ id: 'synthetic-original' }]; await f.coordinator.reconcile();
  assert.equal(f.coordinator.state().status, 'waiting-model'); assert.deepEqual(f.calls, ['share.true']);
});
test('已有其他入口worker时不重复启动；关闭通过现有stop请求并保留其他文件', async t => {
  const f = fixture(t); f.current.worker = { alive: true, pid: 987, runId: 'synthetic-foreign' };
  f.chat.stop = () => { f.calls.push('foreign-stop'); f.current.worker.alive = false; };
  fs.writeFileSync(path.join(f.stateDir, 'chat-watermarks.json'), 'synthetic-existing-watermarks');
  await f.coordinator.reconcile(); assert.deepEqual(f.calls, ['share.true']);
  await f.coordinator.configure({ enabled: false }, { explicit: true }); await f.coordinator.reconcile();
  assert.deepEqual(f.calls, ['share.true', 'foreign-stop', 'share.false']);
  assert.equal(fs.readFileSync(path.join(f.stateDir, 'chat-watermarks.json'), 'utf8'), 'synthetic-existing-watermarks');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.coordinator.policyFile)), { version: 1, enabled: false });
});
test('正在启动时关闭会立即撤销同一signal，旧启动不能迟发，reconcile不并发', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), released = Promise.withResolvers(); let signal;
  f.chat.start = async controls => { f.calls.push('chat.start'); signal = controls.signal; entered.resolve(); await released.promise; controls.signal.throwIfAborted(); f.calls.push('synthetic-late-send'); };
  const pending = f.coordinator.reconcile(); await entered.promise;
  const closing = f.coordinator.configure({ enabled: false }, { explicit: true });
  assert.equal(signal.aborted, true); released.resolve(); const results = await Promise.all([pending, closing]); assert.equal(results.every(value => value.protocol === 'friend-interactions-v1'), true);
  assert.equal(f.coordinator.state().status, 'disabled'); assert.equal(f.calls.includes('synthetic-late-send'), false); assert.equal(f.calls.filter(item => item === 'chat.start').length, 1);
});
test('另入口磁盘关闭在检查时撤销启动，保留已关闭开关', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), released = Promise.withResolvers(); let signal;
  f.chat.start = async controls => { signal = controls.signal; entered.resolve(); await released.promise; signal.throwIfAborted(); };
  const pending = f.coordinator.reconcile(); await entered.promise;
  fs.writeFileSync(f.coordinator.policyFile, JSON.stringify({ version: 1, enabled: false })); const check = f.coordinator.reconcile();
  assert.equal(signal.aborted, true); released.resolve(); await Promise.all([pending, check]); assert.equal(f.coordinator.state().enabled, false);
});
test('未确认发送阻止正常启动，不删除或解除原状态', async t => {
  for (const status of ['inflight', 'delivery-uncertain']) {
    const f = fixture(t); f.current.contacts = [{ id: 'synthetic-original', status, pending: { phase: 'sending' } }];
    await f.coordinator.reconcile(); assert.equal(f.calls.includes('chat.start'), false); assert.equal(f.current.contacts[0].status, status); assert.match(f.coordinator.state().lastError, /未确认/);
  }
});
test('锁住的最终点击不能被伪称关闭，忙时409且原总开关不变', async t => {
  const f = fixture(t), release = acquireFriendInteractionDispatch(f.stateDir);
  try { await assert.rejects(f.coordinator.configure({ enabled: false }, { explicit: true }), error => error.status === 409 && error.code === 'FRIEND_INTERACTIONS_BUSY'); assert.equal(f.coordinator.state().enabled, true); }
  finally { release(); }
  assert.deepEqual(f.calls, []);
});
test('退出只停止本地检查，不关总开关或稳定worker，下次入口恢复沿用许可', async t => {
  const f = fixture(t); await f.coordinator.configure({ enabled: true }, { explicit: true }); await f.coordinator.start(); await f.coordinator.close();
  assert.equal(f.current.running, true); assert.equal(f.coordinator.state().enabled, true); assert.equal(f.calls.includes('chat.stop'), false); assert.equal(f.coordinator.timer, null);
  const next = new FriendInteractions({ stateDir: f.stateDir, getChat: () => f.chat, getShare: () => f.share, modelReady: () => true });
  await next.reconcile(); assert.equal(f.calls.filter(item => item === 'chat.start').length, 1); await next.close();
});
test('旧续火花只停止和关闭，不启用且重复检查不重复写', async t => {
  const sparkState = { enabled: true, running: true }, calls = [];
  const spark = { state: () => ({ ...sparkState }), stop: options => { assert.equal(options.explicit, true); calls.push('stop'); sparkState.running = false; }, configure: (input, options) => { assert.equal(options.explicit, true); assert.equal(input.enabled, false); calls.push('disable'); sparkState.enabled = false; } };
  const f = fixture(t, { getSpark: () => spark }); await f.coordinator.reconcile(); await f.coordinator.reconcile(); assert.deepEqual(calls, ['stop', 'disable']);
});
test('损坏总开关拒绝重置并阻止启动，state读取不写磁盘', async t => {
  const f = fixture(t); fs.writeFileSync(f.coordinator.policyFile, '{synthetic-broken'); const before = fs.readFileSync(f.coordinator.policyFile);
  assert.equal(f.coordinator.state().status, 'blocked'); await f.coordinator.reconcile(); assert.equal(f.calls.includes('chat.start'), false);
  assert.deepEqual(fs.readFileSync(f.coordinator.policyFile), before); await assert.rejects(f.coordinator.configure({ enabled: true }, { explicit: true }), /损坏/);
});
test('总开关严格拒绝未授权或扩展名单参数', async t => {
  const f = fixture(t); await assert.rejects(f.coordinator.configure({ enabled: true }), /本人/);
  await assert.rejects(f.coordinator.configure({ enabled: true, recipientIds: [] }, { explicit: true }), /只接受/); assert.deepEqual(f.calls, []);
});
test('缺少HTTP可选模块时只等待，不改变开关或创建worker', async t => {
  const f = fixture(t, { getShare: () => undefined }); await f.coordinator.reconcile();
  assert.equal(f.coordinator.state().status, 'waiting-modules'); assert.equal(f.coordinator.state().lastError, ''); assert.deepEqual(f.calls, []);
});
test('原生入口可注入先绑定模型的启动适配，仍复用同一撤回信号', async t => {
  let providerBound = false;
  const f = fixture(t, { startChat: async (chat, controls) => { providerBound = true; await chat.start({ schedule: true, signal: controls.signal }); } });
  await f.coordinator.reconcile(); assert.equal(providerBound, true); assert.equal(f.current.running, true);
});
test('关闭入口取消尚未完成的本地启动，但不改总开关或分享许可', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), released = Promise.withResolvers();
  f.chat.start = async ({ signal }) => { entered.resolve(); await released.promise; signal.throwIfAborted(); };
  const pending = f.coordinator.reconcile(); await entered.promise; const closed = f.coordinator.close(); released.resolve(); await Promise.all([pending, closed]);
  assert.equal(f.coordinator.state().enabled, true); assert.equal(f.shared.enabled, true); assert.equal(f.calls.includes('share.false'), false);
});
test('运行中保存许可先停旧worker，持共享设置锁配置后按原总开关恢复', async t => {
  const f = fixture(t); await f.coordinator.reconcile();
  f.chat.configure = async input => { assert.equal(f.current.running, false); assert.equal(fs.existsSync(f.coordinator.settingsGuard), true); f.calls.push('contacts.saved'); f.current.policy.allowlist = input.recipientIds.map(id => ({ id })); return { saved: true }; };
  const result = await f.coordinator.configureContacts({ recipientIds: ['synthetic-selected'] });
  assert.equal(result.saved, true); assert.deepEqual(f.calls, ['share.true', 'chat.start', 'chat.stop', 'contacts.saved', 'chat.start']); assert.equal(fs.existsSync(f.coordinator.settingsGuard), false);
  assert.equal(f.coordinator.state().policy.enabled, true);
});
test('另一入口见设置锁等待，保存期间用户真正关闭总开关不会被覆盖', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), done = Promise.withResolvers(); await f.coordinator.reconcile();
  f.chat.configure = async () => { entered.resolve(); await done.promise; return { saved: true }; };
  const pending = f.coordinator.configureContacts({ recipientIds: [] }); await entered.promise;
  const other = new FriendInteractions({ stateDir: f.stateDir, getChat: () => f.chat, getShare: () => f.share, modelReady: () => true });
  await other.reconcile(); assert.equal(other.state().status, 'waiting-settings'); assert.equal(f.calls.filter(item => item === 'chat.start').length, 1);
  await f.coordinator.configure({ enabled: false }, { explicit: true }); done.resolve(); await pending; await other.close();
  assert.equal(f.coordinator.state().enabled, false); assert.equal(f.current.running, false); assert.equal(f.shared.enabled, false); assert.equal(f.calls.filter(item => item === 'chat.start').length, 1);
});
test('停止超时保留草稿和旧状态，设置锁释放但不假称保存成功', async t => {
  const f = fixture(t); f.current.running = true; f.chat.stop = () => { f.calls.push('stop-request'); }; f.chat.configure = () => assert.fail('未停止前不得保存');
  await assert.rejects(f.coordinator.withChatPaused(() => f.chat.configure({}), { timeoutMs: 20 }), /超过60秒/);
  assert.deepEqual(f.current.policy.allowlist, [{ id: 'synthetic-original' }]); assert.equal(fs.existsSync(f.coordinator.settingsGuard), false); assert.equal(f.coordinator.state().enabled, true);
});
test('已有或损坏设置锁不自动抢占，拒绝第二个名单保存', async t => {
  const f = fixture(t); f.chat.configure = () => assert.fail('已有设置锁不能保存'); fs.writeFileSync(f.coordinator.settingsGuard, '{synthetic-bad-lock');
  await assert.rejects(f.coordinator.configureContacts({ recipientIds: [] }), error => error.status === 409 && error.code === 'FRIEND_SETTINGS_BUSY');
  assert.equal(fs.readFileSync(f.coordinator.settingsGuard, 'utf8'), '{synthetic-bad-lock'); await f.coordinator.reconcile(); assert.equal(f.calls.includes('chat.start'), false);
});

test('默认运行中解除所选会话暂停，会协调停止并保留维护中的待答，再恢复许可', async t => {
  const f=fixture(t);await f.coordinator.reconcile();f.chat.configure=()=>{};
  let stopOptions;f.chat.stop=options=>{stopOptions=options;f.current.running=false;f.calls.push('chat.stop');};
  f.chat.resumeContact=id=>{assert.equal(id,'synthetic-original');assert.equal(f.current.running,false);assert.equal(fs.existsSync(f.coordinator.settingsGuard),true);f.calls.push('contact.resumed');return{resolved:true};};
  const result=await f.coordinator.resumeContact('synthetic-original');assert.equal(result.resolved,true);
  assert.deepEqual(stopOptions,{preservePending:true,reason:'settings-update'});assert.equal(f.current.running,true);assert.equal(f.coordinator.state().enabled,true);
  assert.deepEqual(f.calls,['share.true','chat.start','chat.stop','contact.resumed','chat.start']);
});
test('回复启动失败保留结构化等待原因并退避，重复检查不重复启动；显式准备动作只准备一次并重试', async t => {
  const f = fixture(t); let starts = 0, prepared = 0;
  f.chat.start = async () => { starts++; throw Object.assign(new Error('专用标签页已离开抖音，请重新打开或准备回复通道。'), { code: 'CHAT_PAGE_LEFT_DOUYIN' }); };
  await f.coordinator.reconcile();
  let state = f.coordinator.state();
  assert.equal(starts, 1); assert.equal(state.status, 'waiting'); assert.equal(state.lastErrorCode, 'CHAT_PAGE_LEFT_DOUYIN');
  assert.match(state.waitReason, /专用标签页已离开抖音/); assert.ok(Number.isFinite(Date.parse(state.nextRetryAt))); assert.equal(state.canPrepare, true);
  for (let index = 0; index < 50; index++) await f.coordinator.reconcile();
  assert.equal(starts, 1);
  f.chat.prepareChat = async () => { prepared++; return { prepared: true, count: 1 }; };
  f.chat.start = async () => { starts++; f.current.running = true; };
  state = await f.coordinator.prepareChat();
  assert.equal(prepared, 1); assert.equal(starts, 2); assert.equal(state.waitReason, ''); assert.equal(state.status, 'running');
  await f.coordinator.prepareChat(); assert.equal(prepared, 1, '运行中再次准备不会重复建页');
});

test('准备动作并发单飞，关闭中断并等待同一准备 Promise', async t => {
  const f = fixture(t), calls = [], releases = [];
  f.chat.prepareChat = ({ signal }) => { calls.push(signal); return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); releases.push(() => resolve({ prepared: true, count: 1 })); }); };
  const first = f.coordinator.prepareChat();
  const firstSettled = first.catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  const second = f.coordinator.prepareChat();
  const secondSettled = second.catch(error => error);
  assert.equal(calls.length, 1); assert.equal(f.coordinator.state().status, 'preparing');
  const closing = f.coordinator.close();
  assert.equal(calls[0].aborted, true);
  await Promise.all([firstSettled, secondSettled, closing]);
  assert.equal(f.coordinator.state().status, 'closed');
  assert.equal(f.coordinator.state().online, undefined);
});

test('准备等待中进入设置维护会中断准备，但不改总开关', async t => {
  const f = fixture(t); let signal;
  f.chat.configure = async () => { f.calls.push('contacts.saved'); };
  f.chat.prepareChat = ({ signal: current }) => { signal = current; return new Promise((resolve, reject) => { current.addEventListener('abort', () => reject(current.reason), { once: true }); }); };
  const pending = f.coordinator.prepareChat();
  const observed = pending.catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  await f.coordinator.configureContacts({ recipientIds: ['synthetic-original'] });
  assert.equal(signal.aborted, true);
  assert.equal(f.coordinator.state().enabled, true);
  assert.match((await observed).message, /设置维护/);
});

test('准备等待中撤销总开关会中断准备且不会重新打开', async t => {
  const f = fixture(t); let signal;
  f.chat.prepareChat = ({ signal: current }) => { signal = current; return new Promise((resolve, reject) => { current.addEventListener('abort', () => reject(current.reason), { once: true }); }); };
  const pending = f.coordinator.prepareChat();
  const observed = pending.catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  await f.coordinator.configure({ enabled: false }, { explicit: true });
  assert.equal(signal.aborted, true);
  assert.equal(f.coordinator.state().enabled, false);
  await observed;
  assert.equal(f.shared.enabled, false);
});

test('解除暂停不接受名单外会话，用户同时关闭总开关后也不会被恢复动作打开',async t=>{
  const f=fixture(t);await f.coordinator.reconcile();f.chat.configure=()=>{};
  await assert.rejects(f.coordinator.resumeContact('not-selected'),error=>error.status===403);assert.equal(f.calls.includes('chat.stop'),false);
  const entered=Promise.withResolvers(),done=Promise.withResolvers();f.chat.resumeContact=async()=>{entered.resolve();await done.promise;return{resolved:true};};
  const resolving=f.coordinator.resumeContact('synthetic-original');await entered.promise;await f.coordinator.configure({enabled:false},{explicit:true});done.resolve();await resolving;
  assert.equal(f.current.running,false);assert.equal(f.coordinator.state().enabled,false);assert.equal(f.shared.enabled,false);
});
