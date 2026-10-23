import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, Switch, Tag } from '@dsh/primitives';

const statusText = { reserved: '已预留，待核对', clicking: '处理中，待核对', uncertain: '送达未确认', confirmed: '已确认送达', 'not-sent': '未发出', 'resolved-confirmed': '人工已确认送达', 'resolved-not-sent': '人工已确认未送达' };
const displayName = (state, id) => state?.recipients?.find(item => item.id === id)?.name || '许可好友';

export function AutoSharePanel({ state, api, run, busy, connected = true }) {
  const [enabled, setEnabled] = useState(false), [dailyLimit, setDailyLimit] = useState(3), [notice, setNotice] = useState(''), [submitted, setSubmitted] = useState(new Set());
  const dirty = useRef(false), reviews = useRef(new Set());
  const saving = busy?.has('shareConfigure') === true;
  useEffect(() => { if (state && !dirty.current) { setEnabled(state.enabled === true); setDailyLimit(state.dailyLimit ?? 3); } }, [state]);
  async function save(event) {
    event.preventDefault(); if (!state || !connected || saving) return;
    const count = Number(dailyLimit);
    await run('shareConfigure', async () => {
      if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error('自主分享每日上限须为 1 至 20 的整数。');
      await api('/api/share/configure', { enabled, dailyLimit: count }); dirty.current = false;
      setNotice(enabled ? '已允许大肥鱼在许可好友中自主选择分享；这次保存不会立即发送。' : '已关闭自主分享，停止后续发送。');
    });
  }
  function resolve(operationId, outcome) {
    if (!connected || state?.busy || reviews.current.has(operationId)) return;
    reviews.current.add(operationId); setSubmitted(new Set(reviews.current));
    void run(`shareResolve-${operationId}`, async () => {
      try { return await api('/api/share/resolve', { operationId, outcome }); }
      catch (error) { reviews.current.delete(operationId); setSubmitted(new Set(reviews.current)); throw error; }
    });
  }
  return <section className="panel" aria-labelledby="auto-share-title"><div className="panel-title"><h2 id="auto-share-title">自主分享</h2><Tag>{state?.busy ? '处理中' : state?.paused ? '等待核对' : state?.enabled ? '已允许' : '未允许'}</Tag></div>
    <p className="muted">允许后，大肥鱼会自行选择已观察的当前作品和许可好友，不需逐次批准。关闭开关可停止后续分享。</p>
    <form onSubmit={event => { void save(event); }}><div className="switch-row"><span>允许大肥鱼自主分享</span><Switch label="允许大肥鱼自主分享" checked={enabled} disabled={!state || !connected || saving} onChange={value => { dirty.current = true; setNotice(''); setEnabled(value); }} /></div>
      <label className="field"><span>每日分享次数上限</span><Input aria-label="自主分享每日次数上限" type="number" min={1} max={20} step={1} required value={dailyLimit} disabled={!state || !connected || saving} onChange={event => { dirty.current = true; setNotice(''); setDailyLimit(event.target.value); }} /></label>
      <Button size="sm" type="submit" variant="outline" disabled={!state || !connected || saving}>{saving ? '正在保存…' : '保存自主分享设置'}</Button>
    </form>
    <p className="notice">可选好友：{(state?.recipients || []).map(item => item.name || '许可好友').join('、') || '尚无已验证的许可好友'}。</p>
    <p className="notice">名单在“业务设置 → 好友互动 → 好友私信”中维护。读取联系人、勾选并保存许可名单即可，不需要启用自动回复；不会自动加入其他联系人。</p>
    <p className="notice">今日已处理 {state?.daily?.attempts ?? 0} 次，剩余 {state?.daily?.remaining ?? 0} 次。发送未确认也计入次数，不自动重发。</p>
    {notice && <p className="notice" role="status">{notice}</p>}
    {state?.busy && <p className="notice">当前分享正在处理，可关闭总开关请求停止。</p>}
    {state?.paused && !state?.busy && <p className="notice error">后续分享已暂停。请在抖音核对下列异常收据，再明确记录结果。</p>}
    {state?.recoveryRequired && <p className="notice error">上次发送过程需要恢复核对；开关不会清除原收据。</p>}
    {(state?.needsReview || []).map(item => <div className="paused-contact" key={item.operationId}><strong>{displayName(state, item.recipientId)} · 作品 {item.videoId}</strong><p>{statusText[item.status] || '需要人工核对'}</p>{submitted.has(item.operationId) ? <p role="status">核对结果已提交，等待状态回读；不会重复提交。</p> : <div className="actions"><Button size="sm" disabled={!connected || state.busy || busy?.has(`shareResolve-${item.operationId}`)} onClick={() => resolve(item.operationId, 'confirmed')}>已人工核对送达</Button><Button size="sm" disabled={!connected || state.busy || busy?.has(`shareResolve-${item.operationId}`)} onClick={() => resolve(item.operationId, 'not-sent')}>已人工核对未送达</Button></div>}</div>)}
    {!!state?.recent?.length && <details><summary>最近分享记录</summary>{state.recent.slice().reverse().map(item => <p key={item.operationId}>{displayName(state, item.recipientId)} · 作品 {item.videoId} · {statusText[item.status] || item.status}</p>)}</details>}
    {state?.receiptsFile && <details><summary>本机收据文件</summary><code>{state.receiptsFile}</code></details>}
  </section>;
}

export default AutoSharePanel;
