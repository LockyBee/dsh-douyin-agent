import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AutonomousShare } from '../autonomous-share.mjs';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';

const friend = `conv:${'a'.repeat(64)}`, other = `conv:${'b'.repeat(64)}`;
const stateFor = (videoId = '12345') => ({ url: `https://www.douyin.com/video/${videoId}`, loginRequired: false, verificationRequired: false, privateChatVisible: false, video: { id: videoId, url: `https://www.douyin.com/video/${videoId}`, title: '合成作品', author: '合成作者', time: 3, duration: 60, paused: false, readyState: 4 } });
const receipt = videoId => ({ confirmed: true, deliveryUncertain: false, deliveryType: 'native-card', videoId, operationId: 'synthetic-forward-receipt', messageId: 'synthetic-card-message' });

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-auto-share-')), stateDir = path.join(root, 'state');
  let now = Date.parse('2026-10-15T04:00:00Z');
  const clock = () => now;
  const personaMemory = new PersonaMemory({ memoryDir: path.join(root, 'memory'), legacyRoleCardFile: path.join(root, 'absent-role.md'), clock }); personaMemory.initialize();
  const videoLimits = new VideoLimits({ stateDir, now: clock });
  videoLimits.savePolicy({ windows: ['00:00-24:00'], sessionMinutes: 60 }, { explicit: true }); videoLimits.markSession('api', { explicit: true });
  const contacts = [friend, other].map((id, index) => ({ id, name: `合成好友${index + 1}`, followed: true, isGroup: false, verifiedAt: '2026-10-15T01:00:00Z' }));
  fs.writeFileSync(path.join(stateDir, 'chat-policy.json'), JSON.stringify({ version: 1, enabled: false, allowlist: contacts }));
  const calls = [];
  const send = options.send || (async (input, controls) => { calls.push({ input, controls }); assert.deepEqual(Object.keys(input).sort(), ['expectedVideoId', 'recipientId']); controls.authorize({ phase: 'prepare', recipientId: input.recipientId, videoId: input.expectedVideoId }); controls.authorize({ phase: 'before-click', recipientId: input.recipientId, videoId: input.expectedVideoId }); return receipt(input.expectedVideoId); });
  const service = new AutonomousShare({ personaMemory, videoLimits, send, stateDir, now: clock });
  const evidence = (videoId = '12345') => ({ evidenceId: personaMemory.recordObservation(stateFor(videoId), { source: 'api' }).evidenceId, videoId, recipientId: friend, reason: '合成选择理由，只存本机。' });
  t.after(async () => { await service.close(); const target = path.resolve(root); assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(target, { recursive: true, force: true }); });
  return { root, stateDir, personaMemory, videoLimits, service, evidence, calls, contacts, clock, setNow: value => { now = value; } };
}

test('自主分享默认关闭，模型不能改策略，只显示已验证的两位好友', async t => {
  const f = fixture(t), input = f.evidence();
  assert.equal(f.service.state().enabled, false); assert.equal(f.service.state().dailyLimit, 3);
  assert.equal(f.service.context().enabled, false); assert.equal(f.service.context().recipients.length, 2);
  assert.throws(() => f.service.configure({ enabled: true }), /用户/);
  for (const body of [{ enabled: true, dailyLimit: 0 }, { enabled: true, dailyLimit: 21 }, { enabled: true, recipientId: friend }, { enabled: 'true' }]) assert.throws(() => f.service.configure(body, { explicit: true }));
  await assert.rejects(f.service.share(input), /尚未启用/); assert.equal(f.calls.length, 0);
  f.service.configure({ enabled: true }, { explicit: true });
  assert.deepEqual(f.service.context().recipients, f.contacts.map(({ id, name }) => ({ id, name })));
  assert.equal(fs.existsSync(path.join(f.stateDir, 'share-ledger.json')), false);
});

test('观察证据、同一作品及现有白名单是发送前提，不接受任意链接或正文', async t => {
  const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true }, { explicit: true });
  for (const changed of [{ ...input, videoId: '999' }, { ...input, evidenceId: `video:${'0'.repeat(64)}` }, { ...input, recipientId: `conv:${'c'.repeat(64)}` }, { ...input, url: 'https://www.douyin.com/video/999' }, { ...input, text: '不能附带正文' }]) await assert.rejects(f.service.share(changed));
  assert.equal(f.calls.length, 0); assert.equal(f.service.state().daily.attempts, 0);
  const record = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'chat-policy.json'))); record.allowlist.push({ ...record.allowlist[0], id: `conv:${'d'.repeat(64)}` }); fs.writeFileSync(path.join(f.stateDir, 'chat-policy.json'), JSON.stringify(record));
  await assert.rejects(f.service.share(input), /两位|白名单/); assert.equal(f.calls.length, 0);
});

test('启用后无需逐次确认即可发送作品卡片，跨入口持久预算并按好友与作品去重', async t => {
  const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true, dailyLimit: 2 }, { explicit: true });
  const sessionsBefore = fs.readFileSync(f.videoLimits.sessionsFile, 'utf8');
  const sent = await f.service.share(input); assert.equal(sent.confirmed, true); assert.equal(sent.messageId, 'synthetic-card-message'); assert.ok(sent.operationId); assert.equal(f.calls[0].controls.humanAuthorized, undefined);
  assert.equal(JSON.stringify(f.calls[0].input).includes(input.reason), false);
  await assert.rejects(f.service.share(input), /重复/); assert.equal(f.calls.length, 1);
  const second = new AutonomousShare({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, send: async () => { throw new Error('不应进入第三次发送'); }, stateDir: f.stateDir, now: f.clock });
  assert.equal(second.state().daily.attempts, 1); await second.close();
  await f.service.share({ ...input, recipientId: other }); assert.equal(f.service.state().daily.remaining, 0);
  await assert.rejects(f.service.share(f.evidence('67890')), /上限/); assert.equal(f.calls.length, 2);
  f.service.configure({ enabled: false }, { explicit: true }); f.service.configure({ enabled: true }, { explicit: true }); assert.equal(f.service.state().daily.attempts, 2);
  assert.equal(fs.readFileSync(f.videoLimits.sessionsFile, 'utf8'), sessionsBefore);
});

test('发送前重新读取开关、时限、白名单和证据，取消时不点击', async t => {
  for (const mutation of ['disabled', 'expired', 'allowlist', 'evidence']) {
    let f;
    f = fixture(t, { send: async (input, controls) => {
      controls.authorize({ phase: 'prepare', recipientId: input.recipientId, videoId: input.expectedVideoId });
      if (mutation === 'disabled') new AutonomousShare({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, send: async () => {}, stateDir: f.stateDir, now: f.clock }).configure({ enabled: false }, { explicit: true });
      if (mutation === 'expired') f.setNow(f.clock() + 61 * 60_000);
      if (mutation === 'allowlist') fs.writeFileSync(path.join(f.stateDir, 'chat-policy.json'), JSON.stringify({ allowlist: [] }));
      if (mutation === 'evidence') f.personaMemory.snapshot = () => ({ recentObservations: [] });
      controls.authorize({ phase: 'before-click', recipientId: input.recipientId, videoId: input.expectedVideoId });
      assert.fail('核验失败后不得点击');
    } });
    f.service.configure({ enabled: true }, { explicit: true }); await assert.rejects(f.service.share(f.evidence()));
    assert.equal(f.service.ledger().operations[0].status, 'not-sent'); assert.equal(f.service.state().busy, false);
  }
});

test('未确认结果跨重启保持暂停；人工核对只解除暂停，不退预算或重发旧片', async t => {
  const f = fixture(t, { send: async (input, controls) => { controls.authorize({ phase: 'before-click', recipientId: input.recipientId, videoId: input.expectedVideoId }); return { confirmed: false, deliveryUncertain: true, deliveryType: 'native-card', operationId: 'synthetic-uncertain' }; } });
  f.service.configure({ enabled: true }, { explicit: true }); const input = f.evidence(), result = await f.service.share(input);
  assert.equal(result.deliveryUncertain, true); assert.equal(f.service.state().paused, true);
  const restarted = new AutonomousShare({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, stateDir: f.stateDir, now: f.clock });
  assert.equal(restarted.state().paused, true); assert.equal(restarted.state().needsReview[0].forwardOperationId, 'synthetic-uncertain');
  await assert.rejects(restarted.share(f.evidence('67890')), /未确认/);
  restarted.configure({ enabled: false }, { explicit: true }); assert.throws(() => restarted.configure({ enabled: true }, { explicit: true }), /核对/);
  assert.throws(() => restarted.resolve({ operationId: result.operationId, outcome: 'not-sent' }), /用户/);
  restarted.resolve({ operationId: result.operationId, outcome: 'not-sent' }, { explicit: true }); assert.equal(restarted.state().paused, false); assert.equal(restarted.state().daily.attempts, 1);
  restarted.configure({ enabled: true }, { explicit: true }); await assert.rejects(restarted.share(input), /重复/); await restarted.close();
});

test('自主观看运行编号和有限轮次必须一致，停止请求禁止发送', async t => {
  const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true }, { explicit: true });
  const lock = { version: 1, pid: process.pid, source: 'api', runId: 'synthetic-watch', sessionId: f.videoLimits.state().session.id };
  fs.writeFileSync(path.join(f.stateDir, 'watch-loop.lock'), JSON.stringify(lock));
  await assert.rejects(f.service.share(input), /共享观看/); await assert.rejects(f.service.share(input, { watchRunId: 'wrong-run' }), /共享观看/);
  fs.writeFileSync(path.join(f.stateDir, 'watch-stop.request.json'), JSON.stringify({ runId: lock.runId })); await assert.rejects(f.service.share(input, { watchRunId: lock.runId }), /停止/);
  fs.unlinkSync(path.join(f.stateDir, 'watch-stop.request.json'));
  assert.equal((await f.service.share(input, { watchRunId: lock.runId })).confirmed, true); assert.equal(f.calls[0].controls.autonomousRunId, lock.runId);
});

test('上海日期更新只重置新日计数，旧日同片同人去重和不确定暂停保留', async t => {
  const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true, dailyLimit: 1 }, { explicit: true });
  f.setNow(Date.parse('2026-10-15T15:59:00Z')); f.videoLimits.markSession('api', { explicit: true }); await f.service.share(input); assert.equal(f.service.state().daily.date, '2026-10-15');
  f.setNow(Date.parse('2026-10-15T16:01:00Z')); assert.equal(f.service.state().daily.date, '2026-10-16'); assert.equal(f.service.state().daily.remaining, 1);
  await assert.rejects(f.service.share(input), /重复/); await f.service.share(f.evidence('67890')); assert.equal(f.service.state().daily.attempts, 1);
});

test('没有官方卡片或可信点击检查时不宣称成功，不向联系人发送解释或链接', async t => {
  for (const outcome of [{ needsFallback: true, confirmed: false, deliveryUncertain: false }, receipt('12345')]) {
    const f = fixture(t, { send: async (input, controls) => { if (outcome.needsFallback) controls.authorize({ phase: 'prepare', videoId: input.expectedVideoId, recipientId: input.recipientId }); return outcome; } });
    f.service.configure({ enabled: true }, { explicit: true }); const result = await f.service.share(f.evidence());
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, !outcome.needsFallback);
  }
});

test('真实子进程持有共享发送锁时另一入口不能分享，关闭只取消自己的发送', { timeout: 15000 }, async t => {
  const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true }, { explicit: true });
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../autonomous-share.mjs', import.meta.url))).href;
  const workerFile = path.join(f.root, 'synthetic-share-worker.mjs');
  fs.writeFileSync(workerFile, `import {AutonomousShare} from ${JSON.stringify(moduleUrl)};\nconst service=new AutonomousShare({stateDir:process.env.TEST_SHARE_STATE,personaMemory:{snapshot:()=>({recentObservations:JSON.parse(process.env.TEST_SHARE_EVIDENCE)})},videoLimits:{state:()=>JSON.parse(process.env.TEST_SHARE_TIME)},now:()=>Number(process.env.TEST_SHARE_NOW),send:async(input,{authorize,signal})=>{authorize({phase:'prepare',videoId:input.expectedVideoId,recipientId:input.recipientId});process.send({ready:true});await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});\nprocess.on('message',async message=>{if(message==='stop'){await service.close();process.exit(0);}});\nservice.share(JSON.parse(process.env.TEST_SHARE_INPUT)).catch(()=>{});`);
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir|temp|tmp|comspec|pathext)$/i.test(key)));
  const child = fork(workerFile, [], { env: { ...childEnv, TEST_SHARE_STATE: f.stateDir, TEST_SHARE_EVIDENCE: JSON.stringify(f.personaMemory.snapshot().recentObservations), TEST_SHARE_TIME: JSON.stringify(f.videoLimits.state()), TEST_SHARE_NOW: String(f.clock()), TEST_SHARE_INPUT: JSON.stringify(input) }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child, 'message'); assert.equal(f.service.state().busy, true);
  await assert.rejects(f.service.share(f.evidence('67890')), /未确认|分享/); await f.service.close(); assert.equal(child.exitCode, null);
  child.send('stop'); const [exitCode] = await once(child, 'exit'); assert.equal(exitCode, 0); assert.equal(f.service.state().busy, false); assert.equal(f.service.state().daily.attempts, 1);
});

test('异常退出遗留预留收据会暂停，损坏账本和发送锁不会自动清除', async t => {
  const f = fixture(t), input = f.evidence(); f.service.configure({ enabled: true }, { explicit: true });
  fs.writeFileSync(f.service.files.send, JSON.stringify({ pid: 2147483647, token: 'dead-owner' }));
  fs.writeFileSync(f.service.files.ledger, JSON.stringify({ version: 1, days: { '2026-10-15': 1 }, operations: [{ operationId: 'interrupted-send', ...input, source: 'api', pid: 2147483647, status: 'reserved', day: '2026-10-15' }] }));
  assert.equal(f.service.state().paused, true); assert.equal(f.service.state().recoveryRequired, true);
  f.service.resolve({ operationId: 'interrupted-send', outcome: 'not-sent' }, { explicit: true }); assert.equal(f.service.state().paused, false); assert.equal(f.service.state().daily.attempts, 1);
  fs.writeFileSync(f.service.files.ledger, '{broken'); await assert.rejects(f.service.share(f.evidence('67890')), /记录/); assert.equal(fs.readFileSync(f.service.files.ledger, 'utf8'), '{broken');
});

test('真实合成分享面板通过可信授权发送官方卡片，撤回授权与JSON伪造不能点击', { timeout: 15000 }, async t => {
  const [{ chromium }, { VideoForwarder }, { readPageState }] = await Promise.all([import('../playwright-runtime.mjs'), import('../video-forward.mjs'), import('../core.mjs?v=8')]);
  const browser = await chromium.launch({ channel: 'msedge', headless: true }); t.after(() => browser.close());
  for (const revoked of [true, false]) {
    const f = fixture(t), page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>' }));
    await page.setContent('<div data-e2e="video-share-icon-container" style="width:300px;height:100px">分享<div data-e2e="video-share-container"><div data-e2e="share-friend-row"><img src="https://synthetic.invalid/aweme-avatar/friend.png" width="24" height="24"><span data-e2e="share-friend-name">合成好友1</span><button data-e2e="share-friend-send">分享</button></div></div></div>');
    await page.evaluate(() => { window.sendCount = 0; document.querySelector('button').addEventListener('click', () => { window.sendCount++; }); });
    const realEvaluate = page.evaluate.bind(page); page.evaluate = (fn, arg) => fn === readPageState ? Promise.resolve(stateFor()) : realEvaluate(fn, arg);
    let gates = 0, verified = 0;
    const controller = { source: 'api', withPage: async (action, options) => { assert.equal(options.autonomousRunId, undefined); return action(page); }, pauseForLimits: async () => {}, settle: async () => { throw new Error('自主分享不能导航另一作品'); } };
    const contact = { id: friend, name: '合成好友1', displayName: '合成好友1', avatar: 'https://synthetic.invalid/aweme-avatar/friend.png', followed: true, isGroup: false };
    const chatBrowser = { contacts: new Map([[friend, contact]]), listContacts: async ({ verifyFollowing }) => { assert.equal(verifyFollowing, true); verified++; return { contacts: [contact] }; }, readConversation: async () => ({ conversation: { id: friend }, messages: await realEvaluate(() => window.sendCount) ? [{ id: 'synthetic-real-dom-card', sender: 'outgoing', arrivalClassification: 'new-tail', media: { type: 'shared-work', videoId: '12345' } }] : [] }), sendMessage: async () => { throw new Error('不能发送正文或链接'); } };
    const forwarder = new VideoForwarder({ controller, chatBrowser, stateDir: f.stateDir, videoLimits: { beforeAction: () => { gates++; if (revoked && gates === 4) f.service.configure({ enabled: false }, { explicit: true }); return { allowed: true }; } } });
    const forged = await forwarder.forwardAutonomous({ recipientId: friend, expectedVideoId: '12345' }, { authorize: true }); assert.equal(forged.confirmed, false); assert.equal(verified, 0);
    await assert.rejects(forwarder.forwardAutonomous({ recipientId: friend, expectedVideoId: '12345', url: 'https://www.douyin.com/video/999' }, { authorize: () => true }), /不能指定/);
    f.service.send = undefined; f.service.getForwarder = async () => forwarder; f.service.configure({ enabled: true }, { explicit: true });
    if (revoked) { await assert.rejects(f.service.share(f.evidence()), /关闭|启用/); assert.equal(await realEvaluate(() => window.sendCount), 0); }
    else { const result = await f.service.share(f.evidence()); assert.equal(result.confirmed, true); assert.equal(result.messageId, 'synthetic-real-dom-card'); assert.equal(await realEvaluate(() => window.sendCount), 1); assert.equal(f.service.ledger().operations[0].forwardOperationId, forwarder.receipts().operations[0].operationId); }
    assert.equal(verified, 1); await page.close();
  }
});

test('真实临时 Edge：1200ms 按钮等待中跨入口关闭、换作品或换好友均不产生点击', { timeout: 30000 }, async t => {
  const [{ chromium }, { VideoForwarder }] = await Promise.all([import('../playwright-runtime.mjs'), import('../video-forward.mjs')]);
  for (const mutation of ['disabled', 'video', 'recipient']) {
    const f = fixture(t), profile = path.join(f.root, 'isolated-edge-profile');
    let owner, client, timer;
    try {
      owner = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] });
      await owner.route('**/*', route => route.fulfill(route.request().resourceType() === 'document' ? { contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body>
        <section data-e2e="feed-active-video"><div data-e2e="player-container" class="video_12345"><video muted autoplay style="width:240px;height:320px"></video></div><span data-e2e="video-desc">合成测试作品</span></section>
        <div data-e2e="video-share-icon-container" style="position:fixed;left:300px;top:30px;width:500px;height:250px"><span class="s7K4YLGp" style="display:block;width:50px;height:40px">分享</span><div data-e2e="video-share-container"><div data-e2e="share-friend-row"><img src="https://synthetic.invalid/aweme-avatar/friend.png" width="24" height="24"><span data-e2e="share-friend-name">合成好友1</span><button data-e2e="share-friend-send">分享</button></div></div></div>
        <script>window.sendCount=0;document.querySelector('button').onclick=()=>window.sendCount++;const canvas=document.createElement('canvas');canvas.width=240;canvas.height=320;const draw=()=>{const c=canvas.getContext('2d');c.fillStyle='#143447';c.fillRect(0,0,240,320)};draw();const video=document.querySelector('video');video.srcObject=canvas.captureStream(15);void video.play();setInterval(draw,60);</script></body></html>` } : { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>' }));
      const inspectionPage = owner.pages()[0]; await inspectionPage.goto('https://www.douyin.com/video/12345');
      await inspectionPage.waitForFunction(() => document.querySelector('video').readyState >= 2);
      const port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      assert.ok(port >= 1024 && port !== 9227, '只连接本测试自动分配的临时 CDP 端口');
      client = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const page = client.contexts()[0].pages().find(page => page.url().includes('/video/12345'));
      const controller = { source: 'api', pauseForLimits: async () => {}, withPage: async (action, { signal }) => {
        signal.throwIfAborted();
        const cancel = () => { void client.close().catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        try { return await action(page); } finally { signal.removeEventListener('abort', cancel); }
      } };
      const contact = { id: friend, name: '合成好友1', displayName: '合成好友1', avatar: 'https://synthetic.invalid/aweme-avatar/friend.png', followed: true, isGroup: false };
      const chatBrowser = { contacts: new Map([[friend, contact]]), listContacts: async () => ({ contacts: [contact] }), readConversation: async () => ({ conversation: { id: friend }, messages: [] }) };
      const forwarder = new VideoForwarder({ controller, chatBrowser, stateDir: f.stateDir, videoLimits: f.videoLimits });
      const foreign = new AutonomousShare({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, stateDir: f.stateDir, now: f.clock });
      const changed = Promise.withResolvers(); let scheduled = false, wasAnimating = false, successfullyDisabled = false;
      f.service.send = async (input, controls) => {
        const authorize = async request => {
          const result = controls.authorize(request);
          if (request.phase === 'monitor' && !scheduled) {
            scheduled = true;
            await inspectionPage.evaluate(() => { window.pendingAnimation = document.querySelector('button').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 1200, fill: 'forwards' }); });
            timer = setTimeout(async () => {
              try {
                wasAnimating = await inspectionPage.evaluate(() => window.pendingAnimation.playState === 'running');
                if (mutation === 'disabled') successfullyDisabled = foreign.configure({ enabled: false }, { explicit: true }).enabled === false;
                else await inspectionPage.evaluate(kind => {
                  if (kind === 'video') { document.querySelector('[data-e2e="player-container"]').className = 'video_67890'; history.replaceState(null, '', '/video/67890'); }
                  else { document.querySelector('[data-e2e="share-friend-name"]').textContent = '合成其他好友'; document.querySelector('[data-e2e="share-friend-row"] img').src = 'https://synthetic.invalid/aweme-avatar/other.png'; }
                }, mutation);
                changed.resolve();
              } catch (error) { changed.reject(error); }
            }, 100);
          }
          return result;
        };
        authorize.beginDispatch = controls.authorize.beginDispatch;
        return forwarder.forwardAutonomous(input, { ...controls, authorize });
      };
      f.service.configure({ enabled: true }, { explicit: true });
      const output = await f.service.share(f.evidence()).then(result => ({ result }), error => ({ error }));
      await changed.promise;
      assert.equal(wasAnimating, true, `${mutation} 必须发生在真实按钮仍等待稳定时`);
      if (mutation === 'disabled') assert.equal(successfullyDisabled, true, '另一个入口已经成功关闭许可');
      assert.ok(output.error, '最终输入前中止，不能宣称成功');
      assert.equal(client.isConnected(), false, '取消只断开这项操作的 CDP 客户端');
      assert.equal(inspectionPage.isClosed(), false, '临时 Edge 与页面仍可由独立检查连接读取');
      await inspectionPage.waitForTimeout(1350);
      assert.equal(await inspectionPage.evaluate(() => window.sendCount), 0, `${mutation} 后动画结束也不能出现延迟发送`);
      assert.equal(f.service.ledger().operations[0].status, 'not-sent');
      await foreign.close();
    } finally { clearTimeout(timer); await client?.close().catch(() => {}); await owner?.close(); }
  }
});

test('最终短输入与设置互斥，忙时不伪报关闭成功，释放后正常撤回', async t => {
  let f;
  f = fixture(t, { send: async (input, { authorize }) => {
    authorize({ phase: 'before-click', recipientId: input.recipientId, videoId: input.expectedVideoId });
    const release = authorize.beginDispatch();
    const foreign = new AutonomousShare({ personaMemory: f.personaMemory, videoLimits: f.videoLimits, stateDir: f.stateDir, now: f.clock });
    try { assert.throws(() => foreign.configure({ enabled: false }, { explicit: true }), /正在更新/); assert.equal(f.service.policy().enabled, true); }
    finally { release(); }
    assert.equal(foreign.configure({ enabled: false }, { explicit: true }).enabled, false);
    return { confirmed: false, deliveryUncertain: true };
  } });
  f.service.configure({ enabled: true }, { explicit: true });
  const result = await f.service.share(f.evidence());
  assert.equal(result.deliveryUncertain, true); assert.equal(f.service.state().enabled, false); assert.equal(f.service.state().paused, true);
  assert.equal(fs.existsSync(f.service.files.control), false);
});

test('真实合成输入：点击后正常禁用按钮仍可核对卡片，缺少回执则保留 uncertain', { timeout: 15000 }, async t => {
  const [{ chromium }, { VideoForwarder }, { readPageState }] = await Promise.all([import('../playwright-runtime.mjs'), import('../video-forward.mjs'), import('../core.mjs?v=8')]);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const hasReceipt of [true, false]) {
      const f = fixture(t), page = await browser.newPage();
      await page.route('**/*', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>' }));
      await page.setContent('<div data-e2e="video-share-icon-container" style="width:400px;height:200px">分享<div data-e2e="video-share-container"><div data-e2e="share-friend-row"><img src="https://synthetic.invalid/aweme-avatar/friend.png" width="24" height="24"><span data-e2e="share-friend-name">合成好友1</span><button data-e2e="share-friend-send">分享</button></div></div></div>');
      await page.evaluate(() => {
        window.sendCount = 0;
        document.querySelector('button').onclick = event => {
          window.sendCount++; window.trustedClick = event.isTrusted;
          event.currentTarget.textContent = '已发送'; event.currentTarget.disabled = true;
          const end = performance.now() + 120; while (performance.now() < end) {}
        };
      });
      const realEvaluate = page.evaluate.bind(page); page.evaluate = (fn, arg) => fn === readPageState ? Promise.resolve(stateFor()) : realEvaluate(fn, arg);
      const controller = { source: 'api', pauseForLimits: async () => {}, withPage: async (action, { signal }) => {
        const cancel = () => { void page.close(); }; signal.addEventListener('abort', cancel, { once: true });
        try { return await action(page); } finally { signal.removeEventListener('abort', cancel); }
      } };
      const contact = { id: friend, name: '合成好友1', displayName: '合成好友1', avatar: 'https://synthetic.invalid/aweme-avatar/friend.png', followed: true, isGroup: false };
      const chatBrowser = { contacts: new Map([[friend, contact]]), listContacts: async () => ({ contacts: [contact] }), readConversation: async () => ({ conversation: { id: friend }, messages: hasReceipt && await realEvaluate(() => window.sendCount) ? [{ id: 'synthetic-confirmed-after-ui-change', sender: 'outgoing', arrivalClassification: 'new-tail', media: { type: 'shared-work', videoId: '12345' } }] : [] }) };
      const forwarder = new VideoForwarder({ controller, chatBrowser, stateDir: f.stateDir, videoLimits: f.videoLimits });
      f.service.send = undefined; f.service.getForwarder = async () => forwarder; f.service.configure({ enabled: true }, { explicit: true });
      const input = f.evidence(), result = await f.service.share(input);
      assert.equal(result.confirmed, hasReceipt); assert.equal(result.deliveryUncertain, !hasReceipt);
      assert.equal(await realEvaluate(() => window.sendCount), 1); assert.equal(await realEvaluate(() => window.trustedClick), true);
      assert.equal(await page.locator('button').isDisabled(), true);
      assert.equal(fs.existsSync(f.service.files.control), false);
      await assert.rejects(f.service.share(input), /重复|未确认/);
      assert.equal(await realEvaluate(() => window.sendCount), 1);
      await page.close();
    }
  } finally { await browser.close(); }
});
