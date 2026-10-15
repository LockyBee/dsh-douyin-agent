import { createNativeToolDefinitions } from './dsh-plugin.mjs?v=5';

export const name='douyin-chat-addon';
export const inject=['tools'];
// 旧动态视频包由原会话拥有时，只挂新增聊天工具，沿用真实原生执行管线。
export function apply(ctx) {
  let controller;
  const getController=()=>controller??=import('./core.mjs?v=5').then(({BrowserController})=>new BrowserController({source:'dsh'}));
  const tools=createNativeToolDefinitions({ctx,getController}).filter(tool=>tool.name.startsWith('douyin_chat_'));
  const disposers=[];
  try { for(const tool of tools) disposers.push(ctx.tools.register(tool)); }
  catch(error){for(const off of disposers.reverse())off?.();throw error;}
  ctx.effect(()=>async()=>{
    for(const off of disposers.reverse())off?.();
    if(controller) await controller.then(value=>value.close()).catch(()=>{});
  });
}
export default{name,inject,apply};
