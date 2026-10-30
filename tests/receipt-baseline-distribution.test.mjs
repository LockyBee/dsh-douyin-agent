import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {DOMAIN_FILES} from '../desktop/scripts/stage-api-runtime.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
test('收据基线发行：插件与软件都显式包含唯一公共模块',async()=>{
  assert.equal(manifest.files.filter(file=>file==='receipt-baseline.mjs').length,1);assert.equal(DOMAIN_FILES.filter(file=>file==='receipt-baseline.mjs').length,1);assert.equal(new Set(DOMAIN_FILES).size,DOMAIN_FILES.length);assert.ok(DOMAIN_FILES.length>=41);
  const source=await fs.readFile(path.join(root,'receipt-baseline.mjs'),'utf8');assert.match(source,/export function writeDurableReceiptFile/);
});
test('收据基线发行：两入口依赖和公共模块的相对运行导入都包含在发行与软件模块集合',async()=>{
  for(const file of ['comment-browser.mjs','video-forward.mjs'])assert.match(await fs.readFile(path.join(root,file),'utf8'),/from ['"]\.\/receipt-baseline\.mjs['"]/);
  const source=await fs.readFile(path.join(root,'receipt-baseline.mjs'),'utf8');
  for(const match of source.matchAll(/\bfrom\s*['"](\.\/[^'"]+)['"]/g)){const target=match[1].slice(2);assert.ok(manifest.files.includes(target),target);assert.ok(DOMAIN_FILES.includes(target),target);assert.ok((await fs.stat(path.join(root,target))).isFile());}
});
