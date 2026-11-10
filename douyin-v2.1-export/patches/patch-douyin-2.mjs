import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');

const oldBlock = [
  "          const sameVideo = afterState.video?.id === beforeState.video.id;",
  "          const nearEnd = v => Boolean(v && Number.isFinite(v.duration) && v.duration > 0 && Number.isFinite(v.time) && v.time >= v.duration - 1);",
  "          if (!sameVideo || afterState.video.paused !== false) {",
  "            if (!sameVideo && nearEnd(beforeState.video)) {",
  "              this.onEvent({ type: 'watch.natural_advance', message: '作品自然播完后已切到下一条，本次停留不计入偏好。' });",
  "              current = afterState; continue;",
  "            }",
  "            if (!(sameVideo && afterState.video.paused === true && nearEnd(afterState.video))) throw failure('停留期间作品或播放状态已变化，已停止自主观看，没有学习本次停留。', 'needs_user');",
  "          }",
  ""
].join('\n');

const newBlock = [
  "          const sameVideo = afterState.video?.id === beforeState.video.id;",
  "          if (!sameVideo || afterState.video.paused !== false) {",
  "            // 播完自动切下一条、被暂停、或作品已换：本次停留不计入偏好，但继续观察，不停机。",
  "            this.onEvent({ type: 'watch.stay_invalidated', message: '停留期间作品或播放状态已变化，本次停留不计入偏好，继续观察。' });",
  "            current = afterState; continue;",
  "          }",
  ""
].join('\n');

const n = t.split(oldBlock).length - 1;
if (n !== 1) throw new Error('target block occurrences=' + n);
t = t.replace(oldBlock, newBlock);
fs.writeFileSync(p, t, 'utf8');
console.log('patched, chars:', t.length);
