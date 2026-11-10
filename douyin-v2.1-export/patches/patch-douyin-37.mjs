import fs from 'node:fs';

const base = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\';
const NL_OF = s => (s.includes('\r\n') ? '\r\n' : '\n');

// 1) 放宽 tap 的 maxLength，容纳三个筛选项
{
  const p = base + 'tool-definitions.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const oldS = "tap: { type: 'string', minLength: 1, maxLength: 12,";
  const newS = "tap: { type: 'string', minLength: 1, maxLength: 40,";
  if (t.split(oldS).length - 1 !== 1) throw new Error('def tap maxLength not found');
  t = t.replace(oldS, newS);
  fs.writeFileSync(p, t, 'utf8');
  console.log('def maxlength ok');
}

// 2) 主题搜索叠加三个筛选 + 版本标记里的描述
{
  const p = base + 'autonomous-watch.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const rep = (oldS, newS, tag) => {
    const n = t.split(oldS).length - 1;
    if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
    t = t.replace(oldS, newS);
    console.log(tag, 'ok');
  };
  rep("tap: '最新发布|视频#2'", "tap: '最新发布|一天内|视频#2'", 'watch-tap-three');
  rep("searchFilter: '最新发布+仅视频'", "searchFilter: '最新发布+一天内+仅视频'", 'version-filter-text');
  fs.writeFileSync(p, t, 'utf8');
}

console.log('patch37 done');
