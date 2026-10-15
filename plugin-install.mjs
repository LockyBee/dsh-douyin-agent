import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const BEGIN_MARKER = '# BEGIN DSH DOUYIN BROWSER';
export const END_MARKER = '# END DSH DOUYIN BROWSER';
const modulePath = fileURLToPath(import.meta.url);
export const DEFAULT_PLUGIN_PATH = join(dirname(modulePath), 'dsh-plugin.mjs');

async function readOptional(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error; }
}

export function planPatch(original, { action = 'install', pluginPath = DEFAULT_PLUGIN_PATH } = {}) {
  if (!['install', 'uninstall'].includes(action)) throw new Error(`不支持的配置动作：${action}`);
  const text = original.toString('utf8');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if ((begin < 0) !== (end < 0) || (begin >= 0 && (end < begin || text.indexOf(BEGIN_MARKER, begin + 1) >= 0 || text.indexOf(END_MARKER, end + 1) >= 0))) throw new Error('抖音插件标记不完整或重复，已停止修改共享配置。');
  const uri = pathToFileURL(resolve(pluginPath)).href;
  const block = [BEGIN_MARKER, '- insert:', '    - id: douyin-browser', `      name: ${JSON.stringify(uri)}`, END_MARKER, ''].join(newline);
  let next = text;
  const outsideBlock = begin < 0 ? text : text.slice(0, begin) + text.slice(end + END_MARKER.length);
  if (action === 'install' && /^\s*-?\s*id:\s*['"]?douyin-browser['"]?\s*(?:#.*)?$/m.test(outsideBlock)) throw new Error('共享配置已有未由本安装器管理的 douyin-browser 条目，已停止重复注册。');
  if (begin >= 0) {
    let endExclusive = end + END_MARKER.length;
    if (text.slice(endExclusive, endExclusive + 2) === '\r\n') endExclusive += 2;
    else if (text[endExclusive] === '\n') endExclusive += 1;
    next = text.slice(0, begin) + (action === 'uninstall' ? '' : block) + text.slice(endExclusive);
  } else if (action === 'install') {
    const hasBomOnly = text === '\uFEFF';
    next = text + (text.length && !hasBomOnly && !text.endsWith('\n') ? newline : '') + block;
  }
  return { changed: next !== text, installed: action !== 'uninstall' && (begin >= 0 || action === 'install'), uri, content: Buffer.from(next, 'utf8') };
}

export async function managePlugin({ action = 'install', homeDir = process.env.DSH_HOME || join(homedir(), '.dsh'), pluginPath = DEFAULT_PLUGIN_PATH, dryRun = false } = {}) {
  if (!['install', 'uninstall', 'status'].includes(action)) throw new Error(`不支持的安装动作：${action}`);
  const targetPath = join(resolve(homeDir), 'cordis.patch.yml');
  const original = await readOptional(targetPath);
  if (action === 'status') {
    const removal = planPatch(original, { action: 'uninstall', pluginPath });
    return { action, targetPath, installed: removal.changed, runtimeLoaded: null, runtimeStatus: '仅检查配置，尚未检查当前 DSH 是否加载。', restartRequired: false };
  }
  if (action === 'install') await readFile(resolve(pluginPath));
  const plan = planPatch(original, { action, pluginPath });
  const installedBefore = original.toString('utf8').includes(BEGIN_MARKER);
  const summary = { action, targetPath, pluginUri: plan.uri, changed: plan.changed, installed: dryRun ? installedBefore : plan.installed, plannedInstalled: plan.installed, dryRun, runtimeLoaded: null, runtimeStatus: '安装配置与当前 DSH 加载状态须分别验收。', restartRequired: plan.changed, browserStarted: false };
  if (dryRun || !plan.changed) return summary;
  await mkdir(dirname(targetPath), { recursive: true });
  // 写入前再次读取，避免覆盖另一个程序刚刚更新的共享配置。
  if (!(await readOptional(targetPath)).equals(original)) throw new Error('共享配置已被其他程序修改，请重新运行安装。');
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const backupPath = `${targetPath}.douyin-${stamp}-${randomUUID().slice(0, 8)}.bak`;
  await writeFile(backupPath, original, { flag: 'wx' });
  const temporaryPath = `${targetPath}.douyin-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, plan.content, { flag: 'wx' });
    if (!(await readOptional(targetPath)).equals(original)) throw new Error('共享配置在写入前发生变化，已保留备份并停止安装。');
    await rename(temporaryPath, targetPath);
  } finally {
    await unlink(temporaryPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  const readback = await readFile(targetPath);
  if (!readback.equals(plan.content)) throw new Error(`共享配置回读不一致。原配置备份：${backupPath}`);
  return { ...summary, backupPath, verifiedReadback: true };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--uninstall') options.action = 'uninstall';
    else if (arg === '--status') options.action = 'status';
    else if (arg === '--home' || arg === '--plugin') {
      const value = args[++index];
      if (!value) throw new Error(`${arg} 缺少路径。`);
      options[arg === '--home' ? 'homeDir' : 'pluginPath'] = value;
    } else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  try { console.log(JSON.stringify(await managePlugin(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
