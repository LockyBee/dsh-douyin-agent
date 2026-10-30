import React, { useRef, useState } from 'react';
import { Button } from '@dsh/primitives';

const statusText = { reserved: '已预留，待核对', clicking: '处理中，待核对', uncertain: '送达未确认', confirmed: '已确认送达', 'not-sent': '未发出', 'resolved-confirmed': '人工已确认送达', 'resolved-not-sent': '人工已确认未送达' };
const displayName = (state, id) => state?.recipients?.find(item => item.id === id)?.name || '许可会话';
const failureMessage = item => typeof item?.failure?.message === 'string' && item.failure.message.trim() ? item.failure.message : item?.status === 'not-sent' ? '旧记录没有保存详细失败原因。' : '';

export function ShareReceipts({ state, api, run, busy, connected = true }) {
  const [submitted, setSubmitted] = useState(new Set()), reviews = useRef(new Set());
  function resolve(operationId, outcome) {
    if (!connected || state?.busy || reviews.current.has(operationId)) return;
    reviews.current.add(operationId); setSubmitted(new Set(reviews.current));
    void run(`shareResolve-${operationId}`, async () => {
      try { return await api('/api/share/resolve', { operationId, outcome }); }
      catch (error) { reviews.current.delete(operationId); setSubmitted(new Set(reviews.current)); throw error; }
    });
  }
  return <div aria-label="分享收据">
    {!!state?.unavailableRecipients?.length && <div className="paused-contact" aria-label="暂不可分享的许可会话"><strong>暂不能自主分享</strong>{state.unavailableRecipients.map(item => <p key={item.id}>{item.name || '许可会话'}：{item.reason}</p>)}</div>}
    {state?.busy && <p className="notice">正在处理分享。关闭好友互动可请求停止。</p>}
    {state?.paused && !state?.busy && <p className="notice error">分享暂已暂停，请在抖音核对异常收据。</p>}
    {state?.recoveryRequired && <p className="notice error">上次发送需要恢复核对，总开关不会清除收据。</p>}
    {(state?.needsReview || []).map(item => <div className="paused-contact" key={item.operationId}><strong>{displayName(state, item.recipientId)} · 作品 {item.videoId}</strong><p>{statusText[item.status] || '需要人工核对'}</p>{failureMessage(item) && <p className="notice">原因：{failureMessage(item)}</p>}{submitted.has(item.operationId) ? <p role="status">核对结果已提交，等待状态回读；不会重复提交。</p> : <div className="actions"><Button size="sm" disabled={!connected || state.busy || busy?.has(`shareResolve-${item.operationId}`)} onClick={() => resolve(item.operationId, 'confirmed')}>已人工核对送达</Button><Button size="sm" disabled={!connected || state.busy || busy?.has(`shareResolve-${item.operationId}`)} onClick={() => resolve(item.operationId, 'not-sent')}>已人工核对未送达</Button></div>}</div>)}
    {!!state?.recent?.length && <details><summary>最近分享记录</summary>{state.recent.slice().reverse().map(item => <div key={item.operationId}><p>{displayName(state, item.recipientId)} · 作品 {item.videoId} · {state.inProgress && state.activity?.operationId === item.operationId ? '正在分享' : statusText[item.status] || item.status}</p>{failureMessage(item) && <p className="notice">原因：{failureMessage(item)}</p>}</div>)}</details>}
    {state?.receiptsFile && <details><summary>本机分享收据</summary><code>{state.receiptsFile}</code></details>}
  </div>;
}

export const AutoSharePanel = ShareReceipts;
export default ShareReceipts;
