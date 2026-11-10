import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const rep = (oldS, newS, tag) => {
  const n = t.split(oldS).length - 1;
  if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
  t = t.replace(oldS, newS);
  console.log(tag, 'ok');
};

// 决策前先暂停，避免模型思考期间被连播换走
rep(
  "        this.phase='model';this.pendingRequests=1;this.save({phase:this.phase,pendingRequests:1});let result,decisionError;\n",
  "        try { current = await this.execute('douyin_pause'); this.onEvent({ type: 'watch.pause_before_model', videoId: observedState.video?.id || null }); }\n" +
  "        catch (error) { this.onEvent({ type: 'watch.pause_failed', message: error && error.message ? error.message : '' }); }\n" +
  "        this.phase='model';this.pendingRequests=1;this.save({phase:this.phase,pendingRequests:1});let result,decisionError;\n",
  'pause-before-model'
);

// 决策拿到后恢复播放，再读状态做校验
rep(
  "        this.invalidDecisionStreak=0;this.save({decisionRetry:null});\n        current = await this.execute('douyin_status');\n",
  "        this.invalidDecisionStreak=0;this.save({decisionRetry:null});\n" +
  "        try { current = await this.execute('douyin_play'); this.onEvent({ type: 'watch.resume_after_model', action: decision.action }); }\n" +
  "        catch (error) { this.onEvent({ type: 'watch.resume_failed', message: error && error.message ? error.message : '' }); }\n" +
  "        current = await this.execute('douyin_status');\n",
  'resume-after-model'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch11 applied, chars:', t.length);
