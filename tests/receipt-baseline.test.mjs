import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {writeDurableReceiptFile,createCommentReceiptBaseline,createShareReceiptBaseline,checkReceiptBaseline,preserveReceiptBaseline,matchCommentReceiptBaseline,matchShareReceiptBaseline} from '../receipt-baseline.mjs';
import {CommentBrowser} from '../comment-browser.mjs';import {VideoForwarder} from '../video-forward.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex'),id=value=>'msg:'+hash(value),own='synthetic-self-profile',text='合成画面很有趣。';
const contact={id:'conv:'+hash('native:synthetic-contact'),name:'合成许可会话',isGroup:false,identityVersion:2,identityVerified:true,identityKind:'native-conversation',identityHash:hash('native:synthetic-contact'),identityBinding:'binding:'+hash('synthetic-binding')};
function operation(kind,{self=own,known=true}={}){const row={operationId:'synthetic-'+kind,videoId:'12345',status:'uncertain',...(kind==='share'?{recipientId:contact.id}:{})};row.baseline=kind==='share'?createShareReceiptBaseline(row,{messages:known?[{id:id('old')}]:[],contact,ownProfileId:self}):createCommentReceiptBaseline(row,{rows:known?[{commentId:'90000',videoId:'12345'}]:[],ownProfileId:self,text});return row;}
const commentRow=(extra={})=>({commentId:'90001',videoId:'12345',text,mine:true,sent:true,pending:false,failed:false,...extra});
const shareRow=(extra={})=>({id:id('new'),identitySource:'dom-message-id',arrivalClassification:'new-tail',sender:'outgoing',direction:'outgoing',media:{type:'shared-work',videoId:'12345',url:'https://www.douyin.com/video/12345'},...extra});
const commentInput=rows=>({ownProfileId:own,snapshots:[{rows},{rows:structuredClone(rows)}],draftEmpty:true});
const shareInput=rows=>({ownProfileId:own,contact,snapshots:[{conversation:{id:contact.id},messages:rows},{conversation:{id:contact.id},messages:structuredClone(rows)}]});
function directory(t){const value=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-receipt-baseline-'));t.after(()=>{assert.equal(path.dirname(path.resolve(value)),path.resolve(os.tmpdir()));assert.match(path.basename(value),/^douyin-receipt-baseline-/);fs.rmSync(value,{recursive:true,force:true});});return value;}

test('点击前基线：有限字段持久化，精确正文仅留摘要，旧格式明确不可重查',()=>{
  for(const kind of ['comment','share']){const row=operation(kind),checked=checkReceiptBaseline(row,kind==='comment'?'public-comment':'native-card');assert.equal(checked.available,true);assert.equal(row.baseline.knownIds.length,1);assert.equal(JSON.stringify(row.baseline).includes(text),false);assert.equal(JSON.stringify(row.baseline).includes(contact.name),false);}
  assert.deepEqual(checkReceiptBaseline({operationId:'legacy'},'public-comment'),{available:false,reasonCode:'baseline-absent'});
});
test('点击前基线：拒绝缺编号、重复、超窗、异常本人及跨作品数据',()=>{
  const row={operationId:'synthetic-invalid',videoId:'12345',recipientId:contact.id};
  for(const rows of [[{commentId:null,videoId:'12345'}],[{commentId:'9',videoId:'12345'},{commentId:'9',videoId:'12345'}],Array.from({length:2001},(_,n)=>({commentId:String(n+1),videoId:'12345'})),[{commentId:'9',videoId:'99999'}]])assert.throws(()=>createCommentReceiptBaseline(row,{rows,ownProfileId:own,text}),/基线|编号|边界|窗口/);
  assert.throws(()=>createCommentReceiptBaseline(row,{rows:[],ownProfileId:'self',text}),/本人/);
  assert.throws(()=>createShareReceiptBaseline(row,{messages:[{id:'legacy-unbounded-id'}],contact,ownProfileId:own}),/编号/);
  assert.throws(()=>createShareReceiptBaseline(row,{messages:[],contact:{...contact,identityBinding:'different'},ownProfileId:own}),/身份/);
});
test('点击前基线：摘要与操作绑定不可移植，状态更新保留原基线且禁止事后补造',()=>{
  const before=operation('comment'),next=preserveReceiptBaseline(before,{operationId:before.operationId,videoId:before.videoId,status:'confirmed'},'public-comment');assert.deepEqual(next.baseline,before.baseline);
  for(const change of [{operationId:'different-operation'},{videoId:'99999'},{baseline:{...before.baseline,textLength:1}},{baseline:{...before.baseline,unexpected:'private'}}])assert.equal(checkReceiptBaseline({...before,...change},'public-comment').available,false);
  assert.throws(()=>preserveReceiptBaseline({...before,baseline:undefined},before,'public-comment'),/事后补造/);
  assert.throws(()=>preserveReceiptBaseline(before,{...before,baseline:{...before.baseline,knownIds:[]}},'public-comment'),/变化/);
});
test('点击前基线：评论只读双验匹配同本人同作品新ID精确文本，不修改原收据',()=>{
  const row=operation('comment'),before=JSON.stringify(row),input=commentInput([commentRow()]);assert.deepEqual(matchCommentReceiptBaseline(row,input),{available:true,confirmed:true,commentId:'90001'});assert.equal(JSON.stringify(row),before);
  for(const change of [{ownProfileId:'another-self-profile'},{draftEmpty:false},{snapshots:[{rows:[commentRow()]}]}])assert.equal(matchCommentReceiptBaseline(row,{...input,...change}).confirmed,false);
  for(const extra of [{commentId:'90000'},{videoId:'99999'},{mine:false},{pending:true},{failed:true},{sent:false},{text:text+' '},{text:'相同长度但正文不同。'}])assert.equal(matchCommentReceiptBaseline(row,commentInput([commentRow(extra)])).confirmed,false);
});
test('点击前基线：评论多候选、重复编号或两读不同ID均不能确认',()=>{
  const row=operation('comment');for(const rows of [[commentRow(),commentRow({commentId:'90002'})],[commentRow(),commentRow()]])assert.equal(matchCommentReceiptBaseline(row,commentInput(rows)).confirmed,false);
  assert.equal(matchCommentReceiptBaseline(row,{...commentInput([]),snapshots:[{rows:[commentRow()]},{rows:[commentRow({commentId:'90002'})]}]}).confirmed,false);
});
test('点击前基线：分享只读双验仍需稳定会话、本人、原生新尾消息和精确卡片',()=>{
  const row=operation('share'),before=JSON.stringify(row),input=shareInput([shareRow()]);assert.deepEqual(matchShareReceiptBaseline(row,input),{available:true,confirmed:true,messageId:id('new')});assert.equal(JSON.stringify(row),before);
  for(const change of [{ownProfileId:'another-self-profile'},{contact:{...contact,identityBinding:'binding:'+hash('changed')}},{contact:{...contact,isGroup:true}}])assert.equal(matchShareReceiptBaseline(row,{...input,...change}).confirmed,false);
  for(const extra of [{id:id('old')},{sender:'incoming'},{direction:'incoming'},{arrivalClassification:'baseline'},{identitySource:'content-fingerprint'},{pending:true},{failed:true},{sent:false},{media:{type:'shared-work',videoId:'12345',url:'https://www.douyin.com/video/99999'}},{media:{type:'shared-work',videoId:'12345',identityConflict:true}}])assert.equal(matchShareReceiptBaseline(row,shareInput([shareRow(extra)])).confirmed,false);
});
test('点击前基线：分享未知本人可存但不可重查，旧收据及结案字段不冒充平台新卡片',()=>{
  const unknown=operation('share',{self:null});assert.equal(checkReceiptBaseline(unknown,'native-card').available,true);assert.equal(unknown.baseline.recheckable,false);assert.deepEqual(matchShareReceiptBaseline(unknown,shareInput([shareRow()])),{available:false,confirmed:false,reasonCode:'self-identity-unavailable'});
  assert.equal(matchShareReceiptBaseline({operationId:'legacy',status:'uncertain'},shareInput([shareRow()])).confirmed,false);
  assert.equal(matchShareReceiptBaseline({...operation('share'),status:'resolved-confirmed'},shareInput([shareRow()])).confirmed,false);
  const row=operation('share');for(const rows of [[shareRow(),shareRow({id:id('second')})],[shareRow(),shareRow()]])assert.equal(matchShareReceiptBaseline(row,shareInput(rows)).confirmed,false);
});
test('点击前基线：原子写入在write、fsync和rename故障时保留旧文件且清理临时文件',t=>{
  const dir=directory(t),file=path.join(dir,'receipt.json'),original='{"legacy":true}\n';
  for(const mode of ['write','fsync','rename']){
    fs.writeFileSync(file,original);const originals={openSync:fs.openSync,writeFileSync:fs.writeFileSync,fsyncSync:fs.fsyncSync,renameSync:fs.renameSync},tracked=new Set();
    fs.openSync=(name,...args)=>{const fd=originals.openSync(name,...args);if(typeof name==='string'&&name.startsWith(file+'.'))tracked.add(fd);return fd;};
    fs.writeFileSync=(target,...args)=>{if(mode==='write'&&tracked.has(target)){originals.writeFileSync(target,'{');throw Object.assign(Error('合成断写'),{code:'EIO'});}return originals.writeFileSync(target,...args);};
    fs.fsyncSync=fd=>{if(mode==='fsync'&&tracked.has(fd))throw Object.assign(Error('合成刷盘失败'),{code:'EIO'});return originals.fsyncSync(fd);};
    fs.renameSync=(from,to)=>{if(mode==='rename'&&to===file)throw Object.assign(Error('合成原子换入失败'),{code:'EIO'});return originals.renameSync(from,to);};
    try{assert.throws(()=>writeDurableReceiptFile(file,{operations:[operation('comment')]}));}finally{Object.assign(fs,originals);}
    assert.equal(fs.readFileSync(file,'utf8'),original,mode);assert.deepEqual(fs.readdirSync(dir),['receipt.json'],mode);
  }
});
test('点击前基线：模拟落盘后进程中断，重建服务仍读取同一基线，不自动发送或补造',t=>{
  const dir=directory(t),comments={version:1,operations:[{...operation('comment'),status:'clicking'}]},shares={version:1,operations:[{...operation('share'),status:'clicking'}]};
  const input=path.join(dir,'child-input.json');fs.writeFileSync(input,JSON.stringify({dir,comments,shares}));
  const moduleUrl=new URL('../receipt-baseline.mjs',import.meta.url).href;
  const script=`import fs from 'node:fs';import path from 'node:path';import {writeDurableReceiptFile} from ${JSON.stringify(moduleUrl)};const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));writeDurableReceiptFile(path.join(data.dir,'comment-browser-receipts.json'),data.comments);writeDurableReceiptFile(path.join(data.dir,'video-forward-receipts.json'),data.shares);process.exit(73);`;
  const result=spawnSync(process.execPath,[...process.execArgv,'--input-type=module','-e',script,input],{encoding:'utf8'});assert.equal(result.status,73,result.stderr);
  const controller={withPage:async()=>assert.fail('模拟恢复不能连接浏览器'),close:async()=>{}};
  const commenter=new CommentBrowser({stateDir:dir,controller,videoLimits:{state:()=>({allowed:true})}}),forwarder=new VideoForwarder({stateDir:dir,controller,chatBrowser:{},videoLimits:{beforeAction:()=>({allowed:true})}});
  const commentBytes=fs.readFileSync(commenter.receiptsFile),shareBytes=fs.readFileSync(forwarder.receiptsFile);assert.deepEqual(commenter.receipts(),comments);assert.deepEqual(forwarder.receipts(),shares);assert.equal(checkReceiptBaseline(commenter.receipts().operations[0],'public-comment').available,true);assert.equal(checkReceiptBaseline(forwarder.receipts().operations[0],'native-card').available,true);assert.deepEqual(fs.readFileSync(commenter.receiptsFile),commentBytes);assert.deepEqual(fs.readFileSync(forwarder.receiptsFile),shareBytes);
});
test('点击前基线：模拟刷盘后换入前断电，只留下临时文件，旧收据保持原字节和旧格式',t=>{
  const dir=directory(t),file=path.join(dir,'comment-browser-receipts.json'),legacy={version:1,operations:[{operationId:'legacy-interrupted-comment',videoId:'12345',status:'uncertain'}]},bytes=JSON.stringify(legacy)+'\n';fs.writeFileSync(file,bytes);
  const input=path.join(dir,'interrupted-input.json');fs.writeFileSync(input,JSON.stringify({file,value:{version:1,operations:[operation('comment')]}}));
  const moduleUrl=new URL('../receipt-baseline.mjs',import.meta.url).href,script=`import fs from 'node:fs';import {writeDurableReceiptFile} from ${JSON.stringify(moduleUrl)};const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));fs.renameSync=()=>process.exit(72);writeDurableReceiptFile(data.file,data.value);`;
  const result=spawnSync(process.execPath,[...process.execArgv,'--input-type=module','-e',script,input],{encoding:'utf8'});assert.equal(result.status,72,result.stderr);assert.equal(fs.readFileSync(file,'utf8'),bytes);assert.equal(fs.readdirSync(dir).filter(name=>name.endsWith('.tmp')).length,1);
  const commenter=new CommentBrowser({stateDir:dir,controller:{withPage:async()=>assert.fail('临时文件不能触发浏览器恢复')},videoLimits:{state:()=>({allowed:true})}});assert.deepEqual(commenter.receipts(),legacy);assert.equal(checkReceiptBaseline(commenter.receipts().operations[0],'public-comment').available,false);assert.equal(fs.readFileSync(file,'utf8'),bytes);
});
