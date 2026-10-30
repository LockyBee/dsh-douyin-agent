import { browserPageAliases } from './browser-pages.mjs';
const permittedSources = new Set(['api', 'dsh']);
const fail = (message, code = 'BROWSER_PAUSE_FAILED') => Object.assign(new Error(message), { code });

function loopbackEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw fail('暂停检查的专用浏览器地址无效。'); }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw fail('暂停检查只接受本机已核对端口。');
  return endpoint;
}

function pageSocket(value, endpoint) {
  let socket;
  try { socket = new URL(value); } catch { throw fail('专用页面的调试地址无效。'); }
  if (socket.protocol !== 'ws:' || socket.hostname !== endpoint.hostname || socket.port !== endpoint.port || socket.username || socket.password || socket.search || socket.hash || !/^\/devtools\/page\/[A-Za-z0-9_-]+$/.test(socket.pathname)) throw fail('专用页面调试地址与已核对端口不一致。');
  return socket.href;
}

function evaluatePause(url, expression, { signal, WebSocketImpl }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let socket, settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      socket?.removeEventListener('open', open);
      socket?.removeEventListener('message', message);
      socket?.removeEventListener('error', error);
      socket?.removeEventListener('close', closed);
      try { socket?.close(); } catch {}
    };
    const finish = (failure, result) => { if (settled) return; settled = true; cleanup(); failure ? reject(failure) : resolve(result); };
    const abort = () => finish(signal.reason || fail('暂停检查已取消。', 'BROWSER_PAUSE_ABORTED'));
    const error = () => finish(fail('专用页面的暂停连接失败。'));
    const closed = () => finish(fail('暂停检查完成前页面连接已关闭。'));
    const open = () => {
      try { socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: false } })); }
      catch { error(); }
    };
    const message = event => {
      let data;
      try { data = JSON.parse(event.data); } catch { finish(fail('暂停检查收到无法解析的响应。')); return; }
      if (data.id !== 1) return;
      if (data.error || data.result?.exceptionDetails) { finish(fail('页面未能完成可核对的暂停检查。')); return; }
      const value = data.result?.result?.value;
      if (!value || typeof value.matched !== 'boolean' || !Number.isSafeInteger(value.paused) || value.paused < 0) { finish(fail('暂停检查返回了无效结果。')); return; }
      finish(null, value);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      socket = new WebSocketImpl(url);
      socket.addEventListener('open', open);
      socket.addEventListener('message', message);
      socket.addEventListener('error', error);
      socket.addEventListener('close', closed);
      if (signal.aborted) abort();
    } catch { error(); }
  });
}

// 无缓存连接的每秒时限检查只使用主运行环境，避免反复创建 Playwright 隔离环境。
export async function pauseExistingVideoPages({ endpoint, source, signal, timeoutMs = 3000, fetchImpl = fetch, WebSocketImpl = WebSocket } = {}) {
  if (!permittedSources.has(source)) throw new TypeError('暂停检查只接受 api 或 dsh 视频入口。');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new TypeError('暂停检查超时范围无效。');
  const address = loopbackEndpoint(endpoint), abort = new AbortController();
  const forwardAbort = () => abort.abort(signal.reason || fail('暂停检查已取消。', 'BROWSER_PAUSE_ABORTED'));
  signal?.addEventListener('abort', forwardAbort, { once: true });
  if (signal?.aborted) forwardAbort();
  const timer = setTimeout(() => abort.abort(fail('专用浏览器暂停检查超时。', 'BROWSER_PAUSE_TIMEOUT')), timeoutMs);
  try {
    abort.signal.throwIfAborted();
    const response = await fetchImpl(new URL('json/list', address), { signal: abort.signal, redirect: 'error' });
    if (!response.ok) throw fail('专用浏览器页面列表不可用。');
    const targets = await response.json();
    if (!Array.isArray(targets)) throw fail('专用浏览器页面列表格式无效。');
    const pages = targets.filter(target => { try { return target.type === 'page' && new URL(target.url).origin === 'https://www.douyin.com'; } catch { return false; } });
    if (pages.length > 32) throw fail('专用浏览器页面过多，暂停范围需要核对。');
    const sockets = pages.map(target => pageSocket(target.webSocketDebuggerUrl, address));
    if (new Set(sockets).size !== sockets.length) throw fail('专用浏览器页面身份重复。');
    const labels = JSON.stringify(browserPageAliases(source));
    const expression = `(()=>{if(location.origin!=='https://www.douyin.com'||!${labels}.includes(window.name))return{matched:false,paused:0};let paused=0;for(const video of document.querySelectorAll('video')){if(!video.paused)paused++;HTMLMediaElement.prototype.pause.call(video);}return{matched:true,paused};})()`;
    const results = await Promise.allSettled(sockets.map(url => evaluatePause(url, expression, { signal: abort.signal, WebSocketImpl })));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return { paused: results.reduce((sum, result) => sum + result.value.paused, 0), existingPage: results.some(result => result.value.matched) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
    if (!abort.signal.aborted) abort.abort(fail('暂停检查已结束。', 'BROWSER_PAUSE_CLOSED'));
  }
}
