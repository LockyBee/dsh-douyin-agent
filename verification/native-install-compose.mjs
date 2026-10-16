import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const defaultSdk = 'F:/codex/DSH Desktop 2/resources/app/node_modules';

// 只读取配置并在内存合成，不加载插件、求值表达式或改写 profile。
export async function inspectNativeProfile({ homeDir = process.env.DSH_HOME || path.join(homedir(), '.dsh'), sdk = process.env.DSH_NODE_MODULES || defaultSdk } = {}) {
  const { loadProfileDirectory, loadOverlayPatches, composeEntries } = await import(pathToFileURL(path.join(sdk, '@deepseek-ai/dsh-app-boot/lib/index.js')).href);
  const profileDir = path.join(homeDir, 'profiles', 'desktop');
  const profile = loadProfileDirectory('douyin-install-audit', profileDir, path.join(sdk, '@deepseek-ai/dsh/package.json'));
  const globalFile = path.join(homeDir, 'cordis.patch.yml');
  const globalRaw = fs.existsSync(globalFile) ? fs.readFileSync(globalFile, 'utf8') : '';
  const globalPatches = globalRaw ? loadOverlayPatches('douyin-install-audit', globalFile) : [];
  const warnings = [];
  const effective = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches, globalPatches], message => warnings.push(message));
  const owned = effective.filter(row => row.id === 'douyin-browser' || row.name === 'dsh-douyin-browser-local' || typeof row.name === 'string' && row.name.startsWith(pathToFileURL(path.join(projectDir, 'dsh-plugin.mjs')).href));
  const others = effective.filter(row => !owned.includes(row)).map(row => ({ id: row.id, content: JSON.stringify(row) })).sort((a, b) => String(a.id).localeCompare(String(b.id)) || a.content.localeCompare(b.content));
  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  return {
    profileDir, globalFile, loadedProfileLayers: profile.layers.length,
    skippedBundleNames: profile.skippedBundles.map(item => item.packageName),
    ownedDependencies: Object.fromEntries(Object.entries(manifest.dependencies || {}).filter(([name]) => name === 'dsh-douyin-browser-local')),
    ownedBundleCount: (manifest.dsh?.profile?.bundles || []).filter(name => name === 'dsh-douyin-browser-local').length,
    managedLegacyBlocks: (globalRaw.match(/^# BEGIN DSH DOUYIN BROWSER\r?$/gm) || []).length,
    ownedRows: owned.map(({ id, name, disabled = false }) => ({ id, name, disabled })),
    otherEffectiveRowCount: others.length,
    otherEffectiveRowsSha256: createHash('sha256').update(JSON.stringify(others)).digest('hex'),
    warningCount: warnings.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await inspectNativeProfile(), null, 2)); }
  catch (error) { console.error(`只读合成检查失败：${error.message}`); process.exitCode = 1; }
}
