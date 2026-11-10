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

// 1) 新增：统计某作品被判 offtopic 的天数
rep(
  "  recordTaste(item) {" + NL,
  [
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
    "  recordTaste(item) {"
  ].join(NL) + NL,
  'offtopic-days-method'
);

// 2) 记账后：第 3 次判离题则自动点“不感兴趣”
rep(
  "              this.recordNoise({ videoId: observedState.video?.id || null, url: observedState.video?.url || null, title: (observedState.video?.title || '').slice(0, 300), author: observedState.video?.author || null, reason: decision.reason, topics: decision.topics, skipKind });" + NL,
  "              const offtopicDaysBefore = this.offTopicDays(observedState.video?.id || null);" + NL +
  "              this.recordNoise({ videoId: observedState.video?.id || null, url: observedState.video?.url || null, title: (observedState.video?.title || '').slice(0, 300), author: observedState.video?.author || null, reason: decision.reason, topics: decision.topics, skipKind });" + NL +
  "              if (skipKind === 'offtopic' && offtopicDaysBefore >= 2) {" + NL +
  "                try {" + NL +
  "                  const ni = await this.execute('douyin_more', { press: 'R' });" + NL +
  "                  this.onEvent({ type: 'watch.auto_not_interested', videoId: observedState.video?.id || null, days: offtopicDaysBefore + 1, pressed: ni?.pressed || null });" + NL +
  "                } catch (error) { this.onEvent({ type: 'watch.auto_not_interested_failed', message: error && error.message ? error.message : '' }); }" + NL +
  "              }" + NL,
  'auto-not-interested'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch56 done, chars:', t.length);
