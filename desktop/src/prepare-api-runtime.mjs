import fs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';

const exists = file => fs.access(file).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error));
const absolute = (value, label) => { if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`${label}必须是绝对路径。`); return path.normalize(value); };
const locationFields = { stateDir: 'DOUYIN_STATE_DIR', mediaEnvFile: 'DOUYIN_MEDIA_ENV_FILE', mediaSettingsFile: 'DOUYIN_MEDIA_SETTINGS_FILE', mediaRuntimeRoot: 'DOUYIN_MEDIA_RUNTIME_ROOT', mediaModelsDir: 'DOUYIN_MEDIA_MODELS_DIR' };

async function verifyRuntimeTree(directory,manifest,{ready=false}={}){
  const hash=createHash('sha256');let files=0;
  const root=await fs.lstat(directory);if(!root.isDirectory()||root.isSymbolicLink())throw new Error('运行资源目录不是普通目录，未确认就绪。');
  async function visit(folder,prefix=''){
    for(const entry of (await fs.readdir(folder,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
      const filename=path.join(folder,entry.name),relative=prefix?`${prefix}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink()||!entry.isDirectory()&&!entry.isFile())throw new Error('运行资源包含链接或特殊文件，未确认就绪。');
      if(!prefix&&entry.name==='.runtime-ready.json'){
        if(!ready||!entry.isFile())throw new Error('初始运行资源包含非预期就绪标记。');
        continue;
      }
      if(entry.isDirectory())await visit(filename,relative);
      else{
        if(++files>manifest.files)throw new Error('运行资源存在额外文件，未确认就绪。');
        const before=await fs.lstat(filename);if(!before.isFile()||before.isSymbolicLink())throw new Error('运行文件类型已变化，未确认就绪。');
        hash.update(relative);hash.update('\0');hash.update(await fs.readFile(filename));hash.update('\0');
        const after=await fs.lstat(filename);if(!after.isFile()||after.isSymbolicLink()||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino)throw new Error('运行文件在核对期间变化，未确认就绪。');
      }
    }
  }
  await visit(directory);
  if(files!==manifest.files||hash.digest('hex')!==manifest.runtimeId)throw new Error('运行资源完整摘要或文件数不符，未确认就绪。');
}

export async function prepareApiRuntime({seedDir,userData,manifestFile}){
  seedDir=absolute(seedDir,'初始运行资源');userData=absolute(userData,'软件用户目录');manifestFile=absolute(manifestFile,'软件资源清单');
  const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  if(!/^[a-f0-9]{64}$/.test(manifest.runtimeId)||!Number.isSafeInteger(manifest.files)||manifest.files<1||manifest.files>100000)throw new Error('软件资源摘要或文件数无效。');
  await fs.mkdir(userData,{recursive:true});
  const userStat=await fs.lstat(userData);if(!userStat.isDirectory()||userStat.isSymbolicLink())throw new Error('软件用户目录不能使用链接。');
  const runtimeRoot=path.join(userData,'runtimes');await fs.mkdir(runtimeRoot,{recursive:true});
  const rootStat=await fs.lstat(runtimeRoot);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw new Error('软件运行目录不能使用链接。');
  const rootReal=await fs.realpath(runtimeRoot),userReal=await fs.realpath(userData);if(path.dirname(rootReal)!==userReal)throw new Error('软件运行目录实际位置越界。');
  const runtime=path.join(runtimeRoot,manifest.runtimeId.slice(0,20)),ready=path.join(runtime,'.runtime-ready.json');
  const required=['friend-interactions.mjs','friend-interactions-guard.mjs','receipt-baseline.mjs','api-worker.mjs','app.mjs','api-agent.mjs','core.mjs','runtime-paths.mjs','persona-memory.mjs','autonomous-watch.mjs','browser-launcher.mjs','autonomous-share.mjs','task-limits.mjs','outbound-send.mjs','spark-service.mjs','spark-agent.mjs','autonomous-comments.mjs','comment-browser.mjs','public-comment-agent.mjs','daily-report.mjs','watch-mode.mjs','media/index.mjs','media/key-store.mjs','public/index.html','node_modules/playwright-core/package.json','node_modules/yaml/package.json'];
  const requiredFiles=async directory=>{for(const file of required){const stat=await fs.lstat(path.join(directory,file));if(!stat.isFile()||stat.isSymbolicLink())throw new Error('软件运行资源缺失或类型错误。');}};
  if(await exists(ready)){
    const stat=await fs.lstat(ready);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('就绪标记不能使用链接。');
    if(JSON.parse(await fs.readFile(ready,'utf8')).runtimeId!==manifest.runtimeId)throw new Error('软件资源版本不匹配。');
    await requiredFiles(runtime);await verifyRuntimeTree(runtime,manifest,{ready:true});return runtime;
  }
  if(await exists(runtime))throw new Error('软件运行资源尚未完整就绪，已保留原目录，未覆盖。');
  await requiredFiles(seedDir);await verifyRuntimeTree(seedDir,manifest);
  const temporary=await fs.mkdtemp(path.join(runtimeRoot,'.p-'));let renamed=false;
  const temporaryName=path.basename(temporary);
  if(path.dirname(path.resolve(temporary))!==path.resolve(runtimeRoot)||!/^\.p-[A-Za-z0-9]{6}$/.test(temporaryName)||temporaryName.length>20)throw new Error('软件临时目录名称或位置不符合约束。');
  try{
    for(const entry of await fs.readdir(seedDir,{withFileTypes:true})){
      if(entry.isSymbolicLink()||!entry.isDirectory()&&!entry.isFile())throw new Error('初始运行资源在复制前出现链接或特殊文件。');
      await fs.cp(path.join(seedDir,entry.name),path.join(temporary,entry.name),{recursive:true,dereference:false,force:false,errorOnExist:true});
    }
    await requiredFiles(temporary);await verifyRuntimeTree(temporary,manifest);
    await fs.writeFile(path.join(temporary,'.runtime-ready.json'),JSON.stringify({runtimeId:manifest.runtimeId})+'\n',{flag:'wx'});
    await fs.rename(temporary,runtime);renamed=true;
    try{await verifyRuntimeTree(runtime,manifest,{ready:true});}catch(error){await fs.unlink(ready);throw error;}
    return runtime;
  }finally{
    if(!renamed&&await exists(temporary)){
      const stat=await fs.lstat(temporary),resolved=await fs.realpath(temporary);
      if(!stat.isDirectory()||stat.isSymbolicLink()||path.dirname(resolved)!==rootReal||path.dirname(path.resolve(temporary))!==path.resolve(runtimeRoot)||!/^\.p-[A-Za-z0-9]{6}$/.test(path.basename(temporary)))throw new Error('软件临时目录清理边界无法核对，未递归删除。');
      await fs.rm(temporary,{recursive:true,force:true});
    }
  }
}

export async function ensureSharedLocation({ env = process.env, home = homedir(), resolve }) {
  const file = absolute(env.DOUYIN_RUNTIME_LOCATION_FILE || path.join(home, '.dsh', 'douyin-browser', 'runtime-location.json'), '共享位置记录');
  const common = path.join(home, '.dsh', 'douyin-browser');
  let record;
  if (await exists(file)) record = JSON.parse(await fs.readFile(file, 'utf8'));
  else {
    record = { version: 1, stateDir: path.join(common, 'state'), mediaEnvFile: path.join(common, 'media', '.env'), mediaSettingsFile: path.join(common, 'media', 'settings.local.json'), mediaRuntimeRoot: path.join(common, 'media'), mediaModelsDir: path.join(common, 'media', '.models') };
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; record = JSON.parse(await fs.readFile(file, 'utf8')); }
  }
  if (!record || record.version !== 1 || Array.isArray(record) || typeof record.stateDir !== 'string') throw new Error('共享位置记录无效，未创建另一套状态。');
  for (const field of [...Object.keys(locationFields), 'memoryDir', 'memoryDbPath']) if (record[field] !== undefined) absolute(record[field], field);
  const registeredDb = record.memoryDbPath || (record.memoryDir ? path.join(record.memoryDir, 'shared.sqlite') : null);
  if (env.DEEPSEEK_SHARED_MEMORY_DB && registeredDb && absolute(env.DEEPSEEK_SHARED_MEMORY_DB, '共享记忆数据库') !== path.normalize(registeredDb)) throw new Error('显式数据库路径与已登记的共享记忆不一致；已保留原记录，未创建另一套记忆。');
  const paths = resolve({ env: { ...env, DOUYIN_RUNTIME_LOCATION_FILE: file }, home });
  // 首次登记现有记忆位置，不迁移、复制或清空数据库。
  if (!record.memoryDir || !record.memoryDbPath) {
    record.memoryDir = paths.memoryDir;
    record.memoryDbPath = paths.memoryDbPath;
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  const domainEnv = { DOUYIN_RUNTIME_LOCATION_FILE: file, DEEPSEEK_SHARED_MEMORY_DB: paths.memoryDbPath };
  for (const [field, key] of Object.entries(locationFields)) domainEnv[key] = env[key] || paths[field];
  return { paths, env: domainEnv };
}

export async function verifyNode(node, provenanceFile) {
  const expected = JSON.parse(await fs.readFile(provenanceFile, 'utf8'));
  if (createHash('sha256').update(await fs.readFile(node)).digest('hex') !== expected.nodeSha256) throw new Error('随软件附带的 Node 运行程序校验失败。');
}
