import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '../playwright-runtime.mjs';
import { BrowserController } from '../core.mjs';
import { BrowserLauncher } from '../browser-launcher.mjs';
import { browserPageLabel, browserPageLock, findSharedPage, adoptSharedPreparePage } from '../browser-pages.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
async function fixture(t) {
  const context = await browser.newContext();
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-shared-pages-'));
  t.after(async () => { await context.close(); await fs.rm(controlDirectory, { recursive: true, force: true }); });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><textarea data-test="draft"></textarea>' }));
  const scoped = { contexts: () => [context], isConnected: () => true };
  async function page(label, url = 'https://www.douyin.com/?recommend=1') {
    const page = await context.newPage(); await page.goto(url); await page.evaluate(label => { window.name = label; }, label); return page;
  }
  function controller(source) { const value = new BrowserController({ source, controlDirectory }); value.browser = scoped; value.getWatchMode = async () => ({ apply: async () => {} }); return value; }
  return { context, scoped, page, controller };
}

test('软件和插件按用途共用标签与跨进程锁，用量来源仍分别保留', async t => {
  const f = await fixture(t), video = await f.page('deepseek-douyin-api'), chat = await f.page('deepseek-douyin-api-chat');
  await chat.locator('textarea').fill('合成未发送草稿');
  const api = f.controller('api'), dsh = f.controller('dsh'), apiChat = f.controller('api-chat'), dshChat = f.controller('dsh-chat');
  assert.equal(browserPageLabel('api'), browserPageLabel('dsh'));
  assert.equal(browserPageLock('api'), browserPageLock('dsh'));
  assert.equal(browserPageLock('api-chat'), browserPageLock('dsh-chat'));
  assert.notEqual(browserPageLock('api'), browserPageLock('api-chat'));
  for (const controller of [api, dsh]) assert.equal(await controller.connect(), video);
  for (const controller of [apiChat, dshChat]) assert.equal(await controller.connect(), chat);
  const events = [];
  await Promise.all([api, dsh].map((controller, index) => controller.withPage(async page => {
    assert.equal(page, video); events.push(`开始${index}`); await new Promise(resolve => setTimeout(resolve, 35)); events.push(`结束${index}`);
  })));
  assert.deepEqual(events, ['开始0','结束0','开始1','结束1']);
  assert.equal(await chat.locator('textarea').inputValue(), '合成未发送草稿');
  assert.equal(f.context.pages().length, 2); assert.equal(api.source, 'api'); assert.equal(dsh.source, 'dsh');
});

test('仅有旧插件页时原地接管，保留地址和草稿，不增加页面', async t => {
  const f = await fixture(t), page = await f.page('deepseek-douyin-dsh-chat'); await page.locator('textarea').fill('旧页草稿');
  const controller = f.controller('dsh-chat'); assert.equal(await controller.connect(), page);
  assert.equal(await page.evaluate(() => window.name), 'deepseek-douyin-api-chat');
  assert.equal(await page.locator('textarea').inputValue(), '旧页草稿'); assert.equal(f.context.pages().length, 1);
});

test('打开抖音与自主观看显示共同作品页，反复操作保持两页', async t => {
  const f = await fixture(t), video = await f.page('deepseek-douyin-api'); await f.page('deepseek-douyin-api-chat');
  const launcher = new BrowserLauncher({ getBrowser: async () => f.scoped, preferExistingWatchPage: true, preferredSource: 'dsh', getWatchState: () => ({ source: 'dsh' }) });
  for (let i = 0; i < 3; i++) { const result = await launcher.open(); assert.equal(result.mode, 'watch'); assert.equal(result.reused, true); }
  assert.equal(f.context.pages().length, 2); assert.equal(await findSharedPage(f.scoped, 'dsh'), video);
});

test('另一入口创建的准备页可原地转为作品页，解除暂停监听，不新建第三页', async t => {
  const f = await fixture(t), prepared = await f.page('deepseek-douyin-launcher'); await f.page('deepseek-douyin-api-chat');
  await prepared.evaluate(() => { window.__dafeiyuPrepareLease = { version: 2, label: window.name, touched: true, release() { window.syntheticReleased = true; } }; });
  assert.equal(await f.controller('dsh').connect(), prepared);
  assert.equal(await prepared.evaluate(() => window.name), 'deepseek-douyin-api');
  assert.equal(await prepared.evaluate(() => window.syntheticReleased), true); assert.equal(f.context.pages().length, 2);
});

test('准备页草稿或验证码未处理时保留原页，拒绝通过新增标签绕开保护', async t => {
  const f = await fixture(t), prepared = await f.page('deepseek-douyin-launcher'); await prepared.locator('textarea').fill('不要丢弃');
  await assert.rejects(f.controller('api').connect(), { code: 'BROWSER_PREPARE_PROTECTED' });
  assert.equal(f.context.pages().length, 1); assert.equal(await prepared.locator('textarea').inputValue(), '不要丢弃');
  await prepared.locator('textarea').fill(''); await prepared.evaluate(() => { const div = document.createElement('div'); div.id = 'captcha_container'; div.textContent = '合成验证码'; document.body.append(div); });
  await assert.rejects(adoptSharedPreparePage(f.scoped), { code: 'BROWSER_PREPARE_PROTECTED' });
  assert.equal(await prepared.evaluate(() => window.name), 'deepseek-douyin-launcher');
});

test('未知页面不接管，同一用途重复标记时不另建页面掩盖错误', async t => {
  const f = await fixture(t), unrelated = await f.page('用户打开的页面');
  assert.equal(await findSharedPage(f.scoped, 'api'), null);
  assert.equal(await unrelated.evaluate(() => window.name), '用户打开的页面');
  await f.page('deepseek-douyin-api'); await f.page('deepseek-douyin-api');
  await assert.rejects(f.controller('dsh').connect(), /多个专用页/); assert.equal(f.context.pages().length, 3);
});

test('关闭闲置插件连接不会暂停软件的共享观看，超出预算时仍暂停', async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'douyin-shared-close-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  await fs.writeFile(path.join(directory,'watch-loop.lock'),JSON.stringify({pid:process.pid,source:'api'}));
  let allowed=true,pauses=0;
  for(const budget of [true,false]){
    allowed=budget;
    const controller=new BrowserController({source:'dsh',videoLimits:{stateDir:directory,state:()=>({allowed})}});
    controller.pauseForLimits=async()=>{pauses++;};await controller.close();
  }
  assert.equal(pauses,1);
});
