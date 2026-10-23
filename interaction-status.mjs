export function interactionStatus({chat={},spark={},share={},comments={},watch={},modelReady=false}={}) {
  const active=value=>Boolean(value.running||value.starting||value.worker?.alive),viewing=active(watch),rows=[];
  const contacts=chat.contacts||[],paused=contacts.filter(item=>/paused|uncertain/.test(item.status||'')).length,identityPaused=contacts.some(item=>/联系人已变化|群聊/.test(item.reason||''));
  rows.push({id:'chat',label:'好友新私信自动回复',running:active(chat),pausedContacts:paused,message:!modelReady?'尚未配置模型。':!chat.policy?.allowlist?.length?'尚未保存许可好友。':active(chat)?`服务已启动，只处理启动后新收到的消息。${paused?`其中${paused}位好友已暂停；${identityPaused?'联系人身份核对未通过，请在抖音确认后重新读取许可名单。':'请查看下方联系人状态和待核对事项。'}`:''}`:'许可好友已保存，但回复服务未启动。',lastCheckedAt:contacts.map(item=>item.lastCheckedAt).filter(Boolean).sort().at(-1)||null});
  rows.push({id:'spark',label:'自动问候 / 续火花',running:active(spark),message:spark.paused?'发送结果待核对，已暂停。':!spark.enabled?'问候许可未开启。':!active(spark)?'问候许可已开启，但调度服务未启动。':!spark.inWindow?'服务运行中，等待允许问候时段。':'服务运行中，会检查是否已有互动及每日次数。',lastError:spark.lastError||''});
  rows.push({id:'share',label:'自主分享视频',running:viewing&&share.enabled&&!share.paused,message:!share.enabled?'自主分享开关未开启。':share.paused?'有未确认发送，已暂停。':!viewing?'分享许可已开启，等待自主观看运行。':'自主观看运行中，大肥鱼按当前作品和许可好友自行决定分享。'});
  rows.push({id:'comments',label:'自主公开视频评论',running:viewing&&comments.enabled&&!comments.paused,message:!comments.enabled?'自主评论开关未开启。':comments.paused?'评论结果待核对，已暂停。':!viewing?'评论许可已开启，等待自主观看运行。':'自主观看运行中，按观察与剩余次数决定是否评论。'});
  return{protocol:'interaction-status-v1',checkedAt:new Date().toISOString(),rows,note:'运行状态表示服务是否启动，不代表平台已收到消息。真实送达以发送回执为准；当前检查不会发送任何内容。'};
}
