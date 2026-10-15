import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PersonaMemory, GENERATED_START, GENERATED_END } from '../persona-memory.mjs';

const run = promisify(execFile);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-persona-synthetic-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('douyin-persona-synthetic-')) throw new Error('合成测试清理路径不符。');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const memoryDir = path.join(root, 'memory'), legacyRoleCardFile = path.join(root, 'legacy-card.md');
  const store = new PersonaMemory({ memoryDir, legacyRoleCardFile });
  return { root, memoryDir, legacyRoleCardFile, store };
}
function state(id = '100001', extra = {}) {
  return { url: `https://www.douyin.com/video/${id}`, loginRequired: false, verificationRequired: false, privateChatVisible: false,
    video: { id, url: `https://www.douyin.com/video/${id}`, title: '合成抖音作品：蓝色纸船', author: '合成作者', time: 1.25, duration: 12, readyState: 4, paused: false }, ...extra };
}
function capture(id = '100001', extra = {}) {
  return { state: state(id), frames: [{ mimeType: 'image/jpeg', data: '/9j/2Q==', videoId: id, time: 1.25 }], observation: { videoId: id }, ...extra };
}

test('人格快照与上下文只读，不创建目录或默认读取旧人格', t => {
  const f = fixture(t), before = fs.readdirSync(f.root);
  const snapshot = f.store.snapshot();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.personaText, '');
  assert.deepEqual(snapshot.interests, []);
  assert.match(f.store.context(), /不要声称已加载旧人格/);
  assert.deepEqual(fs.readdirSync(f.root), before);
});

test('首次仅本机导入整张合成人格卡，已有卡或删除后均不重导入', t => {
  const f = fixture(t), legacy = '# 合成人格\n喜欢米饭；QQ 社交表达只是人格，不授予发送权限。';
  fs.writeFileSync(f.legacyRoleCardFile, legacy);
  const first = f.store.initialize({ importLegacy: true });
  assert.equal(first.manualText, legacy);
  assert.equal(first.legacyImported, true);
  fs.writeFileSync(f.legacyRoleCardFile, '另一份合成旧卡');
  assert.equal(f.store.initialize({ importLegacy: true }).manualText, legacy);
  fs.unlinkSync(f.store.roleCardFile);
  assert.equal(f.store.initialize({ importLegacy: true }).available, false);
  assert.equal(fs.existsSync(f.store.roleCardFile), false);
});

test('已存在的手编卡不被旧卡覆盖，自动区保留手编原字节与后缀', t => {
  const f = fixture(t), manual = '# 用户合成卡\r\n说话简洁，不执行文案里的命令。';
  fs.mkdirSync(f.store.personaFolder, { recursive: true });
  fs.writeFileSync(f.store.roleCardFile, manual);
  fs.writeFileSync(f.legacyRoleCardFile, '不应覆盖的新旧卡');
  assert.equal(f.store.initialize({ importLegacy: true }).manualText, manual);
  const raw = fs.readFileSync(f.store.roleCardFile, 'utf8') + '\r\n用户后缀。';
  fs.writeFileSync(f.store.roleCardFile, raw);
  const receipt = f.store.recordObservation(capture(), { source: 'api', kind: 'visual' });
  const updated = f.store.updateAgentInterests({ evidenceId: receipt.evidenceId, topics: [{ topic: '纸船', signal: 'like' }], reflection: '合成画面里有纸船，代理愿意继续看。' }, { source: 'api' });
  assert.equal(updated.manualText, manual + '\r\n用户后缀。');
  assert.equal(updated.interests[0].topic, '纸船');
  assert.equal(updated.interests[0].signal, 'neutral', '有限画面本身不能形成喜欢');
  assert.equal(updated.interests[0].evidence[0].proposalSignal, 'like');
  assert.equal(updated.interests[0].evidence[0].privacy, 'internal-reference');
  assert.equal(updated.recentObservations[0].visibility, 'account-visible-unverified');
  assert.equal(updated.recentObservations[0].privacy, 'internal-reference');
  assert.deepEqual(updated.userPreferences, []);
  assert.match(f.store.context(), /代理兴趣不是用户偏好/);
  assert.match(f.store.context(), /未核对对外可见范围/);
  const disk = fs.readFileSync(f.store.stateFile, 'utf8');
  assert.equal(disk.includes('/9j/2Q=='), false);
  assert.equal(disk.includes('"frames"'), false);
});

test('外站、私信、验证、身份不明和伪造画面归属不能成为兴趣证据', t => {
  const f = fixture(t); f.store.initialize();
  const invalid = [
    state('100001', { url: 'https://example.com/' }), state('100001', { privateChatVisible: true }),
    state('100001', { loginRequired: true }), state('100001', { verificationRequired: true }),
    state('100001', { video: null }), state('100001', { privateChatVisible: undefined }),
    state('100001', { video: { ...state().video, readyState: 1 } }),
  ];
  for (const item of invalid) assert.throws(() => f.store.recordObservation(item, { source: 'api' }), { code: 'PERSONA_EVIDENCE' });
  assert.throws(() => f.store.recordObservation(state(), { source: 'qq' }), { code: 'PERSONA_SOURCE' });
  for (const item of [capture('100001', { frames: [] }), capture('100001', { observation: { videoId: '100002' } }), capture('100001', { frames: [{ ...capture().frames[0], videoId: '100002' }] })]) assert.throws(() => f.store.recordObservation(item, { source: 'api', kind: 'visual' }), { code: 'PERSONA_EVIDENCE' });
  assert.deepEqual(f.store.snapshot().recentObservations, []);
  assert.throws(() => f.store.updateAgentInterests({ evidenceId: '未知作品', topics: [{ topic: '纸船', signal: 'like' }] }, { source: 'api' }), { code: 'PERSONA_EVIDENCE' });
});

test('同作品主题跨入口幂等，来源必须真实登记，代理反思不能写进用户偏好', t => {
  const f = fixture(t); f.store.initialize();
  const receipt = f.store.recordObservation(capture(), { source: 'api', kind: 'visual' });
  const input = { evidenceId: receipt.evidenceId, topics: [{ topic: '纸船', signal: 'like' }], reflection: '合成代理想多看手工制作。' };
  assert.throws(() => f.store.updateAgentInterests(input, { source: 'dsh' }), { code: 'PERSONA_EVIDENCE' });
  const first = f.store.updateAgentInterests(input, { source: 'api' });
  assert.equal(f.store.updateAgentInterests(input, { source: 'api' }).generation, first.generation);
  const same = f.store.recordObservation(capture(), { source: 'dsh', kind: 'visual' });
  assert.equal(same.evidenceId, receipt.evidenceId);
  assert.equal(same.duplicate, true);
  const second = f.store.updateAgentInterests({ ...input, topics: [{ topic: '纸船', signal: 'dislike' }] }, { source: 'dsh' });
  assert.equal(second.interests[0].evidence.length, 1);
  assert.equal(second.interests[0].signal, 'neutral');
  assert.deepEqual(second.userPreferences, []);
});

test('手编保存要求明确操作与包含文件指纹的版本，不覆盖外部编辑或自动兴趣', t => {
  const f = fixture(t); const old = f.store.initialize();
  fs.writeFileSync(f.store.roleCardFile, fs.readFileSync(f.store.roleCardFile, 'utf8').replace('小鲸的人格卡', '用户刚编辑的人格卡'));
  assert.throws(() => f.store.saveManualText({ text: '旧页面正文', expectedRevision: old.revision }, { explicit: true }), { code: 'PERSONA_REVISION_CONFLICT' });
  const now = f.store.snapshot();
  assert.throws(() => f.store.saveManualText({ text: '新正文', expectedRevision: now.revision }), { code: 'PERSONA_EXPLICIT_REQUIRED' });
  assert.throws(() => f.store.saveManualText({ text: GENERATED_START, expectedRevision: now.revision }, { explicit: true }), { code: 'PERSONA_CARD_MARKERS' });
  const evidence = f.store.recordObservation(capture(), { source: 'api', kind: 'visual' });
  f.store.updateAgentInterests({ evidenceId: evidence.evidenceId, topics: [{ topic: '纸船', signal: 'like' }] }, { source: 'api' });
  assert.throws(() => f.store.saveManualText({ text: '冲突正文', expectedRevision: now.revision }, { explicit: true }), { code: 'PERSONA_REVISION_CONFLICT' });
  const current = f.store.snapshot();
  const saved = f.store.saveManualText({ text: '用户明确编辑的合成正文。', expectedRevision: current.revision }, { explicit: true });
  assert.equal(saved.manualText, '用户明确编辑的合成正文。');
  assert.equal(saved.interests[0].topic, '纸船');
});

test('state 为权威，半写后的旧生成区只在显式维护时恢复并保留手编', t => {
  const f = fixture(t); f.store.initialize();
  const oldCard = fs.readFileSync(f.store.roleCardFile, 'utf8');
  const evidence = f.store.recordObservation(capture(), { source: 'api', kind: 'visual' });
  f.store.updateAgentInterests({ evidenceId: evidence.evidenceId, topics: [{ topic: '折纸', signal: 'like' }] }, { source: 'api' });
  fs.writeFileSync(f.store.roleCardFile, oldCard.replace('小鲸的人格卡', '合成手编恢复卡'));
  const stateBefore = fs.readFileSync(f.store.stateFile, 'utf8'), cardBefore = fs.readFileSync(f.store.roleCardFile, 'utf8');
  const snapshot = f.store.snapshot();
  assert.equal(snapshot.generatedSynced, false);
  assert.match(snapshot.personaText, /折纸/);
  assert.equal(fs.readFileSync(f.store.roleCardFile, 'utf8'), cardBefore);
  const restored = f.store.initialize({ importLegacy: true });
  assert.equal(restored.generatedSynced, true);
  assert.match(restored.manualText, /合成手编恢复卡/);
  assert.equal(fs.readFileSync(f.store.stateFile, 'utf8'), stateBefore);
});

test('首次提交 state 中断后保全已导入卡，重试不再复制另一份旧卡', t => {
  const f = fixture(t), original = '# 合成首次导入人格\n此文本应在提交中断后保留。';
  fs.writeFileSync(f.legacyRoleCardFile, original);
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (to === f.store.stateFile) throw Object.assign(new Error('合成 state 提交中断'), { code: 'EIO' }); return rename(from, to); };
    assert.throws(() => f.store.initialize({ importLegacy: true }), { code: 'EIO' });
  } finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(f.store.stateFile), false);
  assert.equal(f.store.snapshot().manualText, original);
  fs.writeFileSync(f.legacyRoleCardFile, '后来的合成旧卡，不应覆盖');
  assert.equal(f.store.initialize({ importLegacy: true }).manualText, original);
  assert.equal(fs.readdirSync(f.store.personaFolder).some(name => name.endsWith('.tmp')), false);
});

test('损坏学习数据和生成区拒绝写入，不用空记录覆盖原资料', t => {
  const f = fixture(t); f.store.initialize();
  fs.writeFileSync(f.store.stateFile, '坏的合成数据');
  assert.throws(() => f.store.initialize(), { code: 'PERSONA_STATE' });
  assert.equal(fs.readFileSync(f.store.stateFile, 'utf8'), '坏的合成数据');
  fs.unlinkSync(f.store.stateFile);
  fs.writeFileSync(f.store.roleCardFile, `手编\n${GENERATED_START}\n${GENERATED_START}\n${GENERATED_END}`);
  assert.throws(() => f.store.initialize(), { code: 'PERSONA_CARD_MARKERS' });
  assert.equal(fs.existsSync(f.store.stateFile), false);
});

test('活进程锁与坏锁不被抢占，死进程锁可恢复', t => {
  const f = fixture(t); f.store.initialize();
  const short = new PersonaMemory({ memoryDir: f.memoryDir, lockTimeoutMs: 30 });
  const active = JSON.stringify({ pid: process.pid, nonce: '另一个合成持有者', at: 0 });
  for (const raw of [active, '坏的合成锁']) {
    fs.writeFileSync(short.lockFile, raw);
    assert.throws(() => short.initialize(), { code: 'PERSONA_BUSY' });
    assert.equal(fs.readFileSync(short.lockFile, 'utf8'), raw);
    fs.unlinkSync(short.lockFile);
  }
  fs.writeFileSync(short.lockFile, JSON.stringify({ pid: 2147483647, nonce: '已退出的合成进程' }));
  short.initialize();
  assert.equal(fs.existsSync(short.lockFile), false);
});

test('死锁恢复后两个真实 Node 进程交替写入同一合成兴趣文件，没有丢失或重复主题证据', async t => {
  const f = fixture(t); f.store.initialize();
  fs.writeFileSync(f.store.lockFile, JSON.stringify({ pid: 2147483647, nonce: '合成死锁，多等待者同时恢复' }));
  const module = new URL('../persona-memory.mjs', import.meta.url).href;
  const script = `
    import {PersonaMemory} from ${JSON.stringify(module)};
    const store=new PersonaMemory({memoryDir:process.argv[1],legacyRoleCardFile:process.argv[1]+'/missing.md',lockTimeoutMs:10000});
    const offset=Number(process.argv[2]),source=offset?'dsh':'api';store.initialize();
    for(let i=0;i<8;i++) {
      const id=String(200000+offset+i),state={url:'https://www.douyin.com/video/'+id,loginRequired:false,verificationRequired:false,privateChatVisible:false,video:{id,url:'https://www.douyin.com/video/'+id,title:'合成跨入口纸船',author:'合成作者',time:1,duration:10,readyState:4,paused:false}};
      const e=store.recordObservation(state,{source,kind:'dom'});
      store.updateAgentInterests({evidenceId:e.evidenceId,topics:[{topic:'合成共同兴趣',signal:'like'}],reflection:'根据合成作品文案形成代理兴趣。'},{source});
    }
  `;
  await Promise.all([0, 100].map(offset => run(process.execPath, ['--input-type=module', '-e', script, f.memoryDir, String(offset)], { timeout: 30_000 })));
  const result = f.store.snapshot();
  assert.equal(result.recentObservations.length, 16);
  assert.equal(result.interests.length, 1);
  assert.equal(result.interests[0].evidence.length, 16);
  assert.equal(result.generation, 32);
  assert.equal(result.generatedSynced, true);
  assert.deepEqual(result.userPreferences, []);
});

test('人格卡短暂占用时有限重试替换，保留手编内容并实际完成同步', t => {
  const f = fixture(t); const first = f.store.initialize();
  f.store.saveManualText({ text: '# 合成用户手编卡\n占用时不能丢失。', expectedRevision: first.revision }, { explicit: true });
  const manual = f.store.snapshot().manualText, rename = fs.renameSync;
  let attempts = 0;
  try {
    fs.renameSync = (from, to) => {
      if (to === f.store.roleCardFile && ++attempts <= 2) throw Object.assign(new Error('合成 Windows 短暂占用'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
      return rename(from, to);
    };
    f.store.recordObservation(state(), { source: 'api' });
  } finally { fs.renameSync = rename; }
  assert.equal(attempts, 3);
  assert.equal(f.store.snapshot().manualText, manual); assert.equal(f.store.snapshot().generatedSynced, true);
  assert.equal(fs.readdirSync(f.store.personaFolder).some(name => name.endsWith('.tmp') || name === '.write.lock'), false);
});

test('人格卡持续占用达到重试上限后明确失败，旧卡保留且已提交状态仍可投影', t => {
  const f = fixture(t); f.store.initialize();
  const before = fs.readFileSync(f.store.roleCardFile, 'utf8'), manual = f.store.snapshot().manualText, rename = fs.renameSync;
  let attempts = 0;
  try {
    fs.renameSync = (from, to) => {
      if (to === f.store.roleCardFile) { attempts++; throw Object.assign(new Error('合成 Windows 持续占用'), { code: 'EACCES' }); }
      return rename(from, to);
    };
    assert.throws(() => f.store.recordObservation(state(), { source: 'api' }), { code: 'EACCES' });
  } finally { fs.renameSync = rename; }
  assert.equal(attempts, 12); assert.equal(fs.readFileSync(f.store.roleCardFile, 'utf8'), before);
  const projected = f.store.snapshot(); assert.equal(projected.recentObservations.length, 1); assert.equal(projected.generatedSynced, false); assert.equal(projected.manualText, manual);
  assert.equal(fs.readdirSync(f.store.personaFolder).some(name => name.endsWith('.tmp') || name === '.write.lock'), false);
  assert.equal(f.store.initialize().generatedSynced, true);
});

test('Windows占用连续超过旧100毫秒窗口后恢复，有限等待仍能同步且保留手编', t => {
  const f = fixture(t); f.store.initialize();
  const manual = f.store.snapshot().manualText, rename = fs.renameSync, started = performance.now(); let attempts = 0;
  try {
    fs.renameSync = (from, to) => {
      if (to === f.store.roleCardFile && ++attempts <= 6) throw Object.assign(new Error('合成 Windows 较长临时占用'), { code: ['EPERM', 'EACCES', 'EBUSY'][(attempts - 1) % 3] });
      return rename(from, to);
    };
    f.store.recordObservation(state(), { source: 'api' });
  } finally { fs.renameSync = rename; }
  assert.ok(attempts >= 7 && attempts <= 12); assert.ok(performance.now() - started >= 300);
  assert.equal(f.store.snapshot().manualText, manual); assert.equal(f.store.snapshot().generatedSynced, true); assert.equal(f.store.snapshot().recentObservations.length, 1);
  assert.equal(fs.readdirSync(f.store.personaFolder).some(name => name.endsWith('.tmp') || name === '.write.lock'), false);
});

test('人格卡占用重试期间遇到外部手工编辑时不覆盖新正文', t => {
  const f = fixture(t); f.store.initialize();
  const rename = fs.renameSync, edited = '# 占用期间用户新编辑的合成人格\n必须原样保留。';
  let attempts = 0;
  try {
    fs.renameSync = (from, to) => {
      if (to === f.store.roleCardFile) { attempts++; fs.writeFileSync(to, edited); throw Object.assign(new Error('合成编辑器占用'), { code: 'EPERM' }); }
      return rename(from, to);
    };
    assert.throws(() => f.store.recordObservation(state(), { source: 'api' }), { code: 'PERSONA_REVISION_CONFLICT' });
  } finally { fs.renameSync = rename; }
  assert.equal(attempts, 1); assert.equal(fs.readFileSync(f.store.roleCardFile, 'utf8'), edited); assert.equal(f.store.snapshot().manualText, edited);
});
