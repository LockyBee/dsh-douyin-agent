import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dependencyOwners } from '../scripts/licenses.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), dist = path.join(root, 'dist');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('实际打入的依赖均有可核对通知，清单没有机器绝对路径或开发工具', async () => {
  const text = await fs.readFile(path.join(dist, 'licenses', 'manifest.json'), 'utf8'), manifest = JSON.parse(text);
  const info = JSON.parse(await fs.readFile(path.join(dist, 'build-info.json'), 'utf8'));
  assert.equal(manifest.method, 'esbuild-metafile-bytesInOutput'); assert.equal(info.licenses.packages, manifest.packages.length);
  for (const name of ['react', 'react-dom', 'scheduler', 'katex', '@shikijs/core', '@shikijs/langs', 'mdast-util-from-markdown', 'micromark-core-commonmark', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-theme']) assert.ok(manifest.packages.some(item => item.name === name), name);
  assert.equal(manifest.packages.some(item => ['electron', 'esbuild', '@deepseek-ai/cordis'].includes(item.name)), false);
  assert.doesNotMatch(text, /[a-zA-Z]:[\\/]|(?:^|[\\/])Users[\\/]|\/home\//);
  for (const item of manifest.packages) {
    assert.ok(item.inputs.length && item.notices.length, item.name);
    for (const notice of item.notices) {
      const bytes = await fs.readFile(path.join(dist, notice.file)); assert.equal(digest(bytes), notice.sha256, notice.file);
      assert.ok(bytes.toString('utf8').trim().length > 50, notice.file);
    }
  }
  for (const artifact of manifest.artifacts) assert.equal(digest(await fs.readFile(path.join(dist, artifact.file))), artifact.sha256, artifact.file);
});

test('全部60个实际字体保留已读取的OFL版权、保留名与不变字节证据', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(dist, 'licenses', 'manifest.json'), 'utf8'));
  const files = (await fs.readdir(path.join(dist, 'assets'))).filter(file => /\.(?:ttf|woff2?)$/i.test(file));
  assert.equal(manifest.fonts.length, 60); assert.equal(files.length, manifest.fonts.length);
  const families = new Set();
  for (const font of manifest.fonts) {
    assert.equal(font.license, 'OFL-1.1'); assert.equal(digest(await fs.readFile(path.join(dist, font.file))), font.sha256);
    font.family.forEach(family => families.add(family));
  }
  assert.equal(families.size, 12);
  const text = await fs.readFile(path.join(dist, 'licenses', 'katex-fonts', 'OFL-1.1.txt'), 'utf8');
  assert.match(text, /Copyright \(c\) 2009-2010.*Design Science/); assert.match(text, /Khan Academy/);
  assert.match(text, /Reserved Font Name KaTeX_Main/); assert.match(text, /SIL OPEN FONT LICENSE Version 1\.1 - 26 February 2007/);
  assert.match(text, /TERMINATION/); assert.match(text, /DISCLAIMER/);
});

test('新的实际运行依赖没有许可证时拒绝构建，内部type包声明不会掩盖归属', async t => {
  const temporaryRoot = path.join(root, '.test-temp'); await fs.mkdir(temporaryRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'license-case-'));
  t.after(async () => { if (!path.resolve(directory).startsWith(path.resolve(temporaryRoot) + path.sep)) throw new Error('许可证测试清理越界。'); await fs.rm(directory, { recursive: true, force: true }); });
  const pkg = path.join(directory, 'node_modules', 'synthetic-runtime'), lib = path.join(pkg, 'lib'); await fs.mkdir(lib, { recursive: true });
  await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'synthetic-runtime', version: '1.0.0', license: 'MIT' }));
  await fs.writeFile(path.join(lib, 'package.json'), '{"type":"module"}'); await fs.writeFile(path.join(lib, 'index.js'), 'export const value = 1;');
  const meta = { outputs: { 'dist/app.js': { inputs: { 'node_modules/synthetic-runtime/lib/index.js': { bytesInOutput: 10 } } } } };
  const options = { projectRoot: directory, upstreamRoot: path.join(directory, 'upstream'), workingDirectory: directory };
  await assert.rejects(dependencyOwners(meta, options), /缺少许可证原文/);
  await fs.writeFile(path.join(pkg, 'LICENSE'), '合成许可证，仅用于验证缺失时拒绝与归属查找。');
  const result = await dependencyOwners(meta, options); assert.equal(result[0].name, 'synthetic-runtime'); assert.equal(result[0].inputs[0].file, 'lib/index.js');
});
