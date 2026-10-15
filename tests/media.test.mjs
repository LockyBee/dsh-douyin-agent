import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { MediaAdapter,loadMediaConfig,validatePublicMediaUrl } from '../media/index.mjs';

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'douyin-media-test-'));
  t.after(async()=>{const target=path.resolve(directory);if(!target.startsWith(path.resolve(os.tmpdir())+path.sep))throw new Error('测试清理目录越界。');await fs.rm(target,{recursive:true,force:true});});
  const data=Buffer.alloc(44+16000*2*2);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(16000,24);data.writeUInt32LE(32000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(data.length-44,40);
  for(let i=0;i<32000;i++)data.writeInt16LE(Math.round(3000*Math.sin(2*Math.PI*220*i/16000)),44+i*2);
  const source=path.join(directory,'synthetic-tone.wav');await fs.writeFile(source,data);return{directory,source};
}
const response = value => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
async function enabled(t,{selectedBackend='local-whisper',...options}={}){const {directory}=await fixture(t);const adapter=new MediaAdapter({...options,settingsFile:path.join(directory,'settings.json')});await adapter.saveSettings({enabled:true,backend:selectedBackend},{explicit:true});return adapter;}
async function ffmpeg(args){await new Promise((resolve,reject)=>{const child=spawn('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-y',...args],{windowsHide:true,shell:false,stdio:'ignore'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('合成媒体生成失败')));});}

test('媒体用户设置：默认关闭，模型不能启用，用户无需密钥也能关闭',async t=>{
  const{directory}=await fixture(t);const adapter=new MediaAdapter({config:{},settingsFile:path.join(directory,'settings.json')});
  assert.equal((await adapter.status()).enabled,false);assert.equal((await adapter.transcribeAudio({source:'不应读取'})).status,'disabled');await assert.rejects(adapter.setEnabled(true),/用户/);
  await adapter.saveSettings({enabled:true,backend:'local-whisper'},{explicit:true});assert.equal((await adapter.status()).enabled,true);await adapter.setEnabled(false,{explicit:true});assert.equal((await adapter.status()).enabled,false);
});

test('媒体用户设置：同一实例并发保存开关与后端不会丢失设置或留下临时文件',async t=>{
  const{directory}=await fixture(t),adapter=new MediaAdapter({config:{},settingsFile:path.join(directory,'settings.json')});
  await Promise.all([adapter.saveSettings({enabled:true},{explicit:true}),adapter.saveSettings({backend:'mimo'},{explicit:true})]);
  assert.deepEqual(await adapter.settings(),{enabled:true,backend:'mimo'});assert.equal((await fs.readdir(directory)).some(name=>name.endsWith('.tmp')),false);
});

test('媒体合成测试：缺少云凭据返回 unavailable，不下载媒体或发 API 请求',async t=>{
  let requests=0;const adapter=await enabled(t,{config:{},fetchImpl:async()=>{requests++;throw new Error('不应请求');}});
  for(const backend of ['mimo','minimax']){await adapter.saveSettings({backend},{explicit:true});const result=await adapter.transcribeAudio({source:'https://example.com/public.wav',backend});assert.equal(result.status,'unavailable');assert.equal(result.ok,false);}
  assert.equal(requests,0);
});

test('媒体用户设置：选择本地时模型不能改为云后端上传，即使进程有云凭据',async t=>{
  let requests=0;const adapter=await enabled(t,{config:{XIAOMI_API_KEY:'synthetic-secret',MINIMAX_API_KEY:'synthetic-secret'},fetchImpl:async()=>{requests++;throw new Error('不应请求');}});
  for(const backend of ['mimo','minimax'])assert.equal((await adapter.transcribeAudio({source:'不应读取',backend})).status,'backend-not-selected');
  assert.equal((await adapter.status()).backend,'local-whisper');assert.equal(requests,0);
});

test('媒体合成测试：专用配置只选允许字段，状态不返回密钥或配置URL',async t=>{
  const {directory}=await fixture(t),envFile=path.join(directory,'.env');await fs.writeFile(envFile,'XIAOMI_API_KEY=file-secret\nMINIMAX_API_KEY=other-secret\nQQ_TOKEN=not-load\nDOUYIN_MEDIA_WHISPER_URL=http://127.0.0.1:9999/inference');
  const config=await loadMediaConfig({envFile,env:{XIAOMI_API_KEY:'process-secret'}});assert.equal(config.XIAOMI_API_KEY,'process-secret');assert.equal(Object.hasOwn(config,'QQ_TOKEN'),false);
  const state=JSON.stringify(await new MediaAdapter({config}).status());for(const value of ['file-secret','other-secret','process-secret','9999','QQ_TOKEN'])assert.equal(state.includes(value),false);
});

test('媒体合成测试：拒绝私网、认证、签名及HTTP媒体URL，不回显私有地址',async()=>{
  for(const source of ['http://example.com/a.wav','https://127.0.0.1/a.wav','https://user:password@example.com/a.wav','https://example.com/a.wav?token=private','https://example.com/a.wav?X-Amz-Signature=private'])await assert.rejects(validatePublicMediaUrl(source),error=>!error.message.includes('private')&&!error.message.includes('password'));
});

test('媒体合成测试：真实ffmpeg提取指定音轨片段，MiMo driver构造音频请求；云响应为替身',async t=>{
  const {source}=await fixture(t);let request;
  const adapter=await enabled(t,{selectedBackend:'mimo',config:{XIAOMI_API_KEY:'synthetic-mimo-secret'},fetchImpl:async(url,options)=>{request={url,options,body:JSON.parse(options.body)};return response({choices:[{finish_reason:'stop',message:{content:'合成云模型结果'}}],usage:{prompt_tokens:1,unexpected:'synthetic-mimo-secret',total_tokens:'synthetic-mimo-secret'}});}});
  const result=await adapter.analyzeAudio({source,backend:'mimo',question:'合成问题：这是哪些声音？',startSeconds:0.5,durationSeconds:1});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.backend,'mimo');assert.equal(result.interval.startSeconds,0.5);assert.equal(result.interval.durationSeconds,1);
  assert.equal(request.options.headers['api-key'],'synthetic-mimo-secret');assert.equal(request.options.redirect,'error');assert.ok(request.body.messages[0].content.some(item=>item.type==='input_audio'));assert.ok(request.body.messages[0].content.some(item=>item.text==='合成问题：这是哪些声音？'));
  assert.equal(JSON.stringify(result).includes('synthetic-mimo-secret'),false);assert.ok(result.limitations.some(item=>item.includes('时间片段')));
});

test('媒体合成测试：MiniMax沿用multipart和语言合同，拒绝200错误正文；云响应为替身',async t=>{
  const {source}=await fixture(t);let request;
  const adapter=await enabled(t,{selectedBackend:'minimax',config:{MINIMAX_API_KEY:'synthetic-minimax-secret'},fetchImpl:async(_url,options)=>{request=options;return response({text:'合成转写',duration:1,segments:[{start:0,end:1,text:'合成转写',speaker:'speaker-0'}]});}});
  const result=await adapter.transcribeAudio({source,backend:'minimax',language:'zh',durationSeconds:1});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(request.headers.language,'zh');assert.equal(request.body.get('model'),'asr-1.0');assert.equal(request.body.get('response_format'),'verbose_json');assert.equal(request.body.get('file').type,'audio/wav');assert.equal(result.segments[0].speaker,'speaker-0');
  const bad=await enabled(t,{selectedBackend:'minimax',config:{MINIMAX_API_KEY:'synthetic-minimax-secret'},fetchImpl:async()=>response({error:'synthetic-minimax-secret',text:'不能采信'})});assert.equal((await bad.transcribeAudio({source,backend:'minimax'})).ok,false);
});

test('媒体合成测试：真实ffmpeg处理视频片段，固定MiMo driver产生video_url；云响应为替身',async t=>{
  const{source,directory}=await fixture(t),video=path.join(directory,'synthetic-video.mp4');
  await new Promise((resolve,reject)=>{const child=spawn('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=160x120:r=12','-i',source,'-t','1','-c:v','libx264','-c:a','aac',video],{windowsHide:true,shell:false,stdio:'ignore'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('合成视频生成失败')));});
  let body;const adapter=await enabled(t,{selectedBackend:'mimo',config:{XIAOMI_API_KEY:'synthetic-key'},fetchImpl:async(_url,options)=>{body=JSON.parse(options.body);return response({choices:[{finish_reason:'stop',message:{content:'合成视频答复'}}]});}});
  const result=await adapter.analyzeVideo({source:video,backend:'mimo',question:'合成画面问题',durationSeconds:0.6});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.interval.durationSeconds,0.6);
  const part=body.messages[0].content.find(item=>item.type==='video_url');assert.ok(part.video_url.url.startsWith('data:video/mp4;base64,'));assert.equal(part.fps,1);assert.equal(body.max_tokens,1024);assert.ok(result.limitations.some(item=>item.includes('音轨')));
});

test('媒体合成测试：直接复用dsh-voice本地provider，auto语言与禁止翻译传给Whisper；HTTP响应为替身',async t=>{
  const {source}=await fixture(t);let request;
  const adapter=await enabled(t,{config:{DOUYIN_MEDIA_WHISPER_URL:'http://127.0.0.1:8001/inference'},fetchImpl:async(_url,options)=>{request=options;return response({text:'合成本地服务回复'});}});
  const result=await adapter.transcribeAudio({source,backend:'local-whisper'});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(request.body.get('language'),'auto');assert.equal(request.body.get('translate'),'false');assert.equal(request.body.get('response_format'),'json');
});

test('媒体合成测试：超预算、截断模型响应及预先停止均不报告成功',async t=>{
  const {source}=await fixture(t);const adapter=await enabled(t,{selectedBackend:'mimo',config:{XIAOMI_API_KEY:'synthetic-key'},fetchImpl:async()=>response({choices:[{finish_reason:'length',message:{content:'未完成'}}]})});
  assert.equal((await adapter.analyzeAudio({source,backend:'mimo',durationSeconds:121})).ok,false);assert.equal((await adapter.analyzeAudio({source,backend:'mimo'})).ok,false);
  const abort=new AbortController();abort.abort(new Error('合成停止'));await assert.rejects(adapter.analyzeAudio({source},{signal:abort.signal}),/合成停止/);
});

test('媒体合成测试：无容器duration的本地WebM有界转码，再读取WAV实测时长；HTTP响应为替身',async t=>{
  const{source,directory}=await fixture(t),webm=path.join(directory,'synthetic-recording.webm');
  await ffmpeg(['-i',source,'-c:a','libopus','-live','1',webm]);
  const probe=await new Promise((resolve,reject)=>{let text='';const child=spawn('ffprobe',['-v','error','-show_entries','format=duration','-of','json',webm],{windowsHide:true,shell:false,stdio:['ignore','pipe','ignore']});child.stdout.on('data',chunk=>text+=chunk);child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(text)):reject(new Error('合成WebM核对失败')));});
  assert.equal(Number.isFinite(Number(probe.format?.duration)),false,'合成流式WebM须确实没有容器duration');
  const adapter=await enabled(t,{config:{DOUYIN_MEDIA_WHISPER_URL:'http://127.0.0.1:8001/inference'},fetchImpl:async()=>response({text:'合成转写'})});
  const result=await adapter.transcribeAudio({source:webm,startSeconds:0.25,durationSeconds:0.5});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.interval.sourceDurationSeconds,null);assert.equal(result.interval.durationVerifiedBy,'ffprobe-output');assert.ok(result.interval.durationSeconds>0&&result.interval.durationSeconds<=0.5);assert.equal(result.interval.startSeconds,0.25);
  const pastEnd=await adapter.transcribeAudio({source:webm,startSeconds:9,durationSeconds:1});assert.equal(pastEnd.ok,false);
});

test('媒体来源测试：vendor内容仍与固定commit的SHA256记录一致',async()=>{
  const root=new URL('../media/',import.meta.url);const records=JSON.parse(await fs.readFile(new URL('PROVENANCE.json',root),'utf8'));
  for(const record of records){assert.match(record.commit,/^[a-f0-9]{40}$/);assert.equal(createHash('sha256').update(await fs.readFile(new URL(record.localPath,root))).digest('hex'),record.sha256);}
});

test('真实本地ASR：Windows SAPI合成语音由Whisper识别，未调用云API',{skip:process.env.RUN_REAL_MEDIA_ASR!=='1'},async t=>{
  const source=fileURLToPath(new URL('../media/verification/synthetic.wav',import.meta.url));const adapter=await enabled(t,{config:{DOUYIN_MEDIA_WHISPER_MODEL:'tiny'},fetchImpl:async()=>{throw new Error('真实本地验收不允许云请求');}});
  const result=await adapter.transcribeAudio({source,backend:'local-whisper',language:'en'});assert.equal(result.ok,true,JSON.stringify(result));assert.match(result.text,/orange cat/i);assert.match(result.text,/blue window/i);
});

test('真实本地ASR：无容器duration的合成WebM由Whisper识别，返回实测音轨时长',{skip:process.env.RUN_REAL_MEDIA_ASR!=='1'},async t=>{
  const source=fileURLToPath(new URL('../media/verification/synthetic.wav',import.meta.url)),{directory}=await fixture(t),webm=path.join(directory,'synthetic-speech.webm');await ffmpeg(['-i',source,'-c:a','libopus','-live','1',webm]);
  const adapter=await enabled(t,{config:{DOUYIN_MEDIA_WHISPER_MODEL:'tiny'},fetchImpl:async()=>{throw new Error('真实本地验收不允许云请求');}});
  const result=await adapter.transcribeAudio({source:webm,language:'en',durationSeconds:10});assert.equal(result.ok,true,JSON.stringify(result));assert.match(result.text,/orange cat/i);assert.match(result.text,/blue window/i);assert.equal(result.interval.sourceDurationSeconds,null);assert.equal(result.interval.durationVerifiedBy,'ffprobe-output');assert.ok(result.interval.durationSeconds>6&&result.interval.durationSeconds<7);
});

test('真实公开HTTPS下载：已有网络代理下提取Whisper上游公开样本；转写服务响应为替身',{skip:process.env.RUN_REAL_MEDIA_URL!=='1'},async t=>{
  const adapter=await enabled(t,{config:{DOUYIN_MEDIA_WHISPER_URL:'http://127.0.0.1:8001/inference'},fetchImpl:async()=>response({text:'公开下载提取核对；服务响应为替身'})});
  const result=await adapter.transcribeAudio({source:'https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/samples/jfk.wav',durationSeconds:0.5});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.source.type,'public-url');assert.equal(result.interval.durationSeconds,0.5);assert.equal(result.interval.durationVerifiedBy,'ffprobe-output');
});
