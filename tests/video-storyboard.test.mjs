import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {prepareVideoFrames,jpegDimensions,StoryboardFrameStore} from '../video-storyboard.mjs';
import jpeg from '../storyboard/vendor/jpeg-js/index.js';
import {ApiAgent} from '../api-agent.mjs';
import {ChatAgent} from '../chat-agent.mjs';
import {PublicCommentAgent} from '../public-comment-agent.mjs';
import {createNativeToolDefinitions} from '../dsh-plugin.mjs';
import {TOOL_DEFINITIONS,validateToolArguments} from '../tool-definitions.mjs';

const ID='1234567890123456789';
const frames=[0,1,2].map(index=>{
  const width=320,height=560,data=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const p=(y*width+x)*4;data[p]=index===0?220:25;data[p+1]=index===1?220:25;data[p+2]=index===2?220:25;
    if(x>70&&x<250&&y>200&&y<360)data[p]=data[p+1]=data[p+2]=230;data[p+3]=255;
  }
  return{mimeType:'image/jpeg',data:jpeg.encode({width,height,data},80).data.toString('base64'),time:index*1.5,videoId:ID};
});
const state=()=>({video:{id:ID,time:3,duration:30,paused:false,readyState:4},loginRequired:false,verificationRequired:false,privateChatVisible:false});
const observation=()=>({state:state(),frames:structuredClone(frames),observation:{videoId:ID,beforeTime:0,afterTime:3}});
const decision=()=>({action:'stop',reason:'合成采样已足够。',topics:[],reflection:'仅依据这些画面。'});
const images=messages=>messages.flatMap(x=>Array.isArray(x.content)?x.content.filter(x=>x.type==='image_url'):[]);

test('同作品三帧组成真实JPEG一张，时间索引与像素统计准确，源帧不变',()=>{
  const before=structuredClone(frames),result=prepareVideoFrames(frames);
  assert.equal(result.manifest.status,'storyboard');assert.equal(result.frames.length,1);
  assert.equal(result.manifest.inputImages,3);assert.equal(result.manifest.outputImages,1);
  assert.deepEqual(result.manifest.cells.map(x=>x.time),[0,1.5,3]);assert.ok(result.manifest.outputPixels<result.manifest.inputPixels);
  assert.ok(result.manifest.outputPixels<=480000);assert.deepEqual(frames,before);
  const decoded=jpeg.decode(Buffer.from(result.frames[0].data,'base64'));
  assert.equal(decoded.width,result.manifest.width);assert.equal(decoded.height,result.manifest.height);
  assert.deepEqual(jpegDimensions(Buffer.from(result.frames[0].data,'base64')),{width:decoded.width,height:decoded.height});
  assert.match(result.summary,/第1格.*0\.000秒/);assert.match(result.summary,/没有增加音轨证据/);
  for(const cell of result.manifest.cells){
    const x=4+(cell.col-1)*(Math.floor((decoded.width-4*(result.manifest.cols+1))/result.manifest.cols)+4)+20;
    const y=4+(cell.row-1)*(Math.floor((decoded.height-4*(result.manifest.rows+1))/result.manifest.rows)+4)+100;
    const p=(Math.floor(y)*decoded.width+Math.floor(x))*4,channel=cell.cell-1;
    assert.ok(decoded.data[p+channel]>150,'对应格保留原帧颜色');
  }
});

test('单图、跨作品、缺时间、非JPEG、损坏和巨大尺寸保持原图路径，不伪造分镜',()=>{
  for(const list of [[frames[0]],[frames[0],{...frames[1],videoId:'999'}],[frames[0],{...frames[1],time:null}],[frames[0],{...frames[1],mimeType:'image/png'}],[frames[0],{...frames[1],data:'AAAA'}]]){
    const result=prepareVideoFrames(list);assert.equal(result.manifest.status,'original');assert.equal(result.frames,list);
  }
  const bomb=Buffer.from([255,216,255,192,0,17,8,255,255,255,255,3,1,1,0,2,1,0,3,1,0,255,217]);
  assert.throws(()=>jpegDimensions(bomb),/超限/);
  assert.equal(prepareVideoFrames([frames[0],{...frames[1],data:bomb.toString('base64')}]).manifest.status,'original');
  const aborted=new AbortController();aborted.abort(Error('合成取消'));assert.throws(()=>prepareVideoFrames(frames,{signal:aborted.signal}),/合成取消/);
});

test('原格缓存只属于本实例同作品有效采样，换片、到期、clear及无效格均拒绝',()=>{
  let now=100;const store=new StoryboardFrameStore({now:()=>now});
  const sampleId=store.remember(observation());
  assert.equal(store.zoom({sampleId,cell:2,videoId:ID}).frames[0].data,frames[1].data);
  assert.throws(()=>store.zoom({sampleId,cell:0,videoId:ID}));assert.throws(()=>store.zoom({sampleId,cell:1,videoId:'999'}));
  assert.throws(()=>new StoryboardFrameStore().zoom({sampleId,cell:1,videoId:ID}));
  now+=60001;assert.throws(()=>store.zoom({sampleId,cell:1,videoId:ID}),/过期/);store.clear();
  assert.equal(store.remember({...observation(),state:{...state(),privateChatVisible:true}}),null);
});

test('观看决策及公开评论实际构造的模型请求各只带一张分镜，不夹入人格到公开评论',async()=>{
  let request;const agent=new ApiAgent({controller:{execute(){}},config:{apiKey:'fixture-key'}});
  await agent.decideWatch({observation:observation(),context:'合成人格标记',decisionProvider:async value=>{request=value;return{text:JSON.stringify(decision())};}});
  assert.equal(images(request.messages).length,1);assert.equal(agent.lastVisualPacking.outputImages,1);
  assert.match(JSON.stringify(request.messages),/第2格/);
  const comments=new PublicCommentAgent();await comments.generate({observation:observation(),decisionProvider:async value=>{request=value;return{text:JSON.stringify({text:null})};}});
  assert.equal(images(request.messages).length,1);assert.doesNotMatch(JSON.stringify(request.messages),/合成人格标记/);
});

test('分享视频回复将三帧压为一张，保留媒体证据说明；普通照片仍原图',async()=>{
  let request;const agent=new ChatAgent({config:{apiKey:''},replyProvider:async value=>{request=value;return{text:'这几帧的颜色不一样。'};}});
  const message={id:'incoming-fixture',sender:'incoming',text:'看下这个视频',media:{type:'shared-work'}};
  const media={messageId:message.id,media:{type:'shared-work'},sharedWork:{videoId:ID,observation:{actualWallSeconds:3,requestedSeconds:3}},understandingScope:'card-cover-and-timed-video-sampling',frames:structuredClone(frames)};
  await agent.reply({messages:[message],mediaObservations:[media]});assert.equal(images(request.messages).length,1);assert.equal(agent.lastVisualPacking.status,'storyboard');
  const photo={...frames[0],videoId:undefined,time:undefined};
  await agent.reply({messages:[{...message,media:{type:'image'}}],mediaObservations:[{messageId:message.id,media:{type:'image'},frames:[photo]}]});
  assert.equal(images(request.messages)[0].image_url.url,`data:image/jpeg;base64,${photo.data}`);
});

test('原生工具把实际分镜图片交给附件服务，保护画面不入模型，新格查看参数有界',async()=>{
  const saved=[];const services={attachments:{saveImages:async items=>{saved.push(...items);return items.map((_,index)=>({attachmentId:'fixture-'+index}));}},llm:{resolveModelInfo:async()=>({inputModalities:['image']})}};
  const controller={execute:async()=>observation()};const tools=createNativeToolDefinitions({ctx:{get:name=>services[name]},getController:async()=>controller});
  const tool=tools.find(x=>x.name==='douyin_observe');
  const result=await tool.execute({seconds:3},{agent:{options:{provider:'fixture',model:'fixture'}},signal:new AbortController().signal});
  assert.equal(saved.length,1);assert.equal(result.images.length,1);assert.equal(result.result.storyboard.inputImages,3);assert.doesNotMatch(JSON.stringify(result.result),/base64|"data":/);
  controller.execute=async()=>({...observation(),state:{...state(),verificationRequired:true}});const blocked=await tool.execute({seconds:3},{});assert.equal(blocked.images.length,0);
  const zoom=TOOL_DEFINITIONS.find(x=>x.name==='douyin_video_zoom');assert.doesNotThrow(()=>validateToolArguments(zoom,{sampleId:'a'.repeat(8)+'-aaaa-aaaa-aaaa-'+'a'.repeat(12),cell:2,videoId:ID}));
  assert.throws(()=>validateToolArguments(zoom,{sampleId:'x',cell:17,videoId:ID}));
});

test('源码与桌面运行包都包含分镜适配、上游许可、JPEG许可及来源记录',()=>{
  const pkg=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  for(const file of ['video-storyboard.mjs','storyboard/PROVENANCE.json','storyboard/vendor/sheet.mjs','storyboard/vendor/plan.mjs','storyboard/vendor/LICENSE','storyboard/vendor/NOTICE','storyboard/vendor/jpeg-js/index.js','storyboard/vendor/jpeg-js/lib/encoder.js','storyboard/vendor/jpeg-js/lib/decoder.js','storyboard/vendor/jpeg-js/LICENSE','storyboard/vendor/jpeg-js/LICENSE-APACHE-2.0.txt'])assert.ok(pkg.files.includes(file),file);
  const stage=fs.readFileSync(new URL('../desktop/scripts/stage-api-runtime.mjs',import.meta.url),'utf8');
  assert.match(stage,/STORYBOARD_FILES/);assert.match(stage,/LICENSE-APACHE-2\.0\.txt/);
  const provenance=JSON.parse(fs.readFileSync(new URL('../storyboard/PROVENANCE.json',import.meta.url),'utf8'));
  assert.equal(provenance.upstream.commit,'2ba682d471a0e63defdb5e8e023465ab59806b05');assert.equal(provenance.codec.version,'0.4.4');
});
