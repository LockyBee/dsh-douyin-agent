import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, Switch, Tag } from '@dsh/primitives';

const recipientStatus = {
  waiting: '等待允许时段', 'outside-window': '等待允许时段', 'waiting-window': '等待允许时段',
  ready: '等待检查', checking: '正在检查', generating: '正在生成问候', sending: '正在发送',
  confirmed: '今日问候已确认发送', sent: '发送记录待回读', 'already-greeted': '今日已尝试问候',
  'already-interacted': '今日已有发出互动', 'already-outgoing': '今日已有发出互动',
  'date-unknown': '消息日期尚未核实', 'unknown-date': '消息日期尚未核实',
  'pending-incoming': '有新消息待回复', 'new-incoming': '有新消息待回复',
  uncertain: '发送结果待核对', 'delivery-uncertain': '发送结果待核对', paused: '已暂停', skipped: '已跳过',
};
const reviewStatus = { reserved: '已预留，需核对', generating: '上次处理需核对', sending: '发送过程需核对', uncertain: '发送结果未确认', 'delivery-uncertain': '发送结果未确认' };
const nameOf = (state, id) => state?.recipients?.find(item => item.id === id)?.name || '许可好友';

function parseWindows(text) {
  const windows = text.split(/[\n,;，；]+/).map(item => item.trim()).filter(Boolean);
  if (windows.length < 1 || windows.length > 16) throw new Error('请设置 1 至 16 个每日问候时段。');
  for (const value of windows) {
    const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(value);
    if (!match) throw new Error('问候时段请使用 HH:MM-HH:MM，例如 09:00-22:00。');
    const [startHour, startMinute, endHour, endMinute] = match.slice(1).map(Number);
    if (startHour > 23 || startMinute > 59 || endHour > 24 || endMinute > 59 || (endHour === 24 && endMinute !== 0) || startHour * 60 + startMinute === endHour * 60 + endMinute) throw new Error('问候时段无效；跨午夜可写 23:00-01:00，全天可写 00:00-24:00。');
  }
  return [...new Set(windows)];
}

export function SparkPanel({ state, api, run, busy, configured = false, connected = true }) {
  const [enabled, setEnabled] = useState(false), [windows, setWindows] = useState('09:00-22:00'), [dailyLimit, setDailyLimit] = useState(2);
  const [notice, setNotice] = useState(''), [submitted, setSubmitted] = useState(new Set());
  const dirty = useRef(false), reviews = useRef(new Set());
  const ready = connected && state?.protocol === 'spark-v1' && Boolean(state?.policy);
  const active = state?.running === true || state?.starting === true || state?.busy === true || state?.worker?.alive === true;
  const saving = busy?.has('sparkConfigure') === true, starting = busy?.has('sparkStart') === true, stopping = busy?.has('sparkStop') === true;
  const modelReady = typeof state?.modelReady === 'boolean' ? state.modelReady : configured;
  const hasRecipients = Array.isArray(state?.recipients) && state.recipients.length > 0;
  const reviewPending = Boolean(state?.needsReview?.length);
  const editingDisabled = !ready || saving;
  useEffect(() => {
    if (state?.policy && !dirty.current) {
      setEnabled(state.policy.enabled === true); setWindows((state.policy.windows || ['09:00-22:00']).join('\n')); setDailyLimit(state.policy.dailyLimit ?? 2);
    }
  }, [state?.policy]);
  function edit(action) { dirty.current = true; setNotice(''); action(); }
  async function save(event) {
    event.preventDefault(); if (editingDisabled) return;
    await run('sparkConfigure', async () => {
      const count = Number(dailyLimit), selectedWindows = parseWindows(windows);
      if (!Number.isSafeInteger(count) || count < 1 || count > 2) throw new Error('每日主动问候总上限须为 1 或 2。');
      if (enabled && (!modelReady || !hasRecipients)) throw new Error('请先配置模型并保存已验证的许可好友，再开启主动问候。');
      await api('/api/spark/configure', { enabled, windows: selectedWindows, dailyLimit: count });
      dirty.current = false;
      if (enabled) { setNotice(active ? '自动问候设置已保存，当前调度仍在运行；请以回读状态为准。' : '自动问候设置已保存，尚未启动。点击“开始自动续火花”后才会调度发送。'); return; }
      try { await api('/api/spark/stop', {}); setNotice('已关闭主动问候许可并请求停止服务；请以回读状态为准。'); }
      catch (error) { setNotice('总许可已关闭，尚未取得服务停止确认。请点击停止并核对状态。'); throw error; }
    });
  }
  function start() {
    if (!ready || !modelReady || !hasRecipients || !state.enabled || active || reviewPending || dirty.current || saving || starting || stopping) return;
    void run('sparkStart', async () => { await api('/api/spark/start', {}); setNotice('已提交自动问候启动请求；在允许时段内可能向许可好友发送简短问候。'); });
  }
  function stop() {
    if (!ready || stopping) return;
    void run('sparkStop', async () => { await api('/api/spark/stop', {}); setNotice('已请求停止自动问候，请以服务回读状态为准。总许可设置保留。'); });
  }
  function resolve(operationId, outcome) {
    if (!ready || active || reviews.current.has(operationId)) return;
    reviews.current.add(operationId); setSubmitted(new Set(reviews.current));
    void run(`sparkResolve-${operationId}`, async () => {
      try { await api('/api/spark/resolve', { operationId, outcome }); }
      catch (error) { reviews.current.delete(operationId); setSubmitted(new Set(reviews.current)); throw error; }
    });
  }
  const badge = !ready ? '状态未核实' : state?.busy ? '正在处理' : state?.starting ? '正在启动' : active ? '调度中' : state?.enabled ? '已许可·未运行' : '未许可';
  return <section className="panel" aria-labelledby="spark-title"><div className="panel-title"><h2 id="spark-title">自动续火花</h2><Tag>{badge}</Tag></div>
    <p className="muted">按大肥鱼的人格生成简短问候，只发给现有许可好友。每位好友每天最多尝试一次；当天已有可靠的发出互动就跳过。</p>
    <form onSubmit={event => { void save(event); }}>
      <div className="switch-row"><span>允许主动问候</span><Switch label="允许自动续火花" checked={enabled} disabled={editingDisabled} onChange={value => edit(() => setEnabled(value))} /></div>
      <label className="field"><span>每日问候时段 · 北京时间</span><textarea aria-label="每日问候时段" rows={2} value={windows} maxLength={220} required disabled={editingDisabled} onChange={event => edit(() => setWindows(event.target.value))} placeholder="09:00-22:00，每行一段" /></label>
      <label className="field"><span>每日主动问候总上限</span><Input aria-label="每日主动问候总上限" type="number" min={1} max={2} step={1} required disabled={editingDisabled} value={dailyLimit} onChange={event => edit(() => setDailyLimit(event.target.value))} /></label>
      <Button size="sm" type="submit" variant="outline" disabled={editingDisabled || (enabled && (!modelReady || !hasRecipients))}>{saving ? '正在保存…' : '保存自动问候设置'}</Button>
    </form>
    <div className="actions"><Button size="sm" variant="primary" disabled={!ready || !state?.enabled || !modelReady || !hasRecipients || active || reviewPending || dirty.current || saving || starting || stopping} onClick={start}>{starting ? '正在启动…' : '开始自动续火花'}</Button><Button size="sm" disabled={!ready || !active || stopping} onClick={stop}>{stopping ? '正在停止…' : '停止自动问候'}</Button></div>
    <p className="notice">保存许可不会发送消息。开始调度后，处于允许时段就可能发送；关闭总开关须保存，并会立即请求停止服务。</p>
    <p className="notice">许可好友：{(state?.recipients || []).map(item => item.name || '许可好友').join('、') || '尚无已验证的许可好友'}。名单在“好友私信”中维护，这里不会新增联系人。</p>
    {!ready && <p className="notice error" role="status">自动问候状态尚未核实，暂不能修改或启动，请等待本机服务回读。</p>}
    {ready && !modelReady && <p className="notice">模型尚未就绪，不能启动；仍可关闭许可或停止已运行的服务。</p>}
    <p className="notice">{state?.daily?.date ? `${state.daily.date}（北京时间）` : '今日日期尚未核实'} · 已尝试 {state?.daily?.attempts ?? 0} 次 · 问候已确认发送 {state?.daily?.confirmed ?? 0} 次。失败或未确认不重复尝试。</p>
    <p className="notice">消息日期不可靠、有新消息待回复或发送结果未确认时，不继续主动问候。</p>
    <p className="notice">问候送达不等于火花已续上，火花状态以抖音判定和对方互动为准。</p>
    {(state?.recipients || []).map(item => <div className="paused-contact" key={item.id}><strong>{item.name || '许可好友'}</strong><p>{recipientStatus[item.status] || '状态待核对'}{item.reason ? `：${item.reason}` : ''}</p>{item.lastConfirmedAt && <small>最近确认发送：{item.lastConfirmedAt}</small>}</div>)}
    {!!state?.needsReview?.length && <p className="notice error">存在待核对记录，请先停止服务并在抖音检查实际消息。核对结果不会返还次数，也不会触发补发。</p>}
    {(state?.needsReview || []).map(item => <div className="paused-contact" key={item.operationId}><strong>{nameOf(state, item.recipientId)} · 问候记录</strong><p>{reviewStatus[item.status] || '需要人工核对'}</p>{submitted.has(item.operationId) ? <p role="status">核对结果已提交，等待回读；不会重复提交。</p> : <div className="actions"><Button size="sm" disabled={!ready || active || busy?.has(`sparkResolve-${item.operationId}`)} onClick={() => resolve(item.operationId, 'confirmed')}>已核对问候已发送</Button><Button size="sm" disabled={!ready || active || busy?.has(`sparkResolve-${item.operationId}`)} onClick={() => resolve(item.operationId, 'not-sent')}>已核对问候未发送</Button></div>}</div>)}
    {notice && <p className="notice" role="status">{notice}</p>}
    <p className="notice">只取人格卡的手编正文作表达风格，不读取 QQ、兴趣或其他会话。需软件或插件服务保持运行及抖音登录；关闭所有入口不会后台补发，重启后须重新开始调度。</p>
  </section>;
}

export default SparkPanel;
