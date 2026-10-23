import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOMAIN = path.resolve(DESKTOP, '..');
const CACHE = path.join(DESKTOP, '.cache');
const GENERATED = path.join(CACHE, 'generated');
const PROJECT = path.join(CACHE, 'api-runtime');
const TEMPLATE = path.join(DESKTOP, 'runtime-api-template');
const NODE = path.join(GENERATED, 'node', 'node.exe');
const NODE_VERSION = '24.17.0';
const NODE_SHA256 = 'c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664';
const NODE_LICENSE_SHA256 = '8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c';
const NODE_ARCHIVE_SHA256 = 'f2aa33b35b75aca5f3f7b85675a6f6423201053e9381911e64961f3bda2528ab';
const DEPENDENCIES = { 'playwright-core': '1.64.0-alpha-1790635538000', yaml: '2.9.0' };
export const DOMAIN_FILES = Object.freeze([
  'scheduled-watch.mjs', 'interaction-status.mjs', 'settings-sections.mjs', 'usage-ledger.mjs', 'watch-options.mjs', 'diagnostics.mjs', 'api-agent.mjs', 'app.mjs', 'browser-host.mjs', 'chat-agent.mjs', 'chat-browser.mjs',
  'chat-message.mjs', 'chat-service.mjs', 'core.mjs', 'message-tracker.mjs', 'memory.mjs',
  'qq-sync.mjs', 'runtime-paths.mjs', 'tool-definitions.mjs', 'video-forward.mjs',
  'video-limits.mjs', 'playwright-runtime.mjs',
  'persona-memory.mjs', 'autonomous-watch.mjs', 'browser-launcher.mjs', 'autonomous-share.mjs', 'task-limits.mjs', 'outbound-send.mjs', 'spark-agent.mjs', 'spark-service.mjs', 'daily-report.mjs', 'autonomous-comments.mjs', 'comment-browser.mjs', 'public-comment-agent.mjs', 'watch-mode.mjs',
]);
const MEDIA_FILES = ['index.mjs', 'key-store.mjs', 'local_whisper.py', 'mimo_bridge.py', 'requirements.txt', 'setup_local.py', 'README.md', 'PROVENANCE.json'];
const VENDOR_FILES = [
  'vendor/mimo/driver/mimo_driver.py', 'vendor/mimo/LICENSE', 'vendor/voice/lib/providers.js',
  'vendor/voice/lib/provider-http.js', 'vendor/voice/LICENSE', 'vendor/minimax/lib/index.js', 'vendor/minimax/LICENSE',
];
const TEMPLATE_FILES = ['package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.md'];
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const sha256 = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const exists = async file => fs.access(file).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');

function inside(root, file) {
  const part = path.relative(root, file);
  return part !== '' && part !== '..' && !part.startsWith(`..${path.sep}`) && !path.isAbsolute(part);
}
async function regular(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('运行资源必须是普通文件。');
}
async function noLinkPath(root, target) {
  if (!inside(root, target)) throw new Error('运行资源路径越界。');
  let current = root;
  for (const part of [null, ...path.relative(root, target).split(path.sep)]) {
    if (part !== null) current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('运行资源路径不得使用符号链接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
async function copy(source, target) {
  await regular(source);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
}
function childEnvironment(extra = {}) {
  const allowed = ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
  return { ...Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), ...extra };
}
async function run(executable, args, { cwd = PROJECT, timeoutMs = 300_000, env = childEnvironment() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('纯 API 运行资源准备超时。')); }, timeoutMs);
    child.stdout.on('data', bytes => { if (output.length < 65_536) output += bytes.toString('utf8'); });
    // npm 错误可能带代理凭据，外层只报告退出码，不转发输出。
    child.stderr.resume();
    child.once('error', () => finish(new Error('纯 API 运行资源子进程无法启动。')));
    child.once('close', code => finish(code === 0 ? null : new Error(`纯 API 运行资源子进程退出码 ${code}。`), output));
  });
}
async function verifyNode() {
  await regular(NODE);
  const license = path.join(GENERATED, 'node', 'LICENSE');
  const provenance = path.join(GENERATED, 'node', 'provenance.json');
  if (await sha256(NODE) !== NODE_SHA256 || await sha256(license) !== NODE_LICENSE_SHA256) throw new Error('Node 24.17.0 或完整许可证校验失败，请先恢复已验证的官方运行资源。');
  const record = await readJson(provenance);
  if (record.version !== NODE_VERSION || record.nodeSha256 !== NODE_SHA256 || record.licenseSha256 !== NODE_LICENSE_SHA256) throw new Error('Node 来源记录与固定版本不一致。');
  const actual = JSON.parse((await run(NODE, ['-p', 'JSON.stringify({node:process.versions.node,sqlite:process.versions.sqlite})'], { cwd: DESKTOP })).trim());
  if (actual.node !== NODE_VERSION || !actual.sqlite) throw new Error('物理 Node 版本或内置 SQLite 不符合要求。');
  return { executable: NODE, provenance, license, version: NODE_VERSION, sha256: NODE_SHA256, licenseSha256: NODE_LICENSE_SHA256, sqlite: actual.sqlite };
}
async function clearGenerated(target) {
  await noLinkPath(GENERATED, target);
  await fs.rm(target, { recursive: true, force: true });
}
async function download(url, target) {
  await noLinkPath(GENERATED, target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const curl = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'curl.exe');
  try {
    await run(curl, ['--fail', '--silent', '--show-error', '--location', '--max-redirs', '2', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '240', '--max-filesize', String(100 * 1024 * 1024), '--output', temporary, url], { cwd: DESKTOP, timeoutMs: 250_000 });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function prepareApiNode() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前独立桌面构建仅准备 Windows x64 Node 运行资源。');
  const npm = path.join(GENERATED, 'npm', 'bin', 'npm-cli.js');
  const ready = [NODE, path.join(GENERATED, 'node', 'LICENSE'), path.join(GENERATED, 'node', 'provenance.json'), npm];
  if ((await Promise.all(ready.map(exists))).every(Boolean)) return verifyNode();
  const folder = `node-v${NODE_VERSION}-win-x64`, filename = `${folder}.zip`;
  const release = `https://nodejs.org/download/release/v${NODE_VERSION}`;
  const archive = path.join(GENERATED, 'downloads', filename);
  const sums = path.join(GENERATED, 'downloads', `node-v${NODE_VERSION}-SHASUMS256.txt`);
  if (!await exists(archive)) await download(`${release}/${filename}`, archive);
  if (!await exists(sums)) await download(`${release}/SHASUMS256.txt`, sums);
  const expected = (await fs.readFile(sums, 'utf8')).split(/\r?\n/).find(line => line.endsWith(`  ${filename}`))?.split(/\s+/)[0];
  if (expected !== NODE_ARCHIVE_SHA256 || await sha256(archive) !== NODE_ARCHIVE_SHA256) throw new Error('Node 官方压缩包与固定 SHA256 或官方校验表不一致。');
  const extraction = path.join(GENERATED, `api-node-extract-${randomUUID()}`);
  await noLinkPath(GENERATED, extraction);
  await fs.mkdir(extraction, { recursive: true });
  try {
    const tar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
    await run(tar, ['-xf', archive, '-C', extraction, `${folder}/node.exe`, `${folder}/LICENSE`, `${folder}/node_modules/npm`], { cwd: DESKTOP });
    const unpacked = path.join(extraction, folder);
    if (await sha256(path.join(unpacked, 'node.exe')) !== NODE_SHA256 || await sha256(path.join(unpacked, 'LICENSE')) !== NODE_LICENSE_SHA256) throw new Error('解压后的 Node 或完整许可证校验失败。');
    await noLinkPath(GENERATED, NODE);
    await copy(path.join(unpacked, 'node.exe'), NODE);
    await copy(path.join(unpacked, 'LICENSE'), path.join(GENERATED, 'node', 'LICENSE'));
    await copy(sums, path.join(GENERATED, 'node', 'SHASUMS256.txt'));
    await clearGenerated(path.join(GENERATED, 'npm'));
    await fs.cp(path.join(unpacked, 'node_modules', 'npm'), path.join(GENERATED, 'npm'), { recursive: true, dereference: false });
    await writeJson(path.join(GENERATED, 'node', 'provenance.json'), { version: NODE_VERSION, source: `${release}/${filename}`, archiveSha256: NODE_ARCHIVE_SHA256, nodeSha256: NODE_SHA256, licenseSha256: NODE_LICENSE_SHA256 });
    return verifyNode();
  } finally { await clearGenerated(extraction); }
}
async function validateLock() {
  const manifest = await readJson(path.join(TEMPLATE, 'package.json'));
  const lock = await readJson(path.join(TEMPLATE, 'package-lock.json'));
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify(DEPENDENCIES) || JSON.stringify(lock.packages?.['']?.dependencies) !== JSON.stringify(DEPENDENCIES) || lock.lockfileVersion !== 3) throw new Error('纯 API 依赖清单与固定版本不一致。');
  const names = Object.keys(lock.packages).filter(Boolean).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(DEPENDENCIES).map(name => `node_modules/${name}`).sort())) throw new Error('纯 API lock 含有额外依赖。');
  for (const [name, version] of Object.entries(DEPENDENCIES)) {
    const item = lock.packages[`node_modules/${name}`];
    if (item.version !== version || item.resolved !== `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` || !/^sha512-[A-Za-z0-9+/=]+$/.test(item.integrity) || item.link || item.hasInstallScript) throw new Error('纯 API npm 来源或完整性记录无效。');
  }
}
async function treeFiles(root, { publicOnly = false } = {}) {
  const files = [];
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = path.join(directory, entry.name), rel = relative(root, file);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('运行资源包含链接或特殊文件。');
      if (/^(?:\.env(?:\.|$)|\.git$|state$|verification$|\.models$|\.venv$|runtime-location\.json$|settings\.local\.json$)/i.test(entry.name) || /\.(?:sqlite(?:-wal|-shm)?|db|log)$/i.test(entry.name)) throw new Error('运行资源包含用户状态或本地配置。');
      if (publicOnly && entry.name === 'node_modules') throw new Error('静态界面中不能包含 npm 安装目录。');
      if (entry.isDirectory()) await visit(file); else files.push({ file, relative: rel });
    }
  }
  await visit(root);
  return files;
}
async function installDependencies() {
  const npm = path.join(GENERATED, 'npm', 'bin', 'npm-cli.js');
  await regular(npm);
  const userConfig = path.join(GENERATED, 'api-npm-user-empty.npmrc');
  const globalConfig = path.join(GENERATED, 'api-npm-global-empty.npmrc');
  await fs.writeFile(userConfig, '');
  await fs.writeFile(globalConfig, '');
  await run(NODE, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false', '--registry=https://registry.npmjs.org', `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`, `--cache=${path.join(GENERATED, 'api-npm-cache')}`], { env: childEnvironment({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }) });
}
async function dependencyNotices() {
  for (const [name, version] of Object.entries(DEPENDENCIES)) {
    const packageRoot = path.join(PROJECT, 'node_modules', name);
    if ((await readJson(path.join(packageRoot, 'package.json'))).version !== version) throw new Error('实际安装的纯 API 依赖版本不符。');
    for (const file of name === 'playwright-core' ? ['LICENSE', 'NOTICE', 'ThirdPartyNotices.txt'] : ['LICENSE']) await copy(path.join(packageRoot, file), path.join(PROJECT, 'licenses', name, file));
  }
  const names = (await fs.readdir(path.join(PROJECT, 'node_modules'))).filter(name => name !== '.package-lock.json').sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(DEPENDENCIES).sort())) throw new Error('纯 API node_modules 含额外运行包。');
}
async function smoke() {
  const script = `
    import {createRequire} from 'node:module';
    import {DatabaseSync} from 'node:sqlite';
    const require=createRequire(import.meta.url);
    const core=await import('./core.mjs');
    await import('./app.mjs'); await import('./api-worker.mjs');
    const {MediaAdapter}=await import('./media/index.mjs');
    const db=new DatabaseSync(':memory:'); db.exec('CREATE TABLE probe(value)'); db.close();
    const status=await new MediaAdapter({config:{},settingsFile:process.env.DOUYIN_MEDIA_SETTINGS_FILE}).settings();
    console.log(JSON.stringify({controller:typeof core.BrowserController==='function',node:process.versions.node,sqlite:process.versions.sqlite,playwright:require('playwright-core/package.json').version,yaml:require('yaml/package.json').version,mediaEnabled:status.enabled}));
  `;
  const emptyRoot = path.join(GENERATED, 'api-smoke-no-user-state');
  const result = JSON.parse((await run(NODE, ['--input-type=module', '-e', script], { env: childEnvironment({ DOUYIN_RUNTIME_LOCATION_FILE: path.join(emptyRoot, 'runtime-location.json'), DOUYIN_MEDIA_SETTINGS_FILE: path.join(emptyRoot, 'media-settings.json'), DEEPSEEK_SHARED_MEMORY_DB: path.join(emptyRoot, 'shared.sqlite') }) })).trim());
  if (!result.controller || result.node !== NODE_VERSION || result.playwright !== DEPENDENCIES['playwright-core'] || result.yaml !== DEPENDENCIES.yaml || result.mediaEnabled !== false) throw new Error('纯 API 入口导入或默认音频关闭验证失败。');
  return result;
}

export async function stageApiRuntime({ install = true, uiDir = path.join(DESKTOP, 'ui-api', 'dist'), requireUi = true, workerFile = path.join(DESKTOP, 'src', 'api-worker.mjs') } = {}) {
  await validateLock();
  const node = await prepareApiNode();
  await regular(workerFile);
  const uiReady = await exists(path.join(uiDir, 'index.html'));
  if (requireUi && !uiReady) throw new Error('独立 React 界面尚未构建，未生成可交付运行目录。');
  const publicFiles = uiReady ? await treeFiles(uiDir, { publicOnly: true }) : [];
  const provenance = await readJson(path.join(DOMAIN, 'media', 'PROVENANCE.json'));
  if (!Array.isArray(provenance) || JSON.stringify(provenance.map(item => item.localPath).sort()) !== JSON.stringify([...VENDOR_FILES].sort())) throw new Error('媒体来源清单与七份白名单不一致。');
  for (const item of provenance) {
    const source = path.join(DOMAIN, 'media', item.localPath);
    await noLinkPath(DOMAIN, source);
    if (await sha256(source) !== item.sha256) throw new Error('媒体固定来源 SHA256 校验失败。');
  }
  // 仅清理已校验、固定在 desktop/.cache 下的生成目录。
  await noLinkPath(CACHE, PROJECT);
  await fs.rm(PROJECT, { recursive: true, force: true });
  await fs.mkdir(PROJECT, { recursive: true });
  const inputs = [];
  const add = async (source, target) => {
    await copy(source, target);
    inputs.push({ path: relative(PROJECT, target), sha256: await sha256(target) });
  };
  for (const file of DOMAIN_FILES) await add(path.join(DOMAIN, file), path.join(PROJECT, file));
  await add(workerFile, path.join(PROJECT, 'api-worker.mjs'));
  for (const file of [...MEDIA_FILES, ...VENDOR_FILES]) await add(path.join(DOMAIN, 'media', file), path.join(PROJECT, 'media', file));
  for (const file of TEMPLATE_FILES) await add(path.join(TEMPLATE, file), path.join(PROJECT, file));
  for (const item of publicFiles) await add(item.file, path.join(PROJECT, 'public', item.relative));
  await add(node.license, path.join(PROJECT, 'licenses', 'node', 'LICENSE'));
  await add(node.provenance, path.join(PROJECT, 'licenses', 'node', 'provenance.json'));
  if (install) await installDependencies();
  if (install) await dependencyNotices();
  const verification = install ? await smoke() : null;
  await treeFiles(PROJECT);
  inputs.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const runtimeId = createHash('sha256').update(JSON.stringify({ node: { version: node.version, sha256: node.sha256 }, inputs })).digest('hex');
  const record = { version: 1, kind: 'pure-api', runtimeId, digestKind: 'verified-build-inputs', projectDir: PROJECT, nodeExecutable: NODE, node, dependencies: DEPENDENCIES, installed: install, uiReady, domainFiles: [...DOMAIN_FILES], inputs, verification };
  const publicRecord = { version: record.version, kind: record.kind, runtimeId, digestKind: record.digestKind, node: { version: node.version, sha256: node.sha256, licenseSha256: node.licenseSha256, sqlite: node.sqlite }, dependencies: DEPENDENCIES, installed: install, uiReady, domainFiles: [...DOMAIN_FILES], inputs, verification };
  await writeJson(path.join(PROJECT, 'RUNTIME_BUILD.json'), publicRecord);
  await writeJson(path.join(GENERATED, 'api-runtime-build.json'), record);
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--prepare-node-only')) {
      const result = await prepareApiNode();
      console.log(JSON.stringify({ nodeExecutable: result.executable, version: result.version, sha256: result.sha256, sqlite: result.sqlite }, null, 2));
    } else {
    const result = await stageApiRuntime({ install: !process.argv.includes('--no-install'), requireUi: !process.argv.includes('--allow-missing-ui') });
    console.log(JSON.stringify({ kind: result.kind, runtimeId: result.runtimeId, projectDir: result.projectDir, nodeExecutable: result.nodeExecutable, installed: result.installed, uiReady: result.uiReady, verification: result.verification }, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
