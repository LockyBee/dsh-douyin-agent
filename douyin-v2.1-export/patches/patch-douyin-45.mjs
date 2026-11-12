import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';

const anchor = "        if (isLivePreview(current.state || current)) continue;" + NL;
const block = [
  "        {",
  "          const v = (current.state || current).video;",
  "          if (v?.id && Number.isFinite(v.time)) {",
  "            if (this.playRestartId === v.id && Number.isFinite(this.playRestartTime) && v.time < this.playRestartTime - 1) this.playRestartCount = (this.playRestartCount || 0) + 1;",
  "            else if (this.playRestartId !== v.id) this.playRestartCount = 0;",
  "            this.playRestartId = v.id; this.playRestartTime = v.time;",
  "            if ((this.playRestartCount || 0) >= 2) {",
  "              this.onEvent({ type: 'watch.replay_loop', videoId: v.id, restarts: this.playRestartCount });",
  "              this.playRestartCount = 0;",
  "              current = await this.execute('douyin_next');",
  "              const afterReplayId = (current.state || current).video?.id || null;",
  "              if (afterReplayId && afterReplayId === v.id) { current = await this.execute('douyin_open'); this.onEvent({ type: 'watch.loop_break', videoId: v.id }); }",
  "              continue;",
  "            }",
  "          }",
  "        }",
  ""
].join(NL);

const n = t.split(anchor).length - 1;
if (n !== 1) throw new Error('anchor occurrences=' + n);
t = t.replace(anchor, anchor.replace(anchor, block + anchor));
fs.writeFileSync(p, t, 'utf8');
console.log('patch45 done, chars:', t.length);
