import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../memory.mjs';
import {ChatAgent} from '../chat-agent.mjs';
import {createRuntimeConversationMemory,bindMemoryContact,memoryContactFromToken} from '../runtime-conversation-memory.mjs';
import {appendConversationOriginals,readConversationOriginals,recallLocalConversationHistory} from '../conversation-history-store.mjs';
const contact=(n='a',group=false)=>({id:`conv:${n.repeat(64)}`,name:'合成许可会话',isGroup:group,identityVerified:true,identityBinding:`binding:${'c'.repeat(64)}`,identityVersion:2,identityHash:n.repeat(64),identityKind:group?'rendered-group':'rendered-user'});
const scope=c=>({platform:'douyin',conversationId:c.id,isGroup:c.isGroup,sharedEnabled:false});
function fixture(t){const store=new MemoryStore(':memory:',{qqMemoryPath:null});t.after(()=>store.close());return store;}
test('运行时实际工厂接入同一SQLite，旧记录保留，按当前可信会话找出较早原文',t=>{
 const store=fixture(t),c=contact(),old=store.remember({content:'合成公开视频笔记：纸船'});
 const previous=Array.from({length:20},(_,i)=>({id:`old-${i}`,sender:'incoming',text:i===0?'合成旧事：松果计划周五完成。':`合成普通消息${i}`}));
 appendConversationOriginals(store.db,scope(c),previous,{now:100});
 const result=createRuntimeConversationMemory({store,contact:c,messages:[{id:'current',sender:'incoming',text:'松果计划'}]});
 const recalled=result.session.recall({query:'松果计划'});
 assert.ok(recalled.entries.some(x=>x.content.includes('周五完成')));
 assert.equal(store.db.prepare('SELECT content FROM memory_entries WHERE id=?').get(old.id).content,'合成公开视频笔记：纸船');
 assert.ok(result.session.buildReplyContext({query:'松果计划'}).metrics.historyCount>0);
});
test('同名的另一个会话和跨端私聊不能读取本地私聊原文',t=>{
 const store=fixture(t),a=contact('a'),b=contact('b');
 createRuntimeConversationMemory({store,contact:a,messages:[{id:'secret',sender:'incoming',text:'合成私聊秘密松果'}]});
 assert.equal(createRuntimeConversationMemory({store,contact:b,messages:[]}).session.recall({query:'松果'}).entries.length,0);
 assert.equal(recallLocalConversationHistory(store.db,{...scope(a),platform:'qq'}).entries.length,0);
 assert.throws(()=>createRuntimeConversationMemory({store,contact:{...a,identityVerified:false}}),/稳定身份/);
});
test('追加原文幂等且保留旧版本，过长原文仍留档，模型回溯按预算跳过',t=>{
 const store=fixture(t),c=contact(),s=scope(c),messages=[{id:'one',sender:'incoming',text:'合成原话第一版'}];
 assert.equal(appendConversationOriginals(store.db,s,messages,{now:100}).stored,1);
 assert.equal(appendConversationOriginals(store.db,s,messages,{now:200}).stored,0);
 appendConversationOriginals(store.db,s,[{...messages[0],text:'合成原话第二版'}],{now:300});
 appendConversationOriginals(store.db,s,[{id:'long',sender:'incoming',text:'合成'.repeat(6000)}],{now:400});
 assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM conversation_originals_v1').get().n,3);
 const rows=readConversationOriginals(store.db,s).records;
 assert.equal(rows.length,2);assert.ok(rows.some(x=>x.content.length===12000));
 assert.deepEqual(recallLocalConversationHistory(store.db,s).entries.map(x=>x.content),['合成原话第二版']);
});
test('撤销最新原文后旧版本不会复活，群发言者以会话内匿名标记分开',t=>{
 const store=fixture(t),c=contact('a',true),s=scope(c);
 appendConversationOriginals(store.db,s,[{id:'same',sender:'incoming',text:'合成旧版',memberId:`member:${'d'.repeat(64)}`}],{now:100});
 appendConversationOriginals(store.db,s,[{id:'same',sender:'incoming',text:'合成新版',memberId:`member:${'e'.repeat(64)}`}],{now:200});
 const h=recallLocalConversationHistory(store.db,s);assert.match(h.entries[0].speaker,/历史成员-/);assert.doesNotMatch(JSON.stringify(h),/member:/);
 store.db.exec('UPDATE conversation_originals_v1 SET revoked=1 WHERE seq=2');
 assert.equal(readConversationOriginals(store.db,s).records.length,0);
});
test('真实ChatAgent构造路径使用新记忆，同时保留手编人格和已有观看兴趣',async t=>{
 const store=fixture(t),c=contact();let request;
 const agent=new ChatAgent({config:{apiKey:''},getMemoryStore:()=>store,createConversationMemory:({scopeToken,messages})=>createRuntimeConversationMemory({store,contact:memoryContactFromToken(scopeToken),messages}),personaMemory:{snapshot:()=>({manualText:'合成手编人格正文',interests:[{topic:'合成公开兴趣',signal:'like',evidenceCount:1,evidence:[{basisCode:'sustained-watch'}]}]})},replyProvider:async input=>{request=input;return{text:'好消息呀。'};}});
 await agent.reply({messages:[{id:'new',sender:'incoming',text:'我考上了，好开心'}],memoryScopeToken:bindMemoryContact(c),conversation:{displayName:c.name,isGroup:false}});
 assert.equal(agent.lastMemoryContext.mode,'scoped-memory-v1');assert.ok(agent.lastMemoryContext.available);
 assert.match(request.system,/合成手编人格正文/);assert.match(request.system,/合成公开兴趣/);assert.match(request.system,/本轮语气范例/);
 assert.equal(request.tools,undefined);
});
test('宿主撤销当前会话许可后，已经签发的会话记忆也立即失效',t=>{
 const store=fixture(t),c=contact();let allowed=true;
 const {session}=createRuntimeConversationMemory({store,contact:c,messages:[{id:'old',sender:'incoming',text:'合成旧事松果'}],isAuthorized:()=>allowed});
 assert.equal(session.recall({query:'松果'}).entries.length,1);allowed=false;
 assert.throws(()=>session.history(),/撤销/);assert.throws(()=>session.recall({query:'松果'}),/撤销/);
});
