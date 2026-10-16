import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'release-api', 'win-unpacked'), cache = path.join(root, '.cache');
const productionFiles = ['main.mjs', 'api-process.mjs', 'prepare-api-runtime.mjs', 'media-key-store.mjs', 'startup-navigation.mjs', 'preload.cjs'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, target) => { const relative = path.relative(parent, target); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
await fs.access(path.join(source, '大肥鱼抖音助手.exe'));
await fs.access(path.join(source, 'resources', 'api-runtime', 'public', 'index.html'));
await fs.access(path.join(source, 'resources', 'runtime', 'node', 'node.exe'));
await fs.mkdir(cache, { recursive: true });
const directory = await fs.mkdtemp(path.join(cache, 'startup-smoke-'));
if (!inside(cache, directory) || directory === source || (await fs.lstat(directory)).isSymbolicLink()) throw new Error('隔离验收目录边界无效。');
const executableRoot = path.join(directory, 'application');

// 只复制公开打包资源；原包和现用用户目录均不改动。
await fs.cp(source, executableRoot, { recursive: true, dereference: false, force: false, errorOnExist: true, filter: async file => {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('打包底座含外链或特殊文件，未继续准备。');
  return true;
} });
const asar = path.join(executableRoot, 'resources', 'app.asar');
if (!inside(directory, asar) || !(await fs.lstat(asar)).isFile()) throw new Error('复制包的 app.asar 边界无效。');
await fs.unlink(asar);
const appRoot = path.join(executableRoot, 'resources', 'app'), appCode = path.join(appRoot, 'app');
await fs.mkdir(appRoot); await fs.mkdir(appCode);
const sources = {};
for (const name of productionFiles) {
  const bytes = await fs.readFile(name === 'media-key-store.mjs' ? path.join(root, '..', 'media', 'key-store.mjs') : path.join(root, 'src', name));
  await fs.writeFile(path.join(appCode, name), bytes, { flag: 'wx' }); sources[name] = digest(bytes);
}
const runtime = path.join(executableRoot, 'resources', 'api-runtime');
const runtimeHash = createHash('sha256'); let files = 0;
async function scan(folder, prefix = '') {
  for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) || entry.name === '.env' || /^(?:state|verification|profiles)(?:\/|$)/.test(relative)) throw new Error('隔离运行资源含非预期文件，未继续准备。');
    if (entry.isDirectory()) await scan(path.join(folder, entry.name), relative);
    else { runtimeHash.update(relative); runtimeHash.update('\0'); runtimeHash.update(await fs.readFile(path.join(folder, entry.name))); runtimeHash.update('\0'); files++; }
  }
}
await scan(runtime);
await fs.writeFile(path.join(appCode, 'build-manifest.json'), JSON.stringify({ version: 1, runtimeId: runtimeHash.digest('hex'), files, independentApi: true }, null, 2) + '\n', { flag: 'wx' });
await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'dafeiyu-isolated-startup-smoke', version: '1.0.0', type: 'module', main: 'bootstrap.mjs' }, null, 2) + '\n', { flag: 'wx' });
const isolated = path.join(directory, 'isolated');
const paths = {
  home: path.join(isolated, 'home'), userData: path.join(isolated, 'user-data'), appData: path.join(isolated, 'app-data'), localAppData: path.join(isolated, 'local-app-data'),
  sessionData: path.join(isolated, 'session'), temporary: path.join(isolated, 'temp'), stateDir: path.join(isolated, 'state'), memoryDir: path.join(isolated, 'memory'),
  memoryDbPath: path.join(isolated, 'memory', 'shared.sqlite'), mediaEnvFile: path.join(isolated, 'media', '.env'), mediaSettingsFile: path.join(isolated, 'media', 'settings.local.json'),
  mediaRuntimeRoot: path.join(isolated, 'media'), mediaModelsDir: path.join(isolated, 'media', '.models'), locationFile: path.join(isolated, 'runtime-location.json'),
};
for (const [key, value] of Object.entries(paths)) if (!key.endsWith('File') && key !== 'memoryDbPath') await fs.mkdir(value, { recursive: true });
await fs.writeFile(paths.locationFile, JSON.stringify({ version: 1, ...Object.fromEntries(['stateDir', 'memoryDir', 'memoryDbPath', 'mediaEnvFile', 'mediaSettingsFile', 'mediaRuntimeRoot', 'mediaModelsDir'].map(key => [key, paths[key]])) }, null, 2) + '\n', { flag: 'wx' });
await fs.writeFile(paths.mediaEnvFile, '', { flag: 'wx' });
await fs.writeFile(paths.mediaSettingsFile, JSON.stringify({ enabled: false, backend: 'local-whisper' }) + '\n', { flag: 'wx' });
const environment = {
  HOME: paths.home, USERPROFILE: paths.home, APPDATA: paths.appData, LOCALAPPDATA: paths.localAppData, TEMP: paths.temporary, TMP: paths.temporary,
  DSH_HOME: path.join(paths.home, '.dsh'), DOUYIN_DESKTOP_USER_DATA: paths.userData, DOUYIN_RUNTIME_LOCATION_FILE: paths.locationFile, DOUYIN_STATE_DIR: paths.stateDir,
  DEEPSEEK_SHARED_MEMORY_DB: paths.memoryDbPath, DOUYIN_MEDIA_ENV_FILE: paths.mediaEnvFile, DOUYIN_MEDIA_SETTINGS_FILE: paths.mediaSettingsFile,
  DOUYIN_MEDIA_RUNTIME_ROOT: paths.mediaRuntimeRoot, DOUYIN_MEDIA_MODELS_DIR: paths.mediaModelsDir, DOUYIN_DESKTOP_SMOKE: '1',
};
const bootstrap = `import {app} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
const env=${JSON.stringify(environment)};
for(const key of Object.keys(process.env))if(/^(?:DOUYIN_|DSH_|DEEPSEEK_|XIAOMI_|MINIMAX_)/.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key))delete process.env[key];
Object.assign(process.env,env);
for(const folder of ${JSON.stringify([environment.DSH_HOME, path.join(isolated, 'logs'), path.join(isolated, 'crash-dumps')])})await fs.mkdir(folder,{recursive:true});
app.setPath('appData',env.APPDATA);app.setPath('userData',env.DOUYIN_DESKTOP_USER_DATA);app.setPath('sessionData',${JSON.stringify(paths.sessionData)});app.setPath('temp',env.TEMP);app.setPath('crashDumps',${JSON.stringify(path.join(isolated, 'crash-dumps'))});app.setAppLogsPath(${JSON.stringify(path.join(isolated, 'logs'))});
await import('./app/main.mjs');
`;
await fs.writeFile(path.join(appRoot, 'bootstrap.mjs'), bootstrap, { flag: 'wx' });
const receipt = { protocol: 'isolated-startup-smoke-v1', directory, executable: path.join(executableRoot, '大肥鱼抖音助手.exe'), userData: paths.userData, locationFile: paths.locationFile,
  startupLogs: path.join(paths.userData, 'startup-diagnostics'), readyReceipt: path.join(paths.userData, 'desktop-smoke.json'), productionSourceSha256: sources,
  isolated: true, keyConfiguredByPreparation: false, startedByPreparation: false, originalPackageChanged: false };
await fs.writeFile(path.join(directory, 'smoke-info.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(receipt, null, 2));
