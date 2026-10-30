import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../playwright-runtime.mjs';

test('软件顶栏分开显示观看与回复，观看中不再只剩离线', async t => {
  const ui = fileURLToPath(new URL('../', import.meta.url)), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-presence-split-'));
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const local = createRequire(new URL('../package.json', import.meta.url)), desktop = createRequire(new URL('../../package.json', import.meta.url));
  const source = await fs.readFile(path.join(ui, 'src/main.jsx'), 'utf8');
  const helpers = source.slice(source.indexOf('function Field('), source.indexOf('function ApiSettings('));
  assert.ok(helpers.includes('function FriendPresence('));
  const primitive = path.join(directory, 'primitives.jsx');
  await fs.writeFile(primitive, `import React from'react';export const Button=({children,...props})=><button type="button" {...props}>{children}</button>;`);
  const entry = `import React from'react';import{createRoot}from'react-dom/client';import{Button}from'@dsh/primitives';${helpers}
  const presence={status:'watching',online:false,label:'正在挑选视频 · 回复已关闭',reason:'好友互动已关闭。',watch:{active:true,phase:'model',label:'正在挑选视频',reason:'自主观看正在挑选下一条视频。'},reply:{status:'offline',online:false,label:'回复已关闭',reason:'好友互动已关闭。'},review:{active:true,manualCount:2,label:'有 2 条未答消息',reason:'有 2 条已保留消息需要人工核对；处理后不会补发。'}};
  createRoot(document.getElementById('root')).render(<FriendPresence presence={presence} connected={true} onOpen={()=>{}}/>);`;
  await desktop('esbuild').build({ stdin: { contents: entry, loader: 'jsx', resolveDir: directory }, outfile: path.join(directory, 'app.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', alias: { '@dsh/primitives': primitive, ...Object.fromEntries(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'].map(name => [name, local.resolve(name)])) }, define: { 'process.env.NODE_ENV': '"production"' } });
  const server = http.createServer(async (request, response) => {
    if (request.url === '/') { response.writeHead(200, { 'content-type': 'text/html' }); return response.end('<div id="root"></div><script type="module" src="/app.js"></script>'); }
    response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(await fs.readFile(path.join(directory, 'app.js')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
  const button = page.getByLabel('好友互动状态', { exact: true });
  await button.filter({ hasText: '回复已关闭' }).waitFor();
  assert.match(await button.innerText(), /○ 回复已关闭/);
  assert.match(await page.getByLabel('自主观看状态').innerText(), /正在挑选视频/);
  assert.equal(await page.getByLabel('待核对事项').count(), 0);
  assert.equal(await page.getByRole('button', { name: '查看遗留待处理消息', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '查看好友互动状态', exact: true }).count(), 0);
  await page.getByText('好友互动已关闭。', { exact: true }).waitFor();
});
