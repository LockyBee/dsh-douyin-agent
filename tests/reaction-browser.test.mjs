import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../playwright-runtime.mjs';
import { readPageState } from '../core.mjs';
import { readReactionTarget, reactToVideo } from '../reaction-browser.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
async function fixture(t, { action = 'like', active = false } = {}) {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
  await page.goto('https://www.douyin.com/video/12345');
  const label = action === 'like' ? '点赞' : '收藏';
  await page.setContent(`<div class="tab-user_self"><a href="/user/synthetic-self-profile">我的</a></div><section data-aweme-id="12345"><button aria-label="${active ? '取消' : ''}${label}" aria-pressed="${active}">操作</button></section>`);
  await page.evaluate(({ label }) => {
    window.fixtureState = { video: { id: '12345', readyState: 4 }, loginRequired: false, verificationRequired: false, privateChatVisible: false };
    window.clicks = 0;
    document.querySelector('button').addEventListener('click', event => {
      window.clicks++;
      const node = event.currentTarget, active = node.getAttribute('aria-pressed') === 'true';
      node.setAttribute('aria-pressed', String(!active)); node.setAttribute('aria-label', active ? label : `取消${label}`);
    });
  }, { label });
  const evaluate = page.evaluate.bind(page);
  page.evaluate = (fn, args) => fn === readPageState ? evaluate(() => window.fixtureState) : evaluate(fn, args);
  const controller = { withPage: async callback => callback(page) }, hooks = {};
  const authorize = async request => { if (hooks.authorize) await hooks.authorize(request); return true; };
  authorize.beginDispatch = () => () => {};
  t.after(() => page.close());
  return { page, hooks, input: { action, expectedVideoId: '12345' }, run: () => reactToVideo(controller, { action, expectedVideoId: '12345' }, { authorize }) };
}

test('点赞收藏各只点击一次，回读同作品已选状态并移除监听器', async t => {
  for (const action of ['like', 'favorite']) {
    const f = await fixture(t, { action }); const result = await f.run();
    assert.equal(result.verified, true); assert.equal(result.active, true); assert.equal(result.alreadyActive, false);
    assert.equal(await f.page.evaluate(() => window.clicks), 1);
    assert.equal(await f.page.evaluate(() => window.__dafeiyuReactionGuards), undefined);
    assert.equal(await f.page.locator('[data-dafeiyu-reaction]').count(), 0);
  }
});

test('已经选中的作品不点击，避免变成取消', async t => {
  const f = await fixture(t, { active: true }); const result = await f.run();
  assert.equal(result.alreadyActive, true); assert.equal(await f.page.evaluate(() => window.clicks), 0);
});

test('重复目标、评论中的点赞、状态冲突或其他作品均不猜测', async t => {
  for (const mutation of ['duplicate', 'comment', 'conflict', 'other', 'unknown-state']) {
    const f = await fixture(t);
    await f.page.evaluate(mutation => {
      const root = document.querySelector('section'), button = document.querySelector('button');
      if (mutation === 'duplicate') root.append(button.cloneNode(true));
      if (mutation === 'comment') root.setAttribute('data-e2e', 'comment-item');
      if (mutation === 'conflict') button.setAttribute('aria-pressed', 'true');
      if (mutation === 'other') root.setAttribute('data-aweme-id', '67890');
      if (mutation === 'unknown-state') button.removeAttribute('aria-pressed');
    }, mutation);
    assert.equal(await f.page.evaluate(readReactionTarget, f.input), null);
    const result = await f.run(); assert.equal(result.verified, false);
    assert.equal(await f.page.evaluate(() => window.clicks), 0);
  }
});

test('最终点击前作品、本人账号或按键状态改变时拦截输入', async t => {
  for (const mutation of ['video', 'account', 'pressed']) {
    const f = await fixture(t);
    f.hooks.authorize = async ({ phase }) => {
      if (phase !== 'before-click') return;
      await f.page.evaluate(mutation => {
        if (mutation === 'video') document.querySelector('section').setAttribute('data-aweme-id', '67890');
        if (mutation === 'account') document.querySelector('.tab-user_self a').setAttribute('href', '/user/different-account');
        if (mutation === 'pressed') document.querySelector('button').setAttribute('aria-pressed', 'true');
      }, mutation);
    };
    const result = await f.run(); assert.equal(result.verified, false); assert.equal(result.deliveryUncertain, true);
    assert.equal(await f.page.evaluate(() => window.clicks), 0);
  }
});

test('私信面板、验证或账号不明时不操作；不会自己导航开新页', async t => {
  for (const mutation of ['private', 'verify', 'self']) {
    const f = await fixture(t);
    await f.page.evaluate(mutation => {
      if (mutation === 'private') window.fixtureState.privateChatVisible = true;
      if (mutation === 'verify') window.fixtureState.verificationRequired = true;
      if (mutation === 'self') document.querySelector('.tab-user_self').remove();
    }, mutation);
    await assert.rejects(f.run()); assert.equal(await f.page.evaluate(() => window.clicks), 0);
  }
});
