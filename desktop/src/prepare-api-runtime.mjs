import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

const exists = file => fs.access(file).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
const absolute = (value, label) => { if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`${label}必须是绝对路径。`); return path.normalize(value); };
const locationFields = { stateDir: 'DOUYIN_STATE_DIR', mediaEnvFile: 'DOUYIN_MEDIA_ENV_FILE', mediaSettingsFile: 'DOUYIN_MEDIA_SETTINGS_FILE', mediaRuntimeRoot: 'DOUYIN_MEDIA_RUNTIME_ROOT', mediaModelsDir: 'DOUYIN_MEDIA_MODELS_DIR' };

export async function prepareApiRuntime({ seedDir, userData, manifestFile }) {
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(manifest.runtimeId)) throw new Error('软件资源摘要无效。');
  const runtime = path.join(userData, 'runtimes', manifest.runtimeId.slice(0, 20));
  const ready = path.join(runtime, '.runtime-ready.json');
  const required = ['api-worker.mjs', 'app.mjs', 'api-agent.mjs', 'core.mjs', 'runtime-paths.mjs', 'persona-memory.mjs', 'autonomous-watch.mjs', 'browser-launcher.mjs', 'autonomous-share.mjs', 'task-limits.mjs', 'outbound-send.mjs', 'spark-service.mjs', 'spark-agent.mjs', 'autonomous-comments.mjs', 'comment-browser.mjs', 'public-comment-agent.mjs', 'daily-report.mjs', 'watch-mode.mjs', 'media/index.mjs', 'media/key-store.mjs', 'public/index.html', 'node_modules/playwright-core/package.json', 'node_modules/yaml/package.json'];
  if (await exists(ready)) {
    if (JSON.parse(await fs.readFile(ready, 'utf8')).runtimeId !== manifest.runtimeId) throw new Error('软件资源版本不匹配。');
    for (const file of required) if (!await exists(path.join(runtime, file))) throw new Error('已安装的软件资源不完整，请重新准备此版本。');
    return runtime;
  }
  await fs.mkdir(path.dirname(runtime), { recursive: true });
  const temporary = path.join(path.dirname(runtime), `.preparing-${randomUUID()}`);
  try {
    await fs.cp(seedDir, temporary, { recursive: true, dereference: true, force: false, errorOnExist: true });
    for (const file of required) await fs.access(path.join(temporary, file));
    await fs.writeFile(path.join(temporary, '.runtime-ready.json'), JSON.stringify({ runtimeId: manifest.runtimeId }) + '\n');
    await fs.rename(temporary, runtime);
  } finally {
    const relative = path.relative(path.join(userData, 'runtimes'), temporary);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(temporary).startsWith('.preparing-')) await fs.rm(temporary, { recursive: true, force: true });
  }
  return runtime;
}

export async function ensureSharedLocation({ env = process.env, home = homedir(), resolve }) {
  const file = absolute(env.DOUYIN_RUNTIME_LOCATION_FILE || path.join(home, '.dsh', 'douyin-browser', 'runtime-location.json'), '共享位置记录');
  const common = path.join(home, '.dsh', 'douyin-browser');
  let record;
  if (await exists(file)) record = JSON.parse(await fs.readFile(file, 'utf8'));
  else {
    record = { version: 1, stateDir: path.join(common, 'state'), mediaEnvFile: path.join(common, 'media', '.env'), mediaSettingsFile: path.join(common, 'media', 'settings.local.json'), mediaRuntimeRoot: path.join(common, 'media'), mediaModelsDir: path.join(common, 'media', '.models') };
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; record = JSON.parse(await fs.readFile(file, 'utf8')); }
  }
  if (!record || record.version !== 1 || Array.isArray(record) || typeof record.stateDir !== 'string') throw new Error('共享位置记录无效，未创建另一套状态。');
  for (const field of [...Object.keys(locationFields), 'memoryDir', 'memoryDbPath']) if (record[field] !== undefined) absolute(record[field], field);
  const registeredDb = record.memoryDbPath || (record.memoryDir ? path.join(record.memoryDir, 'shared.sqlite') : null);
  if (env.DEEPSEEK_SHARED_MEMORY_DB && registeredDb && absolute(env.DEEPSEEK_SHARED_MEMORY_DB, '共享记忆数据库') !== path.normalize(registeredDb)) throw new Error('显式数据库路径与已登记的共享记忆不一致；已保留原记录，未创建另一套记忆。');
  const paths = resolve({ env: { ...env, DOUYIN_RUNTIME_LOCATION_FILE: file }, home });
  // 首次登记现有记忆位置，不迁移、复制或清空数据库。
  if (!record.memoryDir || !record.memoryDbPath) {
    record.memoryDir = paths.memoryDir;
    record.memoryDbPath = paths.memoryDbPath;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  const domainEnv = { DOUYIN_RUNTIME_LOCATION_FILE: file, DEEPSEEK_SHARED_MEMORY_DB: paths.memoryDbPath };
  for (const [field, key] of Object.entries(locationFields)) domainEnv[key] = env[key] || paths[field];
  return { paths, env: domainEnv };
}

export async function verifyNode(node, provenanceFile) {
  const expected = JSON.parse(await fs.readFile(provenanceFile, 'utf8'));
  if (createHash('sha256').update(await fs.readFile(node)).digest('hex') !== expected.nodeSha256) throw new Error('随软件附带的 Node 运行程序校验失败。');
}
