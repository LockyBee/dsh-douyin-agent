import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'app');
const runtime = path.join(root, '.cache', 'api-runtime');
const { version: productVersion } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const ui = JSON.parse(await fs.readFile(path.join(runtime, 'public', 'build-info.json'), 'utf8'));
if (ui.version !== productVersion) throw new Error('软件界面版本与桌面版本不一致，请重新构建界面和后台资源。');
await fs.mkdir(output, { recursive: true });
const entries = ['main.mjs', 'api-process.mjs', 'prepare-api-runtime.mjs', 'media-key-store.mjs', 'startup-navigation.mjs', 'preload.cjs', 'update-service.mjs', 'update-launcher.mjs'];
for (const name of entries) await fs.copyFile(name === 'media-key-store.mjs' ? path.join(root, '..', 'media', 'key-store.mjs') : path.join(root, 'src', name), path.join(output, name));
await fs.copyFile(path.join(root,'assets/app.ico'),path.join(output,'app.ico'));
const allowed = new Set([...entries, 'app.ico', 'build-manifest.json']);
for (const entry of await fs.readdir(output, { withFileTypes: true })) {
  if (!allowed.has(entry.name)) {
    if (!entry.isFile()) throw new Error('桌面输出目录含未知子目录，未执行清理。');
    await fs.unlink(path.join(output, entry.name));
  }
}
const hash = createHash('sha256'); let files = 0;
async function scan(directory, prefix = '') {
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('运行资源包含外链或特殊文件。');
    if (['.env', '.git'].includes(entry.name) || /^(?:state|verification|profiles)(?:\/|$)/.test(relative) || /^node_modules\/(?:@deepseek-ai|@agents-anywhere|dsh-)/.test(relative)) throw new Error(`独立软件包含非预期资源：${relative}`);
    if (entry.isDirectory()) await scan(path.join(directory, entry.name), relative);
    else { hash.update(relative); hash.update('\0'); hash.update(await fs.readFile(path.join(directory, entry.name))); hash.update('\0'); files++; }
  }
}
await scan(runtime);
const runtimeId = hash.digest('hex');
await fs.writeFile(path.join(output, 'build-manifest.json'), JSON.stringify({ version: 1, productVersion, runtimeId, files, independentApi: true }, null, 2) + '\n');
console.log(`独立 API 软件入口构建完成，${files} 个运行文件，摘要 ${runtimeId}`);
