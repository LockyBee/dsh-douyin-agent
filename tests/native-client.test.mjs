import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await fs.readFile(path.join(root, 'client.js'), 'utf8');
function load() {
  let definition; const dependencies = [];
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { definition = value; } } }, globalThis: {}, AbortSignal, Set, Error }, { filename: 'client.js' });
  const plugin = definition.factory(name => { dependencies.push(name); if (name === 'react') return {}; if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Button() {} }; throw new Error(`意外客户端依赖 ${name}`); });
  return { definition, dependencies, plugin };
}

test('原生客户端以实际包身份自注册设置插槽，依赖已有静态组件而非不存在runtime包', async () => {
  const { definition, plugin, dependencies } = load(), manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(definition.id, manifest.name); assert.deepEqual(dependencies, ['react', '@deepseek-ai/dsh-client-ui-primitives']);
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings-general']);
  let slot, component, disposed = false;
  plugin.apply({ slots: { inject(name, action) { assert.equal(name, 'settings.section'); this.cleanup = action(); }, register(options, view) { slot = options; component = view; return () => { disposed = true; }; } } });
  assert.equal(slot.id, 'douyin-browser'); assert.equal(slot.name, 'settings.section'); assert.equal(slot.label(), '刷抖音'); assert.equal(component, plugin.SettingsPage); assert.equal(disposed, false);
  assert.doesNotMatch(source, /dsh-client-runtime|http:\/\/127\.0\.0\.1:3218|type:\s*['"]password['"]/);
});

test('原生设置仅同源请求，会话token只进写请求头，403不隐式重试，无载体file页明确拒绝', async () => {
  const { plugin } = load(), calls = [];
  const native = plugin.createSettingsTransport({ location: { protocol: 'http:', hostname: '127.0.0.1' }, fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => url.endsWith('/state') ? { token: 'synthetic-native-token', persona: {} } : { saved: true } }; } });
  await assert.rejects(native.request('/video/start', {}), /先刷新/); assert.equal(calls.length, 0);
  const state = await native.request('/state'); assert.equal(state.token, undefined);
  await native.request('/mode/configure', { silent: true }); assert.equal(calls[1].url, '/api/douyin-browser/mode/configure'); assert.equal(calls[1].init.headers['x-douyin-settings-token'], 'synthetic-native-token'); assert.equal(calls[1].init.body, '{"silent":true}'); assert.equal(calls[1].init.credentials, 'same-origin');
  await assert.rejects(native.request('//evil.example/state'), /只允许/); await assert.rejects(native.request('/reports/read?date=2026-10-15&token=x'), /只允许/);
  let leaked = false; const unavailable = plugin.createSettingsTransport({ location: { protocol: 'file:', hostname: '' }, fetch: () => { leaked = true; } }); await assert.rejects(unavailable.request('/state'), /没有可用的同源/); assert.equal(leaked, false);
  const denied = plugin.createSettingsTransport({ location: { protocol: 'http:', hostname: '127.0.0.1' }, fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: '合成授权已过期。' }) }) });
  await assert.rejects(denied.request('/state'), error => error.status === 403); assert.equal(calls.length, 2);
  let carried = false; const carrier = plugin.createSettingsTransport({ location: { protocol: 'file:', hostname: '' }, __DSH_TRANSPORT__: { fetch: async () => { carried = true; return { ok: true, json: async () => ({ token: 'synthetic-carrier' }) }; } } });
  await carrier.request('/state'); assert.equal(carried, true);
});

test('原生设置页面只显式写入，保留人格草稿及409冲突，直接操作有限观看和独立问候许可', { timeout: 40_000 }, async t => {
  const desktop = createRequire(new URL('../desktop/package.json', import.meta.url)), local = createRequire(new URL('../desktop/ui-api/package.json', import.meta.url));
  let build, chromium;
  try { ({ build } = desktop('esbuild')); ({ chromium } = await import('../playwright-runtime.mjs')); local.resolve('react'); } catch { t.skip('可选原生页面检查需要已有桌面构建依赖和临时 Edge。'); return; }
  const assets = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-native-client-ui-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(assets)), path.resolve(os.tmpdir())); await fs.rm(assets, { recursive: true, force: true }); });
  const nativeAssets = 'F:/codex/DSH Desktop 2/resources/app/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets';
  try { await fs.writeFile(path.join(assets, 'native-theme.css'), (await Promise.all(['vendor-BNsW4eBh.css', 'index-BPHePDI_.css'].map(file => fs.readFile(path.join(nativeAssets, file), 'utf8')))).join('\n')); } catch { await fs.writeFile(path.join(assets, 'native-theme.css'), ''); }
  const upstream = path.join(root, 'desktop/.cache/upstream/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/client');
  await build({ stdin: { sourcefile: 'native-client-harness.jsx', resolveDir: root, loader: 'jsx', contents: `import React from 'react';import{createRoot}from'react-dom/client';import * as primitives from '@native/primitives';import '@native/theme/base.css';import '@native/theme/design-platform.css';window.__ModuleLoader__={load({factory}){const plugin=factory(name=>name==='react'?React:name==='@deepseek-ai/dsh-client-ui-primitives'?primitives:(()=>{throw Error('意外依赖')})());window.__nativePlugin=plugin;plugin.apply({slots:{inject(name,action){action()},register(options,Component){createRoot(document.getElementById('root')).render(<Component/>);return()=>{}}}})}};const original=setInterval;window.setInterval=(fn,ms)=>original(fn,Math.min(ms,100));const script=document.createElement('script');script.src='/client.js';document.body.appendChild(script);` }, bundle: true, outfile: path.join(assets, 'harness.js'), format: 'esm', platform: 'browser', target: 'chrome120', jsx: 'automatic', alias: { '@native/primitives': path.join(upstream, 'ui-primitives/src/index.ts'), '@native/theme': path.join(upstream, 'ui-theme/src/styles'), ...Object.fromEntries(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => [name, local.resolve(name)])) }, nodePaths: [path.join(root, 'desktop/ui-api/node_modules')], tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } }, loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, assetNames: 'assets/[name]-[hash]', minify: true });
  const allowed = [{ id: 'conv:' + 'a'.repeat(64), name: '合成许可好友甲', followed: true, isGroup: false }];
  const state = { token: 'synthetic-native-settings', persona: { manualText: '合成人格初始正文。', revision: 'synthetic-v1', personaFolder: 'C:/合成记忆/persona' }, model: { configured: true, providers: [{ id: 'synthetic', name: '合成已配置提供商' }], provider: 'synthetic', model: 'synthetic-vision' }, video: { allowed: false, reason: '请先开始有限轮次。', policy: { windows: ['00:00-24:00'], sessionMinutes: 10 }, session: null }, watch: { running: false, counts: { maxRequests: 30 } }, mode: { silent: false }, spark: { enabled: false, running: false, policy: { windows: ['09:00-22:00'], dailyLimit: 2 }, recipients: allowed, needsReview: [] }, comments: { enabled: false, policy: { dailyLimit: 3, perSessionLimit: 1 }, daily: { attempts: 0 }, session: { attempts: 0 }, needsReview: [] }, share: { enabled: false, dailyLimit: 3, needsReview: [] }, chat: { running: false, policy: { allowlist: allowed, dailyReplyLimit: 40 }, contacts: [] }, media: { enabled: false, backend: 'local-whisper' }, reports: { date: '2026-10-15', folder: 'C:/合成记忆/reports/videos', reports: [] } };
  const calls = [], errors = []; let failState = false, failComments = false;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost'), reply = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname.startsWith('/api/douyin-browser/')) {
      let raw = ''; for await (const chunk of request) raw += chunk; const input = raw ? JSON.parse(raw) : null;
      calls.push({ route: url.pathname.replace('/api/douyin-browser', ''), method: request.method, body: input, token: request.headers['x-douyin-settings-token'] });
      if (url.pathname.endsWith('/state')) return failState ? reply({ error: '合成原生状态暂不可用。' }, 503) : reply(state);
      if (request.method === 'POST' && request.headers['x-douyin-settings-token'] !== state.token) return reply({ error: '合成令牌不符。' }, 403);
      const route = url.pathname.replace('/api/douyin-browser', '');
      if (route === '/persona/configure') { if (input.expectedRevision !== state.persona.revision) return reply({ error: '合成人格版本冲突。' }, 409); state.persona = { ...state.persona, manualText: input.content, revision: 'synthetic-v3' }; }
      if (route === '/video/start') { state.video.allowed = true; state.video.reason = ''; state.video.session = { status: 'active' }; }
      if (route === '/watch/start') state.watch.running = true;
      if (route === '/watch/stop') state.watch.running = false;
      if (route === '/spark/configure') { state.spark.enabled = input.enabled; state.spark.policy = input; }
      if (route === '/comments/configure') { if (failComments) return reply({ error: '合成评论设置忙。' }, 409); state.comments.enabled = input.enabled; state.comments.policy = input; }
      if (route === '/mode/configure') state.mode.silent = input.silent;
      if (route === '/chat/contacts') return reply({ contacts: allowed });
      if (route === '/reports/read' || route === '/reports/generate') return reply({ date: '2026-10-15', markdown: '# 合成观看日报\n只整理已有证据。' });
      return reply({ ok: true });
    }
    if (url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/native-theme.css"><link rel="stylesheet" href="/harness.css"></head><body data-ds-dark-theme style="background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);padding:24px"><p style="font-size:12px;color:var(--dsw-alias-label-tertiary)">合成设置页预览：未连接真实联系人、模型或抖音。</p><div id="root"></div><script type="module" src="/harness.js"></script></body></html>'); return; }
    if (url.pathname === '/client.js') { response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); response.end(source); return; }
    if (url.pathname === '/harness.js') { response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); response.end(await fs.readFile(path.join(assets, 'harness.js'))); return; }
    try { const target = path.resolve(assets, url.pathname.slice(1)); if (!target.startsWith(assets + path.sep)) throw new Error(); const content = await fs.readFile(target); response.writeHead(200, { 'content-type': target.endsWith('.css') ? 'text/css' : target.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream' }); response.end(content); } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-native-client-edge-')), browser = await chromium.launchPersistentContext(profile, { headless: true, channel: 'msedge', viewport: { width: 1100, height: 900 } });
  t.after(async () => { await browser.close(); assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir())); await fs.rm(profile, { recursive: true, force: true }); });
  const page = browser.pages()[0]; page.setDefaultTimeout(8000); page.on('pageerror', error => { errors.push(error.message); t.diagnostic(error.stack || error.message); }); await page.goto(`http://127.0.0.1:${server.address().port}`);
  const persona = page.getByRole('textbox', { name: '大肥鱼人格正文', exact: true }); await persona.waitFor(); await page.waitForFunction(() => document.querySelector('[aria-label="大肥鱼人格正文"]').disabled === false);
  await page.screenshot({ path: path.join(root, 'verification/native-settings-preview.png') });
  assert.equal(await persona.inputValue(), '合成人格初始正文。'); assert.equal(calls.some(item => item.method === 'POST'), false); assert.equal(await page.locator('input[type="password"]').count(), 0); assert.equal(await page.getByRole('textbox', { name: /聊天输入|视频任务/ }).count(), 0);
  await persona.fill('合成人格未保存草稿。'); state.persona = { ...state.persona, manualText: '合成外部更新正文。', revision: 'synthetic-v2' }; await page.waitForTimeout(300); assert.equal(await persona.inputValue(), '合成人格未保存草稿。');
  await page.getByRole('button', { name: '保存人格', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '草稿已保留' }).waitFor(); assert.equal(await persona.inputValue(), '合成人格未保存草稿。');
  assert.equal(calls.find(item => item.route === '/persona/configure').body.expectedRevision, 'synthetic-v1');
  await page.getByRole('button', { name: '载入最新人格（替换草稿）', exact: true }).click(); assert.equal(await persona.inputValue(), '合成外部更新正文。'); await persona.fill('合成人格明确保存的新正文。'); await page.getByRole('button', { name: '保存人格', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="大肥鱼人格正文"]').value === '合成人格明确保存的新正文。'); assert.equal(calls.filter(item => item.route === '/persona/configure').at(-1).body.expectedRevision, 'synthetic-v2');
  const startWatch = page.getByRole('button', { name: '开始自主观看', exact: true }); assert.equal(await startWatch.isDisabled(), true); await page.getByRole('button', { name: '开始有限轮次', exact: true }).click(); await startWatch.click(); await page.waitForFunction(() => document.querySelector('[aria-label="模型名称"]').disabled === true); assert.deepEqual(calls.find(item => item.route === '/watch/start').body, { maxRequests: 30 });
  await page.getByRole('button', { name: '停止自主观看', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[aria-label="模型名称"]').disabled === false);
  const numeric = page.getByRole('spinbutton', { name: '单轮上限（分钟）', exact: true }); await numeric.focus();
  assert.equal(await numeric.evaluate(input => getComputedStyle(input).outlineStyle), 'none');
  assert.equal(await numeric.evaluate(input => parseFloat(getComputedStyle(input.parentElement).borderTopWidth) > 0), true);
  const shots = path.join(root, 'desktop/ui-api/.test-temp/native-client'); await fs.mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, 'native-settings-top.png') });
  await page.getByRole('checkbox', { name: '静默观看', exact: true }).check(); await page.getByRole('button', { name: '保存静默设置', exact: true }).click(); assert.deepEqual(calls.filter(item => item.route === '/mode/configure').at(-1).body, { silent: true });
  await page.getByRole('checkbox', { name: '允许主动问候', exact: true }).check(); await page.getByRole('button', { name: '保存问候许可', exact: true }).click(); assert.equal(calls.some(item => item.route === '/spark/start'), false);
  await page.getByRole('checkbox', { name: '允许主动问候', exact: true }).uncheck(); await page.getByRole('button', { name: '保存问候许可', exact: true }).click(); await page.waitForTimeout(150); assert.deepEqual(calls.filter(item => item.route.startsWith('/spark/')).slice(-2).map(item => item.route), ['/spark/configure', '/spark/stop']);
  failComments = true; await page.getByRole('checkbox', { name: '允许自主发布评论', exact: true }).check(); await page.getByRole('button', { name: '保存评论许可', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '合成评论设置忙' }).waitFor(); assert.equal(await page.getByRole('checkbox', { name: '允许自主发布评论', exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '读取已关注联系人', exact: true }).click(); await page.getByRole('checkbox', { name: '许可联系人 合成许可好友甲', exact: true }).waitFor(); await page.getByRole('button', { name: '读取所选日报', exact: true }).click(); await page.getByLabel('日报内容').filter({ hasText: '合成观看日报' }).waitFor();
  failState = true; await page.getByRole('status').filter({ hasText: '正在核实插件状态' }).waitFor(); assert.equal(await page.getByRole('button', { name: '保存评论许可', exact: true }).isDisabled(), true);
  assert.equal(calls.filter(item => item.method === 'POST').every(item => item.token === state.token), true); assert.deepEqual(errors, []);
});
