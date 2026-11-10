import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\api-agent.mjs';
let t = fs.readFileSync(p, 'utf8');
const oldS = "'recipientIds'].includes(key)";
const newS = "'recipientIds', 'skipKind'].includes(key)";
const n = t.split(oldS).length - 1;
if (n !== 1) throw new Error('anchor occurrences=' + n);
t = t.replace(oldS, newS);
fs.writeFileSync(p, t, 'utf8');
console.log('patch42b done');
