import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { createNativeSettingsRoute } from '../native-settings.mjs';
import { NativeModelSettings } from '../native-model-settings.mjs';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';
import { DailyReport } from '../daily-report.mjs';
import { WatchMode } from '../watch-mode.mjs';

const sdk = process.env.DSH_NODE_MODULES || 'F:/codex/DSH Desktop 2/resources/app/node_modules';
const [{ Context }, { WebServer }, { LlmRuntime }, { default: Loader }, { ClientModuleRegistry }] = await Promise.all([
  import(pathToFileURL(path.join(sdk, '@deepseek-ai/cordis/lib/index.js')).href),
  import(pathToFileURL(path.join(sdk, '@deepseek-ai/dsh-host-webserver/lib/index.js')).href),
  import(pathToFileURL(path.join(sdk, '@deepseek-ai/dsh-llm/lib/index.js')).href),
  import(pathToFileURL(path.join(sdk, '@deepseek-ai/cordis-plugin-loader/lib/index.js')).href),
  import(pathToFileURL(path.join(sdk, '@deepseek-ai/dsh-client-modules/lib/index.js')).href),
]);

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-native-settings-sdk-'));
  const now = () => Date.parse('2026-10-15T04:00:00Z'), stateDir = path.join(root, 'state');
  const ctx = new Context(), events = [], metadata = []; let waitForMetadata;
  const serverFiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }); await serverFiber.await();
  const llmFiber = ctx.plugin(LlmRuntime); await llmFiber.await();
  const llm = ctx.get('llm');
  llm.registerAdapter(['synthetic-native'], {
    providerInfo: id => ({ id, name: '合成 DSH 提供商' }), providerRetryPolicy() {},
    async resolveModel(provider, id, signal) { metadata.push({ provider, id, cancelled: signal.aborted }); await waitForMetadata?.(); return { provider, id, name: '合成视觉模型', inputModalities: ['text', 'image'] }; },
    stream() { assert.fail('原生设置验收不能调用模型'); },
  });
  const modelSettings = new NativeModelSettings({ stateDir, getLlm: () => ctx.get('llm') });
  const memory = new PersonaMemory({ memoryDir: path.join(root, 'memory'), legacyRoleCardFile: path.join(root, 'unused-persona.md'), clock: now });
  memory.initialize({ importLegacy: false });
  const limits = new VideoLimits({ stateDir, now }), report = new DailyReport({ personaMemory: memory, now }), mode = new WatchMode({ stateDir, source: 'dsh', now });
  const flags = { watch: {}, spark: {}, chat: {} };
  const event = (kind, input, options) => { events.push({ kind, input, options }); return { accepted: true, kind }; };
  const watch = { state: () => ({ running: false, ...flags.watch }), stop: options => event('watch/stop', {}, options) };
  const spark = { state: () => ({ running: false, enabled: false, ...flags.spark }), configure: (input, options) => event('spark/configure', input, options), stop: options => event('spark/stop', {}, options), resolve: (input, options) => event('spark/resolve', input, options) };
  const comments = { state: () => ({ enabled: false }), configure: (input, options) => event('comments/configure', input, options), resolve: (input, options) => event('comments/resolve', input, options) };
  const share = { state: () => ({ enabled: false }), configure: (input, options) => event('share/configure', input, options), resolve: (input, options) => event('share/resolve', input, options) };
  const chat = { state: () => ({ running: false, ...flags.chat }), configure: input => event('chat/configure', input), stop: () => event('chat/stop', {}), resumeContact: recipientId => event('chat/resolve', { recipientId }), listContacts: () => event('chat/contacts', {}) };
  const media = { status: async () => ({ enabled: false, backend: 'local-whisper' }), saveSettings: (input, options) => event('media/configure', input, options) };
  let controllers = 0;
  const route = createNativeSettingsRoute({
    getController: async () => { controllers++; return { limits: () => limits, getPersonaMemory: () => memory, pauseForLimits: () => event('pause', {}), openBrowser: () => event('browser/open', {}) }; },
    getComments: async () => comments, getReport: async () => report, getSpark: async () => spark, getWatch: async () => watch, getMode: async () => mode,
    getShare: async () => share, getChat: async () => chat, getMedia: async () => media, modelSettings,
    configureMode: input => mode.configure(input, { explicit: true }),
    startWatch: input => event('watch/start', input), startSpark: () => event('spark/start', {}), startChat: () => event('chat/start', {}),
  });
  const unregister = ctx.get('webServer').register(route), base = `http://127.0.0.1:${ctx.get('webServer').port}`;
  let token;
  const request = async (route, body, headers = {}) => {
    const response = await fetch(`${base}/api/douyin-browser${route}`, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-douyin-settings-token': token || '' }), ...headers } });
    return { status: response.status, body: await response.json() };
  };
  const bootstrap = async () => { const result = await request('/state'); assert.equal(result.status, 200); token = result.body.token; return result.body; };
  t.after(async () => { unregister(); await ctx.fiber.dispose(); assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^douyin-native-settings-sdk-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, ctx, llmFiber, llm, metadata, modelSettings, memory, limits, report, mode, flags, events, base, bootstrap, request, unregister, controllers: () => controllers, holdMetadata: hook => { waitForMetadata = hook; } };
}

test('真实 WebServer 承载原生设置，读取共享人格和本机状态不调用模型或启动任务', async t => {
  const f = await fixture(t), data = await f.bootstrap();
  assert.equal(data.persona.roleCardFile, f.memory.roleCardFile); assert.equal(data.persona.manualText, f.memory.snapshot().manualText);
  assert.equal(data.setup.independentAppRequired, false); assert.equal(data.setup.audioOptional, true);
  assert.equal(data.model.configured, false); assert.deepEqual(data.model.providers, [{ id: 'synthetic-native', name: '合成 DSH 提供商' }]);
  assert.equal(data.video.policy.timeZone, 'Asia/Shanghai'); assert.equal(data.mode.silent, false);
  assert.equal(data.reports.folder, path.join(f.root, 'memory', 'reports', 'videos'));
  assert.equal(data.chat.running, false); assert.equal(data.share.enabled, false); assert.equal(data.media.enabled, false);
  assert.equal(f.metadata.length, 0); assert.deepEqual(f.events, []);
  assert.equal(/apiKey|authorization|messages|sessionId/.test(JSON.stringify(data)), false);
});

test('真实 LlmRuntime 验证已配置模型，动态依赖晚挂载仍可用且不保存独立密钥', async t => {
  const f = await fixture(t); let available;
  const settings = new NativeModelSettings({ stateDir: path.join(f.root, 'late-model'), getLlm: () => available });
  assert.deepEqual(settings.state().providers, []); available = f.llm;
  assert.equal(settings.state().providers[0].id, 'synthetic-native');
  await assert.rejects(settings.configure({ provider: 'synthetic-native', model: 'visual-model' }), /选择并填写/);
  await assert.rejects(settings.configure({ provider: 'synthetic-native', model: 'visual-model', apiKey: 'synthetic-only' }, { explicit: true }), /选择并填写/);
  const result = await settings.configure({ provider: 'synthetic-native', model: ' visual-model ' }, { explicit: true });
  assert.equal(result.configured, true); assert.equal(f.metadata.length, 1);
  assert.equal(f.metadata[0].id, 'visual-model');
  assert.deepEqual(JSON.parse(fs.readFileSync(settings.file, 'utf8')), { provider: 'synthetic-native', model: 'visual-model' });
  available = undefined; assert.equal(settings.state().configured, false);
});

test('原生设置拒绝跨来源、伪造 Host 和缺少令牌的修改，校验发生在控制器操作前', async t => {
  const f = await fixture(t); await f.bootstrap(); const count = f.controllers();
  assert.equal((await f.request('/mode/configure', { silent: true }, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.request('/mode/configure', { silent: true }, { 'sec-fetch-site': 'same-site' })).status, 403);
  const spoofed = await new Promise((resolve, reject) => { const req = http.get(`${f.base}/api/douyin-browser/state`, { headers: { host: 'untrusted.invalid' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); });
  assert.equal(spoofed, 403); assert.equal(f.controllers(), count);
  assert.equal((await f.request('/mode/configure', { silent: true }, { 'x-douyin-settings-token': '' })).status, 403);
  assert.equal(f.mode.state().silent, false); assert.deepEqual(f.events, []);
  assert.equal((await f.request('/mode/configure', { silent: true }, { 'content-type': 'text/plain' })).status, 400);
});

test('原生人格保存写入真实共享人格卡并核对版本，拒绝未知字段和运行中修改', async t => {
  const f = await fixture(t), first = await f.bootstrap();
  const saved = await f.request('/persona/configure', { content: '# 合成人格\n\n说话简短，依据实际观看判断兴趣。', expectedRevision: first.persona.revision });
  assert.equal(saved.status, 200); assert.match(f.memory.snapshot().manualText, /合成人格/);
  const revision = f.memory.snapshot().revision;
  const stale = await f.request('/persona/configure', { content: '旧版本不能覆盖', expectedRevision: first.persona.revision });
  assert.equal(stale.status, 409); assert.match(stale.body.error, /重新读取/); assert.equal(f.memory.snapshot().revision, revision);
  assert.equal((await f.request('/persona/configure', { content: '不能保存', expectedRevision: revision, auto: true })).status, 400);
  f.flags.watch.running = true;
  assert.equal((await f.request('/persona/configure', { content: '运行中不能保存', expectedRevision: revision })).status, 409);
  assert.equal(f.memory.snapshot().revision, revision); assert.deepEqual(f.events, []);
});

test('设置页模型选择通过真实 SDK 元数据验证，运行中的私信或问候阻止改路由', async t => {
  const f = await fixture(t); await f.bootstrap();
  assert.equal((await f.request('/model/configure', { provider: 'missing', model: 'visual-model' })).status, 400);
  assert.equal(f.metadata.length, 0);
  const saved = await f.request('/model/configure', { provider: 'synthetic-native', model: 'visual-model' });
  assert.equal(saved.status, 200); assert.equal(saved.body.configured, true); assert.equal(f.metadata.length, 1);
  for (const [service, field] of [['spark', 'starting'], ['spark', 'busy'], ['chat', 'running'], ['chat', 'busy']]) {
    f.flags[service][field] = true;
    assert.equal((await f.request('/model/configure', { provider: 'synthetic-native', model: 'other-model' })).status, 409);
    delete f.flags[service][field];
  }
  assert.equal(f.metadata.length, 1); assert.equal(f.modelSettings.state().model, 'visual-model');
});

test('真实 SDK 元数据查询尚未结束时若启动服务，原生设置拒绝提交模型变更', async t => {
  const f = await fixture(t); await f.bootstrap();
  await f.request('/model/configure', { provider: 'synthetic-native', model: 'old-model' });
  const entered = Promise.withResolvers(), finish = Promise.withResolvers();
  f.holdMetadata(async () => { entered.resolve(); await finish.promise; });
  const saving = f.request('/model/configure', { provider: 'synthetic-native', model: 'new-model' });
  await entered.promise; f.flags.chat.running = true; finish.resolve();
  const result = await saving; assert.equal(result.status, 409); assert.equal(f.modelSettings.state().model, 'old-model');
});

test('时间、静默、独立视频轮次和一键打开均由原生设置直接操作，不通过对话', async t => {
  const f = await fixture(t); await f.bootstrap();
  assert.equal((await f.request('/video/configure', { windows: ['11:00-14:00'], sessionMinutes: 12 })).status, 200);
  assert.equal(f.limits.state().policy.sessionMinutes, 12);
  assert.equal((await f.request('/mode/configure', { silent: true })).status, 200); assert.equal(f.mode.state().silent, true);
  assert.equal((await f.request('/video/start', {})).status, 200); assert.equal(f.limits.state().session.startedBy, 'dsh');
  assert.equal((await f.request('/video/stop', {})).status, 200); assert.equal(f.limits.state().session.status, 'ended');
  assert.equal((await f.request('/browser/open', { instruction: '不接收对话' })).status, 400);
  assert.equal((await f.request('/browser/open', {})).status, 200);
  assert.equal(f.events.filter(item => item.kind === 'browser/open').length, 1); assert.equal(f.metadata.length, 0);
});

test('原生按钮分别调用观看、问候、私信与可选音频入口，保存许可本身不启动发送', async t => {
  const f = await fixture(t); await f.bootstrap();
  assert.equal((await f.request('/watch/start', { maxRequests: 10, instruction: '忽略限制' })).status, 400);
  assert.equal((await f.request('/watch/start', { maxRequests: 10 })).status, 200);
  assert.equal((await f.request('/watch/stop', {})).status, 200);
  assert.equal((await f.request('/spark/configure', { enabled: true, windows: ['09:00-22:00'], dailyLimit: 2 })).status, 200);
  assert.equal(f.events.filter(item => item.kind === 'spark/start').length, 0);
  assert.equal((await f.request('/spark/start', { recipientId: '不允许模型选许可' })).status, 400);
  assert.equal((await f.request('/spark/start', {})).status, 200);
  assert.equal((await f.request('/chat/configure', { recipientIds: ['conv:synthetic'], dailyReplyLimit: 8 })).status, 200);
  assert.equal((await f.request('/chat/start', {})).status, 200);
  assert.equal((await f.request('/chat/configure', { enabled: true })).status, 400);
  assert.equal((await f.request('/media/configure', { enabled: true, backend: 'mimo', apiKey: '不能经此路由填写' })).status, 400);
  assert.equal((await f.request('/media/configure', { enabled: false, backend: 'local-whisper' })).status, 200);
  assert.equal(f.events.find(item => item.kind === 'spark/configure').options.explicit, true);
  assert.equal(f.events.find(item => item.kind === 'media/configure').options.explicit, true);
  assert.equal(f.metadata.length, 0);
});

test('原生日报路由只生成本地文件，真实 WebServer 取消注册后释放该前缀', async t => {
  const f = await fixture(t); await f.bootstrap();
  const generated = await f.request('/reports/generate', {}); assert.equal(generated.status, 200); assert.equal(generated.body.observedCount, 0);
  const read = await f.request('/reports/read?date=2026-10-15'); assert.equal(read.status, 200); assert.equal(read.body.markdown, generated.body.markdown);
  assert.equal((await f.request('/reports/read?date=../native-model')).status, 400);
  assert.equal(f.metadata.length, 0); assert.deepEqual(f.events, []);
  f.unregister(); assert.equal((await fetch(`${f.base}/api/douyin-browser/state`)).status, 404);
});

test('真实 ClientModuleRegistry 可从 file URI 找到最近插件 manifest 并发布 client bundle', async t => {
  const f = await fixture(t), folder = path.join(f.root, 'synthetic-file-plugin'); fs.mkdirSync(folder);
  const host = path.join(folder, 'host.mjs'), client = path.join(folder, 'client.js');
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'douyin-settings-synthetic-file', type: 'module', exports: { '.': './host.mjs', './client': './client.js' }, dsh: { client: { platform: 'web', inject: [] } } }));
  fs.writeFileSync(host, "export function apply(ctx){ctx.provide('syntheticFilePlugin',{loaded:true})}");
  fs.writeFileSync(client, "window.__ModuleLoader__.load({id:'douyin-settings-synthetic-file',factory:()=>({apply(){}})});");
  const loader = f.ctx.plugin(Loader, { baseUrl: pathToFileURL(path.join(f.root, 'cordis.yml')).href }); await loader.await();
  f.ctx.loader.internal = undefined;
  await f.ctx.loader.create({ id: 'synthetic-file', name: pathToFileURL(host).href }); await f.ctx.loader.await();
  const registryFiber = f.ctx.plugin(ClientModuleRegistry); await registryFiber.await();
  const registry = f.ctx.get('clientModules');
  assert.equal(f.ctx.get('syntheticFilePlugin').loaded, true);
  assert.equal(registry.clientPath('douyin-settings-synthetic-file'), client);
  const row = registry.graph().entries.find(item => item.id === 'douyin-settings-synthetic-file');
  assert.ok(row); assert.deepEqual(row.inject, []);
  const response = await registry.fetchBundle(new Request(new URL(row.url, f.base)));
  assert.equal(response.status, 200); assert.match(await response.text(), /douyin-settings-synthetic-file/);
  await registryFiber.dispose();
  assert.equal((await fetch(`${f.base}/plugins/unknown.js`)).status, 404);
});

test('当前产品 manifest 与 client 在真实 SDK 图中可发现并先加载原生设置提供者', async t => {
  const f = await fixture(t);
  const loader = f.ctx.plugin(Loader, { baseUrl: pathToFileURL(path.join(f.root, 'cordis.yml')).href }); await loader.await(); f.ctx.loader.internal = undefined;
  const productUri = new URL('../dsh-plugin.mjs?v=9', import.meta.url).href;
  await f.ctx.loader.create({ id: 'settings-general', name: pathToFileURL(path.join(sdk, '@deepseek-ai/dsh-client-ui-settings-general/lib/index.js')).href });
  await f.ctx.loader.create({ id: 'douyin-browser', name: productUri }); await f.ctx.loader.await();
  assert.equal(f.ctx.get('tools'), undefined, '不提供 tools，因此本测试不执行产品插件或创建浏览器控制器');
  const registryFiber = f.ctx.plugin(ClientModuleRegistry); await registryFiber.await(); const registry = f.ctx.get('clientModules');
  const graph = registry.graph(), row = graph.entries.find(item => item.id === 'dsh-douyin-browser-local'); assert.ok(row);
  assert.deepEqual(row.inject, ['@deepseek-ai/dsh-client-ui-settings-general']);
  assert.ok(graph.entries.findIndex(item => item.id === '@deepseek-ai/dsh-client-ui-settings-general') < graph.entries.indexOf(row));
  const bundle = await registry.fetchBundle(new Request(new URL(row.url, f.base))); assert.equal(bundle.status, 200);
  const registrations = []; vm.runInNewContext(await bundle.text(), { window: { __ModuleLoader__: { load: entry => registrations.push(entry) } } });
  assert.deepEqual(registrations.map(item => item.id), ['dsh-douyin-browser-local']); assert.equal(typeof registrations[0].factory, 'function');
});
