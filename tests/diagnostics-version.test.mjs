import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { readProductVersion } from '../diagnostics.mjs';

test('插件自检从实际 manifest 读取版本，软件读取界面构建信息而非运行模板版本', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dy-version-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = pathToFileURL(root + path.sep), manifest = path.join(root, 'package.json');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'dsh-douyin-browser-local', version: '1.5.0-beta.1' })); assert.equal(readProductVersion(base), '1.5.0-beta.1');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'douyin-api-runtime', version: '1.0.0' })); assert.equal(readProductVersion(base), 'unknown');
  fs.mkdirSync(path.join(root, 'public')); fs.writeFileSync(path.join(root, 'public/build-info.json'), JSON.stringify({ version: '1.5.0-beta.2' })); assert.equal(readProductVersion(base), '1.5.0-beta.2');
  fs.writeFileSync(path.join(root, 'public/build-info.json'), 'broken'); assert.equal(readProductVersion(base), 'unknown');
  fs.writeFileSync(manifest, JSON.stringify({ name: 'unrelated', version: '1.5.0' })); assert.equal(readProductVersion(base), 'unknown');
});
