const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const execFile = require('node:util').promisify(require('node:child_process').execFile);
module.exports = async function afterPack({ appOutDir }) {
  const resources = path.join(appOutDir, 'resources'), runtime = path.join(resources, 'api-runtime');
  for (const file of ['api-worker.mjs', 'app.mjs', 'core.mjs', 'runtime-paths.mjs', 'persona-memory.mjs', 'autonomous-watch.mjs', 'browser-launcher.mjs', 'autonomous-share.mjs', 'task-limits.mjs', 'outbound-send.mjs', 'spark-service.mjs', 'spark-agent.mjs', 'autonomous-comments.mjs', 'comment-browser.mjs', 'public-comment-agent.mjs', 'daily-report.mjs', 'watch-mode.mjs', 'media/index.mjs', 'media/key-store.mjs', 'public/index.html', 'node_modules/playwright-core/package.json', 'node_modules/yaml/package.json']) await fs.access(path.join(runtime, file));
  for (const file of ['node_modules/@deepseek-ai', 'node_modules/@agents-anywhere', 'state', '.env']) {
    try { await fs.access(path.join(runtime, file)); throw new Error('独立软件含不应分发的资源：' + file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const nodeRoot = path.join(resources, 'runtime', 'node'), node = path.join(nodeRoot, 'node.exe');
  const record = JSON.parse(await fs.readFile(path.join(nodeRoot, 'provenance.json'), 'utf8'));
  if (createHash('sha256').update(await fs.readFile(node)).digest('hex') !== record.nodeSha256) throw new Error('随包 Node 摘要不符。');
  const { TOOL_DEFINITIONS: expectedTools } = await import(pathToFileURL(path.resolve(__dirname, '../../tool-definitions.mjs')).href);
  const source = "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(':memory:');d.exec('create table test(value)');d.prepare('insert into test values(?)').run(27);if(d.prepare('select value from test').get().value!==27)throw new Error('sqlite');d.close();const{chromium}=await import('./playwright-runtime.mjs');if(!chromium.connectOverCDP)throw new Error('playwright');await import('./persona-memory.mjs');await import('./autonomous-watch.mjs');const{TOOL_DEFINITIONS}=await import('./tool-definitions.mjs');console.log(JSON.stringify({node:process.versions.node,sqlite:process.versions.sqlite,toolNames:TOOL_DEFINITIONS.map(t=>t.name),tools:TOOL_DEFINITIONS.length,independentApi:true}));";
  const { stdout } = await execFile(node, ['--input-type=module', '-e', source], { cwd: runtime, windowsHide: true, timeout: 30000 });
  const result = JSON.parse(stdout.trim());
  if (JSON.stringify(result.toolNames) !== JSON.stringify(expectedTools.map(tool => tool.name))) throw new Error('打包后的工具目录与源码不一致。');
  await fs.writeFile(path.join(appOutDir, '..', 'packaged-api-check.json'), JSON.stringify({ success: true, ...result }, null, 2) + '\n');
  console.log(`打包回读通过：独立 API、Node/SQLite、浏览器底座、人格/自主观看与 ${result.tools} 项领域定义；没有 DSH 运行包。`);
};
