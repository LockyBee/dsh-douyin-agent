import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';

const oldS = "              this.recordNoise({ videoId: observedState.video?.id || null, url: observedState.video?.url || null, title: (observedState.video?.title || '').slice(0, 300), author: observedState.video?.author || null, reason: decision.reason, topics: decision.topics });" + NL;

const newS = [
  "              const offtopicDaysBefore = this.offTopicDays(observedState.video?.id || null);",
  "              this.recordNoise({ videoId: observedState.video?.id || null, url: observedState.video?.url || null, title: (observedState.video?.title || '').slice(0, 300), author: observedState.video?.author || null, reason: decision.reason, topics: decision.topics, skipKind });",
  "              if (skipKind === 'offtopic' && offtopicDaysBefore >= 2) {",
  "                try {",
  "                  const ni = await this.execute('douyin_more', { press: 'R' });",
  "                  this.onEvent({ type: 'watch.auto_not_interested', videoId: observedState.video?.id || null, days: offtopicDaysBefore + 1, pressed: ni?.pressed || null });",
  "                } catch (error) { this.onEvent({ type: 'watch.auto_not_interested_failed', message: error && error.message ? error.message : '' }); }",
  "              }",
  ""
].join(NL);

const n = t.split(oldS).length - 1;
if (n !== 1) throw new Error('anchor occurrences=' + n);
t = t.replace(oldS, newS);
fs.writeFileSync(p, t, 'utf8');
console.log('patch56b done, chars:', t.length);
