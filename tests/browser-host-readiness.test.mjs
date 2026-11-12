import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dedicatedHostReadiness, dedicatedHostPlan, sameBrowserProfile } from '../core.mjs';

const options = { pid: 200, profile: 'synthetic-dedicated-profile', port: 9227, processAlive: pid => pid === 200 };
const state = { pid: 200, profile: options.profile, port: 9227, ready: true };

test('陈旧宿主PID被复用时重新启动，不把活着的异进程当作旧宿主等待', async () => {
  const recorded = { ...state, startedAt: 1000 };
  const probes = { ...options, readProcessBirth: async () => 2000 };
  assert.equal(await dedicatedHostPlan(recorded, probes), 'launch');
  assert.equal(await dedicatedHostPlan(recorded, { ...probes, endpointReady: true }), 'foreign');
  assert.equal(await dedicatedHostPlan(recorded, { ...probes, readProcessBirth: async () => 900 }), 'wait');
  assert.equal(await dedicatedHostPlan(recorded, { ...probes, readProcessBirth: async () => 900, endpointReady: true }), 'connect');
  assert.equal(await dedicatedHostPlan(recorded, { ...probes, processAlive: () => false }), 'launch');
  assert.equal(await dedicatedHostPlan(recorded, { ...probes, readProcessBirth: async () => null }), 'unverified');
  assert.equal(await dedicatedHostPlan(recorded, { ...probes, readProcessBirth: async () => null, endpointReady: true }), 'unverified');
});
test('Windows资料目录规范化分隔符、大小写和父路径，其他目录仍拒绝', () => {
  assert.equal(sameBrowserProfile('C:\\Synthetic\\folder\\..\\profile', 'c:/synthetic/profile', 'win32'), true);
  assert.equal(sameBrowserProfile('C:\\Synthetic\\profile', 'C:\\Synthetic\\other', 'win32'), false);
  assert.equal(sameBrowserProfile('/tmp/Profile', '/tmp/profile', 'darwin'), false);
});
test('实际进程启动时间能识别同PID的陈旧记录，核查过程不终止进程', async t => {
  const child = spawn(process.execPath, ['-e', 'console.log("synthetic-ready");setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => { if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; } });
  await once(child.stdout, 'data');
  const recorded = { pid: child.pid, profile: options.profile, port: options.port, ready: true, startedAt: Date.now() - 86_400_000 };
  assert.equal(await dedicatedHostPlan(recorded, { profile: options.profile, port: options.port }), 'launch');
  assert.equal(child.exitCode, null);
  assert.equal(await dedicatedHostPlan({ ...recorded, startedAt: Date.now() }, { profile: options.profile, port: options.port }), 'wait');
});

test('新宿主尚未覆盖旧状态文件时继续等待，不把旧进程退出误判为新启动失败', () => {
  assert.equal(dedicatedHostReadiness({ ...state, pid: 100 }, options), 'pending');
  assert.equal(dedicatedHostReadiness(null, options), 'pending');
  assert.equal(dedicatedHostReadiness({ ...state, ready: false }, options), 'pending');
  assert.equal(dedicatedHostReadiness(state, options), 'ready');
});

test('仅本次目标进程退出才报告失败，不接受另一宿主或资料目录的就绪记录', () => {
  assert.equal(dedicatedHostReadiness({ ...state, pid: 300 }, options), 'pending');
  assert.equal(dedicatedHostReadiness({ ...state, profile: 'foreign-profile' }, options), 'foreign');
  assert.equal(dedicatedHostReadiness({ ...state, port: 9228 }, options), 'foreign');
  assert.equal(dedicatedHostReadiness(state, { ...options, processAlive: () => false }), 'failed');
  assert.equal(dedicatedHostReadiness(state, { ...options, pid: null }), 'failed');
});
