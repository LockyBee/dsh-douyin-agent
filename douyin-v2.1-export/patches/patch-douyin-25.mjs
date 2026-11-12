import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';
const rep = (oldS, newS, tag) => {
  const n = t.split(oldS).length - 1;
  if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
  t = t.replace(oldS, newS);
  console.log(tag, 'ok');
};

// 主题搜索时带上筛选：最新发布 + 仅视频
rep(
  "    const search = await this.execute('douyin_search', { query: topic });" + NL,
  "    const search = await this.execute('douyin_search', { query: topic, hover: '筛选', tap: '最新发布|视频#2' });" + NL,
  'topic-search-filter'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch25 done, chars:', t.length);
