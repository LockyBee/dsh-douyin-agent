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
import { createApiClient, publicSettings, saveNativeSettings, saveNativeMediaKey, createForwardGate, mergeEvents, watchIsActive, requestFailure, operationLabel } from './api.mjs';
import { WatchView, PersonaPanel } from './watch-persona.jsx';
import { TaskBudgetPanel } from './task-budget.jsx';
import { ShareReceipts } from './autonomous-share.jsx';
import { useAutoSave, AutoSaveStatus } from './use-auto-save.jsx';
import { SilentPanel, CommentsPanel, ReportsView } from './watch-settings.jsx';

const MARKDOWN_LABELS = { code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '注释' };
const EVENT_LABELS = { 'model.request': '请求模型', 'model.usage': '本次用量', 'model.answer': '模型答复', 'tool.start': '调用工具', 'tool.result': '工具返回', 'tool.error': '工具出错', 'task.started': '开始任务', 'task.completed': '任务完成', 'task.stopped': '任务停止', 'task.failed': '任务失败', 'task.limited': '达到限制', 'task.needs_user': '需要手动操作', 'video.started': '开始观看', 'video.limited': '视频时间已结束' };
const EXAMPLES = [['看推荐', '看看当前推荐视频，观察 3 秒，告诉我画面里发生了什么。'], ['搜索猫咪', '搜索猫咪，打开第一条作品并观察 3 秒，告诉我实际看到了什么。'], ['下一条', '切换下一条视频，读回切换是否成功，再观察 3 秒。'], ['上一条', '切换上一条视频，读回切换是否成功。'], ['暂停', '暂停当前视频，确认播放状态。'], ['播放', '播放当前视频，确认播放进度。']];
const truncated = total => `内容较长，当前展示前 20000 字符（共 ${total} 字符）。`;
const contactName = contact => contact?.name || contact?.displayName || '联系人';
const statusLabel = status => ({ completed: '已完成', running: '进行中', stopping: '正在停止', stopped: '已停止', failed: '未完成', limited: '已到限制', needs_user: '等待手动操作' }[status] || '准备中');

function Field({ title, hint, children }) { return <label className="field"><span>{title}</span>{children}{hint && <small>{hint}</small>}</label>; }
function Panel({ title, badge, children }) { return <section className="panel"><div className="panel-title"><h2>{title}</h2>{badge}</div>{children}</section>; }
function Note({ children, error = false }) { return <p className={error ? 'notice error' : 'notice'} role={error ? 'alert' : undefined}>{children}</p>; }
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
  return <div className="friend-presence" role="status" aria-live="polite" title={[reason, watch?.active ? watch.reason : ''].filter(Boolean).join(' ')} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
    <span aria-label="好友互动状态" title={reason} style={{ border: '1px solid currentColor', borderRadius: 20, padding: '6px 12px', whiteSpace: 'nowrap' }}>{reply?.online === true ? '●' : '○'} {label}</span>
    {watch?.active && <small role="status" aria-label="自主观看状态" title={watch.reason} style={{ whiteSpace: 'nowrap' }}>◉ {watch.label}</small>}
    {(status === 'attention' || status === 'preparing' || watch?.active && reply?.online !== true) && <small role={status === 'attention' ? 'alert' : 'status'} style={{ maxWidth: 220, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{reason}</small>}
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
    <Note>这些操作都在软件内完成，不需要去抖音逐条找。分享只能按回执事实选择；“统一未送达”不会重发这一条。</Note>
    {shareItems.length > 0 && <><h3>分享收据（{shareItems.length}）</h3>{shareItems.map(item => <div className="paused-contact" key={item.operationId}><strong>{nameOf(item.recipientId)} · 作品 {item.videoId}</strong><p>{statusOf(item.status)}</p>{item.failure?.message && <p className="notice">原因：{item.failure.message}</p>}<div className="actions"><Button size="sm" disabled={!connected || busy?.has(`shareResolve-${item.operationId}`)} onClick={() => { void resolveShare(item, 'confirmed'); }}>已确认送达</Button><Button size="sm" variant="outline" disabled={!connected || busy?.has(`shareResolve-${item.operationId}`)} onClick={() => { void resolveShare(item, 'not-sent'); }}>确认未送达</Button></div></div>)}<div className="actions"><Button size="sm" variant="outline" disabled={!connected || share?.busy} onClick={() => { void resolveAllNotSent(); }}>全部按未送达处理</Button></div></>}
    {share?.recoveryRequired && shareItems.length === 0 && <Note error>上次分享进程中断，没有可逐条核对的收据；先在“好友互动”重新开启分享会要求先处理这条恢复记录。</Note>}
    {!shareItems.length && !share?.recoveryRequired && <Note>目前没有待核对项。</Note>}
  </div></div>;
}

function ApiSettings({ settings, bridge, onSaved, onClose, run, busy, operationActive, onOpenDouyin, openingDouyin, connected, operationError }) {
  const [draft, setDraft] = useState({ apiKey: '', baseUrl: settings.baseUrl, model: settings.model, remember: settings.remember }), [failure, setFailure] = useState(''), [notice, setNotice] = useState('');
  const current = useRef(draft), version = useRef(0), dirty = useRef(false), writing = useRef(false), queued = useRef(false);
  useEffect(() => { if (!dirty.current) { const next = { apiKey: '', baseUrl: settings.baseUrl, model: settings.model, remember: settings.remember }; current.current = next; setDraft(next); } }, [settings.baseUrl, settings.model, settings.remember]);
  function edit(patch) { version.current++; dirty.current = true; current.current = { ...current.current, ...patch }; setDraft(current.current); setFailure(''); setNotice('离开输入框后自动保存。'); }
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
    <p className="muted">填写后离开输入框即可保存。软件独立运行，不需要启动 DSH。</p>
    <Button size="sm" variant="outline" onClick={onOpenDouyin} disabled={!connected || openingDouyin}>{openingDouyin ? '正在打开抖音…' : '打开抖音'}</Button>
    {operationError && <Note error>{operationError}</Note>}{operationActive && <Note>请先结束当前任务或等待互动处理完成。自主观看运行时，请先关闭允许自动观看。</Note>}
    <Field title="API Key" hint="Key 只通过桌面进程保存，不进入本机 HTTP 请求。"><Input aria-label="API Key" type="password" autoComplete="off" value={draft.apiKey} onChange={event => edit({ apiKey: event.target.value })} onBlur={() => { void save(); }} maxLength={4096} disabled={operationActive} placeholder={settings.configured ? '留空沿用现有 API Key' : ''} autoFocus /></Field>
    <details className="advanced"><summary>接口与模型</summary><Field title="API 地址"><Input aria-label="API 地址" value={draft.baseUrl} disabled={operationActive} onChange={event => edit({ baseUrl: event.target.value })} onBlur={() => { void save(); }} /></Field><Field title="模型名称"><Input aria-label="模型名称" value={draft.model} maxLength={120} disabled={operationActive} onChange={event => edit({ model: event.target.value })} onBlur={() => { void save(); }} /></Field></details>
    <div className="switch-row"><div><strong>记住 API Key</strong><small>关闭后仅在本次运行中使用。</small></div><Switch label="记住 API Key" checked={draft.remember} disabled={operationActive} onChange={value => { edit({ remember: value }); void save(); }} /></div>
    {failure && <Note error>{failure}</Note>}{notice && <p role="status">{notice}</p>}
    {settings.configured && <div className="actions"><Button onClick={onClose}>返回</Button><Button size="sm" disabled={busy || operationActive} onClick={() => { void run('clearKey', async () => onSaved(publicSettings(await bridge.clearApiKey()))); }}>清除已保存的 API Key</Button></div>}
    <div className="memory-location"><strong>与插件共用的记忆文件夹</strong><code>{settings.memoryFolder || '正在读取文件夹位置…'}</code><Button size="sm" variant="outline" disabled={!bridge?.openMemoryFolder || !settings.memoryFolder} onClick={() => { void run('openMemory', () => bridge.openMemoryFolder()); }}>打开记忆文件夹</Button></div>
  </section></div>;
}

function VideoPanel({ state, schedule, watch, api, run, busy, connected = true, configured = false, children }) {
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
  const { draft, edit } = form;
  const [toggleStatus, setToggleStatus] = useState(''), [toggleError, setToggleError] = useState('');
  const changing = useRef(false), pending = useRef(null), enabled = schedule?.policy?.enabled === true;
  const watchReady = connected && typeof schedule?.policy?.enabled === 'boolean' && typeof watch?.running === 'boolean', watching = watchIsActive(watch);
  useEffect(() => { if (pending.current !== null && enabled === pending.current) { pending.current = null; setToggleStatus('自动观看设置已生效。'); } }, [enabled]);
  async function toggle(value) {
    if (changing.current) return; changing.current = true; pending.current = value; setToggleError(''); setToggleStatus('正在更新自动观看…');
    try { const saved = await api('/api/watch/schedule', { enabled: value }); if (saved?.policy?.enabled === value) { pending.current = null; setToggleStatus(value ? '已允许观看，正在检查时段和每日预算。' : '已暂停观看。'); } else setToggleStatus('已提交，等待状态同步。'); }
    catch (error) { pending.current = null; setToggleStatus(''); setToggleError(error.message || '自动观看设置未生效。'); }
    finally { changing.current = false; }
  }
  return <Panel title="视频观看" badge={<Tag>{watch?.running ? '正在观看' : enabled ? '等待允许时段' : '已关闭'}</Tag>}>
    <div className="switch-row"><span>允许自动观看</span><Switch label="允许自动观看" checked={enabled} disabled={!connected || typeof schedule?.policy?.enabled !== 'boolean' || changing.current} onChange={value => { void toggle(value); }} /></div>
    <p className="notice">开启后，在允许时段内自动观看；离开时段或用完每日预算会停止。应用需保持运行。</p>
    <div className="actions"><Button size="sm" variant="primary" disabled={!watchReady || !configured || watching || schedule?.busy || changing.current} onClick={() => { void toggle(true); }}>开始自主观看</Button><Button size="sm" variant="outline" disabled={!watchReady || !enabled && !watching && !schedule?.busy || changing.current} onClick={() => { void toggle(false); }}>暂停观看</Button></div>
    <p className="notice">不在允许时段会等待；按钮与开关共用设置，每日已用时长和模型次数不会重置。</p>
    {toggleStatus && <p role="status">{toggleStatus}</p>}{toggleError && <Note error>{toggleError}</Note>}
    <div className="actions"><Button size="sm" type="button" onClick={() => edit({ windows: '00:00-09:00\n12:00-14:00\n18:00-24:00', weekendAll: true }, { immediate: true })}>谷时段（DeepSeek）</Button><Button size="sm" type="button" onClick={() => edit({ windows: '00:00-24:00', weekendAll: false }, { immediate: true })}>全天</Button><Button size="sm" type="button" onClick={() => edit({ windows: '20:00-22:00', weekendAll: false }, { immediate: true })}>晚间 20–22 点</Button></div>
    <div className="switch-row"><span>周末全天允许</span><Switch label="周末全天允许" checked={draft.weekendAll} onChange={value => edit({ weekendAll: value }, { immediate: true })} /></div>
    <Field title="每日允许时段 · 北京时间"><textarea aria-label="每日允许时段" rows={2} value={draft.windows} maxLength={220} onChange={event => edit({ windows: event.target.value })} /></Field>
    <details><summary>高级选项</summary>
      <div className="switch-row"><span>不限每日观看时长</span><Switch label="不限每日观看时长" checked={draft.unlimitedMinutes} onChange={value => edit({ unlimitedMinutes: value }, { immediate: true })} /></div>
      <Field title="每日观看上限（分钟）"><Input aria-label="每日观看上限" type="number" min={1} step={1} value={draft.unlimitedMinutes ? '' : draft.dailyMinutes} placeholder={draft.unlimitedMinutes ? '不限；输入分钟数可设置上限' : '正整数分钟数'} onChange={event => edit({ dailyMinutes: event.target.value, ...(event.target.value !== '' ? { unlimitedMinutes: false } : {}) })} /></Field>
      <div className="switch-row"><span>不限每日模型请求次数</span><Switch label="不限每日模型请求次数" checked={draft.unlimitedRequests} onChange={value => edit({ unlimitedRequests: value }, { immediate: true })} /></div>
      <Field title="每日模型请求上限"><Input aria-label="每日观看模型请求上限" type="number" min={1} step={1} value={draft.unlimitedRequests ? '' : draft.dailyRequests} placeholder={draft.unlimitedRequests ? '不限；输入次数可设置上限' : '正整数次数'} onChange={event => edit({ dailyRequests: event.target.value, ...(event.target.value !== '' ? { unlimitedRequests: false } : {}) })} /></Field>
    </details>
    <Note>请求上限按模型请求计，不是视频条数；同一视频多次采样、评论生成也计入，私信回复不占。</Note>
    <AutoSaveStatus status={form.status} />
    <Note>今日已观看 {Math.floor(state?.daily?.usedSeconds || 0)} 秒 · 已请求 {state?.daily?.requests || 0} 次模型。{state?.daily?.remainingSeconds === null ? '今日时长不限。' : Number.isFinite(state?.daily?.remainingSeconds) ? `今日剩余 ${Math.floor(state.daily.remainingSeconds)} 秒。` : ''}</Note>
    {state?.reason && <Note>{state.reason}</Note>}{schedule?.lastError && <Note error>{schedule.lastError}</Note>}{watch?.lastError && <p role="status">上次自主观看停止原因：{watch.lastError}</p>}
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
    {backend !== 'local-whisper' && <Field title={`${backend === 'mimo' ? 'MiMo' : 'MiniMax'} API Key`} hint="离开输入框后保存到本机共享媒体文件；不回显已有 Key。"><Input aria-label={`${backend === 'mimo' ? 'MiMo' : 'MiniMax'} API Key`} type="password" autoComplete="off" maxLength={4096} value={mediaKey} disabled={operationActive || !bridge?.saveMediaKey} onChange={event => { keyValue.current = event.target.value; setMediaKey(event.target.value); setKeyNote(''); }} onBlur={() => { void saveKey(); }} placeholder={info?.available ? '已配置；填写后替换' : '填写音频服务 API Key'} /></Field>}
    {keyNote && <p role="status">{keyNote}</p>}{keyError && <Note error>{keyError}</Note>}
    <Note>{info?.available === true ? '后端依赖已就绪。' : info?.available === false ? '所选后端尚未就绪。' : '后端可用性尚未确认。'}</Note>
  </Panel>;
}

function FriendInteractionPanel({ state, interactions, share, api, run, busy, configured, connected = true }) {
  const [contacts, setContacts] = useState(null), [discovery, setDiscovery] = useState(null), [switchError, setSwitchError] = useState(''), [switchStatus, setSwitchStatus] = useState('');
  const changing = useRef(false), pending = useRef(null), existingAuthorization = useRef(false), enabled = interactions?.policy?.enabled === true;
  const read = snapshot => ({ recipientIds: (snapshot?.policy?.allowlist || []).map(item => item.id), allowConversationOnly: existingAuthorization.current || (snapshot?.policy?.allowlist || []).some(item => ['existing-conversation', 'existing-group'].includes(item.authorizationKind)), groupMentionNamesText: (snapshot?.policy?.groupMentionNames || ['大肥鱼']).join('\n') });
  const encode = draft => ({ recipientIds: draft.recipientIds, allowConversationOnly: draft.allowConversationOnly, groupMentionNames: draft.groupMentionNamesText.split(/[,，\n]/).map(item => item.trim()).filter(Boolean) });
  const form = useAutoSave({ value: state, initial: read(null), read, encode, write: payload => api('/api/chat/configure', payload), canonical: (saved, payload) => saved?.policy ? encode(read(saved)) : payload, available: connected });
  const { draft, edit } = form;
  const shownContacts = [...new Map([...(state?.policy?.allowlist || []).map(contact => ({ ...contact, notListed: Boolean(contacts) && !contacts.some(item => item.id === contact.id) })), ...(contacts || [])].map(contact => [contact.id, contact])).values()];
  useEffect(() => { if (pending.current !== null && enabled === pending.current) { pending.current = null; setSwitchStatus('好友互动设置已生效。'); } }, [enabled]);
  async function toggle(value) {
    if (changing.current) return; changing.current = true; pending.current = value; setSwitchError(''); setSwitchStatus('正在更新好友互动…');
    try { await api('/api/interactions/configure', { enabled: value }); setSwitchStatus('已提交，等待状态同步。'); }
    catch (error) { pending.current = null; setSwitchStatus(''); setSwitchError(error.message || '好友互动设置未生效。'); }
    finally { changing.current = false; }
  }
  async function load() { const value = await api('/api/chat/contacts'); if (value.blocked || value.loginRequired || value.verificationRequired) throw new Error('请在专用浏览器完成登录或验证。'); if (!Array.isArray(value.contacts)) throw new Error('未读到可靠联系人列表，保留原许可名单。'); setContacts(value.contacts); setDiscovery(value.listDiscovery || null); }
  return <Panel title="好友互动" badge={<Tag>{connected ? interactions?.presence?.label || (interactions?.friend?.replyRunning || state?.running ? '回复进程已启动' : enabled ? '等待就绪' : '已关闭') : '状态待核实'}</Tag>}>
    <div className="switch-row"><span>允许好友互动</span><Switch label="允许好友互动" checked={enabled} disabled={!connected || typeof interactions?.policy?.enabled !== 'boolean' || changing.current} onChange={value => { void toggle(value); }} /></div>
    <p className="muted">只与下方许可的好友和群聊互动，不设人数和次数上限。配置模型并选好名单后会自动准备回复；观看中可自主分享已观察的作品。群聊只在被 @ 或叫到响应昵称时回复。</p>
    {switchStatus && <p role="status">{switchStatus}</p>}{switchError && <Note error>{switchError}</Note>}
    {!configured && <Note>请先配置模型。名单和总开关会保留，模型就绪后自动准备互动。</Note>}
    {Boolean(share?.needsReview?.length) && <div className="actions"><Note error>有 {share.needsReview.length} 条分享收据待核对；不会自动重发。</Note><Button size="sm" variant="outline" onClick={() => document.getElementById('share-receipts')?.scrollIntoView({ block: 'center' })}>去核对分享收据</Button></div>}
    {interactions?.friend?.lastError && <Note error>{interactions.friend.lastError}</Note>}
    {interactions?.friend?.waitReason && <Note>{interactions.friend.preparing ? '正在准备：' : '等待准备：'}{interactions.friend.waitReason}{interactions.friend.lastErrorCode ? `（${interactions.friend.lastErrorCode}）` : ''}{interactions.friend.nextRetryAt ? ` · 下次自动检查 ${new Date(interactions.friend.nextRetryAt).toLocaleString('zh-CN', { hour12: false })}` : ''}</Note>}
    {interactions?.friend?.waitReason && <div className="actions"><Button size="sm" variant="outline" disabled={!connected || busy.has('chatPrepare') || interactions?.friend?.canPrepare === false} onClick={() => { void run('chatPrepare', () => api('/api/chat/prepare', {})); }}>{busy.has('chatPrepare') || interactions.friend.preparing ? '正在准备…' : '准备回复通道/重新连接并重试'}</Button></div>}
    {interactions?.friend?.message && <Note>{interactions.friend.message}</Note>}
    <Button size="sm" variant="outline" disabled={!connected || busy.has('chatList') || form.status.kind === 'saving'} onClick={() => { void run('chatList', load); }}>读取联系人与群聊</Button>
    <Button size="sm" variant="outline" disabled={!connected || busy.has('chatList') || form.status.kind === 'saving'} onClick={() => { void run('chatList', async () => { await api('/api/browser/open', {}); await new Promise(resolve => setTimeout(resolve, 1200)); await load(); }); }}>重新连接专用浏览器并重试</Button>
    <Note>读取范围是抖音网页版当前会话，不代表全部关注好友或所有群。要授权群聊，请先让群会话出现在抖音消息列表，再刷新。</Note>
    {contacts && <p className="muted">本次读取：个人 {contacts.filter(item => item.isGroup === false).length} 个 · 群聊 {contacts.filter(item => item.isGroup === true).length} 个。{discovery?.scannedToEnd === false ? ` 当前列表尚未完整读取。${discovery.reason || ''}` : ''}</p>}
    {contacts?.some(contact => contact.relationshipStatus === 'unavailable' || contact.isGroup === true || typeof contact.isGroup !== 'boolean') && <><Note>请在抖音核对所选会话的昵称和类型，再勾选授权。未取得稳定身份的会话可人工勾选，按群聊处理；发送前仍核对显示名和类型。</Note><label><input type="checkbox" aria-label="授权已核对的现有会话" checked={draft.allowConversationOnly} onChange={event => { const value = event.target.checked; existingAuthorization.current = value; edit({ allowConversationOnly: value, ...(!value ? { recipientIds: draft.recipientIds.filter(id => shownContacts.some(contact => contact.id === id && contact.followed === true && contact.isGroup === false)) } : {}) }, value ? { blurOnly: true } : { immediate: true }); }} />我已核对所选会话，授权此名单用于互动</label></>}
    <div className="contact-list">{[false, true, null].map(kind => { const items = shownContacts.filter(contact => contact.isGroup === kind || kind === null && typeof contact.isGroup !== 'boolean'); return items.length ? <React.Fragment key={String(kind)}><p className="muted">{kind === false ? '个人会话' : kind === true ? '群聊（仅被 @ 或叫到响应昵称时回复）' : '旧记录类型待核对（暂不可选）'}</p>{items.map(contact => <label key={contact.id}><input type="checkbox" aria-label={`许可联系人 ${contactName(contact)}`} checked={draft.recipientIds.includes(contact.id)} disabled={!connected || !draft.recipientIds.includes(contact.id) && (contact.notListed || !(contact.followed === true && contact.isGroup === false || draft.allowConversationOnly === true && typeof contact.isGroup === 'boolean'))} onChange={event => edit({ recipientIds: event.target.checked ? [...draft.recipientIds, contact.id] : draft.recipientIds.filter(id => id !== contact.id) }, { immediate: true })} />{contactName(contact)}</label>)}</React.Fragment> : null; })}{!contacts && !state?.policy?.allowlist?.length && <p className="muted">尚未选择许可会话。</p>}</div>
    <Field title="群聊响应昵称（逗号或换行分隔）"><textarea aria-label="群聊响应昵称" value={draft.groupMentionNamesText} onChange={event => edit({ groupMentionNamesText: event.target.value }, { blurOnly: true })} onBlur={() => { void form.flush(); }} rows={2} /></Field>
    <AutoSaveStatus status={form.status} />
    <Note>今日回复模型请求 {state?.daily?.requests || 0} 次 · 今日分享 {share?.daily?.attempts || 0} 次。未确认发送会暂停，不自动重发。</Note>
    {(state?.contacts || []).filter(item => item.identityReviewRequired === true || item.recovery?.requiresUserAction === true || /登录|验证码|未授权|许可.*(?:不足|失效|撤销)|身份.*(?:变化|不一致|未通过|不明|不足)/.test(item.reason || '') || ['paused', 'delivery-uncertain'].includes(item.status) && !(item.recovery?.autoPendingCount > 0 || item.recovery?.autoRetryCount > 0)).map(item => <div className="paused-contact" key={item.id}><strong>{contactName(state?.policy?.allowlist?.find(contact => contact.id === item.id))}</strong><p>{item.reason || '该会话暂缓处理，状态会继续更新。'}</p>{item.identityReviewRequired === true && <p>请重新读取联系人并确认许可名单；身份未通过前不会发送。</p>}</div>)}
    <div id="share-receipts"><ShareReceipts state={share} api={api} run={run} busy={busy} connected={connected} /></div>
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
  return <Panel title="转发作品给好友"><p className="muted">选择作品和收件人后，亲自点击转发。</p>
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
  return <div className="memory-view"><div className="section-heading"><h1>共享记忆</h1><p>独立软件和抖音插件共用同一个本地记忆文件夹。</p></div><div className="memory-location"><code>{settings.memoryFolder || '正在读取记忆文件夹位置…'}</code><Button size="sm" variant="outline" disabled={!settings.memoryFolder || !bridge?.openMemoryFolder} onClick={() => { void run('openMemory', () => bridge.openMemoryFolder()); }}>打开记忆文件夹</Button></div>
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
  const [mode, setMode] = useState(null), [comments, setComments] = useState(null), [connectionError, setConnectionError] = useState('');
  const [tasks, setTasks] = useState([]), [selectedTask, setSelectedTask] = useState(null), [events, setEvents] = useState([]), [running, setRunning] = useState(false), [instruction, setInstruction] = useState('');
  const [schedule,setSchedule]=useState(null),[interactions,setInteractions]=useState(null),[updatesOpen,setUpdatesOpen]=useState(false),[reviewOpen,setReviewOpen]=useState(false);
  const [view, setView] = useState('settings'), [settingsCategory, setSettingsCategory] = useState('基础设置'), [rightOpen, setRightOpen] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(new Set()), [suggestedUrl, setSuggestedUrl] = useState('');
  const [operationErrors, setOperationErrors] = useState({}), [pollError, setPollError] = useState('');
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
    let alive = true, polling = false, ticks = 0;
    async function poll() {
      if (!alive || polling) return; polling = true;
      try {
        if (!bootRef.current || ticks++ % 5 === 0) {
          const value = await client.bootstrap(); if (!alive) return;
          if (value.sessionChanged) { revision.current = 0; currentTask.current = null; setEvents([]); setWatchSynced(false); }
          bootRef.current = value; setBoot(value);
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
        const reads = [['/api/watch/schedule',setSchedule],['/api/interactions/state',setInteractions],bootRef.current.videoTime?.enabled ? ['/api/video/status', setVideo] : null, ['/api/task/limits', setTaskLimits], bootRef.current.mode?.available ? ['/api/mode/state', setMode] : null, bootRef.current.comments?.available ? ['/api/comments/state', setComments] : null, ['/api/chat/state', setChat], bootRef.current.media?.available ? ['/api/media/state', setAudio] : null, bootRef.current.watch?.available ? ['/api/watch/state', setWatch] : null, bootRef.current.share?.available ? ['/api/share/state', setShare] : null, bootRef.current.persona?.available ? ['/api/persona', setPersona] : null].filter(Boolean);
        const results = await Promise.allSettled(reads.map(async ([route, setter]) => { try { const state = await client.request(route); if (alive) { setter(state); if (route === '/api/watch/state') setWatchSynced(true); } } catch (failure) { if (alive && route === '/api/watch/state') setWatchSynced(false); if (alive && ['/api/interactions/state', '/api/chat/state', '/api/watch/state', '/api/share/state', '/api/watch/schedule', '/api/mode/state', '/api/comments/state'].includes(route)) setter(null); throw failure; } }));
        if (alive) setPollError(results.filter(item => item.status === 'rejected').map(item => item.reason.message).join(' '));
      } catch (failure) { if (alive) { setConnected(false); setWatchSynced(false); setMode(null); setComments(null); setPollError(''); bootRef.current = null; setConnectionError(failure.message || '正在重新连接本机服务。'); } }
      finally { polling = false; }
    }
    pollRef.current = poll; void poll(); const timer = setInterval(() => { void poll(); }, 1500);
    return () => { alive = false; clearInterval(timer); pollRef.current = null; };
  }, [client, bridge]);
  const api = (route, body) => client.request(route, body);
  const openDouyin = () => { void run('browserOpen', () => api('/api/browser/open', {})); };
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

  const settingsPage = <div className="settings-page"><h1>大肥鱼抖音助手</h1><div role="tablist" aria-label="刷抖音设置分类" className="settings-tabs">{Object.keys(SETTINGS_SECTIONS).map(name => <Button key={name} role="tab" aria-selected={settingsCategory === name} size="sm" variant={settingsCategory === name ? 'primary' : 'outline'} onClick={() => setSettingsCategory(name)}>{name}</Button>)}</div>
    {settingsCategory === '基础设置' && <><Panel title="模型设置"><p className="muted">独立软件使用自己的 API Key，设置控件与插件采用同一套 DSH 组件。</p><p>当前模型：{settings.model || '尚未配置'} · {configured ? '已配置 Key' : '尚未配置 Key'}</p><Button size="sm" onClick={() => setSettingsOpen(true)}>配置模型与 API Key</Button></Panel><PersonaPanel snapshot={persona} onSnapshot={setPersona} api={api} run={run} bridge={bridge} busy={busy} watchState={watch} watchReady={watchReady} /><details><summary>检索共享记忆</summary><MemoryView settings={settings} api={api} run={run} busy={busy} bridge={bridge} /></details></>}
    {settingsCategory === '视频观看' && <><TopicPanel state={watch?.options} active={watchActive} api={api} run={run} busy={busy} connected={connected && watchReady} /><VideoPanel state={video} schedule={schedule} watch={watch} api={api} run={run} busy={busy} connected={connected} configured={configured}>{boot?.mode?.available && <SilentPanel state={mode} connected={connected} api={api} run={run} busy={busy} />}</VideoPanel><TaskBudgetPanel state={taskLimits} api={api} run={run} busy={busy} operationActive={operationActive} /></>}
    {settingsCategory === '好友互动' && <FriendInteractionPanel state={chat} interactions={interactions} share={share} api={api} run={run} busy={busy} configured={configured} connected={connected} />}
    {settingsCategory === '公开评论' && <CommentsPanel state={comments} connected={connected} api={api} run={run} busy={busy} />}
    {settingsCategory === '音频与密钥' && <AudioPanel state={audio} api={api} run={run} busy={busy} bridge={bridge} operationActive={operationActive} />}
    {settingsCategory === '观看日报' && <ReportsView connected={connected} api={api} run={run} busy={busy} />}
    {settingsCategory === '自检与用量' && <HealthDashboard api={api} run={run} busy={busy} connected={connected} />}
  </div>;
  return <div className={`${frame.frame} app-frame`} style={{ gridTemplateColumns: rightOpen && view !== 'settings' ? '240px minmax(340px,1fr) 352px' : '240px minmax(340px,1fr)' }}>
    <aside className={`${frame.sidebarCol} navigation`}><div className="brand"><div className="brand-icon"><img src={brandIcon} alt="大肥鱼图标" /></div><div><strong>大肥鱼</strong><small>你的抖音助手</small></div></div><Button variant="outline" className="new-task" onClick={() => { setSelectedTask(null); setView('chat'); }}>＋ 新任务</Button>
      <nav aria-label="主导航"><button className={view === 'chat' ? 'nav-link active' : 'nav-link'} onClick={() => setView('chat')}>◌ 对话与视频</button><button className={view === 'settings' ? 'nav-link active' : 'nav-link'} onClick={() => setView('settings')}>☷ 业务设置</button>{boot?.watch?.available && <button className={view === 'watch' ? 'nav-link active' : 'nav-link'} onClick={() => setView('watch')}>◉ 自主观看记录</button>}</nav>
      <div className="sidebar-label">本次运行的任务</div><div className="task-list">{tasks.map(item => <button className={item.id === selectedTask && view === 'chat' ? 'task-item selected' : 'task-item'} key={item.id} onClick={() => { setSelectedTask(item.id); setView('chat'); }}><span>{item.instruction || '视频任务'}</span><small>{statusLabel(item.status)}</small></button>)}{!tasks.length && <p className="sidebar-empty">任务记录会出现在这里。</p>}</div>
      <div className="sidebar-bottom"><small className="software-version">独立 API 版 · {__APP_VERSION__}</small><Button size="sm" disabled={busy.has('refresh')} onClick={() => { void run('refresh', async () => { bootRef.current = null; await pollRef.current?.(); }); }}>刷新连接</Button><button className="nav-link" onClick={() => setUpdatesOpen(true)}>检查更新</button><div className="connection"><StateDot state={connected ? running ? 'ongoing' : 'done' : 'warning'} /><span>{connected ? running ? '正在执行任务' : '本机服务已连接' : '正在连接本机服务'}</span></div></div>
    </aside>
    <main className={`${frame.centerCol} main-column`}><header className="topbar"><div><strong>{view === 'settings' ? '刷抖音设置' : view === 'health' ? '自检与用量' : view === 'reports' ? '观看日报' : view === 'memory' ? '共享记忆与人格' : view === 'watch' ? '自主观看' : task?.instruction || '对话与视频'}</strong><small>{settings.model || boot?.config?.model}</small></div><div className="actions"><FriendPresence presence={interactions?.presence} connected={connected} />{settings.configured && !settingsOpen && <Button size="sm" variant="outline" disabled={!connected || busy.has('browserOpen')} onClick={openDouyin}>{busy.has('browserOpen') ? '正在打开抖音…' : '打开抖音'}</Button>}{view !== 'settings' && <Button size="sm" onClick={() => setRightOpen(old => !old)}>{rightOpen ? '收起快捷控制' : '展开快捷控制'}</Button>}</div></header>
    {((share?.needsReview || []).length > 0 || share?.recoveryRequired) && <div className="global-error" role="alert"><span>分享送达尚未确认，保留原收据，不会自动重发。</span><Button size="sm" variant="outline" onClick={() => setReviewOpen(true)}>查看分享收据</Button></div>}
      {(error || connectionError || pollError) && <div className="global-error" role="alert"><span>{[error, connectionError, pollError].filter(Boolean).join(' ')}</span><RecoveryActions busy={busy} connected={connected} message={[error, connectionError, pollError].filter(Boolean).join(' ')} onRetry={() => { void run('refresh', async () => { bootRef.current = null; await pollRef.current?.(); }); }} onHealth={() => { setSettingsCategory('自检与用量'); setView('settings'); }} onOpen={openDouyin} /><button aria-label="关闭提示" onClick={() => { setError(''); setConnectionError(''); setPollError(''); }}>×</button></div>}
      {Object.entries(operationErrors).map(([name, failure]) => <div className="global-error" role="alert" key={name}><span>{failure.requestError ? '上次操作：' : ''}{failure.message}{failure.requestError && connected ? failure.unconfirmed ? ' 本机服务当前已连接；请核对上述操作是否生效。' : ' 本机服务当前已连接。' : ''}</span><RecoveryActions busy={busy} connected={connected} message={failure.message} onRetry={failure.retry ? () => { void run(name, failure.retry); } : undefined} onHealth={() => { setSettingsCategory('自检与用量'); setView('settings'); }} onOpen={openDouyin} /><button aria-label={`清除${operationLabel(name)}提示`} onClick={() => setOperationErrors(old => { const next = { ...old }; delete next[name]; return next; })}>×</button></div>)}
      {boot?.watch?.available && !watchReady && <div className="watch-running-strip" role="status">自主观看状态尚未核实，请等待本机服务回读后再开始操作。</div>}
      {watchActive && <div className="watch-running-strip" role="status">自主观看进行中 · 今日已观看 {Math.floor(video?.daily?.usedSeconds || 0)} 秒 · 模型请求 {video?.daily?.requests || 0} 次</div>}
      {view === 'settings' ? settingsPage : view === 'health' ? <HealthDashboard api={api} run={run} busy={busy} connected={connected} /> : view === 'reports' ? <ReportsView connected={connected} api={api} run={run} busy={busy} /> : view === 'memory' ? <MemoryView api={api} run={run} settings={settings} bridge={bridge} busy={busy} persona={persona} onPersona={setPersona} personaAvailable={boot?.persona?.available} watchState={watch} watchReady={watchReady} /> : view === 'watch' ? <WatchView state={watch} video={video} browser={browser} snapshot={persona} onSettings={() => setRightOpen(true)} /> : <>
        <div className="conversation" aria-live="polite">{!task ? <div className="welcome"><div className="welcome-symbol">◉</div><h1>今天想看些什么？</h1><p>搜索作品、观察视频，把值得记住的内容留下来。</p><div className="suggestions">{EXAMPLES.slice(0, 4).map(([label, value]) => <Button variant="outline" key={label} onClick={() => setInstruction(value)}>{label} ↗</Button>)}</div></div> : <><div className="user-message">{task.instruction}</div><div className="assistant-message"><div className="assistant-avatar">鱼</div><div className="assistant-content">{answer ? <MarkdownText text={answer} labels={MARKDOWN_LABELS} streaming={false} /> : <p className="muted">{running && task.id === currentTask.current ? '正在查看与操作专用浏览器…' : '还没有模型答复。'}</p>}{task.partialMessage && <MarkdownText text={task.partialMessage} labels={MARKDOWN_LABELS} />}{task.status && <small className="task-status">{statusLabel(task.status)}</small>}<details className="activity" open={running && task.id === currentTask.current}><summary>运行过程 · {selectedEvents.length} 条</summary>{selectedEvents.map(item => <EventItem key={item.revision} event={item} />)}</details></div></div></>}</div>
        <div className="composer-area"><div className="quick-actions">{EXAMPLES.map(([label, value]) => <button key={label} type="button" onClick={() => setInstruction(value)}>{label}</button>)}</div><form className="composer" onSubmit={submit}><textarea aria-label="视频任务" placeholder={configured ? '告诉大肥鱼这次想看什么…' : '先在设置中连接 API Key'} maxLength={4000} value={instruction} onChange={event => setInstruction(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit(); } }} /><div className="composer-footer"><span>{boot?.limits ? `最多 ${taskLimits?.policy?.maxSteps ?? boot.limits.maxSteps ?? 20} 步 · ${taskLimits?.policy?.maxToolCalls ?? boot.limits.maxToolCalls} 次工具 · ${taskLimits?.policy?.timeoutSeconds ?? boot.limits.taskTimeoutSeconds} 秒` : 'Enter 发送 · Shift + Enter 换行'}</span>{running ? <Button variant="outline" disabled={busy.has('stop')} onClick={() => { void run('stop', () => api('/api/stop', {})); }}>■ 停止任务</Button> : <Button variant="primary" type="submit" disabled={watchActive || share?.busy || !watchReady || busy.has('watchStart') || !configured || !connected || !allowed || !instruction.trim() || busy.has('task') || busy.has('forward')}>开始任务 ↑</Button>}</div></form>{watchActive && <p className="composer-hint">自主观看正在运行。停止后可手动下达视频任务。</p>}{!watchActive && <p className="composer-hint">手动任务的次数、步骤和超时独立于视频时段与自主观看预算，任一预算先到会停止。自动观看按每日预算和允许时段运行。</p>}{!allowed && <p className="composer-hint">{video?.reason || '请在设置中开启自动观看并确认允许时段。'}</p>}</div>
      </>}
    </main>
    {rightOpen && view !== 'settings' && <aside className="business-sidebar" aria-label="业务设置"><div className="business-heading"><strong>业务设置</strong><small>由你明确控制</small></div>{boot?.videoTime?.enabled ? <VideoPanel state={video} schedule={schedule} watch={watch} api={api} run={run} busy={busy} connected={connected} configured={configured}><TopicPanel state={watch?.options} active={watchActive} api={api} run={run} busy={busy} connected={connected && watchReady} />{boot?.mode?.available && <SilentPanel state={mode} connected={connected} api={api} run={run} busy={busy} />}</VideoPanel> : null}<TaskBudgetPanel state={taskLimits} api={api} run={run} busy={busy} operationActive={operationActive} /><BrowserPanel browser={browser} onPick={pick} manualForward={boot?.share?.available !== true} />{boot?.media?.available && <AudioPanel state={audio} api={api} run={run} busy={busy} bridge={bridge} operationActive={operationActive} />}{boot?.comments?.available && <CommentsPanel state={comments} connected={connected} api={api} run={run} busy={busy} />}<FriendInteractionPanel state={chat} interactions={interactions} share={share} api={api} run={run} busy={busy} configured={configured} connected={connected} /></aside>}
    {updatesOpen && <UpdateDialog bridge={bridge} operationActive={operationActive} onClose={()=>setUpdatesOpen(false)}/>}
    {reviewOpen && <ReviewDialog share={share} api={api} run={run} busy={busy} connected={connected} onClose={()=>setReviewOpen(false)}/>}
    {(!settings.configured || settingsOpen) && <ApiSettings settings={settings} bridge={bridge} onSaved={saved} onClose={() => setSettingsOpen(false)} run={run} busy={busy.has('settings') || busy.has('clearKey')} operationActive={operationActive || !watchReady} watchActive={watchActive} onStopWatch={stopWatch} onOpenDouyin={openDouyin} openingDouyin={busy.has('browserOpen')} connected={connected} operationError={[error, connectionError, ...Object.values(operationErrors).map(item => item.message)].filter(Boolean).join(' ')} />}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
