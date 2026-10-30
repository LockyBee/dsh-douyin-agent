import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatAgent } from '../chat-agent.mjs';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZxkAAAAASUVORK5CYII=';
const id = '1234567890123456789';
const message = { id: 'synthetic-shared-message', sender: 'incoming', media: { type: 'shared-work', title: '合成分享作品' } };
const frame = (time, extra = {}) => ({ mimeType: 'image/png', data: pixel, videoId: id, time, ...extra });

async function requestFor(observation) {
  let request;
  const agent = new ChatAgent({ config: { apiKey: '' }, replyProvider: async value => { request = value; return { text: '合成回复。' }; } });
  await agent.reply({ messages: [message], mediaObservations: [{ messageId: message.id, media: message.media, ...observation }] });
  const parts = request.messages.at(-1).content;
  return { request, parts, summary: JSON.parse(parts.find(part => part.type === 'text' && part.text.startsWith('{')).text) };
}

test('长浏览器状态不截断实际采样时长，三帧视频和一张封面完整交给回复模型', async () => {
  const observation = { understandingScope: 'card-cover-and-timed-video-sampling',
    frames: [{ mimeType: 'image/png', data: pixel }, frame(2.73), frame(10.31), frame(0.23)],
    sharedWork: { videoId: id, title: '合成可讨论标题', author: '合成作者',
      state: { visibleText: 'PRIVATE_BROWSER_STATE_'.repeat(10_000), privateOtherProperty: 'PRIVATE_CONTACT_DETAIL' },
      observation: { actualWallSeconds: 26.187, requestedSeconds: 3, seconds: 3, captureMethod: 'cdp-page-screenshot-interval-v1', beforeTime: 2.73, afterTime: 0.23 } },
    note: '合成说明：真实采样约26秒，不能称为看完整条视频。' };
  const { request, parts, summary } = await requestFor(observation);
  assert.equal(summary.videoSampling.actualWallSeconds, 26.187);
  assert.equal(summary.videoSampling.requestedSeconds, 3);
  assert.equal(summary.videoSampling.captureMethod, 'cdp-page-screenshot-interval-v1');
  assert.equal(summary.videoSampling.frameCount, 4); assert.equal(summary.videoSampling.videoFrameCount, 3);
  assert.deepEqual(summary.videoSampling.frames.map(row => row.time), [null, 2.73, 10.31, 0.23]);
  assert.equal(summary.understandingScope, observation.understandingScope);
  assert.match(summary.videoSampling.interpretation, /没有音频.*不能据此声称看完整条视频/);
  assert.match(summary.videoSampling.interpretation, /requestedSeconds 是请求值，不是实际观看时长/);
  assert.equal(parts.filter(part => part.type === 'image_url').length, 4);
  assert.ok(parts.filter(part => part.type === 'image_url').every(part => part.image_url.url === `data:image/png;base64,${pixel}`));
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE_BROWSER_STATE|PRIVATE_CONTACT_DETAIL/);
});

test('旧三秒scope兼容，但没有实际wall时不把请求三秒冒充成实际观看时长', async () => {
  const { parts, summary } = await requestFor({ understandingScope: 'card-cover-and-three-second-video-sampling', frames: [frame(2), frame(3.5), frame(5)],
    sharedWork: { videoId: id, observation: { seconds: 3, beforeTime: 2, afterTime: 5 } }, note: '旧采样的合成说明。' });
  assert.equal(summary.understandingScope, 'card-cover-and-three-second-video-sampling');
  assert.equal(summary.videoSampling.requestedSeconds, 3); assert.equal(summary.videoSampling.actualWallSeconds, null);
  assert.equal(parts.filter(part => part.type === 'image_url').length, 3);
  assert.match(summary.videoSampling.interpretation, /actualWallSeconds 为空时，本次未提供实际经过时间/);
});

test('超长标题与备注有界，重要范围和时长声明保留且逐帧区间仍可核对', async () => {
  const { summary } = await requestFor({ understandingScope: 'card-cover-and-timed-video-sampling', frames: [frame(10.1, { timeSemantics: 'capture-before-boundary', captureInterval: { before: { time: 10.1, privateProof: 'PRIVATE_PROOF' }, after: { time: 0.4 }, privateProof: 'PRIVATE_PROOF' } })],
    sharedWork: { videoId: id, title: '题'.repeat(20_000), author: '名'.repeat(20_000), observation: { actualWallSeconds: 14.9, requestedSeconds: 3, captureMethod: 'cdp-page-screenshot-interval-v1' } }, note: '说'.repeat(30_000) });
  assert.equal(summary.sharedWork.title.length, 400); assert.equal(summary.sharedWork.author.length, 120); assert.equal(summary.note.length, 600);
  assert.equal(summary.videoSampling.actualWallSeconds, 14.9);
  assert.deepEqual(summary.videoSampling.frames[0].captureInterval, { beforeTime: 10.1, afterTime: 0.4 });
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_PROOF/); assert.match(summary.videoSampling.interpretation, /没有音频/);
  assert.ok(JSON.stringify(summary).length < 2500);
});

test('普通图片观察保留类型、说明与画面，不附带整个任意状态对象', async () => {
  let request;
  const image = { id: 'synthetic-image', sender: 'incoming', media: { type: 'image' } };
  const agent = new ChatAgent({ config: { apiKey: '' }, replyProvider: async value => { request = value; return { text: '合成图片回复。' }; } });
  await agent.reply({ messages: [image], mediaObservations: [{ messageId: image.id, media: image.media, understandingScope: 'single-message-image', frames: [{ mimeType: 'image/png', data: pixel }], note: '合成图片观察', state: { text: 'PRIVATE_STATE' } }] });
  const parts = request.messages.at(-1).content, text = parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.match(text, /single-message-image|合成图片观察/); assert.doesNotMatch(text, /PRIVATE_STATE/);
  assert.equal(parts.filter(part => part.type === 'image_url').length, 1);
});
