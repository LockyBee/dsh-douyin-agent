import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {downloadPublicMedia,isDouyinWorkMediaUrl,openDouyinLiveStream,runMediaProcess,MediaAdapter} from './media/index.mjs';
import { liveUnavailable } from './yunsur-live.mjs';
import { stageHlsSample } from './yunsur-hls.mjs';

export const isImageWork = work => Boolean(work?.images?.length) || [68, 150].includes(work?.aweme_type);
const exactWorkId = value => typeof value === 'string' && /^\d{10,30}$/.test(value);
const playableError = message => Object.assign(new Error(message), {code: 'BACKGROUND_MEDIA_UNAVAILABLE'});

function httpsMediaLinks(input) {
  return [...new Set(input.filter(address => {
    if (typeof address !== 'string' || address.length > 8000) return false;
    try { const url = new URL(address); return url.protocol === 'https:' && !url.username && !url.password && !url.hash; } catch { return false; }
  }))];
}

function albumFromWork(work) {
  if (!exactWorkId(work.aweme_id) || !Array.isArray(work.images) || !work.images.length || work.images.length > 128) throw playableError('图文没有可核对的图片列表。');
  const pages = work.images.map(image => httpsMediaLinks([
    ...(Array.isArray(image?.url_list) ? image.url_list.slice(0, 4) : []),
    ...(Array.isArray(image?.display_image?.url_list) ? image.display_image.url_list.slice(0, 2) : []),
    ...(Array.isArray(image?.download_url_list) ? image.download_url_list.slice(0, 2) : []),
  ]).slice(0, 4));
  return { id: work.aweme_id, title: String(work.desc || '').slice(0, 1000), kind: 'image-post', pages };
}

export function videoFromWork(work){
  if(!exactWorkId(work?.aweme_id))throw Error('推荐作品缺少精确标识。');
  if(isImageWork(work))throw playableError('当前作品需要按图文读取。');
  const candidates=[work.video?.play_addr_h264,work.video?.play_addr,...(work.video?.bit_rate||[]).map(rate=>rate.play_addr)].filter(Boolean).sort((a,b)=>{const size=value=>Number(value.data_size)>0?Number(value.data_size):Number.MAX_SAFE_INTEGER;return size(a)-size(b);});
  const addresses=[...new Set([...candidates.slice(0,3),work.video?.play_addr_h264,work.video?.play_addr].filter(Boolean).flatMap(addr=>(addr.url_list||[]).slice(0,2)).filter(value=>{try{return new URL(value).protocol==='https:'}catch{return false}}))].slice(0,10);
  if(!addresses.length)throw playableError('作品没有可用的视频地址。');
  const audioUrls=[...new Set((work.video?.bit_rate_audio||[]).flatMap(item=>Object.values(item.audio_meta?.url_list||{})).filter(value=>typeof value==='string'&&value.length<10000).map(value=>{if(value.startsWith('https://'))return value;try{return Buffer.from(value,'base64').toString('utf8')}catch{return''}}).filter(value=>{try{return new URL(value).protocol==='https:'}catch{return false}}))].slice(0,4);
  return {id:work.aweme_id,urls:addresses,audioUrls,title:String(work.desc||'').slice(0,1000)};
}

export class BackgroundVideoSampler{
  constructor({cacheDir,ffmpeg='ffmpeg',ffprobe='ffprobe',mediaAdapter=new MediaAdapter(),downloadMedia=downloadPublicMedia,openLiveStream=openDouyinLiveStream,openLiveResource}={}){if(!path.isAbsolute(cacheDir))throw Error('需要独立视频缓存目录。');Object.assign(this,{cacheDir,ffmpeg,ffprobe,mediaAdapter,downloadMedia,openLiveStream,openLiveResource});this.current=null;this.busy=false;this.decoding=false;this.readingImage=false;}
  async openLive(room, { signal } = {}) {
    if (this.busy) throw Error('上一段画面尚在解码。');
    await this.close();
    await fs.mkdir(this.cacheDir, { recursive: true });
    signal?.throwIfAborted();
    const directory = await fs.mkdtemp(path.join(this.cacheDir, 'live-'));
    this.current = { ...room, directory, time: 0, decodedFrames: 0 };
    return this.state();
  }
  async open(work,{signal,includeAudio=true,privateVideo=false}={}){
    if (isImageWork(work)) return this.openImagePage(albumFromWork(work), 0, { signal });
    if(this.busy)throw Error('上一段视频尚在解码。');await this.close();await fs.mkdir(this.cacheDir,{recursive:true});
    const selected=videoFromWork(work),directory=await fs.mkdtemp(path.join(this.cacheDir,'work-')),file=path.join(directory,'source.mp4');
    try {
      let downloaded, lastError;
      for (const url of selected.urls) {
        signal?.throwIfAborted();
        const verifiedWorkId = privateVideo && isDouyinWorkMediaUrl(url) ? selected.id : undefined;
        try {
          downloaded = await this.downloadMedia(url, file, { signal, ...(verifiedWorkId ? { verifiedWorkId } : {}) });
          break;
        } catch (error) { lastError = error; }
      }
      signal?.throwIfAborted();
      if (!downloaded) throw lastError;
      const probe=JSON.parse(await runMediaProcess(this.ffprobe,['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',file],{signal,timeoutMs:30000,maxOutputBytes:20000}));
      const duration=Number(probe.format?.duration);if(!Number.isFinite(duration)||duration<=0||!probe.streams?.some(s=>s.codec_type==='video'))throw Error('视频轨或时长无法核对。');
      let audioFile=null,audioIssue=null;const hasEmbeddedAudio=probe.streams.some(s=>s.codec_type==='audio');
      if(includeAudio&&!hasEmbeddedAudio&&selected.audioUrls.length){audioFile=path.join(directory,'source.audio');let fetched=false;for(const url of selected.audioUrls){try{await this.downloadMedia(url,audioFile,{signal,maxBytes:64*1024*1024});fetched=true;break;}catch(error){audioIssue=error.message;}}if(fetched){const audioProbe=JSON.parse(await runMediaProcess(this.ffprobe,['-v','error','-show_entries','stream=codec_type','-of','json',audioFile],{signal,timeoutMs:30000,maxOutputBytes:10000}));if(!audioProbe.streams?.some(s=>s.codec_type==='audio'))audioFile=null;}else audioFile=null;}
      this.current={...selected,urls:undefined,audioUrls:undefined,file,audioFile,audioIssue,directory,duration,time:0,bytes:downloaded.bytes,hasAudio:hasEmbeddedAudio||!!audioFile};return this.state();
    }catch(error){await this.removeDirectory(directory);throw error;}
  }
  async openImagePage(work, index, { signal } = {}) {
    if (this.busy) throw new Error('前一段作品尚在采样。');
    if (!work.pages[index]?.length) throw playableError('当前图文页没有可读取的图片地址。');
    await fs.mkdir(this.cacheDir, { recursive: true });
    const directory = await fs.mkdtemp(path.join(this.cacheDir, 'image-'));
    const original = path.join(directory, 'source-image'), file = path.join(directory, 'page.jpg');
    try {
      const formats = 'jpeg_pipe,png_pipe,webp_pipe';
      let image;
      for (const url of work.pages[index]) {
        signal?.throwIfAborted();
        try {
          await this.downloadMedia(url, original, { signal, maxBytes: 16 * 1024 * 1024, trustedDouyinImage: true });
          const info = JSON.parse(await runMediaProcess(this.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', formats, '-show_entries', 'stream=width,height', '-of', 'json', original], { signal, timeoutMs: 10_000, maxOutputBytes: 1000 }));
          const { width, height } = info.streams?.[0] || {};
          if (info.streams?.length !== 1 || !Number.isInteger(width) || !Number.isInteger(height) || width < 120 || height < 120 || width * height > 24_000_000) throw playableError('图文图片尺寸不适合采样。');
          await runMediaProcess(this.ffmpeg, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', formats, '-threads', '2', '-i', original, '-frames:v', '1', '-vf', 'scale=960:960:force_original_aspect_ratio=decrease', '-q:v', '4', '-update', '1', file], { signal, timeoutMs: 15_000, maxOutputBytes: 1000 });
          const { size } = await fs.stat(file);
          if (size < 4 || size > 1_500_000) throw playableError('图文没有通过实际画面解码。');
          const bytes = await fs.readFile(file);
          if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw playableError('图文没有通过实际画面解码。');
          image = { width, height, key: createHash('sha256').update(`${work.id}:${index}:`).update(bytes).digest('hex') };
          break;
        } catch (error) {
          signal?.throwIfAborted();
          for (const target of [original, file]) await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      }
      if (!image) throw playableError('当前图文页未取得可解码的真实图片。');
      await fs.unlink(original);
      signal?.throwIfAborted();
      await this.close();
      this.current = { ...work, directory, file, index, image };
      return this.state();
    } catch (error) {
      await this.removeDirectory(directory);
      throw error;
    }
  }
  async advanceImage({ signal } = {}) {
    const current = this.current;
    if (current?.kind !== 'image-post' || current.index + 1 >= current.pages.length) throw new Error('当前图文没有下一张。');
    return this.openImagePage(current, current.index + 1, { signal });
  }
  state(){
    const current = this.current;
    const shared = { loginRequired:false, verificationRequired:false, privateChatVisible:false, playbackBackend:'local-decoder', platformWatchReceipt:false };
    if (current?.kind === 'live-room') {
      return { ...shared, url: `https://live.douyin.com/${current.webRid}`, pageKind: 'live-room', video: null, liveRoom: {
        recognized: true, source: 'local-media-live', scope: 'live-room', roomId: current.id, title: current.title, ended: false,
        video: { readyState: current.decodedFrames ? 2 : 0, time: current.time,
          paused: !this.decoding || performance.now() - current.lastProgressAt > 1800, decodedFrames: current.decodedFrames },
      } };
    }
    if (current?.kind === 'image-post') {
      const url = `https://www.douyin.com/note/${current.id}`;
      const { width, height, key } = current.image;
      return { ...shared, url, pageKind: 'image-post', video: null, imagePost: {
        id: current.id, title: current.title, url, source: 'local-media-image', recognized: true, loaded: true,
        imageKey: key, dimensions: { width, height }, reading: this.readingImage,
        album: { page: current.index + 1, total: current.pages.length, hasNext: current.index + 1 < current.pages.length },
      } };
    }
    const url = current ? `https://www.douyin.com/video/${current.id}` : 'https://www.douyin.com/';
    return { ...shared, pageKind: current ? 'video' : 'unknown', url, video: current ? { id: current.id, url, title: current.title, duration: current.duration, time: current.time, readyState: 2, paused: !this.decoding, ended: current.time >= current.duration } : null };
  }
  async observeImage(seconds, { signal, onProgress }) {
    const current = this.current;
    this.busy = true;
    let ticker, data;
    try {
      data = (await fs.readFile(current.file)).toString('base64');
      signal?.throwIfAborted();
      this.readingImage = true;
      const report = () => onProgress(this.state());
      report();
      ticker = setInterval(report, 1000);
      await delay(seconds * 1000, undefined, { signal });
    } finally {
      clearInterval(ticker);
      this.readingImage = false;
      this.busy = false;
      onProgress(this.state());
    }
    return { state: this.state(),
      frames: [{ videoId: current.id, imageKey: current.image.key, mediaKind: 'image-post', time: null, mimeType: 'image/jpeg', data }],
      observation: { videoId: current.id, workKind: 'image-post', imageKey: current.image.key, scope: 'current-image' } };
  }
  async observe({seconds=12,signal,onProgress=()=>{},includeAudio=true}={}){
    if(this.busy||!this.current)throw Error('没有就绪的视频或前一段仍在解码。');if(!Number.isFinite(seconds)||seconds<0.2||seconds>30)throw Error('单次画面采样须在0.2至30秒之间。');
    if (this.current.kind === 'image-post') return this.observeImage(seconds, { signal, onProgress });
    if (this.current.kind === 'live-room') return this.observeLive(seconds, { signal, onProgress });
    const v=this.current,start=v.time,duration=Math.min(seconds,v.duration-start);if(duration<=0)throw Error('当前视频已经结束。');
    const sampleDir=path.join(v.directory,randomUUID());await fs.mkdir(sampleDir);const count=Math.max(duration>=0.24?2:1,Math.min(12,Math.ceil(duration/2))),fps=count/duration;
    this.busy=true;this.decoding=true;const began=performance.now();const ticker=setInterval(()=>onProgress(this.state()),1000);ticker.unref();
    try{
      onProgress(this.state());signal?.throwIfAborted();
      const progress=await runMediaProcess(this.ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-re','-ss',String(start),'-i',v.file,'-t',String(duration),'-an','-vf',`fps=${fps},scale=480:-2`,'-q:v','4','-progress','pipe:1',path.join(sampleDir,'%03d.jpg')],{signal,timeoutMs:(duration+20)*1000,maxOutputBytes:20000});
      const files=(await fs.readdir(sampleDir)).filter(name=>/^\d{3}\.jpg$/.test(name)).sort();if(!files.length||files.length>12)throw Error('解码未取得可核对的画面。');
      const decoded=Number([...progress.matchAll(/out_time_us=(\d+)/g)].at(-1)?.[1])/1000000;if(!Number.isFinite(decoded)||decoded<=0)throw Error('解码进度没有推进。');
      const frames=await Promise.all(files.map(async(name,index)=>({videoId:v.id,time:Math.min(start+index/fps,v.duration),mimeType:'image/jpeg',data:(await fs.readFile(path.join(sampleDir,name))).toString('base64')})));
      v.time=Math.min(v.duration,start+duration);onProgress({...this.state(),video:{...this.state().video,paused:false}});
      clearInterval(ticker);this.decoding=false;onProgress(this.state());const playbackWallSeconds=(performance.now()-began)/1000;
      let audio={ok:false,status:!includeAudio?'not-requested':v.audioIssue?'audio-download-failed':'no-audio-track'};
      if(includeAudio&&v.hasAudio){const audioFile=path.join(sampleDir,'sample.wav');await runMediaProcess(this.ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-ss',String(start),'-i',v.audioFile||v.file,'-t',String(duration),'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',audioFile],{signal,timeoutMs:30000,maxOutputBytes:1000});audio=await this.mediaAdapter.transcribeAudio({source:audioFile,startSeconds:0,durationSeconds:duration},{signal});}
      const state=this.state(),intervalState={...state,video:{...state.video,paused:false}};
      return {state,intervalState,frames,audio,observation:{videoId:v.id,beforeTime:start,afterTime:v.time,beforePaused:false,paused:false,playbackProgressSeconds:duration,decodedOutputSeconds:decoded,actualWallSeconds:playbackWallSeconds,playbackWallSeconds,elapsedSeconds:(performance.now()-began)/1000,source:'ffmpeg-realtime-local-media'},limitations:['本机解码不等于抖音网页已记录观看或兴趣反馈。',...(audio.ok?['音频为语音转写，未独立识别音乐或环境声。']:['本段没有取得语音转写。'])]};
    }finally{clearInterval(ticker);this.busy=false;this.decoding=false;await this.removeDirectory(sampleDir);}
  }
  async liveInput(room, source, { directory, seconds, signal }) {
    if (source.transport === 'hls') {
      const staging = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
      const { file, cursor } = await stageHlsSample(source.url, { directory, seconds, cursor: room.hlsCursor,
        signal: staging, openResource: this.openLiveResource });
      return { cursor, args: ['-protocol_whitelist','file','-format_whitelist','hls,mpegts,mov',
        '-allowed_extensions','ts,m4s,mp4','-f','hls','-i',file] };
    }
    const connect = new AbortController(), timer = setTimeout(() => connect.abort(), 5000);
    try {
      const inputStream = await this.openLiveStream(source.url, { signal: AbortSignal.any([signal, connect.signal]) });
      return { inputStream, args: ['-protocol_whitelist','pipe','-f','flv','-i','pipe:0'] };
    } finally { clearTimeout(timer); }
  }

  async decodeLive(room, source, { directory, seconds, signal, onProgress, hasFallback }) {
    const beforeTime = room.time, beforeFrames = room.decodedFrames;
    const attempt = new AbortController(), combined = AbortSignal.any([signal, attempt.signal]);
    let input, startup, pending = '', frameCount = 0, outputTime = 0, decoded = 0;
    const progress = chunk => {
      if (combined.aborted) return;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        if (line.startsWith('frame=')) frameCount = Number(line.slice(6));
        if (line.startsWith('out_time_us=')) outputTime = Number(line.slice(12)) / 1_000_000;
        if (line.startsWith('progress=') && frameCount > 0 && Number.isFinite(outputTime) && outputTime > decoded) {
          clearTimeout(startup);
          decoded = Math.min(seconds, outputTime);
          room.time = beforeTime + decoded;
          room.decodedFrames = beforeFrames + frameCount;
          room.lastProgressAt = performance.now();
          this.decoding = true;
          onProgress(this.state());
        }
      }
    };
    try {
      await fs.mkdir(directory);
      input = await this.liveInput(room, source, { directory, seconds, signal: combined });
      const fps = Math.max(2, Math.min(12, Math.ceil(seconds))) / seconds;
      if (hasFallback && source.transport === 'flv') startup = setTimeout(() => attempt.abort(), 5000);
      await runMediaProcess(this.ffmpeg, ['-nostdin','-hide_banner','-loglevel','error','-stats_period','0.5','-probesize','1048576',
        '-analyzeduration','1000000','-re',...input.args,'-t',String(seconds),'-an',
        '-vf',`fps=${fps},scale=480:480:force_original_aspect_ratio=decrease:force_divisible_by=2`,'-q:v','4',
        '-progress','pipe:1',path.join(directory,'%03d.jpg')],
      { signal: combined, inputStream: input.inputStream, onOutput: progress, timeoutMs: (seconds + 10) * 1000, maxOutputBytes: 20000 });
      const files = (await fs.readdir(directory)).filter(name => /^\d{3}\.jpg$/.test(name)).sort();
      if (files.length < 2 || files.length > 12 || decoded <= 0) throw liveUnavailable('直播未取得可以核对的帧或播放时间。');
      const frames = await Promise.all(files.map(async (file, index) => ({
        videoId: `live:${room.id}`, mediaKind: 'live', roomId: room.id, time: beforeTime + index / fps, mimeType: 'image/jpeg',
        data: (await fs.readFile(path.join(directory, file))).toString('base64'),
      })));
      this.decoding = false;
      room.preferredTransport = source.transport;
      if (input.cursor) room.hlsCursor = input.cursor;
      return { state: this.state(), frames, observation: { videoId: `live:${room.id}`, workKind: 'live', roomId: room.id,
        scope: 'sampled-live-frames', transport: source.transport, beforeTime, afterTime: room.time,
        playbackProgressSeconds: decoded, decodedFramesAdded: room.decodedFrames - beforeFrames } };
    } finally {
      clearTimeout(startup);
      this.decoding = false;
      attempt.abort();
      input?.inputStream?.destroy();
      await this.removeDirectory(directory);
    }
  }

  async observeLive(seconds, { signal, onProgress }) {
    const room = this.current;
    const flv = (room.streamUrls ?? []).map(url => ({ transport: 'flv', url }));
    const hls = (room.hlsUrls ?? []).map(url => ({ transport: 'hls', url }));
    const sources = room.preferredTransport === 'hls' ? [...hls, ...flv] : [...flv.slice(0, 1), ...hls, ...flv.slice(1)];
    const combined = AbortSignal.any([AbortSignal.timeout((seconds + 20) * 1000), ...(signal ? [signal] : [])]);
    this.busy = true;
    try {
      for (const [index, source] of sources.entries()) {
        const before = room.time;
        try {
          return await this.decodeLive(room, source, { directory: path.join(room.directory, randomUUID()), seconds,
            signal: combined, onProgress, hasFallback: index + 1 < sources.length });
        } catch {
          signal?.throwIfAborted();
          if (combined.aborted || room.time > before) break;
        }
      }
      throw liveUnavailable('直播画面没有持续解码，将继续浏览其他作品。');
    } finally { this.busy = false; }
  }
  async removeDirectory(directory){const relative=path.relative(path.resolve(this.cacheDir),path.resolve(directory));if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('视频缓存路径越界，未删除。');const stat=await fs.lstat(directory).catch(()=>null);if(stat?.isSymbolicLink())throw Error('缓存路径是链接，未删除。');if(stat)await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
  async close(){if(this.busy)throw Error('须先停止当前采样再释放视频。');if(this.current){const directory=this.current.directory;this.current=null;await this.removeDirectory(directory);}}
}
