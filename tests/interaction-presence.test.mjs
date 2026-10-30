import test from 'node:test';
import assert from 'node:assert/strict';
import { interactionPresence, interactionStatus } from '../interaction-status.mjs';

const now = Date.parse('2026-10-24T13:00:00Z');
function fixture() {
  return {now,modelReady:true,friend:{policy:{enabled:true},status:'running'},chat:{running:true,worker:{alive:true,status:'running',heartbeatAt:new Date(now-500).toISOString()},policy:{allowlist:[{id:'one'},{id:'group'}]},contacts:[{id:'one',status:'ready',lastCheckedAt:new Date(now-2000).toISOString()},{id:'group',status:'ready',lastCheckedAt:new Date(now-3000).toISOString()}]}};
}

test('完整核查周期超过45秒时按实际周期判断，失效心跳和超期核查仍不算在线', () => {
  for (const manualCount of [0, 2]) {
    const f = fixture(); f.chat.fullScanSeconds = 60; f.chat.recovery = { pendingManualCount: manualCount };
    for (const contact of f.chat.contacts) contact.lastCheckedAt = now - 65_000;
    assert.equal(interactionPresence(f).online, true);
    f.chat.contacts[0].lastCheckedAt = now - 77_000;
    assert.equal(interactionPresence(f).online, false);
    f.chat.contacts[0].lastCheckedAt = now - 65_000; f.chat.worker.heartbeatAt = now - 6000;
    assert.equal(interactionPresence(f).online, false);
    f.chat.worker.heartbeatAt = now - 500; f.chat.fullScanSeconds = 86400; f.chat.contacts[0].lastCheckedAt = now - 121_000;
    assert.equal(interactionPresence(f).online, false);
  }
});

test('单个身份暂停保留内部状态，健康会话在线且顶栏不显示核对数量', () => {
  const f = fixture(); f.chat.contacts[1] = { ...f.chat.contacts[1], status: 'paused', identityReviewRequired: true, reason: '群聊身份需核对' }; f.chat.recovery = { pendingManualCount: 2 };
  const p = interactionPresence(f); assert.equal(p.online, true); assert.equal(p.status, 'online'); assert.equal(p.label, '在线 · 等待消息'); assert.equal(p.review.identityPaused, true); assert.equal(p.review.manualCount, 2);
  f.chat.worker.heartbeatAt = now - 6000; assert.equal(interactionPresence(f).online, false);
  f.chat.worker.heartbeatAt = now - 500; f.chat.contacts[0].lastCheckedAt = now - 121000; assert.equal(interactionPresence(f).online, false);
});
test('在线必须有真实心跳、模型、总许可和全部所选会话的接收证据',()=>{
  const f=fixture();assert.equal(interactionPresence(f).status,'online');assert.equal(interactionPresence(f).online,true);
  for(const change of [x=>x.friend.policy.enabled=false,x=>x.modelReady=false,x=>x.chat.worker.alive=false,x=>x.chat.running=false,x=>x.chat.worker.heartbeatAt=new Date(now-6000).toISOString(),x=>x.chat.contacts[1].status='paused',x=>x.chat.contacts[1].lastCheckedAt=new Date(now-121000).toISOString(),x=>x.chat.contacts.pop()]){const next=fixture();change(next);assert.equal(interactionPresence(next).online,false);}
});
test('观看与回复状态按真实工作阶段显示，待回复优先于观看',()=>{
  const f=fixture();f.watch={running:true,worker:{alive:true,heartbeatAt:now-500},phase:'observing'};
  assert.equal(interactionPresence(f).status,'watching');
  f.chat.contacts[0].pending={phase:'model',at:new Date(now-1000).toISOString()};
  assert.equal(interactionPresence(f).status,'replying');assert.equal(interactionPresence(f).online,true);
  f.chat.contacts[0].status='inflight';f.chat.contacts[0].pending.phase='sending';assert.equal(interactionPresence(f).status,'replying');
  f.chat.contacts[0].status='delivery-uncertain';assert.equal(interactionPresence(f).status,'attention');assert.equal(interactionPresence(f).online,false);
});
test('保存、启动和失效观看不冒充在线，旧待答记录不再要求人工清除',()=>{
  const f=fixture();f.friend.status='waiting-settings';assert.equal(interactionPresence(f).status,'preparing');
  f.friend.status='starting';assert.equal(interactionPresence(f).online,false);
  f.friend.status='running';f.chat.recovery={pendingManualCount:1,recoverableCount:0};assert.equal(interactionPresence(f).label,'在线 · 等待消息');assert.equal(interactionPresence(f).review.active,false);assert.equal(interactionPresence(f).online,true);
  f.chat.recovery={pendingManualCount:0,recoverableCount:1};assert.equal(interactionPresence(f).status,'replying');
  f.chat.recovery.recoverableCount=0;f.watch={running:true,worker:{alive:true,heartbeatAt:now-6000}};assert.equal(interactionPresence(f).status,'online');
  f.share={paused:true};assert.equal(interactionPresence(f).online,true);assert.match(interactionPresence(f).review.reason,/分享送达未确认/);
});
test('历史已核对待答不一直阻止在线，公开presence不带消息或联系人正文',()=>{
  const f=fixture();f.chat.contacts[0].unanswered=[{handledByUserAt:new Date(now).toISOString(),text:'私密原文不进入状态栏'}];
  const presence=interactionPresence(f);assert.equal(presence.online,true);assert.equal(JSON.stringify(presence).includes('私密原文'),false);
  const status=interactionStatus({...f,now:undefined});assert.ok(status.presence);assert.equal(status.rows.some(item=>item.id==='spark'),false);
});

test('有明确活动收据的分享显示进行中，好友待答仍优先展示',()=>{
  const f=fixture();
  f.share={enabled:true,paused:false,busy:true,inProgress:true,recoveryRequired:false,needsReview:[],activity:{status:'sending',phase:'reserved',operationId:'synthetic-active-share'}};
  assert.equal(interactionPresence(f).status,'sharing');assert.equal(interactionPresence(f).online,true);
  f.share.activity.phase='clicking';assert.equal(interactionPresence(f).label,'在线 · 分享中');
  const row=interactionStatus(f).rows.find(item=>item.id==='share');assert.equal(row.running,true);assert.match(row.message,/正在分享/);
  f.chat.contacts[0].pending={phase:'model',at:new Date(now-500).toISOString()};assert.equal(interactionPresence(f).status,'replying');
  f.chat.worker.alive=false;assert.equal(interactionPresence(f).online,false);
});

test('观看运行而回复关闭时分别显示观看与回复，不把观看算成回复在线',()=>{
  const f=fixture();f.friend={policy:{enabled:false},enabled:false,status:'disabled'};f.chat.running=false;f.watch={running:true,phase:'model',worker:{alive:true,heartbeatAt:now-500}};
  const p=interactionPresence(f);
  assert.equal(p.online,false);assert.equal(p.reply.online,false);assert.equal(p.reply.label,'回复已关闭');
  assert.equal(p.watch.active,true);assert.equal(p.watch.label,'正在挑选视频');
  assert.match(p.label,/正在挑选视频/);assert.match(p.label,/回复已关闭/);assert.doesNotMatch(p.label,/^离线$/);
});
test('正常收信、启动未就绪、待核对和断连都保留独立回复原因',()=>{
  const normal=fixture();normal.watch={running:true,phase:'observing',worker:{alive:true,heartbeatAt:now-500}};
  let p=interactionPresence(normal);assert.equal(p.online,true);assert.equal(p.status,'watching');assert.equal(p.reply.online,true);assert.equal(p.watch.active,true);
  normal.friend.status='starting';normal.chat.starting=true;p=interactionPresence(normal);assert.equal(p.online,false);assert.equal(p.reply.status,'preparing');assert.match(p.label,/准备中/);
  const pending=fixture();pending.watch={running:true,phase:'observing',worker:{alive:true,heartbeatAt:now-500}};pending.chat.recovery={pendingManualCount:1,recoverableCount:0};p=interactionPresence(pending);
  assert.equal(p.status,'watching');assert.equal(p.online,true);assert.doesNotMatch(p.label,/待核对|未答/);assert.doesNotMatch(p.reason,/人工核对/);assert.equal(p.review.active,false);assert.equal(p.watch.active,true);
  const down=fixture();down.watch={running:true,phase:'observing',worker:{alive:true,heartbeatAt:now-500}};down.chat.running=false;p=interactionPresence(down);
  assert.equal(p.status,'attention');assert.equal(p.online,false);assert.equal(p.reply.label,'回复未就绪');assert.equal(p.watch.active,true);
});
test('回复关闭时仍独立显示身份暂停、送达不确定和回复异常，不承诺继续检查',()=>{
  const f=fixture();f.friend={policy:{enabled:false},enabled:false,status:'blocked',lastError:'Bearer synthetic-secret 合成异常'};f.chat.contacts[0]={...f.chat.contacts[0],status:'paused',reason:'联系人身份已变化，请核对。'};f.chat.contacts[1]={...f.chat.contacts[1],status:'delivery-uncertain',reason:'发送结果未确认。'};
  const p=interactionPresence(f);
  assert.equal(p.reply.label,'回复已关闭');assert.equal(p.review.active,true);assert.equal(p.review.identityPaused,true);assert.equal(p.review.deliveryUncertain,1);assert.equal(p.review.replyError,true);
  assert.match(p.review.label,/会话身份/);assert.match(p.review.label,/发送结果/);assert.match(p.review.label,/回复服务异常/);
  assert.doesNotMatch(p.review.reason,/新消息仍会继续检查|Bearer|synthetic-secret|联系人身份已变化/);
  assert.doesNotMatch(JSON.stringify(p),/合成异常|synthetic-secret/);
});

test('观看中且回复关闭时保持独立观看状态，旧待答数量仅留内部',()=>{
  const f=fixture();f.friend={policy:{enabled:false},enabled:false,status:'disabled'};f.chat.running=false;f.chat.recovery={pendingManualCount:2,recoverableCount:0};f.watch={running:true,phase:'model',worker:{alive:true,heartbeatAt:now-500}};
  const p=interactionPresence(f);
  assert.equal(p.online,false);assert.equal(p.reply.label,'回复已关闭');assert.equal(p.watch.active,true);
  assert.match(p.label,/正在挑选视频/);assert.match(p.label,/回复已关闭/);
  assert.equal(p.review.active,false);assert.equal(p.review.manualCount,2);
  assert.doesNotMatch(p.review.label,/2 条未答消息/);assert.doesNotMatch(p.review.reason,/人工核对/);
  assert.doesNotMatch(p.reply.reason,/2 条已保留消息/);
  assert.equal(JSON.stringify(p).includes('私密原文'),false);assert.equal(JSON.stringify(p).includes('好友甲'),false);
});

test('回复启动等待显示显式原因而不是无声等待或在线',()=>{
  const f=fixture();f.friend={policy:{enabled:true},status:'preparing',waitReason:'正在准备回复通道，最多打开一个受管聊天页。'};f.chat.running=false;
  const p=interactionPresence(f);assert.equal(p.online,false);assert.equal(p.status,'preparing');assert.equal(p.reply.label,'正在准备回复通道');assert.match(p.reply.reason,/正在准备回复通道/);
  f.friend={policy:{enabled:true},status:'waiting',waitReason:'专用聊天标签页已离开抖音；请准备回复通道。'};
  const q=interactionPresence(f);assert.equal(q.online,false);assert.equal(q.status,'attention');assert.equal(q.reply.label,'等待准备回复通道');assert.match(q.reply.reason,/专用聊天标签页已离开抖音/);
});

test('观看或回复心跳过期后不保留旧活跃状态',()=>{
  const watchStale=fixture();watchStale.friend={policy:{enabled:false},enabled:false};watchStale.watch={running:true,phase:'model',worker:{alive:true,heartbeatAt:now-6000}};
  const p=interactionPresence(watchStale);assert.equal(p.watch.active,false);assert.equal(p.online,false);assert.doesNotMatch(p.label,/正在观看|正在挑选视频/);
  const chatStale=fixture();chatStale.watch={running:true,phase:'observing',worker:{alive:true,heartbeatAt:now-500}};chatStale.chat.worker.heartbeatAt=new Date(now-6000).toISOString();
  const q=interactionPresence(chatStale);assert.equal(q.online,false);assert.equal(q.reply.status,'attention');assert.equal(q.watch.active,true);
  assert.equal(JSON.stringify(q).includes('私密原文'),false);assert.equal(JSON.stringify(q).includes('好友甲'),false);
});


test('分享uncertain只暂停分享，健康聊天在线且独立保留收据提示',()=>{
  const f=fixture();f.share={enabled:true,paused:true,recoveryRequired:true,needsReview:[{operationId:'synthetic-share-uncertain',status:'uncertain'}]};
  const p=interactionPresence(f);assert.equal(p.reply.online,true);assert.equal(p.reply.status,'online');assert.equal(p.review.active,true);assert.equal(p.review.shareReviewCount,1);assert.match(p.review.reason,/分享送达未确认/);assert.doesNotMatch(p.reply.reason,/独立分享收据/);
  const row=interactionStatus(f).rows.find(item=>item.id==='share');assert.equal(row.running,false);assert.match(row.message,/未确认发送.*暂停/);
});

test('分享恢复隔离不能掩盖聊天失活、超期检查或总开关关闭',()=>{
  for(const change of [f=>{f.chat.worker.alive=false;},f=>{f.chat.running=false;},f=>{f.chat.worker.heartbeatAt=now-6000;},f=>{f.chat.contacts[0].lastCheckedAt=now-121000;},f=>{f.friend.policy.enabled=false;}]){
    const f=fixture();f.share={enabled:true,paused:true,recoveryRequired:true,needsReview:[{operationId:'synthetic-share-uncertain',status:'uncertain'}]};change(f);const p=interactionPresence(f);assert.equal(p.reply.online,false);assert.equal(p.review.shareReviewCount,1);assert.match(p.review.reason,/分享送达未确认/);assert.equal(interactionStatus(f).rows.find(item=>item.id==='share').running,false);
  }
});
