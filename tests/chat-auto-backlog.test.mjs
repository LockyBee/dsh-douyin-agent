import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ChatService} from '../chat-service.mjs';import {ChatAgent} from '../chat-agent.mjs';import {messageFingerprint,messageContent,mapBacklogMessages,backlogOutgoingReadback,qualifyNativeUnanswered} from '../chat-message.mjs';
const incoming=(id,text=id)=>({id,text,sender:'incoming',direction:'incoming',kind:'text',identitySource:'dom-message-id',eligibleForReply:false,arrivalClassification:'known-old-window',latestEndVerified:true,timestamp:new Date(Date.now()-240_000).toISOString(),dateEvidence:{kind:'absolute'}});
function archive(contact,messages,{legacy=false,id='archive-1',generatedText='小鱼收到啦。',phase='not-sent',beforeDispatch=true,targetIndex=messages.length-1}={}){
 const original=messages.map((item,index)=>({...structuredClone(item),...(legacy?{id:'legacy-'+id+'-'+index,identitySource:'chronological-window-overlap'}:{})})),target=original[targetIndex];
 return{archiveId:id,phase,generatedText,at:new Date(Date.now()-180_000).toISOString(),skippedAt:new Date(Date.now()-120_000).toISOString(),incoming:[structuredClone(target)],recoveryEvidence:{version:1,beforeDispatch,contact:structuredClone(contact),qualifiedIncoming:[{message:structuredClone(target),fingerprint:messageFingerprint(target),qualified:true,originalEligibleForReply:true}],expectedContent:messageContent(original)}};
}
async function fixture(t,{group=true,mode='confirmed',generatedText='小鱼收到啦。',legacy=false}={}){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-auto-backlog-'));
 const contact={id:'conv:'+'4'.repeat(64),name:'合成许可会话',isGroup:group,followed:group?null:true,relationshipStatus:'unavailable',identityVersion:2,identityKind:group?'rendered-conversation':'rendered-user',identityHash:'4'.repeat(64),identityBinding:'binding:'+'5'.repeat(64),identityVerified:true};
 const messages=[incoming('native-a','前文甲'),incoming('native-b','前文乙'),incoming('native-target',group?'大肥鱼，能回话吗':'能回话吗')],requests=[],calls=[],sent=[];let reads=0,deliveryMode=mode,modelFailure=false;
 const browser={listContacts:async()=>({contacts:[structuredClone(contact)]}),unreadCounts:async()=>({available:true,counts:{}}),readConversation:async()=>{reads++;return{contact:structuredClone(contact),conversation:{id:contact.id,isGroup:group},messages:structuredClone(messages),dayEvidence:{chronology:'oldest-first',latestEndVerified:true}};},sendMessage:async(id,text,args)=>{calls.push({id,text,args});assert.equal(args.authorize({recipientId:id,phase:'prepare'}),true);if(deliveryMode==='zero-click')return{confirmed:false,deliveryUncertain:false,failureCode:'CHAT_SEND_BUTTON_UNAVAILABLE'};assert.equal(args.authorize({recipientId:id,phase:'before-click'}),true);const release=args.authorize.beginDispatch();release();sent.push({id,text});if(deliveryMode==='uncertain')return{confirmed:false,deliveryUncertain:true};const outgoing={...incoming('sent-'+sent.length,text),sender:'outgoing',direction:'outgoing',timestamp:new Date().toISOString()};messages.push(outgoing);return{confirmed:true,messageId:outgoing.id};},close:async()=>{}};
 const agent={replyTokens:512,reply:async value=>{requests.push({...value,messages:structuredClone(value.messages)});if(modelFailure)throw new Error('合成临时模型故障');return{text:'当前上下文的合成人格回复。'};}};
 const service=new ChatService({browser,agent,stateDir:directory,config:{apiKey:'synthetic-key',model:'synthetic'}});
 await service.configure({recipientIds:[contact.id],allowConversationOnly:group,groupMentionNames:['大肥鱼']});await service.start({schedule:false});
 const authorized=service.policy.allowlist[0],mark=()=>service.watermarks.contacts[contact.id];mark().unanswered.push(archive(authorized,messages,{generatedText,legacy}));service.persist();
 t.after(async()=>{await service.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^douyin-auto-backlog-/);fs.rmSync(directory,{recursive:true,force:true});});
 return{directory,contact,authorized,messages,requests,calls,sent,browser,agent,service,mark,reads:()=>reads,mode:value=>deliveryMode=value,failModel:value=>modelFailure=value,due:()=>{if(mark().autoBacklog)mark().autoBacklog.nextRetryAt=new Date(0).toISOString();service.persist();}};
}

function nativeMiss(contact) {
 const now=Date.now(),created=new Date(now-20_000).toISOString(),target={...incoming('native-late','合成的新私信'),arrivalClassification:'ambiguous-new',nativeServerMessageBound:true,nativeCreatedAt:created,timestamp:created};
 const messages=[incoming('native-before-a'),incoming('native-before-b'),target],mark={startedAt:new Date(now-60_000).toISOString(),context:structuredClone(messages)},record={archiveId:'native-archive',phase:'unqualified',at:new Date(now-19_000).toISOString(),incoming:[{id:target.id,text:target.text}]},snapshot={dayEvidence:{chronology:'oldest-first',latestEndVerified:true}};
 return {now,target,messages,mark,record,snapshot,contact};
}
test('原生漏回资格：创建于观测基线之后且发送前归档，可恢复而不伪造原资格',()=>{
 const f=nativeMiss({isGroup:false}),evidence=qualifyNativeUnanswered(f.record,f.mark,f.messages,f.snapshot,f.contact,null,f.now);assert.ok(evidence);
 assert.equal(evidence.qualifiedIncoming[0].originalEligibleForReply,false);assert.equal(evidence.qualifiedIncoming[0].message.eligibleForReply,false);
 const record={...f.record,recoveryEvidence:evidence};assert.equal(mapBacklogMessages(record,f.messages).canSend,true);
 const changed=structuredClone(f.messages);changed.at(-1).nativeCreatedAt=new Date(f.now-30_000).toISOString();assert.equal(mapBacklogMessages(record,changed).ready,false);
});
test('原生漏回资格：展示时间、旧历史、内容变化、停止和发送不明均不能冒充新私信',()=>{
 for(const mutation of ['not-bound','display-only','before-baseline','after-detection','stale-detection','changed-body','wrong-prior','outgoing-after','group','stop','uncertain','handled','not-latest','wrong-direction','duplicate']){
  const f=nativeMiss({isGroup:false});let stop;
  if(mutation==='not-bound')f.target.nativeServerMessageBound=false;
  if(mutation==='display-only')delete f.target.nativeCreatedAt;
  if(mutation==='before-baseline')f.mark.startedAt=new Date(f.now-10_000).toISOString();
  if(mutation==='after-detection')f.record.at=new Date(f.now-30_000).toISOString();
  if(mutation==='stale-detection')f.record.at=new Date(f.now+41_000).toISOString();
  if(mutation==='changed-body')f.target.text='与存档不一样';
  if(mutation==='wrong-prior')f.mark.context.at(-1).id='其他编号';
  if(mutation==='outgoing-after')f.messages.push({...incoming('already-replied'),sender:'outgoing',direction:'outgoing'});
  if(mutation==='group')f.contact.isGroup=true;
  if(mutation==='stop')stop={preservePending:false,requestedAt:new Date(f.now-10_000).toISOString()};
  if(mutation==='uncertain')f.record.autoAttempt={state:'uncertain'};
  if(mutation==='handled')f.record.handledByUserAt=new Date().toISOString();
  if(mutation==='not-latest')f.snapshot.dayEvidence.latestEndVerified=false;
  if(mutation==='wrong-direction')f.target.direction='outgoing';
  if(mutation==='duplicate')f.messages.push(structuredClone(f.target));
  assert.equal(qualifyNativeUnanswered(f.record,f.mark,f.messages,f.snapshot,f.contact,stop,f.now),null,mutation);
 }
});
test('自动补答：原生新私信在运行中被误归档，按真实证据恢复并只发送一次',async t=>{
 const f=await fixture(t,{group:false}),miss=nativeMiss(f.authorized);f.messages.splice(0,f.messages.length,...miss.messages);Object.assign(f.mark(),miss.mark,{seen:miss.messages.map(message=>message.id),unanswered:[miss.record],autoBacklog:null});f.service.persist();
 await f.service.poll();await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.requests.length,1);assert.equal(miss.record.autoHandled,true);assert.equal(miss.record.recoveryEvidence.qualifiedIncoming[0].originalEligibleForReply,false);
});
test('自动补答：维护重启保留旧观测基线，恢复原生漏回而不清除旧水位',async t=>{
 const f=await fixture(t,{group:false}),miss=nativeMiss(f.authorized);f.messages.splice(0,f.messages.length,...miss.messages);Object.assign(f.mark(),miss.mark,{seen:miss.messages.map(message=>message.id),unanswered:[miss.record],autoBacklog:null});f.service.persist();
 f.service.stop({preservePending:true,reason:'maintenance'});await f.service.start({schedule:false});await f.service.poll();await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.mark().unanswered[0].autoHandled,true);assert.equal(f.mark().unanswered[0].recoveryEvidence.qualifiedIncoming[0].originalEligibleForReply,false);
});

test('补答pure：native目标和完整原上下文必须一致，不能只按单条ID放行',()=>{
 const contact={},messages=[incoming('a'),incoming('b'),incoming('t','大肥鱼你好')],record=archive(contact,messages);
 assert.equal(mapBacklogMessages(record,messages).canSend,true);
 const changed=structuredClone(messages);changed[1].text='上下文已变';assert.equal(mapBacklogMessages(record,changed).ready,false);
 const withdrawn=structuredClone(messages);withdrawn[2].text='撤回';assert.equal(mapBacklogMessages(record,withdrawn).ready,false);
});
test('补答pure：legacy仅以原完整连续后缀及相邻证据唯一映射native消息',()=>{
 const all=['p0','p1','p2','p3','a','b','大肥鱼问题'].map((text,index)=>incoming('n'+index,text)),record=archive({},all,{legacy:true});
 const current=all.slice(-3);const result=mapBacklogMessages(record,current);assert.equal(result.ready,true);assert.equal(result.targets[0].message.id,'n6');assert.equal(result.targets[0].context.offset,4);
 assert.equal(mapBacklogMessages(record,[current.at(-1)]).ready,false);assert.equal(mapBacklogMessages(record,[...current,...current.map((item,index)=>({...item,id:'copy'+index}))]).ready,false);
 const changed=structuredClone(current);changed[0].text='未知';assert.equal(mapBacklogMessages(record,changed).ready,false);
});
test('补答pure：目标后人工outgoing无绝对日期也禁止补发并可凭原生发出读回结案',()=>{
 const messages=[incoming('a'),incoming('b'),incoming('t','大肥鱼你好')],record=archive({},messages),out={...incoming('human','本人已答'),sender:'outgoing',direction:'outgoing'};delete out.dateEvidence;delete out.timestamp;
 const current=[...messages,out],mapping=mapBacklogMessages(record,current);assert.equal(mapping.canSend,false);assert.equal(backlogOutgoingReadback(record,mapping,current).id,'human');
 const pending=[...messages,{...out,pending:true}];assert.equal(mapBacklogMessages(record,pending).canSend,false);assert.equal(backlogOutgoingReadback(record,mapBacklogMessages(record,pending),pending),null);
});
test('补答pure：uncertain同文outgoing须唯一，多候选、pending或失败不假确认',()=>{
 const messages=[incoming('a'),incoming('b'),incoming('t','大肥鱼你好')],record=archive({},messages,{phase:'sending',beforeDispatch:false});
 const out=id=>({...incoming(id,'小鱼收到啦。'),sender:'outgoing',direction:'outgoing'});
 const multiple=[...messages,out('o1'),out('o2')];assert.equal(backlogOutgoingReadback(record,mapBacklogMessages(record,multiple),multiple,'小鱼收到啦。'),null);
 const single=[...messages,out('o1')];assert.equal(backlogOutgoingReadback(record,mapBacklogMessages(record,single),single,'小鱼收到啦。').id,'o1');assert.equal(mapBacklogMessages(record,single).canSend,false);
});

test('自动补答：启动后未读为0仍复用匹配人格回复一次，保留原archive审计和旧资格',async t=>{
 const f=await fixture(t),before=structuredClone(f.mark().unanswered[0]);await f.service.poll();await f.service.poll();
 assert.equal(f.requests.length,0);assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,'小鱼收到啦。');assert.equal(f.mark().unanswered.length,1);assert.equal(f.mark().unanswered[0].autoHandled,true);
 assert.deepEqual(f.mark().unanswered[0].recoveryEvidence,before.recoveryEvidence);assert.equal(f.mark().unanswered[0].handledByUserAt,undefined);assert.equal(f.service.state().recovery.autoPendingCount,0);assert.equal(f.service.state().recovery.pendingManualCount,0);
 assert.equal(f.service.outbound.history(f.contact.id).length,1);assert.ok(f.calls[0].args.expectedContact.identityHash);assert.equal(f.mark().unanswered[0].autoAttempt.state,'confirmed');
});
test('自动补答：个人私信同样全天补答，不接触视频时段或额度',async t=>{const f=await fixture(t,{group:false});await f.service.poll();assert.equal(f.sent.length,1);assert.equal(fs.existsSync(path.join(f.directory,'watch-budget.json')),false);assert.equal(fs.existsSync(path.join(f.directory,'video-usage.json')),false);});
test('自动补答：同来信跨phase重复归档合并一次发送并同时结案',async t=>{
 const f=await fixture(t);f.mark().unanswered.push({...structuredClone(f.mark().unanswered[0]),archiveId:'duplicate-phase',phase:'stopped-before-send'});f.service.persist();await f.service.poll();
 assert.equal(f.sent.length,1);assert.equal(f.mark().unanswered.every(item=>item.autoHandled===true),true);assert.equal(f.mark().unanswered[0].autoHandledProof.messageId,f.mark().unanswered[1].autoHandledProof.messageId);
});
test('自动补答：三条同群未答按当前上下文合并一次人格生成和发送',async t=>{
 const f=await fixture(t);const first=f.mark().unanswered[0];f.messages.push(incoming('t2','大肥鱼第二个问题'),incoming('t3','大肥鱼第三个问题'));
 f.mark().unanswered=[first,archive(f.authorized,f.messages.slice(0,-1),{id:'archive-2',legacy:true}),archive(f.authorized,f.messages,{id:'archive-3'})];f.mark().seen=f.messages.map(item=>item.id);f.service.persist();await f.service.poll();
 assert.equal(f.requests.length,1);assert.equal(f.sent.length,1);assert.equal(f.mark().unanswered.every(item=>item.autoHandled===true),true);assert.ok(f.requests[0].messages.some(item=>item.id==='native-target'));assert.ok(f.requests[0].messages.some(item=>item.id==='t2'));assert.equal(f.requests[0].messages.at(-1).id,'t3');
});
test('自动补答：known zero-click失败自动退避后重试，复用缓存不反复调用模型',async t=>{
 const f=await fixture(t,{mode:'zero-click'});await f.service.poll();assert.equal(f.sent.length,0);assert.equal(f.calls.length,1);assert.equal(f.service.state().recovery.autoRetryCount,1);await f.service.poll();assert.equal(f.calls.length,1);
 f.mode('confirmed');f.due();await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.calls.length,2);assert.equal(f.requests.length,0);
});
test('自动补答：uncertain只读回等待，重复轮询及重启都不盲重发',async t=>{
 const f=await fixture(t,{mode:'uncertain'});await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.mark().unanswered[0].autoAttempt.state,'uncertain');f.due();await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.mark().unanswered[0].autoHandled,undefined);assert.equal(f.service.state().recovery.pendingManualCount,0);
 f.service.stop({preservePending:true,reason:'settings-update'});await f.service.start({schedule:false});f.due();await f.service.poll();assert.equal(f.sent.length,1);
});
test('自动补答：uncertain后来出现唯一原生同文outgoing仅读回结案不再次发送',async t=>{
 const f=await fixture(t,{mode:'uncertain'});await f.service.poll();f.messages.push({...incoming('real-outgoing','小鱼收到啦。'),sender:'outgoing',direction:'outgoing'});f.due();await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.mark().unanswered[0].autoHandled,true);assert.equal(f.mark().unanswered[0].autoHandledProof.method,'uncertain-matching-native-outgoing');
});
test('自动补答：不明发送的同文多条outgoing不会任取结案',async t=>{
 const f=await fixture(t,{mode:'uncertain'});await f.service.poll();for(const id of ['o1','o2'])f.messages.push({...incoming(id,'小鱼收到啦。'),sender:'outgoing',direction:'outgoing'});f.due();await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.mark().unanswered[0].autoHandled,undefined);
});
test('自动补答：有真人outgoing或待发送outgoing时均不重复补答',async t=>{
 for(const pending of [false,true]){const f=await fixture(t);f.messages.push({...incoming('human','本人已经处理'),sender:'outgoing',direction:'outgoing',pending});f.due();await f.service.poll();assert.equal(f.sent.length,0);assert.equal(f.requests.length,0);assert.equal(f.mark().unanswered[0].autoHandled,pending?undefined:true);}
});
test('自动补答：模型暂态失败有界退避可再推进，同一上下文最多三次',async t=>{
 const f=await fixture(t,{generatedText:undefined});delete f.mark().unanswered[0].generatedText;f.failModel(true);f.service.persist();for(let i=0;i<5;i++){f.due();await f.service.poll();}assert.equal(f.requests.length,3);assert.equal(f.sent.length,0);
 f.messages.push(incoming('later-target','大肥鱼，换个新问题'));const next=archive(f.authorized,f.messages,{id:'new-context'});delete next.generatedText;f.mark().unanswered.push(next);f.mark().seen=f.messages.map(item=>item.id);f.failModel(false);f.due();await f.service.poll();assert.equal(f.requests.length,4);assert.equal(f.sent.length,1);
});
test('自动补答：有效十二条上下文保留旧@和最新真实incoming，不伪造用户指令',async t=>{
 const f=await fixture(t);delete f.mark().unanswered[0].generatedText;for(let i=0;i<15;i++)f.messages.push(incoming('later-'+i,'合成本群近况'+i));f.messages.push(incoming('later-at','大肥鱼请结合前面的提问'));f.mark().unanswered.push(archive(f.authorized,f.messages,{id:'latest-at',generatedText:undefined}));f.mark().seen=f.messages.map(item=>item.id);f.service.persist();
 let request;f.service.agent=new ChatAgent({config:{apiKey:'synthetic-key',model:'synthetic'},replyProvider:async input=>{request=input;return{text:'合成完整上下文回复。'};}});f.due();await f.service.poll();assert.equal(f.sent.length,1);assert.ok(request.messages.some(item=>typeof item.content==='string'&&item.content.includes('能回话吗')));assert.ok(request.messages.at(-1).content.includes('请结合前面的提问'));assert.equal(request.messages.length<=12,true);
});
test('自动补答：身份变化、未知方向、撤回或没有群触发证据时内部等待不发送',async t=>{
 for(const mutation of ['identity','unknown','changed','no-trigger']){const f=await fixture(t);if(mutation==='identity')f.contact.identityBinding='binding:'+'6'.repeat(64);if(mutation==='unknown')f.messages[1].sender=f.messages[1].direction='unknown';if(mutation==='changed')f.messages.at(-1).text='已经撤回';if(mutation==='no-trigger'){f.messages.at(-1).text='其他人的闲聊';f.mark().unanswered=[archive(f.authorized,f.messages)];f.service.persist();}await f.service.poll();assert.equal(f.sent.length,0,mutation);assert.equal(f.requests.length,0,mutation);assert.equal(f.service.state().recovery.pendingManualCount,0,mutation);}
});
test('自动补答：constructor、state和unanswered只读不会成为第二个发送者',async t=>{
 const f=await fixture(t);const reads=f.reads(),observer=new ChatService({stateDir:f.directory,config:{apiKey:''},agent:{reply:()=>{throw new Error('禁止模型')}},browser:{listContacts:()=>{throw new Error('禁止读取')},readConversation:()=>{throw new Error('禁止读取')},sendMessage:()=>{throw new Error('禁止发送')}}});observer.state();observer.unanswered();assert.equal(f.reads(),reads);assert.equal(f.sent.length,0);assert.equal(f.requests.length,0);
});
test('自动补答：不同legacy ID且上下文丢失的uncertain档阻止同来信safe档再发送',async t=>{
 const f=await fixture(t),safe=structuredClone(f.mark().unanswered[0]),uncertain=archive(f.authorized,f.messages,{id:'uncertain-other-process',legacy:true,phase:'sending',beforeDispatch:false});
 uncertain.recoveryEvidence.expectedContent[0].fingerprint=messageFingerprint(incoming('lost1','已消失的前文一'));uncertain.recoveryEvidence.expectedContent[1].fingerprint=messageFingerprint(incoming('lost2','已消失的前文二'));
 f.mark().unanswered=[uncertain,safe];f.service.persist();await f.service.poll();assert.equal(f.sent.length,0);assert.equal(f.mark().unanswered.some(item=>item.autoHandled===true),false);
});
test('自动补答：缺incoming的旧uncertain在启动归档后仍阻止旧backlog盲发',async t=>{
 const f=await fixture(t);f.service.stop({preservePending:true,reason:'settings-update'});f.mark().status='delivery-uncertain';f.mark().pending={phase:'sending',text:'缺身份的旧发送'};f.service.persist();await f.service.start({schedule:false});f.due();await f.service.poll();assert.equal(f.sent.length,0);assert.ok(f.mark().unanswered.some(item=>item.legacyUncertain===true));assert.equal(f.service.state().recovery.pendingManualCount,0);
});
test('自动补答：真实模型await期间撤权或取消以及最终回读出现新尾均无输入',async t=>{
 for(const mutation of ['master-off','cancel','new-tail']){const f=await fixture(t);delete f.mark().unanswered[0].generatedText;f.service.persist();f.service.agent.reply=async()=>{if(mutation==='master-off')fs.writeFileSync(path.join(f.directory,'friend-interactions-policy.json'),JSON.stringify({version:1,enabled:false}));if(mutation==='cancel')f.service.stop();if(mutation==='new-tail')f.messages.push(incoming('changed-after-model','大肥鱼另一个新问题'));return{text:'旧模型输出不应发'};};await f.service.poll();assert.equal(f.sent.length,0,mutation);assert.equal(f.mark().unanswered[0].autoHandled,undefined,mutation);}
});
test('自动补答：三次临时模型故障后窗口过去会自动重算，不清真实每日计数',async t=>{
 const f=await fixture(t);delete f.mark().unanswered[0].generatedText;f.failModel(true);f.service.persist();for(let i=0;i<4;i++){f.due();await f.service.poll();}assert.equal(f.requests.length,3);const date=f.service.state().daily.date,before=f.service.state().daily.requests;f.failModel(false);for(const value of Object.values(f.mark().autoBacklog.generationContexts))value.windowStartedAt=Date.now()-31*60_000;f.due();await f.service.poll();assert.equal(f.requests.length,4);assert.equal(f.sent.length,1);assert.equal(f.service.state().daily.requests,before+1);assert.equal(f.service.watermarks.days[date],before+1);
});
test('自动补答：正常活worker的inflight仍保留发送保护状态',async t=>{
 const f=await fixture(t),entered=Promise.withResolvers(),done=Promise.withResolvers();f.browser.sendMessage=async()=>{entered.resolve();return done.promise;};const poll=f.service.poll();await entered.promise;assert.equal(f.service.state().contacts[0].status,'inflight');done.resolve({confirmed:false,deliveryUncertain:false});await poll;
});
test('自动补答：superseded归档混有普通群消息时只选原@目标，保留原始审计',async t=>{
 const f=await fixture(t);delete f.mark().unanswered[0].generatedText;f.messages.push(incoming('plain-followup','成员普通闲聊'));const record=archive(f.authorized,f.messages,{phase:'superseded',targetIndex:2,generatedText:undefined});const plain=structuredClone(f.messages.at(-1));record.incoming.push(plain);record.recoveryEvidence.qualifiedIncoming.push({message:plain,fingerprint:messageFingerprint(plain),qualified:true,originalEligibleForReply:true});f.mark().unanswered=[record];f.mark().seen=f.messages.map(item=>item.id);const before=structuredClone(record.recoveryEvidence);f.service.persist();await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.requests.length,1);assert.equal(f.requests[0].messages.at(-1).id,'native-target');assert.ok(!f.requests[0].messages.some(item=>item.id==='plain-followup'));assert.deepEqual(record.recoveryEvidence,before);assert.equal(record.autoHandled,true);
});
test('自动补答：确认回执已落盘但结案前崩溃且原DOM窗口消失，凭关联共同回执结案不重发',async t=>{
 const f=await fixture(t);await f.service.poll();assert.equal(f.sent.length,1);const mark=f.mark(),record=mark.unanswered[0];delete record.autoHandled;delete record.autoHandledAt;delete record.autoHandledBy;delete record.autoHandledProof;record.autoAttempt.state='reserved';mark.autoBacklog.state='sending';f.service.persist();f.service.stop({preservePending:true,reason:'maintenance'});f.messages.splice(0,f.messages.length,incoming('new-a','窗口后的甲'),incoming('new-b','窗口后的乙'),incoming('new-c','窗口后的丙'));await f.service.start({schedule:false});f.due();await f.service.poll();assert.equal(f.sent.length,1);assert.equal(f.mark().unanswered[0].autoHandled,true);assert.equal(f.mark().unanswered[0].autoHandledProof.method,'persisted-platform-and-outbound-receipt');assert.equal(f.requests.length,0);
});
test('自动补答：持久结案必须同时具有共同账本和未变更来源证明，缺任意一项只能等待读回',async t=>{
 for(const mutation of ['ledger','source','target']){const f=await fixture(t);await f.service.poll();const record=f.mark().unanswered[0];delete record.autoHandled;delete record.autoHandledAt;record.autoAttempt.state='reserved';if(mutation==='ledger')fs.writeFileSync(path.join(f.directory,'outbound-receipts.json'),JSON.stringify({version:1,receipts:[]}));if(mutation==='source')record.recoveryEvidence.qualifiedIncoming[0].message.text='被改写的来源';if(mutation==='target')record.autoAttempt.targets[0].id='不同目标';f.messages.splice(0,f.messages.length,incoming('next-a'),incoming('next-b'),incoming('next-c'));f.mark().seen=f.messages.map(item=>item.id);f.due();await f.service.poll();assert.equal(f.sent.length,1,mutation);assert.equal(record.autoHandled,undefined,mutation);}
});
test('补答pure：超过当前窗口或资格目标容量时保留等待，不启动昂贵匹配',()=>{
 const messages=Array.from({length:513},(_,index)=>incoming('capacity-'+index));assert.equal(mapBacklogMessages(archive({},messages),messages).ready,false);const short=messages.slice(-10),record=archive({},short);record.recoveryEvidence.qualifiedIncoming=short.slice(-9).map(message=>({message,fingerprint:messageFingerprint(message),qualified:true,originalEligibleForReply:true}));assert.equal(mapBacklogMessages(record,short).ready,false);
});
test('自动补答：有完整证据但无archiveId的旧档只由worker分配内部ID，不改原资格水位',async t=>{
 const f=await fixture(t),record=f.mark().unanswered[0];delete record.archiveId;const before=structuredClone(record),seen=structuredClone(f.mark().seen);f.service.persist();f.service.state();f.service.unanswered();assert.equal(record.archiveId,undefined);let captured;const send=f.browser.sendMessage;f.browser.sendMessage=async(...args)=>{captured={incoming:structuredClone(record.incoming),evidence:structuredClone(record.recoveryEvidence),seen:structuredClone(f.mark().seen),disk:JSON.parse(fs.readFileSync(f.service.watermarkFile,'utf8')).contacts[f.contact.id].unanswered[0].archiveId};return send(...args);};await f.service.poll();assert.equal(f.sent.length,1);assert.match(record.archiveId,/^[0-9a-f-]{36}$/);assert.equal(captured.disk,record.archiveId);assert.deepEqual(captured.incoming,before.incoming);assert.deepEqual(captured.evidence,before.recoveryEvidence);assert.deepEqual(captured.seen,seen);assert.equal(record.autoHandled,true);
});
test('自动补答：同来信多份无archiveId旧档迁移后仅发送一次并覆盖对应审计',async t=>{
 const f=await fixture(t),duplicate=structuredClone(f.mark().unanswered[0]);delete f.mark().unanswered[0].archiveId;delete duplicate.archiveId;duplicate.phase='stopped-before-send';f.mark().unanswered.push(duplicate);const evidence=f.mark().unanswered.map(record=>structuredClone(record.recoveryEvidence));f.service.persist();await f.service.poll();assert.equal(f.sent.length,1);assert.equal(new Set(f.mark().unanswered.map(record=>record.archiveId)).size,2);assert.ok(f.mark().unanswered.every(record=>record.autoHandled===true));assert.deepEqual(f.mark().unanswered.map(record=>record.recoveryEvidence),evidence);
});
