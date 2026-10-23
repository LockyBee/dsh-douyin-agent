const LONG = new Set(['/api/browser/open', '/api/chat/contacts', '/api/chat/configure', '/api/chat/start', '/api/forward/contacts', '/api/forward', '/api/watch/start', '/api/watch/stop']);

export function createApiClient(fetcher = globalThis.fetch.bind(globalThis)) {
  let token = '';
  async function bootstrap() {
    const response = await fetcher('/api/bootstrap', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    if (!response.ok || data.service !== 'douyin-api-local' || typeof data.token !== 'string' || !data.token) throw new Error(data.error || '本机服务尚未就绪。');
    const sessionChanged = Boolean(token) && token !== data.token;
    token = data.token;
    const { token: omitted, ...publicData } = data;
    return { ...publicData, sessionChanged };
  }
  async function request(route, body) {
    if (!route.startsWith('/api/') || route.startsWith('//') || /[\r\n]/.test(route)) throw new Error('请求必须发往本机 API。');
    if (!token) throw new Error('本机服务尚未完成会话校验。');
    const response = await fetcher(route, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store',
      signal: AbortSignal.timeout(LONG.has(route) ? 65_000 : 20_000),
      headers: { 'content-type': 'application/json', 'x-session-token': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || '本机请求未完成。'); error.status = response.status; throw error; }
    return data;
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
