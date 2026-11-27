import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectDedicatedVerification, readVerificationPage } from './core.mjs';

const ID = /^[a-f0-9]{32}$/i;
const COMMAND_TIMEOUT = 5_000;
const IDLE_TIMEOUT = 25_000;
const MAX_FRAME = 1_500_000;
const invalid = (message = '验证操作参数无效。') => Object.assign(new Error(message), { status: 400 });
const conflict = message => Object.assign(new Error(message), { status: 409 });
const changed = () => conflict('专用浏览器或验证画面已变化，请重新打开辅助验证。');
const publicState = state => ({ status: state.status, mode: state.mode ?? null, required: state.verificationRequired ?? null });
const pageExpression = `(() => {
  const page = (${readVerificationPage.toString()})();
  return page && { ...page, width: innerWidth, height: innerHeight, documentStart: performance.timeOrigin };
})()`;

function readOwner(directory) {
  try {
    const file = path.join(directory, 'browser.json'), stat = fs.lstatSync(file);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16_384) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* 浏览器尚未就绪或已结束。 */ }
  return null;
}

async function connectTab(url, { signal, WebSocketImpl = WebSocket } = {}) {
  const socket = new WebSocketImpl(url);
  const pending = new Map();
  let sequence = 0;
  const failure = () => conflict('验证画面连接已断开，请重新打开辅助验证。');
  const rejectPending = () => {
    for (const command of pending.values()) command.reject(failure());
    pending.clear();
  };
  socket.addEventListener('close', rejectPending, { once: true });
  socket.addEventListener('error', rejectPending, { once: true });
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string' || event.data.length > MAX_FRAME + 32_768) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const command = pending.get(message.id);
    if (command) {
      if (message.error || message.result?.exceptionDetails) command.reject(failure());
      else command.resolve(message.result);
    }
  });
  const close = () => {
    rejectPending();
    try { socket.close(); } catch { /* 已断开。 */ }
  };
  try {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', abort);
        socket.removeEventListener('open', open);
        socket.removeEventListener('close', abort);
        socket.removeEventListener('error', abort);
      };
      const open = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(failure()); };
      signal.addEventListener('abort', abort, { once: true });
      socket.addEventListener('open', open, { once: true });
      socket.addEventListener('close', abort, { once: true });
      socket.addEventListener('error', abort, { once: true });
    });
  } catch (error) { close(); throw error; }
  return {
    close,
    async send(method, params) {
      if (socket.readyState !== 1) throw failure();
      const id = ++sequence;
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          timer = setTimeout(() => reject(failure()), COMMAND_TIMEOUT);
          socket.send(JSON.stringify({ id, method, params }));
        });
      } finally { clearTimeout(timer); pending.delete(id); }
    },
  };
}

function keys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === allowed.length && allowed.every(key => Object.hasOwn(value, key));
}

const navigationKeys = new Map(Object.entries({
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
}));
function inputCommand(event, page, pressed) {
  const type = event?.type;
  if (type === 'text' && keys(event, ['type', 'text']) && typeof event.text === 'string'
    && event.text.length > 0 && event.text.length <= 128 && !/[\x00-\x1f\x7f]/u.test(event.text)) {
    return [['Input.insertText', { text: event.text }]];
  }
  if (type === 'key' && keys(event, ['type', 'key']) && navigationKeys.has(event.key)) {
    const key = { key: event.key, windowsVirtualKeyCode: navigationKeys.get(event.key) };
    return ['rawKeyDown', 'keyUp'].map(type => ['Input.dispatchKeyEvent', { type, ...key }]);
  }
  if (!['press', 'move', 'release', 'wheel'].includes(type)
    || !keys(event, type === 'wheel' ? ['type', 'x', 'y', 'delta'] : ['type', 'x', 'y'])
    || ![event.x, event.y].every(value => Number.isFinite(value) && value >= 0 && value < 1)) throw invalid();
  const point = { x: Math.floor(event.x * page.width), y: Math.floor(event.y * page.height) };
  if (type === 'wheel') {
    if (!Number.isFinite(event.delta) || Math.abs(event.delta) > 1600) throw invalid();
    return [['Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: event.delta }]];
  }
  if (type === 'press' ? pressed : !pressed) throw conflict('这次指针操作已结束，请重新操作。');
  return [['Input.dispatchMouseEvent', {
    ...point,
    type: { press: 'mousePressed', move: 'mouseMoved', release: 'mouseReleased' }[type],
    button: type === 'move' ? 'none' : 'left', buttons: type === 'release' ? 0 : 1,
    ...(type !== 'move' ? { clickCount: 1 } : {}),
  }]];
}

// 仅在本人打开辅助验证后，接到同一专用标签。画面和人工输入只在本机设置接口传递。
export class NativeBrowserVerification {
  constructor(controller, { inspect = inspectDedicatedVerification, connect = connectTab, owner = readOwner } = {}) {
    this.options = { profile: controller.browserProfile, port: controller.browserPort, controlDir: controller.controlDirectory };
    Object.assign(this, { inspect, connect, owner });
  }

  readHost() { return this.owner(this.options.controlDir); }

  isCurrent(session) {
    const owner = this.readHost();
    return this.session === session && owner?.ready === true && owner.port === this.options.port
      && owner.instanceId === session.binding.instanceId && owner.pid === session.pid && owner.startedAt === session.startedAt;
  }

  close() {
    const session = this.session;
    this.session = null;
    clearTimeout(session?.timer);
    session?.tab.close();
  }

  dispose() {
    this.disposed = true;
    this.close();
  }

  touch(session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => { if (this.session === session) this.close(); }, IDLE_TIMEOUT);
    session.timer.unref();
  }

  async check() {
    const session = this.session;
    const state = await this.inspect(undefined, { ...this.options, signal: AbortSignal.timeout(COMMAND_TIMEOUT) });
    if (session && this.session === session && (!this.isCurrent(session) || state.status !== 'required'
      || state.binding?.targetId !== session.binding.targetId)) this.close();
    return publicState(state);
  }

  async isWatchReady() {
    const state = await this.inspect(undefined, {
      ...this.options, pageSource: 'dsh', signal: AbortSignal.timeout(COMMAND_TIMEOUT),
    });
    return state.status === 'ready' && state.verificationRequired === false;
  }

  async open() {
    if (this.disposed || this.opening) throw conflict('辅助验证正在准备，请稍候。');
    this.opening = true;
    let tab;
    try {
      this.close();
      const signal = AbortSignal.timeout(COMMAND_TIMEOUT);
      const state = await this.inspect(undefined, { ...this.options, signal });
      if (state.status !== 'required') return publicState(state);
      const host = this.readHost(), binding = state.binding;
      if (!ID.test(binding?.targetId ?? '') || !host?.ready || host.instanceId !== binding.instanceId || host.port !== this.options.port
        || !Number.isSafeInteger(host.pid) || host.pid < 1 || !Number.isFinite(host.startedAt)) throw changed();
      tab = await this.connect(`ws://127.0.0.1:${host.port}/devtools/page/${binding.targetId}`, { signal });
      const session = { id: randomUUID(), tab, binding, pid: host.pid, startedAt: host.startedAt, mode: state.mode, pressed: false };
      if (this.disposed) throw changed();
      this.session = session;
      if (!this.isCurrent(session)) { this.close(); throw changed(); }
      this.touch(session);
      return { ...publicState(state), status: 'opened', session: session.id };
    } catch (error) { tab?.close(); throw error; }
    finally { this.opening = false; }
  }

  requireSession(id) {
    const session = this.session;
    if (!session || session.id !== id) throw changed();
    if (!this.isCurrent(session)) { this.close(); throw changed(); }
    this.touch(session);
    return session;
  }

  async readPage(session) {
    const result = await session.tab.send('Runtime.evaluate', { expression: pageExpression, returnByValue: true });
    if (!this.isCurrent(session)) throw changed();
    const page = result?.result?.value;
    if (!page?.verificationRequired && !page?.loginRequired) return null;
    if (![page.width, page.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192)
      || typeof page.href !== 'string' || !Number.isFinite(page.documentStart)) throw changed();
    page.identity = JSON.stringify([page.href, page.documentStart, page.width, page.height]);
    return page;
  }

  async frame(id) {
    const session = this.requireSession(id);
    const before = await this.readPage(session);
    if (!before) { this.close(); return this.check(); }
    const result = await session.tab.send('Page.captureScreenshot', { format: 'jpeg', quality: 65, captureBeyondViewport: false });
    const after = await this.readPage(session);
    if (!after) { this.close(); return this.check(); }
    if (before.identity !== after.identity) return { status: 'refreshing', mode: session.mode, required: after.verificationRequired };
    if (!result?.data || result.data.length > MAX_FRAME || typeof result.data !== 'string') throw changed();
    if (session.frame?.identity !== after.identity) {
      session.frame = { identity: after.identity, view: randomUUID() };
      session.pressed = false;
    }
    return { status: 'opened', mode: session.mode, required: after.verificationRequired, frame: { data: result.data, view: session.frame.view } };
  }

  async input(id, view, event) {
    const session = this.requireSession(id);
    if (session.inputInFlight) throw conflict('上一个验证操作正在处理。');
    session.inputInFlight = true;
    try {
      const page = await this.readPage(session);
      if (!page) { this.close(); return this.check(); }
      if (session.frame?.view !== view || session.frame.identity !== page.identity) throw conflict('验证画面已更新，请重新操作。');
      const commands = inputCommand(event, page, session.pressed);
      for (const [method, params] of commands) {
        if (!this.isCurrent(session)) throw changed();
        await session.tab.send(method, params);
      }
      if (event.type === 'press') session.pressed = true;
      if (event.type === 'release') session.pressed = false;
      return { status: 'opened', mode: session.mode, required: page.verificationRequired };
    } finally { session.inputInFlight = false; }
  }

  async control(input) {
    if (keys(input, ['action'])) {
      if (input.action === 'check') return this.check();
      if (input.action === 'open') return this.open();
    }
    if (keys(input, ['action', 'session']) && input.action === 'close' && typeof input.session === 'string') {
      if (this.session?.id === input.session) this.close();
      return { status: 'closed' };
    }
    throw invalid();
  }

  async capture(input) {
    if (!keys(input, ['session']) || typeof input.session !== 'string') throw invalid();
    return this.frame(input.session);
  }

  async operate(input) {
    if (!keys(input, ['session', 'view', 'event']) || typeof input.session !== 'string' || typeof input.view !== 'string') throw invalid();
    return this.input(input.session, input.view, input.event);
  }
}
