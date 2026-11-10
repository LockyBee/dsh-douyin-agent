import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');

const oldBlock = [
  "          if (current.changed === false || !readyVideo(current.state || current) || (current.state || current).video.id === observedState.video.id) {",
  "            const reasonCode = current.reasonCode || (!readyVideo(current.state || current) ? 'autonomous-switch-not-ready' : (current.state || current).video.id === observedState.video.id ? 'autonomous-switch-same-id' : 'autonomous-switch-changed-false');",
  "            this.recordSwitchFailure('douyin_next',{...current,before:current.before||observedState.video,reasonCode},{startedAt:switchStartedAt,expectedVideoId:observedState.video.id,stage:'autonomous-verification'});",
  "            throw failure('未确认切换到另一条就绪作品，已停止自主观看。');",
  "          }",
  ""
].join('\n');

const newBlock = [
  "          if (current.changed === false || !readyVideo(current.state || current) || (current.state || current).video.id === observedState.video.id) {",
  "            const cur = current.state || current;",
  "            if (!cur.loginRequired && !cur.verificationRequired && !cur.privateChatVisible && !cur.unsupportedPage && !readyVideo(cur)) {",
  "              // 换片落到图文等没有视频的作品：不停机，退回推荐流继续刷。",
  "              this.onEvent({ type: 'watch.switch_recover', pageKind: cur.pageKind, message: '换片后没有就绪视频（可能是图文），自动回推荐流继续。' });",
  "              current = await this.execute('douyin_open');",
  "              continue;",
  "            }",
  "            const reasonCode = current.reasonCode || (!readyVideo(current.state || current) ? 'autonomous-switch-not-ready' : (current.state || current).video.id === observedState.video.id ? 'autonomous-switch-same-id' : 'autonomous-switch-changed-false');",
  "            this.recordSwitchFailure('douyin_next',{...current,before:current.before||observedState.video,reasonCode},{startedAt:switchStartedAt,expectedVideoId:observedState.video.id,stage:'autonomous-verification'});",
  "            throw failure('未确认切换到另一条就绪作品，已停止自主观看。');",
  "          }",
  ""
].join('\n');

const n = t.split(oldBlock).length - 1;
if (n !== 1) throw new Error('target occurrences=' + n);
t = t.replace(oldBlock, newBlock);
fs.writeFileSync(p, t, 'utf8');
console.log('patch3 applied, chars:', t.length);
