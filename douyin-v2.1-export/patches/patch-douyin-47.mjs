import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';

const oldBlock = [
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
  "        }"
].join(NL);

const newBlock = [
  "        {",
  "          const v = (current.state || current).video;",
  "          if (v?.id && /^\\d{10,30}$/.test(v.id)) {",
  "            if (this.sameVideoId === v.id) this.sameVideoCount = (this.sameVideoCount || 0) + 1;",
  "            else { this.sameVideoId = v.id; this.sameVideoCount = 1; }",
  "            const shortClip = Number.isFinite(v.duration) && v.duration > 0 && v.duration <= 20;",
  "            const sameLimit = shortClip ? 4 : 6;",
  "            if (this.sameVideoCount >= sameLimit) {",
  "              this.onEvent({ type: 'watch.replay_loop', videoId: v.id, count: this.sameVideoCount, duration: v.duration || null });",
  "              this.sameVideoCount = 0; this.sameVideoId = null;",
  "              current = await this.execute('douyin_next');",
  "              const afterSameId = (current.state || current).video?.id || null;",
  "              if (afterSameId && afterSameId === v.id) { current = await this.execute('douyin_open'); this.onEvent({ type: 'watch.loop_break', videoId: v.id }); }",
  "              continue;",
  "            }",
  "          } else { this.sameVideoId = null; this.sameVideoCount = 0; }",
  "        }"
].join(NL);

const n = t.split(oldBlock).length - 1;
if (n !== 1) throw new Error('replay block occurrences=' + n);
t = t.replace(oldBlock, newBlock);
fs.writeFileSync(p, t, 'utf8');
console.log('patch47 done, chars:', t.length);
