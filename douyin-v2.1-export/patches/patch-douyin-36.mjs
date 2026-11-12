import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\core.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';
const oldS = "    const changed=Boolean(afterIdentity&&afterIdentity!==beforeIdentity);" + NL;
const newS = "    let changed=Boolean(afterIdentity&&afterIdentity!==beforeIdentity);" + NL +
  "    // 从直播卡离开就算成功：直播卡没有作品 ID，落点又常被预加载判成歧义，不能只靠身份比对" + NL +
  "    if(!changed && before.pageKind==='live-preview' && after.pageKind!=='live-preview' && !blocked(after)) changed=true;" + NL;
const n = t.split(oldS).length - 1;
if (n !== 1) throw new Error('anchor occurrences=' + n);
t = t.replace(oldS, newS);
fs.writeFileSync(p, t, 'utf8');
console.log('patch36 done, chars:', t.length);
