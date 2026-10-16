import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicCommentAgent, PUBLIC_COMMENT_PROMPT } from '../public-comment-agent.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGDkAAAAASUVORK5CYII=';
const videoId = '7579432563794584933';
function observation() { return { state: { url: `https://www.douyin.com/video/${videoId}`, loginRequired: false, privateChatVisible: false, secret: 'PRIVATE_STATE_SENTINEL', conversation: 'PRIVATE_CHAT_SENTINEL', video: { id: videoId, title: '合成画面：青色与金色', author: '合成作者', time: 4, duration: 30, privateData: 'PRIVATE_VIDEO_SENTINEL', url: 'PRIVATE_URL_SENTINEL' } }, frames: [{ mimeType: 'image/png', data: PNG, videoId, time: 4 }], viewing: { extra: 'PRIVATE_VIEW_SENTINEL' }, context: 'PRIVATE_PERSONA_SENTINEL', persona: 'PRIVATE_INTEREST_SENTINEL' }; }
const answer = text => ({ text: JSON.stringify({ text }), usage: { total_tokens: 3 } });

test('公开评论请求仅含有限视频白名单和实际帧，不带人格、兴趣、私信及任意状态字段', async () => {
  let seen; const agent = new PublicCommentAgent();
  const result = await agent.generate({ observation: observation(), decisionProvider: async request => { seen = request; return answer('这个青金配色很舒服。'); } });
  assert.equal(result.text, '这个青金配色很舒服。'); assert.deepEqual(result.usage, { total_tokens: 3 }); assert.equal(seen.system, PUBLIC_COMMENT_PROMPT);
  const serialized = JSON.stringify(seen.messages); assert.doesNotMatch(serialized, /PRIVATE_[A-Z_]+_SENTINEL/); assert.match(serialized, /合成画面：青色与金色/); assert.match(serialized, /合成作者/); assert.match(serialized, /没有音频/);
  assert.equal(seen.messages.length, 2); assert.equal(seen.messages[1].content.length, 2); assert.equal(seen.messages[1].content[1].image_url.url, `data:image/png;base64,${PNG}`);
  const metadata = JSON.parse(seen.messages[1].content[0].text.match(/采样：(.*)。这些只是/)[1]); assert.deepEqual(Object.keys(metadata).sort(), ['author', 'duration', 'id', 'time', 'title']);
});

test('评论生成允许明确放弃，拒绝其他字段、工具、超长、非JSON和不安全文本', async () => {
  const agent = new PublicCommentAgent(); assert.equal((await agent.generate({ observation: observation(), decisionProvider: async () => answer(null) })).text, null);
  const invalid = [{ text: '{}' }, { text: '[]' }, { text: '{"text":"好看","recipientId":"private"}' }, { text: '看起来不错' }, { text: 'x'.repeat(2001) }, { ...answer('好看'), toolCalls: [{}] }, answer('@合成朋友'), answer('https://example.com'), answer('QQ1234567'), answer('我亲自去过这里'), answer(3)];
  for (const response of invalid) await assert.rejects(agent.generate({ observation: observation(), decisionProvider: async () => response }));
});

test('没有同作品有效画面、私信可见、登录或验证时不会调用评论模型', async () => {
  let calls = 0; const agent = new PublicCommentAgent(), provider = async () => { calls++; return answer('合成评论'); };
  const missing = observation(); missing.frames = [];
  const mismatch = observation(); mismatch.frames[0].videoId = '7579432563794584999';
  const privateView = observation(); privateView.state.privateChatVisible = true;
  const login = observation(); login.state.loginRequired = true;
  const verification = observation(); verification.state.verificationRequired = true;
  for (const value of [missing, mismatch, privateView, login, verification]) await assert.rejects(agent.generate({ observation: value, decisionProvider: provider }));
  assert.equal(calls, 0);
});

test('模型凭据只进入请求头，公开评论原文若含凭据则拒绝', async () => {
  const config = { apiKey: 'synthetic-comment-secret', baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic-comment-model' }; let request;
  const agent = new PublicCommentAgent({ config, fetchImpl: async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: '光影过渡挺柔和。' }) } }], usage: { total_tokens: 7 } })); } });
  const result = await agent.generate({ observation: observation() }); assert.equal(result.text, '光影过渡挺柔和。'); assert.equal(request.url, config.baseUrl + '/chat/completions'); assert.equal(request.options.headers.authorization, `Bearer ${config.apiKey}`); assert.equal(request.options.redirect, 'error'); assert.equal(request.options.body.includes(config.apiKey), false);
  const body = JSON.parse(request.options.body); assert.equal(body.model, config.model); assert.equal(body.stream, false); assert.equal(body.max_tokens, 400); assert.equal(Object.hasOwn(body, 'tools'), false);
  await assert.rejects(agent.generate({ observation: observation(), decisionProvider: async () => answer(config.apiKey) }), /凭据/);
});

test('HTTP失败、截断响应和工具调用均不产生可发布文本', async () => {
  const config = { apiKey: 'synthetic-key', baseUrl: 'https://synthetic.invalid', model: 'synthetic' };
  const responses = [new Response('{}', { status: 429 }), new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"text":"不完整"}' } }] })), new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"text":"好看"}', tool_calls: [{}] } }] }))];
  for (const response of responses) await assert.rejects(new PublicCommentAgent({ config, fetchImpl: async () => response }).generate({ observation: observation() }));
  await assert.rejects(new PublicCommentAgent().generate({ observation: observation() }), /配置/);
});

test('取消在模型返回之前生效；取消后到达的文本不进入发布结果', async () => {
  const abort = new AbortController(), entered = Promise.withResolvers(), finish = Promise.withResolvers(); const agent = new PublicCommentAgent();
  const generating = agent.generate({ observation: observation(), signal: abort.signal, decisionProvider: async () => { entered.resolve(); return finish.promise; } });
  const rejected = assert.rejects(generating, /合成取消/); await entered.promise; abort.abort(new Error('合成取消')); await rejected; finish.resolve(answer('不应迟发的评论'));
  let calls = 0; await assert.rejects(agent.generate({ observation: observation(), signal: abort.signal, decisionProvider: async () => { calls++; return answer('不应执行'); } }), /合成取消/); assert.equal(calls, 0);
});
