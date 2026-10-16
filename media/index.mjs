import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { Readable } from 'node:stream';
import { parseEnv } from 'node:util';
import { makeProviders } from './vendor/voice/lib/providers.js';
import { resolveRuntimePaths } from '../runtime-paths.mjs';
import { saveSharedMediaKey } from './key-store.mjs';

// MiMo驱动、dsh-voice provider与MiniMax ASR参数的来源和MIT声明见README.md及vendor。

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LIMITS = { maxBytes: 25 * 1024 * 1024, maxDurationSeconds: 120, processTimeoutMs: 180_000, apiTimeoutMs: 120_000 };
const ENV_KEYS = ['XIAOMI_API_KEY','MINIMAX_API_KEY','DOUYIN_MEDIA_MIMO_AUDIO_MODEL','DOUYIN_MEDIA_MIMO_VIDEO_MODEL','DOUYIN_MEDIA_WHISPER_MODEL','DOUYIN_MEDIA_PYTHON','DOUYIN_MEDIA_FFMPEG','DOUYIN_MEDIA_FFPROBE','DOUYIN_MEDIA_WHISPER_URL'];
const LOCAL_MODELS=new Set(['tiny','tiny.en','base','base.en','small','small.en','medium','medium.en','large-v3']);
const signed = /^(token|.*_token|mstoken|auth|auth_key|authorization|cookie|signature|.*signature|sig|sign|credential|key|key-pair-id|policy|expires|expire|x-expires|x-bogus|x-amz-.+|x-oss-.+)$/i;
const privateHost = host => /^(localhost|.*\.localhost|.*\.local)$/i.test(host) || /^\[/.test(host) || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host);
const publicAddress = item => item.family === 4 && !privateHost(item.address) && !/^(192\.0\.|192\.0\.2\.|198\.(18|19|51)\.|203\.0\.113\.|22[4-9]\.|2[3-5]\d\.)/.test(item.address);
const validatedAddresses=new WeakMap();

export async function loadMediaConfig({ env = process.env, envFile = resolveRuntimePaths({ env }).mediaEnvFile } = {}) {
  let saved = {};
  try { saved = parseEnv(await fs.readFile(envFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('媒体配置文件无法解析。'); }
  return Object.fromEntries(ENV_KEYS.map(key => [key, env[key] ?? saved[key] ?? '']));
}
function safeText(value, config) {
  let text = String(value ?? '').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [隐藏]');
  for (const key of [config.XIAOMI_API_KEY,config.MINIMAX_API_KEY].filter(Boolean)) text = text.split(key).join('[隐藏]');
  return text.replace(/https?:\/\/[^\s"<>]+/g, raw => { try { const url = new URL(raw); url.search = ''; url.hash = ''; url.username = ''; url.password = ''; return url.href; } catch { return '[地址已省略]'; } }).slice(0, 16_000);
}
function safeUsage(value){
  if(!value||typeof value!=='object')return null;
  return Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].filter(key=>Number.isFinite(value[key])&&value[key]>=0).map(key=>[key,value[key]]));
}
export async function validatePublicMediaUrl(source) {
  let url;
  try { url = new URL(source); } catch { throw new Error('媒体 URL 格式错误。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || privateHost(url.hostname)) throw new Error('只接受不带认证信息的公开 HTTPS 媒体 URL。');
  if ([...url.searchParams.keys()].some(key => signed.test(key))) throw new Error('带签名、凭据或有效期的媒体地址未接受；请提供本地文件或公开地址。');
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item))) throw new Error('媒体地址未解析到可用公网 IPv4，未下载。');
  validatedAddresses.set(url,addresses);
  return url;
}
function mediaProxy(url){
  const exclusions=(process.env.NO_PROXY||process.env.no_proxy||'').split(',').map(item=>item.trim().toLowerCase()).filter(Boolean);
  const host=url.hostname.toLowerCase();
  if(exclusions.some(item=>item==='*'||item===host||item===`${host}:${url.port||443}`||(item.startsWith('.')&&(host===item.slice(1)||host.endsWith(item)))))return null;
  const raw=process.env.HTTPS_PROXY||process.env.https_proxy||process.env.HTTP_PROXY||process.env.http_proxy;
  if(!raw)return null;
  let proxy;try{proxy=new URL(raw);}catch{throw new Error('现有网络代理格式无法解析。');}
  if(!['http:','https:'].includes(proxy.protocol))throw new Error('媒体下载目前只支持HTTP CONNECT代理。');
  return proxy;
}
function proxyMediaAgent(url,proxy,signal){
  const address=validatedAddresses.get(url)?.[0];if(!address||!publicAddress(address))throw new Error('媒体代理连接没有已核对的公网地址。');
  const destination=`${address.address}:${url.port||443}`,agent=new HttpsAgent({keepAlive:false});
  agent.createConnection=(_options,callback)=>{
    let finished=false;
    const finish=(error,socket)=>{if(finished){if(error)socket?.destroy();return;}finished=true;callback(error,socket);};
    const authorization=proxy.username||proxy.password?`Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`:null;
    const connect=(proxy.protocol==='https:'?httpsRequest:httpRequest)({protocol:proxy.protocol,hostname:proxy.hostname,port:proxy.port||undefined,method:'CONNECT',path:destination,signal,headers:{host:destination,...(authorization?{'proxy-authorization':authorization}:{})}});
    connect.on('connect',(response,socket,head)=>{
      if(response.statusCode!==200){socket.destroy();finish(new Error('现有网络代理拒绝媒体连接。'));return;}
      if(head.length)socket.unshift(head);
      const secure=tlsConnect({socket,servername:url.hostname,rejectUnauthorized:true});
      const stop=()=>secure.destroy(new Error('媒体代理连接已停止。'));signal?.addEventListener('abort',stop,{once:true});secure.once('close',()=>signal?.removeEventListener('abort',stop));if(signal?.aborted)stop();
      secure.once('secureConnect',()=>finish(null,secure));secure.once('error',error=>finish(error));
    });
    connect.on('error',error=>finish(error));connect.setTimeout(30_000,()=>connect.destroy(new Error('媒体代理连接超时。')));connect.end();
  };
  return agent;
}
async function publicMediaResponse(url,signal){
  signal?.throwIfAborted();
  const proxy=mediaProxy(url),agent=proxy?proxyMediaAgent(url,proxy,signal):undefined;
  return new Promise((resolve,reject)=>{
    const request=httpsRequest(url,{method:'GET',family:4,signal,agent,lookup:(hostname,options,callback)=>{
      // 核对的IP直接交给此次连接，避免检查后又由fetch重新解析到私网。
      dns.lookup(hostname,{all:true,family:4}).then(addresses=>{
        if(!addresses.length||addresses.some(item=>!publicAddress(item)))throw new Error('媒体连接的地址不是可用公网 IPv4。');
        if(options.all)callback(null,addresses);else callback(null,addresses[0].address,4);
      }).catch(callback);
    }},incoming=>{
      incoming.once('close',()=>agent?.destroy());
      const headers=new Headers();for(const[key,value]of Object.entries(incoming.headers)){if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);}
      const status=incoming.statusCode||500;
      if([204,205,304].includes(status)){incoming.resume();resolve(new Response(null,{status,headers}));}
      else resolve(new Response(Readable.toWeb(incoming),{status,headers}));
    });
    request.on('error',()=>{agent?.destroy();reject(new Error('公开媒体连接失败，未使用任何登录凭据。'));});request.setTimeout(30_000,()=>request.destroy(new Error('媒体连接空闲超时。')));request.end();
  });
}
async function run(executable, args, { input, signal, timeoutMs = 180_000, maxOutputBytes = 40 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const childEnvironment={...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'};delete childEnvironment.XIAOMI_API_KEY;delete childEnvironment.MINIMAX_API_KEY;
    const child = spawn(executable, args, { windowsHide: true, shell: false, env: childEnvironment, stdio: ['pipe','pipe','pipe'] });
    const chunks = []; let length = 0, finished = false;
    const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(value); };
    const cancel = () => { child.kill(); finish(signal?.reason instanceof Error ? signal.reason : new Error('媒体任务已停止。')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('媒体处理超时。')); }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', () => finish(new Error('媒体运行时不可用，请核对 Python 或 ffmpeg 路径。')));
    child.stdout.on('data', chunk => { length += chunk.length; if (length > maxOutputBytes) { child.kill(); finish(new Error('媒体处理输出超过上限。')); } else chunks.push(chunk); });
    // 子进程详细错误可能含文件路径或临时地址，只返回可操作的固定说明。
    child.stderr.resume();
    child.on('close', code => finish(code === 0 ? null : new Error('媒体处理失败；依赖、模型下载或媒体格式未通过。'), Buffer.concat(chunks).toString('utf8')));
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    if (signal?.aborted) cancel();
  });
}
async function cleanTemporary(directory) {
  const resolved = path.resolve(directory), base = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(base) || !path.basename(resolved).startsWith('douyin-media-')) throw new Error('媒体临时目录清理路径越界。');
  await fs.rm(resolved, { recursive: true, force: true, maxRetries:5, retryDelay:100 });
}

export class MediaAdapter {
  constructor({ config, env, envFile, settingsFile = resolveRuntimePaths().mediaSettingsFile, fetchImpl = fetch, python, ffmpeg, ffprobe, limits = {} } = {}) {
    this.configOverride = config; this.env = env; this.envFile = envFile;
    this.settingsFile=settingsFile;
    this.settingsWrite=Promise.resolve();
    this.fetch = fetchImpl; this.pythonOverride = python; this.ffmpegOverride = ffmpeg; this.ffprobeOverride = ffprobe;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const [key,value] of Object.entries(this.limits)) if (!Number.isFinite(value) || value <= 0 || value > DEFAULT_LIMITS[key]) throw new Error('媒体预算只能在默认上限内设置。');
  }
  async settings() {
    let value;try{value=JSON.parse(await fs.readFile(this.settingsFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('媒体运行设置无法读取，请在控制台重新保存。');value={enabled:false,backend:'local-whisper'};}
    if(typeof value.enabled!=='boolean'||!['local-whisper','mimo','minimax'].includes(value.backend))throw new Error('媒体运行设置格式错误。');
    return{enabled:value.enabled,backend:value.backend};
  }
  async saveSettings(value,{explicit=false}={}) {
    if(explicit!==true)throw new Error('媒体启用设置只能由用户在控制台或CLI明确操作。');
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['enabled','backend'].includes(key)))throw new Error('媒体设置只接受enabled和backend。');
    const write=async()=>{
      const settings={...await this.settings(),...value};
      if(typeof settings.enabled!=='boolean'||!['local-whisper','mimo','minimax'].includes(settings.backend))throw new Error('媒体设置格式错误。');
      await fs.mkdir(path.dirname(this.settingsFile),{recursive:true});const temporary=`${this.settingsFile}.${process.pid}.${randomUUID()}.tmp`;
      try{await fs.writeFile(temporary,JSON.stringify(settings,null,2),{mode:0o600});await fs.rename(temporary,this.settingsFile);return settings;}finally{await fs.rm(temporary,{force:true});}
    };
    const pending=this.settingsWrite.then(write,write);this.settingsWrite=pending.then(()=>{},()=>{});return pending;
  }
  setEnabled(enabled,options={}) {return this.saveSettings({enabled},options);}
  async credentialStatus(config) {
    const env = this.env ?? process.env;
    const envFile = this.envFile ?? resolveRuntimePaths({ env }).mediaEnvFile;
    let saved = {};
    try { saved = parseEnv(await fs.readFile(envFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('媒体配置文件无法解析。'); }
    const effective = config ?? (this.configOverride ?? await loadMediaConfig({ env, envFile }));
    return Object.fromEntries([['mimo', 'XIAOMI_API_KEY'], ['minimax', 'MINIMAX_API_KEY']].map(([backend, variable]) => {
      const overridden = this.configOverride !== undefined && this.configOverride !== null;
      const environmentOverride = !overridden && env[variable] !== undefined && env[variable] !== null;
      return [backend, { configured: Boolean(effective[variable]), source: overridden ? 'override' : environmentOverride ? 'environment' : saved[variable] ? 'shared-env' : 'none', saved: Boolean(saved[variable]), environmentOverride }];
    }));
  }
  async saveCredentials(input, { explicit = false } = {}) {
    if (explicit !== true) throw Object.assign(new Error('音频密钥只能由用户明确保存。'), { status: 400 });
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['backend', 'apiKey'].includes(key)) || !['mimo', 'minimax'].includes(input.backend) || typeof input.apiKey !== 'string') throw Object.assign(new Error('请选择 MiMo 或 MiniMax 并填写对应 API Key。'), { status: 400 });
    // 留空沿用现有凭据；保存凭据不会改动音频开关或所选后端。
    if (input.apiKey.trim()) {
      const envFile = this.envFile ?? resolveRuntimePaths({ env: this.env ?? process.env }).mediaEnvFile;
      try { await saveSharedMediaKey(input, { envFile, explicit: true }); }
      catch (error) { throw Object.assign(error, { status: 400 }); }
    }
    return this.status();
  }
  async runtime() {
    const config = this.configOverride ?? await loadMediaConfig({ env: this.env, envFile: this.envFile });
    if(config.DOUYIN_MEDIA_WHISPER_MODEL&&!LOCAL_MODELS.has(config.DOUYIN_MEDIA_WHISPER_MODEL))throw new Error('本地Whisper模型须从受支持的模型名称中选择。');
    const paths = resolveRuntimePaths();
    const localPython = path.join(paths.mediaRuntimeRoot,'.venv','Scripts','python.exe');
    const bundled = path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','python','python.exe');
    return { config, modelsDir: paths.mediaModelsDir, python: this.pythonOverride || config.DOUYIN_MEDIA_PYTHON || (existsSync(localPython) ? localPython : existsSync(bundled) ? bundled : 'python'), ffmpeg: this.ffmpegOverride || config.DOUYIN_MEDIA_FFMPEG || 'ffmpeg', ffprobe: this.ffprobeOverride || config.DOUYIN_MEDIA_FFPROBE || 'ffprobe' };
  }
  async status() {
    const settings=await this.settings();
    const runtime = await this.runtime(), credentials = await this.credentialStatus(runtime.config); let local = { available: false, note: '本地 Whisper 依赖尚未就绪。' };
    try { local = JSON.parse(await run(runtime.python,[path.join(ROOT,'local_whisper.py'),'--probe','--model',runtime.config.DOUYIN_MEDIA_WHISPER_MODEL||'tiny','--models-dir',runtime.modelsDir],{timeoutMs:10_000,maxOutputBytes:4096})); } catch {}
    return { ...settings,backends: { mimo: { available: Boolean(runtime.config.XIAOMI_API_KEY), credential: credentials.mimo, note: '云端音视频理解，需要独立 MiMo 凭据。' }, minimax: { available: Boolean(runtime.config.MINIMAX_API_KEY), credential: credentials.minimax, note: '云端语音转写，需要独立 MiniMax 凭据。' }, 'local-whisper': { ...local, model: runtime.config.DOUYIN_MEDIA_WHISPER_MODEL || 'tiny', note: '依赖检查不等于模型已下载或转写已通过；真实验收另记录。' } }, limits: this.limits };
  }
  analyzeAudio(args, options = {}) { return this.execute('audio', args, options); }
  analyzeVideo(args, options = {}) { return this.execute('video', args, options); }
  transcribeAudio(args, options = {}) { return this.execute('transcription', args, options); }
  async prepare(args, kind, runtime, directory, signal) {
    if (!args || typeof args.source !== 'string' || !args.source.trim()) throw new Error('需要本地媒体文件或公开 HTTPS 媒体地址。');
    const start = args.startSeconds ?? 0, requested = args.durationSeconds ?? this.limits.maxDurationSeconds;
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(requested) || requested <= 0 || requested > this.limits.maxDurationSeconds) throw new Error('媒体开始时间须非负，片段时长须在预算内。');
    let source = args.source, descriptor;
    if (/^https?:/i.test(source)) {
      let url = await validatePublicMediaUrl(source); descriptor = { type: 'public-url', display: `${url.origin}${url.pathname}` };
      let response;
      for (let redirect = 0; redirect < 4; redirect++) {
        response = await publicMediaResponse(url,signal);
        if (![301,302,303,307,308].includes(response.status)) break;
        const target = response.headers.get('location'); await response.body?.cancel();
        if (!target) throw new Error('媒体重定向没有可核对的地址。');
        url = await validatePublicMediaUrl(new URL(target,url).href); response = null;
      }
      if (!response?.ok) throw new Error('公开媒体下载失败或重定向超过上限。');
      const size = Number(response.headers.get('content-length'));
      if (size > this.limits.maxBytes) { await response.body?.cancel(); throw new Error('媒体下载体积超过预算。'); }
      const chunks = []; let length = 0;
      for await (const chunk of response.body) { signal?.throwIfAborted(); length += chunk.length; if (length > this.limits.maxBytes) throw new Error('媒体下载体积超过预算。'); chunks.push(chunk); }
      source = path.join(directory,'source.media'); await fs.writeFile(source,Buffer.concat(chunks));
    } else {
      if (!path.isAbsolute(source)) throw new Error('本地媒体必须使用绝对路径。');
      const stat = await fs.stat(source); if (!stat.isFile() || stat.size > this.limits.maxBytes) throw new Error('本地媒体不是文件或体积超过预算。');
      descriptor = { type: 'local-file', display: path.basename(source) };
    }
    const probe = JSON.parse(await run(runtime.ffprobe,['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',source],{signal,timeoutMs:30_000,maxOutputBytes:30_000}));
    const measuredDuration = Number(probe.format?.duration);
    const duration = Number.isFinite(measuredDuration) && measuredDuration > 0 ? measuredDuration : null;
    const boundedRecordedAudio = duration === null && descriptor.type === 'local-file' && path.extname(source).toLowerCase() === '.webm' && kind !== 'video';
    if ((!duration && !boundedRecordedAudio) || (duration && start >= duration)) throw new Error('媒体时长无法核对，或开始时间已经超过媒体末尾。');
    if (!probe.streams?.some(item=>item.codec_type === (kind==='video'?'video':'audio'))) throw new Error(kind==='video'?'文件没有可读取的视频轨。':'文件没有可读取的音轨。');
    const seconds = duration === null ? requested : Math.min(requested,duration-start), output = path.join(directory,kind==='video'?'sample.mp4':'sample.wav');
    const argv = ['-nostdin','-hide_banner','-loglevel','error','-y','-ss',String(start),'-i',source,'-t',String(seconds)];
    if (kind==='video') argv.push('-vf','scale=480:-2','-c:v','libx264','-preset','veryfast','-crf','28','-c:a','aac','-b:a','64k','-movflags','+faststart');
    else argv.push('-vn','-ac','1','-ar','16000','-c:a','pcm_s16le');
    argv.push(output); await run(runtime.ffmpeg,argv,{signal,timeoutMs:this.limits.processTimeoutMs,maxOutputBytes:10_000});
    const stat = await fs.stat(output); if (!stat.size || stat.size > this.limits.maxBytes) throw new Error('处理后的媒体为空或超过体积预算。');
    let verifiedSeconds=seconds;
    if(kind!=='video'){
      const outputProbe=JSON.parse(await run(runtime.ffprobe,['-v','error','-show_entries','format=duration','-of','json',output],{signal,timeoutMs:30_000,maxOutputBytes:4096}));
      verifiedSeconds=Number(outputProbe.format?.duration);
      if(!Number.isFinite(verifiedSeconds)||verifiedSeconds<=0||verifiedSeconds>seconds+1/16000||verifiedSeconds>this.limits.maxDurationSeconds)throw new Error('转码后的音频时长无法核对或超过预算。');
    }
    return { path: output, descriptor, interval: { startSeconds:start,durationSeconds:verifiedSeconds,requestedDurationSeconds:requested,sourceDurationSeconds:duration,durationVerifiedBy:kind==='video'?'ffprobe-source-and-request':'ffprobe-output' }, clipped: duration===null || start>0 || seconds<duration, unknownSourceDuration:duration===null };
  }
  async execute(kind,args,{signal}={}) {
    signal?.throwIfAborted();
    const settings=await this.settings(),backend=settings.backend;
    if(!settings.enabled)return{ok:false,status:'disabled',backend,kind,error:'媒体能力当前关闭；用户可在控制台自行启用，模型不能改变开关。'};
    if (!['mimo','minimax','local-whisper'].includes(backend)) throw new Error('这个媒体任务不支持所选后端。');
    if(args?.backend&&args.backend!==backend)return{ok:false,status:'backend-not-selected',backend,kind,error:'模型不能切换媒体后端；请先由用户在控制台选择所需后端。'};
    if(kind!=='transcription'&&backend!=='mimo')return{ok:false,status:'unsupported',backend,kind,error:'当前后端只提供语音转写；通用音频或视频理解需要用户选择MiMo。'};
    const runtime = await this.runtime(), config = runtime.config;
    if ((backend==='mimo'&&!config.XIAOMI_API_KEY)||(backend==='minimax'&&!config.MINIMAX_API_KEY)) return { ok:false,status:'unavailable',backend,kind,error:backend==='mimo'?'未配置 MiMo 凭据，未调用云端媒体模型。':'未配置 MiniMax 凭据，未调用云端语音识别。' };
    const timer = new AbortController(), budget = setTimeout(()=>timer.abort(new Error('媒体任务超过时间预算。')),this.limits.processTimeoutMs+this.limits.apiTimeoutMs);
    const combined = signal ? AbortSignal.any([signal,timer.signal]) : timer.signal;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(),'douyin-media-'));
    try {
      const prepared = await this.prepare(args,kind,runtime,directory,combined);
      let output;
      const currentSettings=await this.settings();
      if(!currentSettings.enabled)return{ok:false,status:'disabled',backend,kind,error:'准备媒体期间用户关闭了能力，未交给模型。'};
      if(currentSettings.backend!==backend)return{ok:false,status:'backend-not-selected',backend:currentSettings.backend,kind,error:'准备媒体期间用户切换了后端，本次任务未交给模型。'};
      if (backend==='local-whisper' && config.DOUYIN_MEDIA_WHISPER_URL) {
        const endpoint = new URL(config.DOUYIN_MEDIA_WHISPER_URL);
        if (endpoint.protocol!=='http:' || endpoint.hostname!=='127.0.0.1') throw new Error('本地 Whisper 服务必须在 127.0.0.1 HTTP 上。');
        const bytes = await fs.readFile(prepared.path);
        // 直接复用 dsh-voice 的 WAV、自动语言及禁止翻译的 provider。
        output = await makeProviders({resolveKey:async()=>'',fetchImpl:this.fetch,cfg:{whisperUrl:endpoint.href}}, {bytes,mime:'audio/wav',lang:args.language||'auto',signal:combined})['local-whisper']();
        if (!output.ok) throw new Error('本地 Whisper 服务未返回有效转写。');
      } else if (backend==='local-whisper') {
        output = JSON.parse(await run(runtime.python,[path.join(ROOT,'local_whisper.py')],{input:{path:prepared.path,language:args.language||'auto',model:config.DOUYIN_MEDIA_WHISPER_MODEL||'tiny',modelsDir:runtime.modelsDir},signal:combined,timeoutMs:this.limits.processTimeoutMs,maxOutputBytes:200_000}));
        if (!output.text?.trim()) throw new Error('Whisper 未识别到可用对白；没有把静音当成内容。');
      } else if (backend==='mimo') {
        const requestKind = kind==='video'?'video':kind==='transcription'?'asr':'audio';
        const body = JSON.parse(await run(runtime.python,[path.join(ROOT,'mimo_bridge.py')],{input:{kind:requestKind,model:kind==='video'?(config.DOUYIN_MEDIA_MIMO_VIDEO_MODEL||'mimo-v2.5'):kind==='transcription'?'mimo-v2.5-asr':(config.DOUYIN_MEDIA_MIMO_AUDIO_MODEL||'mimo-v2.6'),files:[{kind:kind==='video'?'video':'audio',mime:kind==='video'?'video/mp4':'audio/wav',path:prepared.path}],prompt:kind==='transcription'?'':args.question||'请说明这段媒体中实际可观察到的内容，并明确不确定之处。',language:args.language,fps:args.fps??1},signal:combined,timeoutMs:30_000,maxOutputBytes:this.limits.maxBytes*2}));
        body.max_tokens=1024;
        const response = await this.fetch('https://api.xiaomimimo.com/v1/chat/completions',{method:'POST',redirect:'error',signal:AbortSignal.any([combined,AbortSignal.timeout(this.limits.apiTimeoutMs)]),headers:{'api-key':config.XIAOMI_API_KEY,'content-type':'application/json'},body:JSON.stringify(body)});
        if (!response.ok) throw new Error(`MiMo 媒体请求失败（HTTP ${response.status}）。`);
        const data = await response.json(), choice = data.choices?.[0];
        if (choice?.finish_reason!=='stop'||choice.message?.tool_calls?.length||typeof choice.message?.content!=='string'||!choice.message.content.trim()) throw new Error('MiMo 没有返回完整媒体答复。');
        output = { text:choice.message.content,usage:data.usage??null };
      } else {
        // 移植固定版 dsh-minimax-asr 的 multipart 参数和 JSON 结果合同，不加载旧 DSH 插件。
        const form = new FormData(); form.set('model','asr-1.0');form.set('response_format','verbose_json');form.set('timestamp_level','sentence');form.set('stream','false');form.set('file',new Blob([await fs.readFile(prepared.path)],{type:'audio/wav'}),'sample.wav');
        const response = await this.fetch('https://api.minimaxi.com/v1/speech_to_text',{method:'POST',redirect:'error',signal:AbortSignal.any([combined,AbortSignal.timeout(this.limits.apiTimeoutMs)]),headers:{authorization:`Bearer ${config.MINIMAX_API_KEY}`,...(args.language&&args.language!=='auto'?{language:args.language}:{})},body:form});
        if (!response.ok) throw new Error(`MiniMax 转写失败（HTTP ${response.status}）。`);
        const data = await response.json(); if (data.error!==undefined || data.base_resp?.status_code || !data.text?.trim()) throw new Error('MiniMax 没有返回有效转写。');
        output = { text:data.text,segments:Array.isArray(data.segments)?data.segments.map(item=>({start:Number(item.start??0),end:Number(item.end??0),text:String(item.text??''),...(typeof item.speaker==='string'?{speaker:item.speaker}:{})})):[],duration:data.duration??null };
      }
      combined.throwIfAborted();
      return { ok:true,backend,kind,text:safeText(output.text,config),...(output.segments?{segments:output.segments.filter(item=>Number.isFinite(item.start)&&Number.isFinite(item.end)&&item.start>=0&&item.end>=item.start).map(item=>({relativeStart:item.start,relativeEnd:item.end,start:prepared.interval.startSeconds+item.start,end:prepared.interval.startSeconds+item.end,text:safeText(item.text,config),...(typeof item.speaker==='string'?{speaker:safeText(item.speaker,config)}:{})}))}:{}),source:prepared.descriptor,interval:prepared.interval,language:output.language||args.language?safeText(output.language||args.language,config).slice(0,32):null,usage:safeUsage(output.usage),limitations:[...(prepared.clipped?['仅处理所标明的时间片段，没有分析完整媒体。']:[]),...(prepared.unknownSourceDuration?['录制文件未提供总时长；返回的是有界转码后实测的音频时长。']:[]),kind==='transcription'?'结果是语音转写，不能证明已理解音乐或环境声。':'结果来自所选媒体模型；未另行确认每种声音的识别准确性。',...(kind==='video'?['视频模型是否完整理解音轨尚未独立验收，需要对白时应另做语音转写。']:[])] };
    } catch(error) { if (combined.aborted) throw combined.reason; return {ok:false,status:'failed',backend,kind,error:safeText(error.message,config)}; }
    finally { clearTimeout(budget); await cleanTemporary(directory); }
  }
}

export default MediaAdapter;
