import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PersonaMemory, BEHAVIOR_THRESHOLDS } from '../persona-memory.mjs';

const run = promisify(execFile);
function state(id = '100001', time = 0, duration = 20, extra = {}) {
  return { url: `https://www.douyin.com/video/${id}`, loginRequired: false, verificationRequired: false, privateChatVisible: false,
    video: { id, url: `https://www.douyin.com/video/${id}`, title: '合成作品：纸船', author: '合成作者', time, duration, readyState: 4, paused: false, ...extra.video }, ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'video')) };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-persona-behavior-synthetic-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('douyin-persona-behavior-synthetic-')) throw new Error('合成行为测试清理路径不符。');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const memoryDir = path.join(root, 'memory'), store = new PersonaMemory({ memoryDir, legacyRoleCardFile: path.join(root, 'missing.md') });
  store.initialize();
  let counter = 0;
  const observe = (id = '100001', duration = 20, source = 'api', time = 0) => store.recordObservation(state(id, time, duration), { source });
  const viewing = (evidence, from, to, wallSeconds, { source = 'api', sampleId = `合成观看:${++counter}`, duration = 20, ...extra } = {}) => store.recordViewing({ evidenceId: evidence.evidenceId, from: state(evidence.videoId, from, duration, extra.from), to: state(evidence.videoId, to, duration, extra.to), wallSeconds, sampleId }, { source });
  const behavior = (evidence, action, { source = 'api', sampleId = `合成互动:${++counter}`, confirmed = true, ...extra } = {}) => store.recordBehavior({ evidenceId: evidence.evidenceId, action, sampleId, confirmed, ...extra }, { source });
  const topic = (evidence, signal = 'like', source = 'api') => store.updateAgentInterests({ evidenceId: evidence.evidenceId, topics: [{ topic: '纸船', signal }], reflection: '这是合成模型的选题提案。' }, { source });
  return { root, memoryDir, store, observe, viewing, behavior, topic };
}

test('合成兴趣：只看到作品或模型声称喜欢都只能待观察，停留请求本身不算观看', t => {
  const f = fixture(t), evidence = f.observe();
  let snapshot = f.topic(evidence);
  assert.equal(snapshot.interests[0].signal, 'neutral');
  assert.equal(snapshot.interests[0].evidence[0].proposalSignal, 'like');
  f.behavior(evidence, 'stay');
  snapshot = f.store.snapshot();
  assert.equal(snapshot.interests[0].signal, 'neutral');
  assert.equal(snapshot.recentObservations[0].watchedSeconds, 0);
  assert.equal(snapshot.recentObservations[0].actions.stay, 1);
  assert.match(snapshot.personaText, /纸船：待观察/);
  assert.match(f.store.context(), /标题、画面和模型提案本身只能记为待观察/);
  assert.deepEqual(snapshot.userPreferences, []);
});

test('合成观看：暂停、卡住、跳跃、回退和虚报墙钟时间不产生观看收益', t => {
  const f = fixture(t), evidence = f.observe('100001', 100);
  const attempts = [
    [1, 2, 1, { from: { video: { paused: true } } }, 'paused'],
    [1, 2, 1, { to: { video: { paused: true } } }, 'paused'],
    [1, 1, 10, {}, 'stalled'], [1, 20, 1, {}, 'seek'], [8, 1, 1, {}, 'rewind'], [1, 2, 0, {}, 'stalled'],
  ];
  for (const [from, to, wall, extra, reason] of attempts) {
    const receipt = f.viewing(evidence, from, to, wall, { duration: 100, ...extra });
    assert.equal(receipt.accepted, false); assert.equal(receipt.creditedSeconds, 0); assert.equal(receipt.reason, reason);
  }
  for (const wall of [-1, 30.001, NaN, Infinity, '8']) assert.throws(() => f.viewing(evidence, 0, 8, wall, { duration: 100 }), { code: 'PERSONA_ARGUMENT' });
  const bounded = f.viewing(evidence, 0, 0.1, 30, { duration: 100 });
  assert.equal(bounded.watchedSeconds, 0.1, '请求三十秒只能按实际前进的零点一秒计');
  f.behavior(evidence, 'stay'); assert.equal(f.topic(evidence).interests[0].signal, 'neutral');
});

test('合成观看：同作品和安全状态须在两端核对，外站、私信、验证与换片拒绝', t => {
  const f = fixture(t), evidence = f.observe();
  const invalid = [
    [state('100002', 0), state('100002', 1)], [state('100001', 0), state('100002', 1)],
    [state('100001', 0, 20, { loginRequired: true }), state('100001', 1)],
    [state('100001', 0), state('100001', 1, 20, { privateChatVisible: true })],
    [state('100001', 0), state('100001', 1, 20, { verificationRequired: true })],
    [state('100001', 0), state('100001', 1, 20, { url: 'https://outside.example/' })],
    [state('100001', 0), state('100001', 1, 50)],
    [state('100001', 0), state('100001', NaN)],
  ];
  for (const [from, to] of invalid) assert.throws(() => f.store.recordViewing({ evidenceId: evidence.evidenceId, from, to, wallSeconds: 1, sampleId: '不能登记' }, { source: 'api' }), { code: 'PERSONA_EVIDENCE' });
  assert.throws(() => f.viewing(evidence, 0, 1, 1, { source: 'dsh' }), { code: 'PERSONA_EVIDENCE' });
  assert.equal(f.store.snapshot().recentObservations[0].watchedSeconds, 0);
});

test('合成观看：重叠区间、重复样本与两个入口不重复累计，同作品后续可升级', t => {
  const f = fixture(t), evidence = f.observe();
  f.topic(evidence); f.behavior(evidence, 'stay');
  const first = f.viewing(evidence, 0, 5, 5, { sampleId: '同一个实际样本' });
  assert.equal(first.watchedSeconds, 5);
  const generation = f.store.snapshot().generation;
  const duplicate = f.viewing(evidence, 0, 5, 5, { sampleId: '同一个实际样本' });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.creditedSeconds, 0); assert.equal(f.store.snapshot().generation, generation);
  assert.throws(() => f.viewing(evidence, 0, 6, 6, { sampleId: '同一个实际样本' }), { code: 'PERSONA_SAMPLE_CONFLICT' });
  f.observe('100001', 20, 'dsh');
  const overlap = f.viewing(evidence, 0, 5, 5, { source: 'dsh' });
  assert.equal(overlap.accepted, false); assert.equal(overlap.reason, 'overlap');
  const extended = f.viewing(evidence, 3, 8, 5, { source: 'dsh' });
  assert.equal(extended.creditedSeconds, 3); assert.equal(extended.watchedSeconds, 8);
  const result = f.topic(evidence, 'dislike', 'dsh');
  assert.equal(result.interests[0].signal, 'like', '模型的相反提案不能覆盖实测行为');
  assert.equal(result.interests[0].evidenceCount, 1);
  assert.equal(result.recentObservations[0].basisCode, 'sustained-watch');
});

test('合成长短观看：阈值按未舍入的进度判断，较完整短片跳过不算讨厌', t => {
  const f = fixture(t);
  assert.equal(BEHAVIOR_THRESHOLDS.sustainedSeconds, 8);
  const cases = [
    ['110001', 100, 7.9999, 'stay', 'neutral'], ['110002', 100, 8, 'stay', 'like'],
    ['110003', 3, 1.9999, 'stay', 'neutral'], ['110004', 3, 2, 'stay', 'like'],
    ['110005', 5, 2.9999, 'stay', 'neutral'], ['110006', 5, 3, 'stay', 'like'],
    ['110007', 100, 3, 'skip', 'dislike'], ['110008', 100, 3.0001, 'skip', 'neutral'],
    ['110009', 3, 3, 'skip', 'neutral'], ['110010', 100, 9, 'skip', 'neutral'],
  ];
  for (const [id, duration, seconds, action, signal] of cases) {
    const evidence = f.observe(id, duration);
    f.viewing(evidence, 0, seconds, seconds, { duration }); f.behavior(evidence, action);
    const result = f.store.snapshot().recentObservations.find(row => row.videoId === id);
    assert.equal(result.signal, signal, `${id} 的边界应为 ${signal}`);
    assert.ok(result.watchRatio >= 0 && result.watchRatio <= 1);
  }
});

test('合成互动：只有确认完成的分享回执是强正向，同操作重放不加权', t => {
  const f = fixture(t), evidence = f.observe();
  for (const action of ['stay', 'skip', 'share']) assert.throws(() => f.behavior(evidence, action, { confirmed: false }), { code: 'PERSONA_BEHAVIOR' });
  assert.throws(() => f.behavior(evidence, 'share'), { code: 'PERSONA_BEHAVIOR' });
  assert.throws(() => f.behavior(evidence, 'share', { operationId: '' }), { code: 'PERSONA_ARGUMENT' });
  f.behavior(evidence, 'skip');
  assert.equal(f.topic(evidence).interests[0].signal, 'neutral', '零观看跳过仍待观察');
  f.behavior(evidence, 'share', { operationId: '实际成功的合成转发', sampleId: '转发样本' });
  const second = f.behavior(evidence, 'share', { operationId: '实际成功的合成转发' });
  assert.equal(second.duplicate, true); assert.equal(second.actions.share, 1); assert.equal(second.signal, 'like');
  const another = f.observe('100002');
  assert.throws(() => f.behavior(another, 'share', { operationId: '实际成功的合成转发' }), { code: 'PERSONA_SAMPLE_CONFLICT' });
  assert.equal(f.store.snapshot().interests[0].evidenceCount, 1);
});

test('合成时长：元数据小幅变动时按较长时长算比例，不提前跨过短片门槛', t => {
  const f = fixture(t), evidence = f.observe('100001', 3);
  f.viewing(evidence, 0, 2, 2, { duration: 3.4 });
  f.behavior(evidence, 'stay');
  const result = f.store.snapshot().recentObservations[0];
  assert.equal(result.watchedSeconds, 2); assert.ok(result.watchRatio < 0.6); assert.equal(result.signal, 'neutral');
});

test('合成倍速容差：实际走过的全部媒体区间均去重，重播尾段不能刷满阈值', t => {
  const f = fixture(t), evidence = f.observe('100001', 100);
  f.behavior(evidence, 'stay');
  const first = f.viewing(evidence, 0, 8, 6.4, { duration: 100 });
  assert.equal(first.watchedSeconds, 6.4);
  const replay = f.viewing(evidence, 6.4, 8, 1.6, { duration: 100 });
  assert.equal(replay.creditedSeconds, 0); assert.equal(replay.watchedSeconds, 6.4); assert.equal(replay.signal, 'neutral');
  assert.equal(f.topic(evidence).interests[0].signal, 'neutral');
});

test('合成作品身份：异常时长观察不能改变已经核对的观看比例', t => {
  const f = fixture(t), evidence = f.observe('100001', 5);
  f.viewing(evidence, 0, 3, 3, { duration: 5 }); f.behavior(evidence, 'stay'); f.topic(evidence);
  assert.equal(f.store.snapshot().interests[0].signal, 'like');
  const before = fs.readFileSync(f.store.stateFile, 'utf8');
  assert.throws(() => f.observe('100001', 100), { code: 'PERSONA_EVIDENCE' });
  assert.equal(fs.readFileSync(f.store.stateFile, 'utf8'), before);
  assert.equal(f.store.snapshot().recentObservations[0].watchRatio, 0.6);
  assert.equal(f.store.snapshot().interests[0].signal, 'like');
});

test('合成主题：不同作品各一票汇总，最后一条和重复模型提案不覆盖整体', t => {
  const f = fixture(t);
  const positive = f.observe('120001'); f.behavior(positive, 'share', { operationId: '合成成功分享一' }); f.topic(positive);
  const negative = f.observe('120002'); f.viewing(negative, 0, 1, 1); f.behavior(negative, 'skip'); f.topic(negative, 'like');
  let topic = f.store.snapshot().interests[0];
  assert.equal(topic.signal, 'neutral'); assert.deepEqual(topic.counts, { like: 1, dislike: 1, neutral: 0 });
  const waiting = f.observe('120003'); f.topic(waiting, 'dislike');
  const before = f.store.snapshot().generation;
  f.topic(negative, 'like'); f.topic(negative, 'like');
  assert.equal(f.store.snapshot().generation, before);
  f.behavior(waiting, 'share', { operationId: '合成成功分享二' });
  topic = f.store.snapshot().interests[0];
  assert.equal(topic.signal, 'like'); assert.deepEqual(topic.counts, { like: 2, dislike: 1, neutral: 0 }); assert.equal(topic.evidenceCount, 3);
});

test('合成旧数据：旧画面喜好只读降为待观察，保留来源、原始提案与手编卡', t => {
  const f = fixture(t), evidence = f.observe(); f.topic(evidence);
  const snapshot = f.store.snapshot();
  f.store.saveManualText({ text: '# 合成用户人格\n我手工写下的偏好不应被自动修改。', expectedRevision: snapshot.revision }, { explicit: true });
  const old = JSON.parse(fs.readFileSync(f.store.stateFile, 'utf8'));
  old.interests[0].signal = 'like'; old.interests[0].evidence[0].signal = 'like';
  delete old.interests[0].evidence[0].assessmentVersion; delete old.interests[0].evidence[0].proposalSignal; delete old.behavior;
  fs.writeFileSync(f.store.stateFile, JSON.stringify(old));
  const beforeState = fs.readFileSync(f.store.stateFile, 'utf8'), beforeCard = fs.readFileSync(f.store.roleCardFile, 'utf8');
  const read = f.store.snapshot();
  assert.equal(read.interests[0].signal, 'neutral'); assert.equal(read.interests[0].evidence[0].legacyProposal, 'like');
  assert.equal(read.interests[0].evidence[0].source, 'api'); assert.equal(read.recentObservations[0].basisCode, 'observation-only');
  assert.match(read.manualText, /我手工写下的偏好不应被自动修改/); assert.match(read.personaText, /纸船：待观察/);
  assert.match(f.store.context(), /"signal":"neutral"/);
  assert.equal(fs.readFileSync(f.store.stateFile, 'utf8'), beforeState); assert.equal(fs.readFileSync(f.store.roleCardFile, 'utf8'), beforeCard);
  f.viewing(evidence, 0, 8, 8); f.behavior(evidence, 'stay');
  assert.equal(f.store.snapshot().interests[0].signal, 'like'); assert.equal(f.store.snapshot().manualText, read.manualText);
});

test('合成跨进程：API 与 DSH 写同一观看区间和样本时只累计一次且保留人格', async t => {
  const f = fixture(t), evidence = f.observe(); f.observe('100001', 20, 'dsh'); f.topic(evidence);
  const module = new URL('../persona-memory.mjs', import.meta.url).href;
  const script = `
    import {PersonaMemory} from ${JSON.stringify(module)};
    const store=new PersonaMemory({memoryDir:process.argv[1],legacyRoleCardFile:process.argv[1]+'/missing.md',lockTimeoutMs:10000});
    const source=process.argv[3],id='100001',state=time=>({url:'https://www.douyin.com/video/'+id,loginRequired:false,verificationRequired:false,privateChatVisible:false,video:{id,url:'https://www.douyin.com/video/'+id,time,duration:20,readyState:4,paused:false}});
    store.recordViewing({evidenceId:process.argv[2],from:state(0),to:state(8),wallSeconds:8,sampleId:'同一个跨进程实际样本'},{source});
    store.recordBehavior({evidenceId:process.argv[2],action:'stay',sampleId:'同一个跨进程停留',confirmed:true},{source});
  `;
  await Promise.all(['api', 'dsh'].map(source => run(process.execPath, ['--input-type=module', '-e', script, f.memoryDir, evidence.evidenceId, source], { timeout: 30_000 })));
  const snapshot = f.store.snapshot();
  assert.equal(snapshot.recentObservations[0].watchedSeconds, 8); assert.equal(snapshot.recentObservations[0].actions.stay, 1);
  assert.equal(snapshot.interests[0].signal, 'like'); assert.equal(snapshot.interests[0].evidenceCount, 1);
  assert.equal(snapshot.generatedSynced, true); assert.deepEqual(snapshot.userPreferences, []);
});
