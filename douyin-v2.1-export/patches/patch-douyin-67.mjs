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

// 1) 类型词表：只写“内容类型”，绝不写主题词
rep(
  "  offTopicDays(videoId) {" + NL,
  [
    "  offtopicType(text) {",
    "    const s = String(text || '');",
    "    const table = [",
    "      [/搞笑|段子|整活|剧情|沙雕/, '搞笑段子'],",
    "      [/剪辑|混剪|混辑|影视|电影|解说视频/, '影视剪辑混剪'],",
    "      [/带货|种草|同款|讲解|口播|链接|橱窗/, '口播带货'],",
    "      [/游戏|Steam|竞技场|英雄联盟|LOL|S16|手游/, '游戏解说'],",
    "      [/配音|声控|连麦|助眠|少御音|御姐音/, '声控配音'],",
    "      [/猫|狗|宠物|萌宠|豚鼠|仓鼠/, '宠物日常'],",
    "      [/图文|纯图|白底|文字图/, '图文段子'],",
    "      [/男性|男生|小哥哥|男cos|人夫/, '男性出镜'],",
    "      [/颓废|黑暗|压抑|阴间|丧|暗黑/, '颓废黑暗风格']",
    "    ];",
    "    for (const [re, tag] of table) if (re.test(s)) return tag;",
    "    return '离题内容';",
    "  }",
    "  offTopicDays(videoId) {"
  ].join(NL) + NL,
  'type-map'
);

// 2) 判 offtopic 时，把“类型”写进兴趣画像（负向证据）
rep(
  "              if (skipKind === 'offtopic') {" + NL + "                try {" + NL + "                  current = await this.execute('douyin_next');",
  [
    "              if (skipKind === 'offtopic') {",
    "                try {",
    "                  const typeTag = this.offtopicType(`${observedState.video?.title || ''} ${decision.reason || ''}`);",
    "                  this.personaMemory.updateAgentInterests({ evidenceId, topics: [{ topic: typeTag, signal: 'dislike' }], reflection: `类型离题（${typeTag}）：${decision.reason || ''}`.slice(0, 400) }, { source: this.source });",
    "                  this.onEvent({ type: 'watch.dislike_written', videoId: observedState.video?.id || null, topic: typeTag });",
    "                } catch (error) { this.onEvent({ type: 'watch.dislike_failed', message: error && error.message ? error.message : '' }); }",
    "                try {",
    "                  current = await this.execute('douyin_next');"
  ].join(NL) + NL,
  'write-dislike'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch67 done');
