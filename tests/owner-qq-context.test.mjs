import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {MemoryStore} from '../memory.mjs';
import {ChatAgent} from '../chat-agent.mjs';
import {ownerPrivateNotes,recentOwnerQQContext} from '../owner-qq-context.mjs';
import {createRuntimeConversationMemory,bindMemoryContact,memoryContactFromToken} from '../runtime-conversation-memory.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'owner-qq-cross-')),qqPath=path.join(root,'qq.sqlite'),configPath=path.join(root,'qq.yaml'),central=path.join(root,'shared.sqlite');
  const qq=new DatabaseSync(qqPath);
  qq.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY,conversation_key TEXT,role TEXT,content_json TEXT,created_at INTEGER,sender_id TEXT,sender_name TEXT); CREATE TABLE runtime_settings(key TEXT PRIMARY KEY,value_json TEXT); CREATE TABLE conversations(key TEXT); CREATE TABLE memories(id INTEGER,conversation_key TEXT,subject TEXT,content TEXT,confidence REAL,status TEXT,created_at INTEGER,updated_at INTEGER);');
  qq.prepare('INSERT INTO conversations VALUES (?)').run('private:12345');qq.prepare('INSERT INTO conversations VALUES (?)').run('private:67890');
  const now=Date.now(),contact={id:'conv:'+'a'.repeat(64),name:'合成本人',isGroup:false,identityVerified:true,identityBinding:'binding:'+'b'.repeat(64),identityVersion:2,identityKind:'rendered-user',identityHash:'a'.repeat(64)};
  const link={version:1,enabled:true,qqOwner:'12345',douyinId:contact.id,douyinBinding:contact.identityBinding,douyinIdentityHash:contact.identityHash};
  fs.writeFileSync(configPath,'ownerQQ: "12345"\nmemory:\n  shared: true\ndeny:\n  private: []\n  groups: []\n');
  const setLink=()=>fs.writeFileSync(path.join(root,'owner-cross-platform.json'),JSON.stringify(link));setLink();
  const put=(id,key,role,text)=>qq.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run(id,key,role,JSON.stringify({role,content:text}),now-1000+id,null,null);
  put(1,'private:12345','user','合成QQ本人消息木槿');put(2,'private:12345','assistant','合成QQ本人回复');put(3,'private:67890','user','合成他人秘密');
  const store=new MemoryStore(central,{qqMemoryPath:qqPath,qqConfigPath:configPath});
  t.after(()=>{store.close();qq.close();});
  return {root,qqPath,configPath,qq,contact,link,setLink,store,now,override:value=>qq.prepare('INSERT OR REPLACE INTO runtime_settings VALUES (?,?)').run('console-overrides',JSON.stringify(value))};
}
test('本人映射只读近期QQ，保护其他人和已关闭共享的记录',t=>{
  const f=fixture(t),args={store:f.store,contact:f.contact,isAuthorized:()=>true,now:f.now};
  const actual=recentOwnerQQContext(args);assert.ok(actual.some(row=>row.content.includes('木槿')));assert.ok(!JSON.stringify(actual).includes('他人秘密'));
  assert.deepEqual(recentOwnerQQContext({...args,contact:{...f.contact,id:'conv:'+'c'.repeat(64),identityHash:'c'.repeat(64)}}),[]);
  assert.deepEqual(recentOwnerQQContext({...args,contact:{...f.contact,isGroup:true,identityKind:'rendered-group'}}),[]);
  assert.deepEqual(recentOwnerQQContext({...args,isAuthorized:()=>false}),[]);
  f.link.douyinBinding='binding:'+'d'.repeat(64);f.setLink();assert.deepEqual(recentOwnerQQContext(args),[]);f.link.douyinBinding=f.contact.identityBinding;f.setLink();
  f.override({memory:{shared:false}});assert.deepEqual(recentOwnerQQContext(args),[]);
  f.override({memory:{shared:true},deny:{private:['12345']}});assert.deepEqual(recentOwnerQQContext(args),[]);
});
test('真实抖音模型请求构造只向已验证本人注入QQ近期记录',async t=>{
  const f=fixture(t);let request;
  assert.equal(f.store.syncQQ().shared,true);
  const foreign=f.store.db.prepare("SELECT id,updated_at FROM memory_entries WHERE external_key LIKE '%:message:3'").get();
  assert.ok(foreign);
  f.store.remember({content:'合成本人的木槿偏好',source:'screen-companion',metadata:{sourceType:'private',privacy:'internal-reference'}});
  f.store.remember({content:'其他人的木槿私密笔记',source:'unverified-other',metadata:{sourceType:'private',privacy:'internal-reference'}});
  f.store.remember({content:'来自他人的木槿派生笔记',source:'screen-companion',metadata:{sourceType:'private',privacy:'internal-reference',sourceMemoryRefs:[{id:foreign.id,updatedAt:foreign.updated_at}]}});
  const notes=ownerPrivateNotes({store:f.store,contact:f.contact,isAuthorized:()=>true,query:'木槿'});
  assert.ok(notes.some(row=>row.content.includes('合成本人的木槿偏好')));assert.ok(!JSON.stringify(notes).includes('其他人的木槿私密笔记'));assert.ok(!JSON.stringify(notes).includes('来自他人的木槿派生笔记'));
  assert.deepEqual(ownerPrivateNotes({store:f.store,contact:{...f.contact,id:'conv:'+'c'.repeat(64),identityHash:'c'.repeat(64)},isAuthorized:()=>true,query:'木槿'}),[]);
  f.store.syncQQ=()=>({available:true,shared:true});f.store.recallForChat=()=>({entries:[],connections:{qq:{available:true,shared:true}}});
  const agent=new ChatAgent({config:{apiKey:''},getMemoryStore:()=>f.store,createConversationMemory:({scopeToken,messages})=>createRuntimeConversationMemory({store:f.store,contact:memoryContactFromToken(scopeToken),messages,isAuthorized:()=>true}),replyProvider:async input=>{request=input;return{text:'合成回复'};}});
  await agent.reply({messages:[{id:'dy1',sender:'incoming',text:'木槿'}],memoryScopeToken:bindMemoryContact(f.contact),conversation:{displayName:f.contact.name,isGroup:false}});
  assert.match(request.system,/合成QQ本人消息木槿/);assert.doesNotMatch(request.system,/合成他人秘密/);
  assert.match(request.system,/合成本人的木槿偏好/);assert.doesNotMatch(request.system,/其他人的木槿私密笔记/);assert.doesNotMatch(request.system,/来自他人的木槿派生笔记/);
});
