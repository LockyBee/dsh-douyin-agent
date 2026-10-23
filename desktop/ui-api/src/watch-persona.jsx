import React, { useEffect, useRef, useState } from 'react';
import { Button, Input, Tag, MarkdownText } from '@dsh/primitives';
import { watchIsActive, watchStartInput } from './api.mjs';

const LABELS = { code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '注释' };
const states = { running: '自主观看中', stopping: '正在停止', stopped: '未运行', limited: '达到限制', failed: '运行中断', needs_user: '等待手动操作' };
const actions = { search: '搜索作品', skip: '换一条', stay: '继续观察', share: '分享当前作品', stop: '结束观看' };
const firstText = (...values) => values.find(value => typeof value === 'string' && value) || '';
const textOf = value => typeof value === 'string' ? value : firstText(value?.summary, value?.observation, value?.text, value?.content);
const topicOf = value => typeof value === 'string' ? value : firstText(value?.topic, value?.name, value?.label);
const secondsLabel = seconds => { if (seconds === null) return '不限时长'; const safe = Math.max(0, Math.floor(Number(seconds) || 0)); return `${Math.floor(safe / 60)}分${safe % 60}秒`; };
const dateLabel = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : ''; };
const signalLabel = signal => ({ like: '感兴趣', dislike: '暂不感兴趣', neutral: '待观察' }[signal] || '待观察');

export function WatchControls({ state, video, configured, connected, otherBusy, busy, run, api, onView }) {
  const [budget, setBudget] = useState(30), dirty = useRef(false);
  const active = watchIsActive(state), counts = state?.counts;
  useEffect(() => { if (counts?.maxRequests && !dirty.current) setBudget(counts.maxRequests); }, [counts?.maxRequests]);
  return <div className="watch-controls">
    <div className="panel-title"><h3>自主观看</h3><Tag>{states[state?.status] || '正在读取状态'}</Tag></div>
    <p className="muted">大肥鱼会按人格和兴趣挑片，用实际观看与已确认行为积累偏好依据。</p>
    <label className="field"><span>本轮模型请求上限</span><Input aria-label="自主观看请求上限" type="number" min={1} max={10000} step={1} value={budget} disabled={active} onChange={event => { dirty.current = true; setBudget(event.target.value); }} /><small>默认30次，最多10000次，每日最多20000次；停止后再开不会清零本轮已用预算。</small></label>
    <div className="actions"><Button size="sm" variant="primary" disabled={!state || active || otherBusy || !connected || !configured || video?.allowed !== true || video?.session?.status !== 'active' || busy.has('watchStart') || busy.has('watchStop')} onClick={() => { void run('watchStart', async () => { await api('/api/watch/start', watchStartInput(budget)); dirty.current = false; }); }}>开始自主观看</Button><Button size="sm" disabled={!active || busy.has('watchStop')} onClick={() => { void run('watchStop', () => api('/api/watch/stop', {})); }}>停止自主观看</Button><Button size="sm" variant="ghost" onClick={onView}>查看观看记录</Button></div>
    <p className="notice">请先亲自开始新一轮。到时或预算用尽都会结束，不会自动续时或预约下一轮。</p>
    {otherBusy && <p className="notice">请先结束手动视频任务或转发，再开始自主观看。</p>}
    <p className="notice">本轮 {counts?.requests ?? 0} / {counts?.maxRequests ?? budget} 次 · 今日 {counts?.dailyRequests ?? 0} / {counts?.dailyLimit ?? 20000} 次</p>
    {active && state?.owned === false && <p className="notice">当前由另一个入口运行，停止按钮仍可请求停止。</p>}
  </div>;
}

function BehaviorEvidence({ value }) {
  const ratio = value?.watchRatio ?? value?.ratio, actual = value?.actions;
  return <div className="behavior-evidence"><div className="interest-list">
    {Number.isFinite(value?.watchedSeconds) && <Tag>已核实观看 {value.watchedSeconds} 秒</Tag>}
    {Number.isFinite(ratio) && <Tag>观看比例 {Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%</Tag>}
    {actual && ['stay', 'skip', 'share'].map(action => Number.isFinite(actual[action]) && <Tag key={action}>{{ stay: '继续停留', skip: '跳过', share: '已确认分享' }[action]} {actual[action]} 次</Tag>)}
  </div><p className="muted">{value?.basis || '只有画面或主题记录，尚无足够的实际观看与行为依据。'}</p>
    {value?.counts && <p className="muted">正向 {value.counts.like ?? 0} · 负向 {value.counts.dislike ?? 0} · 待观察 {value.counts.neutral ?? 0}</p>}
  </div>;
}

export function InterestRecords({ snapshot }) {
  return <><section className="persona-records"><h2>正在形成的兴趣</h2>
    <p className="muted">画面主题只是选题线索，喜好依据来自实际观看时长、比例及已确认行为，不从识别到的像素主题直接判断喜欢。</p>
    <div className="interest-records">{(snapshot?.interests || []).map((interest, index) => <article className="interest-card" key={interest?.key || interest?.id || `${topicOf(interest)}-${index}`}>
      <div className="interest-list"><Tag>{topicOf(interest) || '未命名兴趣'}</Tag><Tag>{signalLabel(interest?.basis || interest?.counts ? interest.signal : 'neutral')}</Tag></div>
      <small>{Number.isSafeInteger(interest?.evidenceCount) ? interest.evidenceCount : Array.isArray(interest?.evidence) ? interest.evidence.length : 0} 条作品依据{dateLabel(interest?.updatedAt) ? ` · 更新于 ${dateLabel(interest.updatedAt)}` : ''}</small>
      <BehaviorEvidence value={interest} />
      {(interest?.evidence || []).slice(-2).reverse().map((evidence, evidenceIndex) => <div className="interest-reflection" key={evidence?.evidenceId || evidenceIndex}>
        <p>选题反思：{evidence.reflection || '暂无文字反思。'}</p><BehaviorEvidence value={evidence} />
        <small>{evidence.source === 'dsh' ? '插件' : evidence.source === 'api' ? '独立软件' : evidence.source || ''}{dateLabel(evidence.at) ? ` · ${dateLabel(evidence.at)}` : ''}</small>
      </div>)}
    </article>)}</div>{!snapshot?.interests?.length && <p className="muted">还没有兴趣记录，实际观看与行为证据会逐步积累在共用记忆中。</p>}
  </section><section className="persona-records"><h2>最近观察与兴趣变化</h2>
    {(snapshot?.recentObservations || []).slice(-30).reverse().map((item, index) => <article className="observation-entry" key={item?.id || index}>
      {dateLabel(item?.observedAt || item?.createdAt || item?.at) && <small>{dateLabel(item.observedAt || item.createdAt || item.at)}</small>}
      <p>{item?.title || textOf(item) || '未读取到作品标题'}</p>{item?.author && <small>作者：{item.author}</small>}
      <div className="interest-list">{item?.kind && <Tag>{{ dom: '页面状态', visual: '画面采样', audio: '音频转写' }[item.kind] || item.kind}</Tag>}{Number.isFinite(item?.frameCount) && item.kind === 'visual' && <Tag>{item.frameCount} 帧</Tag>}{Number.isFinite(item?.playback?.time) && <Tag>播放位置 {Math.round(item.playback.time)} 秒</Tag>}</div>
      <BehaviorEvidence value={item} />
    </article>)}{!snapshot?.recentObservations?.length && <p className="muted">还没有观察记录。</p>}
  </section></>;
}

export function WatchView({ state, video, browser, snapshot, onSettings }) {
  const active = watchIsActive(state), decision = state?.lastDecision;
  return <div className="memory-view watch-view"><div className="section-heading"><h1>自主观看</h1><p>和插件共用大肥鱼的人格与兴趣；每次启动只在你允许的当前轮次内运行。</p></div>
    <div className="watch-summary"><Tag>{states[state?.status] || '正在读取状态'}</Tag><strong>本轮剩余 {secondsLabel(video?.allowed && video?.remainingSeconds === null ? null : video?.remainingSeconds ?? state?.remainingSeconds)}</strong><span>模型请求 {state?.counts?.requests ?? 0} / {state?.counts?.maxRequests ?? 30}</span><Button size="sm" onClick={onSettings}>查看启动设置</Button></div>
    <section className="persona-records"><h2>当前选择</h2>{browser?.video?.title && <h3>{browser.video.title}</h3>}{decision ? <><Tag>{actions[decision.action] || decision.action || '观察作品'}</Tag><p className="decision-reason">{decision.reason || '当前选择尚未给出理由。'}</p>{decision.query && <p className="muted">搜索：{decision.query}</p>}{Number.isFinite(decision.seconds) && <p className="muted">计划观察 {decision.seconds} 秒</p>}</> : <p className="muted">{active ? '正在准备本次选择…' : '点击右侧“开始自主观看”后会显示选择理由。'}</p>}{state?.lastError && <p className="notice error" role="alert">{state.lastError}</p>}</section>
    <InterestRecords snapshot={snapshot} />
    <div className="watch-origin"><span>运行入口：{state?.worker?.source || '无活动入口'}</span><span>本窗口持有 worker：{state?.owned === true ? '是' : '否'}</span></div>
  </div>;
}

export function PersonaPanel({ snapshot, onSnapshot, api, run, bridge, busy, watchState, watchReady }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [baseRevision, setBaseRevision] = useState(null), [notice, setNotice] = useState('');
  const active = watchIsActive(watchState), conflict = editing && snapshot?.revision !== baseRevision;
  useEffect(() => { if (!editing) setDraft(snapshot?.manualText || ''); }, [snapshot?.manualText, editing]);
  function edit() { setDraft(snapshot?.manualText || ''); setBaseRevision(snapshot?.revision); setNotice(''); setEditing(true); }
  async function save(event) {
    event.preventDefault(); if (!editing || conflict || active || !watchReady || busy.has('personaSave')) return;
    await run('personaSave', async () => {
      try { const result = await api('/api/persona/card', { text: draft, expectedRevision: baseRevision }); onSnapshot(result); setEditing(false); setNotice('人格正文已保存，两个入口会读取同一份文件。'); }
      catch (error) { if (error.status === 409) { setNotice('保存前文件已更新，草稿已保留。请比较后选择使用哪个版本。'); onSnapshot(await api('/api/persona')); } throw error; }
    });
  }
  return <section className="persona-section"><div className="section-heading"><h2>人格与兴趣</h2><p>手编人格单独保存，兴趣和观察会随记忆积累。这里不修改时段、许可名单或发送权限。</p></div>
    <div className="memory-location"><strong>软件与插件共用的人格文件夹</strong><code>{snapshot?.personaFolder || '正在读取人格文件夹位置…'}</code>{snapshot?.roleCardFile && <small>{snapshot.roleCardFile}</small>}<Button size="sm" variant="outline" disabled={!snapshot?.personaFolder || !bridge?.openPersonaFolder} onClick={() => { void run('openPersona', () => bridge.openPersonaFolder()); }}>打开人格文件夹</Button></div>
    {!snapshot ? <p className="muted">正在读取共用人格…</p> : <><h3>手编人格正文</h3>{editing ? <form onSubmit={event => { void save(event); }}><label className="field"><span>编辑人格正文</span><textarea aria-label="人格正文" rows={12} maxLength={40000} value={draft} onChange={event => setDraft(event.target.value)} /></label>
      {conflict && <div className="persona-conflict" role="alert"><strong>人格文件已有新版本，未保存的草稿已保留。</strong><details><summary>查看最新的手编人格</summary><p className="plain-persona">{snapshot.manualText || '最新版本为空。'}</p></details><div className="actions"><Button size="sm" disabled={busy.has('personaSave')} onClick={() => { setDraft(snapshot.manualText || ''); setBaseRevision(snapshot.revision); setNotice('已载入最新人格，可继续编辑。'); }}>载入最新人格</Button><Button size="sm" disabled={busy.has('personaSave')} onClick={() => { setBaseRevision(snapshot.revision); setNotice('已保留草稿；点击保存会用草稿替换最新的手编正文。'); }}>保留草稿，采用最新版本号</Button></div></div>}
      <div className="actions"><Button type="submit" size="sm" variant="primary" disabled={conflict || active || !watchReady || busy.has('personaSave')}>保存人格</Button><Button size="sm" disabled={busy.has('personaSave')} onClick={() => { setEditing(false); setNotice(''); }}>取消编辑</Button></div></form> : <><div className="persona-card">{snapshot.manualText ? <MarkdownText text={snapshot.manualText} labels={LABELS} /> : <p className="muted">暂未填写手编人格，当前沿用共用人格文件。</p>}</div><Button size="sm" variant="outline" disabled={active || !watchReady} onClick={edit}>编辑人格</Button></>}
      {snapshot.personaText && <details className="effective-persona"><summary>查看当前生效人格</summary><MarkdownText text={snapshot.personaText} labels={LABELS} /></details>}</>}
    {active && <p className="notice">请先停止自主观看，再保存人格正文。</p>}{notice && <p className="notice" role="status">{notice}</p>}
    <InterestRecords snapshot={snapshot} />
  </section>;
}
