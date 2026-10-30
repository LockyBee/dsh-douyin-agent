import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ChatService} from '../chat-service.mjs';
import {VideoLimits} from '../video-limits.mjs';
import {MessageIdentityTracker} from '../message-tracker.mjs';

for(const isGroup of [false,true])for(const scenario of ['时段外','观看预算耗尽']){
 test('普通'+(isGroup?'群@':'私信')+'在'+scenario+'仍正常回复，视频限制和聊天许可分别生效',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-chat-all-day-'));
  const limits=new VideoLimits({stateDir:directory,now:()=>Date.parse(scenario==='时段外'?'2026-10-28T04:00:00Z':'2026-10-28T12:00:00Z')});
  limits.savePolicy({...limits.policy(),enabled:true,windows:['18:00-24:00'],dailyMinutes:1,dailyRequests:1},{explicit:true});
  if(scenario==='观看预算耗尽'){const started=limits.markSession('api',{explicit:true});limits.reserveRequest({source:'api',sessionId:started.session.id});}
  assert.equal(limits.beforeAction('api','douyin_open_video').allowed,false);
  const videoBefore=JSON.stringify(limits.state().daily);
  const contact={id:'conv:'+'a'.repeat(64),name:'合成全天会话',isGroup,followed:isGroup?null:true,identityVersion:2,identityKind:isGroup?'rendered-conversation':'rendered-user',identityHash:'a'.repeat(64),identityVerified:true,identityBinding:'binding:'+'b'.repeat(64)};
  const tracker=new MessageIdentityTracker(),rows=[{nativeId:'1111111111111111111',text:'合成启动前旧消息',sender:'incoming',direction:'incoming',kind:'text',order:0,orderMode:'relative',latestEndVerified:true}];
  const sent=[],calls=[];
  const browser={
   listContacts:async()=>({contacts:[contact]}),
   readConversation:async()=>({conversation:{id:contact.id,isGroup},contact:structuredClone(contact),dayEvidence:{chronology:'oldest-first',latestEndVerified:true},messages:tracker.identify(contact.id,structuredClone(rows))}),
   sendMessage:async(id,text,options)=>{options.signal.throwIfAborted();options.authorize({recipientId:id,phase:'prepare'});sent.push({id,text});return{confirmed:true,messageId:'synthetic-all-day-send'};},
  };
  const service=new ChatService({stateDir:directory,browser,config:{apiKey:'synthetic-only',model:'synthetic'},agent:{replyTokens:512,reply:async input=>{calls.push(input);return{text:'小鱼在呢。'};}}});
  service.videoInspector=async()=>assert.fail('普通聊天不应进入视频播放或时段检查');
  t.after(async()=>{await service.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^douyin-chat-all-day-/);fs.rmSync(directory,{recursive:true,force:true});});
  await service.configure({recipientIds:[contact.id],allowConversationOnly:isGroup,groupMentionNames:['大肥鱼']});
  await service.start({schedule:false});
  rows.push({nativeId:'2222222222222222222',text:isGroup?'@合成群昵称 现在在线吗':'现在在线吗',sender:'incoming',direction:'incoming',kind:'text',order:1,orderMode:'relative',latestEndVerified:true,...(isGroup?{mentionedSelf:true}:{})});
  await service.poll();await service.poll();
  assert.equal(calls.length,1);assert.equal(sent.length,1);assert.equal(sent[0].id,contact.id);
  assert.equal(JSON.stringify(limits.state().daily),videoBefore,'聊天不能重置或增加视频额度');
  if(isGroup){
   rows.push({nativeId:'3333333333333333333',text:'@其他成员 你好',sender:'incoming',direction:'incoming',kind:'text',order:2,orderMode:'relative',latestEndVerified:true,mentionedSelf:false});
   await service.poll();assert.equal(calls.length,1);assert.equal(sent.length,1,'全天回复仍只响应本人@或设定昵称');
  }
 });
}
