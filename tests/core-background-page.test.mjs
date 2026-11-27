import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';import net from 'node:net';
import {BrowserController,createBackgroundPage} from '../core.mjs';import {connectDedicatedBrowser} from '../browser-launcher.mjs';import {ChatBrowser} from '../chat-browser.mjs';
import {launchWindowsVisibleEdge,runBrowserHost} from '../browser-host.mjs';
import {ownedBrowserExecutionMode} from '../browser-mode.mjs';
function synthetic({hidden=false,altered=false,createError=false,abortInGoto}={}){const events=[],created=[],make=(id,url)=>({id,address:url,closed:false,isClosed(){return this.closed;},url(){return this.address;},async goto(url){events.push(['goto',id,url]);this.address=url;abortInGoto?.();}}),old=make('old','https://www.douyin.com/recommend'),other=make('other','about:blank'),pages=[old];let detach=0;
 const root={async send(method,params){events.push([method,params]);if(method==='Target.createTarget'){if(createError)throw new Error('合成不支持background');const own=make('owned',altered?'https://example.invalid/':params.url);created.push(own);if(!hidden)pages.push(other,own);return{targetId:'owned'};}if(method==='Target.getTargets')return{targetInfos:created.map(page=>({type:'page',targetId:page.id,url:page.address}))};if(method==='Target.closeTarget'){const page=created.find(page=>page.id===params.targetId);assert.ok(page);page.closed=true;return{success:true};}throw new Error('意外CDP方法');},async detach(){detach++;}};
 const context={pages:()=>pages,async newCDPSession(page){return{async send(method){assert.equal(method,'Target.getTargetInfo');return{targetInfo:{targetId:page.id,browserContextId:'synthetic-context'}};},async detach(){events.push(['detach-page',page.id]);}};},newPage(){assert.fail('自动路径不得回退newPage');}},browser={async newBrowserCDPSession(){return root;}};return{events,created,context,browser,other,detach:()=>detach};}
test('后台CDP建页按targetId匹配，传background和原上下文，绝不按同名页匹配',async()=>{const f=synthetic();let auth=0;const page=await createBackgroundPage(f.browser,f.context,{authorizePrepare:async()=>{auth++;}});assert.equal(page.id,'owned');assert.equal(page.url(),'about:blank');assert.equal(auth,4);const params=f.events.find(row=>row[0]==='Target.createTarget')[1];assert.equal(params.background,true);assert.equal(params.browserContextId,'synthetic-context');assert.match(params.url,/^about:blank#dafeiyu-background-/);assert.deepEqual(f.events.filter(row=>row[0]==='goto').map(row=>row[1]),['owned']);assert.equal(f.other.closed,false);assert.equal(f.detach(),1);});
test('预取消不建立CDP，也不检查授权',async()=>{const f=synthetic(),signal=AbortSignal.abort(new Error('合成取消'));await assert.rejects(createBackgroundPage(f.browser,f.context,{signal,authorizePrepare:()=>assert.fail()}),/合成取消/);assert.deepEqual(f.events,[]);});
for(const code of ['CHAT_FOREGROUND','CHAT_DRAFT_PRESENT','CHAT_LOGIN_REQUIRED','CHAT_PERMISSION_REVOKED'])test(`原${code}保护拒绝时零建页`,async()=>{const f=synthetic();await assert.rejects(createBackgroundPage(f.browser,f.context,{authorizePrepare:async()=>{throw Object.assign(new Error('合成保护拒绝'),{code});}}),error=>error.code===code);assert.deepEqual(f.events,[]);});
test('创建前最后授权撤回时，零Target.createTarget并释放CDP',async()=>{const f=synthetic();let n=0;await assert.rejects(createBackgroundPage(f.browser,f.context,{authorizePrepare:async()=>{if(++n===2)throw new Error('合成撤权');}}),/合成撤权/);assert.equal(f.events.some(row=>row[0]==='Target.createTarget'),false);assert.equal(f.detach(),1);});
test('创建后撤回只关闭自己精确target，不改其他新页',async()=>{const f=synthetic();let n=0;await assert.rejects(createBackgroundPage(f.browser,f.context,{authorizePrepare:async()=>{if(++n===3)throw new Error('合成撤权');}}),/合成撤权/);assert.equal(f.created[0].closed,true);assert.equal(f.other.closed,false);assert.equal(f.events.some(row=>row[0]==='goto'),false);assert.equal(f.detach(),1);});
test('映射后授权等待期间用户改导航时不得覆盖，新页保留且零goto',async()=>{const f=synthetic();let n=0;await assert.rejects(createBackgroundPage(f.browser,f.context,{authorizePrepare:async()=>{if(++n===3)f.created[0].address='https://example.invalid/user-navigation';}}),/授权等候期间/);assert.equal(f.created[0].closed,false);assert.equal(f.events.some(row=>row[0]==='goto'),false);assert.equal(f.other.closed,false);assert.equal(f.detach(),1);});
test('映射等候有界，超时关闭自己的标记target并释放session',async()=>{const f=synthetic({hidden:true}),start=Date.now();await assert.rejects(createBackgroundPage(f.browser,f.context,{authorizePrepare:async()=>{},timeoutMs:50}),error=>error.code==='CHAT_BACKGROUND_PAGE_TIMEOUT');assert.ok(Date.now()-start<500);assert.equal(f.created[0].closed,true);assert.equal(f.detach(),1);});
test('自己target已离开标记页时停止，不导航或关闭该页',async()=>{const f=synthetic({altered:true});await assert.rejects(createBackgroundPage(f.browser,f.context,{authorizePrepare:async()=>{}}),/已被改动/);assert.equal(f.created[0].closed,false);assert.equal(f.events.some(row=>row[0]==='goto'),false);assert.equal(f.detach(),1);});
test('CDP不支持后台建页时明确失败，不回退会激活窗口的newPage',async()=>{const f=synthetic({createError:true});await assert.rejects(createBackgroundPage(f.browser,f.context,{authorizePrepare:async()=>{}}),/合成不支持background/);assert.equal(f.created.length,0);assert.equal(f.detach(),1);});
test('规范为空白页过程中取消，也只清理已核对的自己target',async()=>{const abort=new AbortController(),f=synthetic({abortInGoto:()=>abort.abort(new Error('合成导航取消'))});await assert.rejects(createBackgroundPage(f.browser,f.context,{signal:abort.signal,authorizePrepare:async()=>{}}),/合成导航取消/);assert.equal(f.created[0].closed,true);assert.equal(f.other.closed,false);assert.equal(f.detach(),1);});

test('隔离原生有窗口 Edge 可准备并读取后台消息入口，保留原标签、焦点和草稿', { timeout: 35_000, skip: process.platform !== 'win32' }, async t => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-background-core-'));
  const controlDirectory = path.join(profile, 'synthetic-control');
  await fs.mkdir(controlDirectory);
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  let host, browser, session;
  t.after(async () => {
    await session?.detach().catch(() => {});
    await browser?.close().catch(() => {});
    await host?.close();
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert.match(path.basename(profile), /^douyin-background-core-/);
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  const launch = await runBrowserHost({
    profile, port, controlDir: controlDirectory, mode: 'visible',
    logger: { log() {}, error: error => assert.fail(error) },
    processImpl: { pid: process.pid, on() {}, exit() {} },
    launchVisible: async options => {
      host = await launchWindowsVisibleEdge({
        ...options,
        spawnEdge: (executable, args, spawnOptions) => spawn(executable, [
          '--start-minimized', '--disable-background-networking', '--disable-component-update',
          '--disable-sync', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND', ...args,
        ], spawnOptions),
      });
      return host;
    },
  });
  assert.equal(launch.started, true);
  browser = await connectDedicatedBrowser(`http://127.0.0.1:${port}`);
  const ownerFile = path.join(controlDirectory, 'browser.json');
  const owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
  assert.equal(await ownedBrowserExecutionMode(browser, owner), 'visible');
  assert.equal(await ownedBrowserExecutionMode(browser, { ...owner, pid: process.pid + 1 }), 'unknown');
  session = await browser.newBrowserCDPSession();
  const context = browser.contexts()[0];
  const avatar = '<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E">';
  const html = `<!doctype html><meta charset="utf-8"><button data-e2e="im-entry">消息</button><input value="合成草稿保留">
    <div data-e2e="im-dialog" hidden><div data-e2e="conversation-item" data-conversation-id="synthetic-contact" data-conversation-type="direct">
      ${avatar}<div data-e2e="conversation-name">合成好友</div><a href="/user/synthetic-user">主页</a>
    </div><div data-e2e="chat-page" hidden>
      <div data-e2e="chat-header" data-conversation-id="synthetic-contact" data-conversation-type="direct">
        ${avatar}<div class="StackLayoutStackChatHeadertitle">合成好友</div>
      </div>
      <div class="messageMessageListlist" id="message-list" style="display:flex;flex-direction:column">
        <div data-index="0"><div class="messageMessageBoxmessageBox" data-message-id="synthetic-message">
          <div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">合成消息内容</div></div>
        </div></div>
      </div>
      <div data-e2e="msg-input"><div contenteditable="true"></div></div>
    </div></div>
    <script>
      document.querySelector('button').onclick = () => document.querySelector('[data-e2e="im-dialog"]').hidden = false;
      document.querySelector('[data-e2e="conversation-item"]').onclick = () => document.querySelector('[data-e2e="chat-page"]').hidden = false;
    </script>`;
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  const original = context.pages()[0];
  await original.goto('https://www.douyin.com/recommend');
  await original.evaluate(() => { window.name = 'deepseek-douyin-launcher'; });
  const pageSession = await context.newCDPSession(original);
  const { targetInfo } = await pageSession.send('Target.getTargetInfo');
  await pageSession.detach();
  const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
  await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  const controller = new BrowserController({ source: 'api-chat', controlDirectory });
  controller.browser = browser;
  const chat = new ChatBrowser({ controller });
  const prepared = await chat.prepareChat({ automatic: true, authorizePrepare: async () => true, allowForegroundBrowsing: true });
  assert.deepEqual(prepared, { prepared: true, count: 1 });
  const page = controller.page;
  assert.equal(await page.evaluate(() => window.name), 'deepseek-douyin-api-chat');
  assert.equal(await page.evaluate(() => document.hasFocus()), false);
  const { contacts } = await chat.listContacts({ backgroundOnly: true });
  assert.equal(contacts.length, 1);
  const snapshot = await chat.readConversation(contacts[0].id, { allowed: true, backgroundOnly: true });
  assert.equal(snapshot.messages[0].text, '合成消息内容');
  assert.equal(await original.locator('input').inputValue(), '合成草稿保留');
  assert.equal(context.pages().length, 2);
  assert.equal((await session.send('Browser.getWindowBounds', { windowId })).bounds.windowState, 'minimized');
});
