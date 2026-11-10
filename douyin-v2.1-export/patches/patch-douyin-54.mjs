import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\dsh-plugin.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';
const oldS = "    if (!watchPromise) watchPromise=Promise.all([getController(),import('./autonomous-watch.mjs?v=18')]).then(async ([controller,{AutonomousWatch}])=>{";
const newS = "    if (starting) watchPromise=undefined; // 热重启：每次启动重新加载实现模块" + NL +
  "    if (!watchPromise) watchPromise=Promise.all([getController(),import(`./autonomous-watch.mjs?v=${starting ? Date.now() : 18}`)]).then(async ([controller,{AutonomousWatch}])=>{";
const n = t.split(oldS).length - 1;
if (n !== 1) throw new Error('anchor occurrences=' + n);
t = t.replace(oldS, newS);
fs.writeFileSync(p, t, 'utf8');
console.log('patch54 done (hot reload of watch module)');
