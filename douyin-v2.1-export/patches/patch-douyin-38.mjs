import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const rep = (oldS, newS, tag) => {
  const n = t.split(oldS).length - 1;
  if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
  t = t.replace(oldS, newS);
  console.log(tag, 'ok');
};
rep("tap: '最新发布|一天内|视频#2'", "tap: '最新发布|一周内|视频#2'", 'tap-week');
rep("searchFilter: '最新发布+一天内+仅视频'", "searchFilter: '最新发布+一周内+仅视频'", 'version-text');
fs.writeFileSync(p, t, 'utf8');
console.log('patch38 done, chars:', t.length);
