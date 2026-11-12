import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const rep = (oldS, newS, tag) => {
  const n = t.split(oldS).length - 1;
  if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
  t = t.replace(oldS, newS);
  console.log(tag, 'ok');
};

// 1) 事件落盘：包一层 onEvent
rep(
  "    Object.assign(this, { controller, config, videoLimits, personaMemory, shareService, decisionProvider, stateDir, source, now, delayImpl, onEvent });\n",
  "    Object.assign(this, { controller, config, videoLimits, personaMemory, shareService, decisionProvider, stateDir, source, now, delayImpl, onEvent });\n" +
  "    const eventSink = this.onEvent;\n" +
  "    this.onEvent = event => { this.logEvent(event); try { eventSink?.(event); } catch {} };\n",
  'event-sink'
);

// 2) 新增 logEvent 方法
rep(
  "  async openTopicCandidate(topic) {\n",
  "  logEvent(event) {\n" +
  "    try {\n" +
  "      if (!event || typeof event !== 'object') return;\n" +
  "      const dir = path.join(this.stateDir, 'events');\n" +
  "      fs.mkdirSync(dir, { recursive: true });\n" +
  "      const line = JSON.stringify({ at: new Date(this.now()).toISOString(), runId: this.runId || null, ...event });\n" +
  "      fs.appendFileSync(path.join(dir, day(this.now()) + '.jsonl'), line + '\\n');\n" +
  "    } catch (error) { /* 日志写入失败不影响观看 */ }\n" +
  "  }\n" +
  "  async openTopicCandidate(topic) {\n",
  'log-event'
);

// 3) 主题指针：成功时停在当前主题，只有该主题没片可挑才往后轮换
rep(
  "      if (opened) { this.topicCursor = (this.topicCursor + i + 1) % topics.length; return opened; }",
  "      if (opened) { this.topicCursor = (this.topicCursor + i) % topics.length; return opened; }",
  'cursor-stay'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch10 applied, chars:', t.length);
