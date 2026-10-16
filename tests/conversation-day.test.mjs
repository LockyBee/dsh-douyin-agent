import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeConversationDay } from '../chat-browser.mjs';

const now = Date.parse('2026-10-15T12:00:00Z');
const message = (sender, sentAt) => ({ id: `${sender}-${sentAt}`, sender, sentAt });
const snapshot = messages => ({ conversation: { id: '合成联系人' }, messages, dayEvidence: { observedAt: new Date(now).toISOString(), latestEndVerified: true, chronology: 'oldest-first', emptyTodayVerified: false } });
const state = (data, options = {}) => analyzeConversationDay(data, { now, ...options }).status;
test('可靠日期的今日发出消息阻止主动问候，HH:mm单独不推断为今日', () => {
  assert.equal(state(snapshot([message('outgoing', '今天 19:59')])), 'already-sent');
  assert.equal(state(snapshot([message('outgoing', '2026-10-15 19:59')])), 'already-sent');
  assert.equal(state(snapshot([message('outgoing', '2026年10月15日 19:59')])), 'already-sent');
  assert.equal(state(snapshot([message('outgoing', '19:59')])), 'date-unknown');
  assert.equal(state(snapshot([message('outgoing', '昨天 19:59')])), 'date-unknown');
  assert.equal(state(snapshot([{ ...message('outgoing', '2026-10-14 19:59'), dateEvidence: { raw: '2026-10-14 19:59', kind: 'unknown', source: 'unverified-group-label' } }])), 'date-unknown');
});
test('可靠最新端的旧日期发出消息才允许问候，未来日期不能放行', () => {
  assert.equal(state(snapshot([message('incoming', '2026-10-14 10:00'), message('outgoing', '2026-10-14 10:01')])), 'eligible');
  assert.equal(state(snapshot([message('outgoing', '2026-10-16 10:01')])), 'date-unknown');
  assert.equal(state(snapshot([message('outgoing', '2026-02-30 10:01')])), 'date-unknown');
});
test('最新incoming尚待回复时优先推迟，不把问候当回复', () => {
  assert.equal(state(snapshot([message('outgoing', '2026-10-14 10:01'), message('incoming', '今天 19:59')])), 'pending-incoming');
  assert.equal(state(snapshot([message('incoming', '19:59')])), 'pending-incoming');
});
test('明确today空会话才放行，没有消息与只有历史起点都不足以证明', () => {
  const empty = snapshot([]); assert.equal(state(empty), 'date-unknown'); empty.dayEvidence.emptyTodayVerified = true; assert.equal(state(empty), 'eligible');
  const historic = snapshot([]); historic.dayEvidence.historyStartVerified = true; assert.equal(state(historic), 'date-unknown');
});
test('旧快照、跨上海日期、缺最新端及顺序未知一律不猜', () => {
  for (const patch of [{ observedAt: new Date(now - 60_001).toISOString() }, { observedAt: '2026-10-14T12:00:00Z' }, { latestEndVerified: false }, { chronology: 'unknown' }]) {
    const data = snapshot([message('outgoing', '2026-10-14 10:01')]); Object.assign(data.dayEvidence, patch); assert.equal(state(data), 'date-unknown');
  }
});
test('共同账本的今日真实发出凭据优先于缺失DOM日期，其他联系人或不确认不计入', () => {
  const data = { conversation: { id: '合成联系人' }, messages: [] }, row = { confirmed: true, recipientId: '合成联系人', date: '2026-10-15', at: new Date(now).toISOString(), messageId: 'msg:合成', kind: 'video', source: 'dsh' };
  assert.equal(state(data, { confirmedHistory: [row] }), 'already-sent');
  for (const patch of [{ recipientId: '其他好友' }, { confirmed: false }, { messageId: '' }, { date: '2026-10-16' }]) assert.equal(state(data, { confirmedHistory: [{ ...row, ...patch }] }), 'date-unknown');
});
test('ISO绝对时间按上海日期核对', () => {
  assert.equal(state(snapshot([message('outgoing', '2026-10-14T16:30:00Z')])), 'already-sent');
  assert.equal(state(snapshot([message('outgoing', '2026-10-14T15:30:00Z')])), 'eligible');
});
