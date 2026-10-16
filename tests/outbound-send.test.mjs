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
test('伪造日期或重复账本凭据不能作为可信今日消息', t => {
  const f = fixture(t); const row = { confirmed: true, date: '2026-10-14', at: '2026-10-15T12:00:00Z', kind: 'reply', recipientId: '甲', messageId: '消息', source: 'api' };
  fs.writeFileSync(f.api.receiptsFile, JSON.stringify({ version: 1, receipts: [row] })); assert.throws(() => f.api.history('甲'), /异常/);
  row.date = '2026-10-15'; fs.writeFileSync(f.api.receiptsFile, JSON.stringify({ version: 1, receipts: [row, row] })); assert.throws(() => f.api.history('甲'), /异常/);
});
test('独立Node进程与当前入口共享同一发送锁和收据', async t => {
  const f = fixture(t); const acquired = Promise.withResolvers(), finish = Promise.withResolvers(); let errors = '';
  const moduleUrl = new URL('../outbound-send.mjs', import.meta.url).href;
  const script = `import {OutboundCoordinator} from ${JSON.stringify(moduleUrl)};import {setTimeout}from'node:timers/promises';const c=new OutboundCoordinator({stateDir:${JSON.stringify(f.stateDir)},source:'dsh'});await c.run({recipientId:'进程间合成联系人',purpose:'spark'},async()=>{console.log('locked');await setTimeout(250);return{confirmed:true,messageId:'child-message'}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', chunk => { if (String(chunk).includes('locked')) acquired.resolve(); }); child.stderr.on('data', chunk => { errors += chunk; }); child.once('error', error => { acquired.reject(error); finish.reject(error); }); child.once('exit', code => { if (code !== 0) acquired.reject(new Error(errors)); finish.resolve(code); });
  await acquired.promise; let childPresent = false;
  await f.api.run({ recipientId: '进程间合成联系人', purpose: 'reply' }, async () => { childPresent = f.api.history('进程间合成联系人').some(item => item.messageId === 'child-message'); return { confirmed: true, messageId: 'parent-message' }; });
  assert.equal(await finish.promise, 0, errors); assert.equal(childPresent, true); assert.equal(f.api.history('进程间合成联系人').length, 2);
});
