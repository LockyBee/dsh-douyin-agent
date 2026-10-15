import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = path.join(desktopRoot, '.cache');
const manifestPath = path.join(desktopRoot, 'UPSTREAM.json');
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

async function exists(file) {
  try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertCachePath(candidate) {
  const absolute = path.resolve(candidate);
  if (!contained(cacheRoot, absolute)) throw new Error('缓存操作目标超出 desktop/.cache');
  const desktopReal = await realpath(desktopRoot);
  for (let current = cacheRoot; ; ) {
    if (await exists(current)) {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('缓存路径不能使用符号链接');
      const resolved = await realpath(current);
      if (!contained(desktopReal, resolved)) throw new Error('缓存实际路径超出 desktop');
    }
    if (current === absolute) return absolute;
    const next = path.relative(current, absolute).split(path.sep)[0];
    current = path.join(current, next);
  }
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function hashSourceTree(root) {
  const pending = [];
  async function visit(directory, relative = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('源码缓存中出现未物化的符号链接');
      if (entry.isDirectory()) await visit(filename, name);
      else if (entry.isFile()) pending.push([name, filename]);
      else throw new Error('源码缓存中出现不支持的文件类型');
    }
  }
  await visit(root);
  const files = [];
  for (let offset = 0; offset < pending.length; offset += 32) {
    files.push(...await Promise.all(pending.slice(offset, offset + 32).map(async ([name, filename]) => {
      const bytes = await readFile(filename);
      return [name, bytes.length, createHash('sha256').update(bytes).digest('hex')];
    })));
  }
  files.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
  return { algorithm: 'sha256(sorted JSON [relativePosixPath, bytes, fileSha256] rows + LF)', files: files.length, sha256: createHash('sha256').update(files.map(row => `${JSON.stringify(row)}\n`).join('')).digest('hex') };
}

async function run(command, args, { output = false, timeout = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16 * 1024 * 1024) child.kill();
      else if (output) text += chunk.toString('utf8');
    });
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动系统 curl/tar；请确认它们已安装')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (timedOut || bytes > 16 * 1024 * 1024 || code !== 0) reject(new Error('官方源码下载或解包失败；未执行上游代码'));
      else resolve(text);
    });
  });
}

async function verifySource(source, manifest) {
  const actual = await hashSourceTree(source);
  if (actual.files !== manifest.sourceTree.files || actual.sha256 !== manifest.sourceTree.sha256) {
    throw new Error('源码树哈希不匹配，请保留本地修改并使用干净缓存重新获取');
  }
  for (const [relative, expected] of Object.entries(manifest.files)) {
    if (await sha256(path.join(source, relative)) !== expected) throw new Error(`上游固定文件校验失败：${relative}`);
  }
  const retainedLicense = path.join(desktopRoot, manifest.license.localPath);
  if (await sha256(retainedLicense) !== manifest.files.LICENSE) throw new Error('保留的 MIT 许可证与上游原文不一致');
  for (const notice of manifest.retainedNotices ?? []) {
    if (await sha256(path.join(source, notice.upstreamPath)) !== notice.sha256 || await sha256(path.join(desktopRoot, notice.localPath)) !== notice.sha256) throw new Error(`保留的第三方通知与上游原文不一致：${notice.upstreamPath}`);
  }
  return actual;
}

async function validateArchive(archive, manifest, tar) {
  const prefix = `${manifest.archive.rootDirectory}/`;
  const entries = (await run(tar, ['-tzf', archive], { output: true })).split(/\r?\n/u).filter(Boolean);
  if (entries.length !== manifest.archive.entries) throw new Error('源码档案条目数不匹配');
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || entry.includes('\\') || entry.includes(':') || entry.slice(prefix.length).split('/').some(part => part === '..' || part === '.')) {
      throw new Error('源码档案存在越界路径');
    }
  }
  const allowedLinks = new Map(manifest.materializedSymlinks.map(link => [link.path, link.target]));
  const verbose = (await run(tar, ['-tvzf', archive], { output: true })).split(/\r?\n/u).filter(Boolean);
  let linkCount = 0;
  for (const row of verbose) {
    if (row.startsWith('-') || row.startsWith('d')) continue;
    const marker = ` ${prefix}`;
    const position = row.indexOf(marker);
    const link = position < 0 ? [] : row.slice(position + marker.length).split(' -> ');
    if (!row.startsWith('l') || link.length !== 2 || allowedLinks.get(link[0]) !== link[1]) throw new Error('源码档案存在未知链接或文件类型');
    linkCount += 1;
  }
  if (linkCount !== allowedLinks.size) throw new Error('源码符号链接清单不匹配');
}

export async function acquireUpstream({ verifyOnly = false } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!/^[0-9a-f]{40}$/u.test(manifest.commit) || !/^[0-9a-f]{64}$/u.test(manifest.archive.sha256)) throw new Error('上游固定版本清单无效');
  if (manifest.archive.url !== `https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/${manifest.commit}`) throw new Error('只允许下载固定 commit 的官方 GitHub 源码');
  const source = await assertCachePath(path.join(cacheRoot, 'upstream', manifest.commit));
  if (await exists(source)) {
    const tree = await verifySource(source, manifest);
    return { source, commit: manifest.commit, verified: true, files: tree.files, downloaded: false };
  }
  if (verifyOnly) throw new Error('尚未获取上游固定源码');
  const archive = await assertCachePath(path.join(cacheRoot, 'archives', `${manifest.commit}.tar.gz`));
  await mkdir(path.dirname(archive), { recursive: true });
  const system = process.env.SystemRoot || 'C:\\Windows';
  const curl = process.platform === 'win32' ? path.join(system, 'System32', 'curl.exe') : 'curl';
  const tar = process.platform === 'win32' ? path.join(system, 'System32', 'tar.exe') : 'tar';
  if (!(await exists(archive))) {
    const temporary = await assertCachePath(`${archive}.${randomUUID()}.tmp`);
    try {
      await run(curl, ['--disable', '--fail', '--silent', '--show-error', '--location', '--max-redirs', '3', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '180', '--max-filesize', String(MAX_ARCHIVE_BYTES), '--output', temporary, manifest.archive.url]);
      const info = await lstat(temporary);
      if (info.size !== manifest.archive.bytes || await sha256(temporary) !== manifest.archive.sha256) throw new Error('官方源码压缩包哈希或长度不匹配');
      await rename(temporary, archive);
    } finally {
      if (await exists(temporary)) await rm(await assertCachePath(temporary));
    }
  }
  if ((await lstat(archive)).size !== manifest.archive.bytes || await sha256(archive) !== manifest.archive.sha256) throw new Error('缓存源码压缩包哈希或长度不匹配');
  await validateArchive(archive, manifest, tar);
  const staging = await assertCachePath(path.join(cacheRoot, 'upstream', `.extract-${manifest.commit}-${randomUUID()}`));
  await mkdir(staging, { recursive: true });
  try {
    await run(tar, ['-xzf', archive, '--strip-components=1', '-C', staging, ...manifest.materializedSymlinks.map(link => `--exclude=${manifest.archive.rootDirectory}/${link.path}`)]);
    for (const link of manifest.materializedSymlinks) {
      const destination = path.resolve(staging, link.path);
      const target = path.resolve(path.dirname(destination), link.target);
      if (!contained(staging, destination) || !contained(staging, target)) throw new Error('源码符号链接目标越界');
      await cp(target, destination, { recursive: true, errorOnExist: true, force: false });
    }
    const tree = await verifySource(staging, manifest);
    await rename(staging, source);
    return { source, commit: manifest.commit, verified: true, files: tree.files, downloaded: true };
  } finally {
    if (await exists(staging)) await rm(await assertCachePath(staging), { recursive: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const arguments_ = process.argv.slice(2);
    if (arguments_.some(value => value !== '--verify')) throw new Error('用法：node desktop/scripts/acquire-upstream.mjs [--verify]');
    console.log(JSON.stringify(await acquireUpstream({ verifyOnly: arguments_.includes('--verify') }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
