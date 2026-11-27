import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, Tag } from '@dsh/primitives';
import { useAutoSave, AutoSaveStatus } from './use-auto-save.jsx';

const number = value => Number(value || 0).toLocaleString('zh-CN');
const kinds = { watch: '自主观看', task: '手动任务', comment: '评论生成', spark: '自动问候', chat: '私信回复' };
export function HealthDashboard({ api, run, busy, connected }) {
  const [usage, setUsage] = useState(null), [diagnostics, setDiagnostics] = useState(null), [error, setError] = useState(''), [repairResult, setRepairResult] = useState(''), [updatedAt, setUpdatedAt] = useState('');
  const latestApi = useRef(api), lifecycle = useRef({ mounted: false, connected: false, epoch: 0, pending: null, queued: false }); latestApi.current = api;
  async function refresh(manual = true) {
    const life = lifecycle.current;
    if (!life.mounted || !life.connected) return;
    if (life.pending) { if (manual) { life.pending.discard = true; life.queued = true; } return life.pending.promise; }
    const ticket = { epoch: life.epoch, discard: false }; life.pending = ticket;
    ticket.promise = (async () => {
      try {
        const value = await latestApi.current('/api/usage');
        if (life.mounted && life.connected && life.epoch === ticket.epoch && !ticket.discard) { setUsage(value); setUpdatedAt(value.checkedAt || new Date().toISOString()); setError(''); }
      } catch (failure) { if (life.mounted && life.connected && life.epoch === ticket.epoch && !ticket.discard) setError(failure.message); }
      finally {
        if (life.pending === ticket) life.pending = null;
        if (life.mounted && life.connected && life.queued) { life.queued = false; void refresh(false); }
      }
    })();
    return ticket.promise;
  }
  useEffect(() => {
    const life = lifecycle.current; life.mounted = true; life.connected = connected; life.epoch += 1;
    if (connected) void refresh(true);
    const timer = connected ? setInterval(() => { void refresh(false); }, 1500) : null;
    return () => { clearInterval(timer); life.mounted = false; life.connected = false; life.epoch += 1; life.queued = false; };
  }, [connected]);
  return <div className="memory-view"><div className="section-heading"><h1>自检与用量</h1></div>
    <div className="actions"><Button disabled={!connected || busy.has('diagnostics')} onClick={() => { void run('diagnostics', async () => { setRepairResult(''); setDiagnostics(await api('/api/diagnostics', {})); await refresh(); }); }}>{busy.has('diagnostics') ? '正在检查或修复…' : '一键自检'}</Button><Button disabled={!connected} onClick={() => { void refresh(); }}>刷新用量</Button></div>
    <p className="muted">{updatedAt ? `${new Date(updatedAt).toLocaleTimeString('zh-CN', { hour12: false })} 更新` : '正在读取用量…'}</p>
    {usage?.inProgress?.total > 0 && <p className="notice" role="status">{number(usage.inProgress.total)}个请求中，Token待平台返回。</p>}
    {error && <p role="alert">{error}</p>}{diagnostics && <section className="persona-records"><h2>自检结果</h2>{diagnostics.checks.map(item => <div key={item.id}><p><Tag>{{ pass: '通过', warning: '待核对', fail: '未通过' }[item.status]}</Tag> <strong>{item.label}</strong> · {item.message} <small>{item.code}</small></p>{item.resolution?.steps?.map((step, index) => <p className="muted" key={index}>{step}</p>)}</div>)}
      {(diagnostics.repairableActions || []).map(action => <Button key={action.id} disabled={!connected || busy.has('diagnostics')} onClick={() => { void run('diagnostics', async () => { const result = await api('/api/diagnostics/repair', { reportId: diagnostics.reportId, action: action.id }); setDiagnostics(result.after); setRepairResult(result.message); }); }}>修复：{action.label}</Button>)}
      {repairResult && <p role="status">{repairResult}</p>}<details><summary>查看或复制诊断报告</summary><textarea aria-label="诊断报告" readOnly rows={12} value={JSON.stringify(diagnostics, null, 2)} /></details></section>}
    {usage && <><section className="persona-records"><h2>今日用量 · {usage.date}</h2><div className="usage-grid">{[['模型响应', 'requests'],['已报告 Token', 'totalTokens'],['输入 Token', 'promptTokens'],['输出 Token', 'completionTokens'],['缓存命中 Token', 'cachedTokens'],['用量未知的响应', 'unknownRequests']].map(([label, key]) => <div className="interest-card" key={key}><small>{label}</small><h2>{key === 'cachedTokens' && !usage.today.cacheReportedRequests ? '未报告' : number(usage.today[key])}</h2></div>)}</div></section>
      <section className="persona-records"><h2>{usage.period} · {number(usage.total.totalTokens)} Token</h2><div className="usage-scroll"><table><thead><tr><th>入口 / 用途</th><th>模型</th><th>响应数</th><th>已报告 Token</th><th>未知用量</th></tr></thead><tbody>{usage.groups.map((item, index) => <tr key={index}><td>{item.source === 'dsh' ? '插件' : '软件'} / {kinds[item.kind]}</td><td>{item.model}</td><td>{number(item.requests)}</td><td>{number(item.totalTokens)}</td><td>{number(item.unknownRequests)}</td></tr>)}</tbody></table></div>{!usage.groups.length && <p className="muted">暂无用量记录。</p>}{usage.damagedRecords > 0 && <p role="alert">有异常记录，请运行自检。</p>}</section>
      <section className="persona-records"><h2>按日记录</h2>{usage.days.slice().reverse().map(item => <p key={item.date}>{item.date} · {number(item.requests)} 次响应 · {number(item.totalTokens)} Token · {item.unknownRequests} 次用量未知</p>)}</section></>}
  </div>;
}

export function TopicPanel({ state, active, api, run, busy, connected }) {
  const list = text => text.split(/[\n,，;；]+/).map(item => item.trim()).filter(Boolean);
  const save = useAutoSave({ value: state, initial: { mode: 'recommend', topics: '', exclude: '' }, read: value => ({ mode: value.mode, topics: value.topics.join('\n'), exclude: value.exclude.join('\n') }), encode: draft => {
    const payload = { mode: draft.mode, topics: [...new Set(list(draft.topics))], exclude: [...new Set(list(draft.exclude))] };
    if (payload.mode === 'topic' && !payload.topics.length) throw new Error('填写至少一个主题后自动生效。');
    if ([payload.topics, payload.exclude].some(values => values.length > 20 || values.some(value => value.length > 100 || /[\0\r\n]/.test(value)))) throw new Error('主题和排除词各最多20项，每项最多100字。');
    return payload;
  }, write: payload => api('/api/watch/options', payload), available: connected && !active });
  return <section className="watch-controls"><h3>主题观看</h3><label className="field"><span>观看方式</span><select aria-label="观看方式" value={save.draft.mode} disabled={!connected || active} onChange={event => save.edit({ mode: event.target.value })}><option value="recommend">自主挑选推荐</option><option value="topic">围绕指定主题观看</option></select></label>
    <label className="field"><span>想看的主题，每行一个</span><textarea aria-label="想看的主题" rows={3} value={save.draft.topics} maxLength={2200} disabled={!connected || active} onChange={event => save.edit({ topics: event.target.value })} placeholder="例如：猫咪、天文、做饭" /></label>
    <label className="field"><span>按标题排除关键词，每行一个</span><textarea aria-label="排除关键词" rows={2} value={save.draft.exclude} maxLength={2200} disabled={!connected || active} onChange={event => save.edit({ exclude: event.target.value })} /></label>
    <AutoSaveStatus status={save.status} />
  </section>;
}
