import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BrowserController } from './core.mjs';
import { VideoLimits } from './video-limits.mjs';
import { MediaAdapter } from './media/index.mjs';
const [action='help',...input]=process.argv.slice(2);
const mapping={open:'douyin_open',recommend:'douyin_open',status:'douyin_status',search:'douyin_search',video:'douyin_open_video',next:'douyin_next',previous:'douyin_previous',pause:'douyin_pause',play:'douyin_play',observe:'douyin_observe',screenshot:'douyin_screenshot',remember:'douyin_remember',recall:'douyin_recall'};
if(['session-start','session-end','video-policy','video-limits','media-status','media-enable','media-disable'].includes(action)) {
  try {
    const limits=new VideoLimits();let result;
    if(action==='session-start') result=limits.markSession('dsh',{explicit:true});
    if(action==='session-end') result=limits.endSession({explicit:true});
    if(action==='video-policy') result=limits.savePolicy(JSON.parse(input.join(' ')),{explicit:true});
    if(action==='video-limits') result=limits.state();
    if(action.startsWith('media-')) {
      const media=new MediaAdapter();
      result=action==='media-status'?await media.status():await media.saveSettings({enabled:action==='media-enable',...(input[0]?{backend:input[0]}:{})},{explicit:true});
    }
    if(action==='session-end'||action==='video-policy') for(const source of ['api','dsh']) {
      const controller=new BrowserController({source});
      await limits.enforce({sources:[source],pause:()=>controller.pauseForLimits()});
      await controller.close();
    }
    console.log(JSON.stringify(result,null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}else if(!mapping[action] && action!=='forward') {
  console.log('open | recommend | status | search <关键词> | video <结果index或公开视频URL> | next | previous | pause | play | observe [秒] | screenshot | remember <笔记> | recall [关键词] | session-start | session-end | video-policy <JSON> | video-limits | media-status | media-enable [后端] | media-disable | forward <好友ID> [公开作品URL]');
  if(action!=='help') process.exitCode=1;
}else {
  const controller=new BrowserController({source:'dsh'});
  try {
    const args=action==='search'?{query:input.join(' ')}:action==='remember'?{content:input.join(' ')}:action==='recall'?{query:input.join(' ')}:action==='observe'?{seconds:Number(input[0]??3)}:action==='video'?(/^\d+$/.test(input[0]??'')?{index:Number(input[0])}:{url:input[0]}):{};
    const result=action==='forward'?await controller.execute('douyin_forward_video',{recipientId:input[0],...(input[1]?{url:input[1]}:{})},{humanAuthorized:true}):await controller.execute(mapping[action],args);
    if(result.frames?.length) {
      const root=path.join(path.dirname(fileURLToPath(import.meta.url)),'state','frames');
      mkdirSync(root,{recursive:true});
      result.frames=result.frames.map((frame,index)=>{
        const target=path.join(root,`${Date.now()}-${index}.jpg`);
        writeFileSync(target,Buffer.from(frame.data,'base64'));
        return {path:target,mimeType:frame.mimeType,time:frame.time,videoId:frame.videoId};
      });
    }
    console.log(JSON.stringify(result,null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
  finally{await controller.close();}
}
