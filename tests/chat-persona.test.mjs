import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatAgent} from '../chat-agent.mjs';

test('私信每次读取最新共用手编人格，不向模型带出兴趣生成区或观看来源',async()=>{
  let version=1;const requests=[];
  const personaMemory={snapshot:()=>({manualText:`合成人格版本${version}：语气简洁。`,personaText:'不得外发的合成作品与兴趣',interests:[{topic:'合成内部兴趣'}],recentObservations:[{url:'https://synthetic-private.example'}]})};
  const agent=new ChatAgent({config:{apiKey:'synthetic-key',baseUrl:'https://synthetic.example',model:'synthetic'},personaMemory,fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'合成回复'}}]}));}});
  await agent.reply({messages:[{sender:'incoming',text:'合成新消息'}]});version=2;await agent.reply({messages:[{sender:'incoming',text:'第二条合成新消息'}]});
  assert.match(requests[0].messages[0].content,/合成人格版本1/);assert.match(requests[1].messages[0].content,/合成人格版本2/);
  const text=JSON.stringify(requests);assert.doesNotMatch(text,/不得外发的合成作品|合成内部兴趣|synthetic-private/);assert.equal(requests[0].tools,undefined);
});
