import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import plugin, { apply, createNativeLaunchCommand } from '../dsh-plugin.mjs';
import { TOOL_DEFINITIONS } from '../tool-definitions.mjs';

const sdk = process.env.DSH_NODE_MODULES || 'F:/codex/DSH Desktop 2/resources/app/node_modules';
const [{ Context }, { CommandRuntime }, { ToolRuntime }] = await Promise.all([
  import(pathToFileURL(path.join(sdk, '@deepseek-ai/cordis/lib/index.js')).href),
  import(pathToFileURL(path.join(sdk, '@deepseek-ai/dsh-commands/lib/index.js')).href),
  import(pathToFileURL(path.join(sdk, '@deepseek-ai/dsh-tools/lib/index.js')).href),
]);

async function fixture(t, { commands = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-native-launch-sdk-'));
  const previous = Object.fromEntries(['DOUYIN_RUNTIME_LOCATION_FILE', 'DEEPSEEK_SHARED_MEMORY_DB'].map(key => [key, process.env[key]]));
  const location = path.join(root, 'runtime-location.json');
  fs.writeFileSync(location, JSON.stringify({ version: 1, stateDir: path.join(root, 'state'), memoryDir: path.join(root, 'memory') }));
  process.env.DOUYIN_RUNTIME_LOCATION_FILE = location;
  process.env.DEEPSEEK_SHARED_MEMORY_DB = path.join(root, 'memory', 'shared.sqlite');
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools() { return () => {}; } });
  const tools = new ToolRuntime(ctx);
  let provider;
  if (commands) { provider = ctx.plugin(CommandRuntime); await provider.await(); }
  const events = [];
  const agent = { id: '合成打开命令代理', ctx, session: { header: { cwd: root }, append(type, data) { events.push({ type, data }); return events.length; } } };
  t.after(async () => {
    await ctx.fiber.dispose();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('douyin-native-launch-sdk-')) throw new Error('临时 SDK 清理路径不符。');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, ctx, tools, agent, events, provider, commands: () => ctx.get('commands') };
}
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('临时 SDK 的可选命令依赖未在限时内就绪。');
}

test('真实 CommandRuntime 直接执行打开命令，无需模型、视频工具或 API Key', async t => {
  const f = await fixture(t), calls = [];
  const off = f.commands().register(createNativeLaunchCommand({ getController: async () => ({
    openBrowser: async options => { calls.push(options); return { opened: true, mode: 'prepare', paused: true, sessionChanged: false, message: '合成专用入口已打开，视频保持暂停。' }; },
    execute() { assert.fail('原生命令不能进入模型或视频工具执行链'); }, limits() { assert.fail('命令不能启动视频时钟'); }, getChatService() { assert.fail('命令不能启动聊天'); },
  }) }));
  t.after(off);
  assert.equal(f.commands().list(f.agent).find(item => item.name === 'douyin-open').input, undefined);
  const result = await f.commands().execute(f.agent, '/douyin-open', [], new AbortController().signal);
  assert.equal(result.result.kind, 'success'); assert.match(result.result.text, /保持暂停/);
  assert.equal(calls.length, 1); assert.equal(calls[0].signal.aborted, false);
  assert.deepEqual(f.events.map(item => item.type), ['command/run', 'command/done']);
  assert.equal('args' in f.events[0].data, false, '无效参数也不应进入持久命令输入日志');
});

test('真实命令拒绝任意参数、附件及预取消，不进入控制器', async t => {
  const f = await fixture(t); let controllers = 0;
  const off = f.commands().register(createNativeLaunchCommand({ getController: async () => { controllers++; assert.fail('拒绝的命令不得创建控制器'); } }));
  t.after(off);
  for (const line of ['/douyin-open extra', '/douyin-open https://example.com/private?token=synthetic']) {
    const result = await f.commands().execute(f.agent, line, [], new AbortController().signal);
    assert.equal(result.result.kind, 'error'); assert.match(result.result.text, /不接收/);
  }
  const attachment = await f.commands().execute(f.agent, '/douyin-open', [{ type: 'file', receiptId: 'synthetic-upload' }], new AbortController().signal);
  assert.equal(attachment.result.kind, 'error'); assert.match(attachment.result.text, /attachments/);
  const cancelled = new AbortController(); cancelled.abort(new Error('合成取消'));
  await assert.rejects(f.commands().execute(f.agent, '/douyin-open', [], cancelled.signal), /合成取消/);
  assert.equal(controllers, 0);
  assert.equal(JSON.stringify(f.events).includes('token=synthetic'), false);
});

test('卸载信号在异步控制器等待后仍拦截打开，真实 SDK 记录失败结果', async t => {
  const f = await fixture(t), lifetime = new AbortController(); let release, opened = 0;
  const ready = new Promise(resolve => { release = resolve; });
  const off = f.commands().register(createNativeLaunchCommand({ lifetimeSignal: lifetime.signal, getController: async () => { await ready; return { openBrowser() { opened++; } }; } }));
  t.after(off);
  const pending = f.commands().execute(f.agent, '/douyin-open', [], new AbortController().signal);
  lifetime.abort(new Error('合成插件已卸载')); release();
  await assert.rejects(pending, /合成插件已卸载/);
  assert.equal(opened, 0); assert.equal(f.events.at(-1).data.kind, 'error');
});

test('已存在自主观看时使用入口实际返回文案，不假称暂停了自主播放', async t => {
  const f = await fixture(t);
  const off = f.commands().register(createNativeLaunchCommand({ getController: async () => ({ openBrowser: async () => ({ opened: true, mode: 'watch', paused: null, watchPreserved: true, sessionChanged: false, message: '合成自主窗口已显示，播放和轮次保持原状。' }) }) }));
  t.after(off);
  const result = await f.commands().execute(f.agent, '/douyin-open', [], new AbortController().signal);
  assert.equal(result.result.kind, 'success'); assert.match(result.result.text, /保持原状/); assert.doesNotMatch(result.result.text, /保持暂停/);
});

test('无 commands 服务也能加载完整32工具，可选依赖挂载、卸载和恢复均独立', async t => {
  const f = await fixture(t, { commands: false });
  const fiber = f.ctx.plugin(plugin); await fiber.await();
  assert.equal(f.tools.schemas().length, TOOL_DEFINITIONS.length); assert.equal(TOOL_DEFINITIONS.length, TOOL_DEFINITIONS.length);
  assert.equal(f.commands(), undefined);
  const provider = f.ctx.plugin(CommandRuntime); await provider.await();
  await until(() => f.commands()?.list(f.agent).some(item => item.name === 'douyin-open'));
  await provider.dispose();
  assert.equal(f.tools.schemas().length, TOOL_DEFINITIONS.length); assert.equal(f.commands(), undefined);
  const replacement = f.ctx.plugin(CommandRuntime); await replacement.await();
  await until(() => f.commands()?.list(f.agent).some(item => item.name === 'douyin-open'));
  await fiber.dispose();
  assert.equal(f.tools.schemas().length, 0); assert.equal(f.commands().list(f.agent).length, 0);
});

test('真实 SDK 热加载两次均释放命令和工具，不留下重复注册', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 2; index++) {
    const fiber = f.ctx.plugin(plugin); await fiber.await();
    assert.equal(f.tools.schemas().length, TOOL_DEFINITIONS.length);
    assert.deepEqual(f.commands().list(f.agent).map(item => item.name), ['douyin-open']);
    await fiber.dispose();
    assert.equal(f.tools.schemas().length, 0); assert.equal(f.commands().list(f.agent).length, 0);
  }
});

test('命令注册冲突会让加载失败并回收已注册工具，保留原命令', async t => {
  const f = await fixture(t);
  const original = f.commands().register({ name: 'douyin-open', description: '已有合成命令', handler: () => ({ kind: 'success', text: '保留原命令' }) });
  t.after(original);
  await assert.rejects(apply(f.ctx), /duplicate|已注册|重复|already/i);
  assert.equal(f.tools.schemas().length, 0);
  assert.equal(f.commands().list(f.agent).length, 1);
  assert.equal((await f.commands().execute(f.agent, '/douyin-open', [], new AbortController().signal)).result.text, '保留原命令');
});
