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

// 1) 版本常量
rep(
  "export const WATCH_LIMITS = Object.freeze({ sampleSeconds: 3, maxLiveSkips: 3 });" + NL,
  "export const WATCH_LIMITS = Object.freeze({ sampleSeconds: 3, maxLiveSkips: 3 });" + NL +
  "export const WATCH_VERSION = 'v1';" + NL,
  'version-const'
);

// 2) 每轮开始写一条版本事件
rep(
  "      this.passiveWatch = true; // 被动模式：判断只记账，不打断播放" + NL,
  "      this.passiveWatch = true; // 被动模式：判断只记账，不打断播放" + NL +
  "      this.onEvent({ type: 'watch.version', version: WATCH_VERSION, passive: true, searchFilter: '最新发布+仅视频', sampleSeconds: WATCH_LIMITS.sampleSeconds });" + NL,
  'version-event'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch28 done, chars:', t.length);
