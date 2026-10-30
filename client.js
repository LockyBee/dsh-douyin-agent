window.__ModuleLoader__.load({
  id: 'dsh-douyin-browser-local',
  factory: require => {
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { createElement: h, useEffect, useRef, useState } = React;
    const Button = primitives.Button, Input = primitives.Input || 'input';
    const PREFIX = '/api/douyin-browser';
    const routes = new Set(['/interactions/configure', '/state', '/diagnostics', '/diagnostics/repair', '/watch/schedule', '/watch/options', '/video/configure', '/video/start', '/video/stop', '/browser/open', '/persona/configure', '/model/configure', '/mode/configure', '/watch/start', '/watch/stop', '/spark/configure', '/spark/start', '/spark/stop', '/spark/resolve', '/comments/configure', '/comments/resolve', '/share/configure', '/share/resolve', '/chat/contacts', '/chat/configure', '/chat/start', '/chat/stop', '/chat/prepare', '/chat/resolve', '/chat/unanswered', '/chat/unanswered/resolve', '/media/configure', '/media/credentials', '/reports/generate']);
    const column = { display: 'flex', flexDirection: 'column', gap: 12 };
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
    const muted = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, margin: 0 };
    const formControl = { font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 9, maxWidth: '100%', width: '100%', boxSizing: 'border-box' };
    const videoPolicyKey = policy => policy && JSON.stringify([Array.isArray(policy.windows) ? [...new Set(policy.windows)] : null, policy.weekendWindows || null, policy.sessionMinutes]);
    const fallbackCategories = { '基础设置': ['人格与兴趣', 'DSH 模型'], '视频观看': ['观看主题', '视频时间与自主观看'], '自检与用量': ['自检与用量'], '好友互动': ['好友互动'], '公开评论': ['自主公开视频评论'], '音频与密钥': ['可选音频'], '观看日报': ['观看日报'] };

    const OPERATIONS = {
      '/bootstrap': '连接本机服务', '/state': '刷新运行状态', '/interactions/state': '读取好友在线状态', '/interactions/configure': '设置好友互动',
      '/browser/open': '打开抖音', '/watch/state': '读取自主观看状态', '/watch/schedule': '设置自动观看', '/watch/options': '保存观看主题', '/watch/start': '开始自主观看', '/watch/stop': '停止自主观看',
      '/video/status': '读取观看时段与用量', '/video/configure': '保存观看时段与额度', '/video/start': '开始观看', '/video/stop': '结束观看',
      '/chat/state': '读取自动回复状态', '/chat/contacts': '读取当前会话列表', '/chat/configure': '保存许可名单', '/chat/start': '启动自动回复', '/chat/stop': '停止自动回复', '/chat/prepare': '准备回复通道', '/chat/resolve': '解除会话暂停', '/chat/unanswered': '读取遗留待处理消息', '/chat/unanswered/resolve': '标记遗留待处理消息',
      '/share/state': '读取分享状态', '/share/configure': '设置自主分享', '/share/resolve': '核对分享结果', '/comments/state': '读取评论状态', '/comments/configure': '保存评论设置', '/comments/resolve': '核对评论结果',
      '/mode/state': '读取静默观看设置', '/mode/configure': '保存静默观看设置', '/media/state': '读取音频设置', '/media/configure': '保存音频设置', '/media/credentials': '保存音频密钥',
      '/persona': '读取人格', '/persona/card': '保存人格', '/persona/configure': '保存人格', '/model/configure': '保存模型设置', '/task/limits': '读取任务额度', '/task/limits/configure': '保存任务额度',
      '/task': '提交对话任务', '/stop': '停止对话任务', '/forward/contacts': '读取转发会话', '/forward': '转发作品', '/memory': '检索共享记忆',
      '/usage': '读取用量', '/diagnostics': '一键自检', '/diagnostics/repair': '修复自检问题', '/reports/generate': '生成观看日报', '/reports/read': '读取观看日报', '/reports/state': '读取日报目录',
    };

    function requestOperation(route, body) {
      const path = route.split('?')[0].replace(/^\/api/, '');
      if (path === '/task/limits' && body !== undefined) return '保存任务额度';
      if (path === '/watch/schedule' && typeof body?.enabled === 'boolean') return body.enabled ? '开始自主观看' : '暂停观看';
      return OPERATIONS[path] || '本机操作';
    }

    function requestFailure(failure, operation, { timeoutMs, write = false, signal } = {}) {
      failure = failure || new Error('操作未完成。');
      if (failure.operation) return failure;
      const timedOut = !Number.isInteger(failure.status) && (failure.name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError' || /^(?:signal timed out|the operation was aborted due to timeout)\.?$/i.test(failure.message || ''));
      const cancelled = failure.name === 'AbortError';
      const transport = timedOut || cancelled || Boolean(timeoutMs && (failure instanceof TypeError || failure.name === 'TypeError'));
      const detail = timedOut ? `等待本机服务超时${timeoutMs ? `（${Math.round(timeoutMs / 1000)} 秒）` : ''}。` : cancelled ? '请求已取消。' : transport ? '未能连接本机服务。' : /^signal timed out\.?$/i.test(failure.message || '') ? `服务处理超时（${failure.message}）。` : failure.message || '操作未完成。';
      const error = new Error(`${operation}：${detail}${transport && write ? '请求结果尚未确认，请先刷新状态核对，勿重复提交。' : ''}`);
      error.operation = operation; error.requestError = transport; error.unconfirmed = transport && write;
      if (failure.status !== undefined) error.status = failure.status;
      if (failure.code !== undefined) error.code = failure.code;
      return error;
    }

    function operationLabel(name) {
      return ({ browserOpen:'打开抖音', browser:'打开抖音', refresh:'刷新连接', task:'提交对话任务', stop:'停止对话任务', settings:'保存模型设置', clearKey:'移除模型密钥', openMemory:'打开记忆文件夹', memory:'检索共享记忆', watchSchedule:'设置自动观看', schedule:'设置自动观看', interactions:'设置好友互动', chatList:'读取当前会话列表', chatPrepare:'准备回复通道', forwardList:'读取转发会话', forward:'转发作品', personaReload:'载入最新人格', diagnostics:'一键自检或修复', reportGenerate:'生成观看日报', reportRead:'读取观看日报' })[name] || (/^resolve-|^chatResolve:/.test(name) ? '解除会话暂停' : name.startsWith('key:') ? '保存音频密钥' : '本机操作');
    }

    function createSettingsTransport(globals = globalThis, rpc = globals.__DSH_TRANSPORT__?.rpc) {
      const carrier = globals.__DSH_TRANSPORT__;
      const address = globals.location;
      const http = address && ['http:', 'https:'].includes(address.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
      const desktop = ['dsh-app:', 'dsh:'].includes(address?.protocol) && address.hostname === 'app';
      const fetcher = typeof carrier?.fetch === 'function' ? carrier.fetch.bind(carrier) : (http || desktop) && typeof globals.fetch === 'function' ? globals.fetch.bind(globals) : null;
      let token = '';
      const writing = new Set();
      return {
        async request(route, input) {
          if (!routes.has(route) && !/^\/reports\/read\?date=\d{4}-\d{2}-\d{2}$/.test(route)) throw new Error('只允许本插件的原生设置接口。');
          if (!fetcher && typeof rpc?.call !== 'function') throw new Error('当前 DSH 页面没有可用的插件设置通信接口。请更新插件后完全退出并重开 DSH；若仍失败，请核对 DSH 版本与来源。可点击“刷新插件状态”重试。');
          if (input !== undefined && !token) throw new Error('请先刷新原生设置页，核实当前状态。');
          if (route === '/chat/unanswered' && !token) throw new Error('请先刷新原生设置页，核实当前状态。');
          const operation = requestOperation(route, input), write = input !== undefined, timeoutMs = route === '/state' ? 20_000 : 65_000;
          if (write && writing.has(route)) throw Object.assign(new Error(`${operation}正在处理，请等待当前请求完成。`), { operation, code: 'UI_OPERATION_BUSY' });
          if (write) writing.add(route);
          const signal = AbortSignal.timeout(timeoutMs);
          try {
          let response;
          if (!fetcher && typeof rpc?.call === 'function') {
            const reply = await rpc.call('/douyin-settings', 'request', { path: route, ...(input === undefined ? (route === '/chat/unanswered' ? { token } : {}) : { input, token }) }, signal);
            if (!reply?.ok) throw new Error(reply?.error?.message || 'DSH 设置通信失败，请确认插件后端已加载新版；操作不会自动重试。');
            const outcome = reply.value;
            if (!Number.isInteger(outcome?.status) || !outcome.body || typeof outcome.body !== 'object') throw new Error('DSH 设置接口版本不匹配，请完全退出后重开 DSH。');
            response = { status: outcome.status, ok: outcome.status >= 200 && outcome.status < 300, json: async () => outcome.body };
          } else response = await fetcher(PREFIX + route, { method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal, headers: { 'content-type': 'application/json', ...(input !== undefined || route === '/chat/unanswered' ? { 'x-douyin-settings-token': token } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
          let value;
          try { value = await response.json(); }
          catch (failure) { if (signal.aborted || failure.name === 'TimeoutError') throw failure; const error = new Error(`插件设置接口未返回 JSON（HTTP ${response.status || '未知'}）。请检查插件后端是否启用、DSH 的 WebServer 服务及版本兼容性。`); error.status = response.status; throw error; }
          if (!response.ok) { const error = new Error(value.error || '原生设置操作未完成。'); error.status = response.status; throw error; }
          if (route === '/state') { if (typeof value.token !== 'string' || !value.token) throw new Error('原生设置未取得有效会话。'); token = value.token; const { token: hidden, ...state } = value; return state; }
          return value;
          } catch (failure) { throw requestFailure(failure, operation, { timeoutMs, write, signal }); }
          finally { if (write) writing.delete(route); }
        },
      };
    }

    function useAutosave({ value, initial, read, encode, write, canonical = (_result, payload) => payload, available = true }) {
      const [draft, setDraft] = useState(() => value ? read(value) : initial), [status, setStatus] = useState({});
      const current = useRef(draft), dirty = useRef(false), version = useRef(0), ack = useRef(null), timer = useRef(null), writing = useRef(false), queued = useRef(false), requested = useRef(false), alive = useRef(true), options = useRef(null);
      options.current = { read, encode, write, canonical, available };
      const schedule = immediate => { requested.current = true; clearTimeout(timer.current); timer.current = setTimeout(() => { void flush(); }, immediate ? 0 : 600); };
      async function flush() {
        requested.current = true; clearTimeout(timer.current); if (!alive.current || !dirty.current || !options.current.available) return;
        if (writing.current) { queued.current = true; return; }
        let payload; try { payload = options.current.encode(current.current); } catch (error) { setStatus({ kind: 'editing', message: error.message || '填写完整后自动生效。' }); return; }
        const submitted = version.current; writing.current = true; queued.current = false; requested.current = false; setStatus({ kind: 'saving', message: '正在保存…' });
        try { const result = await options.current.write(payload), expected = options.current.canonical(result, payload); if (alive.current && submitted === version.current) { ack.current = { version: submitted, key: JSON.stringify(expected) }; setStatus({ kind: 'saved', message: '已保存，等待状态同步。' }); } }
        catch (error) { if (alive.current) setStatus({ kind: 'error', message: `${error.message || '保存失败。'} 草稿已保留。` }); }
        finally { writing.current = false; if (alive.current && queued.current) schedule(true); }
      }
      function edit(patch, { immediate = false, blurOnly = false } = {}) {
        current.current = { ...current.current, ...patch }; version.current++; dirty.current = true; ack.current = null; setDraft(current.current); setStatus({ kind: 'editing', message: blurOnly ? '离开输入框后自动保存。' : '修改后自动保存。' }); clearTimeout(timer.current); requested.current = !blurOnly; if (blurOnly) queued.current = false; else schedule(immediate);
      }
      useEffect(() => {
        if (!value) return; let incoming, key; try { incoming = options.current.read(value); key = JSON.stringify(options.current.encode(incoming)); } catch { return; }
        if (ack.current?.version === version.current && ack.current.key === key) { dirty.current = false; ack.current = null; setStatus({ kind: 'saved', message: '已生效。' }); }
        if (!dirty.current && !writing.current) { current.current = incoming; setDraft(incoming); }
      }, [value]);
      useEffect(() => { if (available && requested.current && dirty.current) schedule(true); }, [available]);
      useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
      return { draft, edit, flush, status };
    }

    function SettingsPage({ rpc } = {}) {
      const [api] = useState(() => createSettingsTransport(globalThis, rpc));
      const [state, setState] = useState(null), [ready, setReady] = useState(false), [connectionError, setConnectionError] = useState(''), [notice, setNotice] = useState(''), [category, setCategory] = useState('基础设置');
      const [operationErrors, setOperationErrors] = useState({});
      const [busy, setBusy] = useState(new Set()), [contacts, setContacts] = useState(null), [discovery, setDiscovery] = useState(null), [diagnostics, setDiagnostics] = useState(null), [repairResult, setRepairResult] = useState(''), [report, setReport] = useState(null), [reportDate, setReportDate] = useState('');
      const [credentials, setCredentials] = useState({ mimo: '', minimax: '' }), [keyStatus, setKeyStatus] = useState({}), [reviews, setReviews] = useState(new Set());
      const existingAuthorization = useRef(false); const alive = useRef(true), refreshing = useRef(null), refreshAgain = useRef(false), locks = useRef(new Set()), submitted = useRef(new Set()), keyValues = useRef(credentials);
      const active = value => value?.running || value?.starting || value?.busy || value?.worker?.alive;
      const operationActive = active(state?.watch) || state?.chat?.starting || state?.chat?.busy || state?.share?.busy;
      async function refresh(fresh = false) {
        if (refreshing.current) { if (fresh) refreshAgain.current = true; return refreshing.current; }
        const work = (async () => {
          let latest;
          do {
            refreshAgain.current = false;
            try { const value = await api.request('/state'); if (alive.current && !refreshAgain.current) { latest = value; setState(value); setReady(true); setConnectionError(''); } }
            catch (failure) { if (alive.current && !refreshAgain.current) { setReady(false); setConnectionError(failure.message); } }
          } while (alive.current && refreshAgain.current);
          return latest;
        })();
        refreshing.current = work; try { return await work; } finally { if (refreshing.current === work) refreshing.current = null; }
      }
      useEffect(() => { alive.current = true; void refresh(); const timer = setInterval(() => { void refresh(); }, 2500); return () => { alive.current = false; clearInterval(timer); }; }, [api]);
      useEffect(() => { if (!reportDate && state?.reports?.date) setReportDate(state.reports.date); }, [state]);
      const write = route => async payload => { const result = await api.request(route, payload); void refresh(true); return result; };
      const list = text => String(text || '').split(/[\n,;，；]+/).map(item => item.trim()).filter(Boolean);
      const positive = (value, label) => { const number = Number(value); if (String(value).trim() === '' || !Number.isSafeInteger(number) || number < 1) throw new Error(`${label}请填写正整数。`); return number; };
      const model = useAutosave({ value: state?.model, initial: { provider: '', model: '' }, read: value => ({ provider: value.provider || '', model: value.model || '' }), encode: value => { if (!value.provider || !value.model) throw new Error('请选择提供商和模型。'); return value; }, write: write('/model/configure'), available: ready && !operationActive });
      const persona = useAutosave({ value: state?.persona, initial: { content: '', expectedRevision: null }, read: value => ({ content: value.manualText || '', expectedRevision: value.revision }), encode: value => value, write: write('/persona/configure'), canonical: (saved, payload) => saved?.revision ? { content: saved.manualText || '', expectedRevision: saved.revision } : payload, available: ready && !operationActive });
      const readVideo = snapshot => { const policy = snapshot?.policy || {}, minutes = Object.hasOwn(policy, 'dailyMinutes') ? policy.dailyMinutes : Object.hasOwn(policy, 'sessionMinutes') ? policy.sessionMinutes : 10, requests = Object.hasOwn(policy, 'dailyRequests') ? policy.dailyRequests : 30; return { windows: (policy.windows || ['00:00-24:00']).join('\n'), weekendAll: policy.weekendWindows?.join() === '00:00-24:00', dailyMinutes: minutes ?? '', unlimitedMinutes: minutes === null, dailyRequests: requests ?? '', unlimitedRequests: requests === null }; };
      const encodeVideo = value => { const windows = list(value.windows); if (!windows.length || windows.some(item => !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(item))) throw new Error('时段请填写完整的 HH:MM-HH:MM。'); return { windows, weekendWindows: value.weekendAll ? ['00:00-24:00'] : null, dailyMinutes: value.unlimitedMinutes ? null : positive(value.dailyMinutes, '每日观看分钟数'), dailyRequests: value.unlimitedRequests ? null : positive(value.dailyRequests, '每日模型请求次数') }; };
      const video = useAutosave({ value: state?.video, initial: readVideo(null), read: readVideo, encode: encodeVideo, write: write('/video/configure'), canonical: (saved, payload) => saved?.policy ? encodeVideo(readVideo(saved)) : payload, available: ready });
      const readTopics = value => ({ mode: value?.policy?.mode || 'recommend', topics: (value?.policy?.topics || []).join('\n'), exclude: (value?.policy?.exclude || []).join('\n') });
      const topics = useAutosave({ value: state?.watchOptions, initial: readTopics(null), read: readTopics, encode: value => ({ mode: value.mode, topics: list(value.topics), exclude: list(value.exclude) }), write: write('/watch/options'), canonical: (saved, payload) => saved?.policy ? { mode: saved.policy.mode, topics: saved.policy.topics || [], exclude: saved.policy.exclude || [] } : payload, available: ready });
      const mode = useAutosave({ value: state?.mode, initial: { silent: false }, read: value => ({ silent: value?.silent === true }), encode: value => value, write: write('/mode/configure'), canonical: (saved, payload) => typeof saved?.silent === 'boolean' ? { silent: saved.silent } : payload, available: ready });
      const comments = useAutosave({ value: state?.comments, initial: { enabled: false, dailyLimit: 3, perSessionLimit: 1 }, read: value => ({ enabled: value.enabled === true, dailyLimit: value.policy?.dailyLimit ?? 3, perSessionLimit: value.policy?.perSessionLimit ?? 1 }), encode: value => ({ enabled: value.enabled, dailyLimit: positive(value.dailyLimit, '每日评论次数'), perSessionLimit: positive(value.perSessionLimit, '每次观看评论次数') }), write: write('/comments/configure'), canonical: (saved, payload) => saved?.policy ? { enabled: saved.enabled === true, dailyLimit: saved.policy.dailyLimit, perSessionLimit: saved.policy.perSessionLimit } : payload, available: ready });
      const media = useAutosave({ value: state?.media, initial: { enabled: false, backend: 'local-whisper' }, read: value => ({ enabled: value.enabled === true, backend: value.backend || 'local-whisper' }), encode: value => value, write: write('/media/configure'), available: ready });
      const readChat = value => ({ recipientIds: (value?.policy?.allowlist || []).map(item => item.id), allowConversationOnly: existingAuthorization.current || (value?.policy?.allowlist || []).some(item => ['existing-conversation', 'existing-group'].includes(item.authorizationKind)), groupMentionNamesText: (value?.policy?.groupMentionNames || ['大肥鱼']).join('\n') });
      const encodeChat = value => ({ recipientIds: value.recipientIds, allowConversationOnly: value.allowConversationOnly, groupMentionNames: list(value.groupMentionNamesText) });
      const chat = useAutosave({ value: state?.chat, initial: readChat(null), read: readChat, encode: encodeChat, write: write('/chat/configure'), canonical: (saved, payload) => saved?.policy ? encodeChat(readChat(saved)) : payload, available: ready });
      const shownContacts = [...new Map([...(state?.chat?.policy?.allowlist || []).map(item => ({ ...item, notListed: Boolean(contacts) && !contacts.some(found => found.id === item.id) })), ...(contacts || [])].map(item => [item.id, item])).values()];
      async function perform(key, action) {
        if (!ready || locks.current.has(key)) return; locks.current.add(key); setBusy(new Set(locks.current)); setNotice('');
        setOperationErrors(old => { const next = { ...old }; delete next[key]; return next; });
        try { const value = await action(); if (alive.current) setNotice(`${operationLabel(key)}已完成。`); await refresh(true); return value; }
        catch (failure) { if (alive.current) { const detail = requestFailure(failure, operationLabel(key)); setOperationErrors(old => ({ ...old, [key]: { message: detail.message, requestError: detail.requestError === true, unconfirmed: detail.unconfirmed === true } })); } await refresh(true); }
        finally { locks.current.delete(key); if (alive.current) setBusy(new Set(locks.current)); }
      }
      const button = (label, key, action, disabled = false, needsReady = true) => h(Button, { type: 'button', size: 'sm', variant: 'outline', disabled: (needsReady && !ready) || busy.has(key) || disabled, onClick: action }, busy.has(key) ? '处理中…' : label);
      const note = text => text ? h('p', { style: muted }, text) : null;
      const status = form => form.status.message && h('p', { role: form.status.kind === 'error' ? 'alert' : 'status', style: muted }, form.status.message);
      const section = (title, ...children) => h('section', { role: 'tabpanel', 'aria-label': title, style: { ...column, marginBottom: 24 } }, h('h3', null, title), ...children);
      const field = (label, form, key, extra = {}) => h('label', { style: column }, h('span', null, label), h(Input, { 'aria-label': label, value: form.draft[key], disabled: !ready, onChange: event => form.edit({ [key]: event.target.value }), ...extra }));
      const area = (label, form, key, rows = 2, blurOnly = false, disabled = false) => h('label', { style: column }, label, h('textarea', { 'aria-label': label, rows, value: form.draft[key], disabled: !ready || disabled, style: formControl, onChange: event => form.edit({ [key]: event.target.value }, { blurOnly }), onBlur: blurOnly ? () => { void form.flush(); } : undefined }));
      const toggle = (label, checked, onChange, disabled = false) => h('label', { style: row }, h('input', { type: 'checkbox', 'aria-label': label, checked: checked === true, disabled: !ready || disabled, onChange: event => onChange(event.target.checked) }), label);
      const select = (label, value, options, onChange, disabled = false) => h('label', { style: column }, label, h('select', { 'aria-label': label, value, style: formControl, disabled: !ready || disabled, onChange: event => onChange(event.target.value) }, ...options.map(([key, text]) => h('option', { key, value: key }, text))));
      const reviewList = kind => (state?.[kind]?.needsReview || []).map(item => { const key = `${kind}:${item.operationId}`; return h('div', { key, style: column }, note(`待核对：${item.videoId ? `作品 ${item.videoId}` : '消息'} · ${item.status || ''}`), submitted.current.has(key) ? note('核对结果已提交，等待回读。') : h('div', { style: row }, ...[['confirmed', '已核对发送成功'], ['not-sent', '已核对未发送']].map(([outcome, label]) => button(label, key, () => { submitted.current.add(key); setReviews(new Set(submitted.current)); void perform(key, async () => { try { return await api.request(`/${kind}/resolve`, { operationId: item.operationId, outcome }); } catch (error) { submitted.current.delete(key); setReviews(new Set(submitted.current)); throw error; } }); }, state?.[kind]?.busy)))); });
      const shareFailureMessage = item => typeof item?.failure?.message === 'string' && item.failure.message.trim() ? item.failure.message : item?.status === 'not-sent' ? '旧记录没有保存详细失败原因。' : '';
      function credentialForm(backend, label) {
        return h('div', { style: column }, h('label', { style: column }, `${label} API Key`, h(Input, { 'aria-label': `${label} API Key`, type: 'password', autoComplete: 'off', maxLength: 4096, value: credentials[backend], disabled: !ready || operationActive || busy.has(`key:${backend}`), onChange: event => { keyValues.current = { ...keyValues.current, [backend]: event.target.value }; setCredentials(keyValues.current); }, onBlur: () => { const secret = keyValues.current[backend].trim(); if (!secret) return; void perform(`key:${backend}`, async () => { const result = await api.request('/media/credentials', { backend, apiKey: secret }); if (keyValues.current[backend].trim() === secret) { keyValues.current = { ...keyValues.current, [backend]: '' }; setCredentials(keyValues.current); } setKeyStatus(old => ({ ...old, [backend]: 'Key 已保存，不回显。' })); return result; }); } })), note(keyStatus[backend] || (state?.media?.backends?.[backend]?.credential?.configured ? '已配置；填写新 Key 后离开输入框即可替换。' : '填写 Key，离开输入框后保存。')));
      }
      const friendEnabled = state?.interactions?.policy?.enabled === true, watchEnabled = state?.schedule?.policy?.enabled === true;
      const presence = ready ? state?.interactions?.presence : null, replyPresence = presence?.reply || presence, watchState = presence?.watch, presenceLabel = replyPresence?.label || '状态待核实', presenceReason = replyPresence?.reason || '正在读取好友回复服务状态。', watchLabel = watchState?.active ? watchState.label : '';
      return h('div', { style: { ...column, maxWidth: 900, paddingBottom: 32 } },
        h('h2', null, '大肥鱼抖音助手'), !ready && h('p', { role: 'status' }, '正在核实插件状态。'), connectionError && h('p', { role: 'alert' }, connectionError),
        ...Object.entries(operationErrors).map(([key, failure]) => h('div', { key, role: 'alert', style: row }, h('span', null, `${failure.requestError ? '上次操作：' : ''}${failure.message}${failure.requestError && ready ? failure.unconfirmed ? ' 本机服务当前已连接；请核对上述操作是否生效。' : ' 本机服务当前已连接。' : ''}`), h('button', { type: 'button', 'aria-label': `清除${operationLabel(key)}提示`, onClick: () => setOperationErrors(old => { const next = { ...old }; delete next[key]; return next; }) }, '×'))), notice && h('p', { role: 'status' }, notice),
        h('div', { role: 'status', 'aria-live': 'polite', style: { ...row, position: 'sticky', top: 0, zIndex: 5, background: 'var(--dsw-alias-bg-base, #fff)', padding: '8px 0' }, title: [presenceReason, watchState?.active ? watchState.reason : ''].filter(Boolean).join(' ') }, h('span', { 'aria-label': '好友互动状态', title: presenceReason, style: { border: '1px solid currentColor', borderRadius: 20, padding: '6px 12px', whiteSpace: 'nowrap' } }, `${replyPresence?.online === true ? '●' : '○'} ${presenceLabel}`), watchState?.active && h('small', { role: 'status', 'aria-label': '自主观看状态', title: watchState.reason, style: muted }, `◉ ${watchLabel}`), (['attention', 'preparing'].includes(replyPresence?.status) || watchState?.active && replyPresence?.online !== true) && h('small', { role: replyPresence?.status === 'attention' ? 'alert' : 'status', style: muted }, presenceReason)),
        h('div', { style: row }, button('刷新插件状态', 'refresh', () => { void refresh(); }, false, false), button('打开抖音', 'browser', () => { void perform('browser', () => api.request('/browser/open', {})); })),
        h('div', { role: 'tablist', 'aria-label': '抖音设置分类', style: row }, ...Object.keys(fallbackCategories).map(name => h(Button, { key: name, role: 'tab', type: 'button', size: 'sm', variant: category === name ? 'primary' : 'outline', 'aria-selected': category === name, onClick: () => setCategory(name) }, name))),
        category === '基础设置' && h('div', null,
          section('DSH 模型', select('模型提供商', model.draft.provider, [['', '请选择 DSH 提供商'], ...(state?.model?.providers || []).map(item => [item.id, item.name || item.id])], provider => model.edit({ provider, model: '' }, { immediate: true }), operationActive), select('模型名称', model.draft.model, [['', '请选择模型'], ...(state?.model?.models || []).filter(item => item.provider === model.draft.provider).map(item => [item.id, item.name || item.id])], value => model.edit({ model: value }, { immediate: true }), operationActive), status(model), note(state?.model?.configured ? '模型已配置。' : '请选择已配置的 DSH 模型。')),
          section('人格与兴趣', area('大肥鱼人格正文', persona, 'content', 14, true, operationActive), status(persona), persona.status.kind === 'error' && button('载入最新人格（替换草稿）', 'personaReload', () => { void perform('personaReload', async () => { const latest = await refresh(true); if (!latest?.persona?.revision) throw new Error('未读到最新人格，原草稿已保留。'); persona.edit({ content: latest.persona.manualText || '', expectedRevision: latest.persona.revision }, { blurOnly: true }); return latest.persona; }); }), note('离开输入框后保存。插件与软件共用人格，未保存草稿不会被轮询覆盖。'), note(state?.persona?.personaFolder))),
        category === '视频观看' && h('div', null,
          section('视频观看', toggle('允许自动观看', watchEnabled, enabled => { void perform('schedule', () => api.request('/watch/schedule', { enabled })); }, typeof state?.schedule?.policy?.enabled !== 'boolean' || busy.has('schedule')), note('在允许时段内自动观看，离开时段或用完每日预算会停止。DSH 需保持运行。'),
            h('div', { style: row }, button('开始自主观看', 'schedule', () => { void perform('schedule', () => api.request('/watch/schedule', { enabled: true })); }, typeof state?.schedule?.policy?.enabled !== 'boolean' || typeof state?.watch?.running !== 'boolean' || !state?.model?.configured || active(state?.watch) || state?.schedule?.busy), button('暂停观看', 'schedule', () => { void perform('schedule', () => api.request('/watch/schedule', { enabled: false })); }, typeof state?.schedule?.policy?.enabled !== 'boolean' || typeof state?.watch?.running !== 'boolean' || !watchEnabled && !active(state?.watch) && !state?.schedule?.busy)),
            note('不在允许时段会等待；按钮与开关共用设置，每日已用时长和模型次数不会重置。'),
            h('div', { style: row }, button('谷时段（DeepSeek）', 'valley', () => video.edit({ windows: '00:00-09:00\n12:00-14:00\n18:00-24:00', weekendAll: true }, { immediate: true })), button('全天', 'all', () => video.edit({ windows: '00:00-24:00', weekendAll: false }, { immediate: true })), button('晚间 20–22 点', 'evening', () => video.edit({ windows: '20:00-22:00', weekendAll: false }, { immediate: true }))), toggle('周末全天允许', video.draft.weekendAll, value => video.edit({ weekendAll: value }, { immediate: true })), area('每日允许视频时段（北京时间）', video, 'windows'),
            h('details', null, h('summary', null, '高级选项'), toggle('不限每日观看时长', video.draft.unlimitedMinutes, value => video.edit({ unlimitedMinutes: value }, { immediate: true })), field('每日观看上限（分钟）', video, 'dailyMinutes', { type: 'number', min: 1, value: video.draft.unlimitedMinutes ? '' : video.draft.dailyMinutes, placeholder: video.draft.unlimitedMinutes ? '不限；输入分钟数可设置上限' : '正整数分钟数', onChange: event => video.edit({ dailyMinutes: event.target.value, ...(event.target.value !== '' ? { unlimitedMinutes: false } : {}) }) }), toggle('不限每日模型请求次数', video.draft.unlimitedRequests, value => video.edit({ unlimitedRequests: value }, { immediate: true })), field('每日观看模型请求上限', video, 'dailyRequests', { type: 'number', min: 1, value: video.draft.unlimitedRequests ? '' : video.draft.dailyRequests, placeholder: video.draft.unlimitedRequests ? '不限；输入次数可设置上限' : '正整数次数', onChange: event => video.edit({ dailyRequests: event.target.value, ...(event.target.value !== '' ? { unlimitedRequests: false } : {}) }) })), status(video), note(`今日已观看 ${Math.floor(state?.video?.daily?.usedSeconds || 0)} 秒 · 已请求 ${state?.video?.daily?.requests || 0} 次模型。`), note(state?.video?.reason), note(state?.schedule?.lastError), state?.watch?.lastError && h('p', { role: 'status' }, `上次自主观看停止原因：${state.watch.lastError}`)),
          section('观看主题', select('观看方式', topics.draft.mode, [['recommend', '自主挑选推荐'], ['topic', '围绕指定主题观看']], value => topics.edit({ mode: value }, { immediate: true })), area('想看的主题，每行一个', topics, 'topics'), area('排除关键词，每行一个', topics, 'exclude'), status(topics)),
          section('静默观看', toggle('静默观看', mode.draft.silent, value => mode.edit({ silent: value }, { immediate: true })), status(mode), note(state?.mode?.application?.message || state?.mode?.note))),
        category === '好友互动' && section('好友互动', toggle('允许好友互动', friendEnabled, enabled => { void perform('interactions', () => api.request('/interactions/configure', { enabled })); }, typeof state?.interactions?.policy?.enabled !== 'boolean' || busy.has('interactions')), note('只与下方许可的好友和群聊互动，不设人数和次数上限。模型和名单就绪后自动准备回复；观看中可自主分享。群聊仅在被 @ 或叫到响应昵称时回复。'), note(state?.interactions?.friend?.message), state?.interactions?.friend?.lastError && h('p', { role: 'alert' }, state.interactions.friend.lastError),
          state?.interactions?.friend?.waitReason && note(`${state.interactions.friend.preparing ? '正在准备：' : '等待准备：'}${state.interactions.friend.waitReason}${state.interactions.friend.lastErrorCode ? `（${state.interactions.friend.lastErrorCode}）` : ''}${state.interactions.friend.nextRetryAt ? ` · 下次自动检查 ${new Date(state.interactions.friend.nextRetryAt).toLocaleString('zh-CN', { hour12: false })}` : ''}`),
          state?.interactions?.friend?.waitReason && h('div', { style: row }, h(Button, { type: 'button', size: 'sm', variant: 'outline', disabled: !ready || busy.has('chatPrepare') || state.interactions.friend.canPrepare === false, onClick: () => { void perform('chatPrepare', () => api.request('/chat/prepare', {})); } }, busy.has('chatPrepare') || state.interactions.friend.preparing ? '正在准备…' : '准备回复通道/重新连接并重试')),
          button('读取联系人与群聊', 'chatList', () => { void perform('chatList', async () => { const result = await api.request('/chat/contacts', {}); if (result.blocked || result.loginRequired || result.verificationRequired || !Array.isArray(result.contacts)) throw new Error('请在专用浏览器完成登录或验证。'); setContacts(result.contacts); setDiscovery(result.listDiscovery || null); return result; }); }, chat.status.kind === 'saving'),
          note('读取范围是抖音网页版当前会话，不代表全部关注好友或所有群。要授权群聊，请先让群会话出现在抖音消息列表，再刷新。'), contacts && note(`本次读取：个人 ${contacts.filter(item => item.isGroup === false).length} 个 · 群聊 ${contacts.filter(item => item.isGroup === true).length} 个。${discovery?.scannedToEnd === false ? ` 当前列表尚未完整读取。${discovery.reason || ''}` : ''}`),
          contacts?.some(item => item.relationshipStatus === 'unavailable' || item.isGroup === true || typeof item.isGroup !== 'boolean') && toggle('授权已核对的现有会话', chat.draft.allowConversationOnly, value => { existingAuthorization.current = value; chat.edit({ allowConversationOnly: value, ...(!value ? { recipientIds: chat.draft.recipientIds.filter(id => shownContacts.some(item => item.id === id && item.followed === true && item.isGroup === false)) } : {}) }, value ? { blurOnly: true } : { immediate: true }); }),
          ...[false, true, null].flatMap(kind => { const items = shownContacts.filter(item => item.isGroup === kind || kind === null && typeof item.isGroup !== 'boolean'); return items.length ? [note(kind === false ? '个人会话' : kind === true ? '群聊（仅被 @ 或叫到响应昵称时回复）' : '旧记录类型待核对（暂不可选）'), ...items.map(item => h('label', { key: item.id, style: row }, h('input', { type: 'checkbox', 'aria-label': `许可联系人 ${item.name || item.displayName || '联系人'}`, checked: chat.draft.recipientIds.includes(item.id), disabled: !ready || !chat.draft.recipientIds.includes(item.id) && (item.notListed || !(item.followed === true && item.isGroup === false || chat.draft.allowConversationOnly === true && typeof item.isGroup === 'boolean')), onChange: event => chat.edit({ recipientIds: event.target.checked ? [...chat.draft.recipientIds, item.id] : chat.draft.recipientIds.filter(id => id !== item.id) }, { immediate: true }) }), item.name || item.displayName || '许可会话'))] : []; }),
          area('群聊响应昵称（逗号或换行分隔）', chat, 'groupMentionNamesText', 2, true), status(chat), note(`今日回复模型请求 ${state?.chat?.daily?.requests || 0} 次 · 今日分享 ${state?.share?.daily?.attempts || 0} 次。未确认发送会暂停，不自动重发。`), ...(state?.chat?.contacts || []).filter(item => item.identityReviewRequired === true || item.recovery?.requiresUserAction === true || /登录|验证码|未授权|许可.*(?:不足|失效|撤销)|身份.*(?:变化|不一致|未通过|不明|不足)/.test(item.reason || '') || ['paused', 'delivery-uncertain'].includes(item.status) && !(item.recovery?.autoPendingCount > 0 || item.recovery?.autoRetryCount > 0)).map(item => h('div', { key: item.id }, note(item.reason || '该会话暂缓处理，状态会继续更新。'), item.identityReviewRequired === true && note('请重新读取联系人并确认许可名单；身份未通过前不会发送。'))), ...(state?.share?.unavailableRecipients || []).map(item => note(`暂不能自主分享：${item.name || '许可会话'} · ${item.reason}`)), ...reviewList('share'), h('details', null, h('summary', null, '回复处理记录'), h('pre', { style: { whiteSpace: 'pre-wrap' } }, JSON.stringify({ recovery: state?.chat?.recovery, contacts: (state?.chat?.contacts || []).map(item => ({ id: item.id, status: item.status, reason: item.reason, recovery: item.recovery, pending: Boolean(item.pending), unanswered: item.unanswered?.length || 0 })), events: state?.chat?.events || [] }, null, 2))), h('details', null, h('summary', null, '最近分享记录'), ...(state?.share?.recent || []).slice().reverse().map(item => h('div', { key: item.operationId }, note(`作品 ${item.videoId} · ${state?.share?.inProgress && state.share.activity?.operationId === item.operationId ? '正在分享' : ({ confirmed: '已确认送达', 'not-sent': '未发出', uncertain: '送达未确认', reserved: '已预留，待核对', clicking: '处理中，待核对', 'resolved-confirmed': '人工已确认送达', 'resolved-not-sent': '人工已确认未送达' }[item.status] || item.status)}`), shareFailureMessage(item) && note(`原因：${shareFailureMessage(item)}`))))),
        category === '公开评论' && section('自主公开视频评论', toggle('允许自主发布评论', comments.draft.enabled, value => comments.edit({ enabled: value }, { immediate: true })), field('评论每日尝试上限', comments, 'dailyLimit', { type: 'number', min: 1 }), field('评论每次观看尝试上限', comments, 'perSessionLimit', { type: 'number', min: 1 }), status(comments), note(`今日已尝试 ${state?.comments?.daily?.attempts || 0} 次。`), ...reviewList('comments')),
        category === '音频与密钥' && section('可选音频', toggle('读取视频声音', media.draft.enabled, value => media.edit({ enabled: value }, { immediate: true })), select('音频后端', media.draft.backend, [['local-whisper', '本机 Whisper'], ['mimo', 'MiMo'], ['minimax', 'MiniMax']], value => media.edit({ backend: value }, { immediate: true })), status(media), note('Key 离开输入框后保存；保存 Key 不会开启音频或下载模型。'), credentialForm('mimo', 'MiMo'), credentialForm('minimax', 'MiniMax')),
        category === '观看日报' && section('观看日报', note(state?.reports?.folder), button('生成今天日报', 'reportGenerate', () => { void perform('reportGenerate', async () => { const value = await api.request('/reports/generate', {}); setReport(value); return value; }); }), h('label', { style: column }, '日报日期', h('input', { type: 'date', 'aria-label': '日报日期', style: formControl, value: reportDate, onChange: event => setReportDate(event.target.value) })), button('读取所选日报', 'reportRead', () => { void perform('reportRead', async () => { if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error('请选择有效日期。'); const value = await api.request(`/reports/read?date=${reportDate}`); setReport(value); return value; }); }), report && h('pre', { 'aria-label': '日报内容', style: { whiteSpace: 'pre-wrap' } }, report.markdown || '暂无内容')),
        category === '自检与用量' && section('自检与用量', button('一键自检', 'diagnostics', () => { void perform('diagnostics', async () => { const value = await api.request('/diagnostics', {}); setDiagnostics(value); setRepairResult(''); return value; }); }), diagnostics && h('div', { style: column }, ...(diagnostics.checks || []).map(item => h('div', { key: item.id }, note(`${({ pass: '通过', warning: '待核对', fail: '未通过' })[item.status]} · ${item.label}：${item.message} [${item.code || ''}]`), ...(item.resolution?.steps || []).map(step => note(step)))), ...(diagnostics.repairableActions || []).map(action => button(`修复：${action.label}`, 'diagnostics', () => { void perform('diagnostics', async () => { const value = await api.request('/diagnostics/repair', { reportId: diagnostics.reportId, action: action.id }); setDiagnostics(value.after); setRepairResult(value.message); return value; }); })), note(repairResult), h('details', null, h('summary', null, '查看或复制诊断报告'), h('textarea', { 'aria-label': '诊断报告', readOnly: true, rows: 12, style: formControl, value: JSON.stringify(diagnostics, null, 2) }))), h('h3', null, '今日用量'), note(`模型响应 ${state?.usage?.today?.requests || 0} 次 · 已报告 ${state?.usage?.today?.totalTokens || 0} Token`), note(`输入 ${state?.usage?.today?.promptTokens || 0} · 输出 ${state?.usage?.today?.completionTokens || 0} · 缓存命中 ${state?.usage?.today?.cacheReportedRequests ? state.usage.today.cachedTokens : '未报告'} · 用量未知 ${state?.usage?.today?.unknownRequests || 0} 次`), state?.usage?.inFlight > 0 && note(`请求中 ${state.usage.inFlight} 次，Token 等模型返回后记录。`), ...(state?.usage?.groups || []).map(item => note(`${item.model} · ${item.requests} 次响应 · ${item.totalTokens} Token`)), note(state?.usage?.note))
      );
    }

    function apply(ctx) {
      let rpc;
      try { rpc = (ctx.get?.('connection') || ctx.connection)?.rpc; } catch {}
      const Page = rpc ? () => h(SettingsPage, { rpc }) : SettingsPage;
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'douyin-browser', order: 16, label: () => '刷抖音' }, Page));
    }
    return { name: 'douyin-browser-settings', inject: ['slots', 'connection'], apply, SettingsPage, createSettingsTransport };
  },
});
