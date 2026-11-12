import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\core.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';
const oldS = "    const hasLiveAvatar = [...document.querySelectorAll('[data-e2e=\"live-avatar\"]')].some(visible);" + NL +
  "    if (hasLiveAvatar) {" + NL;
const newS = "    const hasLiveAvatar = [...document.querySelectorAll('[data-e2e=\"live-avatar\"]')].some(visible);" + NL +
  "    const hasLiveTag = [...document.querySelectorAll('div,span')].some(el => visible(el) && el.childElementCount === 0 && (el.textContent || '').trim() === '直播中' && (!activeContainer || activeContainer.contains(el)));" + NL +
  "    if (hasLiveAvatar || hasLiveTag) {" + NL;
const n = t.split(oldS).length - 1;
if (n !== 1) throw new Error('anchor occurrences=' + n);
t = t.replace(oldS, newS);
fs.writeFileSync(p, t, 'utf8');
console.log('patch32 done, chars:', t.length);
