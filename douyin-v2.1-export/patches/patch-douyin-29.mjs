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

// 判为“看过重复”时，主动滑到下一条；离题的仍然只记账不打断
rep(
  "            if (hasLike) {" + NL +
  "              this.onEvent({ type: 'watch.skip_duplicate', videoId: observedState.video?.id || null, author: observedState.video?.author || null });" + NL +
  "            } else {" + NL,
  "            if (hasLike) {" + NL +
  "              this.onEvent({ type: 'watch.skip_duplicate', videoId: observedState.video?.id || null, author: observedState.video?.author || null });" + NL +
  "              try { current = await this.execute('douyin_next'); this.onEvent({ type: 'watch.next_after_duplicate', changed: current?.changed !== false }); }" + NL +
  "              catch (error) { this.onEvent({ type: 'watch.next_failed', message: error && error.message ? error.message : '' }); }" + NL +
  "              await this.delayImpl(2000, this.abort.signal);" + NL +
  "              this.assertAllowed();" + NL +
  "              current = await this.execute('douyin_status');" + NL +
  "              if ((current.state || current).video?.paused !== false) current = await this.execute('douyin_play');" + NL +
  "              continue;" + NL +
  "            } else {" + NL,
  'skip-duplicate-next'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch29 done, chars:', t.length);
