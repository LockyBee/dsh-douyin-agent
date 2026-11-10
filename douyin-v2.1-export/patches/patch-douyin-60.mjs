import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';

const anchor = "  recordTaste(item) {" + NL;
const block = [
  "  offTopicDays(videoId) {",
  "    if (!videoId) return 0;",
  "    try {",
  "      const dir = path.join(this.stateDir, 'noise');",
  "      if (!fs.existsSync(dir)) return 0;",
  "      const days = new Set();",
  "      for (const name of fs.readdirSync(dir).filter(item => item.endsWith('.jsonl'))) {",
  "        const body = fs.readFileSync(path.join(dir, name), 'utf8');",
  "        if (!body.includes(videoId)) continue;",
  "        for (const line of body.split('\\n')) {",
  "          if (!line.includes(videoId)) continue;",
  "          let row; try { row = JSON.parse(line); } catch { continue; }",
  "          if (row.videoId !== videoId) continue;",
  "          if (row.skipKind && row.skipKind !== 'offtopic') continue;",
  "          days.add(name.slice(0, 10));",
  "        }",
  "      }",
  "      return days.size;",
  "    } catch (error) { return 0; }",
  "  }",
  ""
].join(NL);

const n = t.split(anchor).length - 1;
if (n !== 1) throw new Error('anchor occurrences=' + n);
t = t.replace(anchor, block + anchor);
fs.writeFileSync(p, t, 'utf8');
console.log('patch60 done: offTopicDays added');
