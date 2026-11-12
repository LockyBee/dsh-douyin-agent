import { createMemorySession } from './conversation-memory.mjs';
import { sourceAwareEntry } from './qq-sync.mjs';
import { isChatShareableMemory } from './memory.mjs';
import { appendConversationOriginals, readConversationOriginals, recallLocalConversationHistory } from './conversation-history-store.mjs';
import { hasStableConversationIdentity } from './contact-authorization.mjs';
import { ownerPrivateNotes, recentOwnerQQContext } from './owner-qq-context.mjs';
const CONTACTS=new WeakMap();
export function bindMemoryContact(contact){if(!hasStableConversationIdentity(contact))return null;const token=Object.freeze({});CONTACTS.set(token,structuredClone(contact));return token;}
export function memoryContactFromToken(token){const contact=token&&CONTACTS.get(token);if(!contact)throw new TypeError('会话记忆缺少可信宿主绑定。');return structuredClone(contact);}

/** 入口在ChatService完成当前许可核对后绑定，不接受聊天中的昵称或跨平台身份声明。 */
export function createRuntimeConversationMemory({store,contact,messages=[],host='desktop',isAuthorized=()=>true}={}) {
  if(!store?.db||typeof store.recallForChat!=='function'||!hasStableConversationIdentity(contact))throw new TypeError('会话记忆需要当前许可会话的稳定身份。');
  const authorize=()=>{if(typeof isAuthorized!=='function'||isAuthorized(contact)!==true)throw new Error('当前会话的记忆许可已撤销。');};authorize();
  const scope={platform:'douyin',conversationId:contact.id,isGroup:contact.isGroup};
  const saved=appendConversationOriginals(store.db,scope,messages.slice(-50));
  const qq=store.syncQQ();
  const getContext=()=>{authorize();return {...scope,sharedEnabled:store.qqConnection?.available===true&&store.qqConnection?.shared===true};};
  function loadRecords({query='',refs=[]}={}){
    const recalled=store.recallForChat({query,limit:100});
    const allowQQ=recalled.connections?.qq?.available===true&&recalled.connections?.qq?.shared===true;
    const records=new Map();
    const add=(item,depth=0)=>{
      if(!item||!isChatShareableMemory(item)||records.has(item.id)||depth>8)return;
      records.set(item.id,item);
      for(const ref of item.metadata?.sourceMemoryRefs||[]){
        const row=store.db.prepare('SELECT * FROM memory_entries WHERE id=?').get(ref.id);
        const parent=row&&sourceAwareEntry(store.db,row,{allowQQSources:allowQQ});if(parent&&parent.updatedAt===ref.updatedAt)add(parent,depth+1);
      }
    };
    for(const row of recalled.entries)add(row);
    for(const ref of refs){const row=store.db.prepare('SELECT * FROM memory_entries WHERE id=?').get(ref.id);if(row)add(sourceAwareEntry(store.db,row,{allowQQSources:allowQQ}));}
    const local=readConversationOriginals(store.db,scope),all=[...records.values(),...local.records],window=all.slice(0,5000);
    window.sourceWindowLimited=local.windowLimited||all.length>5000;return window;
  }
  const session=createMemorySession({host,getContext,loadRecords,retrievalMode:'lexical',historyReader:({context,...options})=>recallLocalConversationHistory(store.db,context,options),
    externalHistory:({query})=>{authorize();return qq.available===true&&qq.shared===true
      ? [...recentOwnerQQContext({store,contact,isAuthorized}).slice(-4),...ownerPrivateNotes({store,contact,isAuthorized,query})] : [];}});
  return {session,retainedOriginals:saved,connections:{qq:qq.available===true&&qq.shared===true}};
}
