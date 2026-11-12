// 本机身份映射由用户授权配置，模型和会话消息不能创建或修改映射。
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readQQConversationHistory } from './qq-history-reader.mjs';
import { loadQQMemoryConfig, recallCentralMemory, resolveMemorySources, scrubMemoryText } from './qq-sync.mjs';
import { hasStableConversationIdentity } from './contact-authorization.mjs';

function policyNow(qqPath, configPath, expectedQQ) {
  let db;
  try {
    const config=loadQQMemoryConfig(qqPath,configPath);
    if(String(config?.ownerQQ)!==expectedQQ)return false;
    db=new DatabaseSync(qqPath,{readOnly:true});db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    const row=db.prepare("SELECT value_json FROM runtime_settings WHERE key='console-overrides'").get();
    const overrides=row?JSON.parse(row.value_json):{};
    const shared=overrides.memory?.shared??config.memory?.shared??false;
    const denied=overrides.deny?.private??config.deny?.private??[];
    return shared===true&&Array.isArray(denied)&&!denied.map(String).includes(expectedQQ);
  } catch {return false;} finally {db?.close();}
}

function ownerLink(store,contact,isAuthorized) {
    if(!store || !path.isAbsolute(store.dbPath) || !path.isAbsolute(store.qqMemoryPath||'') || !path.isAbsolute(store.qqConfigPath||'')
      || !hasStableConversationIdentity(contact) || contact.isGroup!==false || typeof isAuthorized!=='function' || isAuthorized(contact)!==true) return null;
    const mappingPath=path.join(path.dirname(store.dbPath),'owner-cross-platform.json'), stat=lstatSync(mappingPath);
    if(!stat.isFile()||stat.isSymbolicLink())return null;
    const link=JSON.parse(readFileSync(mappingPath,'utf8'));
    if(link?.version!==1||link.enabled!==true||!/^\d{5,15}$/.test(link.qqOwner||'')||link.douyinId!==contact.id
      ||link.douyinBinding!==contact.identityBinding||link.douyinIdentityHash!==contact.identityHash)return null;
    return policyNow(store.qqMemoryPath,store.qqConfigPath,link.qqOwner)?link:null;
}
export function recentOwnerQQContext({store,contact,isAuthorized,now=Date.now()}={}) {
  try {
    const link=ownerLink(store,contact,isAuthorized);if(!link)return [];
    const qqPath=store.qqMemoryPath,configPath=store.qqConfigPath;
    if(!policyNow(qqPath,configPath,link.qqOwner))return [];
    const key=`private:${link.qqOwner}`,scope={platform:'qq',conversationId:'mapped-owner-private',isGroup:false,sharedEnabled:true};
    const result=readQQConversationHistory({qqPath,context:scope,scope,resolveConversationKey:()=>key,loadPolicy:()=>loadQQMemoryConfig(qqPath,configPath),limit:8,maxChars:3600});
    if(!policyNow(qqPath,configPath,link.qqOwner)||isAuthorized(contact)!==true)return [];
    return result.entries.filter(row=>row.createdAt>=now-24*3600*1000&&row.createdAt<=now)
      .map(row=>({role:row.role,content:row.content,createdAt:row.createdAt,source:'qq-private'})).reverse();
  } catch {return [];}
}

/** 仅检索本人已明确保存、可核对全部来源的私密笔记；原生 DSH 来源暂不推断有效。 */
export function ownerPrivateNotes({store,contact,isAuthorized,query}={}) {
  let qq;
  try {
    const link=ownerLink(store,contact,isAuthorized);
    if(!link||typeof query!=='string'||!query.trim()||query.length>200||!store.db)return [];
    qq=new DatabaseSync(store.qqMemoryPath,{readOnly:true});qq.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
    const namespace='qq-'+createHash('sha256').update(path.resolve(store.qqMemoryPath).toLowerCase()).digest('hex').slice(0,20);
    const get=store.db.prepare('SELECT kind,source,origin,external_key,metadata_json FROM memory_entries WHERE id=?');
    const allowed = entry => {
      const resolved=resolveMemorySources(store.db,[{id:entry.id,updatedAt:entry.updatedAt}],{allowQQSources:true});
      for(const ref of resolved.refs){
        const row=get.get(ref.id);if(!row||row.kind==='dsh-native-source')return false;
        const m=JSON.parse(row.metadata_json||'{}'),privateRoot=m.sourceType==='private'||m.privacy==='internal-reference'||String(m.visibility||'').startsWith('private');
        if(['qq','qq-history'].includes(row.origin)){
          if(!privateRoot||!row.external_key?.startsWith(namespace+':'))return false;
          const match=/^(message|memory):([1-9]\d*)$/.exec(row.external_key.slice(namespace.length+1));if(!match)return false;
          const table=match[1]==='message'?'messages':'memories';
          if(qq.prepare(`SELECT conversation_key FROM ${table} WHERE id=?`).get(Number(match[2]))?.conversation_key!==`private:${link.qqOwner}`)return false;
        } else if(privateRoot&&!['screen-companion','dsh-memory'].includes(row.source))return false;
      }
      return true;
    };
    const rows=recallCentralMemory({centralDb:store.db,query,limit:30,origins:['video'],allowQQSources:true})
      .filter(row=>['screen-companion','dsh-memory'].includes(row.source)
        && (row.metadata?.sourceType==='private'||row.metadata?.privacy==='internal-reference') && allowed(row)).slice(0,4)
      .map(row=>({role:'note',content:scrubMemoryText(row.content).slice(0,1200),createdAt:row.createdAt,source:'owner-shared-note'}));
    return ownerLink(store,contact,isAuthorized)?rows:[];
  } catch {return [];} finally {qq?.close();}
}
