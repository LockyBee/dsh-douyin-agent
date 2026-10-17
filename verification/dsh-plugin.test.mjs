import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TOOL_DEFINITIONS, validateToolArguments } from '../tool-definitions.mjs';
import { apply, createNativeToolDefinitions } from '../dsh-plugin.mjs';
import { BEGIN_MARKER, END_MARKER, managePlugin, planPatch } from '../plugin-install.mjs';
import { bindNativePersonaContext } from '../native-persona-context.mjs';

const dshModules = process.env.DSH_NODE_MODULES || 'F:/codex/DSH Desktop 2/resources/app/node_modules';
// 这里加载电脑上 DSH 正在使用的实现，不以自写 schema 校验器替代原生接口。
const [{ ToolRuntime, assertObjectJsonSchema, assertSupportedJsonSchema }, { Context }, { default: Loader }, { LocalAttachmentStore }, { default: sharp }, { DynamicCordisRunnerService }, { default: Include }, { SystemPrompt, renderContextSnapshot }] = await Promise.all([
  import(pathToFileURL(join(dshModules, '@deepseek-ai/dsh-tools/lib/index.js')).href),
  import(pathToFileURL(join(dshModules, '@deepseek-ai/cordis/lib/index.js')).href),
  import(pathToFileURL(join(dshModules, '@deepseek-ai/cordis-plugin-loader/lib/index.js')).href),
  import(pathToFileURL(join(dshModules, '@deepseek-ai/dsh-attachment-local/lib/index.js')).href),
  import(pathToFileURL(join(dshModules, 'sharp/dist/index.cjs')).href),
  import(pathToFileURL(join(dshModules, '@deepseek-ai/dsh-cordis-host-runner/lib/index.js')).href),
  import(pathToFileURL(join(dshModules, '@deepseek-ai/cordis-plugin-include/lib/index.js')).href),
  import(pathToFileURL(join(dshModules, '@deepseek-ai/dsh-system-prompt/lib/index.js')).href),
]);

function context() {
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools() { return () => {}; } });
  const runtime = new ToolRuntime(ctx);
  return { ctx, runtime };
}

function execution(name, args = {}, signal = new AbortController().signal) {
  return { name, arguments: args, signal, token: {}, callId: `验证-${name}` };
}

const inputs = { douyin_search: { query: '科普' }, douyin_open_video: { index: 0 }, douyin_observe: { seconds: 1 }, douyin_remember: { content: '喜欢清楚的解释。' }, douyin_recall: { query: '解释', limit: 2 },douyin_chat_read:{recipientId:'conv:synthetic'},douyin_chat_observe:{recipientId:'conv:synthetic',messageId:'msg:'+'a'.repeat(64)},douyin_forward_video:{recipientId:'conv:synthetic'}, douyin_interest_record:{evidenceId:'video:'+'b'.repeat(64),topic:'合成科普题材',signal:'like',reflection:'根据合成采样证据记录兴趣，不代表用户偏好。'} };
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPEkAAAAASUVORK5CYII=';

async function managedIncludeFixture({ version = '4', mode = 'complete' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'douyin-managed-include-'));
  const file = join(directory, 'plugin.mjs'), uri = pathToFileURL(file).href;
  const configFile = join(directory, 'plugins.json'), otherFile = join(directory, 'other-plugin.mjs');
  const { ctx, runtime } = context();
  const config = { marker: '保留原插件配置', nested: { enabled: true }, mode };
  await writeFile(file, `import {createNativeToolDefinitions} from ${JSON.stringify(new URL('../dsh-plugin.mjs?v=13', import.meta.url).href)};
export const name='douyin-managed-fixture';export const inject=['tools'];
export function apply(ctx,config={}){
  const version=new URL(import.meta.url).searchParams.get('v');
  const all=createNativeToolDefinitions({ctx,getController:async()=>{throw new Error('SDK临时测试禁止浏览器执行')}});
  const count=version==='13'?(config.mode==='incomplete'?all.length-1:all.length):${version.endsWith('-full') ? 'all.length' : version === '5' ? '22' : '17'};
  for(const tool of all.slice(0,count)){const off=ctx.tools.register(tool);ctx.effect(()=>off)}
  if(version==='13'&&config.mode==='throw')throw new Error('合成升级失败');
  ctx.provide('douyinManagedFixture',{version,config});
}`);
  await writeFile(otherFile, `export const name='unrelated-fixture';export function apply(ctx,config){ctx.provide('unrelatedManagedFixture',config)}`);
  const entries = [
    { id: 'douyin-browser', name: `${uri}?v=${version}`, disabled: false, config },
    { id: 'unrelated', name: pathToFileURL(otherFile).href, config: { marker: '其他插件配置' } },
  ];
  await writeFile(configFile, JSON.stringify(entries, null, 2));
  const fiber = ctx.plugin(Loader, { baseUrl: pathToFileURL(join(directory, 'cordis.yml')).href });
  await fiber.await(); ctx.loader.internal = undefined; ctx.loader.builtins.include = Include;
  await ctx.loader.create({ id: 'include', name: 'cordis:include', config: { path: pathToFileURL(configFile).href } });
  await ctx.loader.await();
  const entry = ctx.loader.resolve('include:douyin-browser'), unrelated = ctx.loader.resolve('include:unrelated');
  const originalFiber = entry.fiber, unrelatedFiber = unrelated.fiber;
  const runner = new DynamicCordisRunnerService(ctx, { vmTimeoutMs: 5000 });
  const agent = { id: '配置管理插件升级测试' };
  const run = async host => {
    const defined = runner.define({ sessionId: agent.id, plugin: { kind: 'new', idPrefix: 'douyin' }, name: '配置管理升级测试', purpose: '仅在SDK临时目录核对include条目的生命周期。', code: { host } });
    const result = await runner.run(agent, defined.pluginId, defined.packageId, 'run', new AbortController().signal);
    return { defined, result };
  };
  return { ctx, runtime, runner, agent, uri, entry, unrelated, originalFiber, unrelatedFiber, config, entries, configFile, run,
    async helper() { return (await readFile(new URL('../plugin-hotload.js', import.meta.url), 'utf8')).replaceAll('file:///D:/codex%E5%88%86%E5%B1%80/dsh%E9%85%8D%E7%BD%AE/douyin-browser/dsh-plugin.mjs', uri); },
    async persisted() { await ctx.loader.resolve('include').subtree.flushWrite(); return JSON.parse(await readFile(configFile, 'utf8')); },
    async close() { await ctx.fiber.dispose(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /douyin-managed-include-[^\\/]+$/); await rm(directory, { recursive: true, force: true }); },
  };
}

test('真实SDK复现：旧式include移除再新建留下失败条目，Loader.await不能代替完整性验收', async () => {
  const fixture = await managedIncludeFixture();
  try {
    assert.equal(fixture.runtime.schemas().length, 17);
    const legacy = `return {name:'legacy-remove-create',inject:['loader','tools'],async apply(ctx){await ctx.loader.remove('include:douyin-browser');await ctx.loader.create({name:${JSON.stringify(`${fixture.uri}?v=13`)}});await ctx.loader.await()}};`;
    const { result } = await fixture.run(legacy);
    assert.equal(result.ok, true, JSON.stringify(result));
    const failed = [...fixture.ctx.loader.entries()].find(entry => entry.options.name === `${fixture.uri}?v=13`);
    assert.equal(Boolean(failed), true);
    assert.equal(failed.fiber.state, 3, '重复注册使新条目失败，Loader.await只等任务收敛，不向辅助包上抛该错误');
    assert.equal(fixture.ctx.loader.resolve('include:douyin-browser'), fixture.entry);
    assert.equal(fixture.entry.fiber, fixture.originalFiber);
    assert.equal(fixture.runtime.schemas().length, 17);
    assert.equal(fixture.unrelated.fiber, fixture.unrelatedFiber);
  } finally { await fixture.close(); }
});

test('真实SDK复现：Loader仅更新name元数据时旧fiber和17工具仍在', async () => {
  const fixture = await managedIncludeFixture();
  try {
    await fixture.ctx.loader.update(fixture.entry.id, { name: `${fixture.uri}?v=13` });
    await fixture.ctx.loader.await();
    assert.equal(fixture.entry.options.name, `${fixture.uri}?v=13`);
    assert.equal(fixture.entry.fiber, fixture.originalFiber);
    assert.equal(fixture.ctx.get('douyinManagedFixture').version, '4');
    assert.equal(fixture.runtime.schemas().length, 17);
  } finally { await fixture.close(); }
});

test('旧版完整32工具被误标为v13时仍核对实际入口函数，真实重载后重复运行不再重启', async () => {
  for (const version of ['4-full', '7-full']) {
    const fixture = await managedIncludeFixture({ version });
    try {
      const previousCallback = fixture.entry.fiber.runtime.callback;
      await fixture.ctx.loader.update(fixture.entry.id, { name: `${fixture.uri}?v=13` });
      await fixture.ctx.loader.await();
      assert.equal(fixture.runtime.schemas().length, TOOL_DEFINITIONS.length);
      assert.equal(fixture.entry.fiber, fixture.originalFiber);
      assert.equal(fixture.ctx.get('douyinManagedFixture').version, version);
      const first = await fixture.run(await fixture.helper());
      assert.equal(first.result.ok, true, JSON.stringify(first.result));
      assert.equal(fixture.entry.options.name, `${fixture.uri}?v=13`);
      assert.notEqual(fixture.entry.fiber, fixture.originalFiber);
      assert.notEqual(fixture.entry.fiber.runtime.callback, previousCallback);
      assert.equal(fixture.ctx.get('douyinManagedFixture').version, '13');
      assert.equal(fixture.runtime.schemas().length, TOOL_DEFINITIONS.length);
      const upgradedFiber = fixture.entry.fiber;
      const second = await fixture.run(await fixture.helper());
      assert.equal(second.result.ok, true, JSON.stringify(second.result));
      assert.equal(fixture.entry.fiber, upgradedFiber);
      await fixture.runner.undefine(fixture.agent, first.defined.pluginId);
      await fixture.runner.undefine(fixture.agent, second.defined.pluginId);
      assert.equal(fixture.ctx.loader.resolve('include:douyin-browser'), fixture.entry);
      assert.equal(fixture.unrelated.fiber, fixture.unrelatedFiber);
    } finally { await fixture.close(); }
  }
});

test('真实纯host沙箱受控重启原include条目，停止辅助包仍保留完整工具与其他配置', async () => {
  const fixture = await managedIncludeFixture();
  try {
    const before = structuredClone(fixture.entry.options);
    const { result, defined } = await fixture.run(await fixture.helper());
    assert.equal(result.ok, true, JSON.stringify(result));
    await fixture.ctx.loader.await();
    assert.equal(fixture.ctx.loader.resolve('include:douyin-browser'), fixture.entry);
    assert.notEqual(fixture.entry.fiber, fixture.originalFiber);
    assert.equal(fixture.entry.options.name, `${fixture.uri}?v=13`);
    assert.deepEqual({ ...fixture.entry.options, name: before.name }, before);
    assert.equal(fixture.runtime.schemas().length, TOOL_DEFINITIONS.length);
    assert.equal(fixture.ctx.get('douyinManagedFixture').version, '13');
    assert.deepEqual(fixture.ctx.get('douyinManagedFixture').config, fixture.config);
    assert.equal(fixture.unrelated.fiber, fixture.unrelatedFiber);
    const persisted = await fixture.persisted();
    assert.deepEqual(persisted.map(entry => entry.id), ['douyin-browser', 'unrelated']);
    assert.deepEqual(persisted[0], { ...fixture.entries[0], name: `${fixture.uri}?v=13` });
    assert.deepEqual(persisted[1], fixture.entries[1]);
    const stopped = await fixture.runner.undefine(fixture.agent, defined.pluginId);
    assert.equal(stopped.ok, true);
    assert.equal(fixture.ctx.loader.resolve('include:douyin-browser'), fixture.entry);
    assert.equal(fixture.runtime.schemas().length, TOOL_DEFINITIONS.length);
    assert.equal(fixture.unrelated.fiber, fixture.unrelatedFiber);
  } finally { await fixture.close(); }
});

test('已有完整目录或v5旧22工具仍核对自有entry版本，升级到v13且重复运行不重启', async () => {
  for (const version of ['4-full', '5']) {
  const fixture = await managedIncludeFixture({ version });
  try {
    assert.equal(fixture.runtime.schemas().length, version === '5' ? 22 : TOOL_DEFINITIONS.length);
    const first = await fixture.run(await fixture.helper());
    assert.equal(first.result.ok, true, JSON.stringify(first.result));
    assert.equal(fixture.entry.options.name, `${fixture.uri}?v=13`);
    assert.notEqual(fixture.entry.fiber, fixture.originalFiber);
    const upgradedFiber = fixture.entry.fiber;
    const second = await fixture.run(await fixture.helper());
    assert.equal(second.result.ok, true, JSON.stringify(second.result));
    assert.equal(fixture.entry.fiber, upgradedFiber);
    await fixture.runner.undefine(fixture.agent, first.defined.pluginId);
    await fixture.runner.undefine(fixture.agent, second.defined.pluginId);
    assert.equal(fixture.runtime.schemas().length, TOOL_DEFINITIONS.length);
  } finally { await fixture.close(); }
  }
});

test('原位升级的应用失败或工具目录不完整时回滚原include条目和配置', async () => {
  for (const mode of ['throw', 'incomplete']) {
    const fixture = await managedIncludeFixture({ mode });
    try {
      const before = structuredClone(fixture.entry.options);
      const { result } = await fixture.run(await fixture.helper());
      assert.equal(result.ok, false, JSON.stringify(result));
      await fixture.ctx.loader.await();
      assert.equal(fixture.ctx.loader.resolve('include:douyin-browser'), fixture.entry);
      assert.deepEqual(fixture.entry.options, before);
      assert.equal(fixture.runtime.schemas().length, 17);
      assert.equal(fixture.entry.fiber.runtime.callback, fixture.originalFiber.runtime.callback);
      assert.equal(fixture.ctx.get('douyinManagedFixture').version, '4');
      assert.deepEqual(fixture.ctx.get('douyinManagedFixture').config, fixture.config);
      assert.equal(fixture.unrelated.fiber, fixture.unrelatedFiber);
      assert.deepEqual(await fixture.persisted(), fixture.entries);
    } finally { await fixture.close(); }
  }
});

test('工具名齐全但来源不是目标entry，或自有entry不唯一时拒绝加载', async () => {
  const foreign = await managedIncludeFixture({ version: '13' });
  try {
    const body = (await foreign.helper()).replaceAll(foreign.uri, foreign.uri.replace('plugin.mjs', 'different-plugin.mjs'));
    const { result } = await foreign.run(body);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(foreign.entry.fiber, foreign.originalFiber);
    assert.equal(foreign.runtime.schemas().length, TOOL_DEFINITIONS.length);
  } finally { await foreign.close(); }
  const ambiguous = await managedIncludeFixture();
  try {
    await ambiguous.ctx.loader.create({ id: 'shadow', name: `${ambiguous.uri}?v=4`, disabled: true });
    const { result } = await ambiguous.run(await ambiguous.helper());
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(ambiguous.entry.fiber, ambiguous.originalFiber);
    assert.equal(ambiguous.runtime.schemas().length, 17);
    assert.equal(ambiguous.ctx.loader.resolve('shadow').options.disabled, true);
  } finally { await ambiguous.close(); }
});

test('停用或等待注入依赖的自有v8条目，不因外部完整工具齐全而被误报为活动插件', async () => {
  for (const inactive of ['disabled', 'waiting']) {
    const fixture = await managedIncludeFixture({ version: '8' });
    const disposers = [];
    try {
      const originalFiber = fixture.entry.fiber;
      await fixture.ctx.loader.update('include:douyin-browser', { disabled: true });
      await originalFiber.dispose();
      if (inactive === 'waiting') {
        await fixture.ctx.loader.update('include:douyin-browser', { inject: ['missing-verification-service'], disabled: false });
        await fixture.ctx.loader.await();
      }
      if (inactive === 'disabled') {
        assert.equal(fixture.entry.disabled, true);
        assert.equal(fixture.entry.fiber?.state === 2, false);
      }
      else { assert.equal(fixture.entry.fiber.state, 0); assert.equal(Boolean(fixture.entry.fiber.uid), true); }
      const before = structuredClone(fixture.entry.options), parkedFiber = fixture.entry.fiber;
      const external = createNativeToolDefinitions({ ctx: fixture.ctx, getController: async () => { throw new Error('禁止浏览器执行'); } });
      for (const tool of external) disposers.push(fixture.runtime.register(tool));
      assert.equal(fixture.runtime.schemas().length, TOOL_DEFINITIONS.length);
      const { result } = await fixture.run(await fixture.helper());
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.deepEqual(fixture.entry.options, before);
      assert.equal(fixture.entry.fiber, parkedFiber);
      assert.equal(fixture.runtime.schemas().length, TOOL_DEFINITIONS.length);
      assert.equal(fixture.unrelated.fiber, fixture.unrelatedFiber);
    } finally { for (const dispose of disposers) dispose(); await fixture.close(); }
  }
});

test('新建条目的清理不删除同ID替换、原位改名的其他插件，条目已移除时保持幂等', async () => {
  for (const replacement of ['replace', 'rename', 'removed']) {
    const directory = await mkdtemp(join(tmpdir(), 'douyin-cleanup-owner-'));
    const file = join(directory, 'plugin.mjs'), uri = pathToFileURL(file).href;
    await writeFile(file, `export{default,name,inject,apply}from${JSON.stringify(new URL('../dsh-plugin.mjs?v=13', import.meta.url).href)};`);
    const { ctx, runtime } = context();
    const fiber = ctx.plugin(Loader, { baseUrl: pathToFileURL(join(directory, 'cordis.yml')).href });
    await fiber.await(); ctx.loader.internal = undefined;
    ctx.loader.builtins.unrelated = { name: 'cleanup-unrelated-fixture', apply(ctx) { ctx.provide('cleanupUnrelatedFixture', '保留其他插件'); } };
    const runner = new DynamicCordisRunnerService(ctx, { vmTimeoutMs: 5000 }), agent = { id: '条目清理归属测试' };
    try {
      const host = (await readFile(new URL('../plugin-hotload.js', import.meta.url), 'utf8')).replaceAll('file:///D:/codex%E5%88%86%E5%B1%80/dsh%E9%85%8D%E7%BD%AE/douyin-browser/dsh-plugin.mjs', uri);
      const defined = runner.define({ sessionId: agent.id, plugin: { kind: 'new', idPrefix: 'douyin' }, name: '清理归属测试', purpose: '核对停止辅助包不会删除其他插件。', code: { host } });
      const result = await runner.run(agent, defined.pluginId, defined.packageId, 'run', new AbortController().signal);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(runtime.schemas().length, TOOL_DEFINITIONS.length);
      const entry = [...ctx.loader.entries()].find(entry => entry.options.name === `${uri}?v=13`), id = entry.id;
      const originalFiber = entry.fiber;
      if (replacement === 'rename') {
        await ctx.loader.update(id, { disabled: true });
        await originalFiber.dispose();
        await entry.update({ name: 'cordis:unrelated' });
        await ctx.loader.update(id, { disabled: false });
        await ctx.loader.await();
      }
      else {
        await ctx.loader.remove(id);
        await originalFiber.dispose();
        if (replacement === 'replace') await ctx.loader.create({ id, name: 'cordis:unrelated' });
      }
      const replacementEntry = replacement === 'removed' ? null : ctx.loader.resolve(id);
      const stopped = await runner.undefine(agent, defined.pluginId);
      assert.equal(stopped.ok, true);
      assert.equal(runtime.schemas().length, 0);
      if (replacementEntry) {
        assert.equal(ctx.loader.resolve(id), replacementEntry);
        assert.equal(replacementEntry.options.name, 'cordis:unrelated');
        assert.equal(ctx.get('cleanupUnrelatedFixture'), '保留其他插件');
      } else assert.throws(() => ctx.loader.resolve(id), /cannot resolve/);
    } finally {
      await ctx.fiber.dispose(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /douyin-cleanup-owner-[^\\/]+$/); await rm(directory, { recursive: true, force: true });
    }
  }
});

test('完整工具目录使用真实 DSH schema、注册表和执行管线', async () => {
  const { ctx, runtime } = context();
  const calls = [];
  const definitions = createNativeToolDefinitions({ ctx, getController: async () => ({ execute: async (name, args, options) => { calls.push({ name, args, options }); return { ok: true, state: { name, sample: true } }; } }) });
  assert.equal(definitions.length, TOOL_DEFINITIONS.length);
  assert.equal(new Set(definitions.map((item) => item.name)).size, TOOL_DEFINITIONS.length);
  const disposers = [];
  try {
    for (const definition of definitions) {
      assertObjectJsonSchema(definition.parameters);
      assertSupportedJsonSchema(definition.output.schema);
      disposers.push(runtime.register(definition));
      const result = await runtime.execute(execution(definition.name, inputs[definition.name] ?? {}));
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(result.value.tool, definition.name);
      assert.equal(result.content[0].type, 'text');
      assert.equal(calls.at(-1).options.signal instanceof AbortSignal, true);
    }
  } finally { for (const dispose of disposers.reverse()) dispose(); }
});

test('自主观看原生工具注入服务时走共享watch，默认只使用现有轮次，不回落浏览器执行', async () => {
  const { ctx, runtime } = context();
  const calls = [], lookups = [];
  const watch = {
    state() { calls.push({ method: 'state' }); return { status: 'stopped', running: false }; },
    async start(input, options) { calls.push({ method: 'start', input, options }); return { status: 'running', running: true }; },
    async stop(options) { calls.push({ method: 'stop', options }); return { status: 'stopped', running: false }; },
  };
  const agent = { id: '合成自主观看代理' };
  const definitions = createNativeToolDefinitions({ ctx,
    getController: async () => ({ execute() { assert.fail('注入watch服务后不得把自主观看转到浏览器执行'); } }),
    getWatch: async (exec, starting) => { lookups.push({ agent: exec.agent, starting }); return watch; },
  }).filter(definition => definition.name.startsWith('douyin_watch_'));
  const disposers = definitions.map(definition => runtime.register(definition));
  try {
    for (const [name, args] of [['douyin_watch_status', {}], ['douyin_watch_start', {}], ['douyin_watch_start', { maxRequests: 7 }], ['douyin_watch_stop', {}]]) {
      const result = await runtime.execute({ ...execution(name, args), agent });
      assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(result.value.tool, name);
    }
    assert.deepEqual(calls, [{ method: 'state' }, { method: 'start', input: { startSession: false, maxRequests: 30 }, options: { explicit: true } }, { method: 'start', input: { startSession: false, maxRequests: 7 }, options: { explicit: true } }, { method: 'stop', options: { explicit: true } }]);
    assert.deepEqual(lookups.map(item => item.starting), [false, true, true, false]);
    assert.equal(lookups.every(item => item.agent === agent), true);
    const before = calls.length;
    for (const args of [{ maxRequests: 0 }, { maxRequests: 101 }, { maxRequests: 1.5 }, { startSession: true }]) {
      const result = await runtime.execute({ ...execution('douyin_watch_start', args), agent });
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(calls.length, before, '无效预算或新轮次参数不会进入watch服务');
  } finally { for (const dispose of disposers.reverse()) dispose(); await ctx.fiber.dispose(); }
});

test('共享人格绑定可使用已装真实SystemPrompt变量与动态上下文，每次组装刷新且卸载释放', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'douyin-native-persona-sdk-'));
  const ctx = new Context(), prompt = new SystemPrompt(ctx, { includeHarnessIdentity: false });
  let current = '合成人格版本一：喜欢清楚的解释。';
  const binding = bindNativePersonaContext(ctx, { workspacePaths: [directory], getPersonaMemory: () => ({ context: () => current }) });
  const agent = { id: '合成人格代理', session: { header: { cwd: directory } }, ctx };
  try {
    assert.equal(binding.attach(agent), true);
    assert.equal(binding.attach(agent), false, '重复工具调用不重复注册人格');
    assert.equal(binding.attach({ session: { header: { cwd: join(directory, 'other-workspace') } }, ctx }), false);
    const first = await prompt.assemble();
    assert.equal(first.variables.douyin_shared_persona, current);
    assert.equal(first.contexts.filter(item => item.name === 'workspace:douyin-shared-persona').length, 1);
    assert.match(renderContextSnapshot(first), /合成人格版本一/);
    assert.doesNotMatch(renderContextSnapshot(first), /\{\{douyin_shared_persona\}\}/);
    current = '合成人格版本二：新增有依据的科普兴趣。';
    const refreshed = renderContextSnapshot(await prompt.assemble());
    assert.match(refreshed, /合成人格版本二/); assert.doesNotMatch(refreshed, /合成人格版本一/);
    binding.close();
    const closed = await prompt.assemble();
    assert.equal('douyin_shared_persona' in closed.variables, false);
    assert.equal(closed.contexts.some(item => item.name === 'workspace:douyin-shared-persona'), false);
  } finally {
    binding.close(); await ctx.fiber.dispose();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /douyin-native-persona-sdk-[^\\/]+$/); await rm(directory, { recursive: true, force: true });
  }
});

test('无效参数和控制器失败进入真实 ToolRuntime 的 isError 结果', async () => {
  const { ctx, runtime } = context();
  const definitions = createNativeToolDefinitions({ ctx, getController: async () => ({ execute: async () => ({ ok: false, error: '验证失败' }) }) });
  const disposers = definitions.map((definition) => runtime.register(definition));
  try {
    for (const [name, args] of [['douyin_search', {}], ['douyin_search', { query: '  ' }], ['douyin_next', { url: 'https://example.com' }], ['douyin_open_video', {}], ['douyin_open_video', { url: 'https://example.com' }], ['douyin_observe', { seconds: 11 }], ['douyin_recall', { limit: 1.5 }], ['douyin_remember', { content: '' }]]) {
      const result = await runtime.execute(execution(name, args));
      assert.equal(result.isError, true, name);
    }
    const failure = await runtime.execute(execution('douyin_status'));
    assert.equal(failure.isError, true);
    assert.match(failure.content[0].text, /验证失败/);
  } finally { for (const dispose of disposers.reverse()) dispose(); }
});

test('已取消调用不进入控制器', async () => {
  const { ctx, runtime } = context();
  let count = 0;
  const definition = createNativeToolDefinitions({ ctx, getController: async () => ({ execute: async () => { count += 1; return {}; } }) })[0];
  const dispose = runtime.register(definition);
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.execute(execution(definition.name, {}, controller.signal));
    assert.equal(result.isError, true);
    assert.equal(count, 0);
  } finally { dispose(); }
});

test('原生插件仅注册工具，不触碰工作区且加载时不创建浏览器', async () => {
  const registered = [];
  let teardown;
  const ctx = { tools: { register(value) { registered.push(value); return () => {}; } }, effect(value) { teardown = value(); } };
  Object.defineProperty(ctx, 'workspaceRegistry', { get() { assert.fail('插件不得读取或注册工作区'); } });
  await apply(ctx);
  assert.equal(registered.length, TOOL_DEFINITIONS.length);
  assert.equal(typeof teardown, 'function');
  await teardown();
  await assert.rejects(registered[0].execute({}), /已卸载/);
});

test('真实 Cordis Loader 可加载本地 file URI 并释放完整工具目录', async () => {
  const { ctx, runtime } = context();
  const loaderFiber = ctx.plugin(Loader, { baseUrl: pathToFileURL(join(dshModules, '..', 'cordis.yml')).href });
  await loaderFiber.await();
  const loader = ctx.loader;
  loader.internal = undefined;
  try {
    const id = await loader.create({ name: new URL('../dsh-plugin.mjs',import.meta.url).href });
    await loader.await();
    const names = runtime.schemas().map((definition) => definition.name);
    assert.equal(TOOL_DEFINITIONS.every((definition) => names.includes(definition.name)), true);
    await loader.remove(id);
    assert.equal(runtime.schemas().some((definition) => definition.name.startsWith('douyin_')), false);
  } finally { await ctx.fiber.dispose(); }
});

test('注册中途失败会释放已注册工具', async () => {
  let count = 0;
  let disposed = 0;
  await assert.rejects(apply({ tools: { register() { count += 1; if (count === 3) throw new Error('注册冲突'); return () => { disposed += 1; }; } } }), /注册冲突/);
  assert.equal(disposed, 2);
});

test('真实动态包沙箱通过 Loader 热加载原生插件并可停止释放', async () => {
  const { ctx, runtime } = context();
  const loaderFiber = ctx.plugin(Loader, { baseUrl: pathToFileURL(join(dshModules, '..', 'cordis.yml')).href });
  await loaderFiber.await();
  ctx.loader.internal = undefined;
  const runner = new DynamicCordisRunnerService(ctx, { vmTimeoutMs: 5000 });
  const agent = { id: '插件热加载测试' };
  try {
    const host = await readFile(new URL('../plugin-hotload.js', import.meta.url), 'utf8');
    const defined = runner.define({ sessionId: agent.id, plugin: { kind: 'new', idPrefix: 'douyin' }, name: '抖音插件热加载测试', purpose: '验证当前版本动态包调用 Loader 的实际能力。', code: { host } });
    const result = await runner.run(agent, defined.pluginId, defined.packageId, 'run', new AbortController().signal);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, 'running', JSON.stringify(result));
    assert.equal(TOOL_DEFINITIONS.every((definition) => runtime.get(definition.name) !== undefined), true);
    const stopped = await runner.undefine(agent, defined.pluginId);
    assert.equal(stopped.ok, true);
    assert.equal(runtime.schemas().some((definition) => definition.name.startsWith('douyin_')), false);
  } finally { await ctx.fiber.dispose(); }
});

test('真实动态包可通过 Loader 原位升级同路径旧模块，保留已有entry归属', async () => {
  const directory=await mkdtemp(join(tmpdir(),'douyin-upgrade-'));
  const file=join(directory,'plugin.mjs'),uri=pathToFileURL(file).href;
  const {ctx,runtime}=context();
  const fiber=ctx.plugin(Loader,{baseUrl:pathToFileURL(join(directory,'cordis.yml')).href});
  await fiber.await();ctx.loader.internal=undefined;
  const runner=new DynamicCordisRunnerService(ctx,{vmTimeoutMs:5000});
  try {
    await writeFile(file,`export const name='old-douyin';export const inject=['tools'];export function apply(ctx){const off=ctx.tools.register({name:'douyin_open',description:'合成旧版本',parameters:{type:'object',properties:{}},output:{schema:{type:'object',additionalProperties:true},render:()=>[{type:'text',text:'合成状态'}]},execute:async()=>({ok:true})});ctx.effect(()=>off)}`);
    const old=await ctx.loader.create({name:uri});await ctx.loader.await();
    assert.equal(runtime.schemas().length,1);
    await writeFile(file,`export{default,name,inject,apply}from${JSON.stringify(new URL('../dsh-plugin.mjs?v=13',import.meta.url).href)};`);
    const body=(await readFile(new URL('../plugin-hotload.js',import.meta.url),'utf8')).replaceAll('file:///D:/codex%E5%88%86%E5%B1%80/dsh%E9%85%8D%E7%BD%AE/douyin-browser/dsh-plugin.mjs',uri);
    const defined=runner.define({sessionId:'升级测试',plugin:{kind:'new',idPrefix:'douyin'},name:'升级测试',purpose:'核实模块升级',code:{host:body}});
    const result=await runner.run({id:'升级测试'},defined.pluginId,defined.packageId,'run',new AbortController().signal);await ctx.loader.await();
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(runtime.schemas().length,TOOL_DEFINITIONS.length);assert.equal(Boolean(ctx.loader.store[old]),true);
    assert.equal(ctx.loader.resolve(old).options.name,`${uri}?v=13`);
    await runner.undefine({id:'升级测试'},defined.pluginId);
    assert.equal(runtime.schemas().length,TOOL_DEFINITIONS.length);
  }finally{await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true});}
});

test('真实原生聊天增量包与已有视频工具共存，不重复注册或卸载视频工具',async()=>{
  const {ctx,runtime}=context();
  const video=createNativeToolDefinitions({ctx,getController:async()=>({execute:async()=>({ok:true})})}).filter(tool=>!tool.name.startsWith('douyin_chat_'));
  const off=video.map(tool=>runtime.register(tool));
  const fiber=ctx.plugin(Loader,{baseUrl:pathToFileURL(join(dshModules,'..','cordis.yml')).href});await fiber.await();ctx.loader.internal=undefined;
  const runner=new DynamicCordisRunnerService(ctx,{vmTimeoutMs:5000});const agent={id:'聊天增量测试'};
  try {
    const host=await readFile(new URL('../chat-hotload.js',import.meta.url),'utf8');
    const defined=runner.define({sessionId:agent.id,plugin:{kind:'new',idPrefix:'douyin'},name:'聊天增量测试',purpose:'与12个旧视频工具共存',code:{host}});
    const result=await runner.run(agent,defined.pluginId,defined.packageId,'run',new AbortController().signal);
    assert.equal(result.ok,true,JSON.stringify(result));assert.equal(runtime.schemas().length,TOOL_DEFINITIONS.length);
    await runner.undefine(agent,defined.pluginId);assert.equal(runtime.schemas().length,video.length);
  }finally{for(const dispose of off)dispose();await ctx.fiber.dispose();}
});

test('图片经 attachment ref 呈现，base64 不进入原生结果与文本', async () => {
  let saved;
  const refs = [{ attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 68, width: 1, height: 1 }];
  const ctx = { get(name) { return name === 'attachments' ? { saveImages: async (images) => { saved = images; return refs; } } : name === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } : undefined; } };
  const definition = createNativeToolDefinitions({ ctx, getController: async () => ({ execute: async () => ({ state: { paused: false }, frames: [{ mimeType: 'image/png', data: pixel }] }) }) }).find((item) => item.name === 'douyin_observe');
  const exec = { signal: new AbortController().signal, agent: { options: { provider: '验证供应方', model: '验证图像模型' } } };
  const value = await definition.execute({}, exec);
  assert.equal(saved[0].data instanceof Buffer, true);
  assert.equal(saved[0].mediaType, 'image/png');
  assert.equal(value.images[0].attachmentId, refs[0].attachmentId);
  assert.equal(JSON.stringify(value).includes(pixel), false);
  const { runtime } = context();
  const result = runtime.createSuccessResult(execution(definition.name), definition, value);
  assert.equal(result.content[1].type, 'image');
  assert.deepEqual(result.content[1].attachment, refs[0]);
  assert.equal(JSON.stringify(result).includes(pixel), false);
});

test('模型未声明支持图片时明确报告，不伪称已看懂画面', async () => {
  const ctx = { get(name) { return name === 'attachments' ? { saveImages: async () => { throw new Error('不应调用附件存储'); } } : name === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: ['text'] }) } : undefined; } };
  const definition = createNativeToolDefinitions({ ctx, getController: async () => ({ execute: async () => ({ frames: [{ mimeType: 'image/png', data: pixel }] }) }) }).find((item) => item.name === 'douyin_screenshot');
  const value = await definition.execute({}, { agent: { options: { provider: '验证', model: '纯文本模型' } } });
  assert.deepEqual(value.images, []);
  assert.match(value.imageStatus, /未声明支持图像/);
  assert.equal(JSON.stringify(value).includes(pixel), false);
});

test('登录、验证或敏感画面不进入附件存储或原生文本', async () => {
  let stored = 0;
  const ctx = { get() { stored += 1; throw new Error('不得调用服务'); } };
  for (const state of [{ loginRequired: true }, { verificationRequired: true }, {}]) {
    const definition = createNativeToolDefinitions({ ctx, getController: async () => ({ execute: async () => ({ state, frames: [{ mimeType: 'image/png', data: pixel, sensitive: Object.keys(state).length === 0 }] }) }) }).find((item) => item.name === 'douyin_screenshot');
    const value = await definition.execute({});
    assert.deepEqual(value.images, []);
    assert.equal(value.result.frames, undefined);
    assert.match(value.imageStatus, /登录或验证/);
    assert.equal(JSON.stringify(value).includes(pixel), false);
  }
  assert.equal(stored, 0);
});

test('真实 DSH 附件存储接收图片并通过 ref 回读', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-douyin-attachment-'));
  const ctx = new Context();
  const attachments = new LocalAttachmentStore(ctx, { dshHome: temporaryRoot });
  ctx.provide('llm', { async resolveModelInfo() { return { inputModalities: ['text', 'image'] }; } });
  try {
    const validPixel = (await sharp({ create: { width: 2, height: 2, channels: 3, background: '#123456' } }).png().toBuffer()).toString('base64');
    const definition = createNativeToolDefinitions({ ctx, getController: async () => ({ execute: async () => ({ frames: [{ mimeType: 'image/png', data: validPixel }] }) }) }).find((item) => item.name === 'douyin_screenshot');
    const value = await definition.execute({}, { agent: { options: { provider: '测试', model: '测试图像模型' } } });
    assert.equal(value.images.length, 1, value.imageStatus);
    assert.match(value.images[0].attachmentId, /^sha256:/);
    const readback = await attachments.readImage(value.images[0]);
    assert.equal(readback.data instanceof Uint8Array, true);
    assert.equal(readback.data.length > 0, true);
    assert.equal(JSON.stringify(value).includes(validPixel), false);
  } finally {
    await ctx.fiber.dispose();
    assert.equal(dirname(resolve(temporaryRoot)), resolve(tmpdir()));
    assert.match(temporaryRoot, /dsh-douyin-attachment-[^\\/]+$/);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('工具 schema 与执行验证共同限制长度和数值', () => {
  for (const [name, args] of [['douyin_search', { query: '猫'.repeat(301) }], ['douyin_recall', { query: '猫'.repeat(301) }], ['douyin_remember', { content: '猫'.repeat(4001) }], ['douyin_remember', { content: '偏好', kind: '猫'.repeat(41) }], ['douyin_observe', { seconds: 0 }], ['douyin_recall', { limit: 21 }], ['douyin_open_video', { index: -1 }]]) {
    assert.throws(() => validateToolArguments(TOOL_DEFINITIONS.find((item) => item.name === name), args));
  }
  assert.doesNotThrow(() => validateToolArguments(TOOL_DEFINITIONS.find((item) => item.name === 'douyin_search'), { query: '猫'.repeat(300) }));
});

test('共享安装可回读、幂等和卸载，并保留其他配置', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-douyin-plugin-'));
  try {
    const homeDir = join(temporaryRoot, '.dsh');
    await mkdir(homeDir);
    const original = Buffer.from('\uFEFF# 其他插件\r\n- insert:\r\n    - id: existing\r\n      name: existing-plugin\r\n', 'utf8');
    const target = join(homeDir, 'cordis.patch.yml');
    await writeFile(target, original);
    const dry = await managePlugin({ homeDir, dryRun: true });
    assert.equal(dry.changed, true);
    assert.equal(dry.installed, false);
    assert.equal(dry.plannedInstalled, true);
    assert.deepEqual(await readFile(target), original);
    const installed = await managePlugin({ homeDir });
    assert.equal(installed.verifiedReadback, true);
    assert.equal(installed.restartRequired, true);
    assert.equal(installed.runtimeLoaded, null);
    assert.deepEqual(await readFile(installed.backupPath), original);
    const installedText = await readFile(target, 'utf8');
    assert.equal(installedText.startsWith(original.toString('utf8')), true);
    assert.equal(installedText.split(BEGIN_MARKER).length - 1, 1);
    assert.equal(installedText.split(END_MARKER).length - 1, 1);
    assert.match(installedText, /file:\/\/\/.*dsh-plugin\.mjs/);
    const second = await managePlugin({ homeDir });
    assert.equal(second.changed, false);
    assert.equal(second.backupPath, undefined);
    const removed = await managePlugin({ homeDir, action: 'uninstall' });
    assert.equal(removed.verifiedReadback, true);
    assert.equal(removed.installed, false);
    assert.deepEqual(await readFile(target), original);
  } finally {
    // 只删除本测试创建、且已核实位于系统临时目录下的唯一目录。
    assert.equal(dirname(resolve(temporaryRoot)), resolve(tmpdir()));
    assert.match(temporaryRoot, /dsh-douyin-plugin-[^\\/]+$/);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('损坏或重复的管理标记会停止改写', () => {
  assert.throws(() => planPatch(Buffer.from(BEGIN_MARKER)), /不完整或重复/);
  assert.throws(() => planPatch(Buffer.from(`${BEGIN_MARKER}\n${BEGIN_MARKER}\n${END_MARKER}`)), /不完整或重复/);
  assert.throws(() => planPatch(Buffer.from('- insert:\n    - id: douyin-browser\n      name: other-plugin\n')), /未由本安装器管理/);
  assert.equal(TOOL_DEFINITIONS.every((item) => item.parameters.additionalProperties === false), true);
});
