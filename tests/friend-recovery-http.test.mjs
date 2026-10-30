import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApiServer } from '../app.mjs';
import { VideoLimits } from '../video-limits.mjs';

test('运行中的好友服务可通过HTTP解除暂停并自动恢复，状态栏按实际就绪变在线',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-friend-recovery-http-')),calls=[];
  let running=true,paused=true,shareEnabled=false;
  const chat={
    state:()=>({running,starting:false,busy:false,worker:running?{pid:process.pid,runId:'synthetic-recovery',alive:true,status:'running',heartbeatAt:new Date().toISOString()}:null,policy:{allowlist:[{id:'synthetic-selected'}]},contacts:[{id:'synthetic-selected',status:paused?'paused':'ready',lastCheckedAt:new Date().toISOString()}],recovery:{pendingManualCount:0,recoverableCount:0}}),
    stop:options=>{calls.push(['stop',options]);running=false;},
    configure:()=>assert.fail('解除暂停不重写许可名单'),
    resumeContact:id=>{assert.equal(running,false);assert.equal(id,'synthetic-selected');paused=false;calls.push(['resume',id]);return chat.state();},
    start:async()=>{running=true;calls.push(['start']);return chat.state();},close:async()=>{running=false;},
  };
  const share={state:()=>({enabled:shareEnabled}),configure:({enabled})=>{shareEnabled=enabled;},close:async()=>{}};
  const limits=new VideoLimits({stateDir:root});
  fs.writeFileSync(path.join(root,'friend-interactions-policy.json'),JSON.stringify({version:1,enabled:true}));
  const server=createApiServer({controller:{close:async()=>{}},config:{apiKey:'synthetic-recovery-key',model:'synthetic'},agent:{runTask:async()=>assert.fail('HTTP验收不调用模型')},chatService:chat,shareService:share,videoLimits:limits,pauseVideoSources:async()=>{},port:0});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await server.stop();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`,boot=await(await fetch(origin+'/api/bootstrap')).json();
  const request=async(route,body)=>{const response=await fetch(origin+route,{headers:{'x-session-token':boot.token,...(body?{'content-type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return{status:response.status,value:await response.json()};};
  assert.equal((await request('/api/interactions/state')).value.presence.online,false);
  assert.equal((await request('/api/chat/resolve',{recipientId:'synthetic-selected',enabled:true})).status,400);
  assert.equal((await request('/api/chat/resolve',{recipientId:'other'})).status,403);assert.equal(calls.length,0);
  const resolved=await request('/api/chat/resolve',{recipientId:'synthetic-selected'});assert.equal(resolved.status,200);
  assert.deepEqual(calls,[['stop',{preservePending:true,reason:'settings-update'}],['resume','synthetic-selected'],['start']]);
  const state=await request('/api/interactions/state');assert.equal(state.value.policy.enabled,true);assert.equal(state.value.presence.online,true);assert.equal(state.value.presence.status,'online');
  assert.equal(state.value.presence.selectedCount,1);assert.equal(state.value.presence.readyCount,1);
});
