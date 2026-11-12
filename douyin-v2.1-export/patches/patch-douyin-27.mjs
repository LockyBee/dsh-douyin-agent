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

// 1) 去重：同一个 videoId 一轮只记一次
rep(
  "  recordNoise(item) {" + NL +
  "    try {" + NL,
  "  recordNoise(item) {" + NL +
  "    try {" + NL +
  "      this.noiseSeen ??= new Set();" + NL +
  "      const key = item.videoId || item.url || '';" + NL +
  "      if (!key || this.noiseSeen.has(key)) return;" + NL +
  "      this.noiseSeen.add(key);" + NL,
  'noise-dedupe'
);

// 2) 只有真正离题（没有任何 like 主题）才记黑名单；看过的重复内容单独记事件
rep(
  "          } else if (decision.action === 'skip') {" + NL +
  "            this.recordNoise({ videoId: observedState.video?.id || null, url: observedState.video?.url || null, title: (observedState.video?.title || '').slice(0, 300), author: observedState.video?.author || null, reason: decision.reason, topics: decision.topics });" + NL +
  "          }" + NL,
  "          } else if (decision.action === 'skip') {" + NL +
  "            const hasLike = (decision.topics || []).some(item => item.signal === 'like');" + NL +
  "            if (hasLike) {" + NL +
  "              this.onEvent({ type: 'watch.skip_duplicate', videoId: observedState.video?.id || null, author: observedState.video?.author || null });" + NL +
  "            } else {" + NL +
  "              this.recordNoise({ videoId: observedState.video?.id || null, url: observedState.video?.url || null, title: (observedState.video?.title || '').slice(0, 300), author: observedState.video?.author || null, reason: decision.reason, topics: decision.topics });" + NL +
  "            }" + NL +
  "          }" + NL,
  'noise-only-offtopic'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch27 done, chars:', t.length);
