import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { OutboundCoordinator } from '../outbound-send.mjs';

function fixture(t, options = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-outbound-'));
  t.after(() => { assert.equal(path.dirname(stateDir), os.tmpdir()); fs.rmSync(stateDir, { recursive: true, force: true }); });
  return { stateDir, api: new OutboundCoordinator({ stateDir, ...options }), dsh: new OutboundCoordinator({ stateDir, source: 'dsh', ...options }) };
}
test('两个入口的整个发送回调互斥，收据仅有身份、用途和上海日期', async t => {
  const f = fixture(t, { now: () => Date.parse('2026-10-15T16:01:00Z') });
  let inside = 0, maximum = 0; const order = [];
  const run = (coordinator, purpose) => coordinator.run({ recipientId: '合成联系人', purpose }, async () => { inside++; maximum = Math.max(maximum, inside); order.push(purpose); await delay(80); inside--; return { confirmed: true, messageId: purpose, text: '正文不应进入共同账本', arbitrary: true }; });
  await Promise.all([run(f.api, 'reply'), run(f.dsh, 'video')]);
  assert.equal(maximum, 1); assert.deepEqual(order, ['reply', 'video']);
  const receipts = f.dsh.history('合成联系人'); assert.equal(receipts.length, 2); assert.equal(receipts[0].date, '2026-10-16');
  assert.deepEqual(Object.keys(receipts[0]).sort(), ['at', 'confirmed', 'date', 'kind', 'messageId', 'recipientId', 'source'].sort());
  assert.equal(fs.readFileSync(f.api.receiptsFile, 'utf8').includes('正文'), false); assert.equal(fs.existsSync(f.api.guardFile), false);
});
test('未确认、空messageId和失败回调都不产生成功凭据', async t => {
  const f = fixture(t);
  for (const delivery of [{ confirmed: false, messageId: '不是确认' }, { confirmed: true, messageId: '' }, { confirmed: true, messageId: ' ' }, { confirmed: 1, messageId: '不是布尔确认' }]) await f.api.run({ recipientId: '合成联系人', purpose: 'spark' }, async () => delivery);
  await assert.rejects(f.api.run({ recipientId: '合成联系人', purpose: 'reply' }, async () => { throw new Error('合成失败'); }), /合成失败/);
  assert.deepEqual(f.api.history('合成联系人'), []); assert.equal(fs.existsSync(f.api.guardFile), false);
});
test('相同真实消息凭据跨入口不会重复记账', async t => {
  const f = fixture(t); const result = { confirmed: true, messageId: '同一消息' };
  await f.api.run({ recipientId: '甲', purpose: 'reply' }, async () => result);
  await f.dsh.run({ recipientId: '甲', purpose: 'spark' }, async () => result);
  assert.equal(f.api.history('甲').length, 1); assert.equal(f.api.history('乙').length, 0);
});
test('有限等锁失败在回调之前返回busy，现有锁不被删除', async t => {
  const f = fixture(t, { waitMs: 30 }); fs.writeFileSync(f.api.guardFile, JSON.stringify({ pid: process.pid, token: '另一个事务' })); let called = false;
  await assert.rejects(f.api.run({ recipientId: '甲', purpose: 'reply' }, async () => { called = true; }), e => e.code === 'OUTBOUND_BUSY' && e.beforeDelivery === true);
  assert.equal(called, false); assert.equal(fs.existsSync(f.api.guardFile), true);
});
test('等待取消不进入回调，不清除其他入口的锁', async t => {
  const f = fixture(t); fs.writeFileSync(f.api.guardFile, JSON.stringify({ pid: process.pid, token: '其他事务' })); const abort = new AbortController(); let called = false;
  const pending = f.api.run({ recipientId: '甲', purpose: 'reply', signal: abort.signal }, async () => { called = true; }); setTimeout(() => abort.abort(), 20);
  await assert.rejects(pending, /abort/i); assert.equal(called, false); assert.equal(fs.existsSync(f.api.guardFile), true);
});
test('不明残锁与损坏账本停止发送，保留原始证据', async t => {
  const f = fixture(t); fs.writeFileSync(f.api.guardFile, '{}');
  await assert.rejects(f.api.run({ recipientId: '甲', purpose: 'spark' }, async () => assert.fail()), e => e.code === 'OUTBOUND_RECOVERY_REQUIRED');
  assert.equal(fs.readFileSync(f.api.guardFile, 'utf8'), '{}'); fs.unlinkSync(f.api.guardFile);
  fs.writeFileSync(f.api.receiptsFile, '{bad');
  assert.throws(() => f.api.history('甲'), e => e.code === 'OUTBOUND_LEDGER_INVALID');
  await assert.rejects(f.api.run({ recipientId: '甲', purpose: 'spark' }, async () => assert.fail()), e => e.code === 'OUTBOUND_LEDGER_INVALID');
  assert.equal(fs.readFileSync(f.api.receiptsFile, 'utf8'), '{bad'); assert.equal(fs.existsSync(f.api.guardFile), false);
});
test('真实wx建锁空窗先等待，同名重建遗留旧创建时间也不抢锁', { timeout: 2000 }, async t => {
  const f = fixture(t), completeObserved = Promise.withResolvers(), abort = new AbortController(); let called = false;
  const descriptor = fs.openSync(f.api.guardFile, 'wx', 0o600), originalStat = fs.lstatSync;
  fs.lstatSync = (...args) => { const value = originalStat(...args); if (args[0] === f.api.guardFile) { value.birthtimeMs -= 2000; if (value.size > 0) completeObserved.resolve(); } return value; };
  const pending = f.api.run({ recipientId: '合成半写锁联系人', purpose: 'reply', signal: abort.signal }, async () => { called = true; return { confirmed: true, messageId: 'after-release' }; });
  try {
    assert.equal(called, false); fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token: '合成尚在发送的持有者', source: 'dsh' })); fs.fsyncSync(descriptor);
    await Promise.race([completeObserved.promise, pending.then(() => assert.fail('原锁尚未释放时不能进入发送回调'))]);
    assert.equal(called, false); assert.equal(fs.existsSync(f.api.guardFile), true);
    fs.unlinkSync(f.api.guardFile); await pending; assert.equal(called, true); assert.equal(f.api.history('合成半写锁联系人').length, 1);
  } finally { fs.closeSync(descriptor); fs.lstatSync = originalStat; abort.abort(); await pending.catch(() => {}); }
});
test('新建空锁超过本次等待预算返回busy，既不发送也不删除空锁', async t => {
  const f = fixture(t, { waitMs: 10 }); fs.writeFileSync(f.api.guardFile, ''); let called = false;
  await assert.rejects(f.api.run({ recipientId: '合成短预算联系人', purpose: 'reply' }, async () => { called = true; }), error => error.code === 'OUTBOUND_BUSY' && error.beforeDelivery === true);
  assert.equal(called, false); assert.equal(fs.readFileSync(f.api.guardFile, 'utf8'), '');
});
test('文件时间略快于墙钟的空锁仍只等待，超出发送预算不进入回调',async t=>{
  const f=fixture(t,{waitMs:10});fs.writeFileSync(f.api.guardFile,'');const future=new Date(Date.now()+200);fs.utimesSync(f.api.guardFile,future,future);let sent=false;
  await assert.rejects(f.api.run({recipientId:'合成时间偏差联系人',purpose:'reply'},async()=>{sent=true}),error=>error.code==='OUTBOUND_BUSY'&&error.beforeDelivery===true);
  assert.equal(sent,false);assert.equal(fs.readFileSync(f.api.guardFile,'utf8'),'');
});
test('新空锁一直未写完时仅等短宽限后要求核对，不耗完五秒发送预算', { timeout: 1500 }, async t => {
  const f = fixture(t); fs.writeFileSync(f.api.guardFile, ''); let called = false;
  await assert.rejects(f.api.run({ recipientId: '合成未写完锁联系人', purpose: 'reply' }, async () => { called = true; }), error => error.code === 'OUTBOUND_RECOVERY_REQUIRED');
  assert.equal(called, false); assert.equal(fs.readFileSync(f.api.guardFile, 'utf8'), '');
});
test('空锁时间戳不断刷新也不能延长本次500毫秒宽限或进入发送', { timeout: 1500 }, async t => {
  const f = fixture(t); fs.writeFileSync(f.api.guardFile, ''); let called = false;
  const touching = setInterval(() => { const time = new Date(); fs.utimesSync(f.api.guardFile, time, time); }, 20);
  try { await assert.rejects(f.api.run({ recipientId: '合成持续空锁联系人', purpose: 'reply' }, async () => { called = true; }), error => error.code === 'OUTBOUND_RECOVERY_REQUIRED'); }
  finally { clearInterval(touching); }
  assert.equal(called, false); assert.equal(fs.readFileSync(f.api.guardFile, 'utf8'), '');
});
test('过期空锁、空对象和非空坏JSON保持recovery，不会借宽限自动修复或发送', async t => {
  const f = fixture(t); let called = false;
  for (const text of ['', '{}', '{partial']) {
    fs.writeFileSync(f.api.guardFile, text);
    if (text === '') { const old = new Date(Date.now() - 2000); fs.utimesSync(f.api.guardFile, old, old); }
    await assert.rejects(f.api.run({ recipientId: '合成残锁联系人', purpose: 'spark' }, async () => { called = true; }), error => error.code === 'OUTBOUND_RECOVERY_REQUIRED');
    assert.equal(fs.readFileSync(f.api.guardFile, 'utf8'), text); fs.unlinkSync(f.api.guardFile);
  }
  assert.equal(called, false);
});
test('观察到EEXIST后原持有者恰好释放造成ENOENT时重新竞争，不误报残锁', async t => {
  const f = fixture(t), originalStat = fs.lstatSync; let released = false, called = 0;
  fs.writeFileSync(f.api.guardFile, JSON.stringify({ pid: process.pid, token: '合成正好释放的持有者' }));
  fs.lstatSync = (...args) => { if (args[0] === f.api.guardFile && !released) { released = true; fs.unlinkSync(f.api.guardFile); } return originalStat(...args); };
  try { await f.api.run({ recipientId: '合成释放边界联系人', purpose: 'reply' }, async () => { called++; return { confirmed: true, messageId: 'released-race' }; }); }
  finally { fs.lstatSync = originalStat; }
  assert.equal(released, true); assert.equal(called, 1); assert.equal(f.api.history('合成释放边界联系人').length, 1); assert.equal(fs.existsSync(f.api.guardFile), false);
});
test('伪造日期或重复账本凭据不能作为可信今日消息', t => {
  const f = fixture(t); const row = { confirmed: true, date: '2026-10-14', at: '2026-10-15T12:00:00Z', kind: 'reply', recipientId: '甲', messageId: '消息', source: 'api' };
  fs.writeFileSync(f.api.receiptsFile, JSON.stringify({ version: 1, receipts: [row] })); assert.throws(() => f.api.history('甲'), /异常/);
  row.date = '2026-10-15'; fs.writeFileSync(f.api.receiptsFile, JSON.stringify({ version: 1, receipts: [row, row] })); assert.throws(() => f.api.history('甲'), /异常/);
});
test('独立Node进程与当前入口共享同一发送锁和收据', { timeout: 5000 }, async t => {
  let child, finish;
  t.after(async () => { if (child?.exitCode === null && !child.killed) child.kill(); if (finish) await finish.promise; });
  const f = fixture(t); const acquired = Promise.withResolvers(); finish = Promise.withResolvers(); let errors = '';
  const moduleUrl = new URL('../outbound-send.mjs', import.meta.url).href;
  const script = `import {OutboundCoordinator} from ${JSON.stringify(moduleUrl)};const released=new Promise(resolve=>process.once('message',message=>{if(message?.type==='release')resolve()}));const c=new OutboundCoordinator({stateDir:${JSON.stringify(f.stateDir)},source:'dsh'});await c.run({recipientId:'进程间合成联系人',purpose:'spark'},async()=>{process.send({type:'locked'});await released;return{confirmed:true,messageId:'child-message'}});process.disconnect();`;
  child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  child.on('message', message => { if (message?.type === 'locked') acquired.resolve(); }); child.stderr.on('data', chunk => { errors += chunk; }); child.once('error', error => { acquired.reject(error); finish.resolve(-1); }); child.once('exit', code => { acquired.reject(new Error(errors || '合成子进程在建立发送锁之前退出。')); finish.resolve(code); });
  await acquired.promise; let called = false;
  const contender = new OutboundCoordinator({ stateDir: f.stateDir, waitMs: 0 });
  await assert.rejects(contender.run({ recipientId: '进程间合成联系人', purpose: 'reply' }, async () => { called = true; }), error => error.code === 'OUTBOUND_BUSY');
  assert.equal(called, false); assert.equal(child.exitCode, null); assert.equal(fs.existsSync(f.api.guardFile), true);
  child.send({ type: 'release' }); assert.equal(await finish.promise, 0, errors); let childPresent = false;
  await f.api.run({ recipientId: '进程间合成联系人', purpose: 'reply' }, async () => { childPresent = f.api.history('进程间合成联系人').some(item => item.messageId === 'child-message'); return { confirmed: true, messageId: 'parent-message' }; });
  assert.equal(childPresent, true); assert.equal(f.api.history('进程间合成联系人').length, 2);
});
