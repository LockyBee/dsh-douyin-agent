import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DOMAIN_FILES } from './stage-api-runtime.mjs';
import { chromium } from '../../playwright-runtime.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), domain = path.dirname(desktop);
const { version } = JSON.parse(await fs.readFile(path.join(desktop, 'package.json'), 'utf8'));
const releaseDirectory = process.argv[2] ? path.resolve(process.argv[2]) : path.join(desktop, 'release-api');
const executable = path.join(releaseDirectory, `Dafeiyu-Douyin-API-${version}-win-x64.exe`);
const unpacked = path.join(releaseDirectory, 'win-unpacked'), resources = path.join(unpacked, 'resources');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const rootRequire = createRequire(path.join(desktop, 'package.json'));
const builderRequire = createRequire(rootRequire.resolve('electron-builder'));
const asar = builderRequire('@electron/asar'), archive = path.join(resources, 'app.asar');
const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString());
const manifest = JSON.parse(asar.extractFile(archive, 'app/build-manifest.json').toString());
async function runtimeDigest(directory, prefix = '', hash = createHash('sha256')) {
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!prefix && entry.name === '.runtime-ready.json') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) await runtimeDigest(path.join(directory, entry.name), relative, hash);
    else { assert.ok(entry.isFile()); hash.update(relative); hash.update('\0'); hash.update(await fs.readFile(path.join(directory, entry.name))); hash.update('\0'); }
  }
  return prefix ? null : hash.digest('hex');
}
assert.equal(packaged.version, version); assert.equal(manifest.productVersion, version);
assert.equal(await runtimeDigest(path.join(resources, 'api-runtime')), manifest.runtimeId);
assert.equal(JSON.parse(await fs.readFile(path.join(resources, 'api-runtime/public/build-info.json'), 'utf8')).version, version);
for (const name of ['main.mjs', 'api-process.mjs', 'prepare-api-runtime.mjs', 'media-key-store.mjs', 'startup-navigation.mjs', 'preload.cjs', 'update-service.mjs', 'update-launcher.mjs']) {
  const source = name === 'media-key-store.mjs' ? path.join(domain, 'media/key-store.mjs') : path.join(desktop, 'src', name);
  assert.equal(digest(asar.extractFile(archive, `app/${name}`)), digest(await fs.readFile(source)), name);
}
for (const name of DOMAIN_FILES) assert.equal(digest(await fs.readFile(path.join(resources, 'api-runtime', name))), digest(await fs.readFile(path.join(domain, name))), name);
const bytes = await fs.readFile(executable), sha256 = digest(bytes);
assert.equal(digest(asar.extractFile(archive,'app/app.ico')),digest(await fs.readFile(path.join(desktop,'assets/app.ico'))));
const libRequire=createRequire(builderRequire.resolve('app-builder-lib')),ResEdit=libRequire('resedit');
async function checkIcon(file){const exe=ResEdit.NtExecutable.from(await fs.readFile(file)),resources=ResEdit.NtExecutableResource.from(exe),groups=ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);assert.ok(groups.length>0,'EXE必须包含图标资源');const raw=groups.flatMap(group=>group.getIconItemsFromEntries(resources.entries)).find(item=>item.isRaw()&&Buffer.from(item.bin).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&Buffer.from(item.bin).readUInt32BE(16)===256&&Buffer.from(item.bin).readUInt32BE(20)===256);assert.ok(raw,'EXE必须包含256像素PNG图标');assert.equal(digest(Buffer.from(raw.bin)),digest(await fs.readFile(path.join(desktop,'assets/app.png'))));}
await checkIcon(executable);await checkIcon(path.join(unpacked,'大肥鱼抖音助手.exe'));
await fs.writeFile(`${executable}.sha256`, `${sha256}  ${path.basename(executable)}\n`);

const cache = path.join(desktop, '.cache'), directory = await fs.mkdtemp(path.join(cache, 'packaged-api-smoke-'));
assert.equal(path.dirname(directory), cache);
const userData = path.join(directory, 'user-data'), home = path.join(directory, 'home'), memory = path.join(directory, 'memory');
const locationFile = path.join(directory, 'runtime-location.json');
const paths = { stateDir: path.join(directory, 'state'), memoryDir: memory, memoryDbPath: path.join(memory, 'shared.sqlite'), mediaEnvFile: path.join(directory, 'media/.env'), mediaSettingsFile: path.join(directory, 'media/settings.local.json'), mediaRuntimeRoot: path.join(directory, 'media'), mediaModelsDir: path.join(directory, 'media/models') };
for (const folder of [userData, home, memory, paths.stateDir, paths.mediaRuntimeRoot, path.join(directory, 'temp')]) await fs.mkdir(folder, { recursive: true });
await fs.writeFile(locationFile, JSON.stringify({ version: 1, ...paths }));
await fs.writeFile(paths.mediaEnvFile, '');
await fs.writeFile(paths.mediaSettingsFile, JSON.stringify({ enabled: false, backend: 'local-whisper' }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:path|systemroot|windir|comspec|pathext|programfiles|programfiles\(x86\)|programdata)$/i.test(key)));
Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: path.join(directory, 'app-data'), LOCALAPPDATA: path.join(directory, 'local-app-data'), TEMP: path.join(directory, 'temp'), TMP: path.join(directory, 'temp'), DSH_HOME: path.join(home, '.dsh'), DOUYIN_DESKTOP_USER_DATA: userData, DOUYIN_RUNTIME_LOCATION_FILE: locationFile, DOUYIN_DESKTOP_SMOKE: '1' });
const child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { env, windowsHide: true, stdio: 'ignore' });
const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
let browser, page, ready;
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function until(action, milliseconds = 60_000) {
  const end = Date.now() + milliseconds;
  let last;
  do { try { const value = await action(); if (value) return value; } catch (error) { last = error; } await delay(200); } while (Date.now() < end);
  throw last || new Error('独立便携包检查超时。');
}
try {
  ready = await until(() => readJson(path.join(userData, 'desktop-smoke.json')));
  assert.equal(ready.ready, true); assert.equal(ready.packaged, true); assert.equal(ready.version, version); assert.equal(ready.visible, false); assert.equal(ready.configured, false); assert.equal(ready.memoryFolder, memory);
  const actualRuntime = path.join(userData, 'runtimes', manifest.runtimeId.slice(0, 20));
  assert.equal((await readJson(path.join(actualRuntime, '.runtime-ready.json'))).runtimeId, manifest.runtimeId);
  assert.equal(await runtimeDigest(actualRuntime), manifest.runtimeId);
  for (const name of DOMAIN_FILES) assert.equal(digest(await fs.readFile(path.join(actualRuntime, name))), digest(await fs.readFile(path.join(domain, name))), `portable:${name}`);
  const debug = (await fs.readFile(path.join(userData, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${Number(debug[0])}`);
  page = browser.contexts()[0].pages().find(item => item.url().startsWith(ready.origin)); assert.ok(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '先连接你的 DeepSeek' }).waitFor();
  await page.getByRole('textbox', { name: 'API Key', exact: true }).fill('synthetic-packaged-check-only');
  await page.getByRole('button', { name: '保存并连接', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByText(`独立 API 版 · ${version}`, { exact: true }).waitFor();
  assert.deepEqual(await page.getByRole('navigation',{name:'主导航'}).getByRole('button').allTextContents(),['◌ 对话与视频','☷ 业务设置','◉ 自主观看记录']);
  await page.getByRole('img',{name:'大肥鱼图标',exact:true}).waitFor();
  assert.equal(await page.getByRole('img',{name:'大肥鱼图标',exact:true}).evaluate(img=>img.complete&&img.naturalWidth>0),true);
  assert.deepEqual(await page.evaluate(()=>['checkUpdates','downloadUpdate','installUpdate'].map(key=>typeof window.douyinDesktop[key])),['function','function','function']);
  await page.getByRole('tab', { name:'观看日报',exact:true }).click();
  await page.getByRole('button', { name: '生成今天日报', exact: true }).click();
  await page.getByRole('article', { name: '日报正文' }).waitFor();
  await fs.writeFile(path.join(directory, 'renderer-report.txt'), await page.getByRole('article', { name: '日报正文' }).innerText());
  await page.getByRole('tab', { name:'自检与用量',exact:true }).click();
  await page.getByRole('button', { name: '一键自检', exact: true }).click();
  await page.getByRole('heading', { name: '自检结果', exact: true }).waitFor();
  await page.locator('p').filter({ hasText: /Node\.js .*SQLite 可用/ }).waitFor();
  await page.getByText('查看或复制诊断报告', { exact: true }).click();
  const diagnostics = JSON.parse(await page.getByRole('textbox', { name: '诊断报告', exact: true }).inputValue());
  assert.equal(diagnostics.protocol, 'diagnostics-v2'); assert.equal(diagnostics.pluginVersion, version);
  assert.ok(diagnostics.checks.some(item => item.id === 'silent_window'));
  await page.getByRole('tab', { name: '视频观看', exact: true }).click();
  await page.getByRole('spinbutton',{name:'自动观看模型请求上限',exact:true}).fill('66');
  await page.getByRole('button',{name:'保存自动启动设置',exact:true}).click();
  await page.getByRole('combobox', { name: '观看方式', exact: true }).selectOption('topic');
  await page.getByRole('textbox', { name: '想看的主题', exact: true }).fill('合成打包主题');
  await page.getByRole('button', { name: '保存观看主题', exact: true }).click();
  await page.getByText('主题已保存，插件与软件共用；下次自主观看生效。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '谷时段（DeepSeek）', exact: true }).click();
  await page.getByRole('switch', { name: '不限单轮时长', exact: true }).click();
  const saveTime = () => Promise.all([page.waitForResponse(response => response.url().endsWith('/api/video/policy') && response.request().method() === 'POST'), page.getByRole('button', { name: '保存时间设置', exact: true }).click()]);
  const savedMinutes = () => page.evaluate(async () => { const boot = await (await fetch('/api/bootstrap')).json(); return (await (await fetch('/api/video/status', { headers: { 'x-session-token': boot.token } })).json()).policy.sessionMinutes; });
  await saveTime();
  const minutes = page.getByRole('spinbutton', { name: '单轮上限', exact: true });
  assert.equal(await minutes.isEnabled(), true); assert.equal(await minutes.inputValue(), ''); assert.equal(await savedMinutes(), null);
  await minutes.fill('25'); await delay(1700);
  assert.equal(await minutes.inputValue(), '25'); assert.equal(await page.getByRole('switch', { name: '不限单轮时长', exact: true }).getAttribute('aria-checked'), 'false');
  assert.equal(await savedMinutes(), null);
  await saveTime(); assert.equal(await savedMinutes(), 25);
  await page.getByRole('switch', { name: '不限单轮时长', exact: true }).click(); await saveTime();
  await page.getByRole('tab', { name: '好友互动', exact: true }).click();
  await page.locator('[aria-labelledby="auto-share-title"]').getByText('名单在“业务设置 → 好友互动 → 好友私信”中维护。读取联系人、勾选并保存许可名单即可，不需要启用自动回复；不会自动加入其他联系人。', { exact: true }).waitFor();
  const checks = await page.evaluate(async () => {
    const boot = await (await fetch('/api/bootstrap')).json();
    const routes = ['/api/state', '/api/video/status', '/api/watch/state', '/api/chat/state', '/api/share/state', '/api/spark/state', '/api/comments/state', '/api/mode/state', '/api/persona', '/api/media/state', '/api/reports/state', '/api/usage', '/api/watch/options', '/api/watch/schedule', '/api/interactions/state'];
    const status = {};
    for (const route of routes) {
      const response = await fetch(route, { headers: { 'x-session-token': boot.token } });
      if (!response.ok) throw new Error(`只读接口不可用：${route}`);
      status[route] = await response.json();
    }
    await window.douyinDesktop.clearApiKey();
    const settings = await window.douyinDesktop.getSettings();
    return { status, cleared: !settings.configured };
  });
  assert.equal(checks.cleared, true); assert.equal(checks.status['/api/comments/state'].enabled, false); assert.equal(checks.status['/api/mode/state'].silent, false); assert.equal(checks.status['/api/chat/state'].running, false); assert.equal(checks.status['/api/spark/state'].running, false); assert.equal(checks.status['/api/media/state'].enabled, false); assert.equal(checks.status['/api/watch/state'].running, false);
  assert.deepEqual(errors, []);
  assert.equal(checks.status['/api/video/status'].policy.sessionMinutes, null);
  assert.deepEqual(checks.status['/api/video/status'].policy.weekendWindows, ['00:00-24:00']);
  assert.deepEqual(checks.status['/api/watch/options'].policy.topics, ['合成打包主题']);
  assert.equal(checks.status['/api/usage'].today.requests, 0);
  assert.deepEqual(checks.status['/api/watch/schedule'].policy,{enabled:false,maxRequests:66});
  assert.equal(checks.status['/api/interactions/state'].rows.length,4);
  const saved = await readJson(path.join(userData, 'api-settings.json'));
  assert.equal('encryptedApiKey' in saved, false); assert.equal(JSON.stringify(saved).includes('synthetic-packaged-check-only'), false);
  const receipt = { version, executable: path.basename(executable), bytes: bytes.length, sha256, archiveSourcesMatch: true, iconsMatch:true, domainFilesMatch: DOMAIN_FILES.length, runtimeId: manifest.runtimeId, startup: { ready: true, packaged: true, visible: false, isolated: true, version: ready.version }, renderer: { loaded: true, privateKeyIpc: true, syntheticKeyCleared: true, dailyReportRendered: true, navDeduplicated:true, brandLoaded:true, updateIpc:true, scheduleSettingsSaved:true, durationDraftSavedExplicitly:true, shareAllowlistHint:true, pageErrors: errors.length }, readOnlyEndpoints: Object.keys(checks.status).length, automationStarted: false, realModelCalled: false, smokeDirectory: directory };
  await page.evaluate(() => window.close());
  assert.equal(await Promise.race([exited, delay(12_000, null, { ref: false }).then(() => { throw new Error('便携包未正常退出。'); })]), 0);
  await until(async () => { try { await fetch(ready.origin, { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; } }, 12_000);
  receipt.exit = { graceful: true, backendPortReleased: true };
  await fs.writeFile(path.join(releaseDirectory, `verification-${version}.json`), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  if (page && !page.isClosed()) await page.evaluate(() => window.close()).catch(() => {});
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill();
}
