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

// 1) 播完不要重播：已结束就换下一条，只有中途暂停才恢复
rep(
  "        if ((current.state || current).video?.paused !== false) current = await this.execute('douyin_play');" + NL,
  [
    "        {",
    "          const curVideo = (current.state || current).video;",
    "          const atEnd = curVideo && Number.isFinite(curVideo.duration) && curVideo.duration > 0 && Number.isFinite(curVideo.time) && curVideo.time >= curVideo.duration - 0.3;",
    "          if (curVideo?.ended === true || (atEnd && curVideo.paused !== false)) {",
    "            this.onEvent({ type: 'watch.ended_next', videoId: curVideo.id || null });",
    "            current = await this.execute('douyin_next');",
    "          } else if (curVideo?.paused !== false) {",
    "            current = await this.execute('douyin_play');",
    "          }",
    "        }"
  ].join(NL) + NL,
  'no-replay-after-end'
);

// 2) 重复跳走后仍停在同一条：回推荐流重开，避免死循环
rep(
  "              try { current = await this.execute('douyin_next'); this.onEvent({ type: 'watch.next_after_duplicate', changed: current?.changed !== false }); }" + NL,
  "              try {" + NL +
  "                current = await this.execute('douyin_next');" + NL +
  "                const afterId = (current.state || current).video?.id || null;" + NL +
  "                this.onEvent({ type: 'watch.next_after_duplicate', changed: current?.changed !== false, sameId: afterId === (observedState.video?.id || null) });" + NL +
  "                if (afterId && afterId === observedState.video?.id) { current = await this.execute('douyin_open'); this.onEvent({ type: 'watch.loop_break', videoId: afterId }); }" + NL +
  "              }" + NL,
  'loop-break'
);

// 上一个 patch 留下的 catch 行要保留，这里补回
rep(
  "              }" + NL +
  "              catch (error) { this.onEvent({ type: 'watch.next_failed', message: error && error.message ? error.message : '' }); }" + NL,
  "              catch (error) { this.onEvent({ type: 'watch.next_failed', message: error && error.message ? error.message : '' }); }" + NL,
  'noop-verify'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch43 done, chars:', t.length);
