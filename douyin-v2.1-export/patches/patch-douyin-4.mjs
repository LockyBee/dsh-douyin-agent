import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const rep = (oldS, newS, tag) => {
  const n = t.split(oldS).length - 1;
  if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
  t = t.replace(oldS, newS);
  console.log(tag, 'ok');
};

// 1) 片尾作品先换下一条再采样，避免采到跨片帧
rep(
  "        const sampleStartedAt = this.now();\n        this.phase='observing';",
  "        {\n" +
  "          const nearState = current.state || current;\n" +
  "          const nearVideo = nearState.video;\n" +
  "          if (nearVideo && Number.isFinite(nearVideo.duration) && nearVideo.duration > 0 && Number.isFinite(nearVideo.time) && nearVideo.time >= nearVideo.duration - 1.5) {\n" +
  "            this.onEvent({ type: 'watch.near_end_skip', message: '当前作品已到片尾，先换下一条再采样。' });\n" +
  "            current = await this.execute('douyin_next');\n" +
  "            continue;\n" +
  "          }\n" +
  "        }\n" +
  "        const sampleStartedAt = this.now();\n        this.phase='observing';",
  'near-end-skip'
);

// 2) 采样帧跨片时不再停机，重新观察
rep(
  "        watchDecisionMessages(observation);\n",
  "        try { watchDecisionMessages(observation); }\n" +
  "        catch (error) { this.onEvent({ type: 'watch.sample_retry', message: error.message }); current = await this.execute('douyin_status'); continue; }\n",
  'sample-retry'
);

// 3) 模型等待期间作品变化且未就绪：放弃旧决策重新观察，而不是停机
rep(
  "          if (!readyVideo(freshState) || freshState.video.paused !== false) throw failure('模型等待后作品已变化，但新作品尚未就绪或已暂停，未执行旧决策。', 'needs_user');",
  "          if (!readyVideo(freshState) || freshState.video.paused !== false) { this.save({ lastDecision: null, usage: result.usage }); this.onEvent({ type: 'watch.decision-discarded', action: decision.action, reasonCode: 'observed-video-changed', expectedVideoId: observedState.video.id, message: '作品已变化且新作品尚未就绪，重新观察。' }); continue; }",
  'fresh-not-ready'
);

// 4) 停留前作品变化：放弃这次停留，重新观察
rep(
  "          if (beforeState.video?.id !== observedState.video.id || beforeState.video.paused !== false) throw failure('停留前作品或播放状态已变化，已停止自主观看，没有学习本次停留。', 'needs_user');",
  "          if (beforeState.video?.id !== observedState.video.id || beforeState.video.paused !== false) { this.onEvent({ type: 'watch.stay_deferred', message: '停留前作品或播放状态已变化，放弃这次停留，重新观察。' }); current = await this.execute('douyin_status'); continue; }",
  'pre-stay'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch4 applied, chars:', t.length);
