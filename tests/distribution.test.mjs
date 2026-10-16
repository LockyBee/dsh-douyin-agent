import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const relativeImports = [
  /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
];
const included = relative => manifest.files.some(entry => entry.endsWith('/') ? relative.startsWith(entry) : entry === relative);

test('发行白名单覆盖原生入口和浏览器子进程的相对导入闭包', async () => {
  const visited = new Set();
  async function visit(relative) {
    if (visited.has(relative)) return;
    visited.add(relative);
    assert.ok(included(relative), `发行包缺少运行模块：${relative}`);
    const file = path.join(root, relative), source = await fs.readFile(file, 'utf8');
    for (const expression of relativeImports) {
      for (const match of source.matchAll(expression)) {
        const resolved = path.resolve(path.dirname(file), match[1].split(/[?#]/)[0]);
        const target = path.relative(root, resolved).split(path.sep).join('/');
        assert.ok(!target.startsWith('../') && !path.isAbsolute(target), '运行导入不得逃出发行包');
        await visit(target);
      }
    }
  }
  await visit('dsh-plugin.mjs');
  await visit('browser-host.mjs');
  assert.ok(visited.has('core.mjs') && visited.has('media/index.mjs'));
  for (const entry of [manifest.exports['.'], manifest.exports['./client'], manifest.dsh.bundle.patch]) {
    assert.ok(included(entry.replace(/^\.\//, '')), `发行包缺少声明入口：${entry}`);
  }
});

test('发行白名单排除本机状态、维护工具和桌面资源，保留精确运行文件', async () => {
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
  assert.equal(new Set(manifest.files).size, manifest.files.length, '发行白名单不得重复');
  for (const entry of manifest.files) {
    assert.ok(!/[?*\[\]\\]/.test(entry), `发行白名单不得使用运行文件通配符：${entry}`);
    assert.ok(!entry.startsWith('/') && !entry.includes('..'), '发行白名单只能使用包内路径');
    assert.ok(!/^(?:desktop|tests|verification|state|node_modules|public)(?:\/|$)/.test(entry), `发行包不应包含开发或个人目录：${entry}`);
    assert.ok(!/(?:^|\/)(?:\.env(?:\.|$)|\.cache|\.models|\.venv|settings\.local\.json|runtime-location\.json)|(?:hotload|plugin-install|install-native|probe|mcp-options)/i.test(entry), `发行包不应包含本机配置或维护工具：${entry}`);
    if (entry.endsWith('/')) assert.equal(entry, 'docs/', '只有公开说明目录允许整体包含');
    else assert.ok((await fs.stat(path.join(root, entry))).isFile(), `发行文件不存在：${entry}`);
  }
  for (const relative of ['LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'skill/SKILL.md']) assert.ok(included(relative));
});

test('发行包保留可选音频运行入口和全部固定来源文件及原始许可', async () => {
  for (const relative of ['media/local_whisper.py', 'media/mimo_bridge.py', 'media/setup_local.py', 'media/requirements.txt', 'media/PROVENANCE.json']) {
    assert.ok(included(relative), `发行包缺少音频入口：${relative}`);
  }
  const provenance = JSON.parse(await fs.readFile(path.join(root, 'media/PROVENANCE.json'), 'utf8'));
  assert.equal(provenance.filter(entry => entry.localPath.endsWith('/LICENSE')).length, 3);
  for (const entry of provenance) {
    const relative = `media/${entry.localPath}`;
    assert.ok(included(relative), `发行包缺少固定来源文件：${relative}`);
    const bytes = await fs.readFile(path.join(root, relative));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `固定来源文件已变化：${relative}`);
  }
});
