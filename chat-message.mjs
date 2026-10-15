import { createHash } from 'node:crypto';

// 展示时间和 DOM 选择器会变化；核对真正的消息内容及媒体资源。
export function messageFingerprint(message) {
  const media=message.media;
  const value=[message.sender||message.direction,message.kind||'text',message.text||'',media?{
    type:media.type,label:media.label,title:media.title,author:media.author,
    videoId:media.videoId,url:media.url,isPhotoGallery:media.isPhotoGallery,
    resources:media.resources?.map(resource=>({resourceRef:resource.resourceRef,label:resource.label})),
  }:null];
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
