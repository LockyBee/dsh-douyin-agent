import { ScheduledWatch } from './scheduled-watch.mjs';
import { interactionStatus } from './interaction-status.mjs';
import { SETTINGS_SECTIONS } from './settings-sections.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApiAgent, DEFAULT_LIMITS, loadApiConfig, normalizeApiConfig, publicApiConfig, redact } from './api-agent.mjs';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { AutonomousWatch } from './autonomous-watch.mjs';
import { AutonomousShare } from './autonomous-share.mjs';
import { TaskLimits } from './task-limits.mjs';
import { SparkService } from './spark-service.mjs';
import { AutonomousComments } from './autonomous-comments.mjs';
import { UsageLedger } from './usage-ledger.mjs';
import { WatchOptions } from './watch-options.mjs';
import { DiagnosticsService } from './diagnostics.mjs';
import { DailyReport } from './daily-report.mjs';

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

export function createApiServer({ controller, config, personaMemory, watchService, shareService, sparkService, commentService, reportService, modeService, taskLimits, agent = new ApiAgent({ controller, config, personaMemory }), chatService, videoLimits, pauseVideoSources, mediaAdapter, watchSchedule, port = 3218, htmlFile = path.join(ROOT, 'public/index.html'), staticRoot } = {}) {
  if (staticRoot !== undefined && (typeof staticRoot !== 'string' || !path.isAbsolute(staticRoot))) throw new Error('静态资源目录必须是绝对路径。');
  const stateDir = videoLimits?.stateDir ?? resolveRuntimePaths().stateDir;
  const usageLedger = new UsageLedger({ stateDir }), optionsService = watchService?.optionsService || new WatchOptions({ stateDir });
  agent.usageLedger = usageLedger;
  for (const service of [chatService, sparkService]) if (service?.agent) { service.agent.usageLedger = usageLedger; service.agent.source = 'api'; }
  watchSchedule ??= new ScheduledWatch({ stateDir, source: 'api', getVideoLimits: async () => videoLimits, getWatchState: async () => watchService?.state(), startRound: async ({maxRequests,signal}) => { signal.throwIfAborted(); return watchService.start({startSession:true,maxRequests},{explicit:true}); } });
  const diagnostics = new DiagnosticsService({ source: 'api', controller, modeService, videoLimits, watchService, watchSchedule, optionsService, usageLedger,
    modelConfigured: () => Boolean(config.apiKey), paths: { ...resolveRuntimePaths(), stateDir },
    interactionStates: () => ({ chat: chatService?.state(), spark: sparkService?.state(), comments: commentService?.state() }),
  });
  controller.diagnosticsService = diagnostics;
  const token = randomBytes(32).toString('hex');
  const events = [];
  let revision = 0;
  let active = null;
  let lastTask = null;
  let lastBrowserState = null;
  let forwardAbort = null;
  let browserAbort = null;
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
  const denyVideo = (state) => { const error = Object.assign(new Error(state.reason || '刷视频时间已结束。'), { watchStatus: 'limited' }); active?.abort.abort(error); forwardAbort?.abort(error); watchService?.cancel(error); const key = `${state.session?.id || 'none'}:${state.reason}`; if (key !== lastVideoDenial) { lastVideoDenial = key; append({ type: 'video.limited', message: state.reason || '刷视频时间已结束。' }); } };
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
        return reply(response, 200, { service: 'douyin-api-local', version: 1, sections: SETTINGS_SECTIONS, token, videoTime: { enabled: Boolean(videoLimits) }, media: { available: Boolean(mediaAdapter) }, watch: { available: Boolean(watchService) }, share: { available: Boolean(shareService) }, spark: { available: Boolean(sparkService) }, comments: { available: Boolean(commentService) }, reports: { available: Boolean(reportService) }, mode: { available: Boolean(modeService) }, persona: { available: Boolean(personaMemory) }, forward: { available: Boolean(chatService && videoLimits) }, config: redact(publicApiConfig(config), [config.apiKey]), limits: { maxSteps: agent.maxSteps ?? DEFAULT_LIMITS.maxSteps, maxToolCalls: agent.maxToolCalls ?? DEFAULT_LIMITS.maxToolCalls, taskTimeoutSeconds: (agent.taskTimeoutMs ?? DEFAULT_LIMITS.taskTimeoutMs) / 1_000, apiTimeoutSeconds: (agent.apiTimeoutMs ?? DEFAULT_LIMITS.apiTimeoutMs) / 1_000, maxTokens: agent.maxTokens ?? DEFAULT_LIMITS.maxTokens, maxFrames: agent.maxFrames ?? DEFAULT_LIMITS.maxFrames }, memory: { description: '与 QQ 机器人共享的记忆 / 视频笔记。具体连通状态以检索结果为准。', folder: memory.memoryDir, database: memory.memoryDbPath } });
      }
      if (request.method === 'GET' && !url.pathname.startsWith('/api/') && staticRoot) {
        const asset = await staticAsset(staticRoot, url.pathname);
        if (asset) return reply(response, 200, asset.data, asset.contentType);
      }
      if (!url.pathname.startsWith('/api/')) return reply(response, 404, { error: '地址不存在。' });
      if (!tokenMatches(request.headers['x-session-token'], token)) return reply(response, 403, { error: '控制台会话校验失败，请刷新页面。' });
      if (url.pathname === '/api/interactions/state' && request.method === 'GET') return reply(response, 200, interactionStatus({chat:chatService?.state(),spark:sparkService?.state(),share:shareService?.state(),comments:commentService?.state(),watch:watchService?.state(),modelReady:Boolean(config.apiKey)}));
      if (url.pathname === '/api/usage' && request.method === 'GET') return reply(response, 200, usageLedger.state());
      if (url.pathname === '/api/diagnostics' && request.method === 'POST') { const body = await readJson(request); if (Object.keys(body).length) return reply(response, 400, { error: '自检不接收参数。' }); return reply(response, 200, await diagnostics.run()); }
      if (url.pathname === '/api/diagnostics/repair' && request.method === 'POST') return reply(response, 200, await diagnostics.repair(await readJson(request)));
      if (url.pathname === '/api/watch/options') {
        if (request.method === 'GET') return reply(response, 200, optionsService.state());
        if (request.method === 'POST') { if (watchService?.state().running) return reply(response, 409, { error: '请先停止自主观看再保存主题。' }); return reply(response, 200, optionsService.configure(await readJson(request), { explicit: true })); }
      }
      if (url.pathname.startsWith('/api/comments/')) {
        if (!commentService) return reply(response, 503, { error: '自主评论服务尚未就绪。' });
        if (url.search) return reply(response, 400, { error: '评论设置不接受地址参数。' });
        if (request.method === 'GET' && url.pathname === '/api/comments/state') return reply(response, 200, redact(commentService.state(), [config.apiKey]));
        if (request.method === 'POST' && ['/api/comments/configure', '/api/comments/resolve'].includes(url.pathname)) {
          const body = await readJson(request), configuring = url.pathname.endsWith('/configure');
          if (Object.keys(body).some(key => !(configuring ? ['enabled', 'dailyLimit', 'perSessionLimit'] : ['operationId', 'outcome']).includes(key))) return reply(response, 400, { error: configuring ? '评论设置只接受总开关、每日与单轮次数。' : '评论核对只接受记录编号和实际发布结果。' });
          const state = configuring ? await commentService.configure(body, { explicit: true }) : await commentService.resolve(body, { explicit: true });
          return reply(response, 200, redact(state, [config.apiKey]));
        }
        return reply(response, 404, { error: '自主评论接口不存在。' });
      }
      if (url.pathname.startsWith('/api/reports/')) {
        if (!reportService) return reply(response, 503, { error: '本地刷视频日报尚未就绪。' });
        if (request.method === 'GET' && url.pathname === '/api/reports/state') {
          if (url.search) return reply(response, 400, { error: '日报目录读取不接受地址参数。' });
          return reply(response, 200, redact(await reportService.state(), [config.apiKey]));
        }
        if (request.method === 'GET' && url.pathname === '/api/reports/read') {
          if ([...url.searchParams.keys()].some(key => key !== 'date') || url.searchParams.getAll('date').length > 1) return reply(response, 400, { error: '日报读取只接受一个日期。' });
          return reply(response, 200, redact(await reportService.read({ ...(url.searchParams.has('date') ? { date: url.searchParams.get('date') } : {}) }), [config.apiKey]));
        }
        if (request.method === 'POST' && url.pathname === '/api/reports/generate') {
          const body = await readJson(request);
          if (url.search || Object.keys(body).length) return reply(response, 400, { error: '生成今日日报不接受正文、日期或其他参数。' });
          return reply(response, 200, redact(await reportService.generate({}), [config.apiKey]));
        }
        return reply(response, 404, { error: '日报接口不存在。' });
      }
      if (url.pathname.startsWith('/api/mode/')) {
        if (!modeService) return reply(response, 503, { error: '静默观看模式尚未就绪。' });
        if (url.search) return reply(response, 400, { error: '静默模式不接受地址参数。' });
        if (request.method === 'GET' && url.pathname === '/api/mode/state') return reply(response, 200, modeService.state());
        if (request.method === 'POST' && url.pathname === '/api/mode/configure') {
          const body = await readJson(request);
          if (Object.keys(body).length !== 1 || typeof body.silent !== 'boolean') return reply(response, 400, { error: '静默模式只接受 silent 布尔开关。' });
          const state = await modeService.configure(body, { explicit: true });
          const applied = typeof controller.applyWatchMode === 'function' ? await controller.applyWatchMode({ minimize: state.silent }) : { applied: false, pendingNextVideoAction: true };
          modeService.application = applied;
          return reply(response, 200, { ...modeService.state(), ...applied, application: applied });
        }
        return reply(response, 404, { error: '静默模式接口不存在。' });
      }
      if (url.pathname.startsWith('/api/spark/')) {
        if (!sparkService) return reply(response, 503, { error: '自动续火花服务尚未就绪。' });
        if (request.method === 'GET' && url.pathname === '/api/spark/state') return reply(response, 200, redact(sparkService.state(), [config.apiKey]));
        if (request.method === 'POST') {
          const body = await readJson(request);
          if (url.pathname === '/api/spark/configure') return reply(response, 200, redact(await sparkService.configure(body, { explicit: true }), [config.apiKey]));
          if (['/api/spark/start', '/api/spark/stop'].includes(url.pathname)) {
            if (Object.keys(body).length) return reply(response, 400, { error: '续火花启停不接受额外参数。' });
            const state = url.pathname.endsWith('/start') ? await sparkService.start({ schedule: true, explicit: true }) : await sparkService.stop({ explicit: true });
            return reply(response, 200, redact(state, [config.apiKey]));
          }
          if (url.pathname === '/api/spark/resolve') {
            if (Object.keys(body).some(key => !['operationId', 'outcome'].includes(key))) return reply(response, 400, { error: '核对只接受记录编号和实际发送结果。' });
            return reply(response, 200, redact(await sparkService.resolve(body, { explicit: true }), [config.apiKey]));
          }
        }
        return reply(response, 404, { error: '自动续火花接口不存在。' });
      }
      if (url.pathname === '/api/task/limits') {
        if (!taskLimits) return reply(response, 503, { error: '手动任务预算尚未就绪。' });
        if (request.method === 'GET') return reply(response, 200, taskLimits.state());
        if (request.method === 'POST') {
          const body = await readJson(request);
          if (active || forwardAbort || shareService?.active || watchService?.state().running) return reply(response, 409, { error: '请先停止当前视频任务、自主观看或转发，再修改手动任务预算。' });
          const updated = taskLimits.configure(body, { explicit: true });
          Object.assign(agent, { maxSteps: updated.policy.maxSteps, maxToolCalls: updated.policy.maxToolCalls, taskTimeoutMs: updated.policy.timeoutSeconds * 1000 });
          return reply(response, 200, updated);
        }
        return reply(response, 405, { error: '手动任务预算只支持读取和保存。' });
      }
      if (url.pathname.startsWith('/api/share/')) {
        if (!shareService) return reply(response, 503, { error: '自主分享模块尚未就绪。' });
        if (request.method === 'GET' && url.pathname === '/api/share/state') return reply(response, 200, redact(shareService.state(), [config.apiKey]));
        if (request.method === 'POST' && url.pathname === '/api/share/configure') return reply(response, 200, redact(shareService.configure(await readJson(request), { explicit: true }), [config.apiKey]));
        if (request.method === 'POST' && url.pathname === '/api/share/resolve') {
          const body = await readJson(request);
          if (Object.keys(body).some(key => !['operationId', 'outcome'].includes(key))) return reply(response, 400, { error: '核对记录只接受记录编号和实际发送结果。' });
          return reply(response, 200, redact(shareService.resolve(body, { explicit: true }), [config.apiKey]));
        }
        return reply(response, 404, { error: '自主分享接口不存在。' });
      }
      if (url.pathname === '/api/browser/open' && request.method === 'POST') {
        const body = await readJson(request);
        if (Object.keys(body).length) return reply(response, 400, { error: '打开抖音不接受额外参数。' });
        if (typeof controller.openBrowser !== 'function') return reply(response, 503, { error: '专用浏览器入口尚未就绪。' });
        if (browserAbort) return reply(response, 409, { error: '专用浏览器正在打开，请等待当前操作完成。' });
        const abort = new AbortController(); browserAbort = abort;
        const closed = () => { if (!response.writableEnded) abort.abort(new Error('窗口已关闭，停止准备浏览器。')); };
        response.once('close', closed);
        try { return reply(response, 200, await controller.openBrowser({ signal: AbortSignal.any([abort.signal, AbortSignal.timeout(75_000)]) })); }
        finally { response.removeListener('close', closed); if (browserAbort === abort) browserAbort = null; }
      }
      if (url.pathname.startsWith('/api/watch/')) {
        if (!watchService) return reply(response, 503, { error: '自主观看模块尚未就绪。' });
        if (request.method === 'GET' && url.pathname === '/api/watch/schedule') return reply(response,200,watchSchedule.state());
        if (request.method === 'GET' && url.pathname === '/api/watch/state') return reply(response, 200, watchService.state());
        if (request.method === 'POST') {
          const body = await readJson(request);
          if (url.pathname === '/api/watch/schedule') return reply(response,200,watchSchedule.configure(body,{explicit:true}));
          if (url.pathname === '/api/watch/start') {
            if (Object.keys(body).some(key => !['startSession', 'maxRequests'].includes(key))) return reply(response, 400, { error: '自主观看只接受是否开启有限轮次及请求上限。' });
            if (active || forwardAbort) return reply(response, 409, { error: '请先停止手动视频任务或等待转发结束。' });
            return reply(response, 200, watchService.start(body, { explicit: true }));
          }
          if (url.pathname === '/api/watch/stop') {
            if (Object.keys(body).length) return reply(response, 400, { error: '停止自主观看不接受额外参数。' });
            return reply(response, 200, await watchService.stop({ explicit: true }));
          }
        }
        return reply(response, 404, { error: '自主观看接口不存在。' });
      }
      if (url.pathname === '/api/persona' && request.method === 'GET') {
        if (!personaMemory) return reply(response, 503, { error: '共同人格模块尚未就绪。' });
        return reply(response, 200, personaMemory.snapshot());
      }
      if (url.pathname === '/api/persona/card' && request.method === 'POST') {
        if (!personaMemory) return reply(response, 503, { error: '共同人格模块尚未就绪。' });
        const body = await readJson(request);
        if (Object.keys(body).some(key => !['text', 'expectedRevision'].includes(key))) return reply(response, 400, { error: '人格卡只接受正文和读取时的版本。' });
        if (watchService?.state().running) return reply(response, 409, { error: '请先停止两个入口的自主观看，再修改人格卡。' });
        try { return reply(response, 200, personaMemory.saveManualText(body, { explicit: true })); }
        catch (error) { error.status ||= error.code === 'PERSONA_REVISION_CONFLICT' ? 409 : 400; throw error; }
      }
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
          if (forwardAbort || active || watchService?.state().running) return reply(response, 409, { error: '已有视频任务、自主观看或转发正在执行，请等待完成。' });
          if (!chatService.state().policy.allowlist.some((item) => item.id === body.recipientId && item.followed === true && item.isGroup === false)) return reply(response, 403, { error: '此联系人不在已核对的许可名单内。' });
          const permit = videoLimits.beforeAction('api', 'douyin_forward_video');
          if (!permit.allowed) { await enforceVideo(); return reply(response, 409, { error: permit.reason }); }
          const releaseManual = watchService?.claimManual('forward');
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
          } finally { if (forwardAbort === abort) forwardAbort = null; await releaseManual?.(); }
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
          if (watchService?.state().running) return reply(response, 409, { error: '请先停止自主观看，再开始新一轮。' });
          active?.abort.abort(new Error('用户开始新一轮，结束上一次视频任务。'));
          forwardAbort?.abort(new Error('用户开始新一轮，结束上一次转发操作。'));
          await Promise.allSettled(['api','dsh'].map((source) => pauseSource(source)));
          const state = videoLimits.markSession('api', { explicit: true }); lastVideoDenial = '';
          append({ type: 'video.started', message: `已开始新一轮，${state.policy.sessionMinutes === null ? '不限单轮时长' : `上限 ${state.policy.sessionMinutes} 分钟`}；API 与 DSH 共用这轮时钟。` });
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
        if (active || forwardAbort || watchService?.state().running) return reply(response, 409, { error: '已有任务、自主观看或转发正在执行，请等待或停止。' });
        if (videoLimits) { const permit = videoLimits.beforeAction('api', 'douyin_open'); if (!permit.allowed) { await enforceVideo(); return reply(response, 409, { error: permit.reason, videoTime: permit.state }); } }
        if (!config.apiKey) return reply(response, 400, { error: '未配置 DeepSeek API Key，请打开本机 API 设置。' });
        const { instruction } = await readJson(request);
        if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 4_000) return reply(response, 400, { error: '任务请输入 1 至 4000 个字符。' });
        if (active || forwardAbort || watchService?.state().running) return reply(response, 409, { error: '已有任务、自主观看或转发正在执行，请等待或停止。' });
        const releaseManual = watchService?.claimManual('task');
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
        }).finally(async () => { try { await releaseManual?.(); } catch (error) { append({ type: 'task.coordination_error', message: error.message }); } finally { if (active === task) active = null; } });
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
    const spark = sparkService?.state();
    if (active || forwardAbort || shareService?.active || commentService?.active || watchService?.state().running || chatService?.running || chatService?.starting || chatService?.busy || chatService?.worker?.()?.alive || spark?.running || spark?.starting || spark?.busy || spark?.worker?.alive) throw new Error('请先停止视频任务、自主观看、评论、转发、私信回复和续火花服务，再修改 API 设置。');
    const updated = normalizeApiConfig(value);
    Object.assign(config, updated);
    agent.config = config;
    if (chatService) { chatService.config = config; if (chatService.agent) chatService.agent.config = config; }
    if (watchService) { watchService.config = config; if (watchService.agent) watchService.agent.config = config; if (watchService.commentAgent) watchService.commentAgent.config = config; }
    if (sparkService) { sparkService.config = config; if (sparkService.agent) sparkService.agent.config = config; }
    return publicApiConfig(config);
  };
  server.stopTask = () => { const error = new Error('控制台已关闭。'); active?.abort.abort(error); forwardAbort?.abort(error); browserAbort?.abort(error); watchService?.cancel(); };
  server.enforceVideoLimits = enforceVideo;
  const cleanup = () => cleanupPromise ??= (async () => {
    stopping = true;
    cancelVideoWatch?.();
    await watchSchedule.close();
    const pending = active?.completion;
    server.stopTask();
    // 暂停现有视频，再等待领域操作、浏览器连接与 worker 一起退出。
    const sharedWatch = watchService?.state();
    const protectedSource = sharedWatch?.worker?.alive && !sharedWatch.owned ? sharedWatch.worker.source : null;
    await Promise.allSettled(['api', 'dsh'].filter(source => source !== protectedSource).map(source => pauseSource(source)));
    // 续火花复用私信浏览器，先取消其发送事务再关闭共用页面。
    const sparkResults = await Promise.allSettled(sparkService ? [Promise.resolve().then(() => sparkService.close())] : []);
    const results = await Promise.allSettled([
      ...(pending ? [pending] : []),
      ...(watchService ? [Promise.resolve().then(() => watchService.close())] : []),
      ...(shareService ? [Promise.resolve().then(() => shareService.close())] : []),
      ...(commentService ? [Promise.resolve().then(() => commentService.close())] : []),
      ...(chatService ? [Promise.resolve().then(() => chatService.close())] : []),
      ...(typeof controller.close === 'function' ? [Promise.resolve().then(async () => { if (controller.source === protectedSource) controller.limitsEnabled = false; await controller.close(); })] : []),
      ...shutdownHooks.map(hook => Promise.resolve().then(hook)),
    ]);
    const errors = [...sparkResults, ...results].filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, '本机服务退出时未能释放全部资源。');
  })();
  server.addShutdownHook = (hook) => {
    if (stopping || typeof hook !== 'function') throw new Error('退出清理回调必须在服务停止前注册。');
    shutdownHooks.push(hook);
  };
  server.watchSchedule = watchSchedule;
  server.stop = () => stopPromise ??= (async () => {
    stopping = true;
    cancelVideoWatch?.();
    await watchSchedule.close();
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

export async function startApiServer({ port = Number(process.env.DOUYIN_API_PORT || 3218), config = loadApiConfig(), controller, chatService, videoLimits = new VideoLimits(), mediaAdapter, personaMemory, watchService, shareService, sparkService, commentService, reportService, modeService, taskLimits, htmlFile, staticRoot } = {}) {
  if (!Number.isInteger(port) || (port !== 0 && port < 1024) || port > 65535) throw new Error('端口须为 0，或 1024 至 65535 的整数。');
  if (!controller) {
    const { BrowserController } = await import('./core.mjs');
    controller = new BrowserController({ source: 'api', videoLimits });
  }
  if (!chatService) {
    const [{ ChatService }, { ChatBrowser }] = await Promise.all([import('./chat-service.mjs'), import('./chat-browser.mjs')]);
    chatService = new ChatService({ browser: new ChatBrowser({ source: 'api-chat' }), config });
  }
  const { BrowserController } = await import('./core.mjs');
  if (!mediaAdapter) { const { MediaAdapter } = await import('./media/index.mjs'); mediaAdapter = new MediaAdapter(); }
  if (!personaMemory) { const { PersonaMemory } = await import('./persona-memory.mjs'); personaMemory = new PersonaMemory(); personaMemory.initialize({ importLegacy: false }); }
  if (chatService?.agent) chatService.agent.personaMemory = personaMemory;
  taskLimits ??= new TaskLimits({ stateDir: videoLimits.stateDir ?? resolveRuntimePaths().stateDir });
  const taskPolicy = taskLimits.state().policy;
  const agent = new ApiAgent({ controller, config, personaMemory, maxSteps: taskPolicy.maxSteps, maxToolCalls: taskPolicy.maxToolCalls, taskTimeoutMs: taskPolicy.timeoutSeconds * 1000 });
  if (!shareService) shareService = new AutonomousShare({ controller, videoLimits, personaMemory, stateDir: videoLimits.stateDir ?? resolveRuntimePaths().stateDir, source: 'api' });
  if (!commentService) commentService = new AutonomousComments({ controller, videoLimits, personaMemory, stateDir: videoLimits.stateDir ?? resolveRuntimePaths().stateDir, source: 'api' });
  if (!reportService && personaMemory.personaFolder && personaMemory.stateFile) reportService = new DailyReport({ personaMemory });
  if (!modeService) {
    if (typeof controller.getWatchMode === 'function') modeService = await controller.getWatchMode();
    else { const { WatchMode } = await import('./watch-mode.mjs'); modeService = new WatchMode({ stateDir: videoLimits.stateDir ?? resolveRuntimePaths().stateDir, source: 'api' }); }
  }
  if (!sparkService && chatService.browser) sparkService = new SparkService({ browser: chatService.browser, config, personaMemory, stateDir: videoLimits.stateDir ?? resolveRuntimePaths().stateDir, source: 'api' });
  if (!watchService) watchService = new AutonomousWatch({ controller, config, personaMemory, videoLimits, agent, stateDir: videoLimits.stateDir ?? resolveRuntimePaths().stateDir });
  watchService.shareService = shareService;
  watchService.commentService = commentService; watchService.ownsCommentService = false;
  if (reportService) watchService.reportService = reportService;
  const dshVideoController = new BrowserController({ source: 'dsh' });
  const pauseVideoSources = async (source) => { const target = source === 'api' ? controller : dshVideoController; if (typeof target.pauseForLimits !== 'function') throw new Error('浏览器底座尚未提供 pauseForLimits，到点暂停未验收。'); return target.pauseForLimits(); };
  const server = createApiServer({ controller, config, chatService, videoLimits, pauseVideoSources, mediaAdapter, personaMemory, watchService, shareService, sparkService, commentService, reportService, modeService, taskLimits, agent, port, htmlFile, staticRoot });
  server.addShutdownHook(() => { const state = watchService.state(); if (state.worker?.alive && !state.owned && state.worker.source === 'dsh') dshVideoController.limitsEnabled = false; return dshVideoController.close(); });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) {
    await server.stop().catch(() => {});
    throw error;
  }
  server.watchSchedule.start();
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
