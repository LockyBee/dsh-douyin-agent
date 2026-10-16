import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SparkService } from '../spark-service.mjs';
import { OutboundCoordinator } from '../outbound-send.mjs';

const contacts = ['a', 'b'].map((letter, index) => ({ id: 'conv:' + letter.repeat(64), name: `合成好友${index + 1}`, followed: true, isGroup: false, verifiedAt: '2026-10-15T00:00:00.000Z' }));
const oldMessage = letter => ({ id: 'msg:' + letter.repeat(64), sender: 'outgoing', direction: 'outgoing', text: '昨天的合成消息', kind: 'text', sentAt: '2026-10-15 12:00', dateEvidence: { raw: '2026-10-15 12:00', kind: 'absolute' } });
const config = { apiKey: 'fixture-spark-key', baseUrl: 'https://fixture.invalid', model: 'fixture' };

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-spark-domain-'));
  let clock = Date.parse('2026-10-16T04:00:00Z');
  fs.writeFileSync(path.join(directory, 'chat-policy.json'), JSON.stringify({ version: 1, enabled: false, allowlist: contacts, dailyReplyLimit: 40 }));
  const messages = new Map(contacts.map((contact, index) => [contact.id, [oldMessage(index ? 'd' : 'c')]]));
  const sent = [], requests = [], reads = [];
  const now = () => clock;
  const browser = {
    async listContacts() { return { contacts: structuredClone(contacts) }; },
    async readConversation(id, { signal } = {}) { signal?.throwIfAborted(); reads.push(id); return { conversation: { id }, contact: { id, name: contacts.find(item => item.id === id).name }, messages: structuredClone(messages.get(id)), dayEvidence: { latestEndVerified: true, chronology: 'oldest-first', observedAt: new Date(clock).toISOString(), historyStartVerified: false, emptyTodayVerified: false } }; },
    async sendMessage(id, text, settings) {
      settings.signal.throwIfAborted(); await settings.authorize({ phase: 'prepare', recipientId: id }); await settings.authorize({ phase: 'monitor', recipientId: id }); await settings.authorize({ phase: 'before-click', recipientId: id });
      const release = await settings.authorize.beginDispatch();
      try { settings.signal.throwIfAborted(); sent.push({ id, text, settings }); } finally { release(); }
      const messageId = 'msg:' + String(sent.length).repeat(64);
      messages.get(id).push({ id: messageId, sender: 'outgoing', direction: 'outgoing', text, sentAt: new Date(clock).toISOString() });
      return { confirmed: true, deliveryUncertain: false, messageId, conversation: { id } };
    },
  };
  const provider = async request => { requests.push(request); return { text: '今天也来打个招呼，记得喝水呀。' }; };
  const service = new SparkService({ browser, config, stateDir: directory, now, greetingProvider: provider, ...options });
  const extras = [];
  t.after(async () => { await service.close(); for (const other of extras) await other.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-spark-domain-/); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, now, service, browser, sent, requests, reads, messages, clock(value) { clock = value; }, provider, other(extra = {}) { const value = new SparkService({ browser, config, stateDir: directory, now, greetingProvider: provider, source: 'dsh', ...extra }); extras.push(value); return value; } };
}
async function start(f, policy = {}) { f.service.configure({ enabled: true, windows: ['09:00-22:00'], dailyLimit: 2, ...policy }, { explicit: true }); await f.service.start({ schedule: false, explicit: true }); }

test('默认关闭，保存和启动都不立即发送；一轮检查每天每好友仅一次并持久去重', async t => {
  const f = fixture(t);
  assert.equal(f.service.state().enabled, false);
  assert.equal(f.service.state().modelReady, true);
  await f.service.tick(); assert.equal(f.reads.length, 0);
  await assert.rejects(f.service.start({ explicit: true, schedule: false }), /许可/);
  await start(f); assert.equal(f.sent.length, 0); assert.equal(f.requests.length, 0);
  await f.service.tick();
  assert.equal(f.sent.length, 2); assert.equal(f.requests.length, 2);
  assert.equal(f.service.state().daily.attempts, 2); assert.equal(f.service.state().daily.confirmed, 2);
  assert.equal(f.service.state().daily.remaining, 0);
  assert.equal(fs.readFileSync(path.join(f.directory, 'spark-ledger.json'), 'utf8').includes('今天也来打个招呼'), false);
  assert.equal(JSON.stringify(f.service.state()).includes(config.apiKey), false);
  f.service.stop({ explicit: true }); await f.service.start({ explicit: true, schedule: false }); await f.service.tick();
  assert.equal(f.sent.length, 2);
  f.service.stop({ explicit: true });
  const other = f.other(); await other.start({ explicit: true, schedule: false }); await other.tick();
  assert.equal(f.sent.length, 2);
});

test('不在用户时段时不读会话不调用模型，跨午夜窗口沿用上海日期', async t => {
  const f = fixture(t);
  f.clock(Date.parse('2026-10-16T00:00:00Z')); await start(f); await f.service.tick();
  assert.equal(f.reads.length, 0); assert.equal(f.requests.length, 0);
  f.service.configure({ enabled: true, windows: ['23:00-01:00'], dailyLimit: 1 }, { explicit: true });
  f.clock(Date.parse('2026-10-16T16:30:00Z')); await f.service.tick();
  assert.equal(f.service.state().daily.date, '2026-10-17'); assert.equal(f.sent.length, 1);
});

test('已有真实当日发出收据时不再问候，日期未知或待incoming都不生成文本', async t => {
  const f = fixture(t); await start(f);
  await new OutboundCoordinator({ stateDir: f.directory, source: 'dsh', now: f.now }).run({ recipientId: contacts[0].id, purpose: 'reply' }, async () => ({ confirmed: true, messageId: 'msg:' + 'e'.repeat(64) }));
  f.messages.set(contacts[1].id, [{ ...oldMessage('d'), sentAt: '12:01', dateEvidence: { raw: '12:01', kind: 'unknown' } }]);
  await f.service.tick(); assert.equal(f.requests.length, 0); assert.equal(f.sent.length, 0);
  assert.equal(f.service.state().recipients[0].status, 'already-sent'); assert.equal(f.service.state().recipients[1].status, 'date-unknown');
  f.messages.set(contacts[1].id, [oldMessage('d'), { id: 'msg:' + 'f'.repeat(64), sender: 'incoming', direction: 'incoming', text: '合成新私信', sentAt: new Date(f.now()).toISOString() }]);
  await f.service.tick(); assert.equal(f.requests.length, 0); assert.equal(f.service.state().recipients[1].status, 'pending-incoming');
});

test('生成期间有人工回复或共同发送收据时取消本次，不补发且仍占用尝试', async t => {
  const f = fixture(t); await start(f, { dailyLimit: 1 });
  f.service.greetingProvider = async () => {
    await new OutboundCoordinator({ stateDir: f.directory, now: f.now }).run({ recipientId: contacts[0].id, purpose: 'video' }, async () => ({ confirmed: true, messageId: 'msg:' + 'e'.repeat(64) }));
    return { text: '今天也来打个招呼。' };
  };
  await f.service.tick(); assert.equal(f.sent.length, 0); assert.equal(f.service.state().daily.attempts, 1);
  assert.equal(f.service.state().recent[0].status, 'not-sent'); await f.service.tick(); assert.equal(f.sent.length, 0);
});

test('生成等待中关闭许可会立即取消，不向好友发出，也不返当日次数', async t => {
  const f = fixture(t); let ready;
  const started = new Promise(resolve => { ready = resolve; });
  f.service.greetingProvider = async () => { ready(); return new Promise(() => {}); };
  await start(f, { dailyLimit: 1 }); const ticking = f.service.tick(); await started;
  const disabled = f.service.configure({ enabled: false }, { explicit: true }); assert.equal(disabled.enabled, false);
  await assert.rejects(ticking, /关闭|停止/); assert.equal(f.sent.length, 0);
  assert.equal(f.service.state().recent[0].status, 'not-sent'); assert.equal(f.service.state().daily.attempts, 1);
});

test('最终输入短锁期间关闭返回409且许可未改变，发送完成后才可关闭', async t => {
  const f = fixture(t), other = f.other(); const original = f.browser.sendMessage;
  f.browser.sendMessage = async (id, text, settings) => {
    const release = await settings.authorize.beginDispatch();
    try { assert.throws(() => other.configure({ enabled: false }, { explicit: true }), error => error.status === 409); assert.equal(other.policy().enabled, true); } finally { release(); }
    return original(id, text, settings);
  };
  await start(f, { dailyLimit: 1 }); await f.service.tick(); assert.equal(f.sent.length, 1);
  other.configure({ enabled: false }, { explicit: true }); await f.service.tick(); assert.equal(f.service.state().running, false);
});

test('未确认发送暂停，人工解除不退款且同一天不重新发送', async t => {
  const f = fixture(t); f.browser.sendMessage = async () => ({ confirmed: false, deliveryUncertain: true, reason: '合成确认超时' });
  await start(f, { dailyLimit: 1 }); await assert.rejects(f.service.tick(), /不确定/);
  const state = f.service.state(); assert.equal(state.paused, true); assert.equal(state.daily.attempts, 1); assert.equal(state.needsReview.length, 1);
  await assert.rejects(f.service.start({ explicit: true, schedule: false }), /核对/);
  f.service.resolve({ operationId: state.needsReview[0].operationId, outcome: 'not-sent' }, { explicit: true });
  await f.service.start({ explicit: true, schedule: false }); await f.service.tick(); assert.equal(f.sent.length, 0); assert.equal(f.service.state().daily.attempts, 1);
});

test('上次保留的reserved在重启时转为uncertain，不能自动恢复发送', async t => {
  const f = fixture(t); f.service.configure({ enabled: true }, { explicit: true });
  fs.writeFileSync(path.join(f.directory, 'spark-ledger.json'), JSON.stringify({ version: 1, contacts: {}, lastError: '', operations: [{ operationId: 'synthetic-old', recipientId: contacts[0].id, day: '2026-10-16', status: 'reserved', source: 'api', pid: process.pid, runId: 'old-run', startedAt: new Date(f.now()).toISOString() }] }));
  await assert.rejects(f.service.start({ explicit: true, schedule: false }), /核对/);
  assert.equal(f.service.state().recent[0].status, 'uncertain'); assert.equal(f.requests.length, 0); assert.equal(f.sent.length, 0);
});

test('API与DSH共享唯一worker，关闭旁观入口不停止owner，显式跨入口stop仅定位当前run', async t => {
  const f = fixture(t); await start(f); const other = f.other();
  await assert.rejects(other.start({ explicit: true, schedule: false }), /另一个入口/);
  await other.close(); assert.equal(f.service.state().running, true);
  const stopper = f.other(); const state = stopper.stop({ explicit: true }); assert.equal(state.stopping, true);
  const request = JSON.parse(fs.readFileSync(path.join(f.directory, 'spark-stop.request.json'), 'utf8')); assert.equal(request.targetRunId, f.service.runId);
  await f.service.tick(); assert.equal(f.sent.length, 0); assert.equal(f.service.state().running, false);
});

test('现有自动回复或转发未确认时不发送，坏状态不被保存设置覆盖', async t => {
  const f = fixture(t); await start(f);
  fs.writeFileSync(path.join(f.directory, 'chat-watermarks.json'), JSON.stringify({ contacts: { [contacts[0].id]: { status: 'delivery-uncertain' } } }));
  await assert.rejects(f.service.tick(), /未确认/); assert.equal(f.sent.length, 0);
  fs.writeFileSync(path.join(f.directory, 'spark-ledger.json'), '损坏的合成收据');
  assert.throws(() => f.service.configure({ enabled: false }, { explicit: true }), /读取/);
  assert.equal(fs.readFileSync(path.join(f.directory, 'spark-ledger.json'), 'utf8'), '损坏的合成收据');
});

test('无Key可保存许可但不能启动，原生provider仅在停止时注入且不扩大名单', async t => {
  const f = fixture(t, { config: { apiKey: '' }, greetingProvider: undefined });
  assert.equal(f.service.state().modelReady, false); f.service.configure({ enabled: true }, { explicit: true });
  await assert.rejects(f.service.start({ explicit: true, schedule: false }), /模型/);
  f.service.setGreetingProvider(f.provider); assert.equal(f.service.state().modelReady, true);
  await f.service.start({ explicit: true, schedule: false }); assert.throws(() => f.service.setGreetingProvider(f.provider), /停止/);
  await f.service.tick(); assert.equal(f.sent.length, 2);
  f.service.stop({ explicit: true }); assert.throws(() => f.service.configure({ recipientIds: ['other'] }, { explicit: true }), /只接收/);
});

test('释放worker遇短控制锁后会继续完成释放，不留下活进程残锁', async t => {
  const f = fixture(t); await start(f); const other = f.other();
  const release = other.acquireControl();
  f.service.halt('合成停止');
  assert.equal(f.service.worker().owned, true);
  release();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(f.service.worker(), null);
  assert.equal(f.service.heartbeat, null);
});

test('启动尚在等会话关系时，外国入口关闭也会按runId取消启动', async t => {
  const f = fixture(t); let ready;
  const entered = new Promise(resolve => { ready = resolve; });
  f.browser.listContacts = async ({ signal }) => { ready(); return new Promise((_, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); };
  f.service.configure({ enabled: true }, { explicit: true });
  const starting = f.service.start({ explicit: true, schedule: false }); await entered;
  const other = f.other(); other.configure({ enabled: false }, { explicit: true });
  await assert.rejects(starting, /停止|撤回/);
  assert.equal(f.service.worker(), null); assert.equal(f.sent.length, 0);
});

test('生成过程中共享worker归属改变，旧入口不覆盖新入口锁和收据', async t => {
  const f = fixture(t); let ready, release;
  const entered = new Promise(resolve => { ready = resolve; });
  f.service.greetingProvider = async () => { ready(); await new Promise(resolve => { release = resolve; }); return { text: '今天也来打个招呼。' }; };
  await start(f, { dailyLimit: 1 }); const ticking = f.service.tick(); await entered;
  const before = fs.readFileSync(path.join(f.directory, 'spark-ledger.json'), 'utf8');
  const replacement = { pid: process.pid, source: 'dsh', runId: 'synthetic-new-owner', status: 'running', heartbeatAt: new Date(f.now()).toISOString() };
  fs.writeFileSync(path.join(f.directory, 'spark-loop.lock'), JSON.stringify(replacement)); release();
  await assert.rejects(ticking, /失去/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, 'spark-loop.lock'), 'utf8')), replacement);
  assert.equal(fs.readFileSync(path.join(f.directory, 'spark-ledger.json'), 'utf8'), before);
  assert.equal(f.sent.length, 0);
});

test('错误联系人确认回执不会进入共同成功账本，保留uncertain不重发', async t => {
  const f = fixture(t);
  f.browser.sendMessage = async () => ({ confirmed: true, deliveryUncertain: false, messageId: 'msg:' + 'f'.repeat(64), conversation: { id: contacts[1].id } });
  await start(f, { dailyLimit: 1 }); await assert.rejects(f.service.tick(), /不确定/);
  assert.equal(f.service.state().recent[0].status, 'uncertain');
  assert.equal(new OutboundCoordinator({ stateDir: f.directory }).history(contacts[0].id).length, 0);
});
