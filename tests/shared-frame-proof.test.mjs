import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '../core.mjs';
import { ChatService } from '../chat-service.mjs';
import { ChatAgent } from '../chat-agent.mjs';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPEkAAAAASUVORK5CYII=';
let issuedSample;
function fixture({ kind = 'loop' } = {}) {
  const started = performance.now(), duration = 1.3, baseTime = 1.1;
  let closed = 0, disposed = 0, screenshotCount = 0, stateReads = 0;
  const media = () => {
    const elapsed = (performance.now() - started) / 1000;
    return { connected: true, time: kind === 'static' ? 0.2 : (baseTime + elapsed) % duration, duration, paused: kind === 'paused', readyState: 4, loop: true, playbackRate: 1, seeking: kind === 'seeking', decodedFrames: kind === 'static' ? 10 : 10 + Math.floor(elapsed * 30), documentTimeOrigin: 1000000, pageTimeMs: performance.now(), source: 'https://synthetic.invalid/video.mp4', viewport: { x: 1, y: 1, width: 100, height: 100 } };
  };
  const handle = { evaluate: async fn => { if (fn.name === 'videoCanvasFrame') return { corsBlocked: true }; const value = media(); if (kind === 'seek-jump' && screenshotCount > 0) value.time = (value.time + 0.8) % duration; return value; }, dispose: async () => { disposed++; } };
  const session = { send: async name => { assert.equal(name, 'Page.captureScreenshot'); screenshotCount++; return { data: pixel }; }, detach: async () => { closed++; } };
  const controller = Object.create(core.BrowserController.prototype);
  controller.source = 'api'; controller.page = { context: () => ({ newCDPSession: async () => session }) };
  controller.currentVideo = async () => ({ elementHandle: async () => handle });
  controller.checkVideoLimits = async () => {};
  controller.state = async options => { assert.equal(options.record, false); stateReads++; return { video: { id: kind === 'changed' && screenshotCount ? '999' : '12345', time: media().time, duration, paused: false, readyState: 4, viewport: { x: 1, y: 1, width: 100, height: 100 } }, videoSelection: { identityConflict: false }, loginRequired: false, verificationRequired: false, privateChatVisible: false }; };
  return { controller, state: () => ({ closed, disposed, screenshotCount, stateReads }) };
}

test('共享采样原生proof接受同作品实际推进跨loop，保留逐帧区间和真实墙钟时间', async t => {
  const f = fixture(), result = await f.controller.captureSharedFrames(3);
  assert.equal(core.verifySharedVideoFrameProof(result, '12345'), true);
  assert.equal(result.frames.length, 3); assert.ok(result.frames[1].time < result.frames[0].time || result.frames[2].time < result.frames[1].time);
  assert.ok(result.observation.actualWallSeconds >= 2.8); assert.ok(result.observation.actualWallSeconds < 10);
  assert.equal(result.frames[0].timeSemantics, 'capture-before-boundary'); assert.equal(result.frameProof.issuer, 'dafeiyu-shared-video-capture-v1');
  assert.deepEqual(f.state(), { closed: 1, disposed: 1, screenshotCount: 3, stateReads: 7 });
  const alternate = await import('../core.mjs?shared-frame-proof-alternate'); assert.equal(alternate.verifySharedVideoFrameProof(result, '12345'), true, '同进程不同query模块复用宿主登记');
  for (const value of [structuredClone(result), JSON.parse(JSON.stringify(result)), { ...result }]) assert.equal(core.verifySharedVideoFrameProof(value, '12345'), false, '复制或伪造JSON不能获得宿主签发资格');
  assert.equal(core.verifySharedVideoFrameProof(result, 'different'), false);
  result.frames[0].data = pixel.slice(0, -4) + 'AAAA'; assert.equal(core.verifySharedVideoFrameProof(result, '12345'), false, '签发后改画面使原proof失效');
  result.frames[0].data = pixel;
  const originalWallSeconds = result.observation.actualWallSeconds;
  for (const [edit, undo] of [
    [() => result.frames.reverse(), () => result.frames.reverse()],
    [() => result.observation.actualWallSeconds = originalWallSeconds + 1, () => result.observation.actualWallSeconds = originalWallSeconds],
    [() => result.frameProof.issuer = 'unknown', () => result.frameProof.issuer = 'dafeiyu-shared-video-capture-v1'],
    [() => result.state.video.id = '999', () => result.state.video.id = '12345'],
    [() => result.state.video.paused = true, () => result.state.video.paused = false],
    [() => result.state.privateChatVisible = true, () => result.state.privateChatVisible = false],
  ]) { edit(); assert.equal(core.verifySharedVideoFrameProof(result, '12345'), false); undo(); }
  const now = performance.now.bind(performance), clock = t.mock.method(performance, 'now', () => now() + 61_000);
  assert.equal(core.verifySharedVideoFrameProof(result, '12345'), false, '过期宿主原对象也不能重放'); clock.mock.restore();
  assert.equal(core.verifySharedVideoFrameProof(result, '12345'), true); issuedSample = result;
});

test('共享采样在暂停、seek、静止播放头、大跳或截图后变片时拒绝且释放句柄', async () => {
  for (const kind of ['paused', 'seeking', 'static', 'seek-jump', 'changed']) {
    const f = fixture({ kind }); await assert.rejects(f.controller.captureSharedFrames(3), /采样|播放|作品|推进|画面|视频/);
    assert.equal(f.state().closed, f.state().screenshotCount ? 1 : 0, kind); assert.equal(f.state().disposed, 1, kind);
  }
});

test('共享proof要求宿主原返回对象，未知issuer或单张封面不能伪装', () => {
  assert.equal(core.verifySharedVideoFrameProof({ frameProof: { issuer: 'unknown' }, frames: [{ data: pixel, videoId: '12345', time: 1 }] }, '12345'), false);
});

test('内部采样模式不接受工具伪造，资源创建取消后的迟到句柄仍释放', async () => {
  const controller = new core.BrowserController({ source: 'api' });
  await assert.rejects(controller.execute('douyin_observe', { seconds: 3 }, { sharedCaptureMode: 'shared-video-frame-capture' }), /宿主授权/);
  const f = fixture(), abort = new AbortController(); let detached = 0;
  f.controller.page.context = () => ({ newCDPSession: () => { abort.abort(new Error('合成资源创建取消')); return new Promise(resolve => setTimeout(() => resolve({ detach: async () => detached++ }), 10)); } });
  await assert.rejects(f.controller.captureSharedFrames(3, abort.signal), /合成资源创建取消/);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(detached, 1); assert.equal(f.state().disposed, 1);
});

test('真实服务保留宿主跨loop三帧，模型接收全部画面和有界真实时长声明', async t => {
  assert.ok(issuedSample); const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-shared-proof-service-'));
  const contact = { id: `conv:${'1'.repeat(64)}`, name: '合成许可群', followed: false, isGroup: true, identityVerified: true, identityBinding: `binding:${'2'.repeat(64)}`, identityVersion: 2, identityKind: 'rendered-group', identityHash: '1'.repeat(64) };
  const rows = [], sent = [], requests = [], memberId = `member:${'4'.repeat(64)}`;
  const browser = { listContacts: async () => ({ contacts: [structuredClone(contact)] }), readConversation: async () => ({ contact: structuredClone(contact), conversation: { id: contact.id, isGroup: true }, messages: structuredClone(rows) }), sendMessage: async (id, text) => { sent.push(text); return { confirmed: true, messageId: 'synthetic-sent' }; }, captureMessage: async (id, messageId) => ({ messageId, frames: [{ mimeType: 'image/png', data: pixel }], media: { type: 'shared-work' } }), openSharedVideo: async () => ({ url: 'https://www.douyin.com/video/12345', videoId: '12345', opened: false }) };
  const config = { apiKey: 'synthetic-fixture-key' };
  const agent = new ChatAgent({ config, replyProvider: async request => { requests.push(request); return { text: '合成视频采样回复' }; } });
  const service = new ChatService({ browser, config, agent, videoLimits: { state: () => ({ allowed: true }) }, observeSharedWork: async () => issuedSample, stateDir: directory });
  service.videoInspector = async () => assert.fail('已有受控分享观察器，不创建多余控制器');
  t.after(async () => { await service.close(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.match(path.basename(directory), /^douyin-shared-proof-service-/); fs.rmSync(directory, { recursive: true, force: true }); });
  await service.configure({ recipientIds: [contact.id], allowConversationOnly: true }); await service.start({ schedule: false });
  rows.push({ id: 'synthetic-work', sender: 'incoming', memberId, eligibleForReply: true, text: '', kind: 'video', media: { type: 'shared-work', videoId: '12345', url: 'https://www.douyin.com/video/12345' } }, { id: 'synthetic-ask', sender: 'incoming', memberId, eligibleForReply: true, text: '大肥鱼，看看上面的视频' });
  await service.poll(); assert.equal(sent.length, 1); assert.equal(requests.length, 1);
  const parts = requests[0].messages.at(-1).content; assert.equal(parts.filter(part => part.type === 'image_url').length, 4);
  const metadata = parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.match(metadata, /card-cover-and-timed-video-sampling/); assert.match(metadata, /actualWallSeconds/); assert.match(metadata, /分时|采样/); assert.match(metadata, /没有音频|无音频/); assert.match(metadata, /不代表看完整|不能.*看完/);
});
