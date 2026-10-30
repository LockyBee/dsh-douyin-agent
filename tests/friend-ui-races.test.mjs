import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { matchesAuthorizedContact } from '../contact-authorization.mjs';

const native = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8');
const software = await fs.readFile(new URL('../desktop/ui-api/src/main.jsx', import.meta.url), 'utf8');
const hookSource = await fs.readFile(new URL('../desktop/ui-api/src/use-auto-save.jsx', import.meta.url), 'utf8');
function extract(source, startText, endText) {
  const start = source.indexOf(startText), end = source.indexOf(endText, start); assert.ok(start >= 0 && end > start);
  return source.slice(start, end).trim().replace(/^export /, '');
}

test('原生fresh刷新合并为单飞请求，不应用需要重读的旧快照', async () => {
  const code = extract(native, 'async function refresh(fresh = false)', '\n      useEffect(');
  const first = Promise.withResolvers(), entered = Promise.withResolvers(), applied = []; let active = 0, max = 0, reads = 0;
  const api = { request: async () => { const sequence = ++reads; active++; max = Math.max(max, active); if (sequence === 1) { entered.resolve(); await first.promise; } else await new Promise(resolve => setTimeout(resolve, 10)); active--; return { sequence }; } };
  const refresh = new Function('api', 'alive', 'refreshing', 'refreshAgain', 'setState', 'setReady', 'setConnectionError', `return (${code});`)(api, { current: true }, { current: null }, { current: false }, value => applied.push(value.sequence), () => {}, () => {});
  const old = refresh(); await entered.promise; const one = refresh(true), two = refresh(true); first.resolve(); const results = await Promise.all([old, one, two]);
  assert.equal(max, 1); assert.equal(reads, 2); assert.deepEqual(applied, [2]);
  assert.equal(results.every(value => value?.sequence === 2), true, '无论新建还是等待中的refresh都返回已核实快照');
  assert.equal((await refresh(true)).sequence, 3, '没有现成轮询时，恢复按钮仍可拿到最新快照');
});

for (const [label, source, startText, endText] of [
  ['软件', hookSource, 'export function useAutoSave(', '\nexport function AutoSaveStatus'],
  ['插件', native, '    function useAutosave(', '\n    function SettingsPage'],
]) test(`${label}旧勾选queued不能越过新的昵称blur草稿，离开后才写完整值`, async () => {
  const code = extract(source, startText, endText), first = Promise.withResolvers(), entered = Promise.withResolvers(), calls = [];
  // 直接执行产品hook的闭包与真实定时器；此处不假称浏览器或真实联系人联调。
  const hook = new Function('useState', 'useRef', 'useEffect', `return (${code});`)(initial => [typeof initial === 'function' ? initial() : initial, () => {}], value => ({ current: value }), effect => { effect(); });
  const form = hook({ value: null, initial: { ids: [], name: '大肥鱼' }, read: value => value, encode: value => value, write: async value => { calls.push(structuredClone(value)); if (calls.length === 1) { entered.resolve(); await first.promise; } return value; } });
  form.edit({ ids: ['a'] }, { immediate: true }); await entered.promise;
  form.edit({ ids: ['a', 'b'] }, { immediate: true }); await new Promise(resolve => setTimeout(resolve, 15));
  form.edit({ name: '大肥' }, { blurOnly: true }); first.resolve(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.length, 1, '未blur时不能把半段昵称作为第二次名单保存');
  form.edit({ name: '大肥鱼完整昵称' }, { blurOnly: true }); await form.flush();
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], { ids: ['a', 'b'], name: '大肥鱼完整昵称' });
});

test('两端名单去掉身份旁注，授权仍由稳定身份核对', () => {
  for (const source of [software, native]) assert.doesNotMatch(source, /contactPermissionLabel|稳定身份已核对|关注关系未核实/);
  const current = { id: `conv:${'a'.repeat(64)}`, name: '合成许可好友', isGroup: false, followed: null, identityVerified: true, identityVersion: 2, identityKind: 'rendered-user', identityHash: 'a'.repeat(64), identityBinding: `binding:${'b'.repeat(64)}`, relationshipStatus: 'unavailable' };
  const saved = { ...current, verifiedAt: '2026-10-24T00:00:00.000Z', authorizationKind: 'existing-conversation' };
  assert.equal(matchesAuthorizedContact(saved, { ...current, name: '合成新昵称' }), true);
  assert.equal(matchesAuthorizedContact(saved, { ...current, id: `conv:${'c'.repeat(64)}` }), false);
  assert.equal(matchesAuthorizedContact(saved, { ...current, identityBinding: `binding:${'d'.repeat(64)}` }), false);
});

test('软件状态栏直接渲染后端presence；断连不继续显示旧在线，attention展示原因', async () => {
  const require = createRequire(new URL('../desktop/ui-api/package.json', import.meta.url)), desktopRequire = createRequire(new URL('../desktop/package.json', import.meta.url));
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const code = extract(software, 'function FriendPresence(', '\nfunction ReviewDialog');
  const transformed = await desktopRequire('esbuild').transform(code, { loader: 'jsx', jsx: 'transform' });
  const Button = ({ children, size, variant, ...props }) => React.createElement('button', props, children);
  const Presence = new Function('React', 'Button', `${transformed.code};return FriendPresence;`)(React, Button);
  const html = renderToStaticMarkup(React.createElement(Presence, { connected: true, presence: { online: true, status: 'watching', label: '后端核对：正在看视频', reason: '合成心跳新鲜且所有许可已就绪' }, onOpen() {} }));
  assert.match(html, /后端核对：正在看视频/); assert.match(html, /合成心跳新鲜且所有许可已就绪/);
  const disconnected = renderToStaticMarkup(React.createElement(Presence, { connected: false, presence: { online: true, label: '不得显示的旧在线' }, onOpen() {} })); assert.doesNotMatch(disconnected, /不得显示的旧在线/); assert.match(disconnected, /状态待核实/);
  const attention = renderToStaticMarkup(React.createElement(Presence, { connected: true, presence: { online: false, status: 'attention', label: '回复未就绪', reason: '合成联系人等待人工核对' }, onOpen() {} })); assert.match(attention, /role="alert"/); assert.match(attention, /合成联系人等待人工核对/);
});
