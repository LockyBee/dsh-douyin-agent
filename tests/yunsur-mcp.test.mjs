import test from 'node:test';
import assert from 'node:assert/strict';
import {YunsurMcpClient,parseExactJson} from '../yunsur-mcp.mjs';
test('后台接口保留抖音长整数精度',()=>{assert.equal(parseExactJson('{"id":9007199254740993,"count":2}').id,'9007199254740993');});
test('拒绝远端地址和未认证连接',()=>{for(const endpoint of ['https://example.com/mcp','http://127.0.0.1.evil/mcp','http://127.0.0.1/mcp?token=x'])assert.throws(()=>new YunsurMcpClient({endpoint,token:'x'.repeat(32)}));assert.throws(()=>new YunsurMcpClient({endpoint:'http://127.0.0.1:18080/mcp',token:''}));});
test('默认不开放发送和发布，错误回执不能当成功',async()=>{let calls=0;const client=new YunsurMcpClient({endpoint:'http://127.0.0.1:18080/mcp',token:'x'.repeat(32),fetchImpl:async(_url,options)=>{calls++;const req=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:req.id,result:{isError:true,content:[{type:'text',text:'test'}]}});}});await assert.rejects(client.call('send_conversation_text',{}));await assert.rejects(client.call('publish_content',{}, {control:true}));assert.equal(calls,0);await assert.rejects(client.call('check_login_status'),{code:'DOUYIN_MCP_TOOL_ERROR'});});
