import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, Switch, Tag, MarkdownText } from '@dsh/primitives';

export function SilentPanel({ state, connected, api, run, busy }) {
  const [silent, setSilent] = useState(false), dirty = useRef(false);
  const ready = connected && state?.protocol === 'watch-mode-v1';
  useEffect(() => { if (ready && !dirty.current) setSilent(state.silent); }, [ready, state]);
  return <section className="watch-controls" aria-label="静默观看设置"><h3>静默观看</h3>
    <div className="switch-row"><span>静音并最小化专用视频窗口</span><Switch label="静默观看" checked={silent} disabled={!ready || busy.has('modeSave')} onChange={value => { dirty.current = true; setSilent(value); }} /></div>
    <Button size="sm" disabled={!ready || busy.has('modeSave')} onClick={() => { void run('modeSave', async () => { await api('/api/mode/configure', { silent }); dirty.current = false; }); }}>保存静默设置</Button>
    <p className="notice">{ready ? state.note : '静默状态尚未核实，请等待服务回读。'} 静默观看仍受原视频时段和单轮上限约束。</p>
    {ready && state.silent && <p className="notice" role="status">{state.application?.message || '静默开关已开启，尚未确认当前窗口是否已最小化；可点击保存重新应用。'}</p>}
  </section>;
}

export function CommentsPanel({ state, connected, api, run, busy }) {
  const [enabled, setEnabled] = useState(false), [daily, setDaily] = useState(3), [session, setSession] = useState(1), [submitted, setSubmitted] = useState(new Set());
  const dirty = useRef(false), resolving = useRef(new Set());
  const ready = connected && state?.protocol === 'autonomous-comments-v1';
  useEffect(() => { if (ready && !dirty.current) { setEnabled(state.policy.enabled); setDaily(state.policy.dailyLimit); setSession(state.policy.perSessionLimit); } }, [ready, state]);
  async function resolve(operationId, outcome) {
    if (resolving.current.has(operationId)) return;
    resolving.current.add(operationId);
    try { await api('/api/comments/resolve', { operationId, outcome }); setSubmitted(old => new Set([...old, operationId])); }
    catch (error) { resolving.current.delete(operationId); throw error; }
  }
  return <section className="panel" aria-label="自主评论设置"><div className="panel-title"><h2>自主公开评论</h2><Tag>{state?.paused ? '待人工核对' : state?.enabled ? '已许可' : '未启用'}</Tag></div>
    <form onSubmit={event => { event.preventDefault(); void run('commentsSave', async () => { await api('/api/comments/configure', { enabled, dailyLimit: Number(daily), perSessionLimit: Number(session) }); dirty.current = false; }); }}>
      <div className="switch-row"><span>允许大肥鱼自主发布评论</span><Switch label="允许自主发布评论" checked={enabled} disabled={!ready} onChange={value => { dirty.current = true; setEnabled(value); }} /></div>
      <label className="field"><span>评论每日尝试上限</span><Input aria-label="评论每日尝试上限" type="number" min={1} max={20} required value={daily} disabled={!ready} onChange={event => { dirty.current = true; setDaily(event.target.value); }} /></label>
      <label className="field"><span>评论每轮尝试上限</span><Input aria-label="评论每轮尝试上限" type="number" min={1} max={3} required value={session} disabled={!ready} onChange={event => { dirty.current = true; setSession(event.target.value); }} /></label>
      <Button size="sm" type="submit" disabled={!ready || busy.has('commentsSave')}>保存评论许可</Button>
    </form>
    <p className="notice">{ready ? `今日已尝试 ${state.daily?.attempts || 0} 次。` : '评论状态尚未核实，请等待服务回读。'} 仅在有限自主观看中根据实际观察决定是否评论；不使用人格原文、私信或 QQ 内容。保存许可不会立即发布。</p>
    {(state?.needsReview || []).map(item => <div className="paused-contact" key={item.operationId}><strong>评论结果需要人工核对</strong><p>作品 {item.videoId}；请在抖音确认实际发布情况，不会自动重发。</p>{submitted.has(item.operationId) ? <p>核对结果已提交，等待回读。</p> : <div className="actions"><Button size="sm" disabled={!ready || state.busy || busy.has(`commentReview-${item.operationId}`)} onClick={() => { void run(`commentReview-${item.operationId}`, () => resolve(item.operationId, 'confirmed')); }}>已核对评论已发布</Button><Button size="sm" disabled={!ready || state.busy || busy.has(`commentReview-${item.operationId}`)} onClick={() => { void run(`commentReview-${item.operationId}`, () => resolve(item.operationId, 'not-sent')); }}>已核对评论未发布</Button></div>}</div>)}
  </section>;
}

export function ReportsView({ connected, api, run, busy }) {
  const [catalog, setCatalog] = useState(null), [date, setDate] = useState(''), [report, setReport] = useState(null);
  const dirty = useRef(false);
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    void api('/api/reports/state').then(value => { if (alive) { setCatalog(value); if (!dirty.current) setDate(value.date || ''); } }).catch(() => { if (alive) setCatalog(null); });
    return () => { alive = false; };
  }, [connected]);
  async function loadCatalog() { const value = await api('/api/reports/state'); setCatalog(value); if (!dirty.current) setDate(value.date || ''); }
  return <div className="memory-view reports-view"><div className="section-heading"><h1>观看日报</h1><p>整理共用记忆中的实际观看记录，不调用模型，也不新增浏览。插件与软件可读取同一份日报。</p></div>
    <div className="actions"><Button disabled={!connected || busy.has('reportGenerate')} onClick={() => { void run('reportGenerate', async () => { const value = await api('/api/reports/generate', {}); setReport(value); setDate(value.date); dirty.current = true; await loadCatalog(); }); }}>生成今天日报</Button><Button disabled={!connected || busy.has('reportCatalog')} onClick={() => { void run('reportCatalog', loadCatalog); }}>刷新日报目录</Button></div>
    <form className="report-picker" onSubmit={event => { event.preventDefault(); void run('reportRead', async () => { const value = await api(`/api/reports/read?date=${encodeURIComponent(date)}`); setReport(value); }); }}><label className="field"><span>日报日期</span><Input aria-label="日报日期" type="date" required value={date} disabled={!connected} onChange={event => { dirty.current = true; setDate(event.target.value); }} /></label><Button type="submit" disabled={!connected || !date || busy.has('reportRead')}>读取所选日报</Button></form>
    {!catalog && <p className="notice">日报目录尚未核实，可点击刷新重试。</p>}
    {catalog && <p className="notice">已有 {catalog.reports?.length || 0} 份日报。{catalog.reports?.map(item => item.date).join('、')}</p>}
    {report?.markdown && <article aria-label="日报正文" className="report-content"><MarkdownText text={report.markdown} labels={{ code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '注释' }} /></article>}
  </div>;
}
