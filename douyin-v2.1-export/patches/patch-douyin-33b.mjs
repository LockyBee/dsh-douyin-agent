import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\core.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';
const oldS = "      const r = (element || activeContainer).getBoundingClientRect();" + NL +
  "      livePreview = { recognized: true, source: 'active-feed-live-avatar'";
const newS = "      const host = element || activeContainer;" + NL +
  "      const r = host ? host.getBoundingClientRect() : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };" + NL +
  "      livePreview = { recognized: true, source: 'active-feed-live-avatar'";
const n = t.split(oldS).length - 1;
if (n !== 1) throw new Error('anchor occurrences=' + n);
t = t.replace(oldS, newS);
fs.writeFileSync(p, t, 'utf8');
console.log('patch33b done, chars:', t.length);
