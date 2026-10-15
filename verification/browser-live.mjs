import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { BrowserController } from '../core.mjs';

const controller=new BrowserController({source:'verification'});
const receipt={startedAt:new Date().toISOString(),checks:[],passed:false};
function check(name,value){receipt.checks.push({name,...value});console.log(name);}
try {
  const opened=await controller.execute('douyin_open');
  assert.ok(opened.video?.id);assert.equal(opened.loginRequired,false);
  check('推荐页已读到实际作品',{id:opened.video.id,readyState:opened.video.readyState});
  const playing=await controller.execute('douyin_play');
  await wait(1200);
  const later=await controller.execute('douyin_status');
  assert.equal(later.video.id,playing.video.id);assert.equal(later.video.paused,false);
  assert.ok(Math.abs(later.video.time-playing.video.time)>0.5);
  check('实际播放时间推进',{id:later.video.id,before:playing.video.time,after:later.video.time,paused:later.video.paused});
  const next=await controller.execute('douyin_next');assert.equal(next.changed,true);
  check('下一条作品改变',{before:next.before.id,after:next.after.id,changed:next.changed});
  const previous=await controller.execute('douyin_previous');assert.equal(previous.changed,true);assert.equal(previous.after.id,next.before.id);
  check('上一条返回原作品',{before:previous.before.id,after:previous.after.id,changed:previous.changed});
  const paused=await controller.execute('douyin_pause');assert.equal(paused.video.paused,true);
  await wait(650);const still=await controller.execute('douyin_status');assert.equal(still.video.paused,true);assert.ok(Math.abs(still.video.time-paused.video.time)<0.1);
  check('暂停后播放时间停止',{before:paused.video.time,after:still.video.time});
  const search=await controller.execute('douyin_search',{query:'猫咪'});assert.ok(search.searchResults.length>0);
  check('猫咪搜索读到真实结果',{count:search.searchResults.length,first:search.searchResults[0]});
  const result=await controller.execute('douyin_open_video',{index:0});assert.equal(result.video?.id,search.searchResults[0].id);
  check('打开第一条搜索作品',{id:result.video.id,author:result.video.author,title:result.video.title});
  await controller.execute('douyin_play');
  const observed=await controller.execute('douyin_observe',{seconds:3});assert.equal(observed.frames.length,3);
  const hashes=observed.frames.map(frame=>createHash('sha256').update(Buffer.from(frame.data,'base64')).digest('hex'));
  assert.ok(new Set(hashes).size>1);assert.ok(Math.abs(observed.observation.afterTime-observed.observation.beforeTime)>1);
  writeFileSync(new URL('./current-video.jpg',import.meta.url),Buffer.from(observed.frames[1].data,'base64'));
  check('观察采集不同视频帧',{videoId:observed.state.video.id,frameCount:observed.frames.length,hashes,...observed.observation});
  await controller.execute('douyin_pause');
  receipt.passed=true;
}catch(error){receipt.failure={name:error.name,message:error.message};throw error;}
finally{
  receipt.finishedAt=new Date().toISOString();
  writeFileSync(new URL('./browser-live.json',import.meta.url),JSON.stringify(receipt,null,2));
  await controller.close();
}
