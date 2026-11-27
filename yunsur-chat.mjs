import {createHash} from 'node:crypto';
import {groupMessageAddressesFish} from './group-reply-trigger.mjs';
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {downloadPublicMedia,runMediaProcess} from './media/index.mjs';
import {decryptMessageImage} from './yunsur-media.mjs';
import {messageAttachment,readMessageAttachment} from './yunsur-attachments.mjs';
import {atomicJsonWrite} from './atomic-file.mjs';
import {MessageIdentityTracker} from './message-tracker.mjs';
import {matchesAuthorizedContact} from './contact-authorization.mjs';
import {compareMessageWatermark} from './chat-message.mjs';
import {decimalId} from './yunsur-mcp.mjs';
const hash=value=>createHash('sha256').update(String(value)).digest('hex');
const mediaUnavailable = () => Object.assign(new Error('后台没有读到指定消息的媒体。'), { code: 'CHAT_MEDIA_UNAVAILABLE' });

// 通过原授权绑定的哈希核对，不用昵称或头像继承许可。
export function mapYunsurContacts(conversations,allowlist){
  const result=new Map();
  for(const stored of allowlist){
    const matches=[];
    for(const conv of conversations){
      if(![1,2].includes(conv.conversation_type)||(conv.conversation_type===2)!==stored.isGroup)continue;
      const identities=[['conversation',conv.conversation_id],['conversation-short',conv.conversation_short_id],['group',conv.conversation_id]];
      if(!stored.isGroup){identities.push(['user',conv.owner_sec_uid],['user-id',conv.owner_uid]);for(const message of conv.last_messages||[]){if(message.conversation_id!==conv.conversation_id)continue;identities.push(['user',message.sender_sec_uid],['user-id',message.sender]);}}
      const valid=identities.some(([family,id])=>{if(!id)return false;const key=`rendered:${family}:${hash(id)}`;return hash(key)===stored.identityHash&&`conv:${hash(key)}`===stored.id&&`binding:${hash(`${stored.isGroup?'group':'direct'}\0${key}`)}`===stored.identityBinding;});
      if(valid)matches.push(conv);
    }
    if(matches.length===1)result.set(stored.id,{stored,conversation:matches[0]});
  }
  return result;
}

export function yunsurMessage(message,{conversation,selfUID,recipientId,mentionNames=['大肥鱼']}={}){
  if(message.conversation_id!==conversation.conversation_id||message.conversation_type!==conversation.conversation_type)throw Error('消息不属于核对的会话。');
  const nativeId=String(message.server_message_id||'');if(!/^\d+$/.test(nativeId)||!Number.isSafeInteger(message.timestamp_ms))throw Error('消息标识或时间无法核对。');
  const sender=String(message.sender)===String(selfUID)?'outgoing':'incoming',content=message.content||{},text=typeof content.text==='string'?content.text:'';
  const type=message.message_type,mediaType=({5:'emoji',8:'shared-work',27:'image',30:'video-attachment',6:'file',77:'shared-work',26:'link',25:'user-card',17:'voice',110:'unknown'})[type]||null;
  const id=`msg:${hash(`${conversation.conversation_id}\0${nativeId}`)}`;
  const media=mediaType?{type:mediaType,label:String(content.display_name||content.description||'').slice(0,200),title:String(content.content_title||'').slice(0,1000),isPhotoGallery:type===77,understandingScope:['file','video-attachment','link','user-card','unknown'].includes(mediaType)?'visible-message-metadata-only':'not-yet-observed',contentStatus:'metadata-only',...(mediaType==='shared-work'&&/^\d{10,30}$/.test(String(content.itemId||''))?{videoId:String(content.itemId),url:`https://www.douyin.com/video/${content.itemId}`}:{})}:undefined;
  if(media){
    const md5=content.md5||content.resource_url?.md5;
    if(typeof md5==='string'&&/^[a-f0-9]{32}$/i.test(md5))media.imageMd5=md5;
    const attachment = messageAttachment(media.type, content);
    if (attachment?.urls.length) {
      const sourcePaths = attachment.urls.map(url => { const parsed = new URL(url); return [parsed.host, parsed.pathname]; });
      media.resources = [{ resourceRef:`media:${hash(JSON.stringify([nativeId,sourcePaths,attachment.filename,attachment.format,attachment.reportedBytes,attachment.checksum]))}` }];
    } else {
      const nativeRef=content.resource_url?.oid||content.url?.uri||content.id;
      if(typeof nativeRef==='string'||typeof nativeRef==='number')media.resources=[{resourceRef:`media:${hash(String(nativeRef))}`}];
    }
  }
  return {id,nativeId:hash(`${conversation.conversation_id}\0${nativeId}`),kind:type===7?'text':mediaType?'media':'unknown',sender,direction:sender,text,timestamp:message.timestamp_ms,timestampMs:message.timestamp_ms,sentAt:message.timestamp_ms,createdAt:new Date(message.timestamp_ms).toISOString(),serverConfirmed:true,latestEndVerified:true,messageType:type,unsupported:type!==7&&!mediaType,dayText:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(message.timestamp_ms),...(conversation.conversation_type===2?{memberId:`member:${hash(`${recipientId}\0${message.sender}`)}`,memberName:null,mentionedSelf:groupMessageAddressesFish({text},mentionNames)}:{}),...(media?{media}:{}),nativeServerId:nativeId};
}

export class YunsurChatBrowser{
  constructor({client,getPolicy,journalDir,now=Date.now,downloadAttachment}={}){if(!path.isAbsolute(journalDir||''))throw Error('需要本地消息发送记录目录。');Object.assign(this,{client,getPolicy,journalDir,now,downloadAttachment});this.mapping=new Map();this.selfUID=null;this.controller={source:'api-chat'};this.identities=new MessageIdentityTracker();this.cleanups=new Set();this.resources=new Map();this.captures=new Map();this.assetRoot=path.join(journalDir,'assets');fs.mkdirSync(this.assetRoot,{recursive:true});}
  async prepareChat({signal}={}){const status=await this.client.call('check_login_status',{}, {signal});if(!status.logged_in)throw Object.assign(Error('后台抖音账号需要登录。'),{code:'CHAT_ACCOUNT_ACTION_REQUIRED',needsUserAction:true});this.selfUID=status.uid;return{ready:true,backend:'yunsur-mcp'};}
  async sendAuthorizationBlock({ signal } = {}) {
    let status;
    try {
      status = await this.client.call('check_login_status', {}, { signal });
    } catch {
      signal?.throwIfAborted();
      return { code: 'MCP_IM_SEND_STATUS_UNAVAILABLE', message: '暂时无法检查后台发送授权。' };
    }
    signal?.throwIfAborted();
    const uid = decimalId(status?.uid);
    if (status?.logged_in !== true || !uid || uid !== decimalId(this.selfUID)) {
      return { code: 'MCP_IM_SEND_ACCOUNT_CHANGED', message: '发送前无法核实当前登录账号。' };
    }
    if (status.im_write_configured === false) {
      return { code: 'MCP_IM_SEND_AUTHORIZATION_REQUIRED', message: '后台连接器尚未配置发送授权。' };
    }
    return null;
  }
  async listContacts({signal}={}){
    if(!this.selfUID)await this.prepareChat({signal});const conversations=await this.client.call('list_conversations',{}, {signal});if(!Array.isArray(conversations))throw Error('后台会话列表格式无效。');
    const policy=this.getPolicy(),mapped=mapYunsurContacts(conversations,policy.allowlist);
    for(const stored of policy.allowlist){if(mapped.has(stored.id))continue;const prior=this.mapping.get(stored.id);if(!prior||!matchesAuthorizedContact(prior.stored,stored))continue;const same=conversations.find(c=>c.conversation_id===prior.conversation.conversation_id&&c.conversation_short_id===prior.conversation.conversation_short_id&&c.conversation_type===prior.conversation.conversation_type);if(same)mapped.set(stored.id,{stored,conversation:same});}
    this.mapping=mapped;
    return{contacts:[...this.mapping.values()].map(({stored,conversation})=>({...stored,displayName:conversation.name||stored.name,name:conversation.name||stored.name,conversationType:stored.isGroup?'group':'direct',unread:Number(conversation.unread||0)})),blocked:false};
  }
  async unreadCounts(ids,{signal}={}){const list=await this.listContacts({signal});return{counts:Object.fromEntries(list.contacts.filter(c=>ids.includes(c.id)).map(c=>[c.id,c.unread])),available:true};}
  async readConversation(recipientId,{allowed=false,signal}={}){
    if(!allowed||!this.getPolicy().allowlist.some(c=>c.id===recipientId))throw Error('这个会话未许可。');await this.listContacts({signal});const mapped=this.mapping.get(recipientId);if(!mapped)throw Error('许可会话的稳定身份尚未对上。');
    const result=await this.client.call('get_conversation_history',{conversation:mapped.conversation.conversation_id,count:50},{signal});
    const rows=result.messages;if(!Array.isArray(rows))throw Error('后台消息历史格式无法核对。');
    const raw=rows.map(message=>yunsurMessage(message,{conversation:mapped.conversation,selfUID:this.selfUID,recipientId,mentionNames:this.getPolicy().groupMentionNames})).sort((a,b)=>a.timestampMs-b.timestampMs||(BigInt(a.nativeServerId)<BigInt(b.nativeServerId)?-1:1));
    const messages=this.identities.identify(recipientId,raw);
    for(let i=0;i<messages.length;i++){this.resources.delete(messages[i].id);this.resources.set(messages[i].id,{recipientId,content:rows.find(r=>String(r.server_message_id)===messages[i].nativeServerId)?.content||{},media:messages[i].media});delete messages[i].nativeServerId;messages[i].identitySource='api-message-id';messages[i].apiServerMessageBound=true;}
    while(this.resources.size>256)this.resources.delete(this.resources.keys().next().value);
    return{blocked:false,conversation:{id:recipientId,displayName:mapped.conversation.name,isGroup:mapped.stored.isGroup,conversationType:mapped.stored.isGroup?'group':'direct'},contact:{...mapped.stored,displayName:mapped.conversation.name},messages,dayEvidence:{observedAt:this.now(),latestEndVerified:true,chronology:'oldest-first',historyStartVerified:false,emptyTodayVerified:false}};
  }
  async resource(recipientId,messageId,{allowed,signal}={}){if(!allowed)throw Error('消息采集未授权。');const snapshot=await this.readConversation(recipientId,{allowed:true,signal});const message=snapshot.messages.find(m=>m.id===messageId),resource=this.resources.get(messageId);if(!message||!resource||resource.recipientId!==recipientId)throw Error('指定媒体消息已变化或不可读取。');return{message,resource};}
  mediaUrls(content){const objects=[content.url,content.resource_url,content.cover_url,content.content_thumb,content.cover_url_v2,content.audio_url];const entries=value=>Array.isArray(value)?value:value&&typeof value==='object'?Object.values(value):[];return[...new Set(objects.flatMap(value=>typeof value==='string'?[value]:value?[...entries(value.url_list),...entries(value.medium_url_list),...entries(value.large_url_list),...entries(value.origin_url_list)]:[]).filter(value=>{try{return new URL(value).protocol==='https:'}catch{return false}}))].slice(0,8);}
  async removeAssets(directory){const relative=path.relative(this.assetRoot,path.resolve(directory));if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('媒体临时路径越界，未清理。');const stat=fs.lstatSync(directory,{throwIfNoEntry:false});if(stat?.isSymbolicLink())throw Error('媒体临时路径是链接，未清理。');if(stat)fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
  async downloadMessageResource(content,directory,signal,validate){const file=path.join(directory,'source.media');let last;for(const url of this.mediaUrls(content))try{await downloadPublicMedia(url,file,{signal,maxBytes:25*1024*1024,trustedMessageMedia:true});if(validate)await validate(file);return file;}catch(error){last=error;if(fs.existsSync(file))fs.unlinkSync(file);}throw last||Error('这条消息没有可读取的公开签名媒体地址。');}
  canCaptureAttachment(message){
    const resource=this.resources.get(message.id);
    return Boolean(resource && messageAttachment(message.media?.type,resource.content)?.readable);
  }
  async captureMessage(recipientId,messageId,{allowed=false,signal}={}){
    const {message,resource}=await this.resource(recipientId,messageId,{allowed,signal});
    const base={conversation:{id:recipientId},messageId,frames:[],media:message.media,understandingScope:'visible-message-metadata-only'};
    const attachment=messageAttachment(message.media?.type,resource.content);
    if(attachment){
      if(attachment.readable){
        const directory=fs.mkdtempSync(path.join(this.assetRoot,'attachment-'));
        try{
          const captured=await readMessageAttachment(attachment,directory,{signal,download:this.downloadAttachment});
          signal?.throwIfAborted();
          if(!this.getPolicy().allowlist.some(contact=>contact.id===recipientId))throw Error('采集期间会话许可已撤回。');
          if(captured)return{...base,...captured};
        }finally{await this.removeAssets(directory);}
      }
      return{...base,note:'当前没有从这条附件读到正文或正片画面。'};
    }
    if(!['image','emoji','shared-work'].includes(message.media?.type))return base;
    const directory=fs.mkdtempSync(path.join(this.assetRoot,'image-'));
    try{const image=path.join(directory,'frame.jpg');await this.downloadMessageResource(resource.content,directory,signal,async file=>{let source=file;const skey=resource.content.resource_url?.skey;if(skey){const clear=decryptMessageImage(fs.readFileSync(file),skey);source=path.join(directory,'clear.media');fs.writeFileSync(source,clear,{mode:0o600});}await runMediaProcess('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-y','-i',source,'-frames:v','1','-vf','scale=480:-2','-q:v','4',image],{signal,timeoutMs:10000,maxOutputBytes:1000});});const bytes=fs.readFileSync(image);if(bytes.length>2000000)throw Error('指定消息图像过大。');return{conversation:{id:recipientId},messageId,frames:[{mimeType:'image/jpeg',data:bytes.toString('base64')}],media:message.media,understandingScope:'single-message-image'};}
    catch { signal?.throwIfAborted(); throw mediaUnavailable(); }
    finally{await this.removeAssets(directory);}
  }
  async openSharedVideo(recipientId,messageId,options={}){const {message}=await this.resource(recipientId,messageId,options);if(message.media?.type!=='shared-work'||!message.media.videoId)throw Error('这条消息不是已核对的视频分享。');return{videoId:message.media.videoId,url:message.media.url,isPhotoGallery:message.media.isPhotoGallery};}
  async captureVoiceMessage(recipientId,messageId,{allowed=false,signal}={}){
    const {message,resource}=await this.resource(recipientId,messageId,{allowed,signal});if(message.media?.type!=='voice'||this.captures.size>=8)throw Error('没有可用的指定语音或采集任务过多。');const directory=fs.mkdtempSync(path.join(this.assetRoot,'voice-'));
    try{const file=await this.downloadMessageResource(resource.content,directory,signal),audio=path.join(directory,'sample.wav');const probe=JSON.parse(await runMediaProcess('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',file],{signal,maxOutputBytes:10000}));const seconds=Number(probe.format?.duration);if(!Number.isFinite(seconds)||seconds<=0||seconds>120||!probe.streams?.some(s=>s.codec_type==='audio'))throw Error('指定语音时长或音轨无效。');await runMediaProcess('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-i',file,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',audio],{signal,maxOutputBytes:1000});const captureId=`voice:${hash(randomUUID())}`;this.captures.set(captureId,directory);return{conversation:{id:recipientId},messageId,captureId,understandingScope:'single-message-audio',media:{type:'voice',durationSeconds:seconds},interval:{scope:'single-message-audio',startSeconds:0,durationSeconds:seconds},audio:{path:audio,mimeType:'audio/wav',bytes:fs.statSync(audio).size}};}
    catch { await this.removeAssets(directory); signal?.throwIfAborted(); throw mediaUnavailable(); }
  }
  async releaseVoiceCapture(captureId){const directory=this.captures.get(captureId);if(directory){this.captures.delete(captureId);await this.removeAssets(directory);}}
  async sendMessage(recipientId,message,{allowed=false,signal,expectedContact,expectedMessageIds,expectedMessageContent,expectedMessageEvidence,authorize}={}){
    if(!allowed||typeof authorize!=='function'||typeof authorize.beginDispatch!=='function'||!expectedMessageIds?.length||typeof message!=='string'||!message.trim()||message.length>4000)throw Error('消息没有有效发送资格。');
    await authorize({recipientId,phase:'prepare'});const current=await this.readConversation(recipientId,{allowed:true,signal});
    if(!matchesAuthorizedContact(expectedContact,current.contact)||!compareMessageWatermark({content:expectedMessageContent,...expectedMessageEvidence},current.messages,current).matches)return{confirmed:false,superseded:true,deliveryUncertain:false};
    const key=hash(JSON.stringify([recipientId,expectedMessageIds])),file=path.join(this.journalDir,`${key}.json`);
    const before=new Set(current.messages.map(m=>m.id));
    const persist=value=>atomicJsonWrite(file,value);
    if(fs.existsSync(file)){const prior=JSON.parse(fs.readFileSync(file,'utf8'));return prior.state==='confirmed'?{confirmed:true,messageId:prior.messageId,deliveryUncertain:false}:{confirmed:false,deliveryUncertain:true,failureCode:'MCP_PREVIOUS_DISPATCH_UNCERTAIN'};}
    const sendBlock = await this.sendAuthorizationBlock({ signal });
    if (sendBlock) return { confirmed: false, deliveryUncertain: false, failureCode: sendBlock.code, failureStage: 'send-authorization', reason: sendBlock.message };
    const record={version:1,key,recipientId,textHash:hash(message.trim()),at:this.now(),state:'started'};
    const fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(record));fs.fsyncSync(fd);fs.closeSync(fd);
    let release,dispatched=false;
    try{
      await authorize({recipientId,phase:'before-click'});signal?.throwIfAborted();release=await authorize.beginDispatch();
      const mapped=this.mapping.get(recipientId);if(!mapped)throw Error('发送前许可绑定已丢失。');
      dispatched=true;await this.client.call('send_conversation_text',{conversation_id:mapped.conversation.conversation_id,conversation_type:mapped.conversation.conversation_type,content:message.trim()},{signal,control:true});release();release=null;
      for(let attempt=0;attempt<6;attempt++){
        const latest=await this.readConversation(recipientId,{allowed:true,signal});
        const found=latest.messages.filter(m=>!before.has(m.id)&&m.sender==='outgoing'&&m.text===message.trim()&&m.serverConfirmed===true);
        if(found.length===1){persist({...record,state:'confirmed',messageId:found[0].id});return{confirmed:true,messageId:found[0].id,deliveryUncertain:false};}
        if(found.length>1)break;
        await new Promise(resolve=>setTimeout(resolve,500));
      }
    }catch(error){if(!dispatched){fs.unlinkSync(file);throw error;} /* 发送后的网络错误不能证明未发出；留回执给恢复核对，不重试。 */ }
    finally{release?.();}
    persist({...record,state:'uncertain'});return{confirmed:false,deliveryUncertain:true,failureCode:'MCP_RECEIPT_UNCONFIRMED'};
  }
  async subscribeIncoming(callback,{recipientIds=[],signal}={}){
    let running=true,busy=false;let state=await this.client.call('background_im_state',{}, {signal});
    if(state.state==='stopped'){await this.client.call('start_im_listen',{}, {signal,control:true});state=await this.client.call('background_im_state',{}, {signal});}
    let cursor=state.cursor,instance=state.instance;
    const tick=async()=>{if(!running||busy||signal?.aborted)return;busy=true;try{const status=await this.client.call('background_im_state',{}, {signal});if(status.instance!==instance){instance=status.instance;cursor='0';for(const recipientId of recipientIds)callback({recipientId});}const batch=await this.client.call('background_im_batch',{after:cursor,limit:100},{signal});cursor=batch.next_cursor;for(const recipientId of recipientIds){const entry=this.mapping.get(recipientId);if(entry&&(batch.gap||batch.messages.some(m=>m.conversation_id===entry.conversation.conversation_id)))callback({recipientId});}}catch{for(const recipientId of recipientIds)callback({recipientId});}finally{busy=false;}};
    const timer=setInterval(()=>void tick(),1000);timer.unref();const cleanup=()=>{running=false;clearInterval(timer);signal?.removeEventListener('abort',cleanup);this.cleanups.delete(cleanup);};signal?.addEventListener('abort',cleanup,{once:true});this.cleanups.add(cleanup);return cleanup;
  }
  async close(){for(const cleanup of this.cleanups)cleanup();for(const captureId of this.captures.keys())await this.releaseVoiceCapture(captureId);this.resources.clear();}
}
