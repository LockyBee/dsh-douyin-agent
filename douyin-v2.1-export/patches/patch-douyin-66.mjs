import fs from "node:fs";
const p="C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs";
let t=fs.readFileSync(p,"utf8");
const old="export const WATCH_VERSION = 'v2.0';";
const neu="export const WATCH_VERSION = 'v2.1';";
if(t.split(old).length-1!==1) throw new Error("anchor");
fs.writeFileSync(p,t.replace(old,neu),"utf8");
console.log("v2.0 -> v2.1 ok");
