const pendingPhases = new Set(['observing', 'model', 'sending', 'outbound-wait', 'recovering']);
const timeOf = value => typeof value === 'number' ? value : Date.parse(value);
const countOf = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const automaticCount = item => countOf(item?.recovery?.autoPendingCount) + countOf(item?.recovery?.autoRetryCount);
const actionable = item => item?.identityReviewRequired === true || item?.recovery?.requiresUserAction === true
  || /登录|验证码|验证挑战|未授权|许可.*(?:不足|失效|撤销)|身份.*(?:变化|不一致|未通过|不明|不足)|联系人已变化|会话(?:标题|头像|类型).*(?:不一致|变化)/.test(String(item?.reason || ''));
const sharingActive = share => share.enabled === true && share.inProgress === true && share.busy === true
  && share.paused !== true && share.recoveryRequired !== true && Array.isArray(share.needsReview) && share.needsReview.length === 0
  && share.activity?.status === 'sending' && ['reserved', 'clicking'].includes(share.activity.phase)
  && typeof share.activity.operationId === 'string' && Boolean(share.activity.operationId);
export function interactionPresence({chat={},share={},watch={},modelReady=false,friend,now=Date.now()}={}) {
  const selected = chat.policy?.allowlist || [], contacts = (chat.contacts || []).filter(item => selected.some(row => row.id === item.id));
  const readyCount = selected.filter(item => contacts.some(mark => mark.id === item.id && mark.status === 'ready')).length;
  const pending = contacts.filter(item => pendingPhases.has(item.pending?.phase));
  const pendingManualCount = countOf(chat.recovery?.pendingManualCount ?? contacts.reduce((sum,item)=>sum+countOf(item.recovery?.pendingManualCount ?? (item.unanswered||[]).filter(entry=>!entry.handledByUserAt).length),0));
  const autoPendingCount = countOf(chat.recovery?.autoPendingCount ?? contacts.reduce((sum,item)=>sum+countOf(item.recovery?.autoPendingCount),0));
  const autoRetryCount = countOf(chat.recovery?.autoRetryCount ?? contacts.reduce((sum,item)=>sum+countOf(item.recovery?.autoRetryCount),0));
  const base = { checkedAt:new Date(now).toISOString(),selectedCount:selected.length,readyCount,pendingCount:pending.length,pendingManualCount,autoPendingCount,autoRetryCount };
  const fullScanMs = Number.isFinite(chat.fullScanSeconds) && chat.fullScanSeconds > 0 ? Math.min(120, chat.fullScanSeconds) * 1000 : 0;
  const checkMaxAge = Math.max(45_000, Math.min(120_000, fullScanMs + selected.length * 8000));
  const result = (status,online,label,reason='') => ({...base,status,online,label,reason});
  const freshAt = (value, age) => Number.isFinite(timeOf(value)) && now-timeOf(value)>=-1000 && now-timeOf(value)<age;
  const watchActive = watch.running === true && watch.worker?.alive === true && freshAt(watch.worker?.heartbeatAt, 5000);
  const watchPhase = watchActive && typeof watch.phase === 'string' ? watch.phase : null;
  const progress=watch.shareProgress;
  const sharing=watchPhase==='sharing'&&progress?.status==='sharing'&&['total','currentIndex','completed','confirmed','notSent','skipped'].every(key=>Number.isSafeInteger(progress[key])&&progress[key]>=0)&&progress.total>0&&progress.currentIndex<=progress.total&&progress.completed<=progress.currentIndex&&progress.confirmed+progress.notSent+progress.skipped<=progress.completed;
  const watchInfo = { active:watchActive, phase:watchPhase,
    label:watchActive ? (sharing?`正在分享 ${progress.currentIndex}/${progress.total}`:watchPhase==='model'?'正在挑选视频':'正在观看') : '未在观看',
    reason:watchActive ? (sharing?`本批已处理 ${progress.completed}/${progress.total}，确认送达 ${progress.confirmed}，未发送 ${progress.notSent}，跳过 ${progress.skipped}。`:watchPhase==='model'?'自主观看正在挑选下一条视频。':'自主观看正在运行。') : '自主观看未运行或心跳已失效。' };
  const shareReviewCount = Array.isArray(share.needsReview) ? share.needsReview.length : 0;
  const shareNeedsReview = share.paused === true || share.recoveryRequired === true || shareReviewCount > 0;
  const identityPaused = contacts.some(item => item.status === 'paused' && actionable(item));
  const deliveryUncertain = contacts.filter(item => item.status === 'delivery-uncertain' && (actionable(item) || !automaticCount(item))).length;
  const replyError = Boolean(friend?.lastError || friend?.status === 'blocked');
  const review = { active:identityPaused || deliveryUncertain>0 || replyError || shareNeedsReview,
    manualCount:pendingManualCount,autoPendingCount,autoRetryCount,shareReviewCount,identityPaused,deliveryUncertain,replyError,
    label:[identityPaused?'有会话身份或许可未就绪':'',deliveryUncertain?'有发送结果暂未确认':'',replyError?'回复服务异常':'',shareNeedsReview?'有分享收据待核对':''].filter(Boolean).join('、'),
    reason:[identityPaused?'部分会话身份或许可未通过，保持暂停。':'',deliveryUncertain?'回复送达尚未确认，保留原记录，不自动重发。':'',replyError?'回复服务异常，详细原因保留在好友互动。':'',shareNeedsReview?'分享送达未确认，请在独立分享收据中处理；不会自动重发。':''].filter(Boolean).join(' ') };
  const reply = (() => {
    if (friend?.policy?.enabled===false || friend?.enabled===false) return result('offline',false,'回复已关闭','好友互动已关闭。');
    if (!modelReady) return result('attention',false,'需要配置模型','请先配置回复使用的模型。');
    if (!selected.length) return result('preparing',false,'准备中','请先选择允许互动的好友或群聊。');
    if (friend?.status==='waiting-settings') return result('preparing',false,'准备中','正在更新许可名单，完成后自动恢复回复。');
    if (friend?.status==='preparing') return result('preparing',false,'正在准备回复通道',friend.waitReason || '正在准备受管聊天入口。');
    if (chat.recovery?.requiresUserAction===true || contacts.some(item=>item.recovery?.requiresUserAction===true)) return result('attention',false,'需要完成登录或验证','请在专用浏览器完成登录或验证码后继续。');
    const hasAutomatic = autoPendingCount+autoRetryCount>0;
    const friendAction = actionable({reason:friend?.waitReason || friend?.lastError, recovery:friend?.recovery});
    if (friend?.waitReason && (!hasAutomatic || friendAction)) return result('attention',false,'等待准备回复通道',friend.waitReason);
    if (friend?.lastError && (!hasAutomatic || friendAction)) return result('attention',false,'回复暂缓',friendAction ? '请完成专用浏览器登录或验证，并确认许可设置。' : '回复服务暂未恢复，详细原因保留在好友互动。');
    if (chat.starting || friend?.status==='starting') return result('preparing',false,'准备中','正在核对会话身份并准备接收消息。');
    if (!chat.running || chat.worker?.alive!==true || !freshAt(chat.worker?.heartbeatAt,5000)) return result('attention',false,'回复未就绪','回复服务未运行或连接已失效，暂不能确认在线。');
    const isolated = contacts.filter(item=>item.status==='paused' && actionable(item));
    const available = contacts.filter(item=>!isolated.includes(item) && (item.status==='ready' || item.status==='inflight' && pendingPhases.has(item.pending?.phase) || automaticCount(item)>0 && !actionable(item) && ['paused','delivery-uncertain','auto-readback'].includes(item.status) || automaticCount(item)>0 && !actionable(item) && item.status==='inflight' && item.pending?.phase==='auto-backlog'));
    const unknown = contacts.some(item=>!available.includes(item) && !isolated.includes(item));
    const stalled = pending.some(item=>!automaticCount(item) && (!Number.isFinite(timeOf(item.pending?.at)) || now-timeOf(item.pending.at)>180_000));
    if (unknown || stalled) return result('attention',false,'回复暂缓','部分许可会话尚未恢复，处理状态会继续更新；未确认发送不会自动重发。');
    if (!available.length && isolated.length) return result('attention',false,'会话身份或许可未就绪','请重新读取联系人并确认许可名单；身份未通过的会话保持暂停。');
    if (available.length+isolated.length!==selected.length) return result('preparing',false,'准备中','正在核对所选会话的接收状态。');
    if (available.some(item=>!freshAt(item.lastCheckedAt,checkMaxAge+1))) return result('attention',false,'消息检查延迟','尚未及时完成许可会话检查，暂不能确认在线。');

    if (hasAutomatic || pending.length || countOf(chat.recovery?.recoverableCount)>0) return result('replying',true,'在线 · 回复中','正在处理许可会话的消息。');
    if (sharingActive(share)) return result('sharing',true,'在线 · 分享中','正在向许可会话分享当前作品，好友新消息仍会继续检查。');
    return result('online',true,'在线 · 等待消息','正在检查许可好友与群聊的新消息。');
  })();
  let overall = reply;
  if (watchActive && reply.status==='online') overall={...reply,status:'watching',label:watchPhase==='model'?'在线 · 挑选视频':'在线 · 看视频中',reason:'许可好友发来新消息时优先回复。'};
  else if (watchActive && reply.online!==true) overall={...reply,status:reply.status==='offline'?'watching':reply.status,label:watchInfo.label+' · '+reply.label};
  return {...overall,watch:watchInfo,reply,review};
}

export function interactionStatus({chat={},share={},comments={},watch={},modelReady=false,friend}={}) {
  const active=value=>Boolean(value.running||value.starting||value.worker?.alive),viewing=active(watch),rows=[];
  const contacts=chat.contacts||[],paused=contacts.filter(item=>/paused|uncertain/.test(item.status||'')).length,identityPaused=contacts.some(item=>item.status==='paused'&&actionable(item));
  rows.push({id:'chat',label:'好友新私信自动回复',running:active(chat),pausedContacts:paused,message:!modelReady?'尚未配置模型。':!chat.policy?.allowlist?.length?'尚未保存许可好友。':active(chat)?`服务已启动，自动处理许可会话的新消息和可恢复待答。${identityPaused?'身份或许可未通过的会话保持暂停。':''}`:'许可好友已保存，但回复服务未启动。',lastCheckedAt:contacts.map(item=>item.lastCheckedAt).filter(Boolean).sort().at(-1)||null});
  rows.push({id:'share',label:'自主分享视频',running:sharingActive(share)||viewing&&share.enabled&&!share.paused,message:!share.enabled?'自主分享开关未开启。':sharingActive(share)?'正在分享当前作品，结果以发送回执为准。':share.paused?'有未确认发送，已暂停。':!viewing?'分享许可已开启，等待自主观看运行。':'自主观看运行中，大肥鱼按当前作品和许可好友自行决定分享。'});
  rows.push({id:'comments',label:'自主公开视频评论',running:viewing&&comments.enabled&&!comments.paused,message:!comments.enabled?'自主评论开关未开启。':comments.paused?'评论结果待核对，已暂停。':!viewing?'评论许可已开启，等待自主观看运行。':'自主观看运行中，按观察与剩余次数决定是否评论。'});
  return{protocol:'interaction-status-v1',checkedAt:new Date().toISOString(),presence:interactionPresence({chat,share,watch,modelReady,friend}),rows,...(friend?{policy:friend.policy,friend}:{}),note:'好友互动共用一个总开关，保留所选名单，不限制人数或回复、分享次数。送达以发送回执为准。'};
}
