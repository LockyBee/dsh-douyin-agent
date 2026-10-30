import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ChatService} from '../chat-service.mjs';
const incoming=(id,text)=>({id,text,sender:'incoming',eligibleForReply:true,arrivalClassification:'new-tail'});
function fixture(t,{blockModel=true}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-chat-recovery-'));const contact={id:`conv:${'a'.repeat(64)}`,name:'合成恢复联系人',followed:null,relationshipStatus:'unavailable',isGroup:false,identityVerified:true,identityBinding:`binding:${'b'.repeat(64)}`,identityVersion:2,identityKind:'rendered-user',identityHash:'a'.repeat(64)};
  const messages=[incoming('old','合成旧基线')],sent=[],requests=[],entered=Promise.withResolvers();let calls=0;
  const browser={listContacts:async()=>({contacts:[structuredClone(contact)]}),readConversation:async()=>({conversation:{id:contact.id,isGroup:false},contact:structuredClone(contact),messages:structuredClone(messages)}),sendMessage:async(id,text,{signal})=>{signal.throwIfAborted();sent.push({id,text});return{confirmed:true,messageId:`sent-${sent.length}`};}};
  const agent={replyTokens:512,reply:async value=>{requests.push({...value,messages:structuredClone(value.messages)});calls++;if(blockModel&&calls===1){entered.resolve();return new Promise((resolve,reject)=>value.signal.addEventListener('abort',()=>reject(value.signal.reason),{once:true}));}return{text:'合成恢复回复'};}};
  const options={browser,agent,config:{apiKey:'synthetic-recovery'},stateDir:directory};const service=new ChatService(options),instances=[service];
  t.after(async()=>{for(const instance of instances)await instance.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^douyin-chat-recovery-/);fs.rmSync(directory,{recursive:true,force:true});});
  return{directory,contact,messages,sent,requests,entered,browser,agent,service,other:()=>{const other=new ChatService(options);instances.push(other);return other;}};
}
async function start(f){await f.service.configure({recipientIds:[f.contact.id],allowConversationOnly:true});await f.service.start({schedule:false});}
async function interrupt(f,preservePending=true){f.messages.push(incoming('known-new','合成已核对新问题'));const polling=f.service.poll();await f.entered.promise;f.service.stop({preservePending,reason:preservePending?'settings-update':'user-stop'});await polling;}

test('名单维护恢复已合格且未发送的消息，不删除seen、不伪造baseline资格，不重复上下文',async t=>{
  const f=fixture(t);await start(f);await interrupt(f);const before=f.service.watermarks.contacts[f.contact.id].seen.slice();assert.ok(before.includes('known-new'));assert.equal(f.service.state().recovery.recoverableCount,1);
  f.messages.at(-1).eligibleForReply=false;f.messages.at(-1).arrivalClassification='baseline';await f.service.start({schedule:false});assert.equal(f.service.state().recovery.recoverableCount,1);assert.deepEqual(f.service.watermarks.contacts[f.contact.id].seen,before);
  await f.service.poll();await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.requests.length,2);assert.deepEqual(f.requests[1].messages.map(item=>item.id),['known-new']);assert.equal(f.requests[1].messages[0].eligibleForReply,false);assert.ok(f.service.watermarks.contacts[f.contact.id].seen.includes('known-new'));assert.equal(f.service.state().recovery.recoverableCount,0);assert.equal(f.service.state().recovery.pendingManualCount,0);
});

test('主动关闭不绕过证据门槛，旧待答进入自动队列且仍处理未来真正新消息',async t=>{
  const f=fixture(t);await start(f);await interrupt(f,false);await f.service.start({schedule:false});await f.service.poll();assert.equal(f.requests.length,1);assert.equal(f.sent.length,0);assert.equal(f.service.state().recovery.autoPendingCount,1);
  f.messages.push(incoming('later-new','合成下一条真正新消息'));await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.requests.length,2);assert.equal(f.service.state().recovery.autoPendingCount,1);
});

test('维护后已经离线时显式关闭仍撤销恢复队列，再上线不补旧待答',async t=>{
  const f=fixture(t);await start(f);await interrupt(f);assert.equal(f.service.state().recovery.recoverableCount,1);const other=f.other();other.stop({preservePending:false,reason:'master-off'});await other.start({schedule:false});await other.poll();assert.equal(f.requests.length,1);assert.equal(f.sent.length,0);assert.equal(other.state().recovery.autoPendingCount,1);
});

test('旧维护恢复资格仍限五分钟，独立补答证据不足时留自动队列',async t=>{
  const f=fixture(t);await start(f);await interrupt(f);const mark=f.service.watermarks.contacts[f.contact.id];mark.pending.recoveryExpiresAt=Date.now()-1;fs.writeFileSync(f.service.watermarkFile,JSON.stringify(f.service.watermarks));await f.service.start({schedule:false});await f.service.poll();assert.equal(f.sent.length,0);assert.equal(f.requests.length,1);assert.equal(f.service.state().recovery.autoPendingCount,1);assert.equal(f.service.state().recovery.recoverableCount,0);
});

test('owner未处理较新的跨入口主动停止就退出时，残留维护资格也不能补发',async t=>{
  const f=fixture(t);await start(f);await interrupt(f);fs.writeFileSync(f.service.stopFile,JSON.stringify({targetRunId:'synthetic-old-owner',requestId:'new-user-stop',preservePending:false,reason:'master-off'}));await f.service.start({schedule:false});await f.service.poll();assert.equal(f.sent.length,0);assert.equal(f.requests.length,1);assert.equal(f.service.state().recovery.autoPendingCount,1);
});

test('历史主动停止请求不永久阻止其后新到达消息的维护恢复',async t=>{
  const f=fixture(t);fs.writeFileSync(f.service.stopFile,JSON.stringify({targetRunId:'synthetic-prior-owner',requestId:'old-user-stop',preservePending:false}));await start(f);await interrupt(f);await f.service.start({schedule:false});await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.requests.length,2);assert.equal(f.service.state().recovery.pendingManualCount,0);
});

test('设置锁先落盘而stop尚未调用时，poll按维护暂停保留恢复资格',async t=>{
  const f=fixture(t);await start(f);f.messages.push(incoming('known-new','合成设置锁竞态'));const polling=f.service.poll();await f.entered.promise;const guard=path.join(f.directory,'friend-interactions-settings.guard');fs.writeFileSync(guard,JSON.stringify({pid:process.pid,token:'synthetic-settings'}));await f.service.poll();await polling;assert.equal(f.service.state().recovery.recoverableCount,1);fs.unlinkSync(guard);await f.service.start({schedule:false});await f.service.poll();assert.equal(f.sent.length,1);
});

test('设置锁与真正master关闭同时存在时，用户关闭优先，不保留自动补发',async t=>{
  const f=fixture(t);await start(f);f.messages.push(incoming('known-new','合成关闭优先'));const polling=f.service.poll();await f.entered.promise;const guard=path.join(f.directory,'friend-interactions-settings.guard');fs.writeFileSync(guard,JSON.stringify({pid:process.pid,token:'synthetic-settings'}));fs.writeFileSync(path.join(f.directory,'friend-interactions-policy.json'),JSON.stringify({version:1,enabled:false}));await f.service.poll();await polling;assert.equal(f.service.state().recovery.recoverableCount,0);fs.unlinkSync(guard);fs.writeFileSync(path.join(f.directory,'friend-interactions-policy.json'),JSON.stringify({version:1,enabled:true}));await f.service.start({schedule:false});await f.service.poll();assert.equal(f.sent.length,0);assert.equal(f.service.state().recovery.autoPendingCount,1);
});

test('模型完成后遇设置锁但stop尚未来得及调用时，未进入发送的待答仍可维护恢复',async t=>{
  const f=fixture(t,{blockModel:false}),guard=path.join(f.directory,'friend-interactions-settings.guard');let calls=0;f.agent.reply=async()=>{if(++calls===1)fs.writeFileSync(guard,JSON.stringify({pid:process.pid,token:'synthetic-settings'}));return{text:'合成回复'};};await start(f);f.messages.push(incoming('known-new','合成派发前维护'));await f.service.poll();assert.equal(f.sent.length,0);assert.equal(f.service.state().recovery.recoverableCount,1);f.service.stop({preservePending:true,reason:'settings-update'});fs.unlinkSync(guard);await f.service.start({schedule:false});await f.service.poll();assert.equal(f.sent.length,1);assert.equal(calls,2);
});

test('浏览器prepare尚未开始输入时遇维护，保留已证明未发送的队列',async t=>{
  const f=fixture(t,{blockModel:false}),guard=path.join(f.directory,'friend-interactions-settings.guard');let attempts=0;f.browser.sendMessage=async(id,text,{authorize})=>{if(++attempts===1)fs.writeFileSync(guard,JSON.stringify({pid:process.pid,token:'synthetic-settings'}));authorize({recipientId:id,phase:'prepare'});f.sent.push({id,text});return{confirmed:true,messageId:'sent-recovered'};};await start(f);f.messages.push(incoming('known-new','合成输入前维护'));await f.service.poll();assert.equal(f.sent.length,0);assert.equal(f.service.state().contacts[0].status,'ready');assert.equal(f.service.state().recovery.recoverableCount,1);f.service.stop({preservePending:true,reason:'settings-update'});fs.unlinkSync(guard);await f.service.start({schedule:false});await f.service.poll();assert.equal(f.sent.length,1);
});

test('未知incoming附件保留自动等待元数据但不编造文本，明确撤回或系统通知不生成待答',async t=>{
  const f=fixture(t,{blockModel:false});await start(f);f.messages.push({...incoming('unknown-media',''),kind:'unsupported',unsupported:true});await f.service.poll();assert.equal(f.sent.length,0);assert.equal(f.service.state().recovery.autoPendingCount,1);const item=f.service.state().contacts[0].unanswered[0].incoming[0];assert.equal(item.id,'unknown-media');assert.equal(item.text,undefined);assert.equal(item.unsupported,true);
  f.messages.push({...incoming('recalled',''),kind:'recalled',unsupported:true},{...incoming('system',''),kind:'system',unsupported:true});await f.service.poll();assert.equal(f.service.state().recovery.autoPendingCount,1);assert.equal(f.sent.length,0);
  f.messages.push(incoming('later-normal','合成下一条文字'));await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.service.state().recovery.autoPendingCount,1);
});

test('维护待答内容被改、撤回、后续已有本人回复或窗口变动时不补发',async t=>{
  for(const mutate of [f=>f.messages.at(-1).text='合成修改正文',f=>f.messages.pop(),f=>f.messages.push({id:'human-after',text:'合成本人已回复',sender:'outgoing',eligibleForReply:true}),f=>f.messages.unshift(incoming('loaded-history','合成补载旧窗口'))]){
    const f=fixture(t);await start(f);await interrupt(f);mutate(f);await f.service.start({schedule:false});await f.service.poll();assert.equal(f.sent.length,0);assert.equal(f.requests.length,1);assert.equal(f.service.state().recovery.autoPendingCount,1);assert.equal(f.service.state().recovery.recoverableCount,0);
  }
});

test('维护等待期间联系人绑定改变时不恢复服务或扩大许可',async t=>{
  const f=fixture(t);await start(f);await interrupt(f);f.contact.identityBinding=`binding:${'c'.repeat(64)}`;await assert.rejects(f.service.start({schedule:false}),/身份|关系/);assert.equal(f.requests.length,1);assert.equal(f.sent.length,0);
});

test('旧版pending缺少完整资格证据，只归自动等待，后续新消息照常回复',async t=>{
  const f=fixture(t,{blockModel:false});await start(f);const mark=f.service.watermarks.contacts[f.contact.id];mark.status='paused';mark.reason='合成旧停止原因';mark.pending={phase:'stopped-before-send',incoming:[{id:'old-pending',text:'合成旧待答'}],restartAllowed:true};f.service.persist();f.service.stop({preservePending:true,reason:'settings-update'});
  await f.service.start({schedule:false});assert.equal(f.service.state().contacts[0].status,'ready');assert.equal(f.service.state().recovery.autoPendingCount,1);await f.service.poll();assert.equal(f.sent.length,0);f.messages.push(incoming('actual-new','合成后来新消息'));await f.service.poll();assert.equal(f.sent.length,1);
});

test('运行中的旧paused联系人保留自动待答审计且继续接收新消息，旧手动接口仍可结案',async t=>{
  const f=fixture(t,{blockModel:false});await start(f);const mark=f.service.watermarks.contacts[f.contact.id];mark.status='paused';mark.pending={phase:'model',incoming:[{id:'older-pending',text:'合成旧未答'}]};f.service.persist();f.messages.push(incoming('actual-new','合成当前新消息'));await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.service.state().recovery.autoPendingCount,1);
  f.service.stop();const before=f.service.state().contacts[0].unanswered.length;f.service.resumeContact(f.contact.id);const state=f.service.state();assert.equal(state.recovery.pendingManualCount,0);assert.equal(state.contacts[0].unanswered.length,before);assert.ok(state.contacts[0].unanswered.every(item=>item.handledByUserAt));
});

test('正常取消无待答的只读检查不谎报有未答消息或暂停联系人',async t=>{
  const f=fixture(t,{blockModel:false});await start(f);const entered=Promise.withResolvers(),release=Promise.withResolvers(),read=f.browser.readConversation;f.browser.readConversation=async(...args)=>{entered.resolve();await release.promise;return read(...args);};const polling=f.service.poll();await entered.promise;f.service.stop();release.resolve();await polling;assert.equal(f.service.state().contacts[0].status,'ready');assert.equal(f.service.state().contacts[0].reason,'');assert.equal(f.service.state().recovery.pendingManualCount,0);assert.equal(f.sent.length,0);
});

test('跨入口维护停止保留恢复参数，owner结束后另一个入口可核对恢复',async t=>{
  const f=fixture(t);await start(f);f.messages.push(incoming('known-new','合成跨入口新问题'));const polling=f.service.poll();await f.entered.promise;const other=f.other();assert.equal(other.stop({preservePending:true,reason:'settings-update'}).stopping,true);await polling;assert.equal(other.state().recovery.recoverableCount,1);await other.start({schedule:false});await other.poll();assert.equal(f.sent.length,1);assert.equal(f.requests.length,2);
});

test('进入发送适配器后的中断进入自动读回，重启可接新消息但不能盲重发',async t=>{
  const f=fixture(t,{blockModel:false}),entered=Promise.withResolvers();f.browser.sendMessage=async(id,text,{signal})=>{entered.resolve();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};await start(f);f.messages.push(incoming('known-new','合成待发送'));const polling=f.service.poll();await entered.promise;f.service.stop({preservePending:true,reason:'settings-update'});await polling;assert.equal(f.service.state().contacts[0].status,'auto-readback');await f.service.start({schedule:false});await f.service.poll();assert.equal(f.requests.length,1);assert.equal(f.sent.length,0);assert.ok(f.service.watermarks.contacts[f.contact.id].unanswered.some(item=>item.phase==='sending'||item.phase==='delivery-uncertain'));assert.equal(f.service.state().recovery.pendingManualCount,0);assert.ok(f.service.state().recovery.autoPendingCount>0);
});
