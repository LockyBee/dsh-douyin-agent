import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from '../playwright-runtime.mjs';
import {ChatBrowser,readConversationDom} from '../chat-browser.mjs';
import {messageFingerprint} from '../chat-message.mjs';

let browser;
before(async()=>{browser=await chromium.launch({channel:'msedge',headless:true});});
after(async()=>{await browser?.close();});
const conversationId='8123456789012345678',serverId='9123456789012345678',itemId='7579432563794584999';
const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t,{group=true,propsOnly=false,direction='incoming',domIds=[],item=itemId,native=true,messageId=true}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-native-item-card-')),page=await browser.newPage();
  t.after(async()=>{await page.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^douyin-native-item-card-/);fs.rmSync(directory,{recursive:true,force:true});});
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));await page.goto('https://www.douyin.com/');
  await page.setContent('<div data-e2e="im-dialog"><div data-e2e="chat-page"><div data-e2e="chat-header" style="height:40px"><span data-e2e="chat-title">合成许可会话</span></div><div data-e2e="message-list" style="display:flex;flex-direction:column-reverse"><div data-index="0"><div data-e2e="message-row"><div data-e2e="msg-item-content"><div class="MessageItemShareAwemecontainer"><span data-e2e="shared-video-title">相同封面和标题</span><img src="https://synthetic.invalid/cover.png"></div></div></div></div></div></div></div>');
  await page.evaluate(({conversationId,serverId,group,propsOnly,direction,domIds,item,native,messageId})=>{
    const header=document.querySelector('[data-e2e="chat-header"]'),row=document.querySelector('[data-e2e="message-row"]'),node=document.querySelector('[data-e2e="msg-item-content"]'),card=document.querySelector('.MessageItemShareAwemecontainer');
    if(!propsOnly){header.dataset.conversationId=conversationId;header.dataset.conversationType=group?'group':'direct';}
    if(group){header.dataset.e2e='group-chat-header';const avatar=document.createElement('div');avatar.dataset.e2e='group-avatar';header.append(avatar);}
    const conversationPrototype=Object.create(null);Object.defineProperty(conversationPrototype,'id',{value:conversationId,writable:true,configurable:true});
    const conversation=Object.create(conversationPrototype);Object.defineProperty(conversation,'conversationType',{value:group?'group':'direct',writable:true,configurable:true});
    Object.defineProperty(header,'__reactProps$nativeItemHeader',{value:{children:[{props:{conversation}}]},configurable:true});
    row.dataset.direction=direction;row.dataset.senderId='synthetic-member';
    if(messageId)row.dataset.messageId=serverId;
    const prototype=Object.create(null);Object.defineProperty(prototype,'conversationId',{value:conversationId,writable:true,configurable:true});
    if(messageId)Object.defineProperty(prototype,'serverId',{value:serverId,writable:true,configurable:true});
    Object.defineProperty(prototype,'createdAt',{value:new Date(),writable:true,configurable:true});
    const model=Object.create(prototype);Object.defineProperty(model,'isMyMessage',{value:direction!=='outgoing'});
    if(native)Object.defineProperty(model,'_parsedContent',{value:{itemId:item},writable:true,configurable:true});
    Object.defineProperty(node,'__reactProps$nativeItemMessage',{value:{children:[{props:{message:model}}]},configurable:true});
    for(const id of domIds){const anchor=document.createElement('a');anchor.href='https://www.douyin.com/video/'+id;anchor.textContent='作品';card.append(anchor);}
    window.nativeItemFixture={model,prototype,node,row,header,conversationPrototype,conversation,card};window.nativeItemGetterReads=0;window.nativeItemClicks=0;
    card.addEventListener('click',()=>window.nativeItemClicks++);
  },{conversationId,serverId,group,propsOnly,direction,domIds,item,native,messageId});
  const chat=new ChatBrowser({voiceCaptureDir:directory,controller:{withPage:async action=>action(page),close:async()=>{}}});
  const raw=()=>page.evaluate(readConversationDom);
  return{page,chat,raw};
}
test('原生itemId：固定已绑定消息可读取无href作品，群与个人均保留原发送方向和消息身份',async t=>{
  for(const group of [true,false]){const f=await fixture(t,{group});const a=await f.raw(),b=await f.raw(),message=a.messages[0];assert.equal(a.identityUnavailable,undefined);assert.equal(a.isGroup,group);assert.equal(message.media.videoId,itemId);assert.equal(message.media.url,'https://www.douyin.com/video/'+itemId);assert.equal(message.media.publicUrlSource,'rendered-message-item-id');assert.equal(message.nativeId,serverId);assert.equal(message.direction,'incoming');assert.equal(message.nativeId,b.messages[0].nativeId);assert.equal(await f.page.evaluate(()=>window.nativeItemClicks),0);}
});
test('原生itemId：当前群原型身份绑定成立时同样能读，公开消息ID重复读取不改变',async t=>{
  const f=await fixture(t,{propsOnly:true});const a=await f.raw(),key='conv:'+hash(a.identityKey),one=f.chat.publicMessages(key,a.messages),two=f.chat.publicMessages(key,(await f.raw()).messages);assert.equal(a.groupPrototypeIdentity,true);assert.equal(one[0].id,two[0].id);assert.equal(one[0].media.videoId,itemId);assert.equal(one[0].memberId.startsWith('member:'),true);assert.equal(one[0].mentionedSelf,false);
});
test('原生itemId：同一DOM链接与native编号一致时保留双来源，多个不同公开链接拒绝',async t=>{
  const f=await fixture(t,{domIds:[itemId,itemId]});let row=(await f.raw()).messages[0];assert.equal(row.media.publicUrlSource,'dom-link-and-rendered-item-id');assert.equal(row.media.identityConflict,false);
  await f.page.evaluate(()=>{const a=document.createElement('a');a.href='https://www.douyin.com/video/99999';window.nativeItemFixture.card.append(a);});row=(await f.raw()).messages[0];assert.equal(row.media.identityConflict,true);assert.equal(row.media.videoId,null);assert.equal(row.media.url,null);assert.equal(row.media.canResolveByOpeningCard,false);
  const multiple=await fixture(t);await multiple.page.evaluate(()=>window.nativeItemFixture.node.append(window.nativeItemFixture.card.cloneNode(true)));const ambiguous=(await multiple.raw()).messages[0];assert.equal(ambiguous.media.identityConflict,true);assert.equal(ambiguous.media.videoId,null);
});
test('原生itemId：DOM公开链接与native冲突拒绝，不按封面或标题猜作品',async t=>{
  const f=await fixture(t,{domIds:['99999']});let row=(await f.raw()).messages[0];assert.equal(row.media.identityConflict,true);assert.equal(row.media.videoId,null);
  await f.page.evaluate(()=>{window.nativeItemFixture.card.querySelector('a').remove();window.nativeItemFixture.model._parsedContent.itemId='99999';});const next=(await f.raw()).messages[0];assert.equal(next.media.videoId,'99999');assert.equal(next.media.title,row.media.title);assert.notEqual(messageFingerprint(next),messageFingerprint(row));assert.equal(next.nativeId,row.nativeId);
});
test('原生itemId：只读own字段，不执行getter、原型itemId或_source字符串',async t=>{
  for(const kind of ['parsed-getter','item-getter','prototype-item','source-getter','json-string','two-message-props']){
    const f=await fixture(t);
    await f.page.evaluate(kind=>{const f=window.nativeItemFixture,get=()=>{window.nativeItemGetterReads++;throw Error('不得执行合成getter');};
      if(kind==='parsed-getter')Object.defineProperty(f.model,'_parsedContent',{get,configurable:true});
      if(kind==='item-getter')Object.defineProperty(f.model._parsedContent,'itemId',{get,configurable:true});
      if(kind==='prototype-item')f.model._parsedContent=Object.create({itemId:'7579432563794584999'});
      if(kind==='source-getter')Object.defineProperty(f.model,'_parsedContentSource',{get,configurable:true});
      if(kind==='json-string')f.model._parsedContent='{"itemId":"7579432563794584999"}';
      if(kind==='two-message-props')Object.defineProperty(f.node,'__reactProps$ambiguousItemMessage',{value:{children:[{props:{message:f.model}}]}});
    },kind);
    const row=(await f.raw()).messages[0];assert.equal(await f.page.evaluate(()=>window.nativeItemGetterReads),0,kind);if(kind==='source-getter')assert.equal(row.media.videoId,itemId);else assert.equal(row.media.videoId,null,kind);
  }
});
test('原生itemId：严格限制数字字符串，不把大整数、JSON串或超长值当作品身份',async t=>{
  for(const value of [12345,9007199254740992,'',' 12345','12345 ','12e3','123/45','1'.repeat(65),'x'.repeat(20000)]){const f=await fixture(t,{item:value});const row=(await f.raw()).messages[0];assert.equal(row.media.videoId,null);assert.equal(row.media.identityConflict,true);}
});
test('原生itemId：其他会话或无稳定消息编号不能借metadata取作品链接',async t=>{
  const f=await fixture(t);await f.page.evaluate(()=>window.nativeItemFixture.prototype.conversationId='other-conversation');assert.equal((await f.raw()).messages[0].media.videoId,null);
  const missing=await fixture(t,{messageId:false});assert.equal((await missing.raw()).messages[0].media.videoId,null);
  const invalid=await fixture(t);await invalid.page.evaluate(()=>window.nativeItemFixture.row.dataset.messageId=' 12345 ');assert.equal((await invalid.raw()).messages[0].media.videoId,null);
  const wrong=await fixture(t);const read=await wrong.page.evaluate(readConversationDom,{expectedKey:'native:other-conversation',expectedType:'group'});assert.equal(read.identityUnavailable,true);assert.equal(read.messages.length,0);
});
test('原生itemId：无native对象的旧DOM公开链接路径保留，非法公开链接拒绝',async t=>{
  const f=await fixture(t,{native:false,domIds:[itemId]});let row=(await f.raw()).messages[0];assert.equal(row.media.videoId,itemId);assert.equal(row.media.publicUrlSource,'dom-link');
  await f.page.evaluate(()=>window.nativeItemFixture.card.querySelector('a').href='https://fixture:credential@www.douyin.com/video/7579432563794584999');row=(await f.raw()).messages[0];assert.equal(row.media.identityConflict,true);assert.equal(row.media.url,null);
});
test('原生itemId：群分享按许可会话和指定消息只读返回native链接，不点卡片或进入播放页',async t=>{
  const f=await fixture(t),raw=await f.raw();const contact={id:'conv:'+hash('group-fixture'),isGroup:true,nativeId:conversationId};const message=f.chat.publicMessages(contact.id,raw.messages)[0];let selected=0;
  f.chat.select=async(page,id)=>{selected++;assert.equal(id,contact.id);return{contact,flags:{blocked:false}};};f.chat.stableConversation=async()=>raw;f.chat.markMessages=async()=>assert.fail('已核实native链接不应标记并点击卡片');
  const result=await f.chat.openSharedVideo(contact.id,message.id,{allowed:true});assert.equal(result.opened,false);assert.equal(result.videoId,itemId);assert.equal(result.source,'rendered-message-item-id');assert.equal(selected,1);assert.equal(await f.page.evaluate(()=>window.nativeItemClicks),0);
  await assert.rejects(f.chat.openSharedVideo(contact.id,message.id),/明确授权/);assert.equal(selected,1);await assert.rejects(f.chat.openSharedVideo(contact.id,'msg:invalid',{allowed:true}),/精确消息/);assert.equal(selected,1);
});
test('原生itemId：冲突卡片的群取链接不能降级点击；未知消息或blocked会话不返回链接',async t=>{
  const f=await fixture(t,{domIds:['99999']}),raw=await f.raw(),contact={id:'conv:'+hash('group-fixture'),isGroup:true};const message=f.chat.publicMessages(contact.id,raw.messages)[0];f.chat.select=async()=>({contact,flags:{blocked:false}});f.chat.stableConversation=async()=>raw;f.chat.markMessages=async()=>assert.fail('冲突卡片不能降级点击');
  await assert.rejects(f.chat.openSharedVideo(contact.id,message.id,{allowed:true}),/冲突/);assert.equal(await f.page.evaluate(()=>window.nativeItemClicks),0);
  await assert.rejects(f.chat.openSharedVideo(contact.id,'msg:'+'f'.repeat(64),{allowed:true}),/不是已识别/);
  f.chat.select=async()=>({contact,flags:{blocked:true,loginRequired:true}});const stopped=await f.chat.openSharedVideo(contact.id,message.id,{allowed:true});assert.equal(stopped.blocked,true);assert.equal(stopped.opened,false);
});
