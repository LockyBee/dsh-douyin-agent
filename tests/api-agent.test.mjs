import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ApiAgent, DEFAULT_LIMITS, HARD_LIMITS, loadApiConfig, publicApiConfig, redact } from '../api-agent.mjs';
import { createApiServer } from '../app.mjs';

const config = { apiKey: 'test-only-secret-value', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', keySource: '测试' };
const tool = (name, args = {}, id = 'call_1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const answer = (message) => new Response(JSON.stringify({ choices: [{ message }] }), { headers: { 'content-type': 'application/json' } });
const frameData = Buffer.from('测试替身图片数据').toString('base64');
const rawRequest = (url, options = {}) => new Promise((resolve, reject) => {
  const request = http.request(url, options, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
  });
  request.on('error', reject);
  request.end(options.body);
});

test('模型发出工具调用，读到真实结果后继续答复；画面只进入下一轮模型输入', async () => {
  const events = [];
  const requests = [];
  const executed = [];
  const controller = { execute: async (name, args) => {
    executed.push({ name, args });
    return { state: { url: 'https://www.douyin.com/video/123', video: { id: '123', title: '测试猫咪', paused: false } }, frames: [{ mimeType: 'image/jpeg', data: frameData }] };
  } };
  const agent = new ApiAgent({ controller, config, fetchImpl: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return requests.length === 1 ? answer({ tool_calls: [tool('douyin_observe', { seconds: 3 })] }) : answer({ content: '采样画面显示猫咪，未读取音频。' });
  } });
  const result = await agent.runTask({ instruction: '看看当前视频。', onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'completed');
  assert.deepEqual(executed, [{ name: 'douyin_observe', args: { seconds: 3 } }]);
  assert.equal(requests[0].body.thinking.type, 'disabled');
  assert.equal(requests[0].body.tools[0].type, 'function');
  assert.ok(requests[1].body.messages.some((message) => message.role === 'tool' && message.content.includes('测试猫咪')));
  const image = requests[1].body.messages.at(-1).content.find((part) => part.type === 'image_url');
  assert.equal(image.image_url.url, `data:image/jpeg;base64,${frameData}`);
  assert.equal(image.image_url.detail, 'high');
  assert.equal(JSON.stringify(events).includes(frameData), false);
  assert.equal(JSON.stringify(events).includes(config.apiKey), false);
});

test('不支持的工具或额外参数不能交给浏览器执行', async () => {
  let executed = false;
  let call = 0;
  const agent = new ApiAgent({ controller: { execute: async () => { executed = true; } }, config, fetchImpl: async () => {
    call++;
    return call === 1 ? answer({ tool_calls: [tool('browser_evaluate', { script: 'bad()' }), tool('douyin_search', { query: '猫', unsafe: true }, 'call_2')] }) : answer({ content: '收到工具参数错误，已停止。' });
  } });
  const result = await agent.runTask({ instruction: '搜索猫。' });
  assert.equal(executed, false);
  assert.equal(result.toolsUsed, 2);
});

test('登录或验证码立即结束任务，保留用户操作提示且不回传登录截图', async () => {
  let calls = 0;
  const agent = new ApiAgent({ controller: { execute: async () => ({ state: { loginRequired: true }, frames: [{ mimeType: 'image/jpeg', data: 'LOGIN_QR_SHOULD_NOT_SEND' }] }) }, config, fetchImpl: async () => {
    calls++;
    return answer({ tool_calls: [tool('douyin_search', { query: '猫咪' })] });
  } });
  const result = await agent.runTask({ instruction: '搜索猫咪。' });
  assert.equal(result.status, 'needs_user');
  assert.equal(calls, 1);
  assert.match(result.message, /手动登录/);
});

test('停止会中断正在等待的模型请求，不再操作浏览器', async () => {
  const abort = new AbortController();
  let executed = false;
  const agent = new ApiAgent({ controller: { execute: async () => { executed = true; } }, config, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    setTimeout(() => abort.abort(new Error('用户停止任务。')), 5);
  }) });
  const result = await agent.runTask({ instruction: '看看推荐。', signal: abort.signal });
  assert.equal(result.status, 'stopped');
  assert.equal(executed, false);
});

test('工具预算耗尽不会自动创建下一轮任务', async () => {
  let executed = 0;
  let requests = 0;
  const agent = new ApiAgent({ controller: { execute: async () => { executed++; return { video: { id: '123' } }; } }, config, maxToolCalls: 1, fetchImpl: async () => {
    requests++;
    return answer({ tool_calls: [tool('douyin_status'), tool('douyin_next', {}, 'call_2')] });
  } });
  const result = await agent.runTask({ instruction: '看看推荐再切下一条。' });
  assert.equal(result.status, 'limited');
  assert.equal(executed, 1);
  assert.equal(requests, 1);
});

test('总时间预算会结束任务', async () => {
  const agent = new ApiAgent({ controller: { execute: async () => ({}) }, config, taskTimeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const result = await agent.runTask({ instruction: '看看推荐。' });
  assert.equal(result.status, 'limited');
  assert.match(result.message, /时间限制/);
});

test('配置公开信息不含密钥，兼容端点拒绝凭据和外部HTTP', () => {
  const actual = loadApiConfig({ env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1' }, qqRoot: 'not-present-for-test' });
  assert.equal(actual.model, 'deepseek-flash');
  assert.equal(JSON.stringify(publicApiConfig(actual)).includes('test-key'), false);
  assert.throws(() => loadApiConfig({ env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'http://untrusted.example/' }, qqRoot: 'not-present-for-test' }), /HTTPS/);
  assert.throws(() => loadApiConfig({ env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://user:password@example.com/' }, qqRoot: 'not-present-for-test' }), /凭据/);
});

test('本机控制台校验Host、Origin与令牌，允许停止和读取共享记忆', async (t) => {
  const controller = { execute: async (name, args) => ({ entries: [{ content: '测试视频笔记', origin: 'video' }], connections: { qq: { available: true, note: '测试连接' }, video: { available: true } }, received: { name, args } }) };
  const agent = { runTask: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 'stopped', message: '任务已停止。' }), { once: true })) };
  const server = createApiServer({ controller, config, agent, port: 0 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /大肥鱼/);
  // 原始 HTTP 请求会真实发送 Host；Node fetch 可能覆盖或忽略该字段。
  assert.equal((await rawRequest(`${base}/api/bootstrap`, { headers: { host: 'untrusted.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/bootstrap`, { headers: { origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/state`)).status, 403);
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.equal(bootstrap.service, 'douyin-api-local');
  assert.equal(bootstrap.version, 1);
  assert.equal(JSON.stringify(bootstrap).includes(config.apiKey), false);
  const headers = { 'x-session-token': bootstrap.token, 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/task`, { method: 'POST', headers: { ...headers, origin: 'https://untrusted.example' }, body: JSON.stringify({ instruction: '测试' }) })).status, 403);
  assert.equal((await fetch(`${base}/api/task`, { method: 'POST', headers, body: JSON.stringify({ instruction: '测试停止' }) })).status, 202);
  assert.equal((await fetch(`${base}/api/task`, { method: 'POST', headers, body: JSON.stringify({ instruction: '不应同时运行' }) })).status, 409);
  assert.equal((await fetch(`${base}/api/stop`, { method: 'POST', headers, body: '{}' })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const state = await (await fetch(`${base}/api/state`, { headers })).json();
  assert.equal(state.running, false);
  assert.equal(state.task.status, 'stopped');
  assert.equal(JSON.stringify(state).includes(bootstrap.token), false);
  const memory = await (await fetch(`${base}/api/memory?query=${encodeURIComponent('测试')}`, { headers })).json();
  assert.equal(memory.result.connections.qq.available, true);
  assert.equal(memory.result.received.args.query, '测试');
  assert.equal((await rawRequest(`${base}/api/bootstrap`, { headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
  assert.equal((await fetch(`${base}/api/task`, { method: 'POST', headers: { 'x-session-token': bootstrap.token }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/api/task`, { method: 'POST', headers, body: 'null' })).status, 400);
  assert.equal((await fetch(`${base}/api/task`, { method: 'POST', headers, body: 'not-json' })).status, 400);
  assert.equal((await fetch(`${base}/api/task`, { method: 'POST', headers, body: JSON.stringify({ instruction: 'x'.repeat(21_000) }) })).status, 413);
  assert.equal((await fetch(`${base}/api/stop`, { method: 'POST', headers, body: '{}' })).status, 200);
});

test('截断、过滤或格式损坏的模型响应不算完成，也不交给浏览器执行', async () => {
  let executed = 0;
  const controller = { execute: async () => { executed++; return {}; } };
  for (const finishReason of ['length', 'content_filter', 'insufficient_system_resource', 'aborted']) {
    const agent = new ApiAgent({ controller, config, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: '未完整的内容', tool_calls: [tool('douyin_next')] } }] })) });
    const result = await agent.runTask({ instruction: '看看推荐。' });
    assert.equal(result.status, finishReason === 'length' ? 'limited' : 'failed');
  }
  const agent = new ApiAgent({ controller, config, fetchImpl: async () => answer({ tool_calls: [{ type: 'function', function: { name: 'douyin_next', arguments: '{}' } }] }) });
  assert.equal((await agent.runTask({ instruction: '看看推荐。' })).status, 'failed');
  assert.equal(executed, 0);
});

test('每次保留最新一组采样，旧画面不在后续请求中重复上传', async () => {
  let requests = 0;
  let captures = 0;
  const bodies = [];
  const agent = new ApiAgent({ controller: { execute: async () => ({ state: { video: { id: '123' } }, frames: [{ mimeType: 'image/png', data: Buffer.from(`测试采样${++captures}`).toString('base64') }] }) }, config, fetchImpl: async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return ++requests <= 2 ? answer({ tool_calls: [tool('douyin_screenshot', {}, `call_${requests}`)] }) : answer({ content: '看到了两次采样。' });
  } });
  assert.equal((await agent.runTask({ instruction: '采样两次。' })).status, 'completed');
  const images = bodies[2].messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === 'image_url') : []);
  assert.equal(images.length, 1);
  assert.ok(images[0].image_url.url.endsWith(Buffer.from('测试采样2').toString('base64')));
  assert.equal(JSON.stringify(bodies[2]).includes(Buffer.from('测试采样1').toString('base64')), false);
});

test('超限或无效采样会如实报错，不发送不受限图片', async () => {
  for (const data of ['not_base64', Buffer.alloc(21).toString('base64')]) {
    let calls = 0;
    const agent = new ApiAgent({ controller: { execute: async () => ({ frames: [{ mimeType: 'image/png', data }] }) }, config, maxFrameBytes: 20, fetchImpl: async () => { calls++; return answer({ tool_calls: [tool('douyin_screenshot')] }); } });
    const result = await agent.runTask({ instruction: '截图。' });
    assert.equal(result.status, 'failed');
    assert.equal(calls, 1);
    assert.match(result.message, /图片|Base64/);
  }
});

test('停止信号传递到正在执行的浏览器工具，停止后不再请求模型', async () => {
  const abort = new AbortController();
  let requests = 0;
  const controller = { execute: async (_name, _args, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    setTimeout(() => abort.abort(new Error('用户停止。')), 5);
  }) };
  const agent = new ApiAgent({ controller, config, fetchImpl: async () => { requests++; return answer({ tool_calls: [tool('douyin_observe', { seconds: 3 })] }); } });
  const result = await agent.runTask({ instruction: '观察当前视频。', signal: abort.signal });
  assert.equal(result.status, 'stopped');
  assert.equal(requests, 1);
});

test('QQ 配置只在进程内读取对应两项，不载入其余账号字段', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-api-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.env'), 'DEEPSEEK_API_KEY="fixture-only-secret"\nDEEPSEEK_BASE_URL=https://api.deepseek.com/v1\nQQ_ACCOUNT=不应载入\n');
  // 使用 Node.js 的标准 .env 解析器，测试只读取替身文件。
  const actual = loadApiConfig({ env: { DEEPSEEK_BASE_URL: 'https://api.deepseek.com' }, qqRoot: root });
  assert.equal(actual.apiKey, 'fixture-only-secret');
  assert.equal(actual.baseUrl, 'https://api.deepseek.com');
  assert.equal(Object.hasOwn(actual, 'QQ_ACCOUNT'), false);
  assert.equal(process.env.DEEPSEEK_API_KEY === 'fixture-only-secret', false);
});

test('公开事件去除凭据、Cookie、推理和图片数据，HTTP 错误不会泄露密钥', async () => {
  const safe = redact({ api_key: 'test', cookie: 'cookie-value', reasoning_content: '不应公开', frames: [{ data: frameData }], message: `Bearer another-secret ${config.apiKey}` }, [config.apiKey]);
  assert.equal(safe.frameCount, 1); assert.equal(safe.message, 'Bearer [凭据已隐藏] [凭据已隐藏]'); assert.equal(JSON.stringify(safe).includes(frameData), false);
  const events = [];
  const agent = new ApiAgent({ controller: { execute: async () => ({}) }, config, fetchImpl: async () => new Response(JSON.stringify({ error: { message: `无效密钥 ${config.apiKey}` } }), { status: 401 }) });
  const result = await agent.runTask({ instruction: '看看推荐。', onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'failed');
  assert.equal(JSON.stringify({ result, events }).includes(config.apiKey), false);
  assert.match(result.message, /HTTP 401/);
});

test('默认预算保持原值，用户可在硬上限内提高三项预算，用量仍可回读', async () => {
  assert.equal(DEFAULT_LIMITS.maxSteps, 20); assert.equal(DEFAULT_LIMITS.maxToolCalls, 20); assert.equal(DEFAULT_LIMITS.taskTimeoutMs, 180000);
  const expanded = new ApiAgent({ controller: { execute() {} }, config, maxSteps: 10000, maxToolCalls: 10000, taskTimeoutMs: 604800000 });
  assert.equal(expanded.maxSteps, HARD_LIMITS.maxSteps); assert.equal(expanded.maxToolCalls, HARD_LIMITS.maxToolCalls); assert.equal(expanded.taskTimeoutMs, HARD_LIMITS.taskTimeoutMs);
  for (const [name, value] of [['maxSteps', 10001], ['maxToolCalls', 10001], ['taskTimeoutMs', 604800001], ['maxFrames', 5], ['maxTokens', 2049], ['apiTimeoutMs', 60001]]) assert.throws(() => new ApiAgent({ controller: { execute() {} }, config, [name]: value }), /预算参数/);
  assert.throws(() => new ApiAgent({ controller: { execute() {} }, config, taskTimeoutMs: 0 }), /预算参数/);
  const agent = new ApiAgent({ controller: { execute() {} }, config, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '测试答复' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })) });
  const result = await agent.runTask({ instruction: '测试。' });
  assert.deepEqual(result.usage, { requests: 1, promptTokens: 10, completionTokens: 3, totalTokens: 13 });
});

test('专用临时 Edge 中能填入任务、停止运行并检索笔记，页面无脚本错误', { skip: process.env.DOUYIN_UI_TEST !== '1' }, async (t) => {
  const require = createRequire(import.meta.url);
  const playwright = createRequire(require.resolve('@playwright/mcp'))('playwright');
  const controller = { execute: async () => ({ entries: [{ content: '网页验收测试笔记', origin: 'video' }], connections: { qq: { available: false, note: '当前测试使用控制器替身。' }, video: { available: true } } }) };
  const agent = { runTask: ({ signal, onEvent }) => {
    onEvent({ type: 'tool.result', tool: 'douyin_status', message: '网页交互测试，浏览器状态为替身。', result: { url: 'https://www.douyin.com/video/123', video: { id: '123', title: '网页验收测试视频', author: '测试作者', paused: false } } });
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 'stopped', message: '任务已停止。' }), { once: true }));
  } };
  let autoReply = false; let allowlist = [];
  const chatService = {
    state: () => ({ running: autoReply, starting: false, busy: false, policy: { allowlist, dailyReplyLimit: 40 }, daily: { requests: 0, limit: 40 }, pollSeconds: 15, replyTokens: 512, contacts: [], events: [] }),
    listContacts: async () => ({ contacts: [{ id: 'ui-fixture-contact', name: '网页验收合成联系人', followed: true, isGroup: false }] }),
    configure: async ({ recipientIds }) => { assert.deepEqual(recipientIds, ['ui-fixture-contact']); allowlist = [{ id: 'ui-fixture-contact', name: '网页验收合成联系人' }]; return chatService.state(); },
    start: async () => { autoReply = true; return chatService.state(); }, stop: () => { autoReply = false; return chatService.state(); }, close: async () => {},
  };
  const server = createApiServer({ controller, config, agent, chatService, port: 0 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.stopTask(); server.close(resolve); server.closeAllConnections(); }));
  const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 980 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByText('本机服务已连接', { exact: true }).waitFor();
  await page.getByRole('button', { name: '下一条', exact: true }).click();
  assert.match(await page.locator('#instruction').inputValue(), /切换下一条/);
  await page.getByRole('button', { name: '开始任务', exact: true }).click();
  await page.getByText('任务运行中', { exact: true }).waitFor();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.locator('#answer').filter({ hasText: '任务已停止。' }).waitFor();
  await page.locator('#memoryQuery').fill('测试笔记');
  await page.getByRole('button', { name: '检索记忆', exact: true }).click();
  await page.getByText('网页验收测试笔记', { exact: true }).waitFor();
  assert.match(await page.locator('#memory').innerText(), /暂不可读取/);
  assert.match(await page.locator('#browser').innerText(), /网页验收测试视频/);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  await page.getByRole('button', { name: '读取联系人', exact: true }).click();
  await page.getByRole('checkbox', { name: '网页验收合成联系人（已关注）', exact: true }).check();
  await page.getByRole('button', { name: '保存白名单和预算', exact: true }).click();
  await page.getByRole('button', { name: '启用自动回复', exact: true }).click();
  await page.locator('#chatStatus').filter({ hasText: '自动回复运行中' }).waitFor();
  await page.getByRole('button', { name: '停止自动回复', exact: true }).click();
  await page.locator('#chatStatus').filter({ hasText: '自动回复未启用' }).waitFor();
  assert.deepEqual(errors, []);
  if (process.env.DOUYIN_UI_SCREENSHOT) await page.screenshot({ path: process.env.DOUYIN_UI_SCREENSHOT, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
});
