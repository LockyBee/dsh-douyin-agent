import brandIcon from '../../../assets/brand.png';
import { SchedulePanel, InteractionStatus, UpdateDialog } from './autonomy-panels.jsx';
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
import { createApiClient, publicSettings, saveNativeSettings, saveNativeMediaKey, createForwardGate, mergeEvents, watchIsActive } from './api.mjs';
import { WatchControls, WatchView, PersonaPanel } from './watch-persona.jsx';
import { TaskBudgetPanel } from './task-budget.jsx';
import { AutoSharePanel } from './autonomous-share.jsx';
import { SparkPanel } from './spark-panel.jsx';
import { SilentPanel, CommentsPanel, ReportsView } from './watch-settings.jsx';

const MARKDOWN_LABELS = { code: { copyLabel: '复制代码', copiedLabel: '已复制' }, footnotes: '注释' };
const EVENT_LABELS = { 'model.request': '请求模型', 'model.usage': '本次用量', 'model.answer': '模型答复', 'tool.start': '调用工具', 'tool.result': '工具返回', 'tool.error': '工具出错', 'task.started': '开始任务', 'task.completed': '任务完成', 'task.stopped': '任务停止', 'task.failed': '任务失败', 'task.limited': '达到限制', 'task.needs_user': '需要手动操作', 'video.started': '开始新一轮', 'video.limited': '视频时间已结束' };
const EXAMPLES = [['看推荐', '看看当前推荐视频，观察 3 秒，告诉我画面里发生了什么。'], ['搜索猫咪', '搜索猫咪，打开第一条作品并观察 3 秒，告诉我实际看到了什么。'], ['下一条', '切换下一条视频，读回切换是否成功，再观察 3 秒。'], ['上一条', '切换上一条视频，读回切换是否成功。'], ['暂停', '暂停当前视频，确认播放状态。'], ['播放', '播放当前视频，确认播放进度。']];
const truncated = total => `内容较长，当前展示前 20000 字符（共 ${total} 字符）。`;
const contactName = contact => contact?.name || contact?.displayName || '联系人';
const statusLabel = status => ({ completed: '已完成', running: '进行中', stopping: '正在停止', stopped: '已停止', failed: '未完成', limited: '已到限制', needs_user: '等待手动操作' }[status] || '准备中');

function Field({ title, hint, children }) { return <label className="field"><span>{title}</span>{children}{hint && <small>{hint}</small>}</label>; }
function Panel({ title, badge, children }) { return <section className="panel"><div className="panel-title"><h2>{title}</h2>{badge}</div>{children}</section>; }
function Note({ children, error = false }) { return <p className={error ? 'notice error' : 'notice'} role={error ? 'alert' : undefined}>{children}</p>; }
function Data({ label = '查看返回数据', value }) { return <JsonBlock label={label} payload={value} truncatedLabel={truncated} />; }

function ApiSettings({ settings, bridge, onSaved, onClose, run, busy, operationActive, watchActive, onStopWatch, onOpenDouyin, openingDouyin, connected, operationError }) {
  const [key, setKey] = useState(''), [baseUrl, setBase] = useState(settings.baseUrl), [model, setModel] = useState(settings.model), [remember, setRemember] = useState(settings.remember);
  const [failure, setFailure] = useState('');
  const dirty = useRef(false);
  useEffect(() => { if (!dirty.current) { setBase(settings.baseUrl); setModel(settings.model); setRemember(settings.remember); } }, [settings.baseUrl, settings.model, settings.remember]);
  async function save(event) {
    event.preventDefault(); if ((!settings.configured && !key.trim()) || busy || operationActive) return;
    const input = { apiKey: key.trim(), baseUrl: baseUrl.trim(), model: model.trim(), remember }; setKey(''); setFailure('');
    try { const result = await saveNativeSettings(bridge, input); await onSaved(result); }
    catch { setFailure('设置未保存，请检查 API Key、接口地址和模型名称后重试。'); }
    finally { input.apiKey = ''; }
  }
  return <div className="settings-scrim"><section className="api-dialog" role="dialog" aria-modal="true" aria-labelledby="api-title">
    <div className="brand-icon"><img src={brandIcon} alt="大肥鱼图标" /></div><h1 id="api-title">{settings.configured ? '模型与共享记忆' : '先连接你的 DeepSeek'}</h1>
    <p className="muted">输入 API Key 后即可使用。软件独立运行，不需要启动 DSH。</p>
    <Button size="sm" variant="outline" onClick={onOpenDouyin} disabled={!connected || openingDouyin}>{openingDouyin ? '正在打开抖音…' : '打开抖音'}</Button>
    <p className="notice">可先打开专用抖音窗口登录。打开页面不开始视频计时。</p>
    {operationError && <Note error>{operationError}</Note>}
    {operationActive && <Note>请先停止正在执行的任务、自主观看、自动回复、主动问候或转发，再修改模型设置。{watchActive && <Button size="sm" onClick={onStopWatch}>停止当前自主观看</Button>}</Note>}
    <form onSubmit={event => { void run('settings', () => save(event)); }}>
      <Field title="API Key" hint="通过桌面进程交给模型接口，本机 HTTP 接口不接收或返回密钥。"><Input aria-label="API Key" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} maxLength={4096} required={!settings.configured} placeholder={settings.configured ? '留空沿用现有 API Key' : ''} autoFocus /></Field>
      <details className="advanced"><summary>接口与模型</summary><Field title="API 地址"><Input aria-label="API 地址" value={baseUrl} onChange={event => { dirty.current = true; setBase(event.target.value); }} required /></Field><Field title="模型名称"><Input aria-label="模型名称" value={model} onChange={event => { dirty.current = true; setModel(event.target.value); }} maxLength={120} required /></Field></details>
      <div className="switch-row"><div><strong>记住 API Key</strong><small>关闭后仅在本次运行中使用。</small></div><Switch label="记住 API Key" checked={remember} onChange={value => { dirty.current = true; setRemember(value); }} /></div>
      {failure && <Note error>{failure}</Note>}
      <div className="actions"><Button type="submit" variant="primary" disabled={operationActive || (!settings.configured && !key.trim()) || busy || !bridge?.saveSettings}>{busy ? '正在保存…' : settings.configured ? '保存设置' : '保存并连接'}</Button>{settings.configured && <Button onClick={onClose}>返回</Button>}</div>
    </form>
    {settings.configured && <Button size="sm" onClick={() => { if (!operationActive) void run('clearKey', async () => onSaved(publicSettings(await bridge.clearApiKey()))); }} disabled={busy || operationActive}>清除已保存的 API Key</Button>}
    <div className="memory-location"><strong>与插件共用的记忆文件夹</strong><code>{settings.memoryFolder || '正在读取文件夹位置…'}</code><Button size="sm" variant="outline" disabled={!bridge?.openMemoryFolder || !settings.memoryFolder} onClick={() => { void run('openMemory', () => bridge.openMemoryFolder()); }}>打开记忆文件夹</Button><small>独立软件与抖音插件读取同一位置。</small></div>
    {!bridge && <Note error>桌面设置接口未连接，请从独立软件打开此界面。</Note>}
  </section></div>;
}

function VideoPanel({ state, api, run, busy, children }) {
  const [windows, setWindows] = useState('00:00-24:00'), [minutes, setMinutes] = useState(10), [unlimited, setUnlimited] = useState(false), [weekendAll, setWeekendAll] = useState(false), dirty = useRef(false);
  useEffect(() => { if (state?.policy && !dirty.current) { setWindows(state.policy.windows.join('\n')); setMinutes(state.policy.sessionMinutes ?? 10); setUnlimited(state.policy.sessionMinutes === null); setWeekendAll(state.policy.weekendWindows?.join() === '00:00-24:00'); } }, [state]);
  return <Panel title="刷视频时间" badge={<Tag>{state?.allowed ? state.remainingSeconds === null ? '不限时长' : `${Math.floor((state.remainingSeconds || 0) / 60)}分${(state.remainingSeconds || 0) % 60}秒` : '未开始'}</Tag>}>
    <form onSubmit={event => { event.preventDefault(); void run('videoPolicy', async () => { await api('/api/video/policy', { windows: windows.split(/[\n,;，；]+/).map(item => item.trim()).filter(Boolean), weekendWindows: weekendAll ? ['00:00-24:00'] : null, sessionMinutes: unlimited ? null : Number(minutes) }); dirty.current = false; }); }}>
      <div className="actions"><Button size="sm" type="button" onClick={() => { dirty.current = true; setWindows('00:00-09:00\n12:00-14:00\n18:00-24:00'); setWeekendAll(true); }}>谷时段（DeepSeek）</Button><Button size="sm" type="button" onClick={() => { dirty.current = true; setWindows('00:00-24:00'); setWeekendAll(false); }}>全天</Button><Button size="sm" type="button" onClick={() => { dirty.current = true; setWindows('20:00-22:00'); setWeekendAll(false); }}>晚间 20–22 点</Button></div><p className="notice">谷时段按 DeepSeek 2026-10-23 官方规则；周末全天，法定节假日可手动改为全天。其他提供商优惠以其规则为准。填入后请保存。</p>
      <div className="switch-row"><span>周末全天允许</span><Switch label="周末全天允许" checked={weekendAll} onChange={checked => { dirty.current = true; setWeekendAll(checked); }} /></div>
      <div className="switch-row"><span>不限单轮时长</span><Switch label="不限单轮时长" checked={unlimited} onChange={checked => { dirty.current = true; setUnlimited(checked); }} /></div>
      <Field title="每日允许时段 · 北京时间"><textarea aria-label="每日允许时段" rows={2} value={windows} maxLength={220} onChange={event => { dirty.current = true; setWindows(event.target.value); }} placeholder="20:00-21:00，每行一段" required /></Field>
      <Field title="单轮上限（分钟）" hint={unlimited ? '当前不限单轮时长。直接填写分钟数即可切回限时，点击“保存时间设置”后生效。' : '修改分钟数后，请点击“保存时间设置”。'}><Input aria-label="单轮上限" type="number" min={1} max={1000000} step={1} value={unlimited ? '' : minutes} placeholder={unlimited ? '不限；输入分钟数可设置上限' : '请输入分钟数'} onChange={event => { dirty.current = true; const value = event.target.value; setMinutes(value); if (value !== '') setUnlimited(false); }} required={!unlimited} /></Field>
      <Button type="submit" size="sm" variant="outline" disabled={busy.has('videoPolicy')}>保存时间设置</Button>
    </form>
    <div className="actions"><Button size="sm" variant="primary" disabled={!state?.window || busy.has('videoStart')} onClick={() => { void run('videoStart', () => api('/api/video/start', {})); }}>开始新一轮</Button><Button size="sm" disabled={state?.session?.status !== 'active' || busy.has('videoEnd')} onClick={() => { void run('videoEnd', () => api('/api/video/end', {})); }}>结束本轮</Button></div>
    <Note>{state?.reason || '本轮计时中，到点会暂停视频。'} 保存设置不会给当前轮次加时。</Note>
    {children}
  </Panel>;
}

function AudioPanel({ state, api, run, busy, bridge, operationActive }) {
  const [enabled, setEnabled] = useState(false), [backend, setBackend] = useState('local-whisper');
  const [mediaKey, setMediaKey] = useState(''), [keyNote, setKeyNote] = useState('');
  const dirty = useRef(false);
  useEffect(() => { if (state && !dirty.current) { setEnabled(state.enabled === true); setBackend(state.backend); } }, [state]);
  const info = state?.backends?.[backend] || state?.providers?.[backend];
  return <Panel title="音频理解" badge={<Tag>{state?.enabled ? '已开启' : '默认关闭'}</Tag>}>
    <div className="switch-row"><span>读取视频声音</span><Switch label="读取视频声音" checked={enabled} onChange={value => { dirty.current = true; setEnabled(value); }} /></div>
    <Field title="音频后端"><select aria-label="音频后端" value={backend} onChange={event => { dirty.current = true; setBackend(event.target.value); setMediaKey(''); setKeyNote(''); }}><option value="local-whisper">本机 Whisper</option><option value="mimo">MiMo</option><option value="minimax">MiniMax</option></select></Field>
    {backend !== 'local-whisper' && <form onSubmit={event => { event.preventDefault(); if (operationActive || !mediaKey.trim()) return; void run('mediaKey', async () => { await saveNativeMediaKey(bridge, { backend, apiKey: mediaKey }); setMediaKey(''); setKeyNote('已保存共享音频 Key。保存不会开启音频或发起云端请求。'); }); }}>
      <Field title={`${backend === 'mimo' ? 'MiMo' : 'MiniMax'} API Key`} hint="保存在本机共享媒体 .env 中（明文），软件与插件共用；不回显已保存的 Key。"><Input aria-label={`${backend === 'mimo' ? 'MiMo' : 'MiniMax'} API Key`} type="password" autoComplete="off" maxLength={4096} value={mediaKey} onChange={event => { setMediaKey(event.target.value); setKeyNote(''); }} placeholder={info?.available ? '已配置；填写后替换' : '填写音频服务的 API Key'} /></Field>
      <Button size="sm" type="submit" variant="outline" disabled={!bridge?.saveMediaKey || operationActive || busy.has('mediaKey') || !mediaKey.trim()}>{busy.has('mediaKey') ? '正在保存…' : '保存音频 Key'}</Button>
      {!bridge?.saveMediaKey && <Note>此窗口不支持保存音频 Key，请使用新版软件，或在共享媒体 .env 填写 {backend === 'mimo' ? 'XIAOMI_API_KEY' : 'MINIMAX_API_KEY'}。</Note>}
      {operationActive && <Note>停止当前任务、自主观看及自动回复后可更换音频 Key。</Note>}
      {keyNote && <Note>{keyNote}</Note>}
    </form>}
    <div className="actions"><Button size="sm" variant="outline" disabled={busy.has('audioSave')} onClick={() => { void run('audioSave', async () => { await api('/api/media/configure', { enabled, backend }); dirty.current = false; }); }}>保存音频设置</Button><Button size="sm" onClick={() => { dirty.current = false; void run('audioRefresh', () => api('/api/media/state')); }}>刷新</Button></div>
    <Note>{info?.available === true ? '后端依赖已就绪。' : info?.available === false ? '所选后端尚未就绪。' : '后端可用性尚未确认。'} 音频处理可能需要额外配置或费用。</Note>
  </Panel>;
}

function ChatPanel({ state, api, run, busy, configured }) {
  const [contacts, setContacts] = useState(null), [chosen, setChosen] = useState([]), [budget, setBudget] = useState(40);
  const active = state?.running || state?.starting || state?.busy;
  useEffect(() => { if (!contacts) setChosen((state?.policy?.allowlist || []).map(item => item.id)); }, [state, contacts]);
  useEffect(() => { if (state?.policy) setBudget(state.policy.dailyReplyLimit); }, [state?.policy?.dailyReplyLimit]);
  async function load() { const value = await api('/api/chat/contacts'); if (value.blocked || value.loginRequired || value.verificationRequired) throw new Error('请在专用浏览器完成登录或验证。'); if (!value.contacts?.length) throw new Error('未读到可靠联系人列表，保留原许可名单。'); setContacts(value.contacts); }
  return <Panel title="好友私信" badge={<Tag>{state?.running ? '运行中' : state?.starting ? '建立基线中' : '未启用'}</Tag>}>
    <p className="muted">只回复你明确许可的两位已关注好友，启动前的历史不会触发回复。</p>
    <Button size="sm" variant="outline" disabled={active || busy.has('chatList')} onClick={() => { void run('chatList', load); }}>读取联系人</Button>
    <div className="contact-list">{contacts ? contacts.map(contact => <label key={contact.id}><input type="checkbox" checked={chosen.includes(contact.id)} disabled={active || contact.followed !== true || contact.isGroup !== false || (!chosen.includes(contact.id) && chosen.length >= 2)} onChange={event => setChosen(old => event.target.checked ? [...old, contact.id] : old.filter(id => id !== contact.id))} />{contactName(contact)}<small>{contact.followed === true && contact.isGroup === false ? '已关注' : '未通过身份核对'}</small></label>) : <p className="muted">已许可：{(state?.policy?.allowlist || []).map(contactName).join('、') || '尚未选择'}</p>}</div>
    <Field title="每日模型请求上限"><Input aria-label="每日模型请求上限" type="number" min={1} max={200} value={budget} onChange={event => setBudget(event.target.value)} /></Field>
    <div className="actions"><Button size="sm" disabled={!contacts || active || busy.has('chatSave')} onClick={() => { void run('chatSave', () => api('/api/chat/configure', { recipientIds: chosen, dailyReplyLimit: Number(budget) })); }}>保存许可名单</Button><Button size="sm" variant="primary" disabled={active || !configured || !state?.policy?.allowlist?.length || busy.has('chatStart')} onClick={() => { void run('chatStart', () => api('/api/chat/start', {})); }}>启用自动回复</Button><Button size="sm" disabled={!active && !state?.worker?.alive} onClick={() => { void run('chatStop', () => api('/api/chat/stop', {})); }}>停止</Button></div>
    <Note>今日已请求 {state?.daily?.requests || 0} / {state?.daily?.limit || budget} 次。发送未确认时会暂停，不会自动重发。</Note>
    {state?.worker?.alive && !state.worker.owned && <Note>自动回复正由另一个入口运行。</Note>}
    {(state?.contacts || []).filter(item => item.status !== 'ready').map(item => <div className="paused-contact" key={item.id}><strong>{contactName(state.policy?.allowlist?.find(contact => contact.id === item.id))}</strong><p>{item.reason || item.status}</p><Button size="sm" disabled={active} onClick={() => { void run(`resolve-${item.id}`, () => api('/api/chat/resolve', { recipientId: item.id })); }}>已人工核对，解除暂停</Button></div>)}
    <details><summary>处理记录</summary><Data value={{ contacts: (state?.contacts || []).map(item => ({ name: contactName(state?.policy?.allowlist?.find(contact => contact.id === item.id)), status: item.status, pending: Boolean(item.pending), unanswered: item.unanswered?.length || 0 })), events: state?.events || [] }} /></details>
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
  const [spark, setSpark] = useState(null), [sparkSynced, setSparkSynced] = useState(false);
  const [mode, setMode] = useState(null), [comments, setComments] = useState(null), [connectionError, setConnectionError] = useState('');
  const [tasks, setTasks] = useState([]), [selectedTask, setSelectedTask] = useState(null), [events, setEvents] = useState([]), [running, setRunning] = useState(false), [instruction, setInstruction] = useState('');
  const [schedule,setSchedule]=useState(null),[interactions,setInteractions]=useState(null),[updatesOpen,setUpdatesOpen]=useState(false);
  const [view, setView] = useState('settings'), [settingsCategory, setSettingsCategory] = useState('基础设置'), [rightOpen, setRightOpen] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(new Set()), [suggestedUrl, setSuggestedUrl] = useState('');
  const lock = useRef(new Set()), revision = useRef(0), bootRef = useRef(null), currentTask = useRef(null), pollRef = useRef(null), submitLock = useRef(false), restoredSelection = useRef(false);
  const configured = settings.configured && boot?.config?.configured === true;
  const allowed = boot?.videoTime?.enabled !== true || video?.allowed === true;
  const watchActive = watchIsActive(watch), watchReady = boot?.watch?.available !== true || watchSynced;
  const sparkReady = boot?.spark?.available !== true || sparkSynced;
  const manualBusy = running || busy.has('task') || busy.has('forward') || share?.busy === true;
  const operationActive = manualBusy || watchActive || comments?.busy || busy.has('watchStart') || busy.has('chatStart') || chat?.running || chat?.starting || chat?.busy || chat?.worker?.alive || busy.has('sparkStart') || spark?.running || spark?.starting || spark?.busy || spark?.worker?.alive;
  const run = useCallback(async (name, action) => {
    if (lock.current.has(name)) return;
    lock.current.add(name); setBusy(new Set(lock.current)); setError('');
    try { const result = await action(); await pollRef.current?.(); return result; }
    catch (failure) { setError(failure?.message || '操作未完成，请检查本机服务。'); }
    finally { lock.current.delete(name); setBusy(new Set(lock.current)); }
  }, []);
  useEffect(() => {
    let alive = true, polling = false, ticks = 0;
    async function poll() {
      if (!alive || polling) return; polling = true;
      try {
        if (!bootRef.current || ticks++ % 5 === 0) {
          const value = await client.bootstrap(); if (!alive) return;
          if (value.sessionChanged) { revision.current = 0; currentTask.current = null; setEvents([]); setWatchSynced(false); setSparkSynced(false); }
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
        const reads = [['/api/watch/schedule',setSchedule],['/api/interactions/state',setInteractions],bootRef.current.videoTime?.enabled ? ['/api/video/status', setVideo] : null, ['/api/task/limits', setTaskLimits], bootRef.current.mode?.available ? ['/api/mode/state', setMode] : null, bootRef.current.comments?.available ? ['/api/comments/state', setComments] : null, ['/api/chat/state', setChat], bootRef.current.media?.available ? ['/api/media/state', setAudio] : null, bootRef.current.watch?.available ? ['/api/watch/state', setWatch] : null, bootRef.current.share?.available ? ['/api/share/state', setShare] : null, bootRef.current.spark?.available ? ['/api/spark/state', setSpark] : null, bootRef.current.persona?.available ? ['/api/persona', setPersona] : null].filter(Boolean);
        await Promise.allSettled(reads.map(async ([route, setter]) => { try { const state = await client.request(route); if (route === '/api/spark/state' && state?.protocol !== 'spark-v1') throw new Error('自动问候状态格式尚未核实。'); if (alive) { setter(state); if (route === '/api/watch/state') setWatchSynced(true); if (route === '/api/spark/state') setSparkSynced(true); } } catch (failure) { if (alive && route === '/api/watch/state') setWatchSynced(false); if (alive && route === '/api/spark/state') setSparkSynced(false); if (alive && route === '/api/mode/state') setMode(null); if (alive && route === '/api/comments/state') setComments(null); throw failure; } }));
      } catch (failure) { if (alive) { setConnected(false); setWatchSynced(false); setSparkSynced(false); setMode(null); setComments(null); bootRef.current = null; setConnectionError(failure.message || '正在重新连接本机服务。'); } }
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
  async function saved(value) { setSettings(publicSettings(value)); setSettingsOpen(false); bootRef.current = null; await pollRef.current?.(); }
  function pick(url) { if (!/^https:\/\/(?:www\.)?douyin\.com\/video\/\d+\/?$/.test(url || '')) { setError('当前作品链接尚未核实，请使用公开作品地址。'); return; } setSuggestedUrl(url); setRightOpen(true); }
  const task = tasks.find(item => item.id === selectedTask), selectedEvents = events.filter(item => !task || item.taskId === task.id);
  const answer = task?.message || selectedEvents.filter(item => item.type === 'model.answer').at(-1)?.message;
  const stopWatch = () => { void run('watchStop', () => api('/api/watch/stop', {})); };
  const watchControls = boot?.watch?.available && <WatchControls state={watch} video={video} configured={configured} connected={connected && watchReady} otherBusy={manualBusy} busy={busy} run={run} api={api} onView={() => setView('watch')} />;
  const settingsPage = <div className="settings-page"><h1>大肥鱼抖音助手</h1><div role="tablist" aria-label="刷抖音设置分类" className="settings-tabs">{Object.keys(SETTINGS_SECTIONS).map(name => <Button key={name} role="tab" aria-selected={settingsCategory === name} size="sm" variant={settingsCategory === name ? 'primary' : 'outline'} onClick={() => setSettingsCategory(name)}>{name}</Button>)}</div>
    {settingsCategory === '基础设置' && <><Panel title="模型设置"><p className="muted">独立软件使用自己的 API Key，设置控件与插件采用同一套 DSH 组件。</p><p>当前模型：{settings.model || '尚未配置'} · {configured ? '已配置 Key' : '尚未配置 Key'}</p><Button size="sm" onClick={() => setSettingsOpen(true)}>配置模型与 API Key</Button></Panel><PersonaPanel snapshot={persona} onSnapshot={setPersona} api={api} run={run} bridge={bridge} busy={busy} watchState={watch} watchReady={watchReady} /><details><summary>检索共享记忆</summary><MemoryView settings={settings} api={api} run={run} busy={busy} bridge={bridge} /></details></>}
    {settingsCategory === '视频观看' && <><SchedulePanel state={schedule} api={api} run={run} busy={busy} connected={connected} /><TopicPanel state={watch?.options} active={watchActive} api={api} run={run} busy={busy} connected={connected && watchReady} /><VideoPanel state={video} api={api} run={run} busy={busy}>{watchControls}{boot?.mode?.available && <SilentPanel state={mode} connected={connected} api={api} run={run} busy={busy} />}</VideoPanel><TaskBudgetPanel state={taskLimits} api={api} run={run} busy={busy} operationActive={operationActive} /></>}
    {settingsCategory === '好友互动' && <><InteractionStatus state={interactions}/><ChatPanel state={chat} api={api} run={run} busy={busy} configured={configured} />{boot?.spark?.available && <SparkPanel state={spark} api={api} run={run} busy={busy} configured={configured} connected={connected && sparkReady} />}{boot?.share?.available ? <AutoSharePanel state={share} api={api} run={run} busy={busy} connected={connected} /> : boot?.forward?.available && <ForwardPanel api={api} run={run} busy={busy} allowed={allowed && configured && connected && watchReady} running={manualBusy || watchActive} suggestedUrl={suggestedUrl} />}</>}
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
    <main className={`${frame.centerCol} main-column`}><header className="topbar"><div><strong>{view === 'settings' ? '刷抖音设置' : view === 'health' ? '自检与用量' : view === 'reports' ? '观看日报' : view === 'memory' ? '共享记忆与人格' : view === 'watch' ? '自主观看' : task?.instruction || '对话与视频'}</strong><small>{settings.model || boot?.config?.model}</small></div><div className="actions">{settings.configured && !settingsOpen && <Button size="sm" variant="outline" disabled={!connected || busy.has('browserOpen')} onClick={openDouyin}>{busy.has('browserOpen') ? '正在打开抖音…' : '打开抖音'}</Button>}{view !== 'settings' && <Button size="sm" onClick={() => setRightOpen(old => !old)}>{rightOpen ? '收起快捷控制' : '展开快捷控制'}</Button>}</div></header>
      {(error || connectionError) && <div className="global-error" role="alert"><span>{error || connectionError}</span><button aria-label="关闭提示" onClick={() => { setError(''); setConnectionError(''); }}>×</button></div>}
      {boot?.watch?.available && !watchReady && <div className="watch-running-strip" role="status">自主观看状态尚未核实，请等待本机服务回读后再开始操作。</div>}
      {watchActive && <div className="watch-running-strip" role="status"><span>{statusLabel(watch?.status)} · {video?.remainingSeconds === null ? '本轮不限单轮时长' : `自主观看剩余 ${Math.max(0, Math.floor(video?.remainingSeconds ?? watch?.remainingSeconds ?? 0))} 秒`}</span><Button size="sm" disabled={busy.has('watchStop')} onClick={stopWatch}>停止当前自主观看</Button></div>}
      {view === 'settings' ? settingsPage : view === 'health' ? <HealthDashboard api={api} run={run} busy={busy} connected={connected} /> : view === 'reports' ? <ReportsView connected={connected} api={api} run={run} busy={busy} /> : view === 'memory' ? <MemoryView api={api} run={run} settings={settings} bridge={bridge} busy={busy} persona={persona} onPersona={setPersona} personaAvailable={boot?.persona?.available} watchState={watch} watchReady={watchReady} /> : view === 'watch' ? <WatchView state={watch} video={video} browser={browser} snapshot={persona} onSettings={() => setRightOpen(true)} /> : <>
        <div className="conversation" aria-live="polite">{!task ? <div className="welcome"><div className="welcome-symbol">◉</div><h1>今天想看些什么？</h1><p>搜索作品、观察视频，把值得记住的内容留下来。</p><div className="suggestions">{EXAMPLES.slice(0, 4).map(([label, value]) => <Button variant="outline" key={label} onClick={() => setInstruction(value)}>{label} ↗</Button>)}</div></div> : <><div className="user-message">{task.instruction}</div><div className="assistant-message"><div className="assistant-avatar">鱼</div><div className="assistant-content">{answer ? <MarkdownText text={answer} labels={MARKDOWN_LABELS} streaming={false} /> : <p className="muted">{running && task.id === currentTask.current ? '正在查看与操作专用浏览器…' : '还没有模型答复。'}</p>}{task.partialMessage && <MarkdownText text={task.partialMessage} labels={MARKDOWN_LABELS} />}{task.status && <small className="task-status">{statusLabel(task.status)}</small>}<details className="activity" open={running && task.id === currentTask.current}><summary>运行过程 · {selectedEvents.length} 条</summary>{selectedEvents.map(item => <EventItem key={item.revision} event={item} />)}</details></div></div></>}</div>
        <div className="composer-area"><div className="quick-actions">{EXAMPLES.map(([label, value]) => <button key={label} type="button" onClick={() => setInstruction(value)}>{label}</button>)}</div><form className="composer" onSubmit={submit}><textarea aria-label="视频任务" placeholder={configured ? '告诉大肥鱼这次想看什么…' : '先在设置中连接 API Key'} maxLength={4000} value={instruction} onChange={event => setInstruction(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form.requestSubmit(); } }} /><div className="composer-footer"><span>{boot?.limits ? `最多 ${taskLimits?.policy?.maxSteps ?? boot.limits.maxSteps ?? 20} 步 · ${taskLimits?.policy?.maxToolCalls ?? boot.limits.maxToolCalls} 次工具 · ${taskLimits?.policy?.timeoutSeconds ?? boot.limits.taskTimeoutSeconds} 秒` : 'Enter 发送 · Shift + Enter 换行'}</span>{running ? <Button variant="outline" disabled={busy.has('stop')} onClick={() => { void run('stop', () => api('/api/stop', {})); }}>■ 停止任务</Button> : <Button variant="primary" type="submit" disabled={watchActive || share?.busy || !watchReady || busy.has('watchStart') || !configured || !connected || !allowed || !instruction.trim() || busy.has('task') || busy.has('forward')}>开始任务 ↑</Button>}</div></form>{watchActive && <p className="composer-hint">自主观看正在运行。停止后可手动下达视频任务。</p>}{!watchActive && <p className="composer-hint">手动任务的次数、步骤和超时独立于视频时段与自主观看预算，任一预算先到会停止。持续看可用自主观看，不会自动续时。</p>}{!allowed && <p className="composer-hint">{video?.reason || '请先在右侧开始新一轮视频。'}</p>}</div>
      </>}
    </main>
    {rightOpen && view !== 'settings' && <aside className="business-sidebar" aria-label="业务设置"><div className="business-heading"><strong>业务设置</strong><small>由你明确控制</small></div>{boot?.videoTime?.enabled ? <VideoPanel state={video} api={api} run={run} busy={busy}>{watchControls}<TopicPanel state={watch?.options} active={watchActive} api={api} run={run} busy={busy} connected={connected && watchReady} />{boot?.mode?.available && <SilentPanel state={mode} connected={connected} api={api} run={run} busy={busy} />}</VideoPanel> : watchControls}<TaskBudgetPanel state={taskLimits} api={api} run={run} busy={busy} operationActive={operationActive} /><BrowserPanel browser={browser} onPick={pick} manualForward={boot?.share?.available !== true} />{boot?.media?.available && <AudioPanel state={audio} api={api} run={run} busy={busy} bridge={bridge} operationActive={operationActive} />}{boot?.comments?.available && <CommentsPanel state={comments} connected={connected} api={api} run={run} busy={busy} />}<ChatPanel state={chat} api={api} run={run} busy={busy} configured={configured} />{boot?.spark?.available && <SparkPanel state={spark} api={api} run={run} busy={busy} configured={configured} connected={connected && sparkReady} />}{boot?.share?.available ? <AutoSharePanel state={share} api={api} run={run} busy={busy} connected={connected} /> : boot?.forward?.available && <ForwardPanel api={api} run={run} busy={busy} allowed={allowed && configured && connected && watchReady} running={manualBusy || watchActive || busy.has('watchStart')} suggestedUrl={suggestedUrl} />}</aside>}
    {updatesOpen && <UpdateDialog bridge={bridge} operationActive={operationActive} onClose={()=>setUpdatesOpen(false)}/>}
    {(!settings.configured || settingsOpen) && <ApiSettings settings={settings} bridge={bridge} onSaved={saved} onClose={() => setSettingsOpen(false)} run={run} busy={busy.has('settings') || busy.has('clearKey')} operationActive={operationActive || !watchReady || !sparkReady} watchActive={watchActive} onStopWatch={stopWatch} onOpenDouyin={openDouyin} openingDouyin={busy.has('browserOpen')} connected={connected} operationError={error || connectionError} />}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
