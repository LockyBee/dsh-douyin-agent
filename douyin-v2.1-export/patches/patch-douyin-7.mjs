import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const rep = (oldS, newS, tag) => {
  const n = t.split(oldS).length - 1;
  if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
  t = t.replace(oldS, newS);
  console.log(tag, 'ok');
};

// 换片没换来可核对的作品：退回推荐流继续，而不是停机
rep(
  "            this.recordSwitchFailure('douyin_next',{...current,before:current.before||observedState.video,reasonCode},{startedAt:switchStartedAt,expectedVideoId:observedState.video.id,stage:'autonomous-verification'});\n" +
  "            throw failure('未确认切换到另一条就绪作品，已停止自主观看。');\n",
  "            this.recordSwitchFailure('douyin_next',{...current,before:current.before||observedState.video,reasonCode},{startedAt:switchStartedAt,expectedVideoId:observedState.video.id,stage:'autonomous-verification'});\n" +
  "            this.onEvent({ type: 'watch.switch_recover', reasonCode, message: '下一条没有换成可核对的作品，退回推荐流继续。' });\n" +
  "            current = await this.execute('douyin_open');\n" +
  "            continue;\n",
  'switch-recover'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch7 applied, chars:', t.length);
