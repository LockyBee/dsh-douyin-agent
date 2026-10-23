import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const UPDATE_REPOSITORY='LockyBee/dsh-douyin-agent';
const API=`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
export function parseVersion(value){const match=/^v?(\d+)\.(\d+)\.(\d+)$/.exec(value||'');if(!match||match.slice(1).some(item=>!Number.isSafeInteger(Number(item))))return null;return match.slice(1).map(Number);}
export function newerVersion(next,current){const a=parseVersion(next),b=parseVersion(current);if(!a||!b)return false;for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;}
function githubAsset(value,name){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&url.host==='github.com'&&url.pathname.startsWith(`/${UPDATE_REPOSITORY}/releases/download/`)&&decodeURIComponent(url.pathname.split('/').at(-1))===name&&!url.search&&!url.hash;}catch{return false;}}
export class UpdateService {
  constructor({version,directory,fetchImpl=fetch}={}){if(!parseVersion(version)||!path.isAbsolute(directory))throw new Error('更新版本或下载目录无效。');Object.assign(this,{version,directory,fetchImpl});this.last={currentVersion:version,status:'unchecked'};}
  state(){const{executable,...safe}=this.last;return{...safe,repository:UPDATE_REPOSITORY};}
  check(){if(this.checking)return this.checking;this.checking=this.performCheck().catch(()=>{this.last={currentVersion:this.version,status:'error',message:'无法检查GitHub更新，请稍后重试。'};return this.state();}).finally(()=>{this.checking=null;});return this.checking;}
  async performCheck(){const response=await this.fetchImpl(API,{headers:{accept:'application/vnd.github+json','user-agent':'Dafeiyu-Douyin-Updater'},redirect:'error',signal:AbortSignal.timeout(15000)});
    if(response.status===404){this.last={currentVersion:this.version,status:'unpublished',message:'仓库暂未发布可下载的软件版本。'};return this.state();}
    if(!response.ok)throw new Error('更新接口不可用');const release=await response.json();
    if(release.draft||release.prerelease||!parseVersion(release.tag_name))throw new Error('没有稳定的软件版本');
    const version=release.tag_name.replace(/^v/,''),name=`Dafeiyu-Douyin-API-${version}-win-x64.exe`,asset=release.assets?.find(item=>item.name===name),checksum=release.assets?.find(item=>item.name===name+'.sha256');
    if(!newerVersion(version,this.version)){this.last={currentVersion:this.version,latestVersion:version,status:'current',message:'当前已是本机所需的最新版本。'};return this.state();}
    if(!asset||!checksum||!githubAsset(asset.browser_download_url,name)||!githubAsset(checksum.browser_download_url,name+'.sha256')||!Number.isSafeInteger(asset.size)||asset.size<1024||asset.size>500*1024*1024)throw new Error('发布包或校验文件不完整');
    this.candidate={version,name,url:asset.browser_download_url,checksum:checksum.browser_download_url,size:asset.size};
    this.last={currentVersion:this.version,latestVersion:version,status:'available',name,bytes:asset.size,message:`发现${version}，可下载并核对完整性。`};return this.state();
  }
  async response(url){let current=url;for(let attempt=0;attempt<6;attempt++){const parsed=new URL(current);if(parsed.protocol!=='https:'||parsed.username||parsed.password||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(parsed.hostname))throw new Error('更新下载地址未通过核对');const response=await this.fetchImpl(current,{headers:{'user-agent':'Dafeiyu-Douyin-Updater'},redirect:'manual',signal:AbortSignal.timeout(120000)});if([301,302,303,307,308].includes(response.status)){current=new URL(response.headers.get('location'),current).href;continue;}if(!response.ok)throw new Error('更新下载未完成');return response;}throw new Error('更新跳转过多');}
  download(){if(this.downloading)return this.downloading;this.downloading=this.performDownload().catch(()=>{this.last={...this.last,status:'error',message:'更新下载或SHA256校验失败，未运行文件；可重新检查更新。'};return this.state();}).finally(()=>{this.downloading=null;});return this.downloading;}
  async performDownload(){if(!this.candidate||!['available','downloaded'].includes(this.last.status))throw new Error('请先检查更新');const candidate={...this.candidate};
    const checksumResponse=await this.response(candidate.checksum),checksumChunks=[];let checksumLength=0;for await(const bytes of checksumResponse.body){checksumLength+=bytes.length;if(checksumLength>2048)throw new Error('校验文件过长');checksumChunks.push(Buffer.from(bytes));}const checksum=Buffer.concat(checksumChunks).toString('utf8').trim().split(/\s+/)[0].toLowerCase();if(!/^[a-f0-9]{64}$/.test(checksum))throw new Error('没有有效SHA256');
    await fs.mkdir(this.directory,{recursive:true});const temporary=path.join(this.directory,`.download-${randomUUID()}.tmp`),target=path.join(this.directory,candidate.name);let handle;
    try{handle=await fs.open(temporary,'wx',0o600);const response=await this.response(candidate.url),hash=createHash('sha256');let size=0,first=Buffer.alloc(0);
      for await(const bytes of response.body){const buffer=Buffer.from(bytes);if(first.length<2)first=Buffer.concat([first,buffer.subarray(0,2-first.length)]);size+=buffer.length;if(size>candidate.size||size>500*1024*1024)throw new Error('文件长度超过发布声明');hash.update(buffer);await handle.writeFile(buffer);}
      await handle.close();handle=null;if(size!==candidate.size||first.toString('ascii')!=='MZ'||hash.digest('hex')!==checksum)throw new Error('下载完整性核对失败');
      await fs.rename(temporary,target);this.last={...this.last,status:'downloaded',executable:target,sha256:checksum,message:'下载和SHA256校验通过，可以重启到新版。'};return this.state();
    }finally{await handle?.close();await fs.rm(temporary,{force:true});}
  }
  async verifiedExecutable(){if(this.last.status!=='downloaded'||!this.last.executable)throw new Error('请先完成新版下载');const file=this.last.executable;if(path.dirname(file)!==path.resolve(this.directory)||createHash('sha256').update(await fs.readFile(file)).digest('hex')!==this.last.sha256)throw new Error('下载文件已改变，请重新检查更新');return{file,sha256:this.last.sha256};}
}
