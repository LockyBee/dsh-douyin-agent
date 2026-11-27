import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { YunsurAutonomousWatch, YunsurBackgroundController } from '../yunsur-background.mjs';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';

const work = '7579432563794584933';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGDkAAAAASUVORK5CYII=';
const account = '9007199254740993';
const hash = input => createHash('sha256').update(input).digest('hex');
const supportedTool = 'share_conversation_aweme';
const decision = (action, fields = {}) => JSON.stringify({ action, reason: '合成作品与会话', topics: [], reflection: '', ...fields });

function contact(conversation_id, shortID, conversation_type) {
  const name = '合成会话' + shortID.slice(-1), isGroup = conversation_type === 2;
  const stable = `rendered:conversation:${hash(conversation_id)}`, identityHash = hash(stable);
  return {
    row: { conversation_id, conversation_short_id: JSON.rawJSON(shortID), conversation_type, name },
    shortID,
    permit: { id: `conv:${identityHash}`, name, isGroup, verifiedAt: '2026-11-18T03:00:00Z', identityVersion: 2, identityKind: 'rendered-conversation', identityHash, identityVerified: true, identityBinding: `binding:${hash(`${isGroup ? 'group' : 'direct'}\0${stable}`)}`, relationshipStatus: 'unavailable', authorizationKind: isGroup ? 'existing-group' : 'existing-conversation' },
  };
}

async function fixture(t, { available = true, wrongBaseline = false, receiptIssuer = account, writeConfigured } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-mcp-share-'));
  const contacts = [contact('0:1:1:2', '9007199254741001', 1), contact('0:1:1:3', '9007199254741002', 1), contact('9007199254741003', '9007199254741004', 2)];
  const sends = [], messages = new Map(), calls = [], failures = [];
  const server = http.createServer(async (req, response) => {
    try {
      assert.equal(req.url, '/mcp');
      assert.equal(req.headers.authorization, 'Bearer ' + 'x'.repeat(32));
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const request = JSON.parse(Buffer.concat(body));
      const { method, params } = request;
      let result;
      if (method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: '合成连接器' } };
      else if (method === 'tools/list') result = { tools: available ? [{ name: supportedTool }] : [] };
      else {
        assert.equal(method, 'tools/call');
        calls.push(params.name);
        let output;
        if (params.name === 'check_login_status') output = { logged_in: true, uid: JSON.rawJSON(account), im_write_configured: writeConfigured };
        else if (params.name === 'list_conversations') output = contacts.map(item => item.row);
        else if (params.name === 'get_conversation_history') {
          const entry = contacts.find(item => item.row.conversation_id === params.arguments.conversation);
          assert.ok(entry);
          output = { ...entry.row, messages: messages.get(entry.row.conversation_id) ?? [] };
          if (wrongBaseline && entry === contacts[1]) output.conversation_id = contacts[0].row.conversation_id;
        } else {
          assert.equal(params.name, supportedTool);
          const args = params.arguments;
          const entry = contacts.find(item => item.row.conversation_id === args.conversation_id);
          assert.ok(entry);
          assert.deepEqual(args, { conversation_id: entry.row.conversation_id, conversation_short_id: entry.shortID, conversation_type: entry.row.conversation_type, account_uid: account, aweme_id: work });
          sends.push(args);
          const share_id = account + '_1794970000000_' + work;
          messages.set(args.conversation_id, [{ ...entry.row, server_message_id: JSON.rawJSON('9007199254741111'), sender: JSON.rawJSON(receiptIssuer), message_type: 8, content: { itemId: work, share_id } }]);
          output = { state: 'submitted', share_id };
        }
        result = { content: [{ type: 'text', text: JSON.stringify(output) }] };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  let watch;
  t.after(async () => {
    await watch?.close();
    await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(failures, []);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const stateDir = path.join(directory, 'state');
  const limits = new VideoLimits({ stateDir });
  limits.savePolicy({ windows: ['00:00-24:00'], dailyMinutes: 30, dailyRequests: 400 }, { explicit: true });
  const personaMemory = new PersonaMemory({ memoryDir: path.join(directory, 'memory'), legacyRoleCardFile: path.join(directory, 'no-legacy.md') });
  personaMemory.initialize();
  fs.writeFileSync(path.join(stateDir, 'chat-policy.json'), JSON.stringify({ version: 1, allowlist: contacts.map(item => item.permit) }));
  const connectionFile = path.join(directory, 'connection.json');
  fs.writeFileSync(connectionFile, JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}/mcp`, token: 'x'.repeat(32) }));
  const controller = new YunsurBackgroundController({ connectionFile, source: 'api', videoLimits: limits });
  const state = time => ({ pageKind: 'video', loginRequired: false, verificationRequired: false, privateChatVisible: false, url: `https://www.douyin.com/video/${work}`, video: { id: work, url: `https://www.douyin.com/video/${work}`, title: '合成视频', author: '合成作者', time, duration: 90, paused: false, ended: false, readyState: 4 } });
  controller.sampler.current = { id: work };
  let time = 0;
  controller.execute = async name => {
    if (name === 'douyin_observe') {
      const beforeTime = time;
      time += 3;
      const current = state(time);
      return { state: current, intervalState: current, frames: [{ mimeType: 'image/png', data: png, time, videoId: work }], observation: { videoId: work, beforeTime, playbackProgressSeconds: 3 } };
    }
    return { state: state(time) };
  };
  controller.pauseForLimits = async () => {};
  const requests = [];
  watch = new YunsurAutonomousWatch({
    controller, videoLimits: limits, personaMemory, stateDir,
    decisionProvider: async ({ messages }) => {
      requests.push(messages[1].content[0].text);
      return { text: !available || requests.length > 1 ? decision('stop') : decision('share', { recipientIds: [contacts[0].permit.id, contacts[1].permit.id, contacts[2].permit.id, contacts[2].permit.id] }) };
    },
  });
  const share = watch.getShareService();
  share.configure({ enabled: true }, { explicit: true });
  return { watch, share, calls, sends, requests, stateDir };
}

test('后台真实 HTTP 适配两类会话卡片，中间核对失败后继续且重复选择只提交一次', async t => {
  const f = await fixture(t, { wrongBaseline: true });
  f.watch.start({}, { explicit: true });
  await f.watch.completion;
  assert.equal(f.watch.state().status, 'completed', f.watch.state().lastError);
  assert.deepEqual(f.sends.map(item => item.conversation_type), [1, 2]);
  assert.deepEqual(f.share.ledger().operations.map(item => item.status), ['confirmed', 'not-sent', 'confirmed']);
  assert.equal(f.share.ledger().operations[1].failure.code, 'MCP_SHARE_BASELINE_UNAVAILABLE');
  assert.equal(f.watch.shareProgress.confirmed, 2);
  assert.match(f.requests[0], /自主分享许可[^\n]*\n\{"enabled":true/);
  assert.match(f.requests[1], /自主分享许可[^\n]*\n\{"enabled":false/);
  const receipts = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'outbound-receipts.json'))).receipts;
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every(item => item.kind === 'video' && /^msg:[a-f0-9]{64}$/.test(item.messageId)));
});

test('旧版后台连接器没有分享工具，继续观看且不向模型提供分享许可', async t => {
  const f = await fixture(t, { available: false });
  f.watch.start({}, { explicit: true });
  await f.watch.completion;
  assert.equal(f.watch.state().status, 'completed', f.watch.state().lastError);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.share.ledger().operations, []);
  assert.match(f.requests[0], /自主分享许可[^\n]*\n\{"enabled":false/);
});

test('多选分享缺少后台发送授权时，各会话均在提交前拦截', async t => {
  const f = await fixture(t, { writeConfigured: false });
  f.watch.start({}, { explicit: true });
  await f.watch.completion;
  assert.equal(f.watch.state().status, 'completed', f.watch.state().lastError);
  assert.deepEqual(f.sends, []);
  const operations = f.share.ledger().operations;
  assert.equal(operations.length, 3);
  assert.ok(operations.every(item => item.status === 'not-sent' && item.failure.code === 'MCP_IM_SEND_AUTHORIZATION_REQUIRED' && item.preflight.sendClicks === 0));
  assert.equal(f.share.state().paused, false);
});

test('同作品卡片来自他人时回执不能确认，暂停剩余分享并继续观看', async t => {
  const f = await fixture(t, { receiptIssuer: '9007199254740999' });
  f.watch.start({}, { explicit: true });
  await f.watch.completion;
  assert.equal(f.watch.state().status, 'completed', f.watch.state().lastError);
  assert.equal(f.sends.length, 1);
  assert.equal(f.share.ledger().operations[0].status, 'uncertain');
  assert.equal(f.share.state().paused, true);
  assert.equal(f.requests.length, 2);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'outbound-send.guard')), false);
});
