import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export class ApiProcess {
  constructor(node, runtime, { env = process.env, timeoutMs = 30_000 } = {}) {
    Object.assign(this, { node, runtime, env, timeoutMs });
    this.pending = new Map(); this.secrets = new Set(); this.stderr = '';
  }
  safe(value) {
    let result = String(value).replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [凭据已隐藏]');
    for (const key of this.secrets) result = result.split(key).join('[凭据已隐藏]');
    return result.slice(-12000);
  }
  request(type, extra = {}, timeoutMs = this.timeoutMs) {
    if (extra.config?.apiKey) this.secrets.add(extra.config.apiKey);
    if (extra.options?.config?.apiKey) this.secrets.add(extra.options.config.apiKey);
    if (!this.child?.connected) return Promise.reject(new Error('软件后台没有连接。'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('软件后台操作超时。')); }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.child.send({ type, requestId, ...extra }, error => {
        if (!error) return;
        const pending = this.pending.get(requestId); if (!pending) return;
        clearTimeout(timer); this.pending.delete(requestId); reject(new Error(this.safe(error.message)));
      });
    });
  }
  async start(config, { htmlFile, staticRoot } = {}) {
    if (this.child) throw new Error('软件后台已经启动。');
    const env = { ...this.env };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']) delete env[key];
    this.child = spawn(this.node, [path.join(this.runtime, 'api-worker.mjs')], { cwd: this.runtime, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    this.child.stdout.resume();
    this.child.stderr.on('data', data => { this.stderr = this.safe(this.stderr + data.toString('utf8')); });
    this.exited = new Promise(resolve => {
      let finished = false;
      const finish = (code, signal) => {
        if (finished) return; finished = true;
        this.exitCode = code; this.exitSignal = signal;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(`软件后台已退出（${code ?? signal}）。${this.stderr}`)); }
        this.pending.clear(); resolve();
      };
      this.child.once('exit', finish);
      this.child.once('close', finish);
      this.child.once('error', () => finish(null, 'spawn-error'));
    });
    this.child.on('error', error => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(this.safe(error.message))); }
      this.pending.clear();
    });
    this.child.on('message', message => {
      if (message?.type !== 'response' || typeof message.requestId !== 'string') return;
      const pending = this.pending.get(message.requestId); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.requestId);
      if (message.ok === true) pending.resolve(message.result);
      else pending.reject(new Error(this.safe(message.error || '软件后台操作失败。')));
    });
    try {
      const result = await this.request('start', { options: { config, domainRoot: this.runtime, htmlFile: htmlFile || path.join(this.runtime, 'public', 'index.html'), staticRoot: staticRoot || path.join(this.runtime, 'public') } });
      if (!Number.isSafeInteger(result.port) || result.port < 1024 || result.port > 65535) throw new Error('软件后台返回了无效端口。');
      this.origin = `http://127.0.0.1:${result.port}`; return result;
    } catch (error) { await this.stop().catch(() => {}); throw error; }
  }
  configure(config) { return this.request('configure', { config }); }
  getConfig() { return this.request('get-config'); }
  stop() { return this.stopping ??= this.stopOnce(); }
  async stopOnce() {
    if (!this.child) return;
    if (this.child.connected) { try { await this.request('stop', {}, 8000); } catch {} }
    const wait = milliseconds => new Promise(resolve => { const timer = setTimeout(() => resolve(false), milliseconds); this.exited.then(() => { clearTimeout(timer); resolve(true); }); });
    if (!await wait(1000)) this.child.kill('SIGTERM');
    if (!await wait(5000)) { this.child.kill('SIGKILL'); if (!await wait(2000)) throw new Error('软件后台未能退出。'); }
    this.secrets.clear();
  }
}
