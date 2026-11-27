import brandIcon from '../../../assets/brand.png';
import { UpdateDialog } from './autonomy-panels.jsx';
import { SETTINGS_SECTIONS } from '../../../settings-sections.mjs';
import { HealthDashboard, TopicPanel } from './health-dashboard.jsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Input, Switch, Tag, StateDot, MarkdownText, JsonBlock, DisclosureRow } from '@dsh/primitives';
import frame from '@dsh/frame';
import '@dsh/theme/base.css';
import '@dsh/theme/corner-shape.css';
import '@dsh/theme/design-platform.css';
import '@dsh/theme/scrollbar.css';
import '@dsh/theme/gradient-shadow-text.css';
import '@dsh/theme/shiki.css';
import './style.css';
import './workspace.css';
import { createApiClient, publicSettings, saveNativeSettings, saveNativeMediaKey, createForwardGate, mergeEvents, watchIsActive, requestFailure, operationLabel } from './api.mjs';
import { WatchView, PersonaPanel } from './watch-persona.jsx';
import { TaskBudgetPanel } from './task-budget.jsx';
import { ShareReceipts } from './autonomous-share.jsx';
import { useAutoSave, AutoSaveStatus } from './use-auto-save.jsx';
import { ViewingModePanel, CommentsPanel, ReportsView } from './watch-settings.jsx';

const MARKDOWN_LABELS = { code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '注释' };
const VERIFICATION_STATUS_TEXT = {
  opening: '正在打开验证画面…',
  rechecking: '正在核对后台标签页…',
  opened: '在辅助验证窗口完成登录或验证后，点「检查验证」。',
  required: '抖音仍在等待验证。',
  'login-required': '专用浏览器需要登录。',
  verified: '刚才验证的标签页已恢复。',
  ready: '当前抖音页面已就绪。',
  checking: '还没读到可用的抖音页面，请稍后检查。',
  'browser-unavailable': '专用浏览器尚未连接。',
  'session-changed': '专用浏览器会话已变化，请重新打开辅助验证。',
};
const EVENT_LABELS = { 'model.request': '请求模型', 'model.usage': '本次用量', 'model.answer': '模型答复', 'tool.start': '调用工具', 'tool.result': '工具返回', 'tool.error': '工具出错', 'task.started': '开始任务', 'task.completed': '任务完成', 'task.stopped': '任务停止', 'task.failed': '任务失败', 'task.limited': '达到限制', 'task.needs_user': '需要手动操作', 'video.started': '开始观看', 'video.limited': '视频时间已结束' };
const EXAMPLES = [['看推荐', '看看当前推荐视频，观察 3 秒，告诉我画面里发生了什么。'], ['搜索猫咪', '搜索猫咪，打开第一条作品并观察 3 秒，告诉我实际看到了什么。'], ['下一条', '切换下一条视频，读回切换是否成功，再观察 3 秒。'], ['上一条', '切换上一条视频，读回切换是否成功。'], ['暂停', '暂停当前视频，确认播放状态。'], ['播放', '播放当前视频，确认播放进度。']];
const truncated = total => `内容较长，当前展示前 20000 字符（共 ${total} 字符）。`;
const contactName = contact => contact?.name || contact?.displayName || '联系人';
const statusLabel = status => ({ completed: '已完成', running: '进行中', stopping: '正在停止', stopped: '已停止', failed: '未完成', limited: '已到限制', needs_user: '等待手动操作' }[status] || '准备中');

function Field({ title, hint, children }) { return <label className="field"><span>{title}</span>{children}{hint && <small>{hint}</small>}</label>; }
function Panel({ title, badge, children }) { return <section className="panel"><div className="panel-title"><h2>{title}</h2>{badge}</div>{children}</section>; }
function Note({ children, error = false }) { return <p className={error ? 'notice error' : 'notice'} role={error ? 'alert' : undefined}>{children}</p>; }
function SettingsUsage({ label, items }) {
  return <dl className="settings-usage" aria-label={label}>{items.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value ?? '—'}</dd></div>)}</dl>;
}
function usageDuration(seconds) {
  if (!Number.isFinite(seconds)) return undefined;
  const total = Math.max(0, Math.floor(seconds));
  return total < 60 ? `${total} 秒` : `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
}
const usageCount = value => Number.isFinite(value) ? `${value} 次` : undefined;
function RecoveryActions({ busy, connected, message, onRetry, onHealth, onOpen }) {
  return <span className="error-actions">
    {onRetry && <button type="button" disabled={!connected} onClick={onRetry}>重试</button>}
    <button type="button" disabled={!connected || busy.has('browserOpen')} onClick={onOpen}>重新连接专用浏览器</button>
    <button type="button" onClick={onHealth}>运行自检</button>
    <button type="button" onClick={() => { void navigator.clipboard?.writeText(message).catch(() => {}); }}>复制错误</button>
  </span>;
}
function Data({ label = '查看返回数据', value }) { return <JsonBlock label={label} payload={value} truncatedLabel={truncated} />; }

function FriendPresence({ presence, connected }) {
  const current = connected ? presence : null;
  const reply = current?.reply || current, watch = current?.watch;
  const label = reply?.label || '状态待核实', reason = reply?.reason || '正在读取好友回复服务状态。';
  const status = reply?.status || current?.status;
  return <div className="friend-presence" role="status" aria-live="polite" title={[reason, watch?.active ? watch.reason : ''].filter(Boolean).join(' ')}>
    <span className="presence-label" data-state={reply?.online === true ? 'online' : status} aria-label="好友互动状态" title={reason}>
      <span className="presence-dot" aria-hidden="true" />{label}
    </span>
    {watch?.active && <span className="presence-watch" role="status" aria-label="自主观看状态" title={watch.reason}>{watch.label}</span>}
  </div>;
}

function ReviewDialog({ share, api, run, busy, connected, onClose }) {
  const shareItems = share?.needsReview || [];
  const nameOf = id => share?.recipients?.find(item => item.id === id)?.name || '许可会话';
  const statusOf = status => ({ reserved: '已预留，待核对', clicking: '处理中，待核对', uncertain: '送达未确认', confirmed: '已确认送达', 'not-sent': '未发出', 'resolved-confirmed': '人工已确认送达', 'resolved-not-sent': '人工已确认未送达' }[status] || status || '需要人工核对');
  async function resolveShare(item, outcome) { await run(`shareResolve-${item.operationId}`, () => api('/api/share/resolve', { operationId: item.operationId, outcome })); }
  async function resolveAllNotSent() { for (const item of shareItems) await resolveShare(item, 'not-sent'); }
  return <div className="settings-scrim" role="dialog" aria-modal="true" aria-label="处理分享收据"><div className="api-dialog review-dialog">
    <div className="dialog-head"><h2>处理分享收据</h2><button aria-label="关闭分享收据" onClick={onClose}>×</button></div>
    {shareItems.length > 0 && <><h3>分享收据（{shareItems.length}）</h3>{shareItems.map(item => <div className="paused-contact" key={item.operationId}><strong>{nameOf(item.recipientId)} · 作品 {item.videoId}</strong><p>{statusOf(item.status)}</p>{item.failure?.message && <p className="notice">原因：{item.failure.message}</p>}<div className="actions"><Button size="sm" disabled={!connected || busy?.has(`shareResolve-${item.operationId}`)} onClick={() => { void resolveShare(item, 'confirmed'); }}>已确认送达</Button><Button size="sm" variant="outline" disabled={!connected || busy?.has(`shareResolve-${item.operationId}`)} onClick={() => { void resolveShare(item, 'not-sent'); }}>确认未送达</Button></div></div>)}<div className="actions"><Button size="sm" variant="outline" disabled={!connected || share?.busy} onClick={() => { void resolveAllNotSent(); }}>全部按未送达处理</Button></div></>}
    {share?.recoveryRequired && shareItems.length === 0 && <Note error>上次分享进程中断，没有可逐条核对的收据；先在“好友互动”重新开启分享会要求先处理这条恢复记录。</Note>}
    {!shareItems.length && !share?.recoveryRequired && <Note>目前没有待核对项。</Note>}
  </div></div>;
}

function ApiSettings({ settings, bridge, onSaved, onClose, run, busy, operationActive, onOpenDouyin, openingDouyin, connected, operationError, verificationButton, verificationFeedback }) {
  const [draft, setDraft] = useState({ apiKey: '', baseUrl: settings.baseUrl, model: settings.model, remember: settings.remember }), [failure, setFailure] = useState(''), [notice, setNotice] = useState('');
  const current = useRef(draft), version = useRef(0), dirty = useRef(false), writing = useRef(false), queued = useRef(false);
  useEffect(() => { if (!dirty.current) { const next = { apiKey: '', baseUrl: settings.baseUrl, model: settings.model, remember: settings.remember }; current.current = next; setDraft(next); } }, [settings.baseUrl, settings.model, settings.remember]);
  function edit(patch) { version.current++; dirty.current = true; current.current = { ...current.current, ...patch }; setDraft(current.current); setFailure(''); setNotice(''); }
  async function save() {
    if (!dirty.current || (!settings.configured && !current.current.apiKey.trim()) || operationActive || !bridge?.saveSettings) return;
    if (writing.current) { queued.current = true; return; }
    const input = { ...current.current, apiKey: current.current.apiKey.trim(), baseUrl: current.current.baseUrl.trim(), model: current.current.model.trim() };
    if (!input.baseUrl || !input.model) { setNotice('请填写完整接口地址和模型名称。'); return; }
    writing.current = true; queued.current = false; const submitted = version.current; setFailure(''); setNotice('正在保存…');
    try { const result = await saveNativeSettings(bridge, input); if (version.current === submitted) { dirty.current = false; current.current = { ...current.current, apiKey: '' }; setDraft(current.current); } await onSaved(result); setNotice('模型设置已生效。'); }
    catch (error) { setNotice(''); setFailure(`${error.message || '模型设置未保存。'} 输入已保留。`); }
    finally { input.apiKey = ''; writing.current = false; if (queued.current) { queued.current = false; void save(); } }
  }
  return <div className="settings-scrim"><section className="api-dialog" role="dialog" aria-modal="true" aria-labelledby="api-title">
    <div className="brand-icon"><img src={brandIcon} alt="大肥鱼图标" /></div><h1 id="api-title">{settings.configured ? '模型与共享记忆' : '先连接你的 DeepSeek'}</h1>
    <div className="actions"><Button size="sm" variant="outline" onClick={onOpenDouyin} disabled={!connected || openingDouyin}>{openingDouyin ? '正在打开抖音…' : '打开抖音'}</Button>{verificationButton}</div>
    {verificationFeedback}
    {operationError && <Note error>{operationError}</Note>}{operationActive && <Note>请先结束当前任务或等待互动处理完成。自主观看运行时，请先关闭允许自动观看。</Note>}
    <Field title="API Key"><Input aria-label="API Key" type="password" autoComplete="off" value={draft.apiKey} onChange={event => edit({ apiKey: event.target.value })} onBlur={() => { void save(); }} maxLength={4096} disabled={operationActive} placeholder={settings.configured ? '留空沿用现有 API Key' : '输入后自动保存'} autoFocus /></Field>
    <details className="advanced"><summary>接口与模型</summary><Field title="API 地址"><Input aria-label="API 地址" value={draft.baseUrl} disabled={operationActive} onChange={event => edit({ baseUrl: event.target.value })} onBlur={() => { void save(); }} /></Field><Field title="模型名称"><Input aria-label="模型名称" value={draft.model} maxLength={120} disabled={operationActive} onChange={event => edit({ model: event.target.value })} onBlur={() => { void save(); }} /></Field></details>
    <div className="switch-row"><span>记住 API Key</span><Switch label="记住 API Key" checked={draft.remember} disabled={operationActive} onChange={value => { edit({ remember: value }); void save(); }} /></div>
    {failure && <Note error>{failure}</Note>}{notice && <p role="status">{notice}</p>}
    {settings.configured && <div className="actions"><Button onClick={onClose}>返回</Button><Button size="sm" disabled={busy || operationActive} onClick={() => { void run('clearKey', async () => onSaved(publicSettings(await bridge.clearApiKey()))); }}>清除已保存的 API Key</Button></div>}
    <div className="actions"><Button size="sm" variant="outline" title={settings.memoryFolder} disabled={!bridge?.openMemoryFolder || !settings.memoryFolder} onClick={() => { void run('openMemory', () => bridge.openMemoryFolder()); }}>打开记忆文件夹</Button></div>
  </section></div>;
}

function VideoPanel({ state, schedule, watch, api, busy, connected = true, configured = false, browserMode, verification, onOpenBrowser, onDiagnostics, onReviewComments, children }) {
  const read = snapshot => {
    const policy = snapshot?.policy || {}, minutes = Object.hasOwn(policy, 'dailyMinutes') ? policy.dailyMinutes : Object.hasOwn(policy, 'sessionMinutes') ? policy.sessionMinutes : 10, requests = Object.hasOwn(policy, 'dailyRequests') ? policy.dailyRequests : 30;
    return { windows: (policy.windows || ['00:00-24:00']).join('\n'), weekendAll: policy.weekendWindows?.join() === '00:00-24:00', dailyMinutes: minutes ?? '', unlimitedMinutes: minutes === null, dailyRequests: requests ?? '', unlimitedRequests: requests === null };
  };
  const encode = draft => {
    const windows = draft.windows.split(/[\n,;，；]+/).map(item => item.trim()).filter(Boolean);
    if (!windows.length || windows.some(item => !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(item))) throw new Error('时段请填写完整的 HH:MM-HH:MM。');
    const number = (value, unlimited, label) => { if (unlimited) return null; const result = Number(value); if (String(value).trim() === '' || !Number.isSafeInteger(result) || result < 1) throw new Error(`${label}请填写正整数，或选择不限。`); return result; };
    return { windows, weekendWindows: draft.weekendAll ? ['00:00-24:00'] : null, dailyMinutes: number(draft.dailyMinutes, draft.unlimitedMinutes, '每日观看分钟数'), dailyRequests: number(draft.dailyRequests, draft.unlimitedRequests, '每日模型请求次数') };
  };
  const form = useAutoSave({ value: state, initial: read(null), read, encode, write: payload => api('/api/video/policy', payload), canonical: (saved, payload) => saved?.policy ? encode(read(saved)) : payload, available: connected });
  const privateVideo = useAutoSave({
    value: state?.privateVideoSchedule, initial: { mode: 'all-day' },
    read: value => ({ mode: value.mode || '' }), encode: value => value,
    write: payload => api('/api/video/private-schedule', payload), available: connected && Boolean(state?.privateVideoSchedule),
  });
  const { draft, edit } = form;
  const [toggleStatus, setToggleStatus] = useState(''), [toggleError, setToggleError] = useState('');
  const changing = useRef(false), pending = useRef(null), enabled = schedule?.policy?.enabled === true;
  const watchReady = connected && typeof schedule?.policy?.enabled === 'boolean' && typeof watch?.running === 'boolean', watching = watchIsActive(watch);
  const daily = state?.daily;
  const scheduleError = schedule?.lastError || '';
  const recordedFailure = schedule?.last?.status === 'failed' && schedule.last.error === scheduleError;
  const olderScheduleError = recordedFailure && (watching || Date.parse(watch?.updatedAt) > Date.parse(schedule.last.completedAt));
  const watchError = !watch?.running && !['limited', 'stopped'].includes(watch?.status) ? watch?.lastError : '';
  const stopError = (olderScheduleError ? '' : scheduleError) || watchError;
  const recovery = stopError && (stopError === watchError && watch?.recovery || { action: 'diagnostics', message: stopError });
  const needsVerification = recovery && (recovery.action === 'verify' || verification.required) && !verification.ready;
  const reviewingComments = recovery?.action === 'review-comments';
  const needsBrowser = recovery?.action === 'browser' || needsVerification && !verification.available;
  const canStart = watchReady && configured && !watching && !schedule?.busy && !changing.current;
  const watchLabel = watch?.running ? '正在观看' : !enabled ? '已关闭' : stopError ? '已停止' : state?.allowed ? '准备观看' : '等待允许时段';
  useEffect(() => { if (pending.current !== null && enabled === pending.current) { pending.current = null; setToggleStatus(''); } }, [enabled]);
  async function toggle(value) {
    if (changing.current) return; changing.current = true; pending.current = value; setToggleError(''); setToggleStatus('正在更新自动观看…');
    try { const saved = await api('/api/watch/schedule', { enabled: value }); if (saved?.policy?.enabled === value) { pending.current = null; setToggleStatus(''); } else if (pending.current !== null) setToggleStatus('等待状态同步…'); }
    catch (error) { pending.current = null; setToggleStatus(''); setToggleError(error.message || '自动观看设置未生效。'); }
    finally { changing.current = false; }
  }
  return <Panel title="视频观看" badge={<Tag>{watchLabel}</Tag>}>
    <div className="switch-row"><span>允许自动观看</span><Switch label="允许自动观看" checked={enabled} disabled={!connected || typeof schedule?.policy?.enabled !== 'boolean' || changing.current} onChange={value => { void toggle(value); }} /></div>
    <div className="actions">{!recovery && <Button size="sm" variant="primary" disabled={!canStart} onClick={() => { void toggle(true); }}>开始自主观看</Button>}<Button size="sm" variant="outline" disabled={!watchReady || !enabled && !watching && !schedule?.busy || changing.current} onClick={() => { void toggle(false); }}>暂停观看</Button></div>
    {recovery && <section aria-label="恢复自主观看">
      <Note error>{recovery.message}</Note>
      {needsBrowser && browserMode?.mode === 'background' && <Note>在「观看方式」关闭后台观看，再到专用浏览器处理。</Note>}
      <div className="actions">
        {needsVerification && verification.available && <>
          <Button size="sm" variant="primary" disabled={verification.disabled} onClick={() => verification.start(false)}>辅助验证</Button>
          {verification.canCheck && <Button size="sm" variant="outline" disabled={verification.disabled} onClick={() => verification.start(true)}>检查验证</Button>}
        </>}
        {needsBrowser && browserMode?.mode !== 'background' && <Button size="sm" variant="outline" disabled={!connected || busy.has('browserOpen')} onClick={onOpenBrowser}>打开抖音</Button>}
        {reviewingComments && <Button size="sm" variant="outline" onClick={onReviewComments}>查看评论记录</Button>}
        {(!needsVerification || !verification.available) && !reviewingComments && <Button size="sm" variant="primary" disabled={!canStart || state?.allowed !== true} onClick={() => { void toggle(true); }}>继续观看</Button>}
        <Button size="sm" variant="outline" onClick={onDiagnostics}>打开自检</Button>
      </div>
    </section>}
    {toggleStatus && <p role="status">{toggleStatus}</p>}{toggleError && <Note error>{toggleError}</Note>}
    {state?.reason && <Note>{state.reason}</Note>}
    <SettingsUsage label="今日视频用量" items={[
      ['今日自主观看', usageDuration(daily?.usedSeconds)],
      ['今日私信视频', usageDuration(daily?.privateVideoSeconds)],
      ['模型请求', usageCount(daily?.requests)],
      ['剩余自主观看', daily?.remainingSeconds === null ? '不限' : usageDuration(daily?.remainingSeconds)]
    ]} />
    {state?.privateVideoSchedule && <Field title="私信分享视频时段">
      <select aria-label="私信分享视频时段" value={privateVideo.draft.mode} disabled={!connected} onChange={event => privateVideo.edit({ mode: event.target.value }, { immediate: true })}>
        <option value="" disabled>请选择观看时段</option>
        <option value="all-day">全天</option>
        <option value="follow-watch-hours">跟随自主观看时段</option>
      </select>
      <AutoSaveStatus status={privateVideo.status} />
    </Field>}
    <div className="actions"><Button size="sm" type="button" onClick={() => edit({ windows: '00:00-09:00\n12:00-14:00\n18:00-24:00', weekendAll: true }, { immediate: true })}>谷时段（DeepSeek）</Button><Button size="sm" type="button" onClick={() => edit({ windows: '00:00-24:00', weekendAll: false }, { immediate: true })}>全天</Button><Button size="sm" type="button" onClick={() => edit({ windows: '20:00-22:00', weekendAll: false }, { immediate: true })}>晚间 20–22 点</Button></div>
    <div className="switch-row"><span>周末全天允许</span><Switch label="周末全天允许" checked={draft.weekendAll} onChange={value => edit({ weekendAll: value }, { immediate: true })} /></div>
    <Field title="每日允许时段 · 北京时间"><textarea aria-label="每日允许时段" rows={2} value={draft.windows} maxLength={220} onChange={event => edit({ windows: event.target.value })} /></Field>
    <details><summary>高级选项</summary>
      <div className="switch-row"><span>不限每日观看时长</span><Switch label="不限每日观看时长" checked={draft.unlimitedMinutes} onChange={value => edit({ unlimitedMinutes: value }, { immediate: true })} /></div>
      <Field title="每日观看上限（分钟）"><Input aria-label="每日观看上限" type="number" min={1} step={1} value={draft.unlimitedMinutes ? '' : draft.dailyMinutes} placeholder={draft.unlimitedMinutes ? '不限；输入分钟数可设置上限' : '正整数分钟数'} onChange={event => edit({ dailyMinutes: event.target.value, ...(event.target.value !== '' ? { unlimitedMinutes: false } : {}) })} /></Field>
      <div className="switch-row"><span>不限每日模型请求次数</span><Switch label="不限每日模型请求次数" checked={draft.unlimitedRequests} onChange={value => edit({ unlimitedRequests: value }, { immediate: true })} /></div>
      <Field title="每日模型请求上限"><Input aria-label="每日观看模型请求上限" type="number" min={1} step={1} value={draft.unlimitedRequests ? '' : draft.dailyRequests} placeholder={draft.unlimitedRequests ? '不限；输入次数可设置上限' : '正整数次数'} onChange={event => edit({ dailyRequests: event.target.value, ...(event.target.value !== '' ? { unlimitedRequests: false } : {}) })} /></Field>
    </details>
    <AutoSaveStatus status={form.status} />
    {children}
  </Panel>;
}

function AudioPanel({ state, api, run, busy, bridge, operationActive }) {
  const read = value => ({ enabled: value?.enabled === true, backend: value?.backend || 'local-whisper' });
  const form = useAutoSave({ value: state, initial: read(null), read, encode: value => value, write: value => api('/api/media/configure', value), canonical: (saved, payload) => typeof saved?.enabled === 'boolean' ? read(saved) : payload, available: Boolean(state) });
  const [mediaKey, setMediaKey] = useState(''), [keyNote, setKeyNote] = useState(''), [keyError, setKeyError] = useState('');
  const keyValue = useRef(''), writing = useRef(false), backend = form.draft.backend, info = state?.backends?.[backend] || state?.providers?.[backend];
  async function saveKey() {
    if (operationActive || !keyValue.current.trim() || writing.current) return;
    const secret = keyValue.current; writing.current = true; setKeyNote('正在保存…'); setKeyError('');
    try { await saveNativeMediaKey(bridge, { backend, apiKey: secret }); if (keyValue.current === secret) { keyValue.current = ''; setMediaKey(''); } setKeyNote('共享音频 Key 已保存；不会自动开启音频。'); }
    catch (error) { setKeyNote(''); setKeyError(`${error.message || 'Key 未保存。'} 输入已保留。`); }
    finally { writing.current = false; }
  }
  return <Panel title="音频理解" badge={<Tag>{state?.enabled ? '已开启' : '已关闭'}</Tag>}>
    <div className="switch-row"><span>读取视频声音</span><Switch label="读取视频声音" checked={form.draft.enabled} onChange={value => form.edit({ enabled: value }, { immediate: true })} /></div>
    <Field title="音频后端"><select aria-label="音频后端" value={backend} onChange={event => { form.edit({ backend: event.target.value }, { immediate: true }); keyValue.current = ''; setMediaKey(''); setKeyNote(''); }}><option value="local-whisper">本机 Whisper</option><option value="mimo">MiMo</option><option value="minimax">MiniMax</option></select></Field>
    <AutoSaveStatus status={form.status} />
    {backend !== 'local-whisper' && <Field title={`${backend === 'mimo' ? 'MiMo' : 'MiniMax'} API Key`}><Input aria-label={`${backend === 'mimo' ? 'MiMo' : 'MiniMax'} API Key`} type="password" autoComplete="off" maxLength={4096} value={mediaKey} disabled={operationActive || !bridge?.saveMediaKey} onChange={event => { keyValue.current = event.target.value; setMediaKey(event.target.value); setKeyNote(''); }} onBlur={() => { void saveKey(); }} placeholder={info?.available ? '留空沿用现有 API Key' : '输入后自动保存'} /></Field>}
    {keyNote && <p role="status">{keyNote}</p>}{keyError && <Note error>{keyError}</Note>}
    {info?.available === false && <Note>所选后端尚未就绪。</Note>}
  </Panel>;
}

function FriendInteractionPanel({ state, interactions, share, api, run, busy, configured, connected = true }) {
  const [contacts, setContacts] = useState(null), [discovery, setDiscovery] = useState(null), [switchError, setSwitchError] = useState(''), [switchStatus, setSwitchStatus] = useState('');
  const changing = useRef(false), pending = useRef(null), existingAuthorization = useRef(false), enabled = interactions?.policy?.enabled === true;
  const friend = interactions?.friend;
  const read = snapshot => ({ recipientIds: (snapshot?.policy?.allowlist || []).map(item => item.id), allowConversationOnly: existingAuthorization.current || (snapshot?.policy?.allowlist || []).some(item => ['existing-conversation', 'existing-group'].includes(item.authorizationKind)), groupMentionNamesText: (snapshot?.policy?.groupMentionNames || ['大肥鱼']).join('\n') });
  const encode = draft => ({ recipientIds: draft.recipientIds, allowConversationOnly: draft.allowConversationOnly, groupMentionNames: draft.groupMentionNamesText.split(/[,，\n]/).map(item => item.trim()).filter(Boolean) });
  const form = useAutoSave({ value: state, initial: read(null), read, encode, write: payload => api('/api/chat/configure', payload), canonical: (saved, payload) => saved?.policy ? encode(read(saved)) : payload, available: connected });
  const { draft, edit } = form;
  const shownContacts = [...new Map([...(state?.policy?.allowlist || []).map(contact => ({ ...contact, notListed: Boolean(contacts) && !contacts.some(item => item.id === contact.id) })), ...(contacts || [])].map(contact => [contact.id, contact])).values()];
  const showAuthorization = contacts?.some(contact => contact.isGroup !== false || contact.relationshipStatus === 'unavailable' ||
    contact.relationshipStatus === 'unverified' && contact.manualAuthorizationEligible === true);
  const canSelectContact = contact => typeof contact.isGroup === 'boolean' && (
    contact.isGroup === false && contact.followed === true ||
    draft.allowConversationOnly && (contact.manualAuthorizationEligible ?? (contact.relationshipStatus !== 'unverified'))
  );
  useEffect(() => { if (pending.current !== null && enabled === pending.current) { pending.current = null; setSwitchStatus(''); } }, [enabled]);
  async function toggle(value) {
    if (changing.current) return; changing.current = true; pending.current = value; setSwitchError(''); setSwitchStatus('正在更新好友互动…');
    try { await api('/api/interactions/configure', { enabled: value }); if (pending.current !== null) setSwitchStatus('等待状态同步…'); }
    catch (error) { pending.current = null; setSwitchStatus(''); setSwitchError(error.message || '好友互动设置未生效。'); }
    finally { changing.current = false; }
  }
  async function load() { const value = await api('/api/chat/contacts'); if (value.blocked || value.loginRequired || value.verificationRequired) throw new Error('请在专用浏览器完成登录或验证。'); if (!Array.isArray(value.contacts)) throw new Error('未读到可靠联系人列表，保留原许可名单。'); setContacts(value.contacts); setDiscovery(value.listDiscovery || null); }
  return <Panel title="好友互动" badge={<Tag>{connected ? interactions?.presence?.label || (interactions?.friend?.replyRunning || state?.running ? '回复进程已启动' : enabled ? '等待就绪' : '已关闭') : '状态待核实'}</Tag>}>
    <div className="switch-row"><span>允许好友互动</span><Switch label="允许好友互动" checked={enabled} disabled={!connected || typeof interactions?.policy?.enabled !== 'boolean' || changing.current} onChange={value => { void toggle(value); }} /></div>
    {switchStatus && <p role="status">{switchStatus}</p>}{switchError && <Note error>{switchError}</Note>}
    {!configured && <Note>请先配置模型。</Note>}
    {friend?.waitReason ? <Note error={Boolean(friend.lastError)}>{friend.waitReason}</Note> : friend?.lastError && <Note error>{friend.lastError}</Note>}
    {friend?.waitReason && <div className="actions"><Button size="sm" variant="outline" disabled={!connected || busy.has('chatPrepare') || friend.canPrepare === false} onClick={() => { void run('chatPrepare', () => api('/api/chat/prepare', {})); }}>{busy.has('chatPrepare') || friend.preparing ? '正在准备…' : '准备回复通道'}</Button></div>}
    <Button size="sm" variant="outline" disabled={!connected || busy.has('chatList') || form.status.kind === 'saving'} onClick={() => { void run('chatList', load); }}>读取联系人与群聊</Button>
    <Button size="sm" variant="outline" disabled={!connected || busy.has('chatList') || form.status.kind === 'saving'} onClick={() => { void run('chatList', async () => { await api('/api/browser/open', {}); await new Promise(resolve => setTimeout(resolve, 1200)); await load(); }); }}>重新连接专用浏览器并重试</Button>
    {discovery?.scannedToEnd === false && <p className="notice" role="status" title={discovery.reason}>会话列表未读完整。</p>}
    {showAuthorization && <label className="contact-authorization"><input type="checkbox" aria-label="授权已核对的现有会话" checked={draft.allowConversationOnly} onChange={event => { const value = event.target.checked; existingAuthorization.current = value; edit({ allowConversationOnly: value, ...(!value ? { recipientIds: draft.recipientIds.filter(id => shownContacts.some(contact => contact.id === id && contact.followed === true && contact.isGroup === false)) } : {}) }, value ? { blurOnly: true } : { immediate: true }); }} />授权已核对的现有会话</label>}
    <div className="contact-list">{[false, true, null].map(kind => { const items = shownContacts.filter(contact => contact.isGroup === kind || kind === null && typeof contact.isGroup !== 'boolean'); return items.length ? <React.Fragment key={String(kind)}><h3>{kind === false ? '个人会话' : kind === true ? '群聊 · @ 或昵称触发' : '待核对会话'}</h3>{items.map(contact => <label key={contact.id}><input type="checkbox" aria-label={`许可联系人 ${contactName(contact)}`} checked={draft.recipientIds.includes(contact.id)} disabled={!connected || !draft.recipientIds.includes(contact.id) && (contact.notListed || !canSelectContact(contact))} onChange={event => edit({ recipientIds: event.target.checked ? [...draft.recipientIds, contact.id] : draft.recipientIds.filter(id => id !== contact.id) }, { immediate: true })} />{contactName(contact)}</label>)}</React.Fragment> : null; })}{contacts && !shownContacts.length && <p className="muted">未读到会话。</p>}</div>
    <Field title="群聊响应昵称（逗号或换行分隔）"><textarea aria-label="群聊响应昵称" value={draft.groupMentionNamesText} onChange={event => edit({ groupMentionNamesText: event.target.value }, { blurOnly: true })} onBlur={() => { void form.flush(); }} rows={2} /></Field>
    <AutoSaveStatus status={form.status} />
    <SettingsUsage label="今日互动用量" items={[
      ['回复模型请求', usageCount(state?.daily?.requests)], ['分享尝试', usageCount(share?.daily?.attempts)]
    ]} />
    {(state?.contacts || []).filter(item => item.identityReviewRequired === true || item.recovery?.requiresUserAction === true || /登录|验证码|未授权|许可.*(?:不足|失效|撤销)|身份.*(?:变化|不一致|未通过|不明|不足)/.test(item.reason || '') || ['paused', 'delivery-uncertain'].includes(item.status) && !(item.recovery?.autoPendingCount > 0 || item.recovery?.autoRetryCount > 0)).map(item => <div className="paused-contact" key={item.id}><strong>{contactName(state?.policy?.allowlist?.find(contact => contact.id === item.id))}</strong><p>{item.reason || '该会话暂缓处理，状态会继续更新。'}</p>{item.identityReviewRequired === true && <p>请重新读取联系人并确认许可名单；身份未通过前不会发送。</p>}</div>)}
    <ShareReceipts state={share} api={api} run={run} busy={busy} connected={connected} />
    <details><summary>回复处理记录</summary><Data value={{ recovery: state?.recovery, contacts: (state?.contacts || []).map(item => ({ recovery: item.recovery, reason: item.reason, name: contactName(state?.policy?.allowlist?.find(contact => contact.id === item.id)), status: item.status, pending: Boolean(item.pending), unanswered: item.unanswered?.length || 0 })), events: state?.events || [] }} /></details>
  </Panel>;
}

function ForwardPanel({ api, run, busy, allowed, running, suggestedUrl }) {
  const [contacts, setContacts] = useState([]), [recipient, setRecipient] = useState(''), [url, setUrl] = useState(''), [notice, setNotice] = useState(''), [locked, setLocked] = useState(false);
  const gate = useRef(createForwardGate());
  useEffect(() => { if (suggestedUrl && !gate.current.locked) setUrl(suggestedUrl); }, [suggestedUrl]);
  async function load() { const value = await api('/api/forward/contacts'); if (value.blocked || value.loginRequired || value.verificationRequired) throw new Error('请在专用浏览器完成登录或验证。'); setContacts(value.contacts || []); }
  async function forward(event) {
    event.preventDefault(); if (!recipient || !allowed || running || busy.has('forward')) return;
    gate.current.take(event.nativeEvent); setLocked(true); setNotice('正在核对好友与作品，请等待结果。');
    try { const result = await api('/api/forward', { recipientId: recipient, ...(url.trim() ? { url: url.trim() } : {}) }); setNotice(result.confirmed === true ? '已回读确认：作品卡片已发给所选好友。' : '尚未确认送达，请在抖音人工核对；本次不会自动重发。'); }
    catch (error) { setNotice('未取得送达确认，请先在抖音人工核对；不会自动重试。'); throw error; }
  }
  return <Panel title="转发作品给好友">
    <Button size="sm" variant="outline" disabled={busy.has('forwardList') || locked} onClick={() => { void run('forwardList', load); }}>读取许可好友</Button>
    <form onSubmit={event => { void run('forward', () => forward(event)); }}>
      <Field title="收件人"><select aria-label="转发收件人" value={recipient} disabled={locked} onChange={event => setRecipient(event.target.value)} required><option value="">请选择一位好友</option>{contacts.map(contact => <option value={contact.id} key={contact.id}>{contactName(contact)}</option>)}</select></Field>
      <Field title="抖音作品链接" hint="留空时转发专用浏览器当前作品。"><Input aria-label="转发作品链接" value={url} disabled={locked} onChange={event => setUrl(event.target.value)} maxLength={2048} placeholder="https://www.douyin.com/video/…" /></Field>
      <Button variant="primary" type="submit" disabled={!recipient || !allowed || running || locked || busy.has('forward')}>确认转发给所选好友</Button>
    </form>
    {notice && <Note>{notice}</Note>}
    {locked && !busy.has('forward') && <Button size="sm" onClick={event => { gate.current.reset(event.nativeEvent); setLocked(false); setRecipient(''); setUrl(''); setNotice('请重新选择作品和好友。'); }}>已人工核对，重新选择</Button>}
  </Panel>;
}

function BrowserPanel({ browser, onPick, manualForward = true }) {
  if (!browser) return <Panel title="专用浏览器"><Note>首次视频任务会打开专用浏览器。登录和验证码请在浏览器内手动完成。</Note></Panel>;
  const video = browser.video;
  return <Panel title="专用浏览器" badge={<Tag>{video?.paused === true ? '已暂停' : video?.paused === false ? '播放中' : '已连接'}</Tag>}>
    {video && <><strong>{video.title || '当前作品'}</strong><p className="muted">{video.author || '作者未读取'}{Number.isFinite(video.time) ? ` · ${Math.round(video.time)} 秒` : ''}</p>{manualForward && <Button size="sm" onClick={() => onPick(video.url || browser.url)}>选择此作品转发</Button>}</>}
    {(browser.loginRequired || browser.verificationRequired) && <Note error>请在专用浏览器手动完成{browser.loginRequired ? '登录' : '验证'}。</Note>}
    {(browser.searchResults || []).slice(0, 8).map((item, index) => manualForward ? <button type="button" className="result-link" key={item.url || index} onClick={() => onPick(item.url)}>{index + 1}. {item.title || item.text || '公开作品'}</button> : <p className="muted" key={item.url || index}>{index + 1}. {item.title || item.text || '公开作品'}</p>)}
    <Data label="浏览器回读" value={browser} />
  </Panel>;
}

function EventItem({ event }) {
  const [open, setOpen] = useState(false);
  const data = event.result ?? event.args;
  return <div className="event-row"><DisclosureRow icon={<StateDot state={event.type?.endsWith('error') || event.type?.endsWith('failed') ? 'error' : event.type?.endsWith('start') ? 'ongoing' : 'done'} />} title={EVENT_LABELS[event.type] || event.type || '运行记录'} open={open} expandable={data !== undefined} onToggle={() => setOpen(value => !value)} expandOnRowClick collapsedContent={<span className="event-tool">{event.tool || event.message || ''}</span>}>
    {event.message && <p className="event-message">{event.message}</p>}{data !== undefined && <Data label={event.result ? '工具返回' : '工具参数'} value={data} />}
  </DisclosureRow></div>;
}

function MemoryView({ api, run, settings, bridge, busy, persona, onPersona, personaAvailable, watchState, watchReady }) {
  const [query, setQuery] = useState(''), [result, setResult] = useState(null);
  return <div className="memory-view"><div className="section-heading"><h1>共享记忆</h1></div><div className="actions"><Button size="sm" variant="outline" title={settings.memoryFolder} disabled={!settings.memoryFolder || !bridge?.openMemoryFolder} onClick={() => { void run('openMemory', () => bridge.openMemoryFolder()); }}>打开记忆文件夹</Button></div>
    <form className="memory-search" onSubmit={event => { event.preventDefault(); if (!query.trim()) return; void run('memory', async () => setResult((await api(`/api/memory?query=${encodeURIComponent(query.trim())}`)).result)); }}><Input aria-label="检索共享记忆" placeholder="搜索视频笔记、偏好或聊天内容" maxLength={300} value={query} onChange={event => setQuery(event.target.value)} /><Button type="submit" variant="primary" disabled={!query.trim() || busy.has('memory')}>检索记忆</Button></form>
    {result?.error && <Note error>{result.error}</Note>}{result && !(result.entries || []).length && <Note>没有找到相关记忆，可以换个关键词。</Note>}
    {(result?.entries || []).map((entry, index) => <article className="memory-entry" key={entry.id || index}><small>{entry.status === 'observed-history' ? '聊天历史，未确认为偏好' : entry.origin === 'video' ? '视频笔记' : '已有记忆'}</small><p>{entry.content}</p></article>)}{result && <Data label="查看来源与连接结果" value={result} />}
    {personaAvailable && <PersonaPanel snapshot={persona} onSnapshot={onPersona} api={api} run={run} bridge={bridge} busy={busy} watchState={watchState} watchReady={watchReady} />}
  </div>;
}

export function App() {
  const [client] = useState(() => createApiClient()), bridge = globalThis.window?.douyinDesktop;
  const [settings, setSettings] = useState(() => publicSettings()), [settingsOpen, setSettingsOpen] = useState(false), [boot, setBoot] = useState(null), [connected, setConnected] = useState(false);
  const [video, setVideo] = useState(null), [audio, setAudio] = useState(null), [chat, setChat] = useState(null), [browser, setBrowser] = useState(null);
  const [watch, setWatch] = useState(null), [watchSynced, setWatchSynced] = useState(false), [persona, setPersona] = useState(null);
  const [taskLimits, setTaskLimits] = useState(null), [share, setShare] = useState(null);
  const [reactions, setReactions] = useState(null);
  const [mode, setMode] = useState(null), [comments, setComments] = useState(null), [connectionError, setConnectionError] = useState('');
  const [browserMode, setBrowserMode] = useState(null);
  const [tasks, setTasks] = useState([]), [selectedTask, setSelectedTask] = useState(null), [events, setEvents] = useState([]), [running, setRunning] = useState(false), [instruction, setInstruction] = useState('');
  const [schedule,setSchedule]=useState(null),[interactions,setInteractions]=useState(null),[updatesOpen,setUpdatesOpen]=useState(false),[reviewOpen,setReviewOpen]=useState(false);
  const [view, setView] = useState('settings'), [settingsCategory, setSettingsCategory] = useState('基础设置'), [rightOpen, setRightOpen] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(new Set()), [suggestedUrl, setSuggestedUrl] = useState('');
  const [operationErrors, setOperationErrors] = useState({}), [pollError, setPollError] = useState('');
  const [verificationStatus, setVerificationStatus] = useState(null);
  const [verificationRequired, setVerificationRequired] = useState(false);
  const [verificationReady, setVerificationReady] = useState(false);
  const verificationGeneration = useRef(0);
  const lock = useRef(new Set()), revision = useRef(0), bootRef = useRef(null), currentTask = useRef(null), pollRef = useRef(null), submitLock = useRef(false), restoredSelection = useRef(false);
  const configured = settings.configured && boot?.config?.configured === true;
  const allowed = boot?.videoTime?.enabled !== true || video?.allowed === true;
  const watchActive = watchIsActive(watch), watchReady = boot?.watch?.available !== true || watchSynced;
  const manualBusy = running || busy.has('task') || busy.has('forward') || share?.busy === true;
  const operationActive = manualBusy || watchActive || comments?.busy || busy.has('watchStart') || busy.has('chatStart') || chat?.starting || chat?.busy;
  const run = useCallback(async (name, action) => {
    if (lock.current.has(name)) return;
    lock.current.add(name); setBusy(new Set(lock.current));
    setOperationErrors(old => { const next = { ...old }; delete next[name]; return next; });
    try { const result = await action(); await pollRef.current?.(); return result; }
    catch (failure) { const detail = requestFailure(failure, operationLabel(name)); setOperationErrors(old => ({ ...old, [name]: { message: detail.message, requestError: detail.requestError === true, unconfirmed: detail.unconfirmed === true, retry: action } })); }
    finally { lock.current.delete(name); setBusy(new Set(lock.current)); }
  }, []);
  useEffect(() => {
    let alive = true, polling = false, checkingVerification = false, ticks = 0;
    async function poll() {
      if (!alive || polling) return; polling = true;
      try {
        if (!bootRef.current || ticks++ % 5 === 0) {
          const value = await client.bootstrap(); if (!alive) return;
          if (value.sessionChanged) {
            revision.current = 0; currentTask.current = null; setEvents([]); setWatchSynced(false);
            verificationGeneration.current++; setVerificationRequired(false); setVerificationReady(false); setVerificationStatus(null);
          }
          bootRef.current = value; setBoot(value);
          if (bridge?.readBrowserVerificationStatus && !checkingVerification && !lock.current.has('browserVerification') && document.visibilityState !== 'hidden') {
            checkingVerification = true;
            const generation = verificationGeneration.current;
            void bridge.readBrowserVerificationStatus().then(state => {
              if (!alive || generation !== verificationGeneration.current) return;
              if (typeof state.required === 'boolean') setVerificationRequired(state.required);
              setVerificationReady(state.status === 'ready' && state.required === false);
              setVerificationStatus(previous => {
                if (!previous || ['opening', 'opened', 'rechecking'].includes(previous)) return previous;
                if (state.status === 'browser-unavailable') return 'browser-unavailable';
                if (state.status === 'required') return state.required === false ? 'login-required' : 'required';
                if (state.status === 'ready' && state.required === false && previous !== 'verified') return 'ready';
                return previous;
              });
            }).catch(() => {}).finally(() => { checkingVerification = false; });
          }
          if (bridge?.getSettings) { const value = await bridge.getSettings(); if (!alive) return; setSettings(publicSettings(value)); }
        }
        const value = await client.request(`/api/state?since=${revision.current}`); if (!alive) return;
        setConnected(true); setConnectionError(''); setRunning(value.running === true); submitLock.current = value.running === true;
        if (value.task?.id) {
          currentTask.current = value.task.id;
          setTasks(old => { const found = old.find(item => item.id === value.task.id); return [{ ...found, ...value.task }, ...old.filter(item => item.id !== value.task.id)].slice(0, 30); });
          if (!restoredSelection.current) { restoredSelection.current = true; setSelectedTask(value.task.id); }
        }
        setEvents(old => mergeEvents(old, value.events, currentTask.current)); revision.current = value.revision || revision.current;
        if (value.browser) setBrowser(value.browser);
        const reads = [
          ['/api/watch/schedule', setSchedule], ['/api/interactions/state', setInteractions],
          bootRef.current.videoTime?.enabled && ['/api/video/status', setVideo], ['/api/task/limits', setTaskLimits],
          bootRef.current.mode?.available && ['/api/mode/state', setMode],
          bootRef.current.browserMode?.available && ['/api/browser/mode', setBrowserMode],
          bootRef.current.reactions?.available && ['/api/reactions/state', setReactions],
          bootRef.current.comments?.available && ['/api/comments/state', setComments], ['/api/chat/state', setChat],
          bootRef.current.media?.available && ['/api/media/state', setAudio],
          bootRef.current.watch?.available && ['/api/watch/state', setWatch],
          bootRef.current.share?.available && ['/api/share/state', setShare],
          bootRef.current.persona?.available && ['/api/persona', setPersona]
        ].filter(Boolean);
        const results = await Promise.allSettled(reads.map(async ([route, setter]) => { try { const state = await client.request(route); if (alive) { setter(state); if (route === '/api/watch/state') setWatchSynced(true); } } catch (failure) { if (alive && route === '/api/watch/state') setWatchSynced(false); if (alive && ['/api/interactions/state', '/api/chat/state', '/api/watch/state', '/api/share/state', '/api/watch/schedule', '/api/mode/state', '/api/browser/mode', '/api/comments/state', '/api/reactions/state'].includes(route)) setter(null); throw failure; } }));
        if (alive) setPollError(results.filter(item => item.status === 'rejected').map(item => item.reason.message).join(' '));
      } catch (failure) { if (alive) { setConnected(false); setWatchSynced(false); setMode(null); setBrowserMode(null); setComments(null); setPollError(''); bootRef.current = null; setConnectionError(failure.message || '正在重新连接本机服务。'); } }
      finally { polling = false; }
    }
    pollRef.current = poll; void poll(); const timer = setInterval(() => { void poll(); }, 1500);
    return () => { alive = false; clearInterval(timer); pollRef.current = null; };
  }, [client, bridge]);
  const api = (route, body) => client.request(route, body);
  const openDouyin = () => { void run('browserOpen', () => api('/api/browser/open', {})); };
  const verificationAvailable = typeof bridge?.openBrowserVerification === 'function' && typeof bridge?.checkBrowserVerification === 'function';
  const verifyBrowser = check => {
    void run('browserVerification', async () => {
      const generation = ++verificationGeneration.current;
      setVerificationReady(false);
      setVerificationStatus(check ? 'rechecking' : 'opening');
      try {
        const state = await (check ? bridge.checkBrowserVerification() : bridge.openBrowserVerification());
        if (generation !== verificationGeneration.current) return;
        if (typeof state.verificationRequired === 'boolean') setVerificationRequired(state.verificationRequired);
        setVerificationReady((state.status === 'ready' || state.status === 'verified') && state.verificationRequired === false);
        setVerificationStatus(state.status === 'required' && state.verificationRequired === false ? 'login-required' : state.status);
      } catch (failure) {
        if (generation === verificationGeneration.current) setVerificationStatus(null);
        throw failure;
      }
    });
  };
  const showSettings = !settings.configured || settingsOpen;
  const verificationDisabled = !connected || busy.has('browserVerification');
  const noBrowser = interactions?.friend?.lastErrorCode === 'BROWSER_NOT_RUNNING' && browserMode?.running === false;
  const verificationNotice = verificationStatus || (noBrowser ? 'browser-unavailable' : null);
  const preparingReply = busy.has('chatPrepare') || interactions?.friend?.preparing;
  const canPrepareReply = interactions?.friend?.canPrepare === true;
  const prepareReply = () => {
    void run('chatPrepare', async () => {
      try { await api('/api/chat/prepare', {}); }
      finally { verifyBrowser(true); }
    });
  };
  const verificationButton = verificationAvailable && <Button size="sm" variant="outline" className="verification-button" disabled={verificationDisabled} title={verificationRequired ? '抖音需要安全验证' : undefined} onClick={() => verifyBrowser(false)}>
    辅助验证{verificationRequired && <span className="verification-dot" aria-hidden="true" />}
  </Button>;
  const verificationFeedback = verificationAvailable && VERIFICATION_STATUS_TEXT[verificationNotice] && <div className="verification-status">
    <span role="status">{VERIFICATION_STATUS_TEXT[verificationNotice]}</span>
    {verificationNotice === 'browser-unavailable' && (canPrepareReply || preparingReply) &&
      <Button size="sm" variant="outline" disabled={verificationDisabled || preparingReply} onClick={prepareReply}>{preparingReply ? '正在准备…' : '准备回复通道'}</Button>}
    {verificationNotice === 'browser-unavailable' && !canPrepareReply && !preparingReply && (browserMode?.mode === 'background'
      ? <span>在「视频观看」关闭后台观看后，可以打开抖音。</span>
      : <Button size="sm" variant="outline" disabled={verificationDisabled || busy.has('browserOpen')} onClick={openDouyin}>打开抖音</Button>)}
    {['required', 'login-required', 'session-changed'].includes(verificationNotice) &&
      <Button size="sm" variant="outline" disabled={verificationDisabled} onClick={() => verifyBrowser(false)}>辅助验证</Button>}
    {['opened', 'checking'].includes(verificationNotice) &&
      <Button size="sm" variant="outline" disabled={verificationDisabled} onClick={() => verifyBrowser(true)}>检查验证</Button>}
  </div>;
  async function submit(event) {
    event.preventDefault(); if (submitLock.current || watchActive || share?.busy || !watchReady || lock.current.has('watchStart') || !configured || !allowed || !connected || !instruction.trim() || busy.has('forward')) return;
    submitLock.current = true;
    await run('task', async () => {
      try { const result = await api('/api/task', { instruction: instruction.trim() }); currentTask.current = result.id; setSelectedTask(result.id); setView('chat'); setTasks(old => [{ id: result.id, instruction: instruction.trim(), status: 'running' }, ...old]); setInstruction(''); setRunning(true); }
      catch (failure) { submitLock.current = false; throw failure; }
    });
  }
  async function saved(value) { setSettings(publicSettings(value)); bootRef.current = null; await pollRef.current?.(); }
  function pick(url) { if (!/^https:\/\/(?:www\.)?douyin\.com\/video\/\d+\/?$/.test(url || '')) { setError('当前作品链接尚未核实，请使用公开作品地址。'); return; } setSuggestedUrl(url); setRightOpen(true); }
  const task = tasks.find(item => item.id === selectedTask), selectedEvents = events.filter(item => !task || item.taskId === task.id);
  const answer = task?.message || selectedEvents.filter(item => item.type === 'model.answer').at(-1)?.message;
  const stopWatch = () => { void run('watchSchedule', () => api('/api/watch/schedule', { enabled: false })); };

  const viewingModes = (boot?.mode?.available || boot?.browserMode?.available) && <ViewingModePanel
    state={mode} browserMode={browserMode} setBrowserMode={setBrowserMode} silentAvailable={boot?.mode?.available === true}
    backgroundAvailable={boot?.browserMode?.available === true} connected={connected} api={api} />;
  const settingsPage = <div className="settings-page">
    <div role="tablist" aria-label="刷抖音设置分类" className="settings-tabs">
      {Object.keys(SETTINGS_SECTIONS).map(name => <Button key={name} role="tab" aria-selected={settingsCategory === name} size="sm" variant="outline" onClick={() => setSettingsCategory(name)}>{name}</Button>)}
    </div>
    {settingsCategory === '基础设置' && <>
      <Panel title="模型设置">
        <div className="model-setting">
          <div><strong>{configured ? settings.model : '尚未配置模型'}</strong></div>
          <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>配置模型与 API Key</Button>
        </div>
      </Panel>
      <PersonaPanel snapshot={persona} onSnapshot={setPersona} api={api} run={run} bridge={bridge} busy={busy} watchState={watch} watchReady={watchReady} />
      <details><summary>检索共享记忆</summary><MemoryView settings={settings} api={api} run={run} busy={busy} bridge={bridge} /></details>
    </>}
    {settingsCategory === '视频观看' && <>
      <VideoPanel state={video} schedule={schedule} watch={watch} api={api} busy={busy} connected={connected} configured={configured}
        browserMode={browserMode} onOpenBrowser={openDouyin} onDiagnostics={() => setSettingsCategory('自检与用量')}
        onReviewComments={() => setSettingsCategory('公开评论')}
        verification={{ available: verificationAvailable, ready: verificationReady, required: verificationRequired, disabled: verificationDisabled, start: verifyBrowser,
          canCheck: ['opened', 'required', 'login-required'].includes(verificationStatus) }}>
        {viewingModes}
      </VideoPanel>
      <TopicPanel state={watch?.options} active={watchActive} api={api} run={run} busy={busy} connected={connected && watchReady} />
      <TaskBudgetPanel state={taskLimits} api={api} run={run} busy={busy} operationActive={operationActive} />
    </>}
    {settingsCategory === '好友互动' && <FriendInteractionPanel state={chat} interactions={interactions} share={share} api={api} run={run} busy={busy} configured={configured} connected={connected} />}
    {settingsCategory === '公开评论' && <CommentsPanel reactions={reactions} state={comments} connected={connected} api={api} run={run} busy={busy} />}
    {settingsCategory === '音频与密钥' && <AudioPanel state={audio} api={api} run={run} busy={busy} bridge={bridge} operationActive={operationActive} />}
    {settingsCategory === '观看日报' && <ReportsView connected={connected} api={api} run={run} busy={busy} />}
    {settingsCategory === '自检与用量' && <HealthDashboard api={api} run={run} busy={busy} connected={connected} />}
  </div>;
  const showQuickControls = rightOpen && view !== 'settings';
  return <div className={`${frame.frame} app-frame${showQuickControls ? ' with-quick-controls' : ''}`}>
    <aside className={`${frame.sidebarCol} navigation`}><div className="brand"><div className="brand-icon"><img src={brandIcon} alt="大肥鱼图标" /></div><strong>大肥鱼</strong></div><Button variant="outline" className="new-task" onClick={() => { setSelectedTask(null); setView('chat'); }}>＋ 新任务</Button>
      <nav aria-label="主导航"><button className={view === 'chat' ? 'nav-link active' : 'nav-link'} onClick={() => setView('chat')}>◌ 对话与视频</button><button className={view === 'settings' ? 'nav-link active' : 'nav-link'} onClick={() => setView('settings')}>☷ 业务设置</button>{boot?.watch?.available && <button className={view === 'watch' ? 'nav-link active' : 'nav-link'} onClick={() => setView('watch')}>◉ 自主观看记录</button>}</nav>
      {tasks.length > 0 && <div className="sidebar-label">最近任务</div>}<div className="task-list">{tasks.map(item => <button className={item.id === selectedTask && view === 'chat' ? 'task-item selected' : 'task-item'} key={item.id} onClick={() => { setSelectedTask(item.id); setView('chat'); }}><span>{item.instruction || '视频任务'}</span><small>{statusLabel(item.status)}</small></button>)}</div>
      <div className="sidebar-bottom"><small className="software-version" title={`构建 ${__APP_BUILD_DATE__}`}>独立 API 版 · {__APP_VERSION__}</small><Button size="sm" disabled={busy.has('refresh')} onClick={() => { void run('refresh', async () => { bootRef.current = null; await pollRef.current?.(); }); }}>刷新连接</Button><button className="nav-link" onClick={() => setUpdatesOpen(true)}>检查更新</button>{!connected && <div className="connection"><StateDot state="warning" /><span>正在连接本机服务</span></div>}</div>
    </aside>
    <main className={`${frame.centerCol} main-column`}>
      <header className="topbar">
        <div className="page-context">
          <strong>{view === 'settings' ? '业务设置' : view === 'health' ? '自检与用量' : view === 'reports' ? '观看日报' : view === 'memory' ? '共享记忆与人格' : view === 'watch' ? '自主观看记录' : '对话与视频'}</strong>
        </div>
        <div className="actions">
          <FriendPresence presence={interactions?.presence} connected={connected} />
          {!showSettings && verificationButton}
          {!showSettings && <Button size="sm" variant="outline" disabled={!connected || busy.has('browserOpen')} onClick={openDouyin}>{busy.has('browserOpen') ? '正在打开抖音…' : '打开抖音'}</Button>}
          {view !== 'settings' && <Button size="sm" variant="outline" aria-expanded={showQuickControls} aria-controls="quick-controls" onClick={() => setRightOpen(open => !open)}>{showQuickControls ? '收起快捷控制' : '展开快捷控制'}</Button>}
        </div>
      </header>
    {!showSettings && verificationFeedback}
    {((share?.needsReview || []).length > 0 || share?.recoveryRequired) && <div className="global-error" role="alert"><span>分享送达尚未确认。</span><Button size="sm" variant="outline" onClick={() => setReviewOpen(true)}>查看分享收据</Button></div>}
      {(error || connectionError || pollError) && <div className="global-error" role="alert"><span>{[error, connectionError, pollError].filter(Boolean).join(' ')}</span><RecoveryActions busy={busy} connected={connected} message={[error, connectionError, pollError].filter(Boolean).join(' ')} onRetry={() => { void run('refresh', async () => { bootRef.current = null; await pollRef.current?.(); }); }} onHealth={() => { setSettingsCategory('自检与用量'); setView('settings'); }} onOpen={openDouyin} /><button aria-label="关闭提示" onClick={() => { setError(''); setConnectionError(''); setPollError(''); }}>×</button></div>}
      {Object.entries(operationErrors).map(([name, failure]) => <div className="global-error" role="alert" key={name}><span>{failure.requestError ? '上次操作：' : ''}{failure.message}{failure.requestError && connected ? failure.unconfirmed ? ' 本机服务当前已连接；请核对上述操作是否生效。' : ' 本机服务当前已连接。' : ''}</span><RecoveryActions busy={busy} connected={connected} message={failure.message} onRetry={failure.retry ? () => { void run(name, failure.retry); } : undefined} onHealth={() => { setSettingsCategory('自检与用量'); setView('settings'); }} onOpen={openDouyin} /><button aria-label={`清除${operationLabel(name)}提示`} onClick={() => setOperationErrors(old => { const next = { ...old }; delete next[name]; return next; })}>×</button></div>)}
      {boot?.watch?.available && !watchReady && <div className="watch-running-strip" role="status">自主观看状态尚未核实，请等待本机服务回读后再开始操作。</div>}
      {watchActive && <div className="watch-running-strip" role="status">自主观看进行中 · 今日已观看 {Math.floor(video?.daily?.usedSeconds || 0)} 秒 · 模型请求 {video?.daily?.requests || 0} 次</div>}
      {view === 'settings' ? settingsPage : view === 'health' ? <HealthDashboard api={api} run={run} busy={busy} connected={connected} /> : view === 'reports' ? <ReportsView connected={connected} api={api} run={run} busy={busy} /> : view === 'memory' ? <MemoryView api={api} run={run} settings={settings} bridge={bridge} busy={busy} persona={persona} onPersona={setPersona} personaAvailable={boot?.persona?.available} watchState={watch} watchReady={watchReady} /> : view === 'watch' ? <WatchView state={watch} video={video} browser={browser} snapshot={persona} onSettings={() => { setSettingsCategory('视频观看'); setView('settings'); }} /> :
        <div className={task ? 'task-workspace' : 'task-workspace empty-task'}>
          {!task ? <div className="welcome"><h1>想让大肥鱼看什么？</h1></div> :
            <div className="conversation" aria-live="polite"><div className="conversation-content">
              <div className="user-message">{task.instruction}</div>
              <div className="assistant-message">
                <div className="assistant-avatar"><img src={brandIcon} alt="" /></div>
                <div className="assistant-content">
                  {answer ? <MarkdownText text={answer} labels={MARKDOWN_LABELS} streaming={false} /> : <p className="muted">{running && task.id === currentTask.current ? '正在查看与操作专用浏览器…' : '还没有模型答复。'}</p>}
                  {task.partialMessage && <MarkdownText text={task.partialMessage} labels={MARKDOWN_LABELS} />}
                  {task.status && <small className="task-status">{statusLabel(task.status)}</small>}
                  <details className="activity" open={running && task.id === currentTask.current}>
                    <summary>运行过程 · {selectedEvents.length} 条</summary>
                    {selectedEvents.map(item => <EventItem key={item.revision} event={item} />)}
                  </details>
                </div>
              </div>
            </div></div>}
          <div className="composer-area">
            <form className="composer" onSubmit={submit}>
              <textarea aria-label="视频任务" placeholder={configured ? '贴一个抖音作品链接，或说说想看的主题…' : '先在设置中连接 API Key'} maxLength={4000} value={instruction} onChange={event => setInstruction(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit(); } }} />
              <div className="composer-footer">
                {running ? <Button variant="outline" disabled={busy.has('stop')} onClick={() => { void run('stop', () => api('/api/stop', {})); }}>■ 停止任务</Button> :
                  <Button variant="primary" className="task-submit" type="submit" disabled={watchActive || share?.busy || !watchReady || busy.has('watchStart') || !configured || !connected || !allowed || !instruction.trim() || busy.has('task') || busy.has('forward')}>开始任务 ↑</Button>}
              </div>
            </form>
            <div className="quick-actions" role="group" aria-label="视频任务快捷操作">
              {EXAMPLES.map(([label, value]) => <button key={label} type="button" onClick={() => setInstruction(value)}>{label}</button>)}
            </div>
            {watchActive && <p className="composer-hint">暂停自主观看后可开始任务。</p>}
            {!watchActive && watchReady && !allowed && <p className="composer-hint">{video?.reason || '当前不允许观看。'}</p>}
          </div>
        </div>}
    </main>
    {showQuickControls && <aside id="quick-controls" className="business-sidebar" aria-label="快捷控制"><div className="business-heading"><strong>快捷控制</strong><Button variant="outline" size="sm" aria-label="关闭快捷控制" onClick={() => setRightOpen(false)}>关闭</Button></div>{boot?.videoTime?.enabled ? <VideoPanel state={video} schedule={schedule} watch={watch} api={api} run={run} busy={busy} connected={connected} configured={configured}><TopicPanel state={watch?.options} active={watchActive} api={api} run={run} busy={busy} connected={connected && watchReady} />{viewingModes}</VideoPanel> : null}<TaskBudgetPanel state={taskLimits} api={api} run={run} busy={busy} operationActive={operationActive} /><BrowserPanel browser={browser} onPick={pick} manualForward={boot?.share?.available !== true} />{boot?.media?.available && <AudioPanel state={audio} api={api} run={run} busy={busy} bridge={bridge} operationActive={operationActive} />}{boot?.comments?.available && <CommentsPanel reactions={reactions} state={comments} connected={connected} api={api} run={run} busy={busy} />}<FriendInteractionPanel state={chat} interactions={interactions} share={share} api={api} run={run} busy={busy} configured={configured} connected={connected} /></aside>}
    {updatesOpen && <UpdateDialog bridge={bridge} operationActive={operationActive} onClose={()=>setUpdatesOpen(false)}/>}
    {reviewOpen && <ReviewDialog share={share} api={api} run={run} busy={busy} connected={connected} onClose={()=>setReviewOpen(false)}/>}
    {showSettings && <ApiSettings settings={settings} bridge={bridge} onSaved={saved} onClose={() => setSettingsOpen(false)} run={run} busy={busy.has('settings') || busy.has('clearKey')} operationActive={operationActive || !watchReady} watchActive={watchActive} onStopWatch={stopWatch} onOpenDouyin={openDouyin} openingDouyin={busy.has('browserOpen')} connected={connected} operationError={[error, connectionError, ...Object.values(operationErrors).map(item => item.message)].filter(Boolean).join(' ')} verificationButton={verificationButton} verificationFeedback={verificationFeedback} />}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
