import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const VARIABLES = { mimo: 'XIAOMI_API_KEY', minimax: 'MINIMAX_API_KEY' };

export async function saveSharedMediaKey(input, { envFile, explicit = false } = {}) {
  if (explicit !== true) throw new Error('音频密钥只能由用户明确保存。');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['backend', 'apiKey'].includes(key)) || !Object.hasOwn(VARIABLES, input.backend)) throw new Error('请选择 MiMo 或 MiniMax。');
  if (typeof input.apiKey !== 'string' || !/^[A-Za-z0-9._~+/=-]{1,4096}$/.test(input.apiKey)) throw new Error('音频 API Key 格式不正确，请检查空格或换行。');
  if (typeof envFile !== 'string' || !path.isAbsolute(envFile) || /[\r\n\0]/.test(envFile)) throw new Error('共享音频配置路径无效。');
  await fs.mkdir(path.dirname(envFile), { recursive: true });
  const lockFile = `${envFile}.credentials.lock`, nonce = randomUUID();
  let lock;
  for (let attempt = 0; ; attempt++) {
    try { lock = await fs.open(lockFile, 'wx', 0o600); break; }
    catch (error) { if (error.code !== 'EEXIST' || attempt >= 100) throw new Error('音频配置正被使用，未覆盖原文件，请稍后再试。'); await delay(20); }
  }
  const temporary = `${envFile}.${nonce}.tmp`;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, nonce }));
    let original = '';
    try {
      const stat = await fs.lstat(envFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('共享音频配置不是可编辑的普通文件。');
      original = await fs.readFile(envFile, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('共享音频配置无法读取，原文件已保留。'); }
    const variable = VARIABLES[input.backend], newline = original.includes('\r\n') ? '\r\n' : '\n';
    const pattern = new RegExp(`^(?:[ \\t]*export[ \\t]+)?[ \\t]*${variable}[ \\t]*=.*$`, 'gm');
    let found = false;
    const replacement = `${variable}=${input.apiKey}`;
    let updated = original.replace(pattern, () => { if (found) return ''; found = true; return replacement; });
    if (!found) updated += (updated && !updated.endsWith('\n') ? newline : '') + replacement + newline;
    await fs.writeFile(temporary, updated, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, envFile);
    return { backend: input.backend, configured: true, storage: 'shared-env' };
  } finally {
    await lock.close();
    await fs.rm(temporary, { force: true });
    await fs.unlink(lockFile);
  }
}
