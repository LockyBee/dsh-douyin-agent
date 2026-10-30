import {randomUUID} from 'node:crypto';
import jpeg from './storyboard/vendor/jpeg-js/index.js';
import {bestLayout} from './storyboard/vendor/plan.mjs';
import {composeSheet, layoutCanvas} from './storyboard/vendor/sheet.mjs';

const MAX_BYTES=2_000_000, MAX_TOTAL_BYTES=8_000_000, MAX_PIXELS=8_000_000;
const publicId=value=>typeof value==='string'&&/^\d{1,64}$/.test(value);
const original=(frames,reason)=>({frames,summary:'',manifest:{status:'original',inputImages:frames.length,outputImages:frames.length,reason}});
function frameBytes(frame){
  if(typeof frame?.data!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)||frame.data.length%4)throw Error('视频帧编码无效。');
  const bytes=Buffer.from(frame.data,'base64');
  if(!bytes.length||bytes.length>MAX_BYTES||bytes.toString('base64')!==frame.data)throw Error('视频帧超出有界编码范围。');
  return bytes;
}
export function jpegDimensions(bytes){
  if(bytes[0]!==255||bytes[1]!==216)throw Error('不是JPEG画面。');
  let at=2;
  while(at+4<=bytes.length){
    if(bytes[at++]!==255)throw Error('JPEG头无效。');
    while(bytes[at]===255)at++;
    const marker=bytes[at++];if(marker===218||marker===217)break;
    if(marker===1||marker>=208&&marker<=215)continue;
    const length=bytes.readUInt16BE(at);if(length<2||at+length>bytes.length)throw Error('JPEG长度无效。');
    if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
      if(length<8)throw Error('JPEG尺寸段无效。');
      const height=bytes.readUInt16BE(at+3),width=bytes.readUInt16BE(at+5);
      if(width<2||height<2||width*height>4_000_000)throw Error('JPEG解码像素超限。');
      return{width,height};
    }
    at+=length;
  }
  throw Error('没有JPEG尺寸。');
}
function fitRgb(image,width,height){
  const output=Buffer.alloc(width*height*3,18);
  const ratio=Math.min(width/image.width,height/image.height);
  const w=Math.max(1,Math.floor(image.width*ratio)),h=Math.max(1,Math.floor(image.height*ratio));
  const left=Math.floor((width-w)/2),top=Math.floor((height-h)/2);
  for(let y=0;y<h;y++){
    const sy=Math.max(0,Math.min(image.height-1,(y+0.5)/ratio-0.5)),y0=Math.floor(sy),y1=Math.min(image.height-1,y0+1),fy=sy-y0;
    for(let x=0;x<w;x++){
      const sx=Math.max(0,Math.min(image.width-1,(x+0.5)/ratio-0.5)),x0=Math.floor(sx),x1=Math.min(image.width-1,x0+1),fx=sx-x0;
      for(let c=0;c<3;c++){
        const a=image.data[(y0*image.width+x0)*3+c]*(1-fx)+image.data[(y0*image.width+x1)*3+c]*fx;
        const b=image.data[(y1*image.width+x0)*3+c]*(1-fx)+image.data[(y1*image.width+x1)*3+c]*fx;
        output[((top+y)*width+left+x)*3+c]=Math.round(a*(1-fy)+b*fy);
      }
    }
  }
  return output;
}

// 只压缩已由调用方核实的同作品视频帧，不下载视频或读取语音服务配置。
export function prepareVideoFrames(frames,{signal,budget=480_000}={}){
  signal?.throwIfAborted();
  if(!Array.isArray(frames))throw new TypeError('视频画面须为数组。');
  if(frames.length<2||frames.length>16)return original(frames,'single-or-too-many');
  if(!Number.isSafeInteger(budget)||budget<32_768||budget>640_000)throw Error('分镜像素预算须为32768至640000。');
  const id=frames[0]?.videoId;
  if(!publicId(id)||frames.some(f=>f.videoId!==id||f.mimeType!=='image/jpeg'||!Number.isFinite(f.time)||f.time<0))return original(frames,'not-same-jpeg-video');
  try{
    let totalBytes=0,totalPixels=0;
    const sources=frames.map(frame=>{const bytes=frameBytes(frame),size=jpegDimensions(bytes);totalBytes+=bytes.length;totalPixels+=size.width*size.height;if(totalBytes>MAX_TOTAL_BYTES||totalPixels>MAX_PIXELS)throw Error('分镜输入总量超限。');return{bytes,...size};});
    const aspect=sources[0].width/sources[0].height,{cols,rows}=bestLayout(frames.length,aspect);
    const pixels=Math.min(budget,Math.floor(totalPixels*0.75));
    const layout=layoutCanvas(cols,rows,aspect,pixels);
    if(layout.cellW<64||layout.cellH<64||layout.width*layout.height>=totalPixels)return original(frames,'too-small-to-reduce');
    const tiles=sources.map((source,index)=>{
      signal?.throwIfAborted();
      const image=jpeg.decode(source.bytes,{useTArray:true,formatAsRGBA:false,tolerantDecoding:false,maxResolutionInMP:4,maxMemoryUsageInMB:48});
      if(image.width!==source.width||image.height!==source.height)throw Error('视频帧解码尺寸不一致。');
      return{index:index+1,buffer:fitRgb(image,layout.cellW,layout.cellH)};
    });
    const sheet=composeSheet({frames:tiles,cols,rows,cellAspect:aspect,budget:pixels,badgeRatio:0.13});
    signal?.throwIfAborted();
    const rgba=Buffer.alloc(sheet.width*sheet.height*4);
    for(let i=0,j=0;i<sheet.buffer.length;i+=3,j+=4){rgba[j]=sheet.buffer[i];rgba[j+1]=sheet.buffer[i+1];rgba[j+2]=sheet.buffer[i+2];rgba[j+3]=255;}
    const encoded=jpeg.encode({width:sheet.width,height:sheet.height,data:rgba},72).data;
    if(encoded.length>MAX_BYTES)throw Error('分镜图片超限。');
    const cells=frames.map((f,index)=>({cell:index+1,row:Math.floor(index/cols)+1,col:index%cols+1,time:f.time,videoId:id}));
    const manifest={status:'storyboard',source:'dsh-video-storyboard@0.4.4',videoId:id,inputImages:frames.length,outputImages:1,inputPixels:totalPixels,outputPixels:sheet.width*sheet.height,width:sheet.width,height:sheet.height,cols,rows,cells,inputBytes:totalBytes,outputBytes:encoded.length};
    return{frames:[{mimeType:'image/jpeg',data:Buffer.from(encoded).toString('base64'),videoId:id,storyboard:true}],manifest,
      summary:`这是一张按格编号的视频分镜图，空白灰格没有内容。${cells.map(c=>`第${c.cell}格（第${c.row}行第${c.col}列）对应播放时间${c.time.toFixed(3)}秒`).join('；')}。这些是原来已核实的采样画面，不证明看完整条，也没有增加音轨证据。`};
  }catch(error){signal?.throwIfAborted();return original(frames,'unsupported-or-decode-failed');}
}

export function videoImageParts(frames,options){
  const packed=prepareVideoFrames(frames,options);
  return{...packed,parts:[...(packed.summary?[{type:'text',text:packed.summary}]:[]),...packed.frames.map(frame=>({type:'image_url',image_url:{url:`data:${frame.mimeType};base64,${frame.data}`,detail:'high'}}))]};
}

export class StoryboardFrameStore{
  constructor({now=()=>performance.now(),ttlMs=60_000}={}){this.now=now;this.ttlMs=ttlMs;}
  remember(result){
    this.clear();const frames=result?.frames,state=result?.state;
    if(!Array.isArray(frames)||!frames.length||frames.length>16||!publicId(state?.video?.id)||state.loginRequired||state.verificationRequired||state.privateChatVisible||state.unsupportedPage||state.videoSelection?.identityConflict||frames.some(f=>f.sensitive===true||f.videoId!==state.video.id||!Number.isFinite(f.time)))return null;
    let size=0;const saved=frames.map(frame=>{size+=frameBytes(frame).length;return{mimeType:frame.mimeType,data:frame.data,videoId:frame.videoId,time:frame.time,timeSemantics:frame.timeSemantics};});
    if(size>MAX_TOTAL_BYTES)return null;
    const sampleId=randomUUID();this.sample={sampleId,videoId:state.video.id,at:this.now(),frames:saved};
    this.timer=setTimeout(()=>this.clear(),this.ttlMs);this.timer.unref?.();return sampleId;
  }
  zoom({sampleId,cell,videoId}){
    const sample=this.sample,age=sample?this.now()-sample.at:NaN;
    if(!sample||!Number.isFinite(age)||age<0||age>this.ttlMs||sample.sampleId!==sampleId||sample.videoId!==videoId)throw Error('原分镜已过期或作品已改变，请重新观察。');
    if(!Number.isSafeInteger(cell)||cell<1||cell>sample.frames.length)throw Error('分镜格编号无效。');
    return{frames:[{...sample.frames[cell-1]}],observation:{sourceSampleId:sampleId,cell,videoId,sourceTime:sample.frames[cell-1].time,note:'这是原分镜指定格的原始采样画面，不是新采样或新观看进度，没有增加音频证据。'}};
  }
  clear(){clearTimeout(this.timer);this.timer=null;this.sample=null;}
}
