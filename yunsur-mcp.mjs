import { randomUUID } from 'node:crypto';

const READ_TOOLS = new Set(['check_login_status','get_homefeed','get_video_detail','get_video_comments','get_sub_comments','search_videos','get_live_info','list_conversations','get_conversation_info','get_conversation_history','background_im_state','background_im_batch']);
const CONTROL_TOOLS = new Set(['start_im_listen','stop_im_listen','send_conversation_text','share_conversation_aweme','live_room_enter','digg_video','collect_video','post_video_comment']);
export const decimalId = value => typeof value === 'string' && /^\d{1,64}$/.test(value) || Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
export function parseExactJson(text) {
  return JSON.parse(text, (_key,value,context) => typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context.source : value);
}

// 只连接本机已认证服务。模型不能指定工具名、端口或任意收件人。
export class YunsurMcpClient {
  constructor({ endpoint, token, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password) throw Error('MCP 地址须为本机 /mcp 接口。');
    if (typeof token !== 'string' || token.length < 32 || /\s/.test(token)) throw Error('MCP 本机认证未配置。');
    Object.assign(this,{ endpoint:url.href,token,fetchImpl,timeoutMs });
  }
  async rpc(method, params, { signal } = {}) {
    const id = randomUUID();
    let response;
    try { response = await this.fetchImpl(this.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(this.timeoutMs),...(signal?[signal]:[])]),headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json',accept:'application/json, text/event-stream','MCP-Protocol-Version':this.protocol || '2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})}); }
    catch(error) { if(signal?.aborted) throw signal.reason; throw Object.assign(Error('后台 MCP 连接失败。'),{code:'MCP_CONNECTION_FAILED'}); }
    if(!response.ok) { await response.body?.cancel(); throw Object.assign(Error(`后台 MCP 请求失败（HTTP ${response.status}）。`),{code:'MCP_HTTP_ERROR'}); }
    let text='',size=0;const decoder=new TextDecoder('utf-8',{fatal:true});
    try { for await (const chunk of response.body) {size+=chunk.length;if(size>12*1024*1024)throw Error('MCP 返回超出读取范围。');text+=decoder.decode(chunk,{stream:true});} text+=decoder.decode(); }
    catch(error){await response.body?.cancel().catch(()=>{});throw error;}
    // 服务使用 JSONResponse，拒绝无法核对的流或错误回执。
    const result=parseExactJson(text);
    if(result.id!==id||result.error)throw Object.assign(Error('后台 MCP 返回错误或回执不匹配。'),{code:'MCP_RPC_ERROR'});
    return result.result;
  }
  async initialize(options) {
    const result=await this.rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'dafeiyu-background',version:'1.5.0-beta.1'}},options);
    if(!result?.protocolVersion||!result.serverInfo)throw Error('MCP 初始化未完成。');
    this.protocol=result.protocolVersion;return{protocol:this.protocol,server:result.serverInfo.name};
  }
  async listToolNames({ signal } = {}) {
    const names = new Set(), cursors = new Set();
    let cursor;
    for (let page = 0; page < 8; page++) {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {}, { signal });
      if (!Array.isArray(result?.tools)) throw Error('后台 MCP 工具列表无法核对。');
      for (const tool of result.tools) if (typeof tool?.name === 'string') names.add(tool.name);
      if (!result.nextCursor) return names;
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) break;
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    return names;
  }
  async call(name,args={}, { signal, control=false } = {}) {
    if(!READ_TOOLS.has(name)&&!(control&&CONTROL_TOOLS.has(name)))throw Error('本机适配未开放此 MCP 操作。');
    const result=await this.rpc('tools/call',{name,arguments:args},{signal});
    if(result?.isError)throw Object.assign(Error('抖音后台接口未完成请求，需要检查登录或平台响应。'),{code:'DOUYIN_MCP_TOOL_ERROR'});
    if(result?.structuredContent)return result.structuredContent;
    const blocks=result?.content?.filter(item=>item.type==='text');
    if(blocks?.length!==1)throw Error('MCP 返回的结果格式无法核对。');
    return parseExactJson(blocks[0].text);
  }
}
