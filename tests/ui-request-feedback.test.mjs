import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { operationLabel, requestFailure } from '../desktop/ui-api/src/api.mjs';

const software = await fs.readFile(new URL('../desktop/ui-api/src/main.jsx', import.meta.url), 'utf8');
const native = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8');
function between(source, start, end) {
  const from=source.indexOf(start),to=source.indexOf(end,from); assert.ok(from>=0&&to>from); return source.slice(from,to);
}
function nativeTransport() {
  let definition;
  vm.runInNewContext(native,{window:{__ModuleLoader__:{load:value=>{definition=value;}}},globalThis:{},AbortSignal,Set,Error,TypeError});
  return definition.factory(name=>name==='react'?{}:{Button(){}}).createSettingsTransport;
}

test('插件传输将超时标明操作，不回显查询和凭据，也不重放写入',async()=>{
  const create=nativeTransport(),calls=[]; let mode='ok';
  const api=create({location:{protocol:'dsh-app:',hostname:'app'},fetch:async(route)=>{
    calls.push(route);
    if(route.endsWith('/state'))return {ok:true,json:async()=>({token:'synthetic-feedback-token'})};
    if(mode==='timeout')throw Object.assign(new Error('signal timed out'),{name:'TimeoutError'});
    return {ok:false,status:409,json:async()=>({error:'当前会话身份核对未通过。'})};
  }});
  await api.request('/state');mode='timeout';
  await assert.rejects(api.request('/chat/resolve',{recipientId:'synthetic'}),error=>error.requestError===true&&error.unconfirmed===true&&/解除会话暂停.*超时.*勿重复提交/.test(error.message)&&!/synthetic/.test(error.message));
  mode='business';
  await assert.rejects(api.request('/chat/resolve',{recipientId:'synthetic'}),error=>error.status===409&&!error.requestError&&/解除会话暂停：当前会话身份核对未通过/.test(error.message));
  assert.equal(calls.length,3);
  const pending=Promise.withResolvers();let writes=0;
  const busy=create({location:{protocol:'dsh-app:',hostname:'app'},fetch:async route=>route.endsWith('/state')?{ok:true,json:async()=>({token:'synthetic-busy-token'})}:(writes++,await pending.promise)});
  await busy.request('/state');const first=busy.request('/watch/schedule',{enabled:true});
  await assert.rejects(busy.request('/watch/schedule',{enabled:false}),error=>error.code==='UI_OPERATION_BUSY');
  assert.equal(writes,1);pending.resolve({ok:true,json:async()=>({policy:{enabled:true}})});await first;
});

for(const [label,source,isNative] of [['软件',software,false],['插件',native,true]])test(`${label}同操作忙时不重复提交，其他操作成功不抹掉已发生的业务错误`,async()=>{
  const gate=Promise.withResolvers(),locks={current:new Set()},alive={current:true};let calls=0,errors={};
  const setOperationErrors=update=>{errors=update(errors);};
  let perform;
  if(isNative){
    const code=between(source,'async function perform(key, action)','\n      const button');
    perform=new Function('ready','locks','setBusy','setNotice','setOperationErrors','requestFailure','operationLabel','alive','refresh',`return (${code});`)(true,locks,()=>{},()=>{},setOperationErrors,requestFailure,operationLabel,alive,async()=>{});
  }else{
    const code=between(source,'const run = useCallback(async (name, action)','\n  useEffect(');
    perform=new Function('useCallback','lock','setBusy','setOperationErrors','requestFailure','operationLabel','pollRef',`${code};return run;`)(fn=>fn,locks,()=>{},setOperationErrors,requestFailure,operationLabel,{current:async()=>{}});
  }
  const first=perform('chatList',async()=>{calls++;await gate.promise;throw new Error('需要人工核对合成会话。');});
  await perform('chatList',async()=>{calls++;});assert.equal(calls,1);
  await perform('browserOpen',async()=>{});gate.resolve();await first;
  assert.match(errors.chatList.message,/读取当前会话列表：需要人工核对合成会话/);
  await perform('browserOpen',async()=>{});assert.ok(errors.chatList,'别的操作成功不能删除此业务错误');
  await perform('chatList',async()=>{});assert.equal(errors.chatList,undefined,'同一操作成功后清掉自己的旧错误');
});

test('软件轮询子请求失败会显示来源并撤下旧在线快照，读回成功后只清相应状态错误',async()=>{
  const code=between(software,'    let alive = true, polling = false, checkingVerification = false, ticks = 0;','    pollRef.current = poll;');
  let failing=true,pollError='',interactions={presence:{label:'旧在线'}},connected=false;
  const names=['client','bootRef','bridge','revision','currentTask','setEvents','setWatchSynced','setBoot','setSettings','publicSettings','setConnected','setConnectionError','setRunning','submitLock','setTasks','restoredSelection','setSelectedTask','mergeEvents','setBrowser','setSchedule','setInteractions','setVideo','setTaskLimits','setMode','setComments','setChat','setAudio','setWatch','setShare','setPersona','setPollError','setBrowserMode','setReactions'];
  const noop=()=>{},client={bootstrap:async()=>({}),request:async route=>{
    if(route.startsWith('/api/state'))return {running:false,events:[]};
    if(route==='/api/interactions/state') {if(failing)throw requestFailure(Object.assign(new Error('signal timed out'),{name:'TimeoutError'}),'读取好友在线状态',{timeoutMs:20_000});return {presence:{label:'新核实在线'}};}
    return {};
  }};
  const values=[client,{current:{}},null,{current:0},{current:null},noop,noop,noop,noop,noop,value=>{connected=value;},noop,noop,{current:false},noop,{current:false},noop,()=>[],noop,noop,value=>{interactions=value;},noop,noop,noop,noop,noop,noop,noop,noop,noop,value=>{pollError=value;},noop,noop];
  const poll=new Function(...names,`${code};return poll;`)(...values);
  await poll();assert.equal(connected,true);assert.equal(interactions,null);assert.match(pollError,/读取好友在线状态.*超时/);
  failing=false;await poll();assert.equal(interactions.presence.label,'新核实在线');assert.equal(pollError,'');
});
