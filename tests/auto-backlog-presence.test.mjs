import test from 'node:test';
import assert from 'node:assert/strict';
import { interactionPresence, interactionStatus } from '../interaction-status.mjs';

const now = Date.parse('2026-10-28T10:00:00Z');
function fixture() {
  return {now,modelReady:true,friend:{policy:{enabled:true},status:'running'},chat:{running:true,worker:{alive:true,status:'running',heartbeatAt:now-500},policy:{allowlist:[{id:'one',name:'许可甲',isGroup:false},{id:'group',name:'许可群',isGroup:true}]},contacts:[{id:'one',status:'ready',lastCheckedAt:now-2000},{id:'group',status:'ready',lastCheckedAt:now-3000}]}};
}
const assertNormalText = value => assert.doesNotMatch([value.reply.label,value.reply.reason,value.review.label,value.review.reason].join(' '), /\d+ 条未答|人工核对|已核实的.*个会话继续|处理后不会补发/);
function queue(f, index=1, extra={}) { Object.assign(f.chat.contacts[index],{status:'paused',reason:'会话暂时不可读，等待自动重试。',recovery:{autoPendingCount:1,autoRetryCount:1},...extra}); f.chat.recovery={autoPendingCount:1,autoRetryCount:1,pendingManualCount:2}; return f; }

test('正常在线与旧历史记录均不生成未答核对提示',()=>{
  const f=fixture(); let p=interactionPresence(f);assert.equal(p.reply.status,'online');assert.equal(p.reply.online,true);
  f.chat.recovery={pendingManualCount:2};f.chat.contacts[0].unanswered=[{text:'私密原文',handledByUserAt:null}];
  p=interactionPresence(f);assert.equal(p.reply.status,'online');assert.equal(p.reply.online,true);assert.equal(p.review.active,false);assert.equal(p.pendingManualCount,2);assertNormalText(p);assert.doesNotMatch(JSON.stringify(p),/私密原文|许可甲|许可群/);
});
test('总队列数只在后台返回，正常会话显示回复中',()=>{
  const f=fixture();f.chat.recovery={autoPendingCount:4,autoRetryCount:3};const p=interactionPresence(f);
  assert.equal(p.reply.status,'replying');assert.equal(p.reply.label,'在线 · 回复中');assert.equal(p.autoPendingCount,4);assert.equal(p.autoRetryCount,3);assert.equal(p.review.active,false);assertNormalText(p);
});
test('没有总数时可从各会话精确队列字段汇总',()=>{
  const f=queue(fixture());delete f.chat.recovery;const p=interactionPresence(f);
  assert.equal(p.autoPendingCount,1);assert.equal(p.autoRetryCount,1);assert.equal(p.reply.status,'replying');assert.equal(p.reply.online,true);assert.equal(p.review.identityPaused,false);assertNormalText(p);
});
test('明确自动恢复的暂停会话可显示处理中，不把会话字样误判为身份问题',()=>{
  const p=interactionPresence(queue(fixture()));assert.equal(p.reply.status,'replying');assert.equal(p.reply.online,true);assert.equal(p.review.active,false);assertNormalText(p);
});
test('只有总队列数不能把未知暂停会话冒充在线',()=>{
  const f=queue(fixture());delete f.chat.contacts[1].recovery;const p=interactionPresence(f);
  assert.equal(p.reply.online,false);assert.equal(p.reply.label,'回复暂缓');assertNormalText(p);
});
test('自动重试不能覆盖身份不明或许可不足，健康会话继续接收',()=>{
  const f=queue(fixture(),1,{identityReviewRequired:true,reason:'群聊身份未通过核对。'});const p=interactionPresence(f);
  assert.equal(p.reply.online,true);assert.equal(p.review.identityPaused,true);assert.equal(p.reply.label,'在线 · 回复中');assertNormalText(p);
  f.chat.contacts[0]={...f.chat.contacts[0],status:'paused',identityReviewRequired:true};const blocked=interactionPresence(f);
  assert.equal(blocked.reply.online,false);assert.match(blocked.reply.reason,/重新读取联系人.*许可名单/);
});
test('内容含群聊但无身份问题不应阻止明确自动补答',()=>{
  const p=interactionPresence(queue(fixture(),1,{reason:'群聊消息需要重新读取后自动重试。'}));assert.equal(p.reply.online,true);assert.equal(p.review.identityPaused,false);
});
test('明确加入读回队列的uncertain只显示处理中，不冒充已送达',()=>{
  const p=interactionPresence(queue(fixture(),1,{status:'delivery-uncertain',reason:'发送结果尚未读回。'}));
  assert.equal(p.reply.online,true);assert.equal(p.reply.label,'在线 · 回复中');assert.equal(p.review.deliveryUncertain,0);assert.equal(p.review.active,false);assert.doesNotMatch(p.reply.reason,/已确认|已送达|发送成功/);assertNormalText(p);
});
test('没有自动恢复证据的uncertain仍保护且不要求手动清未答',()=>{
  const f=fixture();f.chat.contacts[1].status='delivery-uncertain';const p=interactionPresence(f);
  assert.equal(p.reply.online,false);assert.equal(p.review.deliveryUncertain,1);assert.match(p.reply.reason,/未确认发送不会自动重发/);assertNormalText(p);
});
test('auto-readback只接受会话自身队列证据，保持心跳和检查时间门槛',()=>{
  const f=queue(fixture(),1,{status:'auto-readback'});assert.equal(interactionPresence(f).reply.label,'在线 · 回复中');
  delete f.chat.contacts[1].recovery;assert.equal(interactionPresence(f).reply.online,false);
  f.chat.contacts[1].recovery={autoPendingCount:1,requiresUserAction:true};assert.equal(interactionPresence(f).reply.online,false);
  f.chat.contacts[1].recovery={autoPendingCount:1};f.chat.contacts[1].lastCheckedAt=now-121000;assert.equal(interactionPresence(f).reply.online,false);
  f.chat.contacts[1].lastCheckedAt=now-500;f.chat.worker.heartbeatAt=now-6000;assert.equal(interactionPresence(f).reply.online,false);
});
for (const [name,change] of [
  ['总开关关闭',f=>{f.friend.policy.enabled=false;}],
  ['没有模型',f=>{f.modelReady=false;}],
  ['worker失效',f=>{f.chat.worker.alive=false;}],
  ['心跳超期',f=>{f.chat.worker.heartbeatAt=now-6000;}],
  ['心跳异常领先',f=>{f.chat.worker.heartbeatAt=now+5000;}],
  ['服务已停',f=>{f.chat.running=false;}],
  ['会话检查超期',f=>{f.chat.contacts[1].lastCheckedAt=now-121000;}],
  ['未读到许可会话',f=>{f.chat.contacts.pop();}],
  ['没有许可名单',f=>{f.chat.policy.allowlist=[];}],
]) test(`自动队列不掩盖${name}`,()=>{const f=queue(fixture());change(f);assert.equal(interactionPresence(f).reply.online,false);});
test('普通暂时错误且有明确自动队列时可恢复，登录验证码仍需操作',()=>{
  const f=queue(fixture());f.friend.lastError='消息页暂时重绘';assert.equal(interactionPresence(f).reply.online,true);
  for(const message of ['请完成验证码','登录状态失效','许可已撤销']){f.friend.lastError=message;const p=interactionPresence(f);assert.equal(p.reply.online,false);assert.doesNotMatch(p.reply.reason,/人工核对.*未答/);}
});
test('账号操作标记即使挂在ready会话或顶层也不能被自动队列掩盖',()=>{
  const f=queue(fixture());f.chat.recovery.requiresUserAction=true;assert.equal(interactionPresence(f).reply.online,false);
  delete f.chat.recovery.requiresUserAction;f.chat.contacts[0].recovery={requiresUserAction:true};assert.equal(interactionPresence(f).reply.online,false);
  assert.match(interactionPresence(f).reply.reason,/登录或验证码/);
});
test('自动队列中的inflight需要显式恢复证据',()=>{
  const f=queue(fixture(),1,{status:'inflight',pending:{phase:'model',at:now-900000}});assert.equal(interactionPresence(f).reply.online,true);
  delete f.chat.contacts[1].recovery;assert.equal(interactionPresence(f).reply.online,false);
});
test('正常inflight各工作阶段无需遗留计数，但180秒超时仍不能冒充处理中',()=>{
  for(const phase of ['observing','model','sending','outbound-wait','recovering']){
    const f=fixture();f.chat.contacts[1]={...f.chat.contacts[1],status:'inflight',pending:{phase,at:now-1000}};
    assert.equal(interactionPresence(f).reply.label,'在线 · 回复中');
    f.chat.contacts[1].pending.at=now-180001;assert.equal(interactionPresence(f).reply.online,false);
  }
  const f=fixture();f.chat.contacts[1]={...f.chat.contacts[1],status:'inflight',pending:{phase:'unknown',at:now-1000}};assert.equal(interactionPresence(f).reply.online,false);
  f.chat.contacts[1].recovery={autoPendingCount:1};assert.equal(interactionPresence(f).reply.online,false);
});
test('补答auto-backlog阶段需要会话自己的明确队列计数',()=>{
  const f=queue(fixture(),1,{status:'inflight',pending:{phase:'auto-backlog',at:now-1000}});assert.equal(interactionPresence(f).reply.label,'在线 · 回复中');
  delete f.chat.contacts[1].recovery;assert.equal(interactionPresence(f).reply.online,false);
});
test('负数或非整数恢复数不会被当作自动恢复授权',()=>{
  for(const value of [-1,Infinity,'1',0.5]){const f=queue(fixture());f.chat.contacts[1].recovery={autoPendingCount:value,autoRetryCount:value};f.chat.recovery={autoPendingCount:value,autoRetryCount:value};assert.equal(interactionPresence(f).reply.online,false);}
});
test('独立分享的uncertain保持原来的暂停和人工收据入口契约',()=>{
  const f=queue(fixture());f.share={enabled:true,paused:true,recoveryRequired:true,needsReview:[{operationId:'share-one',status:'uncertain'}]};const p=interactionPresence(f);
  assert.equal(p.reply.online,true);assert.equal(p.reply.label,'在线 · 回复中');assert.equal(p.review.shareReviewCount,1);assert.match(p.review.reason,/独立分享收据/);assert.doesNotMatch(p.reply.reason,/独立分享收据/);assert.doesNotMatch(p.review.reason,/系统.*检查原收据|自动.*核对分享/);
  const row=interactionStatus(f).rows.find(item=>item.id==='share');assert.equal(row.running,false);assert.match(row.message,/未确认发送.*暂停/);
});
test('观看与回复状态仍分开，补答优先显示回复中',()=>{
  const f=queue(fixture());f.watch={running:true,worker:{alive:true,heartbeatAt:now-500},phase:'model'};let p=interactionPresence(f);
  assert.equal(p.reply.label,'在线 · 回复中');assert.equal(p.watch.active,true);assert.equal(p.watch.label,'正在挑选视频');
  f.friend.policy.enabled=false;p=interactionPresence(f);assert.equal(p.reply.online,false);assert.equal(p.watch.active,true);
});
test('状态行不再声称只处理启动后消息，不扩大许可边界',()=>{
  const f=queue(fixture());const p=interactionStatus(f);const text=p.rows.find(row=>row.id==='chat').message;
  assert.match(text,/许可会话.*可恢复待答/);assert.doesNotMatch(text,/只处理启动后|待核对事项/);
  assert.match(p.note,/保留所选名单/);
});

