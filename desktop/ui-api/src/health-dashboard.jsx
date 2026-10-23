import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, Tag } from '@dsh/primitives';

const number = value => Number(value || 0).toLocaleString('zh-CN');
const kinds = { watch: '自主观看', task: '手动任务', comment: '评论生成', spark: '自动问候', chat: '私信回复' };
export function HealthDashboard({ api, run, busy, connected }) {
  const [usage, setUsage] = useState(null), [diagnostics, setDiagnostics] = useState(null), [error, setError] = useState(''), [repairResult, setRepairResult] = useState('');
  async function refresh() { try { setUsage(await api('/api/usage')); setError(''); } catch (failure) { setError(failure.message); } }
  useEffect(() => { if (connected) void refresh(); }, [connected]);
  return <div className="memory-view"><div className="section-heading"><h1>自检与用量</h1><p>插件与软件共用本机用量记录，数据来自模型实际返回值。</p></div>
    <div className="actions"><Button disabled={!connected || busy.has('diagnostics')} onClick={() => { void run('diagnostics', async () => { setRepairResult(''); setDiagnostics(await api('/api/diagnostics', {})); await refresh(); }); }}>{busy.has('diagnostics') ? '正在检查或修复…' : '一键自检'}</Button><Button disabled={!connected} onClick={() => { void refresh(); }}>刷新用量</Button></div>
    {error && <p role="alert">{error}</p>}{diagnostics && <section className="persona-records"><h2>自检结果</h2>{diagnostics.checks.map(item => <div key={item.id}><p><Tag>{{ pass: '通过', warning: '待核对', fail: '未通过' }[item.status]}</Tag> <strong>{item.label}</strong> · {item.message} <small>{item.code}</small></p>{item.resolution?.steps?.map((step, index) => <p className="muted" key={index}>{step}</p>)}</div>)}
      {(diagnostics.repairableActions || []).map(action => <Button key={action.id} disabled={!connected || busy.has('diagnostics')} onClick={() => { void run('diagnostics', async () => { const result = await api('/api/diagnostics/repair', { reportId: diagnostics.reportId, action: action.id }); setDiagnostics(result.after); setRepairResult(result.message); }); }}>修复：{action.label}</Button>)}
      {repairResult && <p role="status">{repairResult}</p>}<p className="muted">{diagnostics.note}</p><details><summary>查看或复制诊断报告</summary><textarea aria-label="诊断报告" readOnly rows={12} value={JSON.stringify(diagnostics, null, 2)} /></details></section>}
    {usage && <><section className="persona-records"><h2>今日用量 · {usage.date}</h2><div className="usage-grid">{[['模型响应', 'requests'],['已报告 Token', 'totalTokens'],['输入 Token', 'promptTokens'],['输出 Token', 'completionTokens'],['缓存命中 Token', 'cachedTokens'],['用量未知的响应', 'unknownRequests']].map(([label, key]) => <div className="interest-card" key={key}><small>{label}</small><h2>{key === 'cachedTokens' && !usage.today.cacheReportedRequests ? '未报告' : number(usage.today[key])}</h2></div>)}</div></section>
      <section className="persona-records"><h2>{usage.period} · {number(usage.total.totalTokens)} Token</h2><div className="usage-scroll"><table><thead><tr><th>入口 / 用途</th><th>模型</th><th>响应数</th><th>已报告 Token</th><th>未知用量</th></tr></thead><tbody>{usage.groups.map((item, index) => <tr key={index}><td>{item.source === 'dsh' ? '插件' : '软件'} / {kinds[item.kind]}</td><td>{item.model}</td><td>{number(item.requests)}</td><td>{number(item.totalTokens)}</td><td>{number(item.unknownRequests)}</td></tr>)}</tbody></table></div>{!usage.groups.length && <p className="muted">暂时没有本版记录。</p>}<p className="muted">{usage.note}</p>{usage.damagedRecords > 0 && <p role="alert">有异常记录，请运行自检。原记录已保留。</p>}</section>
      <section className="persona-records"><h2>按日记录</h2>{usage.days.slice().reverse().map(item => <p key={item.date}>{item.date} · {number(item.requests)} 次响应 · {number(item.totalTokens)} Token · {item.unknownRequests} 次用量未知</p>)}</section></>}
  </div>;
}

export function TopicPanel({ state, active, api, run, busy, connected }) {
  const [mode, setMode] = useState('recommend'), [topics, setTopics] = useState(''), [exclude, setExclude] = useState(''), [notice, setNotice] = useState('');
  const dirty = useRef(false);
  useEffect(() => { if (state && !dirty.current) { setMode(state.mode); setTopics(state.topics.join('\n')); setExclude(state.exclude.join('\n')); } }, [state]);
  const list = text => text.split(/[\n,，;；]+/).map(item => item.trim()).filter(Boolean);
  return <section className="watch-controls"><h3>主题观看</h3><label className="field"><span>观看方式</span><select aria-label="观看方式" value={mode} disabled={active} onChange={event => { dirty.current = true; setMode(event.target.value); }}><option value="recommend">自主挑选推荐</option><option value="topic">围绕指定主题观看</option></select></label>
    <label className="field"><span>想看的主题，每行一个</span><textarea aria-label="想看的主题" rows={3} value={topics} maxLength={2200} disabled={active} onChange={event => { dirty.current = true; setTopics(event.target.value); }} placeholder="例如：猫咪、天文、做饭" /></label>
    <label className="field"><span>排除关键词，每行一个</span><textarea aria-label="排除关键词" rows={2} value={exclude} maxLength={2200} disabled={active} onChange={event => { dirty.current = true; setExclude(event.target.value); }} /></label>
    <Button size="sm" disabled={!connected || active || busy.has('topics')} onClick={() => { void run('topics', async () => { await api('/api/watch/options', { mode, topics: list(topics), exclude: list(exclude) }); dirty.current = false; setNotice('主题已保存，插件与软件共用；下次自主观看生效。'); }); }}>保存观看主题</Button><p className="notice">主题模式先搜索真实作品，再按人格挑片。排除词按作品标题匹配，不能保证识别画面内全部内容。</p>{notice && <p role="status">{notice}</p>}
  </section>;
}
