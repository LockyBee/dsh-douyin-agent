import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BrowserController} from '../core.mjs';

test('观察返回有界采样编号，查看原格走真实执行分派并拒绝换片及私信遮挡',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-board-core-'));
  const controller=new BrowserController({source:'verification',controlDirectory:directory});controller.limitsEnabled=false;
  controller.page={url:()=> 'https://www.douyin.com/video/1234567890123456789'};
  controller.connect=async()=>controller.page;controller.watchVideoLimits=()=>{};controller.checkVideoLimits=async()=>{};
  let state={video:{id:'1234567890123456789',paused:false,readyState:4},privateChatVisible:false};
  const frames=[1,2,3].map(time=>({mimeType:'image/png',data:'eA==',videoId:state.video.id,time}));
  controller.capture=async()=>({state,frames});controller.state=async()=>state;
  t.after(async()=>{await controller.close();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(directory,{recursive:true,force:true});});
  const sampled=await controller.execute('douyin_observe',{seconds:3});assert.match(sampled.storyboardSampleId,/^[a-f0-9-]{36}$/);
  const args={sampleId:sampled.storyboardSampleId,cell:2,videoId:state.video.id};
  const zoom=await controller.execute('douyin_video_zoom',args);assert.equal(zoom.frames.length,1);assert.equal(zoom.frames[0].time,2);assert.equal(zoom.observation.sourceSampleId,args.sampleId);
  state={...state,privateChatVisible:true};await assert.rejects(controller.execute('douyin_video_zoom',args),/页面|作品/);
  state={video:{id:'999'},privateChatVisible:false};await assert.rejects(controller.execute('douyin_video_zoom',args),/页面|作品/);
  controller.storyboardFrames.clear();assert.equal(controller.storyboardFrames.sample,null);
});
