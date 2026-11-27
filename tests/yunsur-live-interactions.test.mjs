import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PersonaMemory } from '../persona-memory.mjs';
import { VideoLimits } from '../video-limits.mjs';
import { YunsurBackgroundController } from '../yunsur-background.mjs';
import { BackgroundVideoSampler } from '../yunsur-video.mjs';
import { stageHlsSample } from '../yunsur-hls.mjs';
import { liveRoomCandidate, resolveLiveRoom } from '../yunsur-live.mjs';

test('同一直播间保留可信主备流，规范化 FLV 和 HLS 的安全地址', () => {
  const webRid = '12345678', roomId = '7123456789012345678';
  const entry = liveRoomCandidate({ room: { web_rid: webRid } });
  const stream_data = JSON.stringify({data:{sd:{
    main:{flv:'http://pull.douyincdn.com/live.flv'},
    backup:{hls:'http://pull.douyincdn.com/backup.m3u8'},
  },hd:{main:{hls:'https://foreign.invalid/live.m3u8'}}}});
  const entered = {status_code:0,data:{data:[{id_str:roomId,web_rid:webRid,status:2,
    stream_url:{live_core_sdk_data:{pull_data:{stream_data}}}}]}};
  const room = resolveLiveRoom(entry,{room_id:roomId,room_status:2},entered);
  assert.deepEqual(room.streamUrls,['https://pull.douyincdn.com/live.flv']);
  assert.deepEqual(room.hlsUrls,['https://pull.douyincdn.com/backup.m3u8']);
});
import { openDouyinLiveStream } from '../media/index.mjs';
import { grantPrivateVideoAccess } from '../chat-message.mjs';

const workIds = ['7579432563794584933', '7579432563794584934', '7579432563794584935'];
const account = '9007199254740993';
const roomId = '7687099550015753000';
const webRid = '403309276429';
const streamUrl = 'https://pull.example.douyincdn.com/synthetic.flv';
const commentText = '蓝色纸舟碰到桥墩以后才顺着水流掉头。';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGDkAAAAASUVORK5CYII=';
const decide = (action, extras) => ({ text: JSON.stringify({ action, reason: '核对本地样本', reflection: '', topics: [], ...extras }) });
const names = ['get_live_info', 'live_room_enter', 'digg_video', 'collect_video', 'post_video_comment'];
const video = id => ({ aweme_id: id, desc: '合成画面', user_digged: 0, collect_stat: 0 });

async function fixture(t, { tools = names, source = 'api', feed = workIds.map(video), override } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-background-actions-'));
  const works = new Map(workIds.map(id => [id, video(id)]));
  const comments = new Map(), calls = [], errors = [], events = [];
  const handler = (name, args) => {
    switch (name) {
      case 'get_homefeed': return { status_code: 0, aweme_list: feed };
      case 'check_login_status': return { logged_in: true, uid: JSON.rawJSON(account) };
      case 'get_live_info': return { room_id: JSON.rawJSON(roomId), room_status: '2' };
      case 'live_room_enter': return { status_code: 0, data: { data: [
        { id_str: roomId, web_rid: webRid, status: 2, title: '合成直播', stream_url: { flv_pull_url: { SD: streamUrl } } },
      ] } };
      case 'get_video_detail': return { aweme_detail: works.get(args.video) };
      case 'get_video_comments': return { status_code: 0, comments: comments.get(args.video) || [] };
      case 'digg_video':
        assert.equal(args.digg_type, '1');
        works.get(args.aweme_id).user_digged = 1;
        return { success: true };
      case 'collect_video':
        assert.equal(args.action, '1');
        works.get(args.aweme_id).collect_stat = 1;
        return { status_code: 0 };
      case 'post_video_comment': {
        assert.deepEqual(Object.keys(args).sort(), ['aweme_id', 'content']);
        const comment = { cid: JSON.rawJSON('9007199254740995'), aweme_id: args.aweme_id, text: args.content, user: { uid: JSON.rawJSON(account) } };
        comments.set(args.aweme_id, [...(comments.get(args.aweme_id) || []), comment]);
        return { status_code: 0, comment };
      }
      default: throw Error('收到未知本机工具调用。');
    }
  };
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/mcp');
      let body = '';
      for await (const chunk of req) body += chunk;
      const { id, method, params } = JSON.parse(body);
      let result;
      if (method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'local-fixture' } };
      else if (method === 'tools/list') result = { tools: tools.map(name => ({ name })) };
      else {
        assert.equal(method, 'tools/call');
        const { name, arguments: args } = params;
        calls.push({ name, args });
        const data = override?.(name, args, { works, comments }) ?? handler(name, args);
        result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    } catch (error) { errors.push(error); res.writeHead(500).end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const stateDir = path.join(directory, 'state');
  const limits = new VideoLimits({ stateDir });
  limits.savePolicy({ enabled: true, windows: ['00:00-24:00'], dailyMinutes: 10, dailyRequests: 60 }, { explicit: true });
  const personaMemory = new PersonaMemory({ memoryDir: path.join(directory, 'memory') });
  personaMemory.initialize({ importLegacy: false });
  const connectionFile = path.join(directory, 'connection.json');
  fs.writeFileSync(connectionFile, JSON.stringify({ endpoint: `http://127.0.0.1:${server.address().port}/mcp`, token: 'x'.repeat(32) }));
  const controller = new YunsurBackgroundController({ connectionFile, source, personaMemory, videoLimits: limits,
    controlDirectory: path.join(directory, 'browser-control') });
  const sampler = controller.sampler, observe = sampler.observe.bind(sampler);
  sampler.open = async work => {
    await sampler.close();
    fs.mkdirSync(sampler.cacheDir, { recursive: true });
    sampler.current = { id: work.aweme_id, title: work.desc, time: 0, duration: 180,
      directory: fs.mkdtempSync(path.join(sampler.cacheDir, 'work-')) };
  };
  sampler.observe = async options => {
    if (sampler.current.kind === 'live-room') return observe(options);
    const beforeTime = sampler.current.time;
    sampler.current.time += 3;
    const state = sampler.state();
    return { state, intervalState: { ...state, video: { ...state.video, paused: false } },
      frames: [{ videoId: state.video.id, time: beforeTime, mimeType: 'image/png', data: png }],
      observation: { videoId: state.video.id, beforeTime, playbackProgressSeconds: 3 } };
  };
  let watch;
  t.after(async () => {
    await watch?.close();
    await controller.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const createWatch = decisionProvider => {
    watch = controller.createWatchService({ controller, personaMemory, videoLimits: limits, source, stateDir,
      decisionProvider, onEvent: event => events.push(event) });
    return watch;
  };
  return { calls, controller, stateDir, createWatch, comments, works, directory, events, limits };
}

test('后台自主观看经本机 MCP 点赞、收藏和发评论，近期同文跨作品跳过', async t => {
  const f = await fixture(t, { source: 'dsh' });
  const actions = ['like', 'favorite', 'comment', 'skip', 'comment', 'stop'];
  const watch = f.createWatch(({ system, messages }) => {
    if (messages[1].content[0].text.startsWith('本次作品采样')) {
      assert.match(system, /评论/);
      return { text: JSON.stringify({ text: commentText }) };
    }
    return decide(actions.shift());
  });
  (await watch.getReactionService()).configure({ like: true, favorite: true }, { explicit: true });
  watch.getCommentService().configure({ enabled: true, dailyLimit: 3, perSessionLimit: 2 }, { explicit: true });
  watch.start({}, { explicit: true });
  assert.equal((await watch.completion).status, 'completed', watch.state().lastError);
  assert.deepEqual(actions, []);
  const dispatches = f.calls.filter(call => names.slice(2).includes(call.name));
  assert.deepEqual(dispatches.map(call => call.name), ['digg_video', 'collect_video', 'post_video_comment']);
  assert.ok(dispatches.every(call => call.args.aweme_id === workIds[0]));
  assert.deepEqual((await watch.getReactionService()).state().recent.map(item => item.status), ['confirmed', 'confirmed']);
  assert.equal(watch.getCommentService().state().daily.attempts, 1);
  assert.ok(f.events.some(event => event.type === 'watch.comment' && event.delivery.confirmed));
  assert.ok(f.events.some(event => event.type === 'watch.comment' && event.delivery.code === 'COMMENT_REPEATED'));
});

test('后台评论认可回读后的新本人记录，只有提交回执时暂停评论并继续观看', async t => {
  const f = await fixture(t, { override: (name, args) => name === 'post_video_comment' ?
    { status_code: 0, comment: { cid: '9007199254740995', aweme_id: args.aweme_id } } : undefined });
  let decisions = 0;
  const watch = f.createWatch(({ messages }) => {
    const text = messages[1].content[0].text;
    if (text.startsWith('本次作品采样')) return { text: JSON.stringify({ text: commentText }) };
    if (++decisions === 1) return decide('comment');
    assert.match(text, /"enabled":false,"paused":true/);
    return decide('stop');
  });
  watch.getCommentService().configure({ enabled: true, dailyLimit: 3, perSessionLimit: 2 }, { explicit: true });
  watch.start({}, { explicit: true });
  assert.equal((await watch.completion).status, 'completed', watch.state().lastError);
  assert.equal(f.calls.filter(call => call.name === 'post_video_comment').length, 1);
  assert.equal(watch.getCommentService().state().paused, true);
  assert.ok(f.events.some(event => event.type === 'watch.comment-paused'));
});

test('后台评论跳过公开讨论已表达的内容，点赞遇未知状态或收藏已完成均不提交', async t => {
  const f = await fixture(t);
  delete f.works.get(workIds[0]).user_digged;
  f.works.get(workIds[0]).collect_stat = 1;
  f.comments.set(workIds[0], [{ cid: '9007199254740997', aweme_id: workIds[0], text: commentText, digg_count: 20 }]);
  const actions = ['like', 'favorite', 'comment', 'stop'];
  const watch = f.createWatch(({ messages }) => {
    const text = messages[1].content[0].text;
    if (text.startsWith('本次作品采样')) {
      assert.ok(messages[1].content.some(part => part.text?.includes(commentText)));
      return { text: JSON.stringify({ text: commentText }) };
    }
    return decide(actions.shift());
  });
  (await watch.getReactionService()).configure({ like: true, favorite: true }, { explicit: true });
  watch.getCommentService().configure({ enabled: true }, { explicit: true });
  watch.start({}, { explicit: true });
  assert.equal((await watch.completion).status, 'completed', watch.state().lastError);
  assert.equal(f.calls.filter(call => names.slice(2).includes(call.name)).length, 0);
  assert.deepEqual((await watch.getReactionService()).state().recent.map(item => item.status), ['not-sent', 'already-active']);
  assert.equal(watch.getCommentService().state().daily.attempts, 0);
});

test('直播推荐绑定实际房间，拒绝无身份或外站媒体', async () => {
  assert.equal(liveRoomCandidate({ desc: '直播中', author: { web_rid: webRid } }), null);
  const entry = liveRoomCandidate({ room: { web_rid: webRid } });
  assert.equal(entry.webRid, webRid);
  const info = { room_id: roomId, room_status: 2 };
  const response = { status_code: 0, data: { data: [{ id_str: roomId, web_rid: webRid, status: 2,
    stream_url: { flv_pull_url: { SD: streamUrl } } }] } };
  assert.equal(resolveLiveRoom(entry, info, response).id, roomId);
  assert.throws(() => resolveLiveRoom(entry, { ...info, room_id: '7687099550015753001' }, response), { code: 'BACKGROUND_LIVE_UNAVAILABLE' });
  response.data.data[0].stream_url.flv_pull_url.SD = 'https://example.invalid/source.flv';
  assert.throws(() => resolveLiveRoom(entry, info, response), { code: 'BACKGROUND_LIVE_UNAVAILABLE' });
  await assert.rejects(openDouyinLiveStream('https://127.0.0.1/source.flv'), /公开 HTTPS/);
});

test('后台自主进房，用 FFmpeg 解码两段直播并按选择退出到下一条', async t => {
  if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0) return t.skip('未安装 FFmpeg。');
  const f = await fixture(t, { feed: [{ room: { web_rid: webRid, title: '合成直播' } }, video(workIds[0])] });
  const flv = path.join(f.directory, 'synthetic.flv');
  const source = fileURLToPath(new URL('./fixtures/headless-progress.mp4', import.meta.url));
  const converted = spawnSync('ffmpeg', ['-nostdin','-v','error','-stream_loop','-1','-i',source,'-t','6','-an','-c:v','flv',flv], { windowsHide: true });
  assert.equal(converted.status, 0, converted.stderr?.toString());
  f.controller.sampler.openLiveStream = async url => {
    assert.equal(url, streamUrl);
    return fs.createReadStream(flv);
  };
  const seen = [];
  const watch = f.createWatch(({ messages }) => {
    const content = messages[1].content;
    if (!content[0].text.includes('"pageKind":"live-room"')) return decide('stop');
    assert.ok(content.some(item => item.type === 'image_url'));
    seen.push(content[0].text);
    assert.match(content[0].text, /"source":"local-media-live"/);
    return seen.length === 1 ? decide('stay', { seconds: 2 }) : decide('skip');
  });
  watch.start({}, { explicit: true });
  assert.equal((await watch.completion).status, 'completed', watch.state().lastError);
  assert.equal(seen.length, 2);
  assert.deepEqual(f.calls.filter(item => item.name === 'live_room_enter').map(item => item.args.web_rid), [webRid]);
  const samples = f.events.filter(event => event.type === 'watch.tool' && event.result?.state?.pageKind === 'live-room' && event.result.frames);
  assert.equal(samples.length, 2);
  assert.ok(samples.every(event => event.result.frames.length >= 2 && event.result.observation.playbackProgressSeconds > 0));
  assert.equal(samples[1].result.observation.beforeTime, samples[0].result.observation.afterTime);
  assert.ok(f.limits.state().daily.usedSeconds > 0);
  assert.equal(f.controller.currentVideoId(), workIds[0]);
  assert.ok(fs.readdirSync(f.controller.cacheRoot).every(name => !name.startsWith('live-')));
});

const hlsHost = 'https://pull.example.douyincdn.com';
const hlsUrl = hlsHost + '/live/master.m3u8?signature=local-fixture';

test('直播清晰度表缺少可信地址时继续核对同房间的另一张表', () => {
  const entry = liveRoomCandidate({ room: { web_rid: webRid } });
  const resolved = resolveLiveRoom(entry, { room_id: roomId, room_status: 2 }, { status_code: 0, data: { data: [{
    id_str: roomId, web_rid: webRid, status: 2, stream_url: {
      hls_pull_url_map: { SD: 'https://example.invalid/foreign.m3u8' },
      hls_pull_url: JSON.stringify({ LD: hlsUrl }),
    },
  }] } });
  assert.deepEqual(resolved.hlsUrls, [hlsUrl]);
});

function makeHls(directory, fragmented = false, singleFile = false) {
  const extension = fragmented ? 'm4s' : 'ts';
  const converted = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10',
    '-t', '5', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', '-g', '10', '-sc_threshold', '0',
    '-hls_time', '1', '-hls_list_size', '0', '-hls_segment_type', fragmented ? 'fmp4' : 'mpegts',
    ...(singleFile ? ['-hls_flags', 'single_file'] : []),
    '-hls_segment_filename', singleFile ? 'capture.mp4' : `capture-%d.${extension}`, 'generated.m3u8'], { cwd: directory, windowsHide: true });
  assert.equal(converted.status, 0, converted.stderr?.toString());
}

test('后台 FLV 不可用时回退到 HLS，滚动两段正片并按自主选择退出', async t => {
  if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0) return t.skip('未安装 FFmpeg。');
  const f = await fixture(t, {
    feed: [{ room: { web_rid: webRid, title: '合成直播' } }, video(workIds[0])],
    override: name => name === 'live_room_enter' ? { status_code: 0, data: { data: [{
      id_str: roomId, web_rid: webRid, status: 2, stream_url: { flv_pull_url: { SD: streamUrl },
        hls_pull_url_map: { SD: hlsUrl.replace('https:', 'http:') } },
    }] } } : undefined,
  });
  makeHls(f.directory);
  let reads = 0, flvAttempts = 0, decisions = 0;
  const opened = [];
  f.controller.sampler.openLiveStream = async () => { flvAttempts++; throw Error('模拟 FLV 暂不可用'); };
  f.controller.sampler.openLiveResource = async url => {
    const address = new URL(url);
    assert.equal(address.origin, hlsHost);
    const segment = path.posix.basename(address.pathname);
    opened.push(segment);
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=50000,CODECS="mp4a.40.2"\naudio.m3u8\n'
      + '#EXT-X-STREAM-INF:BANDWIDTH=100000\nhttps://example.invalid/foreign.m3u8\n'
      + '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x120\nstream.m3u8\n';
    let data;
    if (segment === 'master.m3u8') data = master;
    else if (segment === 'stream.m3u8') {
      const first = decisions ? 2 : 0, count = reads++ ? 3 : 2;
      data = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${100 + first}\n`;
      data += Array.from({ length: count }, (_, index) => `#EXTINF:1.0,\n${hlsHost.replace('https:', 'http:')}/live/capture-${first + index}.ts?token=fixture\n`).join('');
    } else {
      assert.match(segment, /^capture-[0-4]\.ts$/);
      data = fs.readFileSync(path.join(f.directory, segment));
    }
    return { url, response: new Response(data) };
  };
  const watch = f.createWatch(({ messages }) => {
    const parts = messages[1].content;
    if (!parts[0].text.includes('"pageKind":"live-room"')) return decide('stop');
    assert.ok(parts.some(part => part.type === 'image_url'));
    return ++decisions === 1 ? decide('stay', { seconds: 2 }) : decide('skip');
  });
  watch.start({}, { explicit: true });
  assert.equal((await watch.completion).status, 'completed', watch.state().lastError);
  assert.equal(decisions, 2);
  assert.equal(flvAttempts, 1);
  assert.deepEqual(opened.filter(name => name.endsWith('.ts')), ['capture-0.ts', 'capture-1.ts', 'capture-2.ts', 'capture-3.ts', 'capture-4.ts']);
  const samples = f.events.filter(event => event.type === 'watch.tool' && event.result?.observation?.transport === 'hls');
  assert.equal(samples.length, 2);
  assert.ok(samples.every(event => event.result.frames.length >= 2 && event.result.observation.playbackProgressSeconds > 0));
  assert.equal(samples[1].result.observation.beforeTime, samples[0].result.observation.afterTime);
  assert.ok(f.limits.state().daily.usedSeconds > 0);
  assert.equal(f.controller.currentVideoId(), workIds[0]);
  assert.ok(fs.readdirSync(f.controller.cacheRoot).every(name => !name.startsWith('live-')));
});

test('只有 fMP4 HLS 的已核对直播间也能采样，初始化文件随采样清理', async t => {
  if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0) return t.skip('未安装 FFmpeg。');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-hls-fmp4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  makeHls(dir, true);
  const cacheDir = path.join(dir, 'cache'), opened = [], source = hlsHost + '/generated.m3u8';
  const sampler = new BackgroundVideoSampler({ cacheDir, openLiveResource: async url => {
    const file = path.posix.basename(new URL(url).pathname);
    assert.match(file, /^(?:generated\.m3u8|init\.mp4|capture-\d+\.m4s)$/);
    opened.push(file);
    return { url, response: new Response(fs.readFileSync(path.join(dir, file))) };
  } });
  const entry = liveRoomCandidate({ room: { web_rid: webRid } });
  const resolved = resolveLiveRoom(entry, { room_id: roomId, room_status: 2 }, { status_code: 0, data: { data: [{
    id_str: roomId, web_rid: webRid, status: 2, stream_url: { live_core_sdk_data: { pull_data: { stream_data:
      JSON.stringify({ data: { sd: { main: { hls: source } } } }) } } },
  }] } });
  assert.deepEqual(resolved.streamUrls, []);
  await sampler.openLive(resolved);
  const result = await sampler.observe({ seconds: 2 });
  assert.equal(result.observation.transport, 'hls');
  assert.match(result.frames[0].videoId, /^live:/);
  assert.ok(result.frames.length >= 2 && result.observation.playbackProgressSeconds > 0);
  assert.deepEqual(opened, ['generated.m3u8', 'init.mp4', 'capture-3.m4s', 'capture-4.m4s']);
  await sampler.close();
  assert.deepEqual(fs.readdirSync(cacheDir), []);
});

test('HLS 分片越域或清单要求未知加密时停止，外链和密钥地址都不请求', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-hls-invalid-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const lines of [
    '#EXTINF:2.0,\nhttps://example.invalid/private.ts\n',
    '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="unread.key"\n#EXTINF:2.0,\nlocal.ts\n',
    '#EXTINF:2.0,\n#EXT-X-BYTERANGE:40@0\nfirst.ts\n#EXTINF:2.0,\n#EXT-X-BYTERANGE:40\nsecond.ts\n',
  ]) {
    const opened = [];
    await assert.rejects(stageHlsSample(hlsUrl, { directory: dir, seconds: 2, openResource: async url => {
      opened.push(url);
      return { url, response: new Response('#EXTM3U\n#EXT-X-TARGETDURATION:2\n' + lines) };
    } }), { code: 'BACKGROUND_LIVE_UNAVAILABLE' });
    assert.deepEqual(opened, [hlsUrl]);
    assert.deepEqual(fs.readdirSync(dir), []);
  }
});

test('单文件 HLS 可按字节范围解码初始化片和正片，服务器忽略范围时拒绝读取', async t => {
  if (spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status !== 0) return t.skip('未安装 FFmpeg。');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-hls-ranges-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  makeHls(dir, true, true);
  const media = fs.readFileSync(path.join(dir, 'capture.mp4'));
  let ranges = 0;
  const playlist = fs.readFileSync(path.join(dir, 'generated.m3u8'), 'utf8')
    .replace(/^#EXT-X-BYTERANGE:(\d+)@\d+$/gm, (line, length) => ranges++ ? `#EXT-X-BYTERANGE:${length}` : line);
  assert.ok(ranges >= 3);
  const opened = [];
  const resource = async (url, { range }) => {
    if (!range) return { url, response: new Response(playlist) };
    assert.equal(new URL(url).pathname, '/capture.mp4');
    opened.push(range);
    const { start, end } = range;
    return { url, response: new Response(media.subarray(start, end + 1), {
      status: 206, headers: { 'content-range': `bytes ${start}-${end}/${media.length}` },
    }) };
  };
  const source = hlsHost + '/generated.m3u8';
  const sampler = new BackgroundVideoSampler({ cacheDir: path.join(dir, 'cache'), openLiveResource: resource });
  try {
    await sampler.openLive({ kind: 'live-room', id: roomId, webRid, title: '合成字节范围直播', streamUrls: [], hlsUrls: [source] });
    const result = await sampler.observe({ seconds: 2 });
    assert.equal(result.observation.transport, 'hls');
    assert.ok(result.observation.playbackProgressSeconds > 0 && result.frames.length >= 2);
    assert.equal(opened[0].start, 0);
    assert.equal(opened.at(-2).end + 1, opened.at(-1).start);
    assert.ok(opened.every(range => range.end < media.length));
  } finally { await sampler.close(); }
  await assert.rejects(stageHlsSample(source, { directory: dir, seconds: 2, openResource: async (url, options) =>
    options.range ? { url, response: new Response(media) } : resource(url, options) }), { code: 'BACKGROUND_LIVE_UNAVAILABLE' });
});

test('后台个人私信采样独立于已用尽的自主请求额度，公共入口仍服从额度', async t => {
  if (['ffmpeg', 'ffprobe'].some(command => spawnSync(command, ['-version'], { windowsHide: true }).status !== 0)) {
    return t.skip('未安装 FFmpeg。');
  }
  const id = workIds[0], url = 'https://www.douyin.com/video/' + id;
  const address = 'https://pull.example.douyinvod.com/local-sample.mp4';
  const slow = 'https://slow.example.douyinvod.com/local-sample.mp4';
  const f = await fixture(t, { override: name => name === 'get_video_detail' ? {
    aweme_detail: { ...video(id), video: { play_addr: { url_list: [slow, address] } } },
  } : undefined });
  f.limits.savePolicy({ dailyRequests: 1 }, { explicit: true });
  f.limits.reserveRequest();
  assert.equal(f.limits.state().reasonCode, 'daily-requests');
  const permit = grantPrivateVideoAccess({ sender: 'incoming', media: { type: 'shared-work', videoId: id } }, () => {});
  const cacheDir = path.join(f.directory, 'private-cache');
  const fixtureFile = new URL('./fixtures/headless-progress.mp4', import.meta.url);
  const routes = [];
  f.controller.createSampler = () => new BackgroundVideoSampler({ cacheDir, async downloadMedia(source, destination, options) {
    routes.push(source);
    assert.equal(options.verifiedWorkId, id);
    if (source === slow) throw Object.assign(new Error('合成播放地址无响应'), { code: 'MEDIA_OPEN_TIMEOUT' });
    assert.equal(source, address);
    fs.copyFileSync(fixtureFile, destination);
    return { bytes: fs.statSync(destination).size };
  } });
  await assert.rejects(f.controller.observeSharedWork({ url, videoId: id }), { code: 'GROUP_VIDEO_WAIT_BUDGET' });
  await assert.rejects(f.controller.observeSharedWork({ url, videoId: id, privateVideoAccess: {} }), /许可无效/);
  await assert.rejects(f.controller.executeVideo('douyin_open_video', { url }), /请求次数已用完/);
  const result = await f.controller.observeSharedWork({ url, videoId: id, privateVideoAccess: permit });
  assert.ok(result.observation.playbackProgressSeconds > 0 && result.frames.length >= 2);
  assert.deepEqual(routes, [slow, address]);
  assert.ok(result.frames.every(frame => frame.videoId === id && frame.mimeType === 'image/jpeg' && frame.data.length > 100));
  assert.deepEqual(fs.readdirSync(cacheDir), []);
  assert.equal(f.limits.state().daily.requests, 1);
  assert.equal(f.limits.state().daily.usedSeconds, 0);
  assert.equal(f.limits.state().session, null);
});
