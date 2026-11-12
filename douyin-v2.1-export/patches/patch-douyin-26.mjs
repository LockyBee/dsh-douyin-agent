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

// 1) 新增噪声记录方法
rep(
  "  async openTopicCandidate(topic) {" + NL,
  [
    "  recordNoise(item) {",
    "    try {",
    "      const dir = path.join(this.stateDir, 'noise');",
    "      fs.mkdirSync(dir, { recursive: true });",
    "      const line = JSON.stringify({ at: new Date(this.now()).toISOString(), runId: this.runId || null, ...item });",
    "      fs.appendFileSync(path.join(dir, day(this.now()) + '.jsonl'), line + '\\n');",
    "      this.onEvent({ type: 'watch.noise', videoId: item.videoId || null, author: item.author || null });",
    "    } catch (error) { /* 记录失败不影响观看 */ }",
    "  }",
    "  async openTopicCandidate(topic) {"
  ].join(NL) + NL,
  'noise-method'
);

// 2) 被动模式：开启标记 + 不再为思考暂停
rep(
  "      this.save({shareProgress:null,decisionRetry:null});" + NL,
  "      this.save({shareProgress:null,decisionRetry:null});" + NL +
  "      this.passiveWatch = true; // 被动模式：判断只记账，不打断播放" + NL,
  'passive-flag'
);

rep(
  "        if (nearEndForPause) {" + NL,
  "        if (!this.passiveWatch && nearEndForPause) {" + NL,
  'no-pause-in-passive'
);

// 3) 决策后：只记录，不导航、不等待停留
rep(
  "        let learned = false;" + NL,
  [
    "        let learned = false;",
    "        if (this.passiveWatch) {",
    "          if (decision.action === 'stay') {",
    "            if (viewing?.accepted === true) this.personaMemory.recordBehavior?.({ evidenceId, action: 'stay', confirmed: true, sampleId: `watch:${this.runId}:stay:${randomUUID()}` }, { source: this.source });",
    "            if (decision.topics.length) this.personaMemory.updateAgentInterests({ evidenceId, topics: decision.topics, reflection: decision.reflection }, { source: this.source });",
    "          } else if (decision.action === 'skip') {",
    "            this.recordNoise({ videoId: observedState.video?.id || null, url: observedState.video?.url || null, title: (observedState.video?.title || '').slice(0, 300), author: observedState.video?.author || null, reason: decision.reason, topics: decision.topics });",
    "          }",
    "          await this.delayImpl(6000, this.abort.signal);",
    "          this.assertAllowed();",
    "          current = await this.execute('douyin_status');",
    "          if ((current.state || current).video?.paused !== false) current = await this.execute('douyin_play');",
    "          continue;",
    "        }",
    ""
  ].join(NL) + NL,
  'passive-branch'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch26 done, chars:', t.length);
