import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {hasStableConversationIdentity} from './contact-authorization.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(value);
const video=value=>typeof value==='string'&&/^\d{1,64}$/.test(value);
const profile=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{5,300}$/.test(value)&&value!=='self';
const digestPattern=/^[a-f0-9]{64}$/;
const identityKinds=new Set(['native-conversation','rendered-conversation','rendered-conversation-short','rendered-group','rendered-user','rendered-user-id','profile-user']);
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fail=message=>Object.assign(new Error(message),{code:'RECEIPT_BASELINE_UNAVAILABLE'});

// 与自主评论台账使用相同的临时文件协议；数据刷盘并原子换入后才允许下一次输入。
export function writeDurableReceiptFile(file,value){
  const encoded=JSON.stringify(value,null,2)+'\n';
  if(Buffer.byteLength(encoded,'utf8')>4_194_304)throw fail('本地收据超过有界大小，未执行输入。');
  const temporary=`${file}.${process.pid}.${randomUUID()}.tmp`;
  try{
    const descriptor=fs.openSync(temporary,'wx',0o600);
    try{fs.writeFileSync(descriptor,encoded);fs.fsyncSync(descriptor);}finally{fs.closeSync(descriptor);}
    fs.renameSync(temporary,file);
    if(fs.readFileSync(file,'utf8')!==encoded)throw fail('原子保存后的收据回读不一致，未执行输入。');
  }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}

function contactShape(contact){
  if(!hasStableConversationIdentity(contact))throw fail('收据基线缺少稳定许可会话身份，未执行输入。');
  return{isGroup:contact.isGroup,identityVersion:2,identityKind:contact.identityKind,identityHash:contact.identityHash,identityBinding:contact.identityBinding};
}
function validContact(value,recipientId){
  return exactKeys(value,['isGroup','identityVersion','identityKind','identityHash','identityBinding'])&&typeof value.isGroup==='boolean'&&value.identityVersion===2&&identityKinds.has(value.identityKind)&&(!value.isGroup||!['rendered-user','rendered-user-id','profile-user'].includes(value.identityKind))&&(value.isGroup||value.identityKind!=='rendered-group')&&digestPattern.test(value.identityHash||'')&&recipientId===`conv:${value.identityHash}`&&/^binding:[a-f0-9]{64}$/.test(value.identityBinding||'');
}
function payload(baseline){
  if(!baseline||baseline.version!==1||!['public-comment','native-card'].includes(baseline.kind))throw fail('收据没有可用的点击前基线。');
  const common=['version','kind','operationId','videoId','capturedAt','knownIds','ownProfileHash','recheckable','reasonCode','digest'];
  const extras=baseline.kind==='public-comment'?['textSha256','textLength']:['recipientId','contact'];
  if(!exactKeys(baseline,[...common,...extras])||!uuid(baseline.operationId)||!video(baseline.videoId)||typeof baseline.capturedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(baseline.capturedAt)||!Number.isFinite(Date.parse(baseline.capturedAt))||typeof baseline.recheckable!=='boolean')throw fail('收据基线格式无法核对。');
  if(!Array.isArray(baseline.knownIds)||baseline.knownIds.length>2000||new Set(baseline.knownIds).size!==baseline.knownIds.length||baseline.knownIds.some(id=>baseline.kind==='public-comment'?!video(id):typeof id!=='string'||!/^msg:[a-f0-9]{64}$/.test(id)))throw fail('收据基线编号缺失、重复或超出边界。');
  if(baseline.recheckable?(!digestPattern.test(baseline.ownProfileHash||'')||baseline.reasonCode!==null):(baseline.ownProfileHash!==null||baseline.kind!=='native-card'||baseline.reasonCode!=='self-identity-unavailable'))throw fail('收据基线的本人身份范围无法核对。');
  const value={version:1,kind:baseline.kind,operationId:baseline.operationId,videoId:baseline.videoId,capturedAt:baseline.capturedAt,knownIds:baseline.knownIds,ownProfileHash:baseline.ownProfileHash,recheckable:baseline.recheckable,reasonCode:baseline.reasonCode};
  if(baseline.kind==='public-comment'){
    if(!baseline.recheckable||!digestPattern.test(baseline.textSha256||'')||!Number.isSafeInteger(baseline.textLength)||baseline.textLength<1||baseline.textLength>400)throw fail('评论收据缺少精确正文基线。');
    Object.assign(value,{textSha256:baseline.textSha256,textLength:baseline.textLength});
  }else{
    if(!/^conv:[a-f0-9]{64}$/.test(baseline.recipientId||'')||!validContact(baseline.contact,baseline.recipientId))throw fail('分享收据的稳定会话身份无法核对。');
    Object.assign(value,{recipientId:baseline.recipientId,contact:baseline.contact});
  }
  return value;
}
export function checkReceiptBaseline(operation,kind){
  if(!operation?.baseline)return{available:false,reasonCode:'baseline-absent'};
  try{
    const baseline=operation.baseline,value=payload(baseline);
    if(baseline.kind!==kind||baseline.operationId!==operation.operationId||baseline.videoId!==operation.videoId||kind==='native-card'&&baseline.recipientId!==operation.recipientId||!digestPattern.test(baseline.digest||'')||hash(JSON.stringify(value))!==baseline.digest)throw fail('收据基线与操作或摘要不一致。');
    return{available:true,baseline};
  }catch{return{available:false,reasonCode:'baseline-invalid'};}
}
function seal(value){const baseline={...value,digest:hash(JSON.stringify(value))};payload(baseline);return baseline;}
function ids(rows,kind){
  if(!Array.isArray(rows)||rows.length>2000)throw fail('点击前读取超出有界收据窗口，未执行输入。');
  const knownIds=rows.map(row=>kind==='public-comment'?row?.commentId:row?.id);
  if(new Set(knownIds).size!==knownIds.length||knownIds.some(id=>kind==='public-comment'?!video(id):typeof id!=='string'||!/^msg:[a-f0-9]{64}$/.test(id)))throw fail('点击前消息编号缺失或重复，未执行输入。');
  return knownIds;
}
export function createCommentReceiptBaseline(operation,{rows,ownProfileId,text,capturedAt=new Date().toISOString()}){
  if(typeof text!=='string'||text.length<1||text.length>400||!profile(ownProfileId)||rows?.some(row=>row.videoId!==operation.videoId))throw fail('评论基线缺少同作品、本人或精确正文信息，未执行输入。');
  return seal({version:1,kind:'public-comment',operationId:operation.operationId,videoId:operation.videoId,capturedAt,knownIds:ids(rows,'public-comment'),ownProfileHash:hash(ownProfileId),recheckable:true,reasonCode:null,textSha256:hash(text),textLength:text.length});
}
export function createShareReceiptBaseline(operation,{messages,contact,ownProfileId,capturedAt=new Date().toISOString()}){
  const recheckable=profile(ownProfileId);
  return seal({version:1,kind:'native-card',operationId:operation.operationId,videoId:operation.videoId,capturedAt,knownIds:ids(messages,'native-card'),ownProfileHash:recheckable?hash(ownProfileId):null,recheckable,reasonCode:recheckable?null:'self-identity-unavailable',recipientId:operation.recipientId,contact:contactShape(contact)});
}

export function preserveReceiptBaseline(previous,next,kind){
  if(previous?.baseline){
    if(!checkReceiptBaseline(previous,kind).available||next.baseline&&JSON.stringify(next.baseline)!==JSON.stringify(previous.baseline))throw fail('原点击前基线已损坏或发生变化，未覆盖。');
    next={...next,baseline:previous.baseline};
  }else if(previous&&next.baseline)throw fail('旧收据没有点击前基线，不能事后补造。');
  if(next.baseline&&!checkReceiptBaseline(next,kind).available)throw fail('新收据的点击前基线无法核对，未保存。');
  return next;
}

const inactive=operation=>['clicking','uncertain'].includes(operation?.status);
const unavailable=reasonCode=>({available:false,confirmed:false,reasonCode});
const notConfirmed=reasonCode=>({available:true,confirmed:false,reasonCode});
// 只比较调用者已取得的两次只读快照，不打开页面、不修改收据、不发送或自动结案。
export function matchCommentReceiptBaseline(operation,{ownProfileId,snapshots,draftEmpty}={}){
  const checked=checkReceiptBaseline(operation,'public-comment');if(!checked.available)return unavailable(checked.reasonCode);
  const baseline=checked.baseline;
  if(!inactive(operation)||!profile(ownProfileId)||hash(ownProfileId)!==baseline.ownProfileHash)return unavailable('self-or-operation-mismatch');
  if(!Array.isArray(snapshots)||snapshots.length!==2||draftEmpty!==true)return unavailable('double-read-or-draft-unavailable');
  let previous=null;
  for(const snapshot of snapshots){
    if(!Array.isArray(snapshot?.rows)||snapshot.rows.length>2000)return unavailable('snapshot-unavailable');
    const rows=snapshot.rows,known=new Set(baseline.knownIds),allIds=rows.map(row=>row?.commentId);
    if(allIds.some(id=>!video(id))||new Set(allIds).size!==allIds.length)return unavailable('snapshot-id-conflict');
    const matches=rows.filter(row=>!known.has(row.commentId)&&row.videoId===baseline.videoId&&row.mine===true&&row.sent===true&&row.pending!==true&&row.failed!==true&&typeof row.text==='string'&&row.text.length===baseline.textLength&&hash(row.text)===baseline.textSha256);
    if(matches.length!==1)return notConfirmed(matches.length?'candidate-conflict':'candidate-unavailable');
    if(previous&&previous!==matches[0].commentId)return notConfirmed('double-read-mismatch');previous=matches[0].commentId;
  }
  return{available:true,confirmed:true,commentId:previous};
}
function cardIdentity(media){
  if(media?.type!=='shared-work'||media.identityConflict===true)return null;
  let direct=media.videoId??null,linked=null;if(direct!==null&&!video(direct))return null;
  if(media.url!==undefined&&media.url!==null){try{if(typeof media.url!=='string'||media.url.length>300)return null;const url=new URL(media.url);linked=/^\/video\/(\d{1,64})\/?$/.exec(url.pathname)?.[1];if(url.protocol!=='https:'||url.hostname!=='www.douyin.com'||url.username||url.password||url.port||!linked)return null;}catch{return null;}}
  return direct&&linked&&direct!==linked?null:direct||linked;
}
export function matchShareReceiptBaseline(operation,{ownProfileId,contact,snapshots}={}){
  const checked=checkReceiptBaseline(operation,'native-card');if(!checked.available)return unavailable(checked.reasonCode);const baseline=checked.baseline;
  if(!baseline.recheckable)return unavailable(baseline.reasonCode);
  if(!inactive(operation)||!profile(ownProfileId)||hash(ownProfileId)!==baseline.ownProfileHash)return unavailable('self-or-operation-mismatch');
  let shape;try{shape=contactShape(contact);}catch{return unavailable('contact-unavailable');}
  if(contact.id!==baseline.recipientId||JSON.stringify(shape)!==JSON.stringify(baseline.contact))return unavailable('contact-mismatch');
  if(!Array.isArray(snapshots)||snapshots.length!==2)return unavailable('double-read-unavailable');let previous=null;
  for(const snapshot of snapshots){
    if(snapshot?.blocked||snapshot?.conversation?.id!==baseline.recipientId||!Array.isArray(snapshot.messages)||snapshot.messages.length>2000)return unavailable('snapshot-unavailable');
    const known=new Set(baseline.knownIds),allIds=snapshot.messages.map(row=>row?.id);
    if(allIds.some(id=>typeof id!=='string'||!/^msg:[a-f0-9]{64}$/.test(id))||new Set(allIds).size!==allIds.length)return unavailable('snapshot-id-conflict');
    const matches=snapshot.messages.filter(row=>!known.has(row.id)&&row.identitySource==='dom-message-id'&&row.arrivalClassification==='new-tail'&&row.sender==='outgoing'&&(!row.direction||row.direction==='outgoing')&&row.failed!==true&&row.pending!==true&&row.sent!==false&&cardIdentity(row.media)===baseline.videoId);
    if(matches.length!==1)return notConfirmed(matches.length?'candidate-conflict':'candidate-unavailable');
    if(previous&&previous!==matches[0].id)return notConfirmed('double-read-mismatch');previous=matches[0].id;
  }
  return{available:true,confirmed:true,messageId:previous};
}
