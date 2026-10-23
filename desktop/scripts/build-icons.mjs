import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const icon=await fs.readFile(path.join(root,'../assets/brand.ico'));
if(icon.readUInt16LE(0)!==0||icon.readUInt16LE(2)!==1)throw new Error('应用图标不是有效ICO。');
const frames=[];for(let i=0;i<icon.readUInt16LE(4);i++){const entry=6+i*16,size=icon.readUInt32LE(entry+8),offset=icon.readUInt32LE(entry+12);if(offset+size>icon.length)throw new Error('应用图标帧不完整。');const bytes=icon.subarray(offset,offset+size);if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))frames.push({width:bytes.readUInt32BE(16),bytes});}
frames.sort((a,b)=>b.width-a.width);if(!frames[0]||frames[0].width<256)throw new Error('应用图标缺少256像素PNG。');
await fs.mkdir(path.join(root,'assets'),{recursive:true});
await fs.writeFile(path.join(root,'assets/app.ico'),icon);
await fs.writeFile(path.join(root,'assets/app.png'),frames[0].bytes);
await fs.writeFile(path.join(root,'../assets/brand.png'),frames[0].bytes);
console.log('已将大肥鱼启动器原图标同步到软件包和界面，ICO与原文件字节一致。');
