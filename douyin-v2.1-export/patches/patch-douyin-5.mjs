import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const rep = (oldS, newS, tag) => {
  const n = t.split(oldS).length - 1;
  if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
  t = t.replace(oldS, newS);
  console.log(tag, 'ok');
};

// 模型等待后的状态回读：不再因为 4 秒内没稳定就停机，交回调用方决定
rep(
  "      if (state.video?.paused === true) throw failure('模型等待后播放已暂停，未继续执行旧决策。', 'needs_user');\n" +
  "      if (attempt > 0 && this.now() > deadline) throw failure('模型等待后的作品状态仍未稳定，已停止自主观看。', 'needs_user');\n" +
  "      if (readyVideo(state) && state.video.paused === false) return current;\n" +
  "      if (attempt >= 16 || this.now() >= deadline) throw failure('模型等待后的作品状态仍未稳定，已停止自主观看。', 'needs_user');\n",
  "      if (readyVideo(state) && state.video?.paused === false) return current;\n" +
  "      if (state.video?.paused === true || attempt >= 16 || this.now() >= deadline) {\n" +
  "        this.onEvent({ type: 'watch.ready_giveup', message: '模型等待后作品状态未稳定，交回主循环重新观察。' });\n" +
  "        return current;\n" +
  "      }\n",
  'ready-tolerate'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch5 applied, chars:', t.length);
