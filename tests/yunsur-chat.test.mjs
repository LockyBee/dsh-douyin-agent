import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {mapYunsurContacts,YunsurChatBrowser} from '../yunsur-chat.mjs';
import {messageWatermark} from '../chat-message.mjs';
import { ChatService } from '../chat-service.mjs';
import { ChatAgent } from '../chat-agent.mjs';
import { spawnSync } from 'node:child_process';
const hash=x=>createHash('sha256').update(x).digest('hex');
const conv={conversation_id:'1234567890123456789',conversation_short_id:'1234567890123456789',conversation_type:2,name:'许可群',last_messages:[]};
const key=`rendered:conversation:${hash(conv.conversation_id)}`,stored={id:`conv:${hash(key)}`,identityHash:hash(key),identityBinding:`binding:${hash(`group\0${key}`)}`,identityVersion:2,identityKind:'rendered-conversation',identityVerified:true,isGroup:true,name:'许可群',authorizationKind:'existing-group',verifiedAt:'2026-11-17T12:00:00Z'};
const row=(id,sender,text)=>({conversation_id:conv.conversation_id,conversation_type:2,server_message_id:String(id),sender:String(sender),message_type:7,content:{text},timestamp_ms:Date.now()-1000});
function fixture(t,{failSend=false}={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yunsur-chat-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let sends=0,rows=[row(1,2,'@大肥鱼 你好')];const policy={allowlist:[stored],groupMentionNames:['大肥鱼']};const client={call:async(name,args)=>{if(name==='check_login_status')return{logged_in:true,uid:'1'};if(name==='list_conversations')return[conv];if(name==='get_conversation_history')return{messages:rows};if(name==='send_conversation_text'){sends++;assert.equal(args.conversation_type,2);if(failSend)throw Error('模拟回执丢失');rows=[...rows,row(2,1,args.content)];return{state:'submitted'};}throw Error('未知调用');}};const browser=new YunsurChatBrowser({client,getPolicy:()=>policy,journalDir:dir});return{browser,policy,get sends(){return sends},add:message=>rows.push(message),dir};}
test('稳定绑定迁移许可，同名会话不能继承，重复精确身份拒绝',()=>{assert.equal(mapYunsurContacts([conv],[stored]).size,1);assert.equal(mapYunsurContacts([{...conv,conversation_id:'999'}],[stored]).size,0);assert.equal(mapYunsurContacts([conv,{...conv}],[stored]).size,0);});
test('首次历史不补发，新消息尾部可取得资格',async t=>{const f=fixture(t);let snapshot=await f.browser.readConversation(stored.id,{allowed:true});assert.equal(snapshot.messages[0].eligibleForReply,false);f.add(row(3,2,'大肥鱼 再聊一句'));snapshot=await f.browser.readConversation(stored.id,{allowed:true});assert.equal(snapshot.messages.at(-1).eligibleForReply,true);assert.equal(snapshot.messages.at(-1).mentionedSelf,true);});
test('群发送使用类型2，仅新发出同文回读能确认为成功',async t=>{const f=fixture(t);const s=await f.browser.readConversation(stored.id,{allowed:true});const authorize=()=>true;authorize.beginDispatch=()=>()=>{};const args={allowed:true,expectedContact:stored,expectedMessageIds:s.messages.map(m=>m.id),expectedMessageContent:messageWatermark(s.messages,s).content,expectedMessageEvidence:s.dayEvidence,authorize};const receipt=await f.browser.sendMessage(stored.id,'收到啦',args);assert.equal(receipt.confirmed,true);await f.browser.sendMessage(stored.id,'收到啦',args);assert.equal(f.sends,1);});
test('发送后超时跨实例不重试，许可撤回时不发出',async t=>{const f=fixture(t,{failSend:true});const s=await f.browser.readConversation(stored.id,{allowed:true});const authorize=()=>true;authorize.beginDispatch=()=>()=>{};const args={allowed:true,expectedContact:stored,expectedMessageIds:s.messages.map(m=>m.id),expectedMessageContent:messageWatermark(s.messages,s).content,expectedMessageEvidence:s.dayEvidence,authorize};assert.equal((await f.browser.sendMessage(stored.id,'收到啦',args)).deliveryUncertain,true);const restarted=new YunsurChatBrowser({client:f.browser.client,getPolicy:()=>f.policy,journalDir:f.dir});assert.equal((await restarted.sendMessage(stored.id,'收到啦',args)).deliveryUncertain,true);assert.equal(f.sends,1);f.policy.allowlist=[];await assert.rejects(restarted.readConversation(stored.id,{allowed:true}));});

test('后台发送授权未配置时保留原消息，授权恢复后只发送一次', async t => {
  const f = fixture(t);
  let writeConfigured = false;
  const originalCall = f.browser.client.call;
  f.browser.client.call = async (...args) => {
    const result = await originalCall(...args);
    return args[0] === 'check_login_status' ? { ...result, im_write_configured: writeConfigured } : result;
  };
  const snapshot = await f.browser.readConversation(stored.id, { allowed: true });
  let dispatches = 0;
  const authorize = () => true;
  authorize.beginDispatch = () => { dispatches++; return () => {}; };
  const args = {
    allowed: true, expectedContact: stored, expectedMessageIds: snapshot.messages.map(m => m.id),
    expectedMessageContent: messageWatermark(snapshot.messages, snapshot).content,
    expectedMessageEvidence: snapshot.dayEvidence, authorize,
  };
  const blocked = await f.browser.sendMessage(stored.id, '收到啦', args);
  assert.equal(blocked.deliveryUncertain, false);
  assert.equal(blocked.failureCode, 'MCP_IM_SEND_AUTHORIZATION_REQUIRED');
  assert.equal(dispatches, 0);
  assert.equal(f.sends, 0);
  assert.equal(fs.readdirSync(f.dir).some(name => name.endsWith('.json')), false);
  writeConfigured = true;
  assert.equal((await f.browser.sendMessage(stored.id, '收到啦', args)).confirmed, true);
  await f.browser.sendMessage(stored.id, '收到啦', args);
  assert.equal(dispatches, 1);
  assert.equal(f.sends, 1);
});

function attachmentFixture(t, { type, content, bytes }) {
  const f = fixture(t);
  const address = 'https://attachment.example.douyincdn.com/local-fixture?token=fixture-only-secret';
  const visited = [];
  f.browser.downloadAttachment = async (url, file, options) => {
    visited.push(url);
    assert.equal(url, address);
    assert.equal(options.trustedDouyinAttachment, true);
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { bytes: bytes.length };
  };
  const append = () => f.add({ ...row(3, 2, ''), message_type: type, content: content(address) });
  fs.writeFileSync(path.join(f.dir, 'chat-policy.json'), JSON.stringify({
    version: 1, enabled: true, allowlist: [stored], groupMentionNames: ['大肥鱼'],
  }));
  let modelCalls = 0, modelRequest;
  const config = { apiKey: 'synthetic-test-key' };
  const agent = new ChatAgent({ config, replyProvider: async request => {
    modelCalls++;
    modelRequest = request;
    return { text: '收到附件啦' };
  } });
  const service = new ChatService({ browser: f.browser, agent, config, stateDir: f.dir, fullScanIntervalMs: 0 });
  t.after(() => service.close());
  return { ...f, service, append, visited, get modelRequest() { return modelRequest; }, get modelCalls() { return modelCalls; } };
}

test('后台自动回复读出新文件正文，旧会话不补发且不会交出签名地址', async t => {
  const bytes = Buffer.from('样本正文：今年的工作计划从周二开始。');
  const f = attachmentFixture(t, { type: 6, bytes, content: address => ({
    name: '..\\周报.md', uri: address,
    md5: createHash('md5').update(bytes).digest('hex'),
  }) });
  await f.service.configure({ recipientIds: [stored.id], allowConversationOnly: true });
  await f.service.start({ schedule: false });
  assert.equal(f.modelCalls, 0);
  f.append();
  await f.service.poll();
  assert.equal(f.modelCalls, 0);
  f.add(row(4, 2, '@大肥鱼 帮我读一下刚才的文件'));
  await f.service.poll();
  assert.equal(f.modelCalls, 1);
  const request = JSON.stringify(f.modelRequest);
  assert.match(request, /今年的工作计划从周二开始/);
  assert.match(request, /周报\.md/);
  assert.doesNotMatch(request, /fixture-only-secret|douyincdn\.com/);
  assert.equal(f.visited.length, 1);
  assert.deepEqual(fs.readdirSync(f.browser.assetRoot), []);
});

test('后台读取 Word 正文，单独送出清理过的文字和截断标记', { skip: process.platform !== 'win32' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-docx-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archive = path.join(dir, 'fixture.zip');
  fs.mkdirSync(path.join(dir, 'word'));
  fs.writeFileSync(path.join(dir, 'word', 'document.xml'),
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
    <w:p><w:r><w:t>周报 &amp; 纪要</w:t></w:r></w:p><w:p><w:r><w:t>${'测'.repeat(8100)}</w:t></w:r></w:p></w:body></w:document>`);
  assert.equal(spawnSync('tar', ['-a', '-cf', archive, '-C', dir, 'word/document.xml'], { windowsHide: true }).status, 0);
  const f = attachmentFixture(t, { type: 6, bytes: fs.readFileSync(archive),
    content: address => ({ name: '周报.docx', resource_url: { url_list: [address] } }) });
  f.append();
  const { messages } = await f.service.readConversation(stored.id);
  const result = await f.service.observeMessage(stored.id, messages.at(-1).id);
  assert.equal(result.understandingScope, 'single-message-file-text');
  assert.match(result.fileText.text, /^周报 & 纪要\n/);
  assert.equal(result.fileText.text.length, 8000);
  assert.equal(result.fileText.truncated, true);
  assert.deepEqual(fs.readdirSync(f.browser.assetRoot), []);
});

test('后台视频附件使用正片抽取三帧，跳过封面和无关会话', async t => {
  const bytes = fs.readFileSync(new URL('./fixtures/headless-progress.mp4', import.meta.url));
  const f = attachmentFixture(t, { type: 30, bytes, content: address => ({
    poster: { oid: 'https://cover.example.douyincdn.com/thumbnail.jpg' }, video: { play_addr: { url_list: [address] } },
  }) });
  f.append();
  const { messages } = await f.service.readConversation(stored.id);
  const id = messages.at(-1).id;
  await assert.rejects(f.service.observeMessage('other-conversation', id), /白名单/);
  await assert.rejects(f.service.observeMessage(stored.id, 'other-message'), /指定消息/);
  const result = await f.service.observeMessage(stored.id, id);
  assert.equal(result.understandingScope, 'single-message-video-samples');
  assert.equal(result.frames.length, 3);
  assert.ok(result.frames.every(frame => Buffer.from(frame.data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))));
  assert.equal(new Set(result.frames.map(frame => frame.time)).size, 3);
  assert.ok(result.frames.every(frame => frame.time < result.videoAttachment.durationSeconds));
  assert.equal(f.visited.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture-only-secret|douyincdn\.com/);
  assert.deepEqual(fs.readdirSync(f.browser.assetRoot), []);
});

test('视频只有封面和平台内部引用时，文字聊天照常继续', async t => {
  const f = attachmentFixture(t, { type: 30, bytes: Buffer.alloc(0), content: () => ({
    text: '@大肥鱼 帮我看看', poster: { oid: 'https://cover.example.douyincdn.com/thumbnail.jpg' },
    video: { tkey: 'opaque-resource', play_url: 'https://example.org/video' },
  }) });
  await f.service.configure({ recipientIds: [stored.id], allowConversationOnly: true });
  await f.service.start({ schedule: false });
  f.append();
  await f.service.poll();
  assert.equal(f.modelCalls, 1);
  assert.deepEqual(f.visited, []);
  assert.match(JSON.stringify(f.modelRequest), /visible-message-metadata-only/);
});
