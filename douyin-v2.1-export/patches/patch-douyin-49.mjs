import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';

const oldBlock = [
  "        {",
  "          const v = (current.state || current).video;",
  "          if (v?.id && /^\\d{10,30}$/.test(v.id)) {",
  "            if (this.sameVideoId === v.id) this.sameVideoCount = (this.sameVideoCount || 0) + 1;",
  "            else { this.sameVideoId = v.id; this.sameVideoCount = 1; }",
  "            const shortClip = Number.isFinite(v.duration) && v.duration > 0 && v.duration <= 20;",
  "            const sameLimit = 2;",
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

const newBlock = [
  "        {",
  "          const v = (current.state || current).video;",
  "          const t = Number(v?.time), dur = Number(v?.duration);",
  "          if (v?.id && /^\\d{10,30}$/.test(v.id) && Number.isFinite(t) && Number.isFinite(dur) && dur > 1) {",
  "            if (this.playCountId !== v.id) { this.playCountId = v.id; this.playCount = 0; this.playMaxTime = t; this.playCountStart = this.now(); }",
  "            else if (t > (this.playMaxTime || 0)) this.playMaxTime = t;",
  "            else if (t < (this.playMaxTime || 0) - dur * 0.5) { this.playCount = (this.playCount || 0) + 1; this.playMaxTime = t; this.onEvent({ type: 'watch.play_through', videoId: v.id, plays: this.playCount, duration: dur }); }",
  "            const tooLong = this.now() - (this.playCountStart || this.now()) > 150000;",
  "            if ((this.playCount || 0) >= 2 || tooLong) {",
  "              this.onEvent({ type: 'watch.replay_loop', videoId: v.id, plays: this.playCount || 0, tooLong, duration: dur });",
  "              this.playCountId = null; this.playCount = 0; this.playMaxTime = 0; this.playCountStart = 0;",
  "              current = await this.execute('douyin_next');",
  "              const afterSameId = (current.state || current).video?.id || null;",
  "              if (afterSameId && afterSameId === v.id) { current = await this.execute('douyin_open'); this.onEvent({ type: 'watch.loop_break', videoId: v.id }); }",
  "              continue;",
  "            }",
  "          } else { this.playCountId = null; this.playCount = 0; this.playMaxTime = 0; this.playCountStart = 0; }",
  "        }"
].join(NL);

const n = t.split(oldBlock).length - 1;
if (n !== 1) throw new Error('block occurrences=' + n);
t = t.replace(oldBlock, newBlock);
fs.writeFileSync(p, t, 'utf8');
console.log('patch49 done, chars:', t.length);
