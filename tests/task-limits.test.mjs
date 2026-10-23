import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { TaskLimits, DEFAULT_TASK_POLICY, TASK_LIMIT_BOUNDS, validateTaskPolicy } from '../task-limits.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'douyin-task-policy-'));
  const limits = new TaskLimits({ stateDir: directory });
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, limits };
}

test('缺少设置返回有限默认值，两入口读取同一路径且返回值不能修改默认硬界', t => {
  const { directory, limits } = fixture(t), state = limits.state();
  assert.deepEqual(state.policy, { maxSteps: 20, maxToolCalls: 20, timeoutSeconds: 180 }); assert.equal(state.configured, false);
  assert.equal(fs.existsSync(limits.policyFile), false);
  state.policy.maxSteps = 999; state.hardLimits.maxSteps.maximum = 9999;
  assert.deepEqual(limits.state().policy, DEFAULT_TASK_POLICY); assert.equal(limits.state().hardLimits.maxSteps.maximum, 10000);
  const other = new TaskLimits({ stateDir: directory });
  limits.configure({ maxSteps: 35, maxToolCalls: 40, timeoutSeconds: 600 }, { explicit: true });
  assert.deepEqual(other.state().policy, { maxSteps: 35, maxToolCalls: 40, timeoutSeconds: 600 }); assert.equal(other.state().configured, true);
});

test('仅显式用户操作可保存，完整参数与有限整数硬界共同校验且失败不写文件', t => {
  const { limits } = fixture(t);
  for (const explicit of [undefined, false, 1, 'true']) assert.throws(() => limits.configure(DEFAULT_TASK_POLICY, { explicit }), error => error.code === 'TASK_POLICY_EXPLICIT');
  for (const field of Object.keys(TASK_LIMIT_BOUNDS)) {
    const { minimum, maximum } = TASK_LIMIT_BOUNDS[field];
    for (const value of [minimum - 1, maximum + 1, 1.5, Infinity, NaN, null, '20']) assert.throws(() => limits.configure({ ...DEFAULT_TASK_POLICY, [field]: value }, { explicit: true }), error => error.code === 'TASK_POLICY_ARGUMENT');
    assert.doesNotThrow(() => validateTaskPolicy({ ...DEFAULT_TASK_POLICY, [field]: minimum }));
    assert.doesNotThrow(() => validateTaskPolicy({ ...DEFAULT_TASK_POLICY, [field]: maximum }));
  }
  for (const input of [null, [], {}, { maxSteps: 20 }, { ...DEFAULT_TASK_POLICY, disabled: true }, { ...DEFAULT_TASK_POLICY, sessionMinutes: 1000 }]) assert.throws(() => limits.configure(input, { explicit: true }));
  assert.equal(fs.existsSync(limits.policyFile), false); assert.equal(fs.existsSync(limits.guardFile), false);
});

test('文件原子替换有版本且有界，不遗留临时文件或控制锁', t => {
  const { limits, directory } = fixture(t);
  const policy = { maxSteps: 10000, maxToolCalls: 10000, timeoutSeconds: 604800 };
  const result = limits.configure(policy, { explicit: true });
  assert.deepEqual(result.policy, policy); assert.deepEqual(JSON.parse(fs.readFileSync(limits.policyFile, 'utf8')), { version: 1, policy });
  assert.ok(fs.statSync(limits.policyFile).size < 4096);
  assert.deepEqual(fs.readdirSync(directory), ['task-policy.json']);
  assert.throws(() => limits.configure({ ...policy, maxToolCalls: 10001 }, { explicit: true })); assert.deepEqual(limits.state().policy, policy);
});

test('损坏、超大、非法版本或非普通文件拒绝读取与覆盖，不静默恢复默认值', t => {
  for (const content of ['损坏的合成设置', JSON.stringify({ version: 2, policy: DEFAULT_TASK_POLICY }), JSON.stringify({ version: 1, policy: { ...DEFAULT_TASK_POLICY, maxSteps: 0 } }), ' '.repeat(4097), Buffer.from([0xc3, 0x28])]) {
    const { limits } = fixture(t); fs.writeFileSync(limits.policyFile, content); const before = fs.readFileSync(limits.policyFile);
    assert.throws(() => limits.state(), error => error.code === 'TASK_POLICY_FILE');
    assert.throws(() => limits.configure(DEFAULT_TASK_POLICY, { explicit: true }), error => error.code === 'TASK_POLICY_FILE');
    assert.deepEqual(fs.readFileSync(limits.policyFile), before); assert.equal(fs.existsSync(limits.guardFile), false);
  }
  const { limits } = fixture(t); fs.mkdirSync(limits.policyFile);
  assert.throws(() => limits.state(), error => error.code === 'TASK_POLICY_FILE');
  assert.equal(fs.statSync(limits.policyFile).isDirectory(), true);
});

test('真实另一Node进程持有guard时不抢占，释放后两入口可继续保存', { timeout: 10_000 }, async t => {
  const { limits } = fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';const guard=process.argv[1];fs.writeFileSync(guard,JSON.stringify({pid:process.pid,nonce:'synthetic-child-owner'}),{flag:'wx'});process.send({held:true});process.on('message',()=>{fs.unlinkSync(guard);process.exit(0)});`, limits.guardFile], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [message] = await once(child, 'message'); assert.equal(message.held, true);
  const before = fs.readFileSync(limits.guardFile, 'utf8');
  assert.throws(() => limits.configure(DEFAULT_TASK_POLICY, { explicit: true }), error => error.status === 409 && error.code === 'TASK_POLICY_BUSY');
  assert.equal(fs.readFileSync(limits.guardFile, 'utf8'), before); assert.equal(fs.existsSync(limits.policyFile), false);
  const exited = once(child, 'exit'); child.send({ release: true }); await exited;
  assert.deepEqual(limits.configure(DEFAULT_TASK_POLICY, { explicit: true }).policy, DEFAULT_TASK_POLICY);
});

test('保存手动预算不修改视频截止、自主观看预算或其他业务状态', t => {
  const { directory, limits } = fixture(t);
  const files = { 'video-policy.json': '{"sessionMinutes":10}', 'video-sessions.json': '{"current":{"expiresAt":1792059000000}}', 'watch-budget.json': '{"sessions":{"合成轮次":{"requests":7,"maxRequests":30}}}' };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), body);
  limits.configure({ maxSteps: 10000, maxToolCalls: 10000, timeoutSeconds: 604800 }, { explicit: true });
  for (const [name, body] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(directory, name), 'utf8'), body);
});
