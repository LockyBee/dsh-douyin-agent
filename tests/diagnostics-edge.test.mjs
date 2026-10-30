import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyBrowserLaunchError, probeEdgeInstallation, runBrowserHost } from '../browser-host.mjs';
import { runDiagnostics } from '../diagnostics.mjs';

test('Edge启动分类按实际宿主接口脱敏，明确协议unsupported才报告不兼容', () => {
  const incompatible = classifyBrowserLaunchError(new Error('Browser.getVersion: Protocol error (Browser.getVersion): unsupported'));
  assert.equal(incompatible.code, 'EDGE_VERSION_INCOMPATIBLE');
  assert.match(incompatible.message, /更新 Microsoft Edge/);
  assert.doesNotMatch(incompatible.message, /106|最低版本/);
  const missing = classifyBrowserLaunchError(new Error("Executable doesn't exist at C:\\Users\\private\\msedge.exe"));
  assert.equal(missing.code, 'EDGE_MISSING');
  assert.doesNotMatch(JSON.stringify(missing), /private|msedge\.exe/);
  const exited = classifyBrowserLaunchError(new Error('Target page, context or browser has been closed'));
  assert.equal(exited.code, 'EDGE_LAUNCH_FAILED'); assert.match(exited.message, /退出|未能就绪/);
  assert.equal(classifyBrowserLaunchError(new Error('ProcessSingleton: user data directory is already in use')).code, 'BROWSER_PROFILE_IN_USE');
  assert.equal(classifyBrowserLaunchError(new Error('unexpected synthetic failure')).code, 'EDGE_LAUNCH_FAILED');
  assert.equal(classifyBrowserLaunchError(new Error('unsupported synthetic attachment')).code, 'EDGE_LAUNCH_FAILED');
  const secret = classifyBrowserLaunchError(new Error('Protocol error: unsupported token=synthetic-secret https://synthetic.invalid/private C:\\Users\\private\\msedge.exe'));
  assert.doesNotMatch(JSON.stringify(secret), /synthetic-secret|synthetic\.invalid|private|msedge\.exe/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-edge-diagnostic-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('douyin-edge-diagnostic-')) throw new Error('合成诊断清理路径不符。');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const paths = { stateDir: path.join(root, 'state'), memoryDir: path.join(root, 'memory'), browserControlDir: path.join(root, 'control'), browserProfileDir: path.join(root, 'profile') };
  fs.mkdirSync(paths.browserControlDir);
  const now = Date.UTC(2026, 9, 28, 5), file = path.join(paths.browserControlDir, 'browser.json');
  const report = host => {
    if (host) fs.writeFileSync(file, JSON.stringify(host));
    return runDiagnostics({ source: 'api', modelConfigured: true, paths, now: () => now, nodeResolver: () => process.execPath,
      probeNode: async () => ({ stdout: '22.13.0' }), probeBrowserInstallation: async () => ({ installed: true, version: '106.0.1370.52', channel: 'msedge' }),
      videoLimits: { state: () => ({ allowed: false }) }, optionsService: { state: () => ({ policy: {} }) } });
  };
  const failed = extra => ({ pid: 2147483647, ready: false, profile: paths.browserProfileDir, launchFailure: { code: 'EDGE_VERSION_INCOMPATIBLE', message: '协议不兼容 C:\\Users\\private\\msedge.exe', details: 'token=synthetic-secret https://synthetic.invalid/private', browserVersion: '106.0.1370.52', at: now - 1000 }, ...extra });
  return { root, paths, file, now, report, failed };
}

test('106只作为版本证据，不凭版本号强制拒绝或调用真实Edge', async t => {
  const probed = await probeEdgeInstallation({ candidates: ['synthetic-edge.exe'], exists: () => true, readVersion: async () => '106.0.1370.52' });
  assert.equal(probed.installed, true); assert.equal(probed.version, '106.0.1370.52');
  const f = fixture(t), browser = (await f.report()).checks.find(item => item.id === 'browser');
  assert.equal(browser.status, 'pass'); assert.equal(browser.code, 'BROWSER_OK'); assert.equal(browser.evidence.browserVersion, '106.0.1370.52');
  assert.doesNotMatch(browser.message, /最低版本|必须升级|不支持106/);
});

test('诊断只读取同profile的新近已知失败，活就绪、未知、过期及其他profile不误报', async t => {
  const f = fixture(t), initial = f.failed(), browser = (await f.report(initial)).checks.find(item => item.id === 'browser');
  assert.equal(browser.status, 'warning'); assert.equal(browser.code, 'EDGE_VERSION_INCOMPATIBLE'); assert.equal(browser.resolution.kind, 'update');
  assert.doesNotMatch(JSON.stringify(browser), /synthetic-secret|synthetic\.invalid|private|msedge\.exe/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), JSON.stringify(initial));
  for (const host of [
    f.failed({ pid: process.pid, ready: true }),
    f.failed({ profile: path.join(f.root, 'unrelated-profile') }),
    f.failed({ launchFailure: { ...initial.launchFailure, code: 'UNKNOWN_EDGE_ERROR' } }),
    f.failed({ launchFailure: { ...initial.launchFailure, at: f.now - 24 * 60 * 60_000 } }),
    f.failed({ launchFailure: { ...initial.launchFailure, at: f.now + 1 } }),
  ]) {
    const fresh = (await f.report(host)).checks.find(item => item.id === 'browser');
    assert.equal(fresh.status, 'pass'); assert.equal(fresh.code, 'BROWSER_OK');
    assert.equal(fs.readFileSync(f.file, 'utf8'), JSON.stringify(host));
  }
});

test('自检把同profile启动立即退出保留为warning和更新方向，不伪装浏览器就绪', async t => {
  const f = fixture(t), report = await f.report(f.failed({ launchFailure: { code: 'EDGE_LAUNCH_FAILED', message: '专用浏览器立即退出。', at: f.now - 1000 } }));
  const browser = report.checks.find(item => item.id === 'browser');
  assert.equal(browser.status, 'warning');
  assert.equal(browser.code, 'EDGE_LAUNCH_FAILED');
  assert.match(browser.message, /立即退出/);
  assert.equal(browser.resolution.kind, 'update'); assert.ok(report.summary.warning > 0);
  assert.equal(report.ok, true, 'diagnostics-v2的ok表示没有hard fail；warning仍保留，不代表浏览器已就绪');
});

test('宿主失败记录沿用launchFailure并脱敏，106仍实际尝试合成启动', async t => {
  const f = fixture(t); let attempts = 0;
  const result = await runBrowserHost({ profile: f.paths.browserProfileDir, controlDir: f.paths.browserControlDir, port: 19227,
    chromiumImpl: { launchPersistentContext: async () => { attempts++; throw new Error('Protocol error: unsupported token=synthetic-secret C:\\Users\\private\\msedge.exe'); } },
    probeInstallation: async () => ({ installed: true, version: '106.0.1370.52' }),
    logger: { log() {}, error() {} }, processImpl: { pid: process.pid } });
  assert.equal(attempts, 1); assert.equal(result.started, false); assert.equal(result.exitCode, 1);
  const state = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.equal(state.ready, false); assert.equal(state.profile, f.paths.browserProfileDir); assert.equal(state.launchFailure.code, 'EDGE_VERSION_INCOMPATIBLE');
  assert.equal(state.launchFailure.browserVersion, '106.0.1370.52'); assert.doesNotMatch(JSON.stringify(state.launchFailure), /synthetic-secret|private|msedge\.exe/);
});
