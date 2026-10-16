import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersonaMemory } from '../persona-memory.mjs';
import { DailyReport } from '../daily-report.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-daily-report-'));
  let clock = Date.parse('2026-10-16T04:00:00Z');
  const now = () => clock, memory = new PersonaMemory({ memoryDir: path.join(root, 'memory'), legacyRoleCardFile: path.join(root, 'never-read-legacy.md'), clock: now });
  memory.initialize({ importLegacy: false });
  const report = new DailyReport({ personaMemory: memory, now });
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^douyin-daily-report-/); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, memory, report, now, clock(value) { clock = value; } };
}
const state = (id, time = 0, extra = {}) => ({ url: `https://www.douyin.com/video/${id}`, loginRequired: false, verificationRequired: false, privateChatVisible: false, video: { id, url: `https://www.douyin.com/video/${id}`, title: `合成作品${id}`, author: '合成作者', duration: 20, time, paused: false, readyState: 4, ...extra } });
function observed(f, id = '100001', extra = {}) { return f.memory.recordObservation(state(id, 0, extra), { source: 'api', kind: 'dom' }); }
function viewing(f, evidence, from, to, sampleId = 'sample:one') { return f.memory.recordViewing({ evidenceId: evidence.evidenceId, from: state(evidence.videoId, from), to: state(evidence.videoId, to), wallSeconds: to - from, sampleId }, { source: 'api' }); }
function action(f, evidence, value, sampleId = 'action:one') { return f.memory.recordBehavior({ evidenceId: evidence.evidenceId, action: value, confirmed: true, sampleId, ...(value === 'share' ? { operationId: `share:${sampleId}` } : {}) }, { source: 'api' }); }

test('从真实PersonaMemory全量作品证据生成本地日报，保留标题作者链接及覆盖边界', t => {
  const f = fixture(t), evidence = observed(f);
  viewing(f, evidence, 0, 10); action(f, evidence, 'stay');
  f.memory.updateAgentInterests({ evidenceId: evidence.evidenceId, topics: [{ topic: '合成科普', signal: 'like' }], reflection: '合成实际观看证据' }, { source: 'api' });
  const generated = f.report.generate({ reason: 'watch-finished' });
  assert.equal(generated.date, '2026-10-16'); assert.equal(generated.changed, true);
  assert.equal(generated.observedCount, 1); assert.equal(generated.verifiedProgressSeconds, 10);
  assert.equal(generated.actions.stay, 1); assert.equal(generated.interestCount, 1);
  assert.equal(generated.folder, path.join(f.root, 'memory', 'reports', 'videos'));
  assert.match(generated.markdown, /合成作品100001/); assert.match(generated.markdown, /合成作者/);
  assert.match(generated.markdown, /https:\/\/www\.douyin\.com\/video\/100001/);
  assert.match(generated.markdown, /不是全天观看总时长/); assert.match(generated.markdown, /不代表今天新产生的兴趣/);
  assert.equal(f.report.read({ date: generated.date }).markdown, fs.readFileSync(generated.path, 'utf8'));
  assert.equal(f.report.state().today.date, '2026-10-16');
});

test('完整来源超过快照20条仍不丢作品；没有可信观看进度时不假记时长', t => {
  const f = fixture(t); for (let index = 0; index < 25; index++) observed(f, String(100100 + index));
  const report = f.report.generate();
  assert.equal(f.memory.snapshot().recentObservations.length, 20);
  assert.equal(report.observedCount, 25); assert.equal(report.observationCount, 25); assert.equal(report.verifiedProgressSeconds, 0);
  assert.match(report.markdown, /证据不足，待观察/);
});

test('只用当日进度与行为评估题材，历史累计喜欢不冒充当天新喜欢', t => {
  const f = fixture(t); f.clock(Date.parse('2026-10-15T04:00:00Z'));
  const evidence = observed(f); viewing(f, evidence, 0, 10, 'yesterday'); action(f, evidence, 'stay', 'yesterday-stay');
  f.memory.updateAgentInterests({ evidenceId: evidence.evidenceId, topics: [{ topic: '合成旧兴趣', signal: 'like' }], reflection: '昨日合成留存' }, { source: 'api' });
  f.clock(Date.parse('2026-10-16T04:00:00Z'));
  assert.equal(f.report.generate().observedCount, 0); assert.equal(f.report.generate().interestCount, 0);
  viewing(f, evidence, 10, 12, 'today'); action(f, evidence, 'skip', 'today-skip');
  const current = f.report.generate();
  assert.equal(current.observationCount, 0); assert.equal(current.verifiedProgressSeconds, 2);
  assert.equal(current.actions.stay, 0); assert.equal(current.actions.skip, 1);
  assert.match(current.markdown, /0 条作品有正向依据、1 条有快划依据/);
  assert.equal(f.memory.snapshot().interests[0].signal, 'like');
});

test('同日重叠进度不重复累计，暂停和拖动样本不计；确认分享单独列证据', t => {
  const f = fixture(t), evidence = observed(f);
  viewing(f, evidence, 0, 5, 'first'); viewing(f, evidence, 3, 8, 'overlap');
  f.memory.recordViewing({ evidenceId: evidence.evidenceId, from: state(evidence.videoId, 8, { paused: true }), to: state(evidence.videoId, 10, { paused: true }), wallSeconds: 2, sampleId: 'paused' }, { source: 'api' });
  f.memory.recordViewing({ evidenceId: evidence.evidenceId, from: state(evidence.videoId, 8), to: state(evidence.videoId, 18), wallSeconds: 1, sampleId: 'seek' }, { source: 'api' });
  action(f, evidence, 'share', 'confirmed-share');
  const report = f.report.generate(); assert.equal(report.verifiedProgressSeconds, 8); assert.equal(report.actions.share, 1);
  assert.match(report.markdown, /有正向行为依据/);
});

test('报告只读取state与报告自身，不读取角色卡、QQ、快照、兴趣反思或用户偏好正文', t => {
  const f = fixture(t); observed(f);
  const source = JSON.parse(fs.readFileSync(f.memory.stateFile, 'utf8'));
  source.userPreferences = [{ text: '不应出现在日报的私密偏好' }]; source.privateChat = '不应出现在日报的私信';
  fs.writeFileSync(f.memory.stateFile, JSON.stringify(source));
  f.memory.readFiles = () => assert.fail('日报不能调用会读取角色卡的readFiles');
  f.memory.snapshot = () => assert.fail('日报不能调用人格快照');
  const original = fs.readFileSync, reads = [];
  fs.readFileSync = function(file, ...args) { reads.push(String(file)); return original.call(this, file, ...args); };
  let report;
  try { report = f.report.generate(); } finally { fs.readFileSync = original; }
  assert.equal(reads.includes(f.memory.roleCardFile), false);
  assert.equal(reads.some(file => /shared\.sqlite|QQ|never-read-legacy/.test(file)), false);
  assert.equal(report.markdown.includes('不应出现在日报'), false);
  source.userPreferences.push({ text: '另一条私密偏好' }); source.generation++;
  fs.writeFileSync(f.memory.stateFile, JSON.stringify(source));
  assert.equal(f.report.generate().changed, false);
});

test('事实不变时重复生成幂等；手编正文、元数据和非管理文件都保留并报冲突', t => {
  const f = fixture(t); observed(f); const first = f.report.generate();
  f.clock(f.now() + 10_000); const repeated = f.report.generate({ reason: 'watch-finished' });
  assert.equal(repeated.changed, false); assert.equal(repeated.generatedAt, first.generatedAt); assert.equal(repeated.markdown, first.markdown);
  const edited = first.markdown + '\n用户的合成批注'; fs.writeFileSync(first.path, edited);
  assert.throws(() => f.report.generate(), error => error.code === 'DAILY_REPORT_CONFLICT');
  assert.equal(fs.readFileSync(first.path, 'utf8'), edited); assert.equal(f.report.state().today.conflict, true);
  fs.writeFileSync(first.path, first.markdown.replace('"observedCount":1', '"observedCount":999'));
  assert.throws(() => f.report.read({ date: first.date }), error => error.code === 'DAILY_REPORT_CONFLICT');
  fs.writeFileSync(first.path, '合成用户自己写的日报');
  assert.throws(() => f.report.generate(), error => error.code === 'DAILY_REPORT_CONFLICT');
  assert.equal(fs.readFileSync(first.path, 'utf8'), '合成用户自己写的日报');
});

test('严格上海日期、路径穿越、损坏来源和未知生成原因不会覆盖旧报告', t => {
  const f = fixture(t); observed(f); const first = f.report.generate();
  for (const date of ['../secrets', '2026-02-30', '2026-1-01', '2026-10-17', '2026-10-16/../../private']) assert.throws(() => f.report.generate({ date }));
  assert.throws(() => f.report.generate({ reason: 'model-request' }));
  fs.writeFileSync(f.memory.stateFile, '{损坏的合成来源');
  assert.throws(() => f.report.generate(), error => error.code === 'DAILY_REPORT_SOURCE');
  assert.equal(fs.readFileSync(first.path, 'utf8'), first.markdown);
  assert.equal(fs.existsSync(path.join(first.folder, '.daily-report.guard')), false);
});

test('符号链接和跨入口生成锁不被跟随或自动清除', t => {
  const f = fixture(t); observed(f); const first = f.report.generate();
  const destination = path.join(f.root, 'outside'); fs.mkdirSync(destination);
  const linked = path.join(f.root, 'linked-memory'); fs.symlinkSync(path.join(f.root, 'memory'), linked, 'junction');
  const linkedReport = new DailyReport({ personaMemory: { personaFolder: path.join(linked, 'persona'), stateFile: path.join(linked, 'persona', 'state.json') }, now: f.now });
  assert.throws(() => linkedReport.generate(), error => error.code === 'DAILY_REPORT_PATH');
  const guard = path.join(first.folder, '.daily-report.guard'); fs.writeFileSync(guard, '合成外来锁');
  assert.throws(() => f.report.generate(), error => error.code === 'DAILY_REPORT_BUSY'); assert.equal(fs.readFileSync(guard, 'utf8'), '合成外来锁');
  fs.unlinkSync(guard);
  fs.unlinkSync(first.path); fs.symlinkSync(destination, first.path, 'junction');
  assert.throws(() => f.report.generate(), error => error.code === 'DAILY_REPORT_PATH');
  assert.equal(fs.existsSync(path.join(destination, 'secret.md')), false);
});
