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

// 只在片尾最后 10 秒内才暂停
rep(
  "        try { current = await this.execute('douyin_pause'); this.onEvent({ type: 'watch.pause_before_model', videoId: observedState.video?.id || null }); }" + NL +
  "        catch (error) { this.onEvent({ type: 'watch.pause_failed', message: error && error.message ? error.message : '' }); }" + NL,
  "        const pauseVideo = observedState.video;" + NL +
  "        const nearEndForPause = Boolean(pauseVideo && Number.isFinite(pauseVideo.duration) && pauseVideo.duration > 0 && Number.isFinite(pauseVideo.time) && (pauseVideo.duration - pauseVideo.time) <= 10);" + NL +
  "        this.pausedForModel = false;" + NL +
  "        if (nearEndForPause) {" + NL +
  "          try { current = await this.execute('douyin_pause'); this.pausedForModel = true; this.onEvent({ type: 'watch.pause_before_model', videoId: pauseVideo.id || null, remaining: Number((pauseVideo.duration - pauseVideo.time).toFixed(1)) }); }" + NL +
  "          catch (error) { this.onEvent({ type: 'watch.pause_failed', message: error && error.message ? error.message : '' }); }" + NL +
  "        }" + NL,
  'pause-only-near-end'
);

// 只有真的暂停过才恢复
rep(
  "        try { current = await this.execute('douyin_play'); this.onEvent({ type: 'watch.resume_after_model', action: decision.action }); }" + NL +
  "        catch (error) { this.onEvent({ type: 'watch.resume_failed', message: error && error.message ? error.message : '' }); }" + NL,
  "        if (this.pausedForModel) {" + NL +
  "          this.pausedForModel = false;" + NL +
  "          try { current = await this.execute('douyin_play'); this.onEvent({ type: 'watch.resume_after_model', action: decision.action }); }" + NL +
  "          catch (error) { this.onEvent({ type: 'watch.resume_failed', message: error && error.message ? error.message : '' }); }" + NL +
  "        }" + NL,
  'resume-only-if-paused'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch13 applied, chars:', t.length);
