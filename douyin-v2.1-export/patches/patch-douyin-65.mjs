import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const oldS = "export const WATCH_VERSION = 'v1.1.251';";
const newS = "export const WATCH_VERSION = 'v2.0';";
const n = t.split(oldS).length - 1;
if (n !== 1) throw new Error('version anchor occurrences=' + n);
t = t.replace(oldS, newS);
fs.writeFileSync(p, t, 'utf8');
console.log('patch65 done: v1.1.251 -> v2.0');
