import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatAgent } from '../chat-agent.mjs';
import { ChatService } from '../chat-service.mjs';
import { OutboundCoordinator } from '../outbound-send.mjs';

const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPEkAAAAASUVORK5CYII=';
const incoming=(id,extra={})=>({id,sender:'incoming',text:'',eligibleForReply:true,...extra});
function fixture(t,{group=false,settings={enabled:true,backend:'local-whisper'},status,transcription}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-chat-media-test-'));
  const contact={id:`conv:${'1'.repeat(64)}`,name:'合成媒体联系人',followed:true,isGroup:group,identityVerified:true,identityBinding:`binding:${'2'.repeat(64)}`,identityVersion:2,identityKind:group?'rendered-group':'rendered-user',identityHash:'1'.repeat(64)};
  const messages=[incoming('old',{text:'启动前旧消息'})],requests=[],sent=[],transcriptions=[],released=[];
  const captureId=`voice:${'3'.repeat(64)}`,audioPath=path.join(directory,'single-message.wav');
  fs.writeFileSync(audioPath,Buffer.alloc(32));
  const capture={conversation:{id:contact.id},messageId:'voice-new',captureId,media:{type:'voice',durationSeconds:6.5},interval:{scope:'single-message-audio',startSeconds:0,durationSeconds:6.5},audio:{path:audioPath,mimeType:'audio/wav',bytes:32},understandingScope:'single-message-audio'};
  const browser={
    listContacts:async()=>({contacts:[structuredClone(contact)]}),
    readConversation:async()=>({conversation:{id:contact.id,isGroup:group},contact:structuredClone(contact),messages:structuredClone(messages)}),
    sendMessage:async(id,text)=>{sent.push({id,text});return{confirmed:true,messageId:`sent-${sent.length}`};},
    captureVoiceMessage:async(id,messageId,{allowed,signal})=>{assert.equal(id,contact.id);assert.equal(messageId,'voice-new');assert.equal(allowed,true);signal?.throwIfAborted();return structuredClone(capture);},
    releaseVoiceCapture:async id=>{released.push(id);assert.equal(id,captureId);fs.rmSync(audioPath,{force:true});},
    captureMessage:async(id,messageId)=>({conversation:{id},messageId,media:{type:'image'},understandingScope:'single-message-image',frames:[{mimeType:'image/png',data:pixel}]}),
  };
  const adapter={settings:async()=>settings,status:async()=>status??{...settings,backends:{'local-whisper':{available:true}}},transcribeAudio:async(args,{signal})=>{transcriptions.push(args);signal?.throwIfAborted();return transcription??{ok:true,backend:'local-whisper',kind:'transcription',text:'合成语音原句',interval:{startSeconds:0,durationSeconds:6.5}};}};
  const agent=new ChatAgent({config:{apiKey:''},replyProvider:async request=>{requests.push(request);return{text:'【自动回复】 收到合成新消息。'};}});
  const service=new ChatService({browser,agent,config:{apiKey:''},mediaAdapter:adapter,stateDir:directory});
  t.after(async()=>{await service.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^douyin-chat-media-test-/);fs.rmSync(directory,{recursive:true,force:true});});
  return{directory,contact,messages,requests,sent,transcriptions,released,capture,browser,adapter,agent,service,audioPath};
}
async function start(f){await f.service.configure({recipientIds:[f.contact.id],allowConversationOnly:f.contact.isGroup});await f.service.start({schedule:false});}
const voice=()=>incoming('voice-new',{kind:'voice',media:{type:'voice',durationSeconds:6.5,resources:[{resourceRef:'media:synthetic-audio'}]}});

test('普通图片只向当前模型发送指定消息画面，正文不带固定回复标签',async t=>{
  const f=fixture(t);await start(f);f.messages.push(incoming('image-new',{kind:'image',media:{type:'image',resources:[{resourceRef:'media:synthetic-image'}]}}));
  await f.service.poll();await f.service.poll();
  assert.equal(f.requests.length,1);assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,'收到合成新消息。');
  assert.equal(f.requests[0].messages.at(-1).content.filter(part=>part.type==='image_url').length,1);
  assert.equal(fs.readFileSync(f.service.watermarkFile,'utf8').includes(pixel),false);
});

test('单条语音经选定本地后端转写，转写不落水位且临时音频最终释放',async t=>{
  const f=fixture(t);await start(f);f.messages.push(voice());await f.service.poll();await f.service.poll();
  assert.equal(f.requests.length,1);assert.equal(f.sent.length,1);assert.deepEqual(f.transcriptions,[{source:f.audioPath,startSeconds:0,durationSeconds:6.5,backend:'local-whisper',language:'auto'}]);
  const body=JSON.stringify(f.requests[0]);assert.match(body,/合成语音原句/);assert.doesNotMatch(body,/single-message\.wav|douyin-chat-media-test/);
  assert.deepEqual(f.released,[f.capture.captureId]);assert.equal(fs.existsSync(f.audioPath),false);
  assert.equal(fs.readFileSync(f.service.watermarkFile,'utf8').includes('合成语音原句'),false);
});

test('缺少本地语音后端时保留文字和语音卡片，确认只回复一次',async t=>{
  for(const options of [{settings:{enabled:false,backend:'local-whisper'}},{settings:{enabled:true,backend:'mimo'}},{status:{enabled:true,backend:'local-whisper',backends:{'local-whisper':{available:false}}}}]){
    const f=fixture(t,options);f.browser.captureVoiceMessage=async()=>assert.fail('尚未允许本地转写，不能采集音频');await start(f);
    f.messages.push(voice(),incoming('new-text',{text:'混发了一段语音'}));await f.service.poll();await f.service.poll();
    assert.equal(f.requests.length,1);assert.equal(f.sent.length,1);assert.equal(f.service.state().contacts[0].status,'ready');
    assert.match(JSON.stringify(f.requests[0].messages),/single-message-media-unavailable/);
    assert.match(JSON.stringify(f.requests[0].messages),/混发了一段语音/);
    assert.doesNotMatch(JSON.stringify(f.requests[0].messages),/"transcription"/);
  }
});

test('单消息音频身份、范围、体积、类型不符时拒绝转写并释放受控捕获',async t=>{
  for(const mutate of [value=>value.conversation.id='another',value=>value.messageId='another',value=>value.media.durationSeconds=121,value=>value.interval.startSeconds=1,value=>value.audio.bytes=26*1024*1024,value=>value.audio.bytes=31,value=>value.audio.path='relative.wav',value=>value.audio.mimeType='text/html']){
    const f=fixture(t);mutate(f.capture);await start(f);f.messages.push(voice());await f.service.poll();
    assert.equal(f.transcriptions.length,0);assert.equal(f.requests.length,0);assert.equal(f.sent.length,0);assert.deepEqual(f.released,[f.capture.captureId]);
  }
});

test('本地转写失败、空白或声称超出采集时长时暂停且释放音频',async t=>{
  for(const transcription of [{ok:false,backend:'local-whisper'}, {ok:true,backend:'mimo',text:'不应接受'}, {ok:true,backend:'local-whisper',kind:'transcription',text:' ',interval:{startSeconds:0,durationSeconds:6.5}}, {ok:true,backend:'local-whisper',kind:'transcription',text:'合成超界',interval:{startSeconds:0,durationSeconds:7}}]){
    const f=fixture(t,{transcription});await start(f);f.messages.push(voice());await f.service.poll();
    assert.equal(f.requests.length,0);assert.equal(f.sent.length,0);assert.deepEqual(f.released,[f.capture.captureId]);assert.equal(f.service.state().contacts[0].status,'paused');
  }
});

test('合法无对白语音与图片同批仍回复，后续文字不中断；无对白状态不冒充已识别文字',async t=>{
  const transcription={ok:false,status:'no-speech',kind:'transcription',backend:'local-whisper',text:'',segments:[],interval:{startSeconds:0,durationSeconds:6.5}};
  const f=fixture(t,{transcription});await start(f);f.messages.push(voice(),incoming('image-new',{kind:'image',media:{type:'image',resources:[{resourceRef:'media:synthetic-image'}]}}));
  await f.service.poll();assert.equal(f.service.state().contacts[0].status,'ready');assert.equal(f.requests.length,1);assert.equal(f.sent.length,1);assert.deepEqual(f.released,[f.capture.captureId]);
  const content=f.requests[0].messages.at(-1).content;assert.equal(content.filter(part=>part.type==='image_url').length,1);
  const voicePart=content.find(part=>part.type==='text'&&part.text.includes('single-message-audio-no-speech'));assert.ok(voicePart);assert.match(voicePart.text,/不能编造说话内容或环境声/);assert.doesNotMatch(voicePart.text,/"transcription"/);
  f.messages.push(incoming('text-after',{text:'合成后续正常文字'}));await f.service.poll();assert.equal(f.requests.length,2);assert.equal(f.sent.length,2);assert.equal(f.service.state().contacts[0].status,'ready');
});

test('伪装no-speech但返回范围或字段不合法时仍暂停',async t=>{
  const valid={ok:false,status:'no-speech',kind:'transcription',backend:'local-whisper',text:'',segments:[],interval:{startSeconds:0,durationSeconds:6.5}};
  for(const mutate of [value=>delete value.text,value=>delete value.segments,value=>value.segments=[{}],value=>value.text='有文本',value=>value.interval.durationSeconds=7,value=>value.backend='mimo',value=>value.kind='audio',value=>value.ok=true]){
    const value=structuredClone(valid);mutate(value);const f=fixture(t,{transcription:value});await start(f);f.messages.push(voice());await f.service.poll();assert.equal(f.requests.length,0);assert.equal(f.sent.length,0);assert.equal(f.service.state().contacts[0].status,'paused');assert.deepEqual(f.released,[f.capture.captureId]);
  }
});

test('转写失败只影响语音理解，停止时释放音频且不发出',async t=>{
  for(const cancel of [false,true]){
    const f=fixture(t);await start(f);f.adapter.transcribeAudio=async()=>{if(cancel)f.service.stop();throw new Error('合成转写中断');};f.messages.push(voice());await f.service.poll();
    assert.deepEqual(f.released,[f.capture.captureId]);assert.equal(f.sent.length,cancel?0:1);assert.equal(f.requests.length,cancel?0:1);
  }
});

test('私信同一批文字、语音、图像、表情、附件视频、文件和引用合并一次回复', async t => {
  const f = fixture(t);
  const metadata = 'visible-message-metadata-only';
  f.browser.canCaptureAttachment = message => ['file', 'video-attachment'].includes(message.media?.type);
  f.browser.captureMessage = async (_id, messageId) => {
    const media = f.messages.find(item => item.id === messageId).media;
    const frame = { mimeType: 'image/png', data: pixel };
    const result = { messageId, media };
    if (media.type === 'file') return { ...result, frames: [], understandingScope: 'single-message-file-text',
      fileText: { text: '合成文件正文', filename: '合成.txt' } };
    if (media.type === 'video-attachment') return { ...result, understandingScope: 'single-message-video-samples',
      videoAttachment: { durationSeconds: 8 }, frames: [1, 3, 7].map(time => ({ ...frame, time, timeSemantics: 'approximate-seek-position' })) };
    return { ...result, understandingScope: 'single-message-image', frames: [frame] };
  };
  await start(f);
  f.messages.push(
    incoming('video-new', { media: { type: 'video-attachment', understandingScope: metadata } }),
    voice(),
    incoming('image-new', { media: { type: 'image' } }),
    incoming('emoji-new', { media: { type: 'emoji', label: '合成表情' } }),
    incoming('file-new', { media: { type: 'file', title: '合成.txt', understandingScope: metadata } }),
    incoming('question-new', { text: '把上面的内容一起说一下', reference: { text: '合成旧问题' } }),
  );
  await f.service.poll();
  await f.service.poll();
  assert.equal(f.requests.length, 1);
  assert.equal(f.sent.length, 1);
  const parts = f.requests[0].messages.at(-1).content;
  const details = JSON.stringify(f.requests[0].messages);
  for (const value of ['合成语音原句', '合成文件正文', '合成旧问题', '把上面的内容一起说一下', 'image-new', 'emoji-new', 'video-new']) assert.ok(details.includes(value), value);
  assert.equal(parts.filter(part => part.type === 'image_url').length, 4);
  assert.equal(parts.filter(part => part.type === 'text').some(part => part.text.includes('"approximateSampleTimes":[1,3]')), true);
  assert.doesNotMatch(details, /single-message\.wav|media:synthetic-audio/);
});

test('群里先发附件再艾特时保留发送者，插入的另一成员附件不会进入画面', async t => {
  const f = fixture(t, { group: true }), memberId = `member:${'6'.repeat(64)}`;
  const captured = [], capture = f.browser.captureMessage;
  f.browser.captureMessage = async (id, messageId) => { captured.push(messageId); return capture(id, messageId); };
  await start(f);
  f.messages.push(
    incoming('image-a', { memberId, media: { type: 'image' } }),
    incoming('image-b', { memberId: `member:${'7'.repeat(64)}`, media: { type: 'image' } }),
  );
  await f.service.poll();
  assert.equal(f.sent.length, 0);
  f.messages.push(incoming('ask', { memberId, text: '@大肥鱼，看看上面的图片', mentionedSelf: true }));
  await f.service.poll();
  await f.service.poll();
  assert.deepEqual(captured, ['image-a']);
  assert.equal(f.sent.length, 1);
  const transcript = f.requests[0].messages.filter(message => typeof message.content === 'string').map(message => message.content).join('\n');
  assert.match(transcript, /"replyTarget":true[^\n]+\n消息正文：@大肥鱼/);
  assert.match(transcript, /"replyTarget":false[^\n]+\n消息正文：\{"messageId":"image-a"/);
});

test('附件回读发现真实验证页时，同批文字也不外发', async t => {
  const f = fixture(t);
  f.browser.captureMessage = async () => ({ verificationRequired: true, frames: [] });
  await start(f);
  f.messages.push(incoming('image-new', { media: { type: 'image' } }), incoming('text-new', { text: '同批文字' }));
  await f.service.poll();
  assert.equal(f.requests.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.service.state().contacts[0].recovery.requiresUserAction, true);
});

test('转写期间原语音被替换时丢弃转写，不让模型回复旧媒体',async t=>{
  const f=fixture(t),original=f.adapter.transcribeAudio;f.adapter.transcribeAudio=async(...args)=>{const value=await original(...args);f.messages.at(-1).media.resources=[{resourceRef:'media:changed'}];return value;};
  await start(f);f.messages.push(voice());await f.service.poll();assert.equal(f.requests.length,0);assert.equal(f.sent.length,0);assert.deepEqual(f.released,[f.capture.captureId]);
});

test('群里没有@或设定昵称证据的纯语音不触发采集或转写',async t=>{
  const f=fixture(t,{group:true});f.browser.captureVoiceMessage=async()=>assert.fail('普通群语音不应被采集');await start(f);f.messages.push(voice());await f.service.poll();
  assert.equal(f.transcriptions.length,0);assert.equal(f.requests.length,0);assert.equal(f.sent.length,0);assert.equal(f.service.state().contacts[0].status,'ready');
});

test('群消息带明确@自己证据时可转写这条语音',async t=>{
  const f=fixture(t,{group:true});await start(f);f.messages.push({...voice(),mentionedSelf:true});await f.service.poll();assert.equal(f.transcriptions.length,1);assert.equal(f.requests.length,1);assert.equal(f.sent.length,1);
});

test('共同发送锁延后发送的旧格式回复也清理前缀，不重复调用模型',async t=>{
  const f=fixture(t);await start(f);f.service.outbound=new OutboundCoordinator({stateDir:f.directory,waitMs:20});
  const guard=path.join(f.directory,'outbound-send.guard');fs.writeFileSync(guard,JSON.stringify({pid:process.pid,token:'合成占用'}));
  f.messages.push(incoming('text-new',{text:'合成待回复'}));await f.service.poll();assert.equal(f.sent.length,0);
  const mark=f.service.watermarks.contacts[f.contact.id];mark.pending.generatedText='[自动回复] 【自动回复】 合成待发送正文';f.service.persist();fs.unlinkSync(guard);
  await f.service.poll();assert.equal(f.sent[0].text,'合成待发送正文');assert.equal(f.requests.length,1);
});

test('模型接受1000个Unicode字符并拒绝空标签回复及超长正文',async()=>{
  const messages=[incoming('new',{text:'合成问题'})];
  const agent=value=>new ChatAgent({config:{apiKey:''},replyProvider:async()=>({text:value})});
  assert.equal((await agent('鱼🐟'.repeat(500)).reply({messages})).text,'鱼🐟'.repeat(500));
  for(const value of ['[自动回复] 【自动回复】 ','🐟'.repeat(1001)])await assert.rejects(agent(value).reply({messages}),/为空|1000/);
});

test('语音转写必须属于本条incoming且为本地识别，不能夹带图像冒充音频',async()=>{
  const agent=new ChatAgent({config:{apiKey:''},replyProvider:async()=>({text:'合成回复'})});
  const observation={messageId:'voice-new',media:{type:'voice'},transcription:{text:'合成转写',backend:'local-whisper',interval:{startSeconds:0,durationSeconds:1}},frames:[],understandingScope:'single-message-audio-transcription'};
  const messages=[voice()];await agent.reply({messages,mediaObservations:[observation]});
  for(const mutate of [value=>value.messageId='another',value=>value.transcription.backend='mimo',value=>value.frames=[{mimeType:'image/png',data:pixel}],value=>value.understandingScope='unverified']){
    const value=structuredClone(observation);mutate(value);await assert.rejects(agent.reply({messages,mediaObservations:[value]}));
  }
});

test('模型无对白提示要求精确本地证据，拒绝跨消息、伪装后端、带转写或图像',async()=>{
  let called=0;const agent=new ChatAgent({config:{apiKey:''},replyProvider:async()=>{called++;return{text:'合成回复'};}});
  const observation={messageId:'voice-new',media:{type:'voice'},audioStatus:'no-recognized-speech',backend:'local-whisper',interval:{startSeconds:0,durationSeconds:1},frames:[],understandingScope:'single-message-audio-no-speech'};
  const messages=[voice()];await agent.reply({messages,mediaObservations:[observation]});assert.equal(called,1);
  for(const mutate of [value=>value.messageId='another',value=>value.backend='mimo',value=>value.transcription={text:'伪造'},value=>value.frames=[{mimeType:'image/png',data:pixel}],value=>value.interval.durationSeconds=121,value=>value.understandingScope='unverified']){
    const value=structuredClone(observation);mutate(value);await assert.rejects(agent.reply({messages,mediaObservations:[value]}));
  }
  assert.equal(called,1);
});
