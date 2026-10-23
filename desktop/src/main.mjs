import { UpdateService } from './update-service.mjs';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { ApiProcess } from './api-process.mjs';
import { ensureSharedLocation, prepareApiRuntime, verifyNode } from './prepare-api-runtime.mjs';
import { saveSharedMediaKey } from './media-key-store.mjs';
import { createStartupTimeline, navigateStartup } from './startup-navigation.mjs';

app.setName('大肥鱼抖音助手');
app.setAppUserModelId('local.dafeiyu.douyin.api');
app.commandLine.appendSwitch('lang', 'zh-CN');
const override = process.env.DOUYIN_DESKTOP_USER_DATA;
if (override && !path.isAbsolute(override)) throw new Error('软件用户目录必须是绝对路径。');
app.setPath('userData', override || path.join(app.getPath('appData'), 'DafeiyuDouyinAPI'));
let window, backend, memoryFolder, current, normalize, startup;
let remember = false, quitting = false, startupReady = false;
const sensitive = new Set();
const settingsFile = path.join(app.getPath('userData'), 'api-settings.json');
function redact(value) { let text = String(value); for (const key of sensitive) text = text.split(key).join('[凭据已隐藏]'); return text.replace(/Bearer\s+[^\s,;"']+/gi, 'Bearer [凭据已隐藏]').slice(0, 12000); }
function focus() { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } }
async function quit(code = 0) { if (quitting) return; quitting = true; startup?.record('exit.requested', { exitCode: code }); try { await backend?.stop(); } finally { startup?.record('exit.finished', { exitCode: code }); await startup?.flush().catch(() => {}); app.exit(code); } }
function authorized(event) {
  if (!window || event.sender.id !== window.webContents.id || new URL(event.senderFrame.url).origin !== backend.origin) throw new Error('设置请求来源无效。');
}
async function publicSettings() {
  const status = await backend.getConfig();
  return { configured: status.configured, baseUrl: current.baseUrl, model: current.model, remember, memoryFolder };
}
async function persist(value, shouldRemember) {
  const record = { version: 1, baseUrl: value.baseUrl, model: value.model };
  let stored = false, note = '';
  if (shouldRemember && value.apiKey) {
    if (!safeStorage.isEncryptionAvailable()) note = '本机加密暂不可用，密钥仅用于本次运行。';
    else { record.encryptedApiKey = safeStorage.encryptString(value.apiKey).toString('base64'); stored = true; }
  }
  const temporary = `${settingsFile}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temporary, settingsFile); }
  finally { await fs.rm(temporary, { force: true }); }
  remember = stored;
  return note;
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', focus);
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quit(); } });
  app.on('window-all-closed', () => { void quit(); });
  app.whenReady().then(async () => {
    const appRoot = app.getAppPath(), userData = app.getPath('userData');
    const resources = app.isPackaged ? process.resourcesPath : path.join(appRoot, '.cache');
    const nodeRoot = path.join(resources, app.isPackaged ? 'runtime/node' : 'generated/node');
    const node = path.join(nodeRoot, 'node.exe');
    await fs.mkdir(userData, { recursive: true });
    startup = await createStartupTimeline(userData);
    startup.record('startup.started');
    await verifyNode(node, path.join(nodeRoot, 'provenance.json'));
    startup.record('startup.stage', { stage: 'node-verified' });
    const runtime = await prepareApiRuntime({ seedDir: path.join(resources, 'api-runtime'), userData, manifestFile: path.join(appRoot, 'app', 'build-manifest.json') });
    startup.record('startup.stage', { stage: 'runtime-prepared' });
    const pathsModule = await import(pathToFileURL(path.join(runtime, 'runtime-paths.mjs')).href);
    const shared = await ensureSharedLocation({ resolve: pathsModule.resolveRuntimePaths });
    memoryFolder = shared.paths.memoryDir;
    ({ normalizeApiConfig: normalize } = await import(pathToFileURL(path.join(runtime, 'api-agent.mjs')).href));
    let saved = {};
    try { saved = JSON.parse(await fs.readFile(settingsFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('API 设置文件无法读取，未覆盖原文件。'); }
    if (saved.version !== undefined && saved.version !== 1) throw new Error('API 设置文件版本不受支持。');
    let apiKey = '';
    if (saved.encryptedApiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('本机密钥解密不可用；原加密文件已保留。');
      apiKey = safeStorage.decryptString(Buffer.from(saved.encryptedApiKey, 'base64'));
      remember = true;
    }
    current = normalize({ apiKey, baseUrl: saved.baseUrl || 'https://api.deepseek.com', model: saved.model || 'deepseek-flash', keySource: apiKey ? '软件本机加密存储' : '未配置' });
    if (current.apiKey) sensitive.add(current.apiKey);
    backend = new ApiProcess(node, runtime, { env: { ...process.env, ...shared.env, DOUYIN_NODE_EXECUTABLE: node } });
    await backend.start(current);
    startup.record('backend.ready');
    backend.exited.then(() => {
      startup.record('backend.exited', { exitCode: backend.exitCode, signal: backend.exitSignal });
      if (startupReady && !quitting) {
        const message = '本机后台已退出，软件已停止。请查看启动诊断后重新打开。';
        void startup.fail(message).catch(() => {}).finally(() => { if (!quitting) { dialog.showErrorBox('抖音助手后台已退出', message); void quit(1); } });
      }
    });
    const updater = new UpdateService({version:app.getVersion(),directory:path.join(userData,'updates')});
    ipcMain.handle('douyin:check-updates', async event => { authorized(event); return updater.check(); });
    ipcMain.handle('douyin:download-update', async event => { authorized(event); return updater.download(); });
    ipcMain.handle('douyin:install-update', async event => {
      authorized(event); await backend.configure(current);
      const {file,sha256}=await updater.verifiedExecutable();
      // 便携版退出后会清理解压目录，更新助手必须先放到持久目录。
      const launcherDir=path.join(userData,'updates','launcher');await fs.mkdir(launcherDir,{recursive:true});
      const launcher=path.join(launcherDir,'update-launcher.mjs'),launcherNode=path.join(launcherDir,'node.exe');
      await fs.copyFile(node,launcherNode);await fs.copyFile(path.join(appRoot,'app/update-launcher.mjs'),launcher);
      const shortcut=path.join(app.getPath('desktop'),'大肥鱼抖音助手.lnk');
      if(!shell.writeShortcutLink(shortcut,'create',{target:file,cwd:path.dirname(file),description:'大肥鱼抖音助手 · 独立 API 版',icon:file,iconIndex:0,appUserModelId:'local.dafeiyu.douyin.api'}))throw new Error('无法创建新版软件快捷方式，尚未重启。');
      const child=spawn(launcherNode,[launcher,String(process.pid),file,sha256],{detached:true,windowsHide:true,stdio:'ignore',shell:false});
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
      setTimeout(()=>{void quit();},100);return {status:'restarting',message:'正在退出旧版并打开已核对的新版。桌面快捷方式已指向新版。'};
    });
    ipcMain.handle('douyin:save-media-key', async (event, input) => {
      authorized(event);
      if (typeof input?.apiKey === 'string' && input.apiKey) sensitive.add(input.apiKey);
      return saveSharedMediaKey(input, { envFile: shared.paths.mediaEnvFile, explicit: true });
    });
    ipcMain.handle('douyin:get-settings', async event => { authorized(event); return publicSettings(); });
    ipcMain.handle('douyin:save-settings', async (event, input) => {
      authorized(event);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['apiKey', 'baseUrl', 'model', 'remember'].includes(key)) || typeof input.remember !== 'boolean') throw new Error('API 设置字段无效。');
      const next = normalize({ apiKey: typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey : current.apiKey, baseUrl: input.baseUrl || current.baseUrl, model: input.model || current.model, keySource: '软件 API 设置' });
      if (!next.apiKey) throw new Error('请填写 API Key。');
      sensitive.add(next.apiKey);
      await backend.configure(next); current = next;
      let storageNote = '';
      try { storageNote = await persist(next, input.remember); }
      catch { remember = false; storageNote = '本次配置已生效，但保存失败；原磁盘设置仍可能保留，下次启动请核对。'; }
      return { ...await publicSettings(), storageNote };
    });
    ipcMain.handle('douyin:clear-key', async event => {
      authorized(event);
      const previous = current, previousRemember = remember;
      const next = normalize({ ...current, apiKey: '', keySource: '未配置' });
      await backend.configure(next);
      try { await persist(next, false); current = next; }
      catch {
        try { await backend.configure(previous); current = previous; } catch { current = next; }
        remember = previousRemember;
        throw new Error('未能清除磁盘上的密钥记录，原文件仍保留，请检查本机文件权限。');
      }
      return publicSettings();
    });
    ipcMain.handle('douyin:open-memory', async event => { authorized(event); await fs.mkdir(memoryFolder, { recursive: true }); const error = await shell.openPath(memoryFolder); if (error) throw new Error('无法打开共享记忆文件夹。'); return { opened: true }; });
    ipcMain.handle('douyin:open-persona', async event => { authorized(event); const folder=path.join(memoryFolder,'persona'); await fs.mkdir(folder,{recursive:true}); const error=await shell.openPath(folder); if(error)throw new Error('无法打开共用人格文件夹。'); return {opened:true}; });
    window = new BrowserWindow({ icon:path.join(appRoot,'app/app.ico'), title: '大肥鱼抖音助手 · 独立 API 版', width: 1320, height: 880, minWidth: 920, minHeight: 640, autoHideMenuBar: true, show: process.env.DOUYIN_DESKTOP_SMOKE !== '1', backgroundColor: '#10141d', webPreferences: { preload: path.join(appRoot, 'app', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { try { if (new URL(url).origin !== backend.origin) event.preventDefault(); } catch { event.preventDefault(); } });
    window.on('page-title-updated', event => event.preventDefault());
    window.on('closed', () => startup.record('window.closed'));
    window.webContents.on('did-finish-load', () => { if (!window.isDestroyed()) window.setTitle('大肥鱼抖音助手 · 独立 API 版'); });
    const expectedSha256 = createHash('sha256').update(await fs.readFile(path.join(runtime, 'public', 'index.html'))).digest('hex');
    await navigateStartup({ window, backend, url: `${backend.origin}/`, expectedSha256, record: startup.record,
      checkRenderer: () => window.webContents.executeJavaScript("new Promise(resolve => { const end = Date.now() + 2500; const check = () => { const ready = document.readyState !== 'loading' && document.getElementById('root')?.childElementCount > 0 && typeof window.douyinDesktop?.getSettings === 'function' && typeof window.douyinDesktop?.saveSettings === 'function'; if (ready || Date.now() >= end) resolve(Boolean(ready)); else setTimeout(check, 50); }; check(); })"),
    });
    await startup.success();
    if (quitting || window.isDestroyed()) return;
    if (!backend.child.connected || backend.child.exitCode !== null || backend.child.signalCode) throw Object.assign(new Error('本机后台已退出，无法完成软件启动。'), { code: 'STARTUP_BACKEND_EXITED' });
    startupReady = true;
    if (process.env.DOUYIN_DESKTOP_SMOKE === '1') await fs.writeFile(path.join(userData, 'desktop-smoke.json'), JSON.stringify({ ready: true, packaged: app.isPackaged, version: app.getVersion(), visible: window.isVisible(), origin: backend.origin, appPid: process.pid, backendPid: backend.child.pid, memoryFolder, configured: Boolean(current.apiKey), time: new Date().toISOString() }, null, 2) + '\n');
  }).catch(async error => {
    if (quitting || error?.code === 'STARTUP_WINDOW_CLOSED') { startup?.record('startup.cancelled', { code: error?.code }); await startup?.flush().catch(() => {}); if (!quitting) await quit(); return; }
    const message = redact(error?.message || error);
    await fs.mkdir(app.getPath('userData'), { recursive: true });
    startup?.record('startup.rejected', { code: typeof error?.code === 'string' ? error.code : 'STARTUP_FAILED' });
    if (startup) await startup.fail(message).catch(() => {});
    else await fs.writeFile(path.join(app.getPath('userData'), 'startup-error.txt'), message + '\n');
    await backend?.stop().catch(() => {});
    dialog.showErrorBox('抖音助手启动失败', message);
    await quit(1);
  });
}
