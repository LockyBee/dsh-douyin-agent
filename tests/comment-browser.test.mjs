import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from '../playwright-runtime.mjs';
import { readPageState } from '../core.mjs?v=9';
import { CommentBrowser, readCommentDom } from '../comment-browser.mjs';
import { AutonomousComments } from '../autonomous-comments.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
const text = '合成画面的配色很舒服。';
async function fixture(t, { result = { id: '90001', mine: true, status: 'sent', videoId: '12345' }, existing = [], draft = '', missingInput = false, doubleButton = false } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-browser-')), page = await browser.newPage();
  await page.setContent('<section data-e2e="feed-active-video"><video></video></section><div class="comment-mainContent" data-video-id="12345"><div data-e2e="comment-list"></div></div>' + (missingInput ? '' : '<div class="comment-input-container"><div contenteditable="true" role="textbox" style="min-height:35px;width:260px"></div><button data-e2e="comment-post">发布</button>' + (doubleButton ? '<button data-e2e="comment-submit">发布</button>' : '') + '</div>'));
  await page.evaluate(({ result, existing }) => {
    window.commentClicks = 0; window.result = result; window.fixtureState = { loginRequired: false, verificationRequired: false, privateChatVisible: false, video: { id: '12345', url: 'https://www.douyin.com/video/12345', readyState: 4 } };
    window.appendComment = entry => { const row = document.createElement('div'); row.setAttribute('data-e2e', 'comment-item'); row.setAttribute('data-comment-id', entry.id); row.setAttribute('data-video-id', entry.videoId || '12345'); if (entry.mine !== undefined) row.setAttribute('data-is-self', String(entry.mine)); if (entry.status) row.setAttribute('data-send-status', entry.status); const content = document.createElement('span'); content.setAttribute('data-e2e', 'comment-content'); content.textContent = entry.text || ''; row.append(content); document.querySelector('[data-e2e="comment-list"]').append(row); };
    for (const entry of existing) window.appendComment(entry);
    document.querySelector('[data-e2e="comment-post"]')?.addEventListener('click', () => { window.commentClicks++; const editor = document.querySelector('[contenteditable]'), content = editor.innerText; if (window.result) { const rows = Array.isArray(window.result) ? window.result : [window.result]; for (const row of rows) window.appendComment({ ...row, text: row.text ?? content }); editor.textContent = ''; } });
  }, { result, existing });
  if (draft && !missingInput) await page.locator('[contenteditable]').fill(draft);
  const evaluate = page.evaluate.bind(page); page.evaluate = (fn, args) => fn === readPageState ? evaluate(() => window.fixtureState) : evaluate(fn, args);
  let allowed = true, lease = false, begins = 0; const phases = [], hooks = {};
  const authorize = async request => { phases.push(request.phase); await hooks.authorize?.(request); return allowed; };
  authorize.beginDispatch = () => { begins++; lease = true; return () => { lease = false; }; };
  const controller = { source: 'api', withPage: async (action, options) => { options.signal?.throwIfAborted(); return action(page); }, close: async () => {} };
  const videoLimits = { state: () => ({ allowed: true, session: { id: 'synthetic-session' } }) };
  const commenter = new CommentBrowser({ source: 'api', controller, videoLimits, stateDir });
  t.after(async () => { await page.close(); assert.equal(path.dirname(stateDir), os.tmpdir()); fs.rmSync(stateDir, { recursive: true, force: true }); });
  return { page, commenter, authorize, stateDir, hooks, setAllowed: value => { allowed = value; }, stats: () => ({ lease, begins, phases }), post: (options = {}) => commenter.post({ expectedVideoId: '12345', text }, { authorize, ...options }) };
}

test('可信许可缺失或JSON伪造时完全不填写与发布', async t => {
  const f = await fixture(t); for (const authorize of [undefined, {}, () => true]) { const result = await f.commenter.post({ expectedVideoId: '12345', text }, { authorize }); assert.equal(result.confirmed, false); }
  assert.equal(await f.page.evaluate(() => window.commentClicks), 0); assert.equal(await f.page.locator('[contenteditable]').innerText(), '');
});
test('未打开评论输入或官方按钮不唯一时明确要求人工处理', async t => {
  for (const options of [{ missingInput: true }, { doubleButton: true }]) { const f = await fixture(t, options), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.needsUserAction, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 0); }
});
test('已有草稿、处于回复模式或私信遮挡时不填写和发布', async t => {
  const f = await fixture(t, { draft: '用户草稿' }); let result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.locator('[contenteditable]').innerText(), '用户草稿');
  await f.page.locator('[contenteditable]').fill(''); await f.page.evaluate(() => { const reply = document.createElement('div'); reply.setAttribute('data-e2e', 'comment-reply-target'); reply.textContent = '回复合成评论'; document.querySelector('.comment-input-container').append(reply); }); result = await f.post(); assert.equal(result.confirmed, false); assert.equal((await f.page.locator('[contenteditable]').innerText()).trim(), '');
  await f.page.evaluate(() => { document.querySelector('[data-e2e="comment-reply-target"]').remove(); window.fixtureState.privateChatVisible = true; }); result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 0);
});
test('唯一真实点击、同作品新本人commentId和稳定发出状态才确认成功', async t => {
  const f = await fixture(t), result = await f.post(); assert.equal(result.confirmed, true); assert.equal(result.commentId, '90001'); assert.equal(result.videoId, '12345'); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); assert.equal(f.stats().begins, 1); assert.equal(f.stats().lease, false);
  assert.equal(f.commenter.receipts().operations[0].status, 'confirmed'); const again = await f.post(); assert.equal(again.confirmed, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); assert.equal(fs.existsSync(path.join(f.stateDir, 'comment-post.guard')), false);
});
test('旧评论、其他人的相同文字、不同作品、pending和无编号都不冒充成功', async t => {
  for (const result of [{ id: '90001', mine: true, status: 'sent' }, { id: '90002', mine: false, status: 'sent' }, { id: '90002', mine: true, status: 'sent', videoId: '67890' }, { id: '90002', mine: true, status: 'pending' }, { id: 'local-pending', mine: true, status: 'sent' }]) {
    const f = await fixture(t, { existing: [{ id: '90001', mine: true, status: 'sent', text }], result }); const output = await f.post(); assert.equal(output.confirmed, false); assert.equal(output.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); assert.equal(f.commenter.receipts().operations[0].status, 'uncertain');
  }
});
test('同文多条新本人评论不能作为唯一发布证据', async t => {
  const f = await fixture(t, { result: [{ id: '90001', mine: true, status: 'sent' }, { id: '90002', mine: true, status: 'sent' }] }); const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1);
});
test('等待真实按钮稳定期间关闭许可，动画结束后也不会迟发，草稿保留', async t => {
  const f = await fixture(t); let prepared = false;
  f.hooks.authorize = async ({ phase }) => { if (phase === 'monitor' && !prepared && await f.page.locator('[contenteditable]').innerText() === text) { prepared = true; await f.page.evaluate(() => document.querySelector('[data-e2e="comment-post"]').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 800 })); setTimeout(() => f.setAllowed(false), 80); } };
  const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(f.stats().begins, 0); await f.page.waitForTimeout(300); assert.equal(await f.page.evaluate(() => window.commentClicks), 0); assert.equal(await f.page.locator('[contenteditable]').innerText(), text);
});
test('等待期间换片或用户改草稿都不发布，保留用户内容', async t => {
  for (const mutation of ['video', 'draft']) {
    const f = await fixture(t); let prepared = false;
    f.hooks.authorize = async ({ phase }) => { if (phase === 'monitor' && !prepared && await f.page.locator('[contenteditable]').innerText() === text) { prepared = true; await f.page.evaluate(kind => { document.querySelector('[data-e2e="comment-post"]').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 800 }); setTimeout(() => { if (kind === 'video') window.fixtureState.video.id = '67890'; else document.querySelector('[contenteditable]').textContent = '用户改写草稿'; }, 80); }, mutation); } };
    const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 0); if (mutation === 'draft') assert.equal(await f.page.locator('[contenteditable]').innerText(), '用户改写草稿');
  }
});
test('最终输入期间用户取消后不再次点击，没有回读则保留未确认收据', async t => {
  const f = await fixture(t, { result: null }), abort = new AbortController(); await f.page.exposeFunction('fixtureAbortComment', () => abort.abort(new Error('合成用户取消'))); await f.page.evaluate(() => document.querySelector('[data-e2e="comment-post"]').addEventListener('click', () => window.fixtureAbortComment()));
  const result = await f.post({ signal: abort.signal }); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); assert.equal(await f.page.locator('[contenteditable]').innerText(), text); assert.equal(f.commenter.receipts().operations[0].status, 'uncertain');
});
test('只读评论字段不含账号、昵称或头像，明确限定作品', async t => {
  const f = await fixture(t, { existing: [{ id: '90000', mine: true, status: 'sent', text: '合成已有评论' }] }); await f.page.evaluate(() => { const row = document.querySelector('[data-e2e="comment-item"]'); row.insertAdjacentHTML('beforeend', '<a href="/user/synthetic-private-account">合成评论者姓名</a><img src="https://synthetic.invalid/avatar-private">'); });
  const snapshot = await f.page.evaluate(readCommentDom, '12345'); assert.deepEqual(Object.keys(snapshot.rows[0]).sort(), ['commentId', 'videoId', 'text', 'mine', 'sent', 'pending', 'failed'].sort()); assert.equal(JSON.stringify(snapshot).includes('private'), false); assert.equal(JSON.stringify(snapshot).includes('姓名'), false);
});
test('真实合成发布链路跨入口撤回许可，服务保留扣费与草稿但不发布', async t => {
  const f = await fixture(t), now = Date.now(), evidenceId = `video:${'a'.repeat(64)}`, watchRunId = 'synthetic-comment-watch';
  const personaMemory = { snapshot: () => ({ recentObservations: [{ id: evidenceId, videoId: '12345', url: 'https://www.douyin.com/video/12345', sources: ['api'], privacy: 'internal-reference', visibility: 'account-visible-unverified', observedAt: now }] }) };
  const videoLimits = { state: () => ({ allowed: true, session: { id: 'synthetic-session', startAt: now, expiresAt: now + 60000 } }) };
  fs.writeFileSync(path.join(f.stateDir, 'watch-loop.lock'), JSON.stringify({ pid: process.pid, source: 'api', runId: watchRunId, sessionId: 'synthetic-session', status: 'running' }));
  const foreign = new AutonomousComments({ personaMemory, videoLimits, stateDir: f.stateDir }); let scheduled = false, disabled = false;
  const service = new AutonomousComments({ personaMemory, videoLimits, stateDir: f.stateDir, post: (input, controls) => {
    const authorize = async request => { const result = controls.authorize(request); if (request.phase === 'monitor' && !scheduled && await f.page.locator('[contenteditable]').innerText() === text) { scheduled = true; await f.page.evaluate(() => document.querySelector('[data-e2e="comment-post"]').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 800 })); setTimeout(() => { disabled = foreign.configure({ enabled: false }, { explicit: true }).enabled === false; }, 80); } return result; }; authorize.beginDispatch = controls.authorize.beginDispatch;
    return f.commenter.post(input, { ...controls, authorize });
  } });
  service.configure({ enabled: true }, { explicit: true }); const result = await service.comment({ evidenceId, videoId: '12345', text }, { watchRunId });
  assert.equal(disabled, true); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 0); assert.equal(await f.page.locator('[contenteditable]').innerText(), text); assert.equal(service.ledger().operations[0].status, 'not-sent'); assert.equal(service.state().daily.attempts, 1); await service.close(); await foreign.close();
});
