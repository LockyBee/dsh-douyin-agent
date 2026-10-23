import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiagnosticsService } from '../diagnostics.mjs';
import { VideoLimits } from '../video-limits.mjs';
import { WatchMode } from '../watch-mode.mjs';
import { createApiServer } from '../app.mjs';
import { createNativeToolDefinitions } from '../dsh-plugin.mjs';
import { validateToolArguments, TOOL_DEFINITIONS } from '../tool-definitions.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-diagnostic-'));
  t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); assert.match(path.basename(directory), /^douyin-diagnostic-/); fs.rmSync(directory, { recursive: true, force: true }); });
  let clock = Date.now(), applyCalls = 0;
  const pages = [], states = new Map([[1, 'normal']]), mutations = [];
  const browser = { isConnected: () => true, contexts: () => [context] };
  const context = { pages: () => pages, browser: () => browser, async newCDPSession(page) {
    return { async send(method, args) {
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: page.targetId } };
      if (method === 'Browser.getWindowForTarget') { const target = pages.find(item => item.targetId === args.targetId); return { windowId: target.windowId, bounds: { windowState: states.get(target.windowId) } }; }
      if (method === 'Browser.setWindowBounds') { mutations.push(method); states.set(args.windowId, args.bounds.windowState); return {}; }
      assert.fail(`不允许的测试指令 ${method}`);
    }, async detach() {} };
  } };
  const add = (name = 'deepseek-douyin-api-chat') => {
    const page = { name, targetId: `private-target-${pages.length}`, windowId: 1, isClosed: () => false, context: () => context, login: false, unmuted: 0,
      async evaluate(fn) { return fn.name === 'pageIdentity' ? { name: page.name, origin: 'https://www.douyin.com', loginRequired: page.login, verificationRequired: false } : { count: 1, unmuted: page.unmuted }; } };
    pages.push(page); return page;
  };
  add();
  const mode = new WatchMode({ stateDir: directory }); mode.configure({ silent: true }, { explicit: true });
  const controller = { connectExistingBrowser: async () => browser, async applyWatchMode(input) { applyCalls++; return mode.applyBrowser(browser, input); }, getWatchMode: async () => mode };
  const options = { source: 'dsh', controller, modeService: mode, paths: { stateDir: directory, memoryDir: path.join(directory, 'memory') }, now: () => clock,
    nodeResolver: () => process.execPath, probeNode: async () => ({ stdout: '24.19.0' }), modelConfigured: true,
    videoLimits: { state: () => ({ allowed: false }) }, usageLedger: { state: () => ({ damagedRecords: 0 }) }, watchService: { state: () => ({ running: false }) },
    settingsTransport: () => ({ webServer: false, connectionFetch: true }), watchSchedule: { state: () => ({ policy: { enabled: false } }) },
  };
  const service = new DiagnosticsService(options);
  return { directory, controller, options, mode, service, states, pages, add, mutations, applyCalls: () => applyCalls, advance: milliseconds => { clock += milliseconds; } };
}
const item = (report, id) => report.checks.find(check => check.id === id);
const input = report => ({ reportId: report.reportId, action: 'reapply_silent' });

test('实时检查发现静默开关与窗口不一致；修复后CDP回读，保留许可文件，不启动媒体或发送', async t => {
  const f = fixture(t), policy = fs.readFileSync(f.mode.policyFile);
  const before = await f.service.run();
  assert.equal(before.pluginVersion, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
  assert.equal(item(before, 'silent_window').code, 'SILENT_WINDOW_VISIBLE'); assert.equal(before.ok, false);
  assert.equal(f.mutations.length, 0); assert.equal(f.applyCalls(), 0);
  const repair = await f.service.repair(input(before));
  assert.equal(repair.status, 'repaired'); assert.equal(item(repair.after, 'silent_window').code, 'SILENT_WINDOW_MINIMIZED');
  assert.equal(f.states.get(1), 'minimized'); assert.equal(f.applyCalls(), 1); assert.deepEqual(f.mutations, ['Browser.setWindowBounds']);
  assert.deepEqual(fs.readFileSync(f.mode.policyFile), policy); assert.equal(f.pages.length, 1);
  assert.doesNotMatch(JSON.stringify(repair), /private-target|douyin-diagnostic-|https:\/\/|联系人|Cookie|private-key/);
});

test('同窗含非受管标签、登录验证或全屏时报告阻止原因，不提供窗口修复', async t => {
  for (const reason of ['foreign', 'login', 'fullscreen']) {
    const f = fixture(t);
    if (reason === 'foreign') f.add('unmanaged');
    if (reason === 'login') f.pages[0].login = true;
    if (reason === 'fullscreen') f.states.set(1, 'fullscreen');
    const report = await f.service.run();
    assert.equal(item(report, 'silent_window').code, 'SILENT_WINDOW_BLOCKED'); assert.equal(report.repairableActions.length, 0);
    await assert.rejects(f.service.repair(input(report)), /没有允许/); assert.equal(f.mutations.length, 0);
  }
});

test('报告过期、伪造编号、任意动作或扩权字段均不能修复，旧报告不能重复执行', async t => {
  const f = fixture(t), report = await f.service.run();
  for (const args of [{ ...input(report), reportId: 'forged' }, { ...input(report), action: 'delete_memory' }, { ...input(report), resetBudget: true }]) await assert.rejects(f.service.repair(args));
  f.advance(300_001); await assert.rejects(f.service.repair(input(report)), /过期/);
  const fresh = await f.service.run(); await f.service.repair(input(fresh));
  await assert.rejects(f.service.repair(input(fresh)), /过期|不属于/); assert.equal(f.applyCalls(), 1);
});

test('执行前重新检查，用户已关闭静默或出现登录提示则不使用旧报告修复', async t => {
  for (const change of ['disabled', 'login']) {
    const f = fixture(t), report = await f.service.run();
    if (change === 'disabled') f.mode.configure({ silent: false }, { explicit: true }); else f.pages[0].login = true;
    const result = await f.service.repair(input(report)); assert.equal(result.status, 'skipped'); assert.equal(f.applyCalls(), 0);
  }
});

test('执行返回成功但窗口未改变不能报告修复完成；不会自动循环重试', async t => {
  const f = fixture(t); let calls = 0;
  f.controller.applyWatchMode = async () => { calls++; return { applied: true }; };
  const result = await f.service.repair(input(await f.service.run()));
  assert.equal(result.status, 'unresolved'); assert.equal(item(result.after, 'silent_window').code, 'SILENT_WINDOW_VISIBLE'); assert.equal(calls, 1);
});

test('作品未静音可独立检出，报告无媒体时保持待核对', async t => {
  const f = fixture(t); f.states.set(1, 'minimized');
  assert.equal(item(await f.service.run(), 'silent_media').code, 'MEDIA_NOT_PRESENT');
  f.pages[0].name = 'deepseek-douyin-api'; f.pages[0].unmuted = 1;
  const report = await f.service.run(); assert.equal(item(report, 'silent_media').code, 'SILENT_MEDIA_UNMUTED'); assert.equal(report.repairableActions.length, 1);
});

test('设置承载接口缺失与Edge安装独立报告；损坏运行记录不妨碍其他项，报告剔除错误原文', async t => {
  const f = fixture(t);
  f.options.settingsTransport = () => ({ webServer: false, connectionFetch: false });
  f.options.watchService = async () => { throw Error('private-key C:/private/path'); };
  f.options.interactionStates = () => ({ chat: { policy: { allowlist: ['private-name'] }, running: false } });
  const report = await f.service.run();
  assert.equal(item(report, 'transport').code, 'SETTINGS_TRANSPORT_MISSING'); assert.equal(item(report, 'transport').resolution.kind, 'update');
  assert.equal(item(report, 'worker').code, 'WORKER_UNREADABLE'); assert.equal(item(report, 'interactions').code, 'INTERACTION_NOT_RUNNING');
  assert.ok(item(report, 'browser')); assert.doesNotMatch(JSON.stringify(report), /private-key|private-name|C:\/private/);
});

test('真实HTTP自检和修复受认证及报告约束，返回修复后的报告', async t => {
  const f = fixture(t);
  const server = createApiServer({ controller: f.controller, config: { apiKey: '', model: '合成' }, agent: {}, modeService: f.mode, videoLimits: new VideoLimits({ stateDir: f.directory }), port: 0 });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => server.stop());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(origin + '/api/bootstrap')).json();
  const post = (route, body, headers = {}) => fetch(origin + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': token, ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/diagnostics/repair', {}, { 'x-session-token': '' })).status, 403);
  const report = await (await post('/api/diagnostics', {})).json(); assert.equal(item(report, 'silent_window').code, 'SILENT_WINDOW_VISIBLE');
  assert.equal((await post('/api/diagnostics/repair', { ...input(report), action: 'reset' })).status, 400);
  const result = await (await post('/api/diagnostics/repair', input(report))).json(); assert.equal(result.status, 'repaired'); assert.equal(result.after.protocol, 'diagnostics-v2');
});

test('原生诊断工具保留未通过报告供模型读取，修复工具按reportId调用同一服务', async t => {
  const f = fixture(t);
  const definitions = createNativeToolDefinitions({ getController: async () => f.controller, getDiagnostics: async () => f.service });
  const run = definitions.find(tool => tool.name === 'douyin_diagnostics'), repair = definitions.find(tool => tool.name === 'douyin_diagnostics_repair');
  const report = (await run.execute({})).result; assert.equal(report.ok, false); assert.equal(report.protocol, 'diagnostics-v2');
  const result = (await repair.execute(input(report))).result; assert.equal(result.status, 'repaired');
  const schema = TOOL_DEFINITIONS.find(tool => tool.name === repair.name);
  assert.throws(() => validateToolArguments(schema, { ...input(report), action: 'shell' }));
});

test('修复前复查期间取消任务，不改窗口或重放动作', async t => {
  const f = fixture(t), report = await f.service.run(), abort = new AbortController();
  f.options.probeNode = async () => { abort.abort(Error('本人取消排查')); return { stdout: '24.19.0' }; };
  await assert.rejects(f.service.repair(input(report), { signal: abort.signal }), /取消排查/);
  assert.equal(f.applyCalls(), 0); assert.equal(f.mutations.length, 0);
});
