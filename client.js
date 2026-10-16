window.__ModuleLoader__.load({
  id: 'dsh-douyin-browser-local',
  factory: require => {
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { createElement: h, useEffect, useRef, useState } = React;
    const Button = primitives.Button, Input = primitives.Input || 'input';
    const PREFIX = '/api/douyin-browser';
    const routes = new Set(['/state', '/video/configure', '/video/start', '/video/stop', '/browser/open', '/persona/configure', '/model/configure', '/mode/configure', '/watch/start', '/watch/stop', '/spark/configure', '/spark/start', '/spark/stop', '/spark/resolve', '/comments/configure', '/comments/resolve', '/share/configure', '/share/resolve', '/chat/contacts', '/chat/configure', '/chat/start', '/chat/stop', '/chat/resolve', '/media/configure', '/media/credentials', '/reports/generate']);
    const column = { display: 'flex', flexDirection: 'column', gap: 12 };
    const row = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
    const muted = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, margin: 0 };
    const formControl = { font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 9, maxWidth: '100%', width: '100%', boxSizing: 'border-box' };
    const categories = { '基础设置': ['人格与兴趣', 'DSH 模型'], '视频观看': ['视频时间与自主观看'], '好友互动': ['自动续火花', '自主分享作品', '许可好友与自动回复'], '公开评论': ['自主公开视频评论'], '音频与密钥': ['可选音频'], '观看日报': ['观看日报'] };

    function createSettingsTransport(globals = globalThis) {
      const carrier = globals.__DSH_TRANSPORT__;
      const address = globals.location;
      const http = address && address.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
      const fetcher = typeof carrier?.fetch === 'function' ? carrier.fetch.bind(carrier) : http && typeof globals.fetch === 'function' ? globals.fetch.bind(globals) : null;
      let token = '';
      return {
        async request(route, input) {
          if (!routes.has(route) && !/^\/reports\/read\?date=\d{4}-\d{2}-\d{2}$/.test(route)) throw new Error('只允许本插件的原生设置接口。');
          if (!fetcher) throw new Error('当前 DSH 没有可用的同源设置服务，请使用支持 WebServer 的原生宿主。');
          if (input !== undefined && !token) throw new Error('请先刷新原生设置页，核实当前状态。');
          const response = await fetcher(PREFIX + route, { method: input === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(65_000), headers: { 'content-type': 'application/json', ...(input === undefined ? {} : { 'x-douyin-settings-token': token }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
          const value = await response.json();
          if (!response.ok) { const error = new Error(value.error || '原生设置操作未完成。'); error.status = response.status; throw error; }
          if (route === '/state') { if (typeof value.token !== 'string' || !value.token) throw new Error('原生设置未取得有效会话。'); token = value.token; const { token: hidden, ...state } = value; return state; }
          return value;
        },
      };
    }

    function SettingsPage() {
      const [api] = useState(() => createSettingsTransport());
      const [state, setState] = useState(null), [ready, setReady] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
      const [draft, setDraft] = useState({}), [busy, setBusy] = useState(new Set()), [contacts, setContacts] = useState(null), [report, setReport] = useState(null), [reportDate, setReportDate] = useState('');
      const [personaConflict, setPersonaConflict] = useState(false), [reviews, setReviews] = useState(new Set());
      const [category, setCategory] = useState('基础设置'), [credentials, setCredentials] = useState({ mimo: '', minimax: '' });
      const dirty = useRef(new Set()), locks = useRef(new Set()), personaRevision = useRef(null), stateRef = useRef(null), generation = useRef(0), alive = useRef(true), submitted = useRef(new Set());
      const active = value => value?.running === true || value?.starting === true || value?.busy === true || value?.worker?.alive === true;
      const operationActive = active(state?.watch) || active(state?.spark) || active(state?.chat);
      const runningWatch = active(state?.watch), runningSpark = active(state?.spark), runningChat = active(state?.chat);
      async function refresh() {
        const sequence = ++generation.current;
        try { const value = await api.request('/state'); if (!alive.current || sequence !== generation.current) return; stateRef.current = value; setState(value); setReady(true); }
        catch (failure) { if (alive.current && sequence === generation.current) { setReady(false); setError(failure.message); } }
      }
      useEffect(() => { alive.current = true; void refresh(); const timer = setInterval(() => { void refresh(); }, 2500); return () => { alive.current = false; generation.current++; clearInterval(timer); }; }, [api]);
      useEffect(() => {
        if (!state) return;
        const defaults = {
          persona: { content: state.persona?.manualText || '' }, model: { provider: state.model?.provider || '', model: state.model?.model || '' },
          video: { windows: (state.video?.policy?.windows || ['00:00-24:00']).join('\n'), sessionMinutes: state.video?.policy?.sessionMinutes ?? 10 },
          mode: { silent: state.mode?.silent === true }, watch: { maxRequests: state.watch?.counts?.maxRequests ?? 30 },
          spark: { enabled: state.spark?.enabled === true, windows: (state.spark?.policy?.windows || ['09:00-22:00']).join('\n'), dailyLimit: state.spark?.policy?.dailyLimit ?? 2 },
          comments: { enabled: state.comments?.enabled === true, dailyLimit: state.comments?.policy?.dailyLimit ?? 3, perSessionLimit: state.comments?.policy?.perSessionLimit ?? 1 },
          share: { enabled: state.share?.enabled === true, dailyLimit: state.share?.dailyLimit ?? 3 },
          chat: { recipientIds: (state.chat?.policy?.allowlist || []).map(item => item.id), dailyReplyLimit: state.chat?.policy?.dailyReplyLimit ?? 40 },
          media: { enabled: state.media?.enabled === true, backend: state.media?.backend || 'local-whisper' },
        };
        setDraft(old => ({ ...old, ...Object.fromEntries(Object.entries(defaults).filter(([key]) => !dirty.current.has(key))) }));
        if (!dirty.current.has('persona')) personaRevision.current = state.persona?.revision;
        if (!reportDate && state.reports?.date) setReportDate(state.reports.date);
      }, [state]);
      function edit(section, key, value) {
        if (section === 'persona' && !dirty.current.has('persona')) personaRevision.current = stateRef.current?.persona?.revision;
        dirty.current.add(section); setNotice(''); setDraft(old => ({ ...old, [section]: { ...old[section], [key]: value } }));
      }
      async function perform(key, action, section) {
        if (!ready || locks.current.has(key)) return;
        locks.current.add(key); setBusy(new Set(locks.current)); setError(''); setNotice('');
        try { const value = await action(); if (section) dirty.current.delete(section); setNotice('操作已提交，请以回读状态为准。'); await refresh(); return value; }
        catch (failure) { if (key === 'persona' && failure.status === 409) { setPersonaConflict(true); setError('人格文件已更新，草稿已保留。请比较后选择载入最新人格再保存。'); } else setError(failure.message || '操作未完成。'); await refresh(); }
        finally { locks.current.delete(key); setBusy(new Set(locks.current)); }
      }
      const post = (key, route, value, section) => { void perform(key, () => api.request(route, value), section); };
      const value = (section, key, fallback = '') => draft[section]?.[key] ?? fallback;
      const windows = section => value(section, 'windows').split(/[\n,;，；]+/).map(item => item.trim()).filter(Boolean);
      const button = (text, key, callback, disabled = false) => h(Button, { type: 'button', size: 'sm', variant: 'outline', style: { alignSelf: 'flex-start' }, disabled: !ready || busy.has(key) || disabled, onClick: callback }, busy.has(key) ? '处理中…' : text);
      const input = (label, section, key, extra = {}) => h('label', { style: column }, h('span', null, label), h(Input, { 'aria-label': label, value: value(section, key), disabled: !ready, onChange: event => edit(section, key, event.target.value), ...extra }));
      const textarea = (label, section, key, rows = 2) => h('label', { style: column }, h('span', null, label), h('textarea', { 'aria-label': label, rows, value: value(section, key), disabled: !ready, onChange: event => edit(section, key, event.target.value), style: formControl, maxLength: section === 'persona' ? 40000 : 220 }));
      const toggle = (label, section, key = 'enabled') => h('label', { style: row }, h('input', { type: 'checkbox', 'aria-label': label, checked: value(section, key, false) === true, disabled: !ready, onChange: event => edit(section, key, event.target.checked) }), label);
      const section = (title, ...children) => categories[category].includes(title) ? h('section', { role: 'tabpanel', 'aria-label': title, style: { ...column, borderBottom: '1px solid var(--dsw-alias-border-l2)', paddingBottom: 24, marginBottom: 24 } }, h('h3', { style: { margin: 0 } }, title), ...children) : null;
      const note = (text, key) => h('p', { key, style: muted }, text);
      const modelLink = () => h(Button, { type: 'button', size: 'sm', variant: 'outline', onClick: () => setCategory('基础设置') }, '前往模型设置');
      const watchReason = runningWatch ? '自主观看正在运行。' : !state?.model?.configured ? '请先在基础设置中选择并保存模型。' : !state?.video?.allowed ? '请先开始一个允许时段内的有限轮次。' : '';
      const sparkReason = runningSpark ? '自动问候正在运行。' : !state?.model?.configured ? '请先在基础设置中选择并保存模型，再开始自动问候。' : dirty.current.has('spark') ? '请先保存问候许可。' : !state?.spark?.enabled ? '请先开启并保存主动问候许可。' : '';
      const chatReason = runningChat ? '自动回复正在运行。' : !state?.model?.configured ? '请先在基础设置中选择并保存模型。' : dirty.current.has('chat') ? '请先保存许可好友。' : !(state?.chat?.policy?.allowlist || []).length ? '请先读取并保存许可好友。' : '';
      function credentialForm(backend, label) {
        const credential = state?.media?.backends?.[backend]?.credential;
        return h('div', { key: backend, style: column }, h('label', { style: column }, h('span', null, `${label} API Key`), h(Input, { type: 'password', 'aria-label': `${label} API Key`, autoComplete: 'off', maxLength: 4096, value: credentials[backend], disabled: !ready || operationActive || busy.has(`key:${backend}`), placeholder: credential?.configured ? '已配置；填写后替换' : '填写音频服务 API Key', onChange: event => setCredentials(old => ({ ...old, [backend]: event.target.value })) })),
          button(`保存 ${label} Key`, `key:${backend}`, () => { void perform(`key:${backend}`, async () => { const result = await api.request('/media/credentials', { backend, apiKey: credentials[backend] }); setCredentials(old => ({ ...old, [backend]: '' })); return result; }); }, operationActive || !credentials[backend].trim()),
          note(credential?.environmentOverride ? '当前进程的环境变量优先；共享文件中的 Key 不覆盖它。' : credential?.configured ? '已配置，不回显已保存的 Key。' : '尚未配置。音频可以保持关闭。'));
      }
      function resolve(kind, item, outcome) {
        const key = `${kind}:${item.operationId}`; if (submitted.current.has(key)) return;
        submitted.current.add(key); setReviews(new Set(submitted.current));
        void perform(key, async () => { try { return await api.request(`/${kind}/resolve`, { operationId: item.operationId, outcome }); } catch (failure) { submitted.current.delete(key); setReviews(new Set(submitted.current)); throw failure; } });
      }
      const reviewList = kind => (state?.[kind]?.needsReview || []).map(item => {
        const key = `${kind}:${item.operationId}`;
        return h('div', { key, style: column }, note(`待核对：${item.videoId ? `作品 ${item.videoId}` : '许可好友问候'} · ${item.status || ''}`), reviews.has(key) ? note('核对结果已提交，等待回读，不会重复提交。') : h('div', { style: row }, button('已核对发送成功', key, () => resolve(kind, item, 'confirmed'), kind === 'spark' && runningSpark), button('已核对未发送', key, () => resolve(kind, item, 'not-sent'), kind === 'spark' && runningSpark)));
      });
      const remaining = state?.video?.remainingSeconds ?? 0;
      return h('div', { style: { maxWidth: 900, color: 'var(--dsw-alias-label-primary)', paddingBottom: 32 } },
        h('h2', null, '大肥鱼抖音助手'),
        !ready && h('p', { role: 'status' }, '正在核实插件状态；未就绪时不会启用或启动任何功能。'),
        error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice),
        h('div', { style: row }, button('刷新插件状态', 'refresh', () => { void refresh(); }), button('打开抖音', 'browser', () => post('browser', '/browser/open', {}))),
        h('div', { role: 'tablist', 'aria-label': '刷抖音设置分类', style: { ...row, marginTop: 20, marginBottom: 24 } }, ...Object.keys(categories).map(name => h(Button, { key: name, type: 'button', role: 'tab', 'aria-selected': category === name, size: 'sm', variant: category === name ? 'primary' : 'outline', onClick: () => setCategory(name) }, name))),
        section('DSH 模型', note('使用 DSH 已配置提供商；观看、问候和私信按本页模型设置运行。'),
          h('label', { style: column }, '模型提供商', h('select', { 'aria-label': '模型提供商', style: formControl, value: value('model', 'provider'), disabled: !ready || operationActive, onChange: event => { edit('model', 'provider', event.target.value); edit('model', 'model', ''); } }, h('option', { value: '' }, '请选择 DSH 提供商'), ...(state?.model?.providers || []).map(item => h('option', { key: item.id, value: item.id }, item.name || item.id)))),
          h('label', { style: column }, '模型名称', h('select', { 'aria-label': '模型名称', style: formControl, value: value('model', 'model'), disabled: !ready || operationActive || !value('model', 'provider'), onChange: event => edit('model', 'model', event.target.value) }, h('option', { value: '' }, '请选择模型'), ...(state?.model?.models || []).filter(item => item.provider === value('model', 'provider')).map(item => h('option', { key: item.id, value: item.id }, item.name || item.id)))),
          value('model', 'provider') && !(state?.model?.models || []).some(item => item.provider === value('model', 'provider')) && note('该提供商尚无可选模型，请先在 DSH 的模型设置中配置或刷新模型列表。'),
          ...(state?.model?.catalogErrors || []).filter(item => item.provider === value('model', 'provider')).map(item => note(item.message, item.provider)),
          button('保存模型设置', 'model', () => post('model', '/model/configure', { provider: value('model', 'provider'), model: value('model', 'model').trim() }, 'model'), operationActive || !value('model', 'provider') || !value('model', 'model').trim()), note(state?.model?.configured ? '模型已配置。' : '请先配置并核实 DSH 模型。')),
        section('人格与兴趣', note('手编人格与软件共用；自动兴趣和观察单独记录。未保存的草稿不会被状态轮询覆盖。'), textarea('大肥鱼人格正文', 'persona', 'content', 14),
          personaConflict && note('人格存在版本冲突，请先比较草稿和最新正文。'),
          h('div', { style: row }, button('保存人格', 'persona', () => post('persona', '/persona/configure', { content: value('persona', 'content'), expectedRevision: personaRevision.current }, 'persona'), operationActive || personaConflict), button('载入最新人格（替换草稿）', 'personaReload', () => { dirty.current.delete('persona'); setDraft(old => ({ ...old, persona: { content: state.persona?.manualText || '' } })); personaRevision.current = state.persona?.revision; setPersonaConflict(false); })),
          h('details', null, h('summary', null, '查看最新人格正文'), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, state?.persona?.manualText || '尚未填写')),
          note(state?.persona?.personaFolder || '人格文件夹位置正在读取。')),
        section('视频时间与自主观看', textarea('每日允许视频时段（北京时间）', 'video', 'windows'), input('单轮上限（分钟）', 'video', 'sessionMinutes', { type: 'number', min: 1, max: 1440 }),
          button('保存视频时间', 'video', () => post('video', '/video/configure', { windows: windows('video'), sessionMinutes: Number(value('video', 'sessionMinutes')) }, 'video')),
          note(state?.video?.reason || `当前轮次剩余 ${remaining} 秒。`), h('div', { style: row }, button('开始有限轮次', 'videoStart', () => post('videoStart', '/video/start', {}), runningWatch), button('结束本轮', 'videoStop', () => post('videoStop', '/video/stop', {}))),
          input('本轮自主模型请求上限', 'watch', 'maxRequests', { type: 'number', min: 1, max: 100 }), h('div', { style: row }, button('开始自主观看', 'watchStart', () => post('watchStart', '/watch/start', { maxRequests: Number(value('watch', 'maxRequests', 30)) }), runningWatch || !state?.video?.allowed || !state?.model?.configured), button('停止自主观看', 'watchStop', () => post('watchStop', '/watch/stop', {}), !runningWatch)),
          watchReason && note(watchReason), !state?.model?.configured && modelLink(), note('先由本人开始有限轮次，再启动自主观看；停止再开不会重置时间或请求预算。'), toggle('静默观看', 'mode', 'silent'), button('保存静默设置', 'mode', () => post('mode', '/mode/configure', { silent: value('mode', 'silent', false) === true }, 'mode')), note(state?.mode?.note || '静默模式不延长轮次，也不保证网站始终允许后台播放。')),
        section('自动续火花', toggle('允许主动问候', 'spark'), textarea('每日问候时段（北京时间）', 'spark', 'windows'), input('每日主动问候总上限', 'spark', 'dailyLimit', { type: 'number', min: 1, max: 2 }),
          button('保存问候许可', 'spark', () => { void perform('spark', async () => { const result = await api.request('/spark/configure', { enabled: value('spark', 'enabled', false), windows: windows('spark'), dailyLimit: Number(value('spark', 'dailyLimit', 2)) }); if (!value('spark', 'enabled', false)) await api.request('/spark/stop', {}); return result; }, 'spark'); }),
          h('div', { style: row }, button('开始自动问候', 'sparkStart', () => post('sparkStart', '/spark/start', {}), runningSpark || !state?.spark?.enabled || !state?.model?.configured || dirty.current.has('spark')), button('停止自动问候', 'sparkStop', () => post('sparkStop', '/spark/stop', {}), !runningSpark)),
          sparkReason && note(sparkReason), !state?.model?.configured && modelLink(), !runningSpark && note('问候尚未启动，无需停止。'),
          note(`许可：${state?.spark?.enabled ? '已开启' : '未开启'}；服务：${runningSpark ? '运行中' : '未运行'}。保存许可不会发送；点击开始后，在允许时段可能发送。`), note('每好友每天最多一次尝试，已有可靠发出互动、有新消息待回复或日期不明时不打扰。问候送达不等于火花增加，以抖音判定及对方互动为准。'),
          ...(state?.spark?.recipients || []).map(item => note(`${item.name || '许可好友'}：${item.reason || item.status || '等待检查'}`, item.id)), ...reviewList('spark')),
        section('自主公开视频评论', toggle('允许自主发布评论', 'comments'), input('评论每日尝试上限', 'comments', 'dailyLimit', { type: 'number', min: 1, max: 20 }), input('评论每轮尝试上限', 'comments', 'perSessionLimit', { type: 'number', min: 1, max: 3 }),
          button('保存评论许可', 'comments', () => post('comments', '/comments/configure', { enabled: value('comments', 'enabled', false), dailyLimit: Number(value('comments', 'dailyLimit', 3)), perSessionLimit: Number(value('comments', 'perSessionLimit', 1)) }, 'comments')),
          note('仅在有限自主观看中由大肥鱼决定是否公开评论，不含人格、私信或 QQ 内容。每作品永久去重，未确认时暂停，不退次数或自动重发。'), note(`今日已尝试 ${state?.comments?.daily?.attempts ?? 0} 次，本轮 ${state?.comments?.session?.attempts ?? 0} 次。`), ...reviewList('comments')),
        state?.share && section('自主分享作品', toggle('允许自主分享', 'share'), input('分享每日尝试上限', 'share', 'dailyLimit', { type: 'number', min: 1, max: 20 }), button('保存分享许可', 'share', () => post('share', '/share/configure', { enabled: value('share', 'enabled', false), dailyLimit: Number(value('share', 'dailyLimit', 3)) }, 'share')), note('只在有限自主观看中选择当前观察的作品及许可好友；未确认不自动重发。'), ...reviewList('share')),
        state?.chat && section('许可好友与自动回复', note(`服务：${runningChat ? '运行中' : '未运行'}；只回复启动后的可靠新消息，不补发历史。`), button('读取已关注联系人', 'chatList', () => { void perform('chatList', async () => { const result = await api.request('/chat/contacts', {}); if (result.blocked || result.loginRequired || result.verificationRequired || !Array.isArray(result.contacts)) throw new Error('请在专用抖音窗口完成登录或验证。'); setContacts(result.contacts); }); }, runningChat),
          ...(contacts || state.chat.policy?.allowlist || []).map(item => h('label', { key: item.id, style: row }, h('input', { type: 'checkbox', 'aria-label': `许可联系人 ${item.name || item.displayName || '联系人'}`, checked: value('chat', 'recipientIds', []).includes(item.id), disabled: !ready || runningChat || item.followed !== true || item.isGroup !== false || !value('chat', 'recipientIds', []).includes(item.id) && value('chat', 'recipientIds', []).length >= 2, onChange: event => edit('chat', 'recipientIds', event.target.checked ? [...value('chat', 'recipientIds', []), item.id] : value('chat', 'recipientIds', []).filter(id => id !== item.id)) }), item.name || item.displayName || '许可好友')),
          input('私信每日模型请求上限', 'chat', 'dailyReplyLimit', { type: 'number', min: 1, max: 200 }), h('div', { style: row }, button('保存许可好友', 'chat', () => post('chat', '/chat/configure', { recipientIds: value('chat', 'recipientIds', []), dailyReplyLimit: Number(value('chat', 'dailyReplyLimit', 40)) }, 'chat'), runningChat), button('启用私信自动回复', 'chatStart', () => post('chatStart', '/chat/start', {}), runningChat || !state?.model?.configured || !(state.chat.policy?.allowlist || []).length || dirty.current.has('chat')), button('停止私信回复', 'chatStop', () => post('chatStop', '/chat/stop', {}), !runningChat)),
          chatReason && note(chatReason), !runningChat && note('自动回复尚未启动，无需停止。'),
          ...(state.chat.contacts || []).filter(item => item.status !== 'ready').map(item => h('div', { key: item.id }, note(item.reason || item.status), button('已人工核对该会话', `chatResolve:${item.id}`, () => post(`chatResolve:${item.id}`, '/chat/resolve', { recipientId: item.id }), runningChat)))),
        state?.media && section('可选音频', toggle('读取视频声音', 'media'), h('label', { style: column }, '音频后端', h('select', { 'aria-label': '音频后端', value: value('media', 'backend', 'local-whisper'), disabled: !ready, style: formControl, onChange: event => edit('media', 'backend', event.target.value) }, h('option', { value: 'local-whisper' }, '本机 Whisper'), h('option', { value: 'mimo' }, 'MiMo'), h('option', { value: 'minimax' }, 'MiniMax'))), button('保存音频设置', 'media', () => post('media', '/media/configure', { enabled: value('media', 'enabled', false), backend: value('media', 'backend', 'local-whisper') }, 'media')), note('音频可以不接入。以下 Key 仅用于对应云音频服务，与 DSH 主模型分开。保存在本机共享媒体文件中（明文），软件与插件共用。保存 Key 不开启音频、不发起云请求，也不安装依赖或下载模型。'), credentialForm('mimo', 'MiMo'), credentialForm('minimax', 'MiniMax'), operationActive && note('请先停止自主观看、问候及私信回复，再更换音频 Key。')),
        section('观看日报', note(state?.reports?.folder || '日报保存在共用记忆的 reports/videos 目录。'), button('生成今天日报', 'reportGenerate', () => { void perform('reportGenerate', async () => { const result = await api.request('/reports/generate', {}); setReport(result); return result; }); }),
          h('label', { style: column }, '日报日期', h('input', { 'aria-label': '日报日期', type: 'date', value: reportDate, onChange: event => setReportDate(event.target.value), style: formControl })),
          button('读取所选日报', 'reportRead', () => { void perform('reportRead', async () => { if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error('请选择有效日报日期。'); const result = await api.request(`/reports/read?date=${reportDate}`); setReport(result); return result; }); }),
          note('日报只整理已记录的观看证据，不调用模型，也不会新增浏览。'), ...(state?.reports?.reports || []).map(item => note(`${item.date} · ${item.observedCount ?? 0} 项观察 · 已核实进度 ${item.verifiedProgressSeconds ?? 0} 秒`, item.date)), report && h('pre', { 'aria-label': '日报内容', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' } }, report.markdown || '该日报没有可显示正文。'))
      );
    }
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'douyin-browser', order: 16, label: () => '刷抖音' }, SettingsPage));
    }
    return { name: 'douyin-browser-settings', inject: ['slots'], apply, SettingsPage, createSettingsTransport };
  },
});
