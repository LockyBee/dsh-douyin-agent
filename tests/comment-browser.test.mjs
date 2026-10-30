import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from '../playwright-runtime.mjs';
import { readPageState } from '../core.mjs?v=9';
import { CommentBrowser, readCommentDom, inspectCommentComposer } from '../comment-browser.mjs';
import { AutonomousComments } from '../autonomous-comments.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
const text = '合成画面的配色很舒服。';
async function fixture(t, { result = { id: '90001', mine: true, status: 'sent', videoId: '12345' }, existing = [], draft = '', missingInput = false, doubleButton = false } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-browser-')), page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto('https://www.douyin.com/video/12345');
  await page.setContent('<div class="tab-user_self" data-fixture-default-self="true"><a href="https://www.douyin.com/user/synthetic-self-profile">我的</a></div><section data-e2e="feed-active-video"><video></video></section><div class="comment-mainContent" data-video-id="12345"><div data-e2e="comment-list"></div></div>' + (missingInput ? '' : '<div class="comment-input-container"><div contenteditable="true" role="textbox" style="min-height:35px;width:260px"></div><button data-e2e="comment-post">发布</button>' + (doubleButton ? '<button data-e2e="comment-submit">发布</button>' : '') + '</div>'));
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

async function modernFixture(t, { lazyDraft = '', missingSubmit = false, duplicateSubmit = false, clearWithoutReceipt = false, videoId = '12345', hiddenDraft = '' } = {}) {
  const f = await fixture(t, { missingInput: true });
  await f.page.evaluate(({ lazyDraft, missingSubmit, duplicateSubmit, clearWithoutReceipt, videoId, hiddenDraft }) => {
    const composer = document.createElement('section'); composer.setAttribute('data-video-id', videoId); composer.className = 'modern-comment-composer';
    composer.innerHTML = '<div class="comment-input-inner-container" style="min-height:40px;width:300px" data-placeholder="说点什么..."></div><div class="modern-publish-control" style="cursor:pointer;display:none"><span>发布</span></div>';
    const lazy = composer.querySelector('.comment-input-inner-container'); lazy.textContent = lazyDraft;
    if (hiddenDraft) { const textarea = document.createElement('textarea'); textarea.value = hiddenDraft; textarea.style.display = 'none'; lazy.append(textarea); }
    const publish = composer.querySelector('.modern-publish-control');
    if (duplicateSubmit) composer.insertAdjacentHTML('beforeend', '<div class="another-publish-control" style="cursor:pointer;display:none"><span>发布</span></div>');
    window.commentActivations = 0; window.enterCount = 0;
    lazy.addEventListener('click', () => {
      if (lazy.querySelector('[contenteditable]')) return;
      window.commentActivations++;
      lazy.textContent = ''; const editor = document.createElement('div'); editor.setAttribute('contenteditable', 'true'); editor.setAttribute('role', 'textbox'); editor.style.cssText = 'min-height:40px;width:290px'; lazy.append(editor);
      editor.addEventListener('input', () => { if (!missingSubmit) for (const node of composer.querySelectorAll('.modern-publish-control,.another-publish-control')) node.style.display = 'block'; });
      editor.addEventListener('keydown', event => { if (event.key === 'Enter') { window.enterCount++; editor.textContent = ''; event.preventDefault(); } });
      editor.focus();
    });
    publish.addEventListener('click', () => {
      window.commentClicks++; const editor = lazy.querySelector('[contenteditable]');
      if (!clearWithoutReceipt) window.appendComment({ id: '99001', mine: true, status: 'sent', videoId, text: editor.innerText });
      editor.textContent = '';
    });
    document.body.append(composer);
    const danmaku = document.createElement('div'); danmaku.setAttribute('data-e2e', 'danmaku-container'); danmaku.style.display = 'none';
    danmaku.innerHTML = '<div class="comment-input-inner-container"><div contenteditable="true"></div><button>发送</button></div>';
    danmaku.addEventListener('click', () => { window.danmakuClicks = (window.danmakuClicks || 0) + 1; }); document.body.append(danmaku);
  }, { lazyDraft, missingSubmit, duplicateSubmit, clearWithoutReceipt, videoId, hiddenDraft });
  return f;
}

async function nativeFixture(t, { activated = false, existingDraft = '', wrongGeometry = false, disabled = false, wrongToolbar = false, duplicate = false, selectedFile = false, innerOnly = false } = {}) {
  const f = await fixture(t, { missingInput: true });
  const dom = JSON.parse(fs.readFileSync(new URL('./fixtures/comment-publish-icon-20261024.json', import.meta.url), 'utf8'));
  await f.page.evaluate(({ dom, activated, existingDraft, wrongGeometry, disabled, wrongToolbar, duplicate, selectedFile, innerOnly }) => {
    const outer = document.createElement('div'); outer.className = innerOnly ? 'native-comment-synthetic-outer' : 'N7WyeAml comment-input-container';
    outer.innerHTML = `<div class="ZWk5Ao93"><div class="McY63d8B ${dom.containerClass}" style="width:420px;min-height:70px"><div class="_x9Gwl7G" style="min-height:40px"></div><span class="${dom.placeholderClass}">${dom.placeholderText}</span><div class="${wrongToolbar ? 'unverified-toolbar' : dom.toolbarClass}"><div class="${dom.toolsWrapperClass}" style="display:flex;justify-content:flex-end"><input type="file" style="display:none"><span><svg width="20" height="20"><path d="M0 0L20 20"></path></svg></span><span><svg width="20" height="20"><path d="M0 20L20 0"></path></svg></span></div></div></div></div>`;
    const inner = outer.querySelector('.comment-input-inner-container'), rich = outer.querySelector('._x9Gwl7G'), tools = outer.querySelector(`.${dom.toolsWrapperClass}`);
    window.nativeCommentClicks = 0; window.commentActivations = 0; window.nativeEmojiClicks = 0;
    const publisher = document.createElement('span'); publisher.className = dom.emptyPublishClass; publisher.style.cursor = 'pointer';
    publisher.innerHTML = `<svg viewBox="${dom.viewBox}" width="36" height="36">${dom.paths.map((entry, index) => `<path d="${entry.d}${wrongGeometry && index === 1 ? ' L1 1' : ''}" fill="${entry.fill}"></path>`).join('')}</svg>`;
    tools.append(publisher); if (duplicate) tools.append(publisher.cloneNode(true));
    for (const emoji of tools.querySelectorAll('span:not(.wchsYBpK)')) emoji.addEventListener('click', () => window.nativeEmojiClicks++);
    const addEditor = () => {
      if (rich.querySelector('[contenteditable]')) return;
      inner.querySelector(`.${dom.placeholderClass}`)?.remove(); rich.innerHTML = `<div class="richtext-container"><div class="DraftEditor-root"><div class="DraftEditor-editorContainer"><div class="${dom.editorClass}" role="${dom.editorRole}" contenteditable="true" style="min-height:40px;width:400px"></div></div></div></div>`;
      const editor = rich.querySelector('[contenteditable]'); editor.textContent = existingDraft || dom.emptyEditorText;
      if (!existingDraft) { const placeholder = document.createElement('span'); placeholder.className = 'm53pwJvW'; placeholder.textContent = dom.placeholderText; placeholder.style.pointerEvents = 'none'; rich.prepend(placeholder); }
      editor.addEventListener('input', () => { const value = editor.innerText.replace(/[\u200B-\u200F\uFEFF]/g, '').trim(); publisher.className = value && !disabled ? dom.enabledPublishClass : dom.emptyPublishClass; rich.querySelector('.m53pwJvW')?.remove(); });
      editor.focus();
    };
    inner.addEventListener('click', event => { if (!event.target.closest('.commentInput-right-ct,.unverified-toolbar') && !rich.querySelector('[contenteditable]')) { window.commentActivations++; addEditor(); } });
    publisher.addEventListener('click', () => {
      window.nativeCommentClicks++; window.commentClicks++;
      const editor = rich.querySelector('[contenteditable]'); if (!editor || !publisher.classList.contains('jfGCpJo0')) return;
      window.appendComment({ id: '99501', mine: true, status: 'sent', videoId: '12345', text: editor.innerText.replace(/[\u200B-\u200F\uFEFF]/g, '').trim() }); editor.textContent = dom.emptyEditorText;
    });
    document.body.append(outer); if (activated) addEditor();
    if (selectedFile) { const transfer = new DataTransfer(); transfer.items.add(new File(['原附件'], 'draft.txt')); tools.querySelector('input[type="file"]').files = transfer.files; }
  }, { dom, activated, existingDraft, wrongGeometry, disabled, wrongToolbar, duplicate, selectedFile, innerOnly });
  return f;
}

test('实机结构的懒占位和无标签两path发布图标经启用态核对后只点击一次', async t => {
  const f = await nativeFixture(t), result = await f.post(); assert.equal(result.confirmed, true); assert.equal(result.commentId, '99501'); assert.equal(await f.page.evaluate(() => window.commentActivations), 1);
  assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 1); assert.equal(await f.page.evaluate(() => window.nativeEmojiClicks), 0); assert.equal(await f.page.locator('[data-deepseek-comment-native-publish]').count(), 0);
});
test('DraftEditor空ZWSP不误判草稿，已有真实文字则不覆盖', async t => {
  const empty = await nativeFixture(t, { activated: true }); assert.equal((await empty.post()).confirmed, true);
  const nonempty = await nativeFixture(t, { activated: true, existingDraft: '用户已有DraftEditor草稿' }); const result = await nonempty.post(); assert.equal(result.confirmed, false); assert.equal(await nonempty.page.locator('.public-DraftEditor-content').innerText(), '用户已有DraftEditor草稿'); assert.equal(await nonempty.page.evaluate(() => window.nativeCommentClicks), 0);
});
test('无标签图标形状、母区域或唯一性不符时不猜测发布目标', async t => {
  for (const options of [{ wrongGeometry: true }, { wrongToolbar: true }, { duplicate: true }]) {
    const f = await nativeFixture(t, options), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.needsUserAction, true); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0); assert.equal(await f.page.evaluate(() => window.nativeEmojiClicks), 0);
  }
});
test('实机图标没有进入已启用class时不点击', async t => {
  const f = await nativeFixture(t, { disabled: true }), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(result.needsUserAction, true); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0);
});
test('实机编辑器已经有附件时不激活或追加文字', async t => {
  for (const activated of [false, true]) { const f = await nativeFixture(t, { activated, selectedFile: true }), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.locator('input[type="file"]').evaluate(input => input.files.length), 1); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0); }
});
test('评论结构只读检查不会激活、填写或点击，区分实际图标空态和启用态', async t => {
  const f = await nativeFixture(t, { activated: true });
  let result = await inspectCommentComposer(f.page, '12345'); assert.equal(result.submitFound, true); assert.equal(result.nativeIcon, true); assert.equal(result.enabled, false); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0);
  await f.page.locator('.public-DraftEditor-content').fill('合成结构检查'); result = await inspectCommentComposer(f.page, '12345'); assert.equal(result.enabled, true); assert.equal(await f.page.locator('.public-DraftEditor-content').innerText(), '合成结构检查'); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0);
});

test('新版懒加载评论框激活后识别同区域div发布控件，不误点隐藏弹幕', async t => {
  const f = await modernFixture(t), result = await f.post();
  assert.equal(result.confirmed, true); assert.equal(result.commentId, '99001'); assert.equal(await f.page.evaluate(() => window.commentActivations), 1);
  assert.equal(await f.page.evaluate(() => window.commentClicks), 1); assert.equal(await f.page.evaluate(() => window.danmakuClicks || 0), 0); assert.equal(await f.page.evaluate(() => window.enterCount), 0);
  assert.equal(await f.page.locator('[data-deepseek-comment-control]').count(), 0);
});
test('未激活区域有文字或隐藏草稿时不激活、不清空', async t => {
  for (const options of [{ lazyDraft: '用户还没有发出的评论' }, { hiddenDraft: '用户隐藏的输入内容' }]) {
    const f = await modernFixture(t, options), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.needsUserAction, true);
    assert.equal(await f.page.evaluate(() => window.commentActivations), 0); assert.equal(await f.page.evaluate(() => window.commentClicks), 0);
    if (options.hiddenDraft) assert.equal(await f.page.locator('textarea').inputValue(), options.hiddenDraft); else assert.equal(await f.page.locator('.modern-comment-composer .comment-input-inner-container').innerText(), options.lazyDraft);
  }
});
test('实际新版占位span可激活，普通同文草稿仍保留', async t => {
  const f = await modernFixture(t);
  await f.page.locator('.modern-comment-composer').evaluate(element => { element.classList.add('comment-input-container'); const inner = element.querySelector('.comment-input-inner-container'); inner.removeAttribute('data-placeholder'); inner.innerHTML = '<span class="RXtfhfhu">留下你的精彩评论吧</span>'; });
  const result = await f.post(); assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.commentActivations), 1);
  const other = await modernFixture(t, { lazyDraft: '留下你的精彩评论吧' }); await other.page.locator('.modern-comment-composer .comment-input-inner-container').evaluate(element => element.removeAttribute('data-placeholder'));
  const guarded = await other.post(); assert.equal(guarded.confirmed, false); assert.equal(await other.page.evaluate(() => window.commentActivations), 0); assert.equal(await other.page.locator('.modern-comment-composer .comment-input-inner-container').innerText(), '留下你的精彩评论吧');
});
test('新版评论区域没有发布控件时保留生成草稿，不用回车替代提交', async t => {
  const f = await modernFixture(t, { missingSubmit: true }), result = await f.post();
  assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(result.needsUserAction, true); assert.match(result.reason, /没有唯一可核对的发布控件/);
  assert.equal(await f.page.locator('.modern-comment-composer [contenteditable]').innerText(), text); assert.equal(await f.page.evaluate(() => window.enterCount), 0); assert.equal(await f.page.evaluate(() => window.commentClicks), 0);
});
test('新版输入后出现两个发布控件时拒绝猜测，草稿不丢', async t => {
  const f = await modernFixture(t, { duplicateSubmit: true }), result = await f.post();
  assert.equal(result.confirmed, false); assert.equal(result.needsUserAction, true); assert.match(result.reason, /多个发布控件/); assert.equal(await f.page.evaluate(() => window.commentClicks), 0);
  assert.equal(await f.page.locator('.modern-comment-composer [contenteditable]').innerText(), text);
});
test('新版输入框所属作品不同则不激活或发布', async t => {
  const f = await modernFixture(t, { videoId: '67890' }), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.evaluate(() => window.commentActivations), 0); assert.equal(await f.page.evaluate(() => window.commentClicks), 0);
});
test('新版点击发布后只有编辑器清空，没有本人新评论回读仍为未确认', async t => {
  const f = await modernFixture(t, { clearWithoutReceipt: true }), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true);
  assert.equal(await f.page.evaluate(() => window.commentClicks), 1); assert.equal(await f.page.locator('.modern-comment-composer [contenteditable]').innerText(), ''); assert.equal(f.commenter.receipts().operations[0].status, 'uncertain');
});
test('语义按钮中的发布文字不算第二个控件', async t => {
  const f = await fixture(t); await f.page.locator('[data-e2e="comment-post"]').evaluate(button => { button.innerHTML = '<span>发布</span>'; });
  const result = await f.post(); assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1);
});
test('编辑器自身带评论标识时仍能核对同组发布按钮', async t => {
  const f = await fixture(t); await f.page.locator('.comment-input-container').evaluate(element => { element.className = 'comment-composer'; element.querySelector('[contenteditable]').setAttribute('data-e2e', 'comment-input'); });
  const result = await f.post(); assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1);
});
test('只有明确发布辅助标签的图标控件也可核对，保留单次点击与收据要求', async t => {
  const f = await modernFixture(t); await f.page.locator('.modern-publish-control').evaluate(element => { element.innerHTML = '<svg aria-label="发布" width="28" height="28"><path d="M2 2L24 14L2 26Z"></path></svg>'; });
  const result = await f.post(); assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1);
});
test('新版div发布控件明确禁用时不点击', async t => {
  const f = await modernFixture(t); await f.page.locator('.modern-publish-control').evaluate(element => element.setAttribute('aria-disabled', 'true'));
  const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(result.needsUserAction, true);
  assert.match(result.reason, /发布控件尚不可用/); assert.equal(await f.page.evaluate(() => window.commentClicks), 0); assert.equal(await f.page.locator('.modern-comment-composer [contenteditable]').innerText(), text);
});
test('发布控件选定后出现第二个同区域按钮仍会中止', async t => {
  const f = await modernFixture(t); let added = false;
  f.hooks.authorize = async ({ phase }) => { if (phase === 'monitor' && !added && await f.page.locator('[data-deepseek-comment-control]').count()) { added = true; await f.page.locator('.modern-comment-composer').evaluate(element => element.insertAdjacentHTML('beforeend', '<button>发布</button>')); } };
  const result = await f.post(); assert.equal(added, true); assert.equal(result.confirmed, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 0); assert.equal(await f.page.locator('.modern-comment-composer [contenteditable]').innerText(), text);
});

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
async function nativeCommentRows(f, { self = 'synthetic-self-profile', duplicateNavigation = false, navigationOrigin = 'https://www.douyin.com', author = 'synthetic-self-profile', mentionSelf = false, duplicateAuthor = false, nestedSelf = false, statusLabel = '' } = {}) {
  await f.page.evaluate(({ self, duplicateNavigation, navigationOrigin, author, mentionSelf, duplicateAuthor, nestedSelf, statusLabel }) => {
    document.querySelector('[data-fixture-default-self]')?.remove();
    const nav = document.createElement('div'); nav.className = 'tab-user_self'; nav.innerHTML = `<a href="${navigationOrigin}/user/${self}">我的</a>`; if (duplicateNavigation) nav.append(nav.firstElementChild.cloneNode(true)); document.body.prepend(nav);
    const make = (id, owner, body) => { const row = document.createElement('div'); row.setAttribute('data-e2e', 'comment-item'); row.innerHTML = `<div class="comment-item-avatar"><a href="https://www.douyin.com/user/${owner}"><span style="display:inline-block;width:30px;height:30px">头像</span></a></div><div class="JPoP3Ezg"><div data-e2e="video-comment-more"><div id="tooltip_${id}"></div></div><div class="FduGc_lz"><span class="Sh1Da424">${body}</span></div></div>`; return row; };
    const row = make('98001', author, '新版合成评论正文');
    if (mentionSelf) row.querySelector('.Sh1Da424').insertAdjacentHTML('beforeend', `<a href="https://www.douyin.com/user/${self}">@合成提及</a>`);
    if (duplicateAuthor) row.querySelector('.comment-item-avatar').append(row.querySelector('.comment-item-avatar a').cloneNode(true));
    if (nestedSelf) { const reply = document.createElement('div'); reply.className = 'replyContainer'; reply.append(make('98002', self, '嵌套的本人回复')); row.append(reply); }
    if (statusLabel) { const label = document.createElement('span'); label.className = 'comment-item-tag-text'; label.textContent = statusLabel; row.append(label); }
    document.querySelector('[data-e2e="comment-list"]').append(row);
  }, { self, duplicateNavigation, navigationOrigin, author, mentionSelf, duplicateAuthor, nestedSelf, statusLabel });
}
test('真实作者profile与唯一官方我的导航比对，读取新版正文但不带出账号', async t => {
  const f = await fixture(t); await nativeCommentRows(f);
  const snapshot = await f.page.evaluate(readCommentDom, '12345'); assert.equal(snapshot.rows.length, 1); assert.equal(snapshot.rows[0].mine, true); assert.equal(snapshot.rows[0].commentId, '98001'); assert.equal(snapshot.rows[0].text, '新版合成评论正文'); assert.equal(snapshot.rows[0].sent, true);
  assert.equal(JSON.stringify(snapshot).includes('synthetic-self-profile'), false); assert.equal(JSON.stringify(snapshot).includes('/user/'), false);
});
test('正文提及自己、嵌套本人回复都不能把别人的顶层评论认成本人', async t => {
  const f = await fixture(t); await nativeCommentRows(f, { author: 'synthetic-other-profile', mentionSelf: true, nestedSelf: true });
  const snapshot = await f.page.evaluate(readCommentDom, '12345'); assert.equal(snapshot.rows.length, 1); assert.equal(snapshot.rows[0].mine, false); assert.equal(snapshot.rows[0].commentId, '98001'); assert.equal(snapshot.rows[0].text.includes('嵌套'), false);
});
test('自账号导航或作者不唯一、导航域名不符时不能补出本人证据', async t => {
  for (const options of [{ duplicateNavigation: true }, { duplicateAuthor: true }, { navigationOrigin: 'https://untrusted.invalid' }]) {
    const f = await fixture(t); await nativeCommentRows(f, options); const snapshot = await f.page.evaluate(readCommentDom, '12345'); assert.equal(snapshot.rows[0].mine, false);
  }
});
test('作者匹配仍须绑定同作品，页面视频编号冲突则不返回成功候选', async t => {
  const f = await fixture(t); await nativeCommentRows(f); await f.page.locator('.comment-mainContent').evaluate(element => element.setAttribute('data-video-id', '67890'));
  assert.equal((await f.page.evaluate(readCommentDom, '12345')).rows.length, 0);
  await f.page.locator('.comment-mainContent').evaluate(element => element.setAttribute('data-video-id', '12345'));
  await f.page.evaluate(() => { const player = document.createElement('div'); player.setAttribute('data-e2e', 'player-container'); player.className = 'video_67890'; player.innerHTML = '<video style="width:300px;height:180px"></video>'; document.body.prepend(player); });
  assert.equal((await f.page.evaluate(readCommentDom, '12345')).rows.length, 0);
});
test('真实样式的审核或失败标签不被当成已发布', async t => {
  for (const statusLabel of ['审核中', '审核未通过']) {
    const f = await fixture(t); await nativeCommentRows(f, { statusLabel }); const row = (await f.page.evaluate(readCommentDom, '12345')).rows[0]; assert.equal(row.mine, true); assert.equal(row.sent, false); assert.equal(row.pending || row.failed, true);
  }
});
test('真实合成发布链路跨入口撤回许可，服务保留扣费与草稿但不发布', async t => {
  const f = await fixture(t), now = Date.now(), evidenceId = `video:${'a'.repeat(64)}`, watchRunId = 'synthetic-comment-watch';
  const personaMemory = { snapshot: () => ({ recentObservations: [{ id: evidenceId, videoId: '12345', url: 'https://www.douyin.com/video/12345', sources: ['api'], privacy: 'internal-reference', visibility: 'account-visible-unverified', observedAt: now }] }) };
  const videoLimits = { state: () => ({ allowed: true, session: { status:'active', id: 'synthetic-session', startAt: now, expiresAt: now + 60000 } }) };
  fs.writeFileSync(path.join(f.stateDir, 'watch-loop.lock'), JSON.stringify({ pid: process.pid, source: 'api', runId: watchRunId, sessionId: 'synthetic-session', status: 'running' }));
  const foreign = new AutonomousComments({ personaMemory, videoLimits, stateDir: f.stateDir }); let scheduled = false, disabled = false;
  const service = new AutonomousComments({ personaMemory, videoLimits, stateDir: f.stateDir, post: (input, controls) => {
    const authorize = async request => { const result = controls.authorize(request); if (request.phase === 'monitor' && !scheduled && await f.page.locator('[contenteditable]').innerText() === text) { scheduled = true; await f.page.evaluate(() => document.querySelector('[data-e2e="comment-post"]').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 800 })); setTimeout(() => { disabled = foreign.configure({ enabled: false }, { explicit: true }).enabled === false; }, 80); } return result; }; authorize.beginDispatch = controls.authorize.beginDispatch;
    return f.commenter.post(input, { ...controls, authorize });
  } });
  service.configure({ enabled: true }, { explicit: true }); const result = await service.comment({ evidenceId, videoId: '12345', text }, { watchRunId });
  assert.equal(disabled, true); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 0); assert.equal(await f.page.locator('[contenteditable]').innerText(), text); assert.equal(service.ledger().operations[0].status, 'not-sent'); assert.equal(service.state().daily.attempts, 1); await service.close(); await foreign.close();
});

test('inner-only真实结构不依赖旧outer类，懒占位激活后保留签名核对并只发布一次', async t => {
  const f = await nativeFixture(t, { innerOnly: true }); assert.equal(await f.page.locator('.comment-input-container').count(), 0);
  const result = await f.post(); assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.commentActivations), 1); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 1); assert.equal(await f.page.evaluate(() => window.nativeEmojiClicks), 0);
});
test('inner-only已激活编辑器可识别同区域真实签名图标', async t => {
  const f = await nativeFixture(t, { innerOnly: true, activated: true }); const initial = await inspectCommentComposer(f.page, '12345'); assert.equal(initial.nativeIcon, true); assert.equal(initial.enabled, false);
  assert.equal((await f.post()).confirmed, true); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 1);
});
test('inner-only私信弹幕和评论内容中的相似容器不激活或发布', async t => {
  for (const type of ['im-dialog', 'danmaku-container', 'comment-item']) {
    const f = await nativeFixture(t, { innerOnly: true }); await f.page.locator('.native-comment-synthetic-outer').evaluate((outer, type) => { const wrapper = document.createElement('div'); wrapper.setAttribute('data-e2e', type); outer.replaceWith(wrapper); wrapper.append(outer); }, type);
    const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.evaluate(() => window.commentActivations), 0); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0);
  }
});
test('inner-only多个公开inner不猜目标，激活态也不发布', async t => {
  for (const activated of [false, true]) { const f = await nativeFixture(t, { innerOnly: true, activated }); await f.page.evaluate(() => { const other = document.createElement('div'); other.className = 'comment-input-inner-container'; other.style.cssText = 'width:300px;min-height:60px'; other.innerHTML = '<span class="RXtfhfhu">留下你的精彩评论吧</span>'; document.body.append(other); });
    const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0); if (!activated) assert.equal(await f.page.evaluate(() => window.commentActivations), 0);
  }
});
test('inner-only已有文字草稿、错误占位span和不同作品归属仍拒绝', async t => {
  const draft = await nativeFixture(t, { innerOnly: true, activated: true, existingDraft: '本人原有草稿' }); assert.equal((await draft.post()).confirmed, false); assert.equal(await draft.page.locator('.public-DraftEditor-content').innerText(), '本人原有草稿'); assert.equal(await draft.page.evaluate(() => window.nativeCommentClicks), 0);
  const placeholder = await nativeFixture(t, { innerOnly: true }); await placeholder.page.locator('span.RXtfhfhu').evaluate(element => element.className = 'unverified-placeholder'); assert.equal((await placeholder.post()).confirmed, false); assert.equal(await placeholder.page.evaluate(() => window.commentActivations), 0);
  const other = await nativeFixture(t, { innerOnly: true }); await other.page.locator('.native-comment-synthetic-outer').evaluate(element => element.setAttribute('data-video-id', '67890')); assert.equal((await other.post()).confirmed, false); assert.equal(await other.page.evaluate(() => window.commentActivations), 0); assert.equal(await other.page.evaluate(() => window.nativeCommentClicks), 0);
});
test('inner-only仍要求toolbar归属、唯一图标和完整路径签名', async t => {
  for (const options of [{ wrongGeometry: true }, { wrongToolbar: true }, { duplicate: true }]) { const f = await nativeFixture(t, { innerOnly: true, ...options }); const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0); assert.equal(await f.page.evaluate(() => window.nativeEmojiClicks), 0); }
});

async function freezeCommentRaf(f) {
  await f.page.evaluate(() => { window.syntheticRafScheduled = 0; window.syntheticRafDelivered = 0; window.requestAnimationFrame = () => ++window.syntheticRafScheduled; window.cancelAnimationFrame = () => {}; requestAnimationFrame(() => window.syntheticRafDelivered++); });
  const calls = { locatorClick: 0, waitForFunction: 0 }, original = f.page.locator.bind(f.page), cache = new WeakMap(), real = new WeakMap();
  const wrap = locator => { if (cache.has(locator)) return cache.get(locator); const proxy = new Proxy(locator, { get(target, key) { if (key === 'click') return () => { calls.locatorClick++; throw new Error('冻结rAF用例禁止旧locator.click路径'); }; const value = Reflect.get(target, key); if (typeof value !== 'function') return value; return (...args) => { const result = value.apply(target, args.map(arg => real.get(arg) || arg)); return result && typeof result.locator === 'function' && typeof result.count === 'function' ? wrap(result) : result; }; } }); cache.set(locator, proxy); real.set(proxy, locator); return proxy; };
  f.page.locator = (...args) => wrap(original(...args));
  f.page.waitForFunction = () => { calls.waitForFunction++; throw new Error('冻结rAF用例禁止默认RAF等待'); };
  return calls;
}
async function assertCommentPointerClean(f) { assert.equal(await f.page.locator('[data-deepseek-comment-pointer],[data-deepseek-comment-pointer-scope]').count(), 0); assert.equal(await f.page.evaluate(() => Object.keys(window.__deepseekCommentGeometryInputs || {}).length), 0); }
test('冻结rAF的inner-only懒激活到发布全链路用trusted mouse且只发布一次', async t => {
  const f = await nativeFixture(t, { innerOnly: true }), calls = await freezeCommentRaf(f), result = await f.post();
  assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 1); assert.equal(await f.page.evaluate(() => window.commentActivations), 1); assert.equal(await f.page.evaluate(() => window.syntheticRafDelivered), 0); assert.deepEqual(calls, { locatorClick: 0, waitForFunction: 0 }); await assertCommentPointerClean(f);
});
test('冻结rAF的已激活编辑器与语义发布控件均不走locator稳定性等待', async t => {
  for (const native of [false, true]) { const f = native ? await nativeFixture(t, { innerOnly: true, activated: true }) : await fixture(t), calls = await freezeCommentRaf(f); assert.equal((await f.post()).confirmed, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); assert.deepEqual(calls, { locatorClick: 0, waitForFunction: 0 }); await assertCommentPointerClean(f); }
});
test('冻结rAF仍拒绝用户已有草稿，不填入或发布', async t => {
  const f = await nativeFixture(t, { innerOnly: true, activated: true, existingDraft: '用户原有草稿' }); await freezeCommentRaf(f); const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.locator('.public-DraftEditor-content').innerText(), '用户原有草稿'); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0); await assertCommentPointerClean(f);
});
test('冻结rAF等待期间撤销许可或切换作品仍不发布并保留草稿', async t => {
  for (const mode of ['permission', 'video']) { const f = await nativeFixture(t, { innerOnly: true }); await freezeCommentRaf(f); let changed = false; f.hooks.authorize = async ({ phase }) => { if (phase === 'monitor' && !changed && await f.page.locator('[data-deepseek-comment-control]').count()) { changed = true; if (mode === 'permission') f.setAllowed(false); else await f.page.evaluate(() => window.fixtureState.video.id = '67890'); } }; const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0); const draft = await f.page.locator('.public-DraftEditor-content').innerText(); assert.equal(draft.replace(/[\u200B-\u200F\uFEFF]/g, '').trim(), text); assert.ok(draft === text || draft === '\u200b' + text); await assertCommentPointerClean(f); }
});
test('冻结rAF最终输入前替换同几何按钮，不沿旧token发布', async t => {
  const f = await nativeFixture(t, { innerOnly: true }); await freezeCommentRaf(f); f.hooks.authorize = async ({ phase }) => { if (phase === 'before-click') await f.page.locator('[data-deepseek-comment-control]').evaluate(element => element.replaceWith(element.cloneNode(true))); };
  const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0); await assertCommentPointerClean(f);
});
test('冻结rAF最后native输入边界出现验证码或改草稿会被同步门禁拦截', async t => {
  for (const mutation of ['captcha', 'draft']) { const f = await nativeFixture(t, { innerOnly: true }); await freezeCommentRaf(f); const mouse = f.page.mouse.click.bind(f.page.mouse); f.page.mouse.click = async (...args) => { const armed = await f.page.evaluate(() => Object.values(window.__deepseekCommentGeometryInputs || {}).some(entry => entry.mode === 'submit' && entry.armed)); if (armed) await f.page.evaluate(mutation => { if (mutation === 'captcha') { const blocker = document.createElement('div'); blocker.id = 'captcha_container'; blocker.style.cssText = 'position:fixed;inset:0;z-index:10000'; document.body.append(blocker); } else document.querySelector('[contenteditable]').textContent = '用户最后改写'; }, mutation); return mouse(...args); };
    const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0); assert.equal(result.deliveryUncertain, true); await f.post(); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0); await assertCommentPointerClean(f); }
});
test('冻结rAF点击后没有平台新评论仍uncertain且不重发', async t => {
  const f = await modernFixture(t, { clearWithoutReceipt: true }); await freezeCommentRaf(f); const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); await f.post(); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); await assertCommentPointerClean(f);
});
test('冻结rAF最终输入瞬间新增回复目标、附件或改变composer归属均被拦截', async t => {
  for (const mutation of ['reply', 'file', 'owner', 'reparent', 'duplicate-editor']) { const f = await nativeFixture(t, { innerOnly: true }); await freezeCommentRaf(f); const mouse = f.page.mouse.click.bind(f.page.mouse); f.page.mouse.click = async (...args) => { const armed = await f.page.evaluate(() => Object.values(window.__deepseekCommentGeometryInputs || {}).some(entry => entry.mode === 'submit' && entry.armed)); if (armed) await f.page.evaluate(mutation => { const inner = document.querySelector('.comment-input-inner-container'); if (mutation === 'reply') { const reply = document.createElement('span'); reply.dataset.e2e = 'comment-reply-target'; reply.textContent = '回复目标'; inner.append(reply); } if (mutation === 'file') { const data = new DataTransfer(); data.items.add(new File(['临时合成附件'], 'synthetic.txt')); inner.querySelector('input[type="file"]').files = data.files; } if (mutation === 'owner') inner.dataset.videoId = '67890'; if (mutation === 'reparent') { const other = document.createElement('section'); other.dataset.videoId = '67890'; document.body.append(other); other.append(inner.querySelector('[contenteditable]')); } if (mutation === 'duplicate-editor') { const editor = document.createElement('div'); editor.contentEditable = 'true'; inner.append(editor); } }, mutation); return mouse(...args); };
    const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0); await assertCommentPointerClean(f); }
});


test('前置适配补测：合法pointerdown展开后仍取得真实编辑器，完整发布只发生一次', async t => {
  const f = await modernFixture(t);
  await f.page.locator('.modern-comment-composer .comment-input-inner-container').evaluate(lazy => lazy.addEventListener('pointerdown', () => { lazy.style.height = '140px'; }));
  const result = await f.post();
  assert.equal(result.confirmed, true); assert.equal(result.deliveryUncertain, false);
  assert.equal(await f.page.evaluate(() => window.commentActivations), 1); assert.equal(await f.page.evaluate(() => window.commentClicks), 1);
  await assertCommentPointerClean(f);
});
test('前置适配补测：小数布局选择整数命中点，完整发布与本人回读仍通过', async t => {
  const f = await modernFixture(t);
  await f.page.locator('.modern-comment-composer').evaluate(composer => { composer.style.transform = 'translate(.75px,.75px)'; });
  const result = await f.post();
  assert.equal(result.confirmed, true); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 1);
  await assertCommentPointerClean(f);
});
test('前置适配补测：应用document捕获处理懒激活，仍需实际编辑器和完整发布回读', async t => {
  const f = await modernFixture(t);
  await f.page.evaluate(() => {
    const composer = document.querySelector('.modern-comment-composer'), lazy = composer.querySelector('.comment-input-inner-container');
    document.addEventListener('click', event => {
      if (!lazy.contains(event.target)) return;
      if (!lazy.querySelector('[contenteditable]')) {
        window.commentActivations++; lazy.textContent = '';
        const editor = document.createElement('div'); editor.contentEditable = 'true'; editor.setAttribute('role', 'textbox'); editor.style.cssText = 'min-height:40px;width:290px'; lazy.append(editor);
        editor.addEventListener('input', () => { for (const node of composer.querySelectorAll('.modern-publish-control')) node.style.display = 'block'; }); editor.focus();
      }
      event.stopImmediatePropagation();
    }, { capture: true });
  });
  const result = await f.post();
  assert.equal(result.confirmed, true); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 1);
  await assertCommentPointerClean(f);
});
test('前置适配补测：应用document捕获发布导致见证丢失仍uncertain，平台有行也不自动重发', async t => {
  const f = await modernFixture(t);
  await f.page.evaluate(() => {
    const publish = document.querySelector('.modern-publish-control');
    document.addEventListener('click', event => {
      if (!publish.contains(event.target)) return;
      window.commentClicks++; const editor = document.querySelector('.modern-comment-composer [contenteditable]');
      window.appendComment({ id: '99991', mine: true, status: 'sent', videoId: '12345', text: editor.innerText }); editor.textContent = ''; event.stopImmediatePropagation();
    }, { capture: true });
  });
  const result = await f.post();
  assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1);
  await f.post(); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); await assertCommentPointerClean(f);
});
test('前置适配补测：更早window捕获阻止见证时停在激活前，无发布收据', async t => {
  const f = await modernFixture(t);
  await f.page.evaluate(() => {
    const lazy = document.querySelector('.modern-comment-composer .comment-input-inner-container');
    window.addEventListener('click', event => { if (lazy.contains(event.target)) event.stopImmediatePropagation(); }, { capture: true });
  });
  const result = await f.post();
  assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 0);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'comment-browser-receipts.json')), false); await assertCommentPointerClean(f);
});


async function installInlineCommentEmoji(f, options = {}) {
  await nativeCommentRows(f, options);
  await f.page.locator('[data-e2e="comment-item"]').first().evaluate((row, options) => {
    const content = row.querySelector('.FduGc_lz > .Sh1Da424'); content.textContent = '';
    const span = document.createElement('span'); span.textContent = '合成表情评论正文';
    const image = document.createElement('img'); image.alt = '🐟'; image.src = 'https://synthetic.invalid/emoji.png'; image.draggable = false; span.append(image); content.append(span);
    row.__reactFiber$syntheticEmojiComparison = { memoizedProps: { commentInfo: { cid: '98001', text: options.metadataText || '合成表情评论正文🐟', user: { secUid: 'synthetic-self-profile' }, status: 1 } } };
  }, options);
}
test('表情回读补测：owned正文按IMG alt还原，同文与固定metadata一致但不读取metadata', async t => {
  const f = await fixture(t); await installInlineCommentEmoji(f);
  const result = await f.page.evaluate(readCommentDom, { expectedVideoId: '12345', ownProfileId: 'synthetic-self-profile' });
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].text, '合成表情评论正文🐟'); assert.equal(result.rows[0].mine, true); assert.equal(result.rows[0].sent, true);
  assert.equal(await f.page.locator('.FduGc_lz > .Sh1Da424').innerText(), '合成表情评论正文');
  await f.page.locator('[data-e2e="comment-item"]').first().evaluate(row => { Object.defineProperty(row, '__reactFiber$syntheticEmojiComparison', { configurable: true, get() { throw new Error('回读不应调用metadata getter'); } }); });
  assert.equal((await f.page.evaluate(readCommentDom, '12345')).rows[0].text, '合成表情评论正文🐟');
});
test('表情回读补测：DOM和metadata不一致时只返回DOM，不用metadata凑同文', async t => {
  const f = await fixture(t); await installInlineCommentEmoji(f, { metadataText: '与DOM不同的合成目标🐟' });
  const row = (await f.page.evaluate(readCommentDom, '12345')).rows[0]; assert.equal(row.text, '合成表情评论正文🐟'); assert.notEqual(row.text, '与DOM不同的合成目标🐟');
});
test('表情回读补测：BR保留换行顺序，title或aria不能替代缺失alt', async t => {
  const f = await fixture(t); await installInlineCommentEmoji(f);
  await f.page.locator('.FduGc_lz > .Sh1Da424').evaluate(content => { content.innerHTML = '<span>第一行<br>第二行</span>'; });
  assert.equal((await f.page.evaluate(readCommentDom, '12345')).rows[0].text, '第一行\n第二行');
  await f.page.locator('.FduGc_lz > .Sh1Da424').evaluate(content => { content.innerHTML = '<span>合成文字<img title="🐟" aria-label="🐟" src="https://synthetic.invalid/emoji.png"></span>'; });
  const row = (await f.page.evaluate(readCommentDom, '12345')).rows[0]; assert.equal(row.text, ''); assert.ok(row.commentId, '未知正文仍保留原合法ID以防基线漏项');
});
test('表情回读补测：异常IMG、非文本控件和超限内容不产生部分同文', async t => {
  const cases = ['missing-alt','long-alt','control-alt','ordinary-alt','unsafe-src','credential-src','linked-image','too-many-images','too-many-nodes','too-long-text','input-control','svg'];
  for (const mutation of cases) {
    const f = await fixture(t); await installInlineCommentEmoji(f);
    await f.page.locator('.FduGc_lz > .Sh1Da424').evaluate((content, mutation) => {
      const image = content.querySelector('img');
      if (mutation === 'missing-alt') image.removeAttribute('alt');
      if (mutation === 'long-alt') image.alt = '🐟'.repeat(17);
      if (mutation === 'control-alt') image.alt = '🐟\n';
      if (mutation === 'ordinary-alt') image.alt = '普通附件图片';
      if (mutation === 'unsafe-src') image.src = 'data:image/png;base64,AA==';
      if (mutation === 'credential-src') image.src = 'https://synthetic:fixture@synthetic.invalid/emoji.png';
      if (mutation === 'linked-image') { const link = document.createElement('a'); link.href = 'https://synthetic.invalid/'; image.replaceWith(link); link.append(image); }
      if (mutation === 'too-many-images') for (let index = 0; index < 8; index++) content.append(image.cloneNode());
      if (mutation === 'too-many-nodes') for (let index = 0; index < 180; index++) content.append(document.createElement('span'));
      if (mutation === 'too-long-text') content.textContent = 'x'.repeat(513);
      if (mutation === 'input-control') content.append(document.createElement('input'));
      if (mutation === 'svg') content.insertAdjacentHTML('beforeend', '<svg></svg>');
    }, mutation);
    const row = (await f.page.evaluate(readCommentDom, '12345')).rows[0]; assert.equal(row.text, '', mutation); assert.ok(row.commentId, mutation);
  }
});
test('表情回读补测：私信或嵌套row不能进入owned正文，也不泄漏其文字', async t => {
  for (const kind of ['im-dialog','comment-item']) {
    const f = await fixture(t); await installInlineCommentEmoji(f);
    await f.page.locator('.FduGc_lz > .Sh1Da424').evaluate((content, kind) => { const foreign = document.createElement('span'); foreign.dataset.e2e = kind; foreign.textContent = '不应被采集的合成内容'; content.append(foreign); }, kind);
    const result = await f.page.evaluate(readCommentDom, '12345'); assert.equal(result.rows[0].text, ''); assert.equal(JSON.stringify(result).includes('不应被采集'), false);
  }
});
test('表情回读补测：hidden表情不补入正文，不把未知可见图片猜成emoji', async t => {
  const f = await fixture(t); await installInlineCommentEmoji(f);
  await f.page.locator('.FduGc_lz > .Sh1Da424 img').evaluate(image => { image.style.display = 'none'; });
  assert.equal((await f.page.evaluate(readCommentDom, '12345')).rows[0].text, '合成表情评论正文');
});
test('表情回读补测：重建正文不覆盖作者、作品、唯一编号和审核状态门槛', async t => {
  for (const options of [{ author: 'synthetic-other-profile' }, { duplicateAuthor: true }, { statusLabel: '审核中' }, { statusLabel: '审核未通过' }]) {
    const f = await fixture(t); await installInlineCommentEmoji(f, options); const row = (await f.page.evaluate(readCommentDom, '12345')).rows[0]; assert.equal(row.text, '合成表情评论正文🐟');
    if (options.author || options.duplicateAuthor) assert.equal(row.mine, false); else assert.equal(row.sent, false);
  }
  const f = await fixture(t); await installInlineCommentEmoji(f); await f.page.locator('[data-e2e="comment-item"]').first().evaluate(row => { row.dataset.commentId = '98002'; });
  const conflict = (await f.page.evaluate(readCommentDom, '12345')).rows[0]; assert.equal(conflict.commentId, null); assert.equal(conflict.sent, false);
  await f.page.locator('.comment-mainContent').evaluate(node => { node.dataset.videoId = '67890'; }); assert.equal((await f.page.evaluate(readCommentDom, '12345')).rows.length, 0);
});
test('表情回读补测：真实合成post在一次点击后按同文新编号双读确认', async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => { const append = window.appendComment; window.appendComment = entry => { append(entry); const content = document.querySelector('[data-e2e="comment-item"]:last-child [data-e2e="comment-content"]'); const body = content.textContent; content.textContent = body.replace('🐟', ''); const image = document.createElement('img'); image.alt = '🐟'; image.src = 'https://synthetic.invalid/emoji.png'; content.append(image); }; });
  const result = await f.commenter.post({ expectedVideoId: '12345', text: '合成画面的配色很舒服。🐟' }, { authorize: f.authorize });
  assert.equal(result.confirmed, true); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); await assertCommentPointerClean(f);
});
test('表情回读补测：旧编号从未知alt变可读也不能冒充点击后新评论', async t => {
  const f = await fixture(t, { result: null, existing: [{ id: '90000', mine: true, status: 'sent', text: '合成画面的配色很舒服。' }] });
  await f.page.locator('[data-e2e="comment-content"]').evaluate(content => { const image = document.createElement('img'); image.src = 'https://synthetic.invalid/emoji.png'; content.append(image); });
  await f.page.evaluate(() => document.querySelector('[data-e2e="comment-post"]').addEventListener('click', () => { document.querySelector('[data-e2e="comment-content"] img').alt = '🐟'; }));
  const result = await f.commenter.post({ expectedVideoId: '12345', text: '合成画面的配色很舒服。🐟' }, { authorize: f.authorize });
  assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); await assertCommentPointerClean(f);
});

import {checkReceiptBaseline as checkCommentBaseline} from '../receipt-baseline.mjs';
import {createHash as receiptBaselineHash} from 'node:crypto';
function installCommentBaselineFault(file,mode){
  const originals={openSync:fs.openSync,writeFileSync:fs.writeFileSync,fsyncSync:fs.fsyncSync,renameSync:fs.renameSync},descriptors=new Set();
  fs.openSync=(target,...args)=>{const descriptor=originals.openSync(target,...args);if(typeof target==='string'&&target.startsWith(file+'.'))descriptors.add(descriptor);return descriptor;};
  fs.writeFileSync=(target,...args)=>{if(mode==='write'&&descriptors.has(target))throw Object.assign(Error('合成评论基线写失败'),{code:'EIO'});return originals.writeFileSync(target,...args);};
  fs.fsyncSync=descriptor=>{if(mode==='fsync'&&descriptors.has(descriptor))throw Object.assign(Error('合成评论基线刷盘失败'),{code:'EIO'});return originals.fsyncSync(descriptor);};
  fs.renameSync=(from,to)=>{if(mode==='rename'&&to===file)throw Object.assign(Error('合成评论基线原子换入失败'),{code:'EIO'});return originals.renameSync(from,to);};
  return()=>Object.assign(fs,originals);
}
test('持久基线评论：发布点击前已落盘，确认状态保留同一有限基线',async t=>{
  const f=await fixture(t,{existing:[{id:'90000',videoId:'12345',mine:true,status:'sent',text:'合成旧评论'}]});let checked=0;const click=f.page.mouse.click.bind(f.page.mouse);
  f.page.mouse.click=async(...args)=>{if(fs.existsSync(f.commenter.receiptsFile)){const row=f.commenter.receipts().operations[0];assert.equal(row.status,'clicking');assert.equal(checkCommentBaseline(row,'public-comment').available,true);assert.deepEqual(row.baseline.knownIds,['90000']);assert.equal(row.baseline.ownProfileHash,receiptBaselineHash('sha256').update('synthetic-self-profile').digest('hex'));assert.equal(JSON.stringify(row.baseline).includes('synthetic-self-profile'),false);assert.equal(JSON.stringify(row.baseline).includes(text),false);checked++;}return click(...args);};
  const result=await f.post();assert.equal(result.confirmed,true);assert.equal(checked,1);assert.equal(await f.page.evaluate(()=>window.commentClicks),1);const row=f.commenter.receipts().operations[0];assert.equal(row.status,'confirmed');assert.equal(checkCommentBaseline(row,'public-comment').available,true);
});
test('持久基线评论：写入、刷盘、换入失败均零发布点击，保留原旧格式收据',async t=>{
  for(const mode of ['write','fsync','rename']){const f=await fixture(t),legacy={version:1,operations:[{operationId:'legacy-comment',videoId:'88888',status:'uncertain'}]};fs.writeFileSync(f.commenter.receiptsFile,JSON.stringify(legacy));const before=fs.readFileSync(f.commenter.receiptsFile),restore=installCommentBaselineFault(f.commenter.receiptsFile,mode);let result;try{result=await f.post();}finally{restore();}assert.equal(result.confirmed,false,mode);assert.equal(result.deliveryUncertain,false,mode);assert.equal(await f.page.evaluate(()=>window.commentClicks),0,mode);assert.deepEqual(fs.readFileSync(f.commenter.receiptsFile),before,mode);assert.equal(fs.readdirSync(f.stateDir).some(name=>name.endsWith('.tmp')),false,mode);}
});
test('持久基线评论：不确定结果重建后保留原基线，既有无基线收据不升级或重发',async t=>{
  const f=await fixture(t,{result:null});const result=await f.post();assert.equal(result.deliveryUncertain,true);const raw=fs.readFileSync(f.commenter.receiptsFile),snapshot=f.commenter.receipts(),restarted=new CommentBrowser({stateDir:f.stateDir,controller:{withPage:async()=>assert.fail('恢复收据不连接浏览器')},videoLimits:{state:()=>({allowed:true})}});assert.deepEqual(restarted.receipts(),snapshot);assert.equal(checkCommentBaseline(snapshot.operations[0],'public-comment').available,true);assert.deepEqual(fs.readFileSync(f.commenter.receiptsFile),raw);const again=await f.post();assert.equal(again.confirmed,false);assert.equal(await f.page.evaluate(()=>window.commentClicks),1);assert.deepEqual(fs.readFileSync(f.commenter.receiptsFile),raw);
  const legacy={version:1,operations:[{operationId:'legacy-comment',videoId:'12345',status:'uncertain'}]};fs.writeFileSync(f.commenter.receiptsFile,JSON.stringify(legacy));const old=fs.readFileSync(f.commenter.receiptsFile);assert.equal(checkCommentBaseline(f.commenter.receipts().operations[0],'public-comment').available,false);await f.post();assert.deepEqual(fs.readFileSync(f.commenter.receiptsFile),old);assert.equal(await f.page.evaluate(()=>window.commentClicks),1);
});
