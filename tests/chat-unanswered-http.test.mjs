import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApiServer } from '../app.mjs';
import { VideoLimits } from '../video-limits.mjs';

test('本机 HTTP 未认证不能读遗留记录；带会话令牌可读取并按快照标记，随后回读归零', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-chat-unanswered-http-')), calls = [], records = [
    { recordId: 'a'.repeat(64), contactName: '合成许可好友', at: '2026-10-26T12:28:21.601Z', reason: '新消息尚未取得可靠的新到达资格，未自动回复。', phase: 'unqualified', types: ['文字'], messageCount: 1, preview: '合成本地预览一', handled: false },
    { recordId: 'b'.repeat(64), contactName: '合成许可好友', at: '2026-10-26T12:50:58.112Z', reason: '新消息尚未取得可靠的新到达资格，未自动回复。', phase: 'unqualified', types: ['文字'], messageCount: 1, preview: '合成本地预览二', handled: false },
  ];
  let running = true, worker = { pid: process.pid, runId: 'synthetic-unanswered', alive: true, status: 'running', heartbeatAt: new Date().toISOString() };
  const chat = {
    state: () => ({ running, starting: false, busy: false, worker, policy: { allowlist: [{ id: 'conv:' + 'a'.repeat(64) }] }, contacts: [{ id: 'conv:' + 'a'.repeat(64), status: 'ready', lastCheckedAt: new Date().toISOString() }], recovery: { pendingManualCount: records.filter(item => !item.handled).length, recoverableCount: 0 }, daily: { requests: 0 } }),
    stop: async options => { calls.push(['stop', options]); running = false; worker = null; },
    configure: () => assert.fail('待处理消息不能改写许可名单'),
    start: async () => { calls.push(['start']); running = true; worker = { pid: process.pid, runId: 'synthetic-unanswered', alive: true, status: 'running', heartbeatAt: new Date().toISOString() }; },
    resumeAfterMaintenance: async () => { calls.push(['resumeAfterMaintenance']); running = true; worker = { pid: process.pid, runId: 'synthetic-unanswered', alive: true, status: 'running', heartbeatAt: new Date().toISOString() }; return chat.state(); },
    prepareChat: async () => { calls.push(['prepareChat']); return { prepared: true, count: 1 }; },
    unanswered: () => { const items = records.filter(item => !item.handled).map(({ handled, ...item }) => item); return { protocol: 'chat-unanswered-v1', count: items.length, snapshot: 'c'.repeat(64), items }; },
    markUnansweredHandled: input => { calls.push(['mark', input]); if (input.recordIds.length > 1 && !input.snapshot) throw Object.assign(new Error('批量处理必须核对当前列表快照。'), { status: 400 }); const wanted = new Set(input.recordIds); if (input.recordIds.some(id => !records.some(item => item.recordId === id))) throw Object.assign(new Error('待处理消息不存在或已更新，请刷新列表。'), { status: 404 }); let resolved = 0; for (const item of records) if (wanted.has(item.recordId) && !item.handled) { item.handled = true; item.handledByUserAt = new Date().toISOString(); item.handledMethod = 'mark-handled-no-resend'; resolved++; } return { resolved, alreadyHandled: resolved === 0 }; },
    close: async () => { running = false; },
  };
  let shareEnabled = false;
  const share = { state: () => ({ enabled: shareEnabled }), configure: ({ enabled }) => { shareEnabled = enabled; }, close: async () => {} };
  fs.writeFileSync(path.join(root, 'friend-interactions-policy.json'), JSON.stringify({ version: 1, enabled: true }));
  const server = createApiServer({ controller: { close: async () => {} }, config: { apiKey: 'synthetic-http-key', model: 'synthetic' }, agent: { runTask: async () => assert.fail('HTTP验收不调用模型') }, chatService: chat, shareService: share, videoLimits: new VideoLimits({ stateDir: root }), pauseVideoSources: async () => {}, port: 0 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await server.stop(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, boot = await (await fetch(origin + '/api/bootstrap')).json();
  const request = async (route, body, token = boot.token) => { const response = await fetch(origin + route, { headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-session-token': token } : {}) }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() }; };
  assert.equal((await request('/api/chat/unanswered', undefined, '')).status, 403);
  const opened = await request('/api/chat/unanswered'); assert.equal(opened.status, 200); assert.equal(opened.value.count, 2);
  assert.equal((await request('/api/chat/unanswered/resolve', { recordIds: ['f'.repeat(64)] })).status, 404);
  assert.equal((await request('/api/chat/unanswered/resolve', { recordIds: records.map(item => item.recordId) })).status, 400);
  const resolved = await request('/api/chat/unanswered/resolve', { recordIds: records.map(item => item.recordId), snapshot: opened.value.snapshot });
  assert.equal(resolved.status, 200, resolved.value.error); assert.equal(resolved.value.unanswered.count, 0);
  assert.equal(calls.filter(item => item[0] === 'stop').length, 3); assert.deepEqual(calls.find(item => item[0] === 'stop')[1], { preservePending: true, reason: 'unanswered-review' });
  assert.equal(calls.filter(item => item[0] === 'start').length, 0); assert.equal(calls.filter(item => item[0] === 'resumeAfterMaintenance').length, 3); assert.equal(running, true);
  assert.equal(calls.some(item => item[0] === 'send'), false);
  assert.equal((await request('/api/chat/unanswered')).value.count, 0);
  assert.equal((await request('/api/interactions/state')).value.presence.selectedCount, 1);
  running = false; worker = null;
  const prepared = await request('/api/chat/prepare', {});
  assert.equal(prepared.status, 200); assert.equal(calls.some(item => item[0] === 'prepareChat'), true);
});
