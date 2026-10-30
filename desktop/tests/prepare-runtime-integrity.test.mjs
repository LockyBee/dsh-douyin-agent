import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import sync from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {prepareApiRuntime} from '../src/prepare-api-runtime.mjs';
import {DOMAIN_FILES} from '../scripts/stage-api-runtime.mjs';
const deep='node_modules/playwright-core/lib/tools/skills/playwright-component-testing/references/gallery-spec.md';
async function tree(directory){const hash=createHash('sha256');let files=0;async function visit(folder,prefix=''){for(const entry of (await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){if(!prefix&&entry.name==='.runtime-ready.json')continue;const relative=prefix?`${prefix}/${entry.name}`:entry.name,file=path.join(folder,entry.name);assert.equal(entry.isSymbolicLink(),false);if(entry.isDirectory())await visit(file,relative);else{files++;hash.update(relative);hash.update('\0');hash.update(await fs.readFile(file));hash.update('\0');}}}await visit(directory);return{runtimeId:hash.digest('hex'),files};}
async function fixture(t,{long=false}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dy-rcopy-')),seedDir=path.join(directory,'seed'),manifestFile=path.join(directory,'manifest.json');await fs.mkdir(seedDir);
  const files=new Set([...DOMAIN_FILES,'receipt-baseline.mjs','api-worker.mjs','media/index.mjs','media/key-store.mjs','public/index.html','node_modules/playwright-core/package.json','node_modules/yaml/package.json',deep]);
  for(const file of files){await fs.mkdir(path.dirname(path.join(seedDir,file)),{recursive:true});await fs.writeFile(path.join(seedDir,file),'synthetic public resource: '+file+'\n');}
  const manifest={version:1,...await tree(seedDir)},suffix=path.join('runtimes',manifest.runtimeId.slice(0,20),deep),length=252-directory.length-suffix.length-2,userData=long?path.join(directory,'u'.repeat(Math.max(1,length))):path.join(directory,'user');await fs.writeFile(manifestFile,JSON.stringify(manifest));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^dy-rcopy-/);await fs.rm(directory,{recursive:true,force:true});});
  return{directory,seedDir,userData,manifestFile,manifest,runtime:path.join(userData,'runtimes',manifest.runtimeId.slice(0,20)),run:()=>prepareApiRuntime({seedDir,userData,manifestFile})};
}
test('运行资源完整性：普通复制和缓存复用都匹配完整manifest，包含第41模块',async t=>{
  const f=await fixture(t);assert.equal(await f.run(),f.runtime);assert.deepEqual(await tree(f.runtime),{runtimeId:f.manifest.runtimeId,files:f.manifest.files});assert.ok(await fs.readFile(path.join(f.runtime,'receipt-baseline.mjs')));const before=await fs.readFile(path.join(f.runtime,'.runtime-ready.json'));assert.equal(await f.run(),f.runtime);assert.deepEqual(await fs.readFile(path.join(f.runtime,'.runtime-ready.json')),before);
});
test('运行资源完整性：Electron长路径实拷贝完整，临时名不长于最终目录',async t=>{
  if(process.platform!=='win32')return t.skip('仅Windows长路径回归');const f=await fixture(t,{long:true});
  const electron=process.env.RUNTIME_COPY_ELECTRON||fileURLToPath(new URL('../node_modules/electron/dist/electron.exe',import.meta.url));if(!sync.existsSync(electron))return t.skip('隔离Electron工具未安装');
  assert.ok(path.join(f.runtime,deep).length<=259);assert.ok(path.join(path.dirname(f.runtime),'.preparing-'+'a'.repeat(36),deep).length>260);
  const probe=path.join(f.directory,'probe');await fs.mkdir(probe);await fs.writeFile(path.join(probe,'package.json'),JSON.stringify({name:'synthetic-runtime-copy-probe',version:'1.0.0',main:'main.cjs'}));
  const moduleUrl=process.env.RUNTIME_COPY_BASELINE_MODULE||new URL('../src/prepare-api-runtime.mjs',import.meta.url).href;
  const body=`const{app}=require('electron'),fs=require('node:fs/promises'),path=require('node:path');app.setPath('userData',${JSON.stringify(path.join(f.directory,'probe-user'))});app.whenReady().then(async()=>{const{prepareApiRuntime}=await import(${JSON.stringify(moduleUrl)});const runtime=await prepareApiRuntime(${JSON.stringify({seedDir:f.seedDir,userData:f.userData,manifestFile:f.manifestFile})});await fs.readFile(path.join(runtime,${JSON.stringify(deep)}));process.stdout.write(JSON.stringify({complete:true})+'\\n');app.exit(0);}).catch(error=>{process.stdout.write(JSON.stringify({complete:false,error:error.message})+'\\n');app.exit(1);});`;
  await fs.writeFile(path.join(probe,'main.cjs'),body);const allowed=['SystemRoot','WINDIR','PATH','Path','ComSpec','PATHEXT'];const env={...Object.fromEntries(allowed.filter(key=>process.env[key]!==undefined).map(key=>[key,process.env[key]])),HOME:f.directory,USERPROFILE:f.directory,APPDATA:path.join(f.directory,'app-data'),LOCALAPPDATA:path.join(f.directory,'local-app-data'),TEMP:f.directory,TMP:f.directory};
  const result=spawnSync(electron,[probe],{env,encoding:'utf8',timeout:30000,windowsHide:true});assert.equal(result.status,0,result.stdout+'\n'+result.stderr);assert.match(result.stdout,/"complete":true/);assert.deepEqual(await tree(f.runtime),{runtimeId:f.manifest.runtimeId,files:f.manifest.files});
});
test('运行资源完整性：已有ready但非required深层文件缺失时拒绝，旧树不自动删除',async t=>{
  const f=await fixture(t);await f.run();const flag=await fs.readFile(path.join(f.runtime,'.runtime-ready.json'));await fs.unlink(path.join(f.runtime,deep));await assert.rejects(f.run(),/摘要|文件数|资源/);assert.deepEqual(await fs.readFile(path.join(f.runtime,'.runtime-ready.json')),flag);assert.ok(await fs.stat(f.runtime));
});
test('运行资源完整性：缓存required正文篡改和额外文件不能借ready复用',async t=>{
  const f=await fixture(t);await f.run();const core=path.join(f.runtime,'core.mjs'),old=await fs.readFile(core);await fs.writeFile(core,'changed content');await assert.rejects(f.run(),/摘要|文件数/);await fs.writeFile(core,old);await fs.writeFile(path.join(f.runtime,'extra.txt'),'unexpected');await assert.rejects(f.run(),/额外|摘要|文件数/);
});
test('运行资源完整性：种子缺receipt模块、遗漏深层文档或摘要漂移均不生成ready',async t=>{
  for(const file of ['receipt-baseline.mjs',deep]){const f=await fixture(t);await fs.unlink(path.join(f.seedDir,file));await assert.rejects(f.run());assert.equal(sync.existsSync(path.join(f.runtime,'.runtime-ready.json')),false);}
  const f=await fixture(t);await fs.writeFile(path.join(f.seedDir,'core.mjs'),'seed drift');await assert.rejects(f.run(),/摘要|文件数/);assert.equal(sync.existsSync(f.runtime),false);
});
test('运行资源完整性：复制静默遗漏或ready写入失败都会清理本次短temp，不标就绪',async t=>{
  for(const mode of ['copy-omission','ready-write']){const f=await fixture(t),originalCopy=fs.cp,originalWrite=fs.writeFile;let temporary;
    fs.cp=async(from,to,options)=>{temporary=path.dirname(to);assert.ok(path.basename(temporary).length<=20);await originalCopy(from,to,options);if(mode==='copy-omission'&&sync.existsSync(path.join(temporary,deep)))await fs.unlink(path.join(temporary,deep));};
    fs.writeFile=async(file,...args)=>{if(mode==='ready-write'&&path.basename(file)==='.runtime-ready.json')throw Error('合成ready写入失败');return originalWrite(file,...args);};
    try{await assert.rejects(f.run());}finally{fs.cp=originalCopy;fs.writeFile=originalWrite;}
    assert.ok(temporary);assert.equal(sync.existsSync(temporary),false);assert.equal(sync.existsSync(path.join(f.runtime,'.runtime-ready.json')),false);assert.deepEqual(await fs.readdir(path.join(f.userData,'runtimes')),[]);
  }
});
test('运行资源完整性：种子和已缓存资源中的junction都拒绝，不跟随复制',async t=>{
  if(process.platform!=='win32')return t.skip('仅Windows junction回归');
  for(const cached of [false,true]){const f=await fixture(t);if(cached)await f.run();const base=cached?f.runtime:f.seedDir,folder=path.dirname(path.join(base,deep)),moved=path.join(f.directory,cached?'cached-docs':'seed-docs');await fs.rename(folder,moved);await fs.symlink(moved,folder,'junction');await assert.rejects(f.run(),/链接|资源/);assert.ok(await fs.readFile(path.join(moved,path.basename(deep))));}
});
test('运行资源完整性：无ready的旧目录不被覆盖，损坏manifest和相对路径拒绝',async t=>{
  const f=await fixture(t);await fs.mkdir(f.runtime,{recursive:true});await fs.writeFile(path.join(f.runtime,'keep.txt'),'keep unchanged');await assert.rejects(f.run(),/未完整就绪|未覆盖/);assert.equal(await fs.readFile(path.join(f.runtime,'keep.txt'),'utf8'),'keep unchanged');
  const other=await fixture(t);await fs.writeFile(other.manifestFile,JSON.stringify({...other.manifest,files:0}));await assert.rejects(other.run(),/文件数/);await assert.rejects(prepareApiRuntime({seedDir:'relative',userData:other.userData,manifestFile:other.manifestFile}),/绝对/);
});
