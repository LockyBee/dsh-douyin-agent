import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';

// 1) 新增：跳出死循环时优先回到“主题搜索”，只有非主题模式才回推荐流
const anchor = "  async recoverTopic() {" + NL;
const helper = [
  "  async afterLoopBreak(videoId) {",
  "    this.onEvent({ type: 'watch.loop_break', videoId });",
  "    let mode = null;",
  "    try { mode = this.optionsService.state().policy.mode; } catch (error) { mode = null; }",
  "    if (mode === 'topic') return await this.recoverTopic();",
  "    return await this.execute('douyin_open');",
  "  }",
  ""
].join(NL);

const n1 = t.split(anchor).length - 1;
if (n1 !== 1) throw new Error('anchor recoverTopic=' + n1);
t = t.replace(anchor, helper + anchor);

// 2) 三处 loop_break 改成走 afterLoopBreak
const sites = [
  "if (afterSameId && afterSameId === v.id) { current = await this.execute('douyin_open'); this.onEvent({ type: 'watch.loop_break', videoId: v.id }); }",
  "if (afterId && afterId === observedState.video?.id) { current = await this.execute('douyin_open'); this.onEvent({ type: 'watch.loop_break', videoId: afterId }); }",
  "if (nextId && nextId === observedState.video?.id) { current = await this.execute('douyin_open'); this.onEvent({ type: 'watch.loop_break', videoId: nextId }); }"
];
const replacements = [
  "if (afterSameId && afterSameId === v.id) { current = await this.afterLoopBreak(v.id); }",
  "if (afterId && afterId === observedState.video?.id) { current = await this.afterLoopBreak(afterId); }",
  "if (nextId && nextId === observedState.video?.id) { current = await this.afterLoopBreak(nextId); }"
];
for (let i = 0; i < sites.length; i++) {
  const count = t.split(sites[i]).length - 1;
  if (count !== 1) throw new Error(`site${i} occurrences=${count}`);
  t = t.replace(sites[i], replacements[i]);
  console.log('site', i, 'ok');
}

fs.writeFileSync(p, t, 'utf8');
console.log('patch62 done');
