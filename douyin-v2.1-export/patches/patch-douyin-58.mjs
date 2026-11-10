import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\daily-report.mjs';
let t = fs.readFileSync(p, 'utf8');
const oldS = "    const base = this.stateDir || resolveRuntimePaths().stateDir;";
const newS = "    const base = this.stateDir || (typeof resolveRuntimePaths === 'function' ? resolveRuntimePaths().stateDir : null);";
const n = t.split(oldS).length - 1;
if (n !== 1) throw new Error('anchor occurrences=' + n);
t = t.replace(oldS, newS);
fs.writeFileSync(p, t, 'utf8');
console.log('patch58 done (guard undefined resolver)');
