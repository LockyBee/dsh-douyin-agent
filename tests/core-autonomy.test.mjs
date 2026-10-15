import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserController } from '../core.mjs';
import { ApiAgent, WATCH_SYSTEM_PROMPT } from '../api-agent.mjs';
import { AutonomousWatch } from '../autonomous-watch.mjs';
import { VideoLimits } from '../video-limits.mjs';
import { createNativeWatchDecision } from '../native-watch-decision.mjs';
import { PersonaMemory } from '../persona-memory.mjs';

const run = promisify(execFile);
const ID = '7770000000000000001';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-core-autonomy-synthetic-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('douyin-core-autonomy-synthetic-')) throw new Error('合成自主测试清理路径不符。');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const stateDir = path.join(root, 'state'); fs.mkdirSync(stateDir);
  return { root, stateDir };
}
function state(extra = {}) {
  return { url: `https://www.douyin.com/video/${ID}`, loginRequired: false, verificationRequired: false, privateChatVisible: false,
    video: { id: ID, url: `https://www.douyin.com/video/${ID}`, title: '合成作品：折纸小船', author: '合成作者', time: 1, duration: 12, readyState: 4, paused: false, viewport: { x: 0, y: 0, width: 200, height: 300 } }, ...extra };
}
function capture() { return { state: state(), frames: [{ mimeType: 'image/jpeg', data: '/9j/2Q==', videoId: ID, time: 1 }], observation: { videoId: ID } }; }
function gateController(source, stateDir) {
  const controller = new BrowserController({ source, videoLimits: { stateDir } });
  const admitted = Object.assign(new Error('合成门禁已放行，测试在任何浏览器操作前停止。'), { code: 'SYNTHETIC_ADMITTED' });
  controller.watchVideoLimits = () => { throw admitted; };
  return controller;
}

test('活跃自主锁拒绝普通 API/DSH 视频动作，只放行完全匹配的 runId', async t => {
  const f = fixture(t), owner = { version: 1, pid: process.pid, runId: '合成现有轮次', sessionId: '合成视频轮次', source: 'api' };
  fs.writeFileSync(path.join(f.stateDir, 'watch-loop.lock'), JSON.stringify(owner));
  for (const source of ['api', 'dsh']) {
    const controller = gateController(source, f.stateDir);
    for (const options of [{}, { autonomousRunId: '另一轮合成轮次' }]) await assert.rejects(controller.execute('douyin_next', {}, options), { status: 409 });
    await assert.rejects(controller.execute('douyin_next', {}, { autonomousRunId: owner.runId }), { code: 'SYNTHETIC_ADMITTED' });
  }
  assert.equal(fs.existsSync(path.join(f.stateDir, 'watch-stop.request.json')), false);
});

test('普通暂停先写精确运行轮次的合作停止请求，不延长时钟或替换自主锁', async t => {
  const f = fixture(t), owner = { version: 1, pid: process.pid, runId: '只停止这一轮', sessionId: '保留原时钟', source: 'dsh' };
  const lockFile = path.join(f.stateDir, 'watch-loop.lock'), original = JSON.stringify(owner);
  fs.writeFileSync(lockFile, original);
  const before = Date.now();
  await assert.rejects(gateController('api', f.stateDir).execute('douyin_pause'), { code: 'SYNTHETIC_ADMITTED' });
  const request = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'watch-stop.request.json'), 'utf8'));
  assert.equal(request.runId, owner.runId);
  assert.ok(request.requestedAt >= before && request.requestedAt <= Date.now());
  assert.deepEqual(Object.keys(request).sort(), ['requestedAt', 'runId']);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), original);
  assert.equal(fs.readdirSync(f.stateDir).some(file => file.endsWith('.tmp')), false);
});

test('DSH 普通视频动作持有共享手动 lease，异步动作期间另一入口不能启动自主观看', async t => {
  const f = fixture(t), videoLimits = new VideoLimits({ stateDir: f.stateDir });
  videoLimits.markSession('dsh', { explicit: true });
  const watch = new AutonomousWatch({ stateDir: f.stateDir, source: 'api', videoLimits,
    controller: { execute: async () => { throw new Error('合成测试禁止真实浏览器'); }, pauseForLimits: async () => ({ paused: 0 }) },
    personaMemory: { context: () => '合成共同人格', initialize() {} }, decisionProvider: async () => { throw new Error('合成测试禁止模型'); },
  });
  const controller = new BrowserController({ source: 'dsh', videoLimits });
  controller.watchVideoLimits = () => {};
  controller.checkVideoLimits = async () => {
    assert.throws(() => watch.start({ startSession: false }, { explicit: true }), { status: 409 });
    throw Object.assign(new Error('合成测试在真实连接前停止'), { code: 'SYNTHETIC_NO_CONNECT' });
  };
  try { await assert.rejects(controller.execute('douyin_next'), { code: 'SYNTHETIC_NO_CONNECT' }); }
  finally { await watch.stop({ explicit: true }); }
  assert.equal(fs.existsSync(path.join(f.stateDir, 'watch-manual.lock')), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'watch-loop.lock')), false);
});

test('合成捕获：外站、私信覆盖或截图后出现验证均不登记人格证据', async () => {
  for (const states of [
    [state({ url: null, unsupportedPage: true, video: null })],
    [state({ privateChatVisible: true })],
    [state(), state(), state({ verificationRequired: true })],
  ]) {
    let reads = 0, screenshots = 0, registrations = 0;
    const controller = Object.create(BrowserController.prototype);
    Object.assign(controller, { source: 'api', state: async () => structuredClone(states[Math.min(reads++, states.length - 1)]),
      checkVideoLimits: async () => {}, page: { screenshot: async () => { screenshots++; return Buffer.from([255, 216, 255, 217]); } },
      getPersonaMemory: () => ({ recordObservation() { registrations++; throw new Error('保护画面不能登记'); } }),
    });
    const output = await controller.capture(0);
    assert.equal(registrations, 0);
    assert.deepEqual(output.frames, []);
    if (states.length === 1) assert.equal(screenshots, 0);
    assert.equal(output.personaEvidenceId, undefined);
  }
});

test('合成捕获：仅把通过截后核验的同作品帧登记，并返回该 evidenceId', async () => {
  let recorded;
  const controller = Object.create(BrowserController.prototype);
  Object.assign(controller, { source: 'dsh', state: async () => state(), checkVideoLimits: async () => {},
    page: { screenshot: async () => Buffer.from([255, 216, 255, 217]) },
    getPersonaMemory: () => ({ recordObservation(value, options) { recorded = { value: structuredClone(value), options }; return { evidenceId: 'video:合成证据标记' }; } }),
  });
  const output = await controller.capture(0);
  assert.equal(output.personaEvidenceId, 'video:合成证据标记');
  assert.equal(recorded.value.frames[0].videoId, ID);
  assert.equal(recorded.value.observation.videoId, ID);
  assert.deepEqual(recorded.options, { source: 'dsh', kind: 'visual' });
});

test('API 与 DSH 的 core.getPersonaMemory 经同一临时定位器共用人格文件，无需打开 SQLite', async t => {
  const f = fixture(t), memoryDir = path.join(f.root, 'memory'), location = path.join(f.root, 'runtime-location.json');
  fs.writeFileSync(location, JSON.stringify({ version: 1, stateDir: f.stateDir, memoryDir, memoryDbPath: path.join(memoryDir, 'custom-shared.sqlite') }));
  fs.mkdirSync(path.join(memoryDir, 'persona'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'persona', 'role-card.md'), '合成初始人格卡，不读取本机旧卡。');
  const script = `
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    import {BrowserController} from ${JSON.stringify(new URL('../core.mjs', import.meta.url).href)};
    const left=new BrowserController({source:'api'}), right=new BrowserController({source:'dsh'});
    const a=left.getPersonaMemory(), b=right.getPersonaMemory();
    assert.equal(a.personaFolder,b.personaFolder);
    const initial=a.snapshot(); a.saveManualText({text:'合成共同人格：说话简洁。',expectedRevision:initial.revision},{explicit:true});
    assert.match(b.context(),/合成共同人格/);
    assert.equal(left.browser,null);assert.equal(right.browser,null);assert.equal(left.memory,undefined);assert.equal(right.memory,undefined);
    console.log(JSON.stringify({sameCard:a.roleCardFile===b.roleCardFile,manual:b.snapshot().manualText,dbCreated:fs.existsSync(process.env.DEEPSEEK_SHARED_MEMORY_DB)}));
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { timeout: 15_000,
    env: { ...process.env, DOUYIN_RUNTIME_LOCATION_FILE: location, DOUYIN_STATE_DIR: '', DEEPSEEK_SHARED_MEMORY_DB: path.join(memoryDir, 'custom-shared.sqlite'), DSH_HOME: path.join(f.root, 'unrelated-host') },
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.sameCard, true); assert.equal(result.manual, '合成共同人格：说话简洁。'); assert.equal(result.dbCreated, false);
});

test('真实 ApiAgent 到原生 decisionProvider 接线可处理固定 system 消息，只调用合成 LLM', async () => {
  let streams = 0, attachments = 0;
  const decisionProvider = createNativeWatchDecision({
    agent: { options: { provider: '合成provider', model: '合成视觉模型' }, session: { id: '合成DSH会话' } },
    attachments: { saveImages: async () => { attachments++; return [{ attachmentId: `synthetic:${attachments}` }]; } },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['image'] }), async *stream(request) {
      streams++; assert.equal(request.system, WATCH_SYSTEM_PROMPT); assert.ok(request.messages.every(message => message.role !== 'system'));
      yield { type: 'text-delta', text: JSON.stringify({ action: 'stop', reason: '合成画面证据足够测试接口。', topics: [], reflection: '不执行真实动作。' }) };
      yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } },
  });
  const agent = new ApiAgent({ controller: { execute: async () => { throw new Error('测试禁止浏览器'); } }, config: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: '合成模型' } });
  const output = await agent.decideWatch({ observation: capture(), context: '合成共同人格', decisionProvider });
  assert.equal(output.decision.action, 'stop'); assert.equal(streams, 1); assert.equal(attachments, 1); assert.equal(output.usage.totalTokens, 5);
  await assert.rejects(decisionProvider({ system: WATCH_SYSTEM_PROMPT, messages: [{ role: 'system', content: '合成恶意改写规则' }] }), /系统提示不一致/);
  assert.equal(streams, 1);
});

test('无有效视频轮次时仍只读返回共享自主状态，不触浏览器、模型、SQLite或真实人格', async t => {
  const f = fixture(t), memoryDir = path.join(f.root, 'isolated-persona-memory');
  const personaMemory = new PersonaMemory({ memoryDir, legacyRoleCardFile: path.join(f.root, 'absent-legacy-role-card.md') });
  const videoLimits = new VideoLimits({ stateDir: f.stateDir });
  assert.equal(videoLimits.state().allowed, false); assert.equal(videoLimits.state().session, null);
  let requests = 0, connections = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('状态查询不得发起模型或网络请求。'); });
  const controllers = ['api', 'dsh'].map(source => {
    const controller = new BrowserController({ source, videoLimits, personaMemory });
    controller.connect = async () => { connections++; throw new Error('状态查询不得打开浏览器。'); };
    controller.watchVideoLimits = () => { throw new Error('状态查询不得进入视频执行流程。'); };
    controller.checkVideoLimits = async () => { throw new Error('状态查询不得要求有效视频轮次。'); };
    controller.store = () => { throw new Error('状态查询不得打开共享SQLite。'); };
    return controller;
  });
  const before = fs.readdirSync(f.root, { recursive: true }).sort();
  for (const controller of controllers) {
    const status = await controller.execute('douyin_watch_status');
    assert.equal(status.protocol, 'autonomous-watch-v1'); assert.equal(status.running, false); assert.equal(status.remainingSeconds, 0);
    assert.equal(status.counts.requests, 0); assert.equal(status.counts.maxRequests, 30);
  }
  assert.deepEqual(fs.readdirSync(f.root, { recursive: true }).sort(), before);

  const sessionId = 'synthetic-shared-session', runId = 'synthetic-external-owner';
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const records = {
    'watch-loop.lock': { version: 1, pid: process.pid, runId, sessionId, source: 'dsh', status: 'running' },
    'watch-budget.json': { version: 1, sessions: { [sessionId]: { requests: 7, maxRequests: 9 } }, days: { [date]: 7 } },
    'watch-state.json': { status: 'running', sessionId, lastDecision: { action: 'stay', reason: '合成来源状态', seconds: 2 } },
  };
  for (const [file, value] of Object.entries(records)) fs.writeFileSync(path.join(f.stateDir, file), JSON.stringify(value));
  for (const controller of controllers) {
    const status = await controller.execute('douyin_watch_status');
    assert.equal(status.running, true); assert.equal(status.owned, false); assert.equal(status.worker.runId, runId); assert.equal(status.worker.source, 'dsh');
    assert.equal(status.counts.requests, 7); assert.equal(status.counts.maxRequests, 9); assert.equal(status.counts.dailyRequests, 7);
    assert.equal(status.lastDecision.reason, '合成来源状态'); assert.equal(status.remainingSeconds, 0);
    assert.equal(controller.browser, null); assert.equal(controller.memory, undefined);
  }
  for (const [file, value] of Object.entries(records)) assert.equal(fs.readFileSync(path.join(f.stateDir, file), 'utf8'), JSON.stringify(value));
  assert.equal(requests, 0); assert.equal(connections, 0); assert.equal(fs.existsSync(memoryDir), false);
});
