import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApiAgent, DEFAULT_LIMITS, loadApiConfig, normalizeApiConfig, publicApiConfig, redact } from './api-agent.mjs';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function reply(response, status, value, contentType = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  response.end(contentType.startsWith('application/json') ? JSON.stringify(value) : value);
}

function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) throw Object.assign(new Error('请求必须使用 application/json。'), { status: 415 });
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const clean = () => { request.removeListener('data', onData); request.removeListener('end', onEnd); request.removeListener('error', onError); request.removeListener('aborted', onAbort); };
    const fail = (error) => { clean(); request.resume(); reject(error); };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > 20_000) return fail(Object.assign(new Error('请求内容过长。'), { status: 413 }));
      chunks.push(chunk);
    };
    const onEnd = () => {
      clean();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(Object.assign(new Error('请求必须是 JSON 对象。'), { status: 400 })); }
    };
    const onError = (error) => fail(error);
    const onAbort = () => fail(Object.assign(new Error('请求已中断。'), { status: 400 }));
    request.on('data', onData); request.on('end', onEnd); request.on('error', onError); request.on('aborted', onAbort);
  });
}

function tokenMatches(actual, expected) {
  if (typeof actual !== 'string' || Buffer.byteLength(actual) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

const STATIC_TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2' };
async function staticAsset(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (/[\0\r\n]/.test(decoded)) return null;
  const file = path.resolve(root, '.' + decoded);
  const within = (base, target) => { const relative = path.relative(base, target); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
  if (!within(path.resolve(root), file) || !STATIC_TYPES[path.extname(file).toLowerCase()]) return null;
  try {
    const [actualRoot, actualFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
    if (!within(actualRoot, actualFile) || !(await fs.stat(actualFile)).isFile()) return null;
    return { data: await fs.readFile(actualFile), contentType: STATIC_TYPES[path.extname(file).toLowerCase()] };
  } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
}

export function createApiServer({ controller, config, agent = new ApiAgent({ controller, config }), chatService, videoLimits, pauseVideoSources, mediaAdapter, port = 3218, htmlFile = path.join(ROOT, 'public/index.html'), staticRoot } = {}) {
  if (staticRoot !== undefined && (typeof staticRoot !== 'string' || !path.isAbsolute(staticRoot))) throw new Error('静态资源目录必须是绝对路径。');
  const token = randomBytes(32).toString('hex');
  const events = [];
  let revision = 0;
  let active = null;
  let lastTask = null;
  let lastBrowserState = null;
  let forwardAbort = null;
  let stopping = false;
  let stopPromise;
  let cleanupPromise;
  const shutdownHooks = [];
  const append = (event) => {
    const safe = redact(event, [config.apiKey]);
    events.push({ ...safe, revision: ++revision });
    if (events.length > 200) events.splice(0, events.length - 200);
    if (safe.type === 'tool.result' && safe.result) {
      const state = safe.result.state || safe.result;
      if (state.url || state.video) lastBrowserState = state;
    }
  };
  const pauseSource = pauseVideoSources || (async (source) => source === 'api' ? typeof controller.pauseForLimits === 'function' ? controller.pauseForLimits() : controller.execute('douyin_pause') : { skipped: true, reason: '此测试服务未提供 DSH 暂停控制器。' });
  let lastVideoDenial = '';
  const denyVideo = (state) => { const error = new Error(state.reason || '刷视频时间已结束。'); active?.abort.abort(error); forwardAbort?.abort(error); const key = `${state.session?.id || 'none'}:${state.reason}`; if (key !== lastVideoDenial) { lastVideoDenial = key; append({ type: 'video.limited', message: state.reason || '刷视频时间已结束。' }); } };
  const enforceVideo = () => videoLimits?.enforce({ pause: pauseSource, onDeny: denyVideo });
  const cancelVideoWatch = videoLimits?.watch({ pause: pauseSource, onDeny: denyVideo });
  const server = http.createServer(async (request, response) => {
    try {
      const origin = `http://127.0.0.1:${server.address()?.port || port}`;
      const hostCount = request.rawHeaders.filter((_item, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host').length;
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || hostCount !== 1 || request.headers.host !== new URL(origin).host) return reply(response, 403, { error: '只接受本机 127.0.0.1 地址。' });
      if ((request.headers.origin && request.headers.origin !== origin) || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) return reply(response, 403, { error: '拒绝跨来源请求。' });
      const url = new URL(request.url, origin);
      if (url.origin !== origin) return reply(response, 403, { error: '请求地址与本机服务不一致。' });
      if (stopping) return reply(response, 503, { error: '本机服务正在退出。' });
      if (request.method === 'GET' && url.pathname === '/') return reply(response, 200, await fs.readFile(htmlFile), 'text/html; charset=utf-8');
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
        const memory = resolveRuntimePaths();
        return reply(response, 200, { service: 'douyin-api-local', version: 1, token, videoTime: { enabled: Boolean(videoLimits) }, media: { available: Boolean(mediaAdapter) }, forward: { available: Boolean(chatService && videoLimits) }, config: redact(publicApiConfig(config), [config.apiKey]), limits: { maxSteps: agent.maxSteps ?? DEFAULT_LIMITS.maxSteps, maxToolCalls: agent.maxToolCalls ?? DEFAULT_LIMITS.maxToolCalls, taskTimeoutSeconds: (agent.taskTimeoutMs ?? DEFAULT_LIMITS.taskTimeoutMs) / 1_000, apiTimeoutSeconds: (agent.apiTimeoutMs ?? DEFAULT_LIMITS.apiTimeoutMs) / 1_000, maxTokens: agent.maxTokens ?? DEFAULT_LIMITS.maxTokens, maxFrames: agent.maxFrames ?? DEFAULT_LIMITS.maxFrames }, memory: { description: '与 QQ 机器人共享的记忆 / 视频笔记。具体连通状态以检索结果为准。', folder: memory.memoryDir, database: memory.memoryDbPath } });
      }
      if (request.method === 'GET' && !url.pathname.startsWith('/api/') && staticRoot) {
        const asset = await staticAsset(staticRoot, url.pathname);
        if (asset) return reply(response, 200, asset.data, asset.contentType);
      }
      if (!url.pathname.startsWith('/api/')) return reply(response, 404, { error: '地址不存在。' });
      if (!tokenMatches(request.headers['x-session-token'], token)) return reply(response, 403, { error: '控制台会话校验失败，请刷新页面。' });
      if (url.pathname.startsWith('/api/media/')) {
        if (!mediaAdapter) return reply(response, 503, { error: '可选音频模块尚未就绪。' });
        if (request.method === 'GET' && url.pathname === '/api/media/state') return reply(response, 200, await mediaAdapter.status());
        if (request.method === 'POST' && url.pathname === '/api/media/configure') {
          const body = await readJson(request);
          if (Object.keys(body).some((key) => !['enabled', 'backend'].includes(key)) || typeof body.enabled !== 'boolean' || !['local-whisper', 'minimax', 'mimo'].includes(body.backend)) return reply(response, 400, { error: '音频设置只接受启用开关和有效后端。' });
          await mediaAdapter.saveSettings(body, { explicit: true });
          return reply(response, 200, await mediaAdapter.status());
        }
        return reply(response, 404, { error: '音频接口不存在。' });
      }
      if (url.pathname.startsWith('/api/forward')) {
        if (!chatService || !videoLimits) return reply(response, 503, { error: '转发需要已核对的私信许可名单及视频时间模块。' });
        if (request.method === 'GET' && url.pathname === '/api/forward/contacts') {
          const result = await chatService.listContacts({ signal: AbortSignal.timeout(60_000) });
          const approved = new Set(chatService.state().policy.allowlist.map((item) => item.id));
          return reply(response, 200, { contacts: (result.contacts || []).filter((item) => approved.has(item.id) && item.followed === true && item.isGroup === false), blocked: result.blocked, loginRequired: result.loginRequired, verificationRequired: result.verificationRequired });
        }
        if (request.method === 'POST' && url.pathname === '/api/forward') {
          const body = await readJson(request);
          if (Object.keys(body).some((key) => !['recipientId', 'url'].includes(key)) || typeof body.recipientId !== 'string' || !body.recipientId.trim() || body.recipientId.length > 500) return reply(response, 400, { error: '请选择已许可的联系人。' });
          let videoUrl;
          if (body.url !== undefined && body.url !== '') {
            if (typeof body.url !== 'string' || body.url.length > 2048) return reply(response, 400, { error: '作品链接过长或格式无效。' });
            try {
              const value = new URL(body.url);
              if (value.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(value.hostname) || value.port || value.username || value.password || !/^\/video\/\d{10,30}\/?$/.test(value.pathname)) throw new Error();
              videoUrl = `https://www.douyin.com${value.pathname.replace(/\/$/, '')}`;
            } catch { return reply(response, 400, { error: '请使用 https://www.douyin.com/video/数字 形式的作品链接；留空转发当前作品。' }); }
          }
          if (forwardAbort || active) return reply(response, 409, { error: '已有视频任务或转发正在执行，请等待完成。' });
          if (!chatService.state().policy.allowlist.some((item) => item.id === body.recipientId && item.followed === true && item.isGroup === false)) return reply(response, 403, { error: '此联系人不在已核对的许可名单内。' });
          const permit = videoLimits.beforeAction('api', 'douyin_forward_video');
          if (!permit.allowed) { await enforceVideo(); return reply(response, 409, { error: permit.reason }); }
          const abort = new AbortController(); forwardAbort = abort;
          const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]);
          try {
            const contacts = await chatService.listContacts({ signal });
            if (contacts.blocked || contacts.loginRequired || contacts.verificationRequired || !contacts.contacts?.some((item) => item.id === body.recipientId && item.followed === true && item.isGroup === false) || !chatService.state().policy.allowlist.some((item) => item.id === body.recipientId)) return reply(response, 403, { error: '当前关注关系或联系人身份未能核对，未转发。' });
            signal.throwIfAborted();
            const latest = videoLimits.beforeAction('api', 'douyin_forward_video');
            if (!latest.allowed) { await enforceVideo(); return reply(response, 409, { error: latest.reason }); }
            const result = await controller.execute('douyin_forward_video', { recipientId: body.recipientId, ...(videoUrl ? { url: videoUrl } : {}) }, { signal, humanAuthorized: true });
            return reply(response, 200, redact(result, [config.apiKey]));
          } finally { if (forwardAbort === abort) forwardAbort = null; }
        }
        return reply(response, 404, { error: '转发接口不存在。' });
      }
      if (url.pathname.startsWith('/api/video/')) {
        if (!videoLimits) return reply(response, 503, { error: '视频时间模块尚未就绪。' });
        if (request.method === 'GET' && url.pathname === '/api/video/status') return reply(response, 200, videoLimits.state());
        if (request.method !== 'POST') return reply(response, 404, { error: '视频时间接口不存在。' });
        const body = await readJson(request);
        if (url.pathname === '/api/video/policy') { let result; try { result = videoLimits.savePolicy(body, { explicit: true }); } catch (error) { error.status ||= 400; throw error; } await enforceVideo(); return reply(response, 200, result); }
        if (url.pathname === '/api/video/start') {
          if (Object.keys(body).length) return reply(response, 400, { error: '开始新一轮不接受额外参数。' });
          active?.abort.abort(new Error('用户开始新一轮，结束上一次视频任务。'));
          forwardAbort?.abort(new Error('用户开始新一轮，结束上一次转发操作。'));
          await Promise.allSettled(['api','dsh'].map((source) => pauseSource(source)));
          const state = videoLimits.markSession('api', { explicit: true }); lastVideoDenial = '';
          append({ type: 'video.started', message: `已开始新一轮，上限 ${state.policy.sessionMinutes} 分钟；API 与 DSH 共用这轮时钟。` });
          return reply(response, 200, state);
        }
        if (url.pathname === '/api/video/end') { if (Object.keys(body).length) return reply(response, 400, { error: '结束当前轮不接受额外参数。' }); const state = videoLimits.endSession({ explicit: true }); await enforceVideo(); return reply(response, 200, state); }
        return reply(response, 404, { error: '视频时间接口不存在。' });
      }
      if (url.pathname.startsWith('/api/chat/')) {
        if (!chatService) return reply(response, 503, { error: '私信模块尚未就绪。' });
        let result;
        if (request.method === 'GET' && url.pathname === '/api/chat/state') result = chatService.state();
        else if (request.method === 'GET' && url.pathname === '/api/chat/contacts') result = await chatService.listContacts();
        else if (request.method === 'POST') {
          const body = await readJson(request);
          if (url.pathname === '/api/chat/configure') result = await chatService.configure(body);
          else if (url.pathname === '/api/chat/start') result = await chatService.start();
          else if (url.pathname === '/api/chat/stop') result = chatService.stop();
          else if (url.pathname === '/api/chat/resolve') result = chatService.resumeContact(body.recipientId);
          else return reply(response, 404, { error: '私信接口不存在。' });
        } else return reply(response, 404, { error: '私信接口不存在。' });
        return reply(response, 200, redact(result, [config.apiKey]));
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const since = Number(url.searchParams.get('since')) || 0;
        return reply(response, 200, { running: Boolean(active), task: active ? { id: active.id, instruction: redact(active.instruction, [config.apiKey]), startedAt: active.startedAt, status: active.abort.signal.aborted ? 'stopping' : 'running' } : lastTask, events: events.filter((item) => item.revision > since), revision, browser: lastBrowserState });
      }
      if (request.method === 'GET' && url.pathname === '/api/memory') {
        const query = (url.searchParams.get('query') || '').slice(0, 300);
        const result = await controller.execute('douyin_recall', { query, limit: 12 });
        return reply(response, 200, { result: redact(result, [config.apiKey]) });
      }
      if (request.method === 'POST' && url.pathname === '/api/task') {
        if (active || forwardAbort) return reply(response, 409, { error: '已有任务或转发正在执行，请等待或停止。' });
        if (videoLimits) { const permit = videoLimits.beforeAction('api', 'douyin_open'); if (!permit.allowed) { await enforceVideo(); return reply(response, 409, { error: permit.reason, videoTime: permit.state }); } }
        if (!config.apiKey) return reply(response, 400, { error: '未配置 DeepSeek API Key，请打开本机 API 设置。' });
        const { instruction } = await readJson(request);
        if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 4_000) return reply(response, 400, { error: '任务请输入 1 至 4000 个字符。' });
        if (active || forwardAbort) return reply(response, 409, { error: '已有任务或转发正在执行，请等待或停止。' });
        const task = { id: randomUUID(), instruction: instruction.trim(), startedAt: new Date().toISOString(), abort: new AbortController() };
        active = task;
        append({ type: 'task.started', message: task.instruction, at: task.startedAt });
        reply(response, 202, { id: task.id, status: 'running' });
        task.completion = Promise.resolve().then(() => agent.runTask({ instruction: task.instruction, signal: task.abort.signal, onEvent: append })).then((result) => {
          lastTask = redact({ id: task.id, instruction: task.instruction, startedAt: task.startedAt, endedAt: new Date().toISOString(), ...result }, [config.apiKey]);
          append({ type: `task.${result.status}`, message: result.status === 'completed' ? 'DeepSeek 已答复，见上方结果。' : result.message, at: lastTask.endedAt });
        }).catch((error) => {
          lastTask = { id: task.id, status: 'failed', message: redact(error.message || String(error), [config.apiKey]) };
          append({ type: 'task.failed', message: lastTask.message });
        }).finally(() => { if (active === task) active = null; });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/stop') {
        await readJson(request);
        active?.abort.abort(new Error('用户停止任务。'));
        return reply(response, 200, { stopping: Boolean(active), message: active ? '已发送停止请求，正在结束当前操作。' : '当前没有任务运行。' });
      }
      return reply(response, 404, { error: '地址不存在。' });
    } catch (error) { if (!response.destroyed && !response.headersSent) reply(response, error.status || 500, { error: redact(error.message || String(error), [config.apiKey]) }); }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.apiConfig = () => publicApiConfig(config);
  server.configureApi = value => {
    if (stopping) throw new Error('本机服务正在退出，不能修改 API 设置。');
    if (active || forwardAbort || chatService?.running || chatService?.starting || chatService?.busy || chatService?.worker?.()?.alive) throw new Error('请先停止视频任务、转发和私信自动回复，再修改 API 设置。');
    const updated = normalizeApiConfig(value);
    Object.assign(config, updated);
    agent.config = config;
    if (chatService) { chatService.config = config; if (chatService.agent) chatService.agent.config = config; }
    return publicApiConfig(config);
  };
  server.stopTask = () => { const error = new Error('控制台已关闭。'); active?.abort.abort(error); forwardAbort?.abort(error); };
  server.enforceVideoLimits = enforceVideo;
  const cleanup = () => cleanupPromise ??= (async () => {
    stopping = true;
    cancelVideoWatch?.();
    const pending = active?.completion;
    server.stopTask();
    // 暂停现有视频，再等待领域操作、浏览器连接与 worker 一起退出。
    await Promise.allSettled(['api', 'dsh'].map(source => pauseSource(source)));
    const results = await Promise.allSettled([
      ...(pending ? [pending] : []),
      ...(chatService ? [Promise.resolve().then(() => chatService.close())] : []),
      ...(typeof controller.close === 'function' ? [Promise.resolve().then(() => controller.close())] : []),
      ...shutdownHooks.map(hook => Promise.resolve().then(hook)),
    ]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, '本机服务退出时未能释放全部资源。');
  })();
  server.addShutdownHook = (hook) => {
    if (stopping || typeof hook !== 'function') throw new Error('退出清理回调必须在服务停止前注册。');
    shutdownHooks.push(hook);
  };
  server.stop = () => stopPromise ??= (async () => {
    stopping = true;
    cancelVideoWatch?.();
    server.stopTask();
    const cleaned = cleanup();
    // close 事件也会监听同一清理 Promise；提前挂拒绝处理，随后统一回传。
    void cleaned.catch(() => {});
    await new Promise((resolve, reject) => {
      server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
      server.closeIdleConnections();
    });
    await cleaned;
  })();
  server.on('close', () => {
    if (!stopPromise) void cleanup().catch((error) => console.error(`本机服务退出失败：${redact(error.message || String(error), [config.apiKey])}`));
  });
  return server;
}

export function stopApiServer(server) {
  if (typeof server?.stop !== 'function') throw new TypeError('只能停止本工具创建的服务。');
  return server.stop();
}

export async function startApiServer({ port = Number(process.env.DOUYIN_API_PORT || 3218), config = loadApiConfig(), controller, chatService, videoLimits = new VideoLimits(), mediaAdapter, htmlFile, staticRoot } = {}) {
  if (!Number.isInteger(port) || (port !== 0 && port < 1024) || port > 65535) throw new Error('端口须为 0，或 1024 至 65535 的整数。');
  if (!controller) {
    const { BrowserController } = await import('./core.mjs');
    controller = new BrowserController({ source: 'api' });
  }
  if (!chatService) {
    const [{ ChatService }, { ChatBrowser }] = await Promise.all([import('./chat-service.mjs'), import('./chat-browser.mjs')]);
    chatService = new ChatService({ browser: new ChatBrowser({ source: 'api-chat' }), config });
  }
  const { BrowserController } = await import('./core.mjs');
  if (!mediaAdapter) { const { MediaAdapter } = await import('./media/index.mjs'); mediaAdapter = new MediaAdapter(); }
  const dshVideoController = new BrowserController({ source: 'dsh' });
  const pauseVideoSources = async (source) => { const target = source === 'api' ? controller : dshVideoController; if (typeof target.pauseForLimits !== 'function') throw new Error('浏览器底座尚未提供 pauseForLimits，到点暂停未验收。'); return target.pauseForLimits(); };
  const server = createApiServer({ controller, config, chatService, videoLimits, pauseVideoSources, mediaAdapter, port, htmlFile, staticRoot });
  server.addShutdownHook(() => dshVideoController.close());
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) {
    await server.stop().catch(() => {});
    throw error;
  }
  console.log(`大肥鱼 · 视频助手：http://127.0.0.1:${server.address().port}`);
  console.log(`模型：${config.model}；凭据：${config.apiKey ? '已在内存读取' : '未配置'}`);
  const signalHandlers = ['SIGINT', 'SIGTERM'].map(signal => {
    const handler = () => { void server.stop().catch(error => { console.error(`退出失败：${redact(error.message, [config.apiKey])}`); process.exitCode = 1; }); };
    process.once(signal, handler);
    return [signal, handler];
  });
  server.addShutdownHook(() => { for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler); });
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startApiServer().catch((error) => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
}
