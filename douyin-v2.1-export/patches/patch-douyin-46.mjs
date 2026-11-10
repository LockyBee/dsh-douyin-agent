import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';
const oldS = "    this.onEvent({ type: 'watch.topic_exhausted', message: '所有主题都没有未看过的可播作品，改回推荐流。' });" + NL +
  "    return await this.execute('douyin_open');" + NL;
const newS = "    this.onEvent({ type: 'watch.topic_exhausted', message: '四个主题都没有未看过的可播作品，今天的观看已完成。' });" + NL +
  "    throw Object.assign(new Error('四个主题都搜不到未看过的可播作品，今天这一轮观看已完成；日报已生成，可以直接汇报。'), { watchStatus: 'stopped' });" + NL;
const n = t.split(oldS).length - 1;
if (n !== 1) throw new Error('anchor occurrences=' + n);
t = t.replace(oldS, newS);
fs.writeFileSync(p, t, 'utf8');
console.log('patch46 done, chars:', t.length);
