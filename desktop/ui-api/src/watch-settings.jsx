import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, Switch, Tag, MarkdownText } from '@dsh/primitives';
import { useAutoSave, AutoSaveStatus } from './use-auto-save.jsx';

export function ViewingModePanel({ state, browserMode, setBrowserMode, backgroundAvailable = false, silentAvailable = true, connected, api }) {
  const silentReady = connected && state?.protocol === 'watch-mode-v1';
  const backgroundReady = connected && browserMode?.protocol === 'browser-mode-v1';
  const silent = useAutoSave({ value: silentReady ? state : null, initial: { silent: false }, read: value => ({ silent: value.silent === true }), encode: draft => ({ silent: draft.silent }), write: payload => api('/api/mode/configure', payload), available: silentReady });
  const [changingMode, setChangingMode] = useState(null), [modeError, setModeError] = useState('');
  const changing = useRef(false);
  async function changeBackground(enabled) {
    if (!backgroundReady || changing.current) return;
    const mode = enabled ? 'background' : 'visible';
    changing.current = true;
    setChangingMode(mode); setModeError('');
    try { setBrowserMode(await api('/api/browser/mode', { mode })); }
    catch (error) { setModeError(error.message); }
    finally { changing.current = false; setChangingMode(null); }
  }
  const executionMode = browserMode?.recordedMode ?? browserMode?.mode ?? state?.executionMode;
  return <section className="watch-controls" aria-label="观看方式"><h3>观看方式</h3>
    {backgroundAvailable && <>
      <div className="switch-row"><span>后台观看（无窗口）</span><Switch label="后台观看" checked={(changingMode ?? browserMode?.mode) === 'background'} disabled={!backgroundReady || changingMode !== null} onChange={value => { void changeBackground(value); }} /></div>
      {changingMode && <p className="notice" role="status">{changingMode === 'background' ? '正在切换到后台…' : '正在打开专用浏览器并恢复回复…'}</p>}
      {modeError && <p className="notice error" role="alert">{modeError}</p>}
      {!changingMode && backgroundReady && browserMode.restartRequired && <Button onClick={() => { void changeBackground(browserMode.mode === 'background'); }}>应用当前设置</Button>}
    </>}
    {silentAvailable && <>
      <div className="switch-row"><span>{executionMode === 'background' ? '静默观看（静音）' : '静默观看（静音，有窗时最小化）'}</span><Switch label="静默观看" checked={silent.draft.silent} disabled={!silentReady} onChange={value => silent.edit({ silent: value }, { immediate: true })} /></div>
      <AutoSaveStatus status={silent.status.kind === 'saved' ? null : silent.status} />
      {silentReady && state.silent && state.application?.applied === false && state.application?.message && <p className="notice" role="status">{state.application.message}</p>}
    </>}
  </section>;
}

export function CommentsPanel({ state, reactions, connected, api, run, busy }) {
  const reactionSave = useAutoSave({ value: reactions?.protocol === 'video-reactions-v1' ? reactions : null, initial: { like: false, favorite: false }, read: value => value.policy, encode: draft => ({ like: draft.like === true, favorite: draft.favorite === true }), write: payload => api('/api/reactions/configure', payload), available: connected && reactions?.protocol === 'video-reactions-v1' });
  const [submitted, setSubmitted] = useState(new Set());
  const resolving = useRef(new Set());
  const ready = connected && state?.protocol === 'autonomous-comments-v1';
  const save = useAutoSave({ value: ready ? state.policy : null, initial: { enabled: false, daily: 3, session: 1 }, read: value => ({ enabled: value.enabled, daily: value.dailyLimit, session: value.perSessionLimit }), encode: draft => {
    const daily = Number(draft.daily), session = Number(draft.session), result = { enabled: draft.enabled };
    if (String(draft.daily).trim() && Number.isSafeInteger(daily) && daily >= 1 && daily <= 20) result.dailyLimit = daily;
    else if (draft.enabled) throw new Error('评论每日上限须填写1至20的整数。');
    if (String(draft.session).trim() && Number.isSafeInteger(session) && session >= 1 && session <= 3) result.perSessionLimit = session;
    else if (draft.enabled) throw new Error('评论每轮上限须填写1至3的整数。');
    return result;
  }, write: payload => api('/api/comments/configure', payload), available: ready });
  async function resolve(operationId, outcome) {
    if (resolving.current.has(operationId)) return;
    resolving.current.add(operationId);
    try { await api('/api/comments/resolve', { operationId, outcome }); setSubmitted(old => new Set([...old, operationId])); }
    catch (error) { resolving.current.delete(operationId); throw error; }
  }
  return <section className="panel" aria-label="自主评论设置"><div className="panel-title"><h2>自主点赞、收藏与评论</h2><Tag>{state?.paused ? '待人工核对' : state?.enabled ? '已许可' : '未启用'}</Tag></div>
    <div className="switch-row"><span>允许自主点赞</span><Switch label="允许自主点赞" checked={reactionSave.draft.like} disabled={!connected || !reactions} onChange={value => reactionSave.edit({ like: value }, { immediate: true })} /></div>
    <div className="switch-row"><span>允许自主收藏</span><Switch label="允许自主收藏" checked={reactionSave.draft.favorite} disabled={!connected || !reactions} onChange={value => reactionSave.edit({ favorite: value }, { immediate: true })} /></div>
    <AutoSaveStatus status={reactionSave.status} />
    <div className="switch-row"><span>允许大肥鱼自主发布评论</span><Switch label="允许自主发布评论" checked={save.draft.enabled} disabled={!ready} onChange={value => save.edit({ enabled: value }, { immediate: true })} /></div>
    <label className="field"><span>评论每日尝试上限</span><Input aria-label="评论每日尝试上限" type="number" min={1} max={20} required value={save.draft.daily} disabled={!ready} onChange={event => save.edit({ daily: event.target.value })} /></label>
    <label className="field"><span>评论每轮尝试上限</span><Input aria-label="评论每轮尝试上限" type="number" min={1} max={3} required value={save.draft.session} disabled={!ready} onChange={event => save.edit({ session: event.target.value })} /></label>
    <AutoSaveStatus status={save.status} />
    {!ready && <p className="notice" role="status">评论状态尚未核实。</p>}
    {ready && Number.isFinite(state.daily?.attempts) && <p>今日尝试 {state.daily.attempts} 次</p>}
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
  return <div className="memory-view reports-view"><div className="section-heading"><h1>观看日报</h1></div>
    <div className="actions"><Button disabled={!connected || busy.has('reportGenerate')} onClick={() => { void run('reportGenerate', async () => { const value = await api('/api/reports/generate', {}); setReport(value); setDate(value.date); dirty.current = true; await loadCatalog(); }); }}>生成今天日报</Button><Button disabled={!connected || busy.has('reportCatalog')} onClick={() => { void run('reportCatalog', loadCatalog); }}>刷新日报目录</Button></div>
    <form className="report-picker" onSubmit={event => { event.preventDefault(); void run('reportRead', async () => { const value = await api(`/api/reports/read?date=${encodeURIComponent(date)}`); setReport(value); }); }}><label className="field"><span>日报日期</span><Input aria-label="日报日期" type="date" required value={date} disabled={!connected} onChange={event => { dirty.current = true; setDate(event.target.value); }} /></label><Button type="submit" disabled={!connected || !date || busy.has('reportRead')}>读取所选日报</Button></form>
    {!catalog && <p className="notice">日报目录未载入。</p>}
    {catalog && (catalog.reports?.length ? <details><summary>已有日报（{catalog.reports.length}）</summary><p>{catalog.reports.map(item => item.date).join('、')}</p></details> : <p className="notice">暂无日报。</p>)}
    {report?.markdown && <article aria-label="日报正文" className="report-content"><MarkdownText text={report.markdown} labels={{ code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '注释' }} /></article>}
  </div>;
}
