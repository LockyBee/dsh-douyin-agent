import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createNativeWatchDecision} from '../native-watch-decision.mjs';
import {WATCH_SYSTEM_PROMPT,watchDecisionMessages} from '../api-agent.mjs';
import {AutonomousWatch} from '../autonomous-watch.mjs';
import {PersonaMemory} from '../persona-memory.mjs';
import {VideoLimits} from '../video-limits.mjs';

const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGDkAAAAASUVORK5CYII=';
const ID='1234567890123456789';
const state=()=>({url:`https://www.douyin.com/video/${ID}`,loginRequired:false,verificationRequired:false,privateChatVisible:false,video:{id:ID,url:`https://www.douyin.com/video/${ID}`,title:'合成科普动画',author:'合成作者',time:3,duration:60,readyState:4,paused:false}});
const observation=()=>({state:state(),frames:[{mimeType:'image/png',data:PNG,time:3,videoId:ID}],observation:{videoId:ID,beforeTime:0,afterTime:3}});
const decision=()=>({action:'stop',reason:'已观察到合成动画，记录后结束。',topics:[{topic:'科普动画',signal:'like'}],reflection:'这次有限采样展示了清楚的图解。'});
function fixture(options={}) {
  const requests=[],saved=[];
  const llm={resolveModelInfo:async()=>({inputModalities:['text','image']}),async *stream(input){requests.push(input);yield {type:'text-delta',index:0,text:JSON.stringify(decision())};yield {type:'usage',usage:{inputTokens:10,outputTokens:20,totalTokens:30}};yield {type:'finish',reason:{kind:'stop'}};},...options};
  const agent={session:{id:'synthetic-native',requestHeader:()=>({config:{provider:'synthetic',model:'synthetic-vision'}})},options:{}};
  const attachments={saveImages:async images=>{saved.push(images);return[{attachmentId:'synthetic-ref',mediaType:'image/png',bytes:Buffer.from(PNG,'base64').length,width:1,height:1}];}};
  return{llm,agent,attachments,requests,saved,provider:createNativeWatchDecision({llm,agent,attachments})};
}
test('真实决策消息通过原生适配：核对system、转换附件、沿用当前模型路由与用量',async()=>{
  const f=fixture(),controller=new AbortController();
  const result=await f.provider({system:WATCH_SYSTEM_PROMPT,messages:watchDecisionMessages(observation(),{context:'合成人格'}),signal:controller.signal});
  assert.deepEqual(JSON.parse(result.text),decision());assert.equal(result.usage.total_tokens,30);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].provider,'synthetic');assert.equal(f.requests[0].model,'synthetic-vision');
  assert.equal(f.requests[0].system,WATCH_SYSTEM_PROMPT);assert.equal(f.requests[0].messages.length,1);assert.equal(f.requests[0].messages[0].content[1].attachment.attachmentId,'synthetic-ref');
  assert.equal(f.requests[0].tools,undefined);assert.equal(f.saved.length,1);assert.deepEqual(f.saved[0][0].data,Buffer.from(PNG,'base64'));
});
test('没有图像能力或system不一致时不发起原生模型生成',async()=>{
  const f=fixture({resolveModelInfo:async()=>({inputModalities:['text']})});
  await assert.rejects(f.provider({system:WATCH_SYSTEM_PROMPT,messages:watchDecisionMessages(observation())}),/画面/);assert.equal(f.requests.length,0);assert.equal(f.saved.length,0);
  const g=fixture();await assert.rejects(g.provider({system:WATCH_SYSTEM_PROMPT,messages:[{role:'system',content:'合成替换系统指令'}]}),/不一致/);assert.equal(g.requests.length,0);
});
test('原生失败或截断返回不当作成功决策，block-end正文也能完整返回',async()=>{
  for(const kind of ['error','max-tokens','aborted']){const f=fixture({async *stream(){yield{type:'text-delta',index:0,text:JSON.stringify(decision())};yield{type:'finish',reason:{kind}};}});await assert.rejects(f.provider({system:WATCH_SYSTEM_PROMPT,messages:watchDecisionMessages(observation())}),/未完整返回/);}
  const f=fixture({async *stream(){yield{type:'block-end',index:0,block:{type:'text',text:JSON.stringify(decision())}};yield{type:'finish',reason:{kind:'stop'}};}});
  assert.deepEqual(JSON.parse((await f.provider({system:WATCH_SYSTEM_PROMPT,messages:watchDecisionMessages(observation())})).text),decision());
});
test('原生自主循环把观察写入同一人格文件，停止前的有限画面不直接学成喜欢',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-watch-shared-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  const memoryDir=path.join(root,'memory'),personaMemory=new PersonaMemory({memoryDir}),videoLimits=new VideoLimits({stateDir:path.join(root,'state')});personaMemory.initialize();videoLimits.markSession('dsh',{explicit:true});
  const f=fixture();let paused=0;
  const controller={execute:async(name,_args,options)=>{assert.ok(options.autonomousRunId);return name==='douyin_observe'?observation():state();},pauseForLimits:async()=>{paused++;}};
  const watch=new AutonomousWatch({controller,config:{},videoLimits,personaMemory,source:'dsh',stateDir:videoLimits.stateDir,decisionProvider:f.provider});
  t.after(()=>watch.close());watch.start({maxRequests:2},{explicit:true});await watch.completion;
  assert.equal(watch.state().running,false);assert.equal(watch.state().counts.requests,1);assert.equal(paused,1);assert.equal(f.requests.length,1);
  const apiPersona=new PersonaMemory({memoryDir}).snapshot();assert.equal(apiPersona.interests.length,0);assert.equal(apiPersona.recentObservations.length,1);assert.equal(apiPersona.recentObservations[0].signal,'neutral');assert.match(apiPersona.personaText,/科普动画/);
});
