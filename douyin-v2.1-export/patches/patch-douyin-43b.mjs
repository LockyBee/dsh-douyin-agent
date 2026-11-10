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

fs.writeFileSync(p, t, 'utf8');
console.log('patch43b done, chars:', t.length);
