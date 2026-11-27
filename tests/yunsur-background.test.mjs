import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {YunsurAutonomousWatch, YunsurBackgroundController} from '../yunsur-background.mjs';
import { BackgroundVideoSampler } from '../yunsur-video.mjs';
import {VideoLimits} from '../video-limits.mjs';

function fixture(t, { realTime = false } = {}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'yunsur-controller-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let clock=Date.parse('2026-11-17T12:00:00Z');
  const limits=new VideoLimits({stateDir:directory,now:realTime ? Date.now : ()=>clock});limits.savePolicy({enabled:true,windows:['00:00-24:00'],dailyMinutes:30,dailyRequests:400},{explicit:true});
  const connectionFile=path.join(directory,'connection.json');
  fs.writeFileSync(connectionFile,JSON.stringify({endpoint:'http://127.0.0.1:1/mcp',token:'fixture-token-'.repeat(3)}));
  const controller=new YunsurBackgroundController({connectionFile,controlDirectory:path.join(directory,'browser-control')});
  Object.assign(controller,{source:'api',videoLimits:limits,personaMemory:{context:()=>''},initialization:Promise.resolve(),queue:Promise.resolve(),recent:[],sampler:{current:{id:'1234567890123'},state:()=>({video:{id:'1234567890123',paused:true,readyState:2}})}});
  return {controller,limits,directory,advance:ms=>clock+=ms};
}

test('后台手动采样实时计量，模型和音频等待不算播放',async t=>{
  const f=fixture(t),c=f.controller;
  c.sampler.observe=async({onProgress})=>{onProgress({video:{paused:false,readyState:2}});f.advance(1000);onProgress({video:{paused:false,readyState:2}});f.advance(1000);onProgress({video:{paused:true,readyState:2}});f.advance(20000);return{frames:[]};};
  await c.execute('douyin_observe',{seconds:2});
  assert.equal(f.limits.state().daily.usedSeconds,2);assert.equal(f.limits.usage().active,null);assert.equal(fs.existsSync(path.join(f.directory,'watch-manual.lock')),false);
});

test('后台读取当前视频的公开热评，作者回复按精确平台身份和作品核对', async t => {
  const { controller } = fixture(t);
  const id = '1234567890123', uid = '9007199254740993', calls = [];
  controller.client = { call: async (name, args) => {
    calls.push([name, args]);
    if (name === 'get_video_detail') return { aweme_detail: { aweme_id: id, author: { uid } } };
    if (name === 'get_video_comments') return { status_code: 0, comments: [
      { aweme_id: id, cid: '99001', text: '低赞', digg_count: 5 },
      { aweme_id: id, cid: '99002', text: '热评', digg_count: 684, reply_comment_total: 2, reply_comment: [{ aweme_id: id, cid: '99003', reply_id: '99002', text: '同名用户', user: { uid: '9007199254740992' } }] },
      { aweme_id: '7654321098765', cid: '99004', text: '别的作品', digg_count: 999 },
    ] };
    assert.equal(name, 'get_sub_comments');
    return { status_code: 0, comments: [{ aweme_id: id, cid: '99005', reply_id: '99002', text: '作者的回复', user: { uid }, digg_count: 12 }] };
  } };
  const result = await controller.execute('douyin_read_comments', { limit: 1 });
  assert.equal(result.videoId, id);
  assert.deepEqual(result.rows, [{ text: '热评', likeCount: 684, likeCountText: '684', authorReplies: [{ text: '作者的回复', likeCount: 12, likeCountText: '12' }] }]);
  assert.deepEqual(calls.at(-1), ['get_sub_comments', { video: id, comment_id: '99002', cursor: '0', count: '10' }]);
  assert.doesNotMatch(JSON.stringify(result), /9900|900719925474099/);
});

test('采样中预算耗尽会中止，失败仍释放手动锁',async t=>{
  const f=fixture(t),c=f.controller;f.limits.savePolicy({dailyRequests:1},{explicit:true});
  c.sampler.observe=async({onProgress,signal})=>{onProgress({video:{paused:false,readyState:2}});f.limits.reserveRequest({source:'api'});onProgress({video:{paused:false,readyState:2}});signal.throwIfAborted();};
  await assert.rejects(c.execute('douyin_observe'),/用完/);assert.equal(f.limits.usage().active,null);assert.equal(fs.existsSync(path.join(f.directory,'watch-manual.lock')),false);
});

test('另一自主观看占用时不切片，失效运行令牌不能绕过',async t=>{
  const f=fixture(t),c=f.controller;let called=false;c.nextWork=async()=>{called=true;};
  fs.writeFileSync(path.join(f.directory,'watch-loop.lock'),JSON.stringify({version:1,pid:process.pid,runId:'other',sessionId:'session',source:'api',heartbeatAt:Date.now()}));
  await assert.rejects(c.execute('douyin_next'),/停止共享自主观看/);
  await assert.rejects(c.execute('douyin_next',{}, {autonomousRunId:'stale'}),/观看锁已改变/);assert.equal(called,false);
  assert.equal((await c.execute('douyin_status')).state.video.id,'1234567890123');
});

test('持有真实运行令牌可继续采样，结算只清自己的用量租约',async t=>{
  const f=fixture(t),c=f.controller;
  fs.writeFileSync(path.join(f.directory,'watch-loop.lock'),JSON.stringify({version:1,pid:process.pid,runId:'active',sessionId:'session',source:'api',heartbeatAt:Date.now()}));
  c.sampler.observe=async({onProgress})=>{onProgress({video:{paused:false,readyState:2}});assert.equal(f.limits.usage().active.ownerId,'active');f.advance(1000);return{frames:[]};};
  await c.execute('douyin_observe',{}, {autonomousRunId:'active'});assert.equal(f.limits.state().daily.usedSeconds,1);assert.equal(f.limits.usage().active,null);
});

test('分享详情不匹配时不采样，释放同一套全局手动锁',async t=>{
  const f=fixture(t),c=f.controller;c.client={call:async()=>{assert.equal(fs.existsSync(path.join(f.directory,'watch-manual.lock')),true);return{aweme_detail:{aweme_id:'9999999999999'}};}};
  await assert.rejects(c.observeSharedWork({videoId:'1234567890123',url:'https://www.douyin.com/video/1234567890123'}),/详情.*不匹配/);
  assert.equal(fs.existsSync(path.join(f.directory,'watch-manual.lock')),false);
});

test('无窗口观看遇到未许可的收藏时换片，下一条继续采样和请求模型', async t => {
  const f = fixture(t), { controller } = f;
  let id = '7579432563794584933', progress = 0, decisions = 0;
  const switches = [], events = [];
  const state = () => ({ pageKind: 'video', url: `https://www.douyin.com/video/${id}`,
    video: { id, title: '合成视频', time: progress, duration: 60, readyState: 4, paused: false } });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPEkAAAAASUVORK5CYII=';
  controller.execute = async (tool, _args, controls) => {
    if (tool === 'douyin_next') {
      assert.equal(controls.expectedVideoId, id);
      switches.push(id);
      id = String(BigInt(id) + 1n);
      progress = 0;
      return { changed: true, state: state() };
    }
    if (tool === 'douyin_observe') {
      const beforeTime = progress;
      progress += 3; f.advance(3000);
      const sample = state();
      return { state: sample, intervalState: sample, frames: [{ mimeType: 'image/png', data: png, videoId: id, time: progress }],
        observation: { videoId: id, beforeTime, playbackProgressSeconds: 3 } };
    }
    assert.equal(tool, 'douyin_open');
    return { state: state() };
  };
  controller.pauseForLimits = async () => {};
  controller.getReactions = async () => ({ context: () => ({ like: false, favorite: false }), react: () => assert.fail('未许可不得收藏') });
  controller.personaMemory.recordObservation = () => ({ evidenceId: 'synthetic-evidence' });
  const watch = new YunsurAutonomousWatch({
    controller, videoLimits: f.limits, personaMemory: controller.personaMemory, stateDir: f.directory, now: f.limits.now,
    config: { model: 'synthetic', apiKey: 'synthetic-key' }, onEvent: event => events.push(event),
    decisionProvider: async () => ({ text: JSON.stringify({ action: ++decisions === 1 ? 'favorite' : 'stop', reason: '合成画面', topics: [], reflection: '' }) }),
  });
  t.after(() => watch.close());
  watch.start({}, { explicit: true });
  await watch.completion;
  assert.equal(watch.state().status, 'completed', watch.state().lastError);
  assert.equal(decisions, 2);
  assert.equal(switches.length, 1);
  assert.equal(events.filter(event => event.type === 'watch.reaction-skipped').length, 1);
});

test('后台按主题选中图文，模型逐页收到实际解码画面', async t => {
  if (['ffmpeg', 'ffprobe'].some(command => spawnSync(command, ['-version'], { windowsHide: true }).status !== 0)) return t.skip('未安装 FFmpeg。');
  const f = fixture(t, { realTime: true });
  const controller = f.controller;
  const { encode } = createRequire(import.meta.url)('../storyboard/vendor/jpeg-js');
  const id = '7579432563794584933';
  const excluded = '7579432563794584934';
  const links = ['https://example.invalid/page1', 'https://example.invalid/page2'];
  const downloads = [], observed = [], calls = [];
  controller.sampler = new BackgroundVideoSampler({ cacheDir: path.join(f.directory, 'cache'), downloadMedia: async (url, file) => {
    downloads.push(url);
    assert.ok(links.includes(url));
    fs.writeFileSync(file, encode({ width: 160, height: 160, data: Buffer.alloc(160 * 160 * 4, url === links[0] ? 45 : 180) }).data);
  } });
  const album = { aweme_id: id, desc: '合成主题图文', aweme_type: 68, images: links.map(url => ({ url_list: [url] })) };
  controller.client = { call: async (method, args) => {
    calls.push(method);
    if (method === 'search_videos') {
      assert.deepEqual(args, { keyword: '红蓝配色', channel: 'general', offset: '0' });
      return { status_code: 0, data: [{ aweme_info: { aweme_id: excluded, desc: '合成广告' } }, { aweme_info: album }] };
    }
    assert.equal(method, 'get_video_detail');
    assert.equal(args.video, id);
    return { aweme_detail: album };
  } };
  const watch = new YunsurAutonomousWatch({
    controller, videoLimits: f.limits, personaMemory: controller.personaMemory, stateDir: f.directory,
    decisionProvider: async ({ messages }) => {
      const content = messages[1].content;
      const page = Number(/"album":\{"page":(\d+),"total":2/.exec(content[0].text)?.[1]);
      observed.push({ page, picture: content.find(part => part.type === 'image_url')?.image_url.url });
      assert.match(content[0].text, /"source":"local-media-image"/);
      return { text: JSON.stringify({ action: page === 1 ? 'next_image' : 'stop', reason: '核对合成图文画面', topics: [], reflection: '' }) };
    },
  });
  t.after(async () => { await watch.close(); await controller.close(); });
  watch.optionsService.configure({ mode: 'topic', topics: ['红蓝配色'], exclude: ['广告'] }, { explicit: true });
  watch.start({}, { explicit: true });
  await watch.completion;
  assert.equal(watch.state().status, 'completed', watch.state().lastError);
  assert.deepEqual(observed.map(row => row.page), [1, 2]);
  for (const row of observed) assert.match(row.picture, /^data:image\/jpeg;base64,/);
  assert.notEqual(observed[0].picture, observed[1].picture);
  assert.deepEqual(downloads, links);
  assert.deepEqual(calls, ['search_videos', 'get_video_detail']);
  assert.ok(f.limits.state().daily.usedSeconds >= 1.8);
  assert.equal(f.limits.state().daily.requests, 2);
  assert.equal(fs.readdirSync(controller.sampler.cacheDir).length, 1);
});
