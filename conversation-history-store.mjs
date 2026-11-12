import { createHash } from 'node:crypto';
import { validScope } from './memory-policy.mjs';
import { recallConversationHistory } from './memory-history.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key=scope=>hash([scope.platform,scope.conversationId,scope.isGroup]);
export function ensureConversationHistory(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_originals_v1 (
    seq INTEGER PRIMARY KEY,scope_key TEXT NOT NULL,message_key TEXT NOT NULL,revision TEXT NOT NULL,
    role TEXT NOT NULL,content TEXT NOT NULL,member_key TEXT,created_at INTEGER NOT NULL,observed_at INTEGER NOT NULL,
    time_basis TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,UNIQUE(scope_key,message_key,revision));
    CREATE INDEX IF NOT EXISTS conversation_originals_scope ON conversation_originals_v1(scope_key,created_at DESC,seq DESC);`);
}
/** 仅由已通过许可和稳定身份核对的宿主调用；原文版本追加，模型不能指定会话。 */
export function appendConversationOriginals(db,scope,messages,{now=Date.now()}={}) {
  if(!validScope(scope)||scope.platform!=='douyin'||!/^conv:[a-f0-9]{64}$/.test(scope.conversationId)||!Array.isArray(messages)||messages.length>50)throw new TypeError('原文留档需要已核对的抖音会话和有界消息。');
  ensureConversationHistory(db);
  const insert=db.prepare('INSERT OR IGNORE INTO conversation_originals_v1(scope_key,message_key,revision,role,content,member_key,created_at,observed_at,time_basis) VALUES(?,?,?,?,?,?,?,?,?)');
  let stored=0,omitted=0;
  db.exec('SAVEPOINT conversation_originals_append');
  try{
    for(const message of messages){
      if(typeof message?.id!=='string'||!message.id||message.id.length>1000||!['incoming','outgoing'].includes(message.sender)||typeof message.text!=='string'||!message.text.trim()||message.text.length>256000){omitted++;continue;}
      const native=Date.parse(message.nativeCreatedAt),created=Number.isSafeInteger(native)&&native>=0&&native<=now?native:now;
      const role=message.sender==='incoming'?'user':'assistant',member=scope.isGroup&&/^member:[a-f0-9]{64}$/.test(message.memberId||'')?hash(message.memberId).slice(0,12):null,revision=hash([role,message.text,message.nativeCreatedAt||null,member]);
      stored+=Number(insert.run(key(scope),hash(message.id),revision,role,message.text,member,created,now,created===native?'native-created-at':'observed-at').changes);
    }
    db.exec('RELEASE conversation_originals_append');return {stored,omitted};
  }catch(error){db.exec('ROLLBACK TO conversation_originals_append');db.exec('RELEASE conversation_originals_append');throw error;}
}
export function readConversationOriginals(db,scope,{before,cursor}={}) {
  if(!validScope(scope))throw new TypeError('原文回溯需要可信会话。');
  ensureConversationHistory(db);
  let boundary=before;
  if(cursor!==undefined){
    try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(Number.isSafeInteger(value.t)&&value.t>=0)boundary=value.t+1;}catch{}
  }
  const rows=db.prepare(`SELECT a.* FROM conversation_originals_v1 a WHERE scope_key=? AND revoked=0 AND (? IS NULL OR created_at<?)
    AND NOT EXISTS(SELECT 1 FROM conversation_originals_v1 b WHERE b.scope_key=a.scope_key AND b.message_key=a.message_key AND b.seq>a.seq)
    ORDER BY created_at DESC,seq DESC LIMIT 5001`).all(key(scope),boundary??null,boundary??null);
  return {windowLimited:rows.length>5000,records:rows.slice(0,5000).map(row=>({id:`dyraw:${row.seq}`,updatedAt:row.observed_at,createdAt:row.created_at,
    content:row.content,kind:'history',origin:'douyin-history',status:'observed-history',scope:{...scope},metadata:{role:row.role,...(row.member_key?{speaker:`历史成员-${row.member_key}`}:{speaker:scope.isGroup?'历史发言人未核对':'当前会话'}),sourceType:scope.isGroup?'group':'private',...(scope.isGroup?{}:{privacy:'internal-reference'}),sourceRevision:row.revision,timeBasis:row.time_basis}}))};
}
export function recallLocalConversationHistory(db,context,options={}) {
  const {records,windowLimited}=readConversationOriginals(db,context,options);
  return {...recallConversationHistory({records,context,...options}),windowLimited};
}
