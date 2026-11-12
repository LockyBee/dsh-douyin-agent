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

// 1) recoverTopic 支持“先跳到下一个主题”
rep(
  "  async recoverTopic() {" + NL,
  "  async recoverTopic({ advance = false } = {}) {" + NL,
  'recover-signature'
);

rep(
  "    this.topicCursor ??= 0;" + NL,
  "    this.topicCursor ??= 0;" + NL +
  "    if (advance) this.topicCursor = (this.topicCursor + 1) % topics.length;" + NL,
  'recover-advance'
);

// 2) 跳出循环时推进主题，避免同一主题原地打转
rep(
  "    if (mode === 'topic') return await this.recoverTopic();",
  "    if (mode === 'topic') return await this.recoverTopic({ advance: true });",
  'loopbreak-advance'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch64 done');
