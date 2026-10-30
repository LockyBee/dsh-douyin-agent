const LONG = new Set(['/api/browser/open', '/api/chat/contacts', '/api/forward/contacts']);
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

export function requestOperation(route, body) {
  const path = route.split('?')[0].replace(/^\/api/, '');
  if (path === '/task/limits' && body !== undefined) return '保存任务额度';
  if (path === '/watch/schedule' && typeof body?.enabled === 'boolean') return body.enabled ? '开始自主观看' : '暂停观看';
  return OPERATIONS[path] || '本机操作';
}

export function requestFailure(failure, operation, { timeoutMs, write = false, signal } = {}) {
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

export function operationLabel(name) {
  return ({ browserOpen:'打开抖音', browser:'打开抖音', refresh:'刷新连接', task:'提交对话任务', stop:'停止对话任务', settings:'保存模型设置', clearKey:'移除模型密钥', openMemory:'打开记忆文件夹', memory:'检索共享记忆', watchSchedule:'设置自动观看', schedule:'设置自动观看', interactions:'设置好友互动', chatList:'读取当前会话列表', chatPrepare:'准备回复通道', forwardList:'读取转发会话', forward:'转发作品', personaReload:'载入最新人格', diagnostics:'一键自检或修复', reportGenerate:'生成观看日报', reportRead:'读取观看日报' })[name] || (/^resolve-|^chatResolve:/.test(name) ? '解除会话暂停' : name.startsWith('key:') ? '保存音频密钥' : name === 'unansweredResolve' ? '标记遗留待处理消息' : '本机操作');
}

export function createApiClient(fetcher = globalThis.fetch.bind(globalThis)) {
  let token = '';
  const writing = new Set();
  async function bootstrap() {
    try {
    const response = await fetcher('/api/bootstrap', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    let data;
    try { data = await response.json(); } catch (failure) { if (failure.name === 'TimeoutError') throw failure; throw Object.assign(new Error('本机服务未返回有效 JSON，请检查服务是否加载完成。'), { status: response.status }); }
    if (!response.ok || data.service !== 'douyin-api-local' || typeof data.token !== 'string' || !data.token) throw new Error(data.error || '本机服务尚未就绪。');
    const sessionChanged = Boolean(token) && token !== data.token;
    token = data.token;
    const { token: omitted, ...publicData } = data;
    return { ...publicData, sessionChanged };
    } catch (failure) { throw requestFailure(failure, requestOperation('/api/bootstrap'), { timeoutMs: 5000 }); }
  }
  async function request(route, body) {
    if (!route.startsWith('/api/') || route.startsWith('//') || /[\r\n]/.test(route)) throw new Error('请求必须发往本机 API。');
    if (!token) throw new Error('本机服务尚未完成会话校验。');
    const operation = requestOperation(route, body), write = body !== undefined, timeoutMs = write || LONG.has(route.split('?')[0]) ? 65_000 : 20_000;
    const key = route.split('?')[0];
    if (write && writing.has(key)) throw Object.assign(new Error(`${operation}正在处理，请等待当前请求完成。`), { operation, code: 'UI_OPERATION_BUSY' });
    if (write) writing.add(key);
    const signal = AbortSignal.timeout(timeoutMs);
    try {
    const response = await fetcher(route, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
      signal,
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data;
    try { data = await response.json(); } catch (failure) { if (signal.aborted || failure.name === 'TimeoutError') throw failure; throw Object.assign(new Error('本机服务未返回有效 JSON，请检查服务是否加载完成。'), { status: response.status }); }
    if (!response.ok) { const error = new Error(data.error || '本机请求未完成。'); error.status = response.status; throw error; }
    return data;
    } catch (failure) { throw requestFailure(failure, operation, { timeoutMs, write, signal }); }
    finally { if (write) writing.delete(key); }
  }
  return { bootstrap, request };
}

export function watchIsActive(state) {
  return state?.running === true || state?.worker?.alive === true || ['running', 'stopping'].includes(state?.status);
}

export function watchStartInput(value) {
  const maxRequests = Number(value);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 10000) throw new Error('本轮请求上限须为 1 至 10000 的整数。');
  return { startSession: false, maxRequests };
}

export function publicSettings(value = {}) {
  return { configured: value.configured === true, baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : 'https://api.deepseek.com',
    model: typeof value.model === 'string' ? value.model : 'deepseek-chat', remember: value.remember === true,
    memoryFolder: typeof value.memoryFolder === 'string' ? value.memoryFolder : '' };
}

export async function saveNativeSettings(bridge, input) {
  if (!bridge?.saveSettings) throw new Error('请从独立桌面软件打开设置。');
  const { apiKey, baseUrl, model, remember } = input;
  if (typeof apiKey !== 'string' || apiKey.length > 4096 || typeof baseUrl !== 'string' || typeof model !== 'string' || typeof remember !== 'boolean') throw new Error('模型设置格式不正确。');
  return publicSettings(await bridge.saveSettings({ apiKey, baseUrl, model, remember }));
}

export async function saveNativeMediaKey(bridge, input) {
  if (!bridge?.saveMediaKey) throw new Error('请使用新版独立桌面软件填写音频 Key；插件可在共享媒体 .env 配置。');
  if (!input || !['mimo', 'minimax'].includes(input.backend) || typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 4096) throw new Error('请选择云端音频后端并填写 API Key。');
  const result = await bridge.saveMediaKey({ backend: input.backend, apiKey: input.apiKey.trim() });
  if (result?.configured !== true || result?.backend !== input.backend) throw new Error('音频 Key 未确认保存，请重试。');
  return { backend: input.backend, configured: true, storage: 'shared-env' };
}

export function createForwardGate() {
  let locked = false;
  return {
    get locked() { return locked; },
    take(event) { if (event?.isTrusted !== true) throw new Error('转发需要你亲自点击按钮。'); if (locked) throw new Error('这次转发已提交，请先人工核对。'); locked = true; },
    reset(event) { if (event?.isTrusted !== true) throw new Error('请亲自确认核对结果。'); locked = false; },
  };
}

export function mergeEvents(previous, incoming, taskId) {
  const merged = new Map(previous.map(item => [item.revision, item]));
  for (const item of incoming || []) if (Number.isSafeInteger(item.revision) && !merged.has(item.revision)) merged.set(item.revision, { ...item, taskId });
  return [...merged.values()].sort((a, b) => a.revision - b.revision).slice(-200);
}
