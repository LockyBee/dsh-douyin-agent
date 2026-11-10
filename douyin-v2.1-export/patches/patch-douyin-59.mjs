import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\daily-report.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';

// 1) 引入 resolveRuntimePaths，让没有 stateDir 的构造也能找到噪声目录
const anchorImport = "import { BEHAVIOR_THRESHOLDS } from './persona-memory.mjs';" + NL;
if (t.split(anchorImport).length - 1 !== 1) throw new Error('import anchor');
t = t.replace(anchorImport, anchorImport + "import { resolveRuntimePaths } from './runtime-paths.mjs';" + NL);

// 2) 简化为直接调用（现在有 import 了）
const oldS = "    const base = this.stateDir || (typeof resolveRuntimePaths === 'function' ? resolveRuntimePaths().stateDir : null);";
const newS = "    const base = this.stateDir || resolveRuntimePaths().stateDir;";
if (t.split(oldS).length - 1 !== 1) throw new Error('base anchor');
t = t.replace(oldS, newS);

fs.writeFileSync(p, t, 'utf8');
console.log('patch59 done');
