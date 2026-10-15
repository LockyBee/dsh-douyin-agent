import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEVELOPMENT_DOMAIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`${label}必须是绝对路径。`);
  return path.normalize(value);
}

export function runApiWorker() {
  if (typeof process.send !== 'function' || !process.connected || process.versions.electron) throw new Error('独立后台必须由软件使用物理 Node 和私有 IPC 启动。');
  let server;
  let config;
  let api;
  let starting;
  let stopping;
  let queue = Promise.resolve();
  const secrets = new Set();
  const send = value => new Promise(resolve => {
    if (!process.connected) return resolve();
    process.send(value, () => resolve());
  });
  const safeError = error => {
    let message = String(error?.message ?? error).replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [凭据已隐藏]').replace(/\bsk-[\w-]+/g, '[凭据已隐藏]');
    for (const secret of secrets) if (secret) message = message.split(secret).join('[凭据已隐藏]');
    return message.slice(0, 1000);
  };
  const stop = () => stopping ??= (async () => {
    await starting?.catch(() => {});
    await server?.stop();
    if (config) config.apiKey = '';
  })();
  const exit = async code => {
    try { await stop(); }
    catch { code = 1; }
    process.exit(code);
  };
  const start = async options => {
    if (server || starting || stopping) throw new Error('独立后台已经启动或正在退出。');
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['config', 'htmlFile', 'staticRoot', 'domainRoot'].includes(key))) throw new Error('独立后台启动参数无效。');
    const domainRoot = absolute(options.domainRoot ?? DEVELOPMENT_DOMAIN_ROOT, '领域源码目录');
    const htmlFile = absolute(options.htmlFile, '软件首页');
    const staticRoot = absolute(options.staticRoot, '软件资源目录');
    const [actualHtml, actualStaticRoot] = await Promise.all([fs.realpath(htmlFile), fs.realpath(staticRoot)]);
    const relativeHtml = path.relative(actualStaticRoot, actualHtml);
    if (!relativeHtml || relativeHtml === '..' || relativeHtml.startsWith(`..${path.sep}`) || path.isAbsolute(relativeHtml) || !(await fs.stat(actualHtml)).isFile()) throw new Error('软件首页必须位于软件资源目录内。');
    const apiModule = pathToFileURL(path.join(domainRoot, 'api-agent.mjs')).href;
    api = await import(apiModule);
    config = api.normalizeApiConfig(options.config ?? {});
    if (config.apiKey) secrets.add(config.apiKey);
    const { startApiServer } = await import(pathToFileURL(path.join(domainRoot, 'app.mjs')).href);
    server = await startApiServer({ port: 0, config, htmlFile, staticRoot });
    if (stopping) { await server.stop(); throw new Error('独立后台启动已取消。'); }
    const ready = { port: server.address().port, pid: process.pid };
    await send({ type: 'ready', ...ready });
    return { ...ready, config: server.apiConfig() };
  };
  const command = async message => {
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(message.requestId)) return;
    const { requestId, type } = message;
    try {
      let result;
      if (type === 'start') {
        const pending = start(message.options);
        starting = pending;
        try { result = await pending; } finally { starting = undefined; }
      } else if (type === 'configure') {
        if (!server || stopping) throw new Error('独立后台尚未就绪。');
        const next = api.normalizeApiConfig(message.config ?? {});
        if (next.apiKey) secrets.add(next.apiKey);
        result = server.configureApi(next);
      } else if (type === 'get-config') {
        if (!server || stopping) throw new Error('独立后台尚未就绪。');
        result = server.apiConfig();
      } else if (type === 'stop') {
        await stop();
        result = { stopped: true };
      } else throw new Error('不支持的独立后台命令。');
      await send({ type: 'response', requestId, ok: true, result });
      if (type === 'stop') process.exit(0);
    } catch (error) {
      await send({ type: 'response', requestId, ok: false, error: safeError(error) });
      if (type === 'stop') process.exit(1);
    }
  };
  process.on('message', message => { queue = queue.then(() => command(message)).catch(() => exit(1)); });
  process.once('disconnect', () => { void exit(0); });
  process.once('SIGINT', () => { void exit(0); });
  process.once('SIGTERM', () => { void exit(0); });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runApiWorker(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
