const origin = 'http://127.0.0.1:9227';
const configuredSessions = new WeakSet();

function verificationView(targetId) {
  if (typeof targetId !== 'string' || !/^[a-f0-9]{32}$/i.test(targetId)) {
    throw new Error('未核对到可用于验证的专用标签。');
  }
  const url = new URL('/devtools/inspector.html', origin);
  const target = `${url.host}/devtools/page/${targetId}`;
  url.searchParams.set('ws', target);
  return { url: url.href, socket: `ws://${target}` };
}

export function createBrowserVerification({ inspect, openView }) {
  let binding, view, pending, disposed = false;
  const closeView = () => {
    const previous = view;
    view = null;
    if (previous && !previous.isDestroyed()) previous.close();
  };

  async function run(open) {
    if (disposed) throw new Error('软件窗口已关闭。');
    const state = await inspect(binding);
    if (disposed) throw new Error('软件窗口已关闭。');
    const mode = state.mode;
    if (state.status === 'ready') {
      const verified = Boolean(binding);
      closeView();
      binding = undefined;
      const current = verified ? await inspect().catch(() => null) : state;
      if (disposed) throw new Error('软件窗口已关闭。');
      const verificationRequired = current?.verificationRequired === true;
      return { status: verificationRequired ? 'required' : verified ? 'verified' : 'ready', mode: current?.mode ?? mode, verificationRequired };
    }
    if (state.status === 'session-changed' || state.status === 'browser-unavailable') {
      closeView();
      binding = undefined;
    }
    if (state.status !== 'required' || !open) return { status: state.status, mode, verificationRequired: state.verificationRequired ?? null };
    if (!state.binding || typeof state.binding.instanceId !== 'string') {
      throw new Error('专用浏览器会话无法核对，请重新检查。');
    }
    const target = verificationView(state.binding.targetId);
    if (view && !view.isDestroyed()) showVerificationView(view);
    else {
      const opened = await openView(target);
      if (disposed) {
        if (!opened.isDestroyed()) opened.close();
        throw new Error('软件窗口已关闭。');
      }
      view = opened;
    }
    binding = state.binding;
    return { status: 'opened', mode, verificationRequired: state.verificationRequired ?? null };
  }

  function request(open) {
    if (pending) return pending;
    pending = run(open).finally(() => { pending = null; });
    return pending;
  }

  return { open: () => request(true), check: () => request(false), close() { disposed = true; closeView(); } };
}

function showVerificationView(view) {
  if (view.isMinimized()) view.restore();
  view.show();
  view.focus();
}

export async function openBrowserVerificationWindow(BrowserWindow, target) {
  const view = new BrowserWindow({
    title: '抖音辅助验证', width: 1050, height: 800, show: false,
    autoHideMenuBar: true, backgroundColor: '#171a1f',
    webPreferences: {
      partition: 'douyin-manual-verification',
      sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false,
    },
  });
  const contents = view.webContents;
  const session = contents.session;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  view.on('page-title-updated', event => event.preventDefault());
  if (!configuredSessions.has(session)) {
    session.setPermissionCheckHandler(() => false);
    session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    session.on('will-download', event => event.preventDefault());
    configuredSessions.add(session);
  }
  session.webRequest.onBeforeRequest((request, respond) => {
    const url = new URL(request.url);
    const allowed = url.href === target.socket || (url.origin === origin && url.pathname.startsWith('/devtools/'));
    respond({ cancel: !allowed });
  });
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('验证画面加载超时。')), 12000); });
    await Promise.race([view.loadURL(target.url), timeout]);
    showVerificationView(view);
    return view;
  } catch {
    if (!view.isDestroyed()) view.destroy();
    throw new Error('辅助验证窗口未能打开，请重新检查专用浏览器。');
  } finally {
    clearTimeout(timer);
  }
}
