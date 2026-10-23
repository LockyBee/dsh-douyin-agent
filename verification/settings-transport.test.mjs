import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindNativeSettingsRoutes, createSettingsFetchHandler, createSettingsRpcHandler } from '../native-settings-transport.mjs';
import { createNativeSettingsRoute } from '../native-settings.mjs';

const sdk = process.env.DSH_NODE_MODULES || 'F:/codex/DSH Desktop 2/resources/app/node_modules';
const [{ Context }, { WebServer }, connectionModule] = await Promise.all([
  import(pathToFileURL(path.join(sdk, '@deepseek-ai/cordis/lib/index.js')).href),
  import(pathToFileURL(path.join(sdk, '@deepseek-ai/dsh-host-webserver/lib/index.js')).href),
  import(pathToFileURL(path.join(sdk, '@deepseek-ai/dsh-client-connection/lib/index.js')).href),
]);

async function fixture(t, web = true) {
  const ctx = new Context(), settings = { minutes: 10, writes: 0 };
  t.after(async () => { await ctx.fiber.dispose(); });
  const records = new Map();
  ctx.provide('credentials', { async modifyRecord(key, callback) { const next = await callback(records.get(key)); if (next !== undefined) records.set(key, next); return records.get(key); } });
  if (web) await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await();
  if (web) await ctx.plugin(connectionModule).await();
  else new connectionModule.HostConnectionService(ctx, [], {});
  const state = () => ({}), service = () => ({ state });
  const route = createNativeSettingsRoute({
    getController: async () => ({ limits: () => ({ state, savePolicy(input) { settings.writes++; settings.minutes = input.sessionMinutes; return { saved: true }; } }), getPersonaMemory: () => ({ snapshot: state }) }),
    getSpark: service, getComments: service, getReport: service, getMode: service, getWatch: service, modelSettings: { state },
  });
  const binding = bindNativeSettingsRoutes(ctx, () => route); await binding.ready();
  t.after(async () => { await binding.dispose(); await ctx.fiber.dispose(); });
  return { ctx, route, binding, settings };
}

test('真实 Connection 在没有 WebServer 时仍能读取和保存设置，保留令牌与卸载行为', { timeout: 15_000 }, async t => {
  const f = await fixture(t, false), connection = f.ctx.get('connection');
  const carrier = connection.createSharedFetchHandler('/api');
  const request = (route, input, token) => carrier.fetch(new Request('http://127.0.0.1/api/douyin-browser' + route, { ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }), headers: { 'content-type': 'application/json', ...(token ? { 'x-douyin-settings-token': token } : {}) } }), connection.browserPeer ?? connection.operator);
  const state = await (await request('/state')).json(); assert.ok(state.token);
  assert.equal((await request('/video/configure', { sessionMinutes: 7 })).status, 403); assert.equal(f.settings.writes, 0);
  assert.equal((await request('/video/configure', { sessionMinutes: 7 }, state.token)).status, 200); assert.equal(f.settings.minutes, 7);
  await f.binding.dispose(); assert.equal((await request('/state')).status, 404);
});

test('真实 WebServer 与 Connection RPC 完整往返，未认证调用被拒绝，不依赖独立控制台', { timeout: 15_000 }, async t => {
  const f = await fixture(t), connection = f.ctx.get('connection'), server = f.ctx.get('webServer');
  const base = `http://127.0.0.1:${server.port}`;
  const unregister = server.register({ kind: 'exact', path: '/', handler(req, res) { if (connection.authorizeIndex(req, res)) { res.writeHead(200); res.end('测试宿主'); } } });
  t.after(unregister);
  const auth = await fetch(connection.authenticatedUrl(base), { redirect: 'manual' });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const call = async (payload, authenticated = true) => {
    const response = await fetch(base + '/douyin-settings/request', { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { cookie } : {}) }, body: JSON.stringify({ type: 'client-request', rpcId: 'synthetic-id', method: 'request', payload }) });
    return response.status === 200 ? (await response.json()).result.value : { status: response.status };
  };
  assert.equal((await call({ path: '/state' }, false)).status, 401);
  const initial = await call({ path: '/state' }); assert.equal(initial.status, 200);
  assert.equal((await call({ path: '/video/configure', input: { sessionMinutes: 8 }, token: initial.body.token })).status, 200);
  assert.equal(f.settings.minutes, 8);
});

test('桥接拒绝跨源、非所有者、未知接口和超长输入，预先取消不执行操作', { timeout: 15_000 }, async t => {
  const f = await fixture(t, false), rpc = createSettingsRpcHandler(f.route), fetcher = createSettingsFetchHandler(f.route);
  assert.equal((await rpc('request', { path: '/state' }, undefined, { principal: { kind: 'guest' } })).value.status, 403);
  assert.equal((await rpc('request', { path: '//evil/state' })).value.status, 400);
  assert.equal((await rpc('request', { path: '/video/configure', input: { value: 'x'.repeat(270000) } })).value.status, 413);
  assert.equal((await fetcher(new Request('dsh://app/api/douyin-browser/state', { headers: { origin: 'https://evil.example' } }))).status, 403);
  assert.equal((await fetcher(new Request('dsh://app/api/douyin-browser/state'))).status, 200);
  await assert.rejects(rpc('request', { path: '/state' }, AbortSignal.abort()), /abort/i);
  assert.equal(f.settings.writes, 0);
});
