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
    {state?.lastError && <p className="notice" role="status">上次自主观看停止原因：{state.lastError}</p>}
    {active && state?.owned === false && <p className="notice">当前由另一个入口运行，停止按钮仍可请求停止。</p>}
  </div>;
}

const evidenceActions = [['stay', '继续停留'], ['skip', '跳过'], ['share', '确认分享']];
const evidenceBasis = new Map([
  ['observation-only', '仅有作品观察'], ['insufficient-behavior', '待观察'],
  ['confirmed-share', ''], ['sustained-watch', ''], ['quick-skip', '']
]);

function BehaviorEvidence({ value }) {
  const seconds = value?.watchedSeconds, ratio = value?.watchRatio ?? value?.ratio;
  const percentage = Number.isFinite(ratio) ? `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` : '';
  const evidence = [];
  if (Number.isFinite(seconds) && seconds > 0) evidence.push(`观看 ${seconds} 秒${percentage ? `（${percentage}）` : ''}`);
  else if (ratio > 0 && percentage) evidence.push(`观看 ${percentage}`);
  for (const [action, label] of evidenceActions) {
    const count = value?.actions?.[action];
    if (Number.isFinite(count) && count > 0) evidence.push(`${label} ${count} 次`);
  }
  const basis = evidenceBasis.get(value?.basisCode) ?? value?.basis;
  if (basis) evidence.push(basis);
  return evidence.length ? <p className="behavior-evidence">{evidence.join(' · ')}</p> : null;
}

function InterestCard({ interest }) {
  const evidence = Array.isArray(interest?.evidence) ? interest.evidence : [];
  const count = Number.isSafeInteger(interest?.evidenceCount) ? interest.evidenceCount : evidence.length;
  const counts = interest?.counts, updated = dateLabel(interest?.updatedAt);
  const topic = topicOf(interest) || '未命名兴趣';
  return <details className="interest-card interest-details">
    <summary>
      <strong className="interest-topic" title={topic}>{topic}</strong>
      <span>{signalLabel(interest?.basis || counts ? interest.signal : 'neutral')}</span>
      <span className="interest-count">{count} 条依据</span>
    </summary>
    <div className="interest-detail">
      {counts ? <p>正向 {counts.like ?? 0} · 负向 {counts.dislike ?? 0} · 待观察 {counts.neutral ?? 0}</p>
        : interest?.basis && <p>{interest.basis}</p>}
      {updated && <small>更新于 {updated}</small>}
      {evidence.slice(-2).reverse().map((entry, index) => {
        const source = entry.source === 'dsh' ? '插件' : entry.source === 'api' ? '独立软件' : entry.source;
        const origin = [source, dateLabel(entry.at)].filter(Boolean).join(' · ');
        return <div className="interest-reflection" key={entry.evidenceId || index}>
          {entry.reflection && <p>{entry.reflection}</p>}
          <BehaviorEvidence value={entry} />
          {origin && <small>{origin}</small>}
        </div>;
      })}
    </div>
  </details>;
}

export function InterestRecords({ snapshot }) {
  return <><section className="persona-records"><h2>正在形成的兴趣</h2>
    <div className="interest-records">{(snapshot?.interests || []).map((interest, index) => (
      <InterestCard interest={interest} key={interest?.key || interest?.id || `${topicOf(interest)}-${index}`} />
    ))}</div>{!snapshot?.interests?.length && <p className="muted">暂无兴趣记录。</p>}
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
  const watchedSeconds = video?.daily?.usedSeconds;
  const watched = Number.isFinite(watchedSeconds) ? Math.max(0, Math.floor(watchedSeconds)) : null;
  const remaining = video?.daily && Object.hasOwn(video.daily, 'remainingSeconds')
    ? video.daily.remainingSeconds : video?.policy?.dailyMinutes === null ? null : video?.remainingSeconds;
  const requests = video?.daily?.requests ?? state?.counts?.dailyRequests;
  const limit = video?.policy?.dailyRequests === null ? '不限' : video?.policy?.dailyRequests ?? state?.counts?.dailyLimit;
  const remainingLabel = remaining === null || Number.isFinite(remaining) ? secondsLabel(remaining) : '—';
  return <div className="memory-view watch-view">
    <section className="watch-summary" aria-label="今日观看用量">
      <dl className="watch-metrics">
        <div className="watch-metric-primary">
          <dt>今日已观看</dt>
          <dd>{watched === null ? '—' : <>{Math.floor(watched / 60)} <span>分</span> {watched % 60} <span>秒</span></>}</dd>
        </div>
        <div><dt>剩余时长</dt><dd>{remainingLabel}</dd></div>
        <div><dt>今日模型请求</dt><dd>{requests ?? '—'} <span>{limit === undefined ? '次' : '/ ' + limit}</span></dd></div>
      </dl>
      <div className="watch-summary-actions">
        <Tag>{states[state?.status] || '正在读取状态'}</Tag>
        <Button size="sm" variant="outline" onClick={onSettings}>{state?.recovery ? '处理观看暂停' : '查看观看设置'}</Button>
      </div>
    </section>
    <section className="persona-records"><h2>当前选择</h2>{browser?.video?.title && <h3>{browser.video.title}</h3>}{decision ? <><Tag>{actions[decision.action] || decision.action || '观察作品'}</Tag>{decision.reason && <p className="decision-reason">{decision.reason}</p>}{decision.query && <p className="muted">搜索「{decision.query}」</p>}{Number.isFinite(decision.seconds) && <p className="muted">计划观察 {decision.seconds} 秒</p>}</> : <p className="muted">{active ? '正在挑片…' : '暂无选择。'}</p>}{state?.lastError && <p className="notice error" role="alert">{state.lastError}</p>}</section>
    <InterestRecords snapshot={snapshot} />
  </div>;
}

export function PersonaPanel({ snapshot, onSnapshot, api, run, bridge, busy, watchState, watchReady }) {
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [baseRevision, setBaseRevision] = useState(null), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false), [forceConflict, setForceConflict] = useState(false);
  const retired = useRef(new Set()), accepted = useRef(snapshot), alive = useRef(true), dirty = useRef(false), version = useRef(0), writing = useRef(false), queued = useRef(false), live = useRef({});
  if (snapshot && !retired.current.has(snapshot.revision)) accepted.current = snapshot;
  const shown = accepted.current, active = watchIsActive(watchState), conflict = editing && (forceConflict || shown?.revision !== baseRevision);
  const effectiveText = shown?.personaText || shown?.manualText;
  live.current = { editing, draft, baseRevision, active, watchReady, forceConflict, onSnapshot, api };
  useEffect(() => { alive.current = true; return () => { alive.current = false; queued.current = false; }; }, []);
  useEffect(() => { if (!editing) setDraft(shown?.manualText || ''); }, [shown?.manualText, editing]);
  function adoptRevision(value) { live.current.baseRevision = value; setBaseRevision(value); live.current.forceConflict = false; setForceConflict(false); }
  function edit() { const current = accepted.current; dirty.current = false; version.current += 1; setDraft(current?.manualText || ''); adoptRevision(current?.revision); setNotice('修改后离开输入框会自动保存。'); setEditing(true); }
  async function save() {
    const current = live.current;
    if (!current.editing || !dirty.current || current.active || !current.watchReady || current.forceConflict || accepted.current?.revision !== current.baseRevision) return;
    if (writing.current) { queued.current = true; return; }
    const submitted = version.current, text = current.draft, revision = current.baseRevision;
    writing.current = true; queued.current = false; setSaving(true); setNotice('正在保存人格正文…');
    try {
      const result = await current.api('/api/persona/card', { text, expectedRevision: revision });
      if (!alive.current) return;
      if (!result || typeof result.revision !== 'string' || result.manualText !== text) throw new Error('人格保存回读不完整。');
      const external = accepted.current?.revision !== revision && accepted.current?.revision !== result.revision;
      if (revision !== result.revision) retired.current.add(revision);
      adoptRevision(result.revision);
      if (!external) { accepted.current = result; current.onSnapshot(result); }
      if (version.current === submitted && !external) { dirty.current = false; setEditing(false); setNotice('人格正文已自动保存，两个入口会读取同一份文件。'); }
      else { setNotice(external ? '保存后又发现外部新版本，当前草稿已保留，请比较。' : '上一段已保存，新的输入仍保留；离开输入框后再保存。'); }
    } catch (error) {
      queued.current = false;
      if (alive.current) {
        if (error.status === 409) {
          live.current.forceConflict = true; setForceConflict(true); setNotice('保存前文件已更新，草稿已保留。请比较后选择使用哪个版本。');
          try { const latest = await current.api('/api/persona'); if (alive.current) { accepted.current = latest; current.onSnapshot(latest); } } catch { /* 读取失败继续保留原草稿，不自动重试覆盖。 */ }
        } else setNotice(`${error.message || '人格保存失败。'} 草稿已保留，离开输入框可重试。`);
      }
    } finally { writing.current = false; if (alive.current) { setSaving(false); if (queued.current) { queued.current = false; void save(); } } }
  }
  function chooseLatest() { const current = accepted.current; dirty.current = false; version.current += 1; setDraft(current?.manualText || ''); live.current.draft = current?.manualText || ''; adoptRevision(current?.revision); setNotice('已载入最新人格，可继续编辑。'); }
  function keepDraft() { adoptRevision(accepted.current?.revision); dirty.current = true; setNotice('已采用最新版本号，正在保存保留的草稿。'); void save(); }
  return <section className="persona-section"><div className="section-heading"><h2>人格与兴趣</h2></div>
    <div className="actions"><Button size="sm" variant="outline" title={snapshot?.personaFolder} disabled={!snapshot?.personaFolder || !bridge?.openPersonaFolder} onClick={() => { void run('openPersona', () => bridge.openPersonaFolder()); }}>打开人格文件夹</Button></div>
    {!shown ? <p className="muted">正在读取共用人格…</p> : <details className="effective-persona">
      <summary>查看当前生效人格</summary>
      {editing ? <div>
        <label className="field"><span>编辑人格正文，离开输入框自动保存</span>
          <textarea aria-label="人格正文" rows={12} maxLength={40000} disabled={active || !watchReady} value={draft} onChange={event => {
            const text = event.target.value;
            version.current += 1;
            dirty.current = true;
            live.current.draft = text;
            setDraft(text);
            setNotice('离开输入框后自动保存。');
          }} onBlur={() => { void save(); }} />
        </label>
        {conflict && <div className="persona-conflict" role="alert">
          <strong>人格文件已有新版本，未保存的草稿已保留。</strong>
          <details><summary>查看最新的手编人格</summary><p className="plain-persona">{shown.manualText || '最新版本为空。'}</p></details>
          <div className="actions">
            <Button size="sm" disabled={saving} onMouseDown={event => event.preventDefault()} onClick={chooseLatest}>载入最新人格</Button>
            <Button size="sm" disabled={saving} onMouseDown={event => event.preventDefault()} onClick={keepDraft}>保留草稿，采用最新版本号</Button>
          </div>
        </div>}
        <div className="actions"><Button size="sm" disabled={saving} onMouseDown={event => event.preventDefault()} onClick={() => {
          dirty.current = false;
          version.current += 1;
          queued.current = false;
          setEditing(false);
          setNotice('');
        }}>取消编辑</Button></div>
      </div> : <>
        <div className="actions"><Button size="sm" variant="outline" disabled={active || !watchReady} onClick={edit}>编辑人格</Button></div>
        <div className="persona-card">
          {effectiveText ? <MarkdownText text={effectiveText} labels={LABELS} /> : <p className="muted">暂无人格正文。</p>}
        </div>
      </>}
      {active && <p className="notice">请先停止自主观看，再保存人格正文。</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
    </details>}
    <InterestRecords snapshot={snapshot} />
  </section>;
}
