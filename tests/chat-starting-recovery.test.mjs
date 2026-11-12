import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatService } from '../chat-service.mjs';
import { FriendInteractions } from '../friend-interactions.mjs';

function fixture(t) {
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-starting-recovery-'));
  const contact={id:`conv:${'1'.repeat(64)}`,name:'合成许可联系人',followed:true,isGroup:false,identityVerified:true,identityBinding:`binding:${'2'.repeat(64)}`,identityVersion:2,identityKind:'rendered-user',identityHash:'1'.repeat(64)};
  const browser={listContacts:async()=>({contacts:[contact]}),readConversation:async()=>({conversation:{id:contact.id},contact,messages:[]}),sendMessage:async()=>assert.fail('启动检查不得发送消息')};
  const service=new ChatService({browser,agent:{replyTokens:512},config:{apiKey:'synthetic-only',model:'deepseek-flash',baseUrl:'https://api.deepseek.com'},stateDir});
  t.after(async()=>{await service.close();assert.equal(path.dirname(stateDir),os.tmpdir());fs.rmSync(stateDir,{recursive:true,force:true});});
  return {service,stateDir,contact};
}

test('退出进程留下的启动记录不能让新入口一直等待',t=>{
  const {service,stateDir}=fixture(t);
  const file=path.join(stateDir,'chat-loop.lock'),raw=JSON.stringify({pid:2147483647,runId:'synthetic-exited-worker',status:'starting',heartbeatAt:'2000-01-01T00:00:00.000Z'});
  fs.writeFileSync(file,raw);
  const state=service.state();assert.equal(state.worker.alive,false);assert.equal(state.starting,false);assert.equal(state.running,false);assert.equal(fs.readFileSync(file,'utf8'),raw);
});

test('仍存活的其他入口正在启动时不能启动第二个回复进程',t=>{
  const {service,stateDir}=fixture(t);fs.writeFileSync(path.join(stateDir,'chat-loop.lock'),JSON.stringify({pid:process.pid,runId:'synthetic-live-worker',status:'starting',heartbeatAt:new Date().toISOString()}));
  const state=service.state();assert.equal(state.worker.alive,true);assert.equal(state.starting,true);assert.throws(()=>service.acquire(),/另一个入口/);
});

test('本地启动尚未落锁时仍展示启动中',t=>{
  const {service}=fixture(t);service.starting=Promise.resolve();assert.equal(service.state().starting,true);service.starting=null;
});

test('退出进程的旧锁不会阻断好友总开关自动恢复回复',async t=>{
  const {service,stateDir,contact}=fixture(t);await service.configure({recipientIds:[contact.id]});
  fs.writeFileSync(path.join(stateDir,'chat-loop.lock'),JSON.stringify({pid:2147483647,runId:'synthetic-exited-worker',status:'starting',heartbeatAt:'2000-01-01T00:00:00.000Z'}));
  let starts=0;const friend=new FriendInteractions({stateDir,getChat:()=>service,getShare:()=>({state:()=>({enabled:true}),configure:async()=>{}}),modelReady:()=>true,startChat:async chat=>{starts++;return chat.start({schedule:false});}});
  t.after(()=>friend.close());await friend.reconcile();assert.equal(starts,1);assert.equal(service.state().running,true);assert.equal(friend.state().status,'running');
});
