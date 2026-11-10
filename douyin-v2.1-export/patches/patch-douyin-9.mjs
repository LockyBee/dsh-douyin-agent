import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const rep = (oldS, newS, tag) => {
  const n = t.split(oldS).length - 1;
  if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
  t = t.replace(oldS, newS);
  console.log(tag, 'ok');
};

// 1) 新增：按搜索结果列表 + 已看集合挑片，并轮换主题
const methods = [
  "  async openTopicCandidate(topic) {",
  "    const seen = (this.searchSeen ??= new Set());",
  "    const search = await this.execute('douyin_search', { query: topic });",
  "    const list = (search.state || search).searchResults || [];",
  "    const candidates = list.filter(item => Number.isSafeInteger(item.index) && /^\\d{10,30}$/.test(item.id || '') && !seen.has(item.id)).slice(0, 8);",
  "    this.onEvent({ type: 'watch.topic_list', topic, total: list.length, unseen: candidates.length });",
  "    for (const item of candidates) {",
  "      this.assertAllowed();",
  "      seen.add(item.id);",
  "      let opened = null;",
  "      try { opened = await this.execute('douyin_open_video', { index: item.index }); }",
  "      catch (error) { this.onEvent({ type: 'watch.topic_skip', topic, index: item.index, message: '打不开，试下一条：' + (error && error.message ? error.message : '') }); continue; }",
  "      if (readyVideo(opened.state || opened)) { this.onEvent({ type: 'watch.topic_open', topic, index: item.index, unseenLeft: candidates.length - 1 }); return opened; }",
  "      this.onEvent({ type: 'watch.topic_skip', topic, index: item.index, message: '不是可播放作品' });",
  "    }",
  "    return null;",
  "  }",
  "  async recoverTopic() {",
  "    const options = this.optionsService.state().policy;",
  "    const topics = (options.topics || []).filter(Boolean);",
  "    if (options.mode !== 'topic' || !topics.length) return await this.execute('douyin_open');",
  "    (this.searchSeen ??= new Set());",
  "    this.topicCursor ??= 0;",
  "    for (let i = 0; i < topics.length; i++) {",
  "      this.assertAllowed();",
  "      const topic = topics[(this.topicCursor + i) % topics.length];",
  "      let opened = null;",
  "      try { opened = await this.openTopicCandidate(topic); }",
  "      catch (error) { this.onEvent({ type: 'watch.topic_error', topic, message: error && error.message ? error.message : '' }); continue; }",
  "      if (opened) { this.topicCursor = (this.topicCursor + i + 1) % topics.length; return opened; }",
  "    }",
  "    this.onEvent({ type: 'watch.topic_exhausted', message: '所有主题都没有未看过的可播作品，改回推荐流。' });",
  "    return await this.execute('douyin_open');",
  "  }",
  ""
].join('\n');

rep(
  "  async run() {\n    let status = 'stopped', lastError = '';",
  methods + "  async run() {\n    let status = 'stopped', lastError = '';",
  'methods'
);

// 2) 开局主题挑选改为统一走 recoverTopic
const oldStartup = [
  "      const initialOptions = this.optionsService.state().policy;",
  "      if (initialOptions.mode === 'topic') {",
  "        try {",
  "          current = await this.execute('douyin_search', { query: initialOptions.topics[0] });",
  "          const candidates = ((current.state || current).searchResults || []).filter(item => Number.isSafeInteger(item.index) && /^\\d{10,30}$/.test(item.id || '')).slice(0, 6);",
  "          if (!candidates.length) throw failure('主题搜索没有可核实的作品结果，请更换主题后重试。', 'needs_user');",
  "          let opened = null;",
  "          for (const item of candidates) {",
  "            this.assertAllowed();",
  "            let attempt = null;",
  "            try { attempt = await this.execute('douyin_open_video', { index: item.index }); }",
  "            catch (error) { this.onEvent({ type: 'watch.topic_retry', index: item.index, message: '这条打不开（可能是图文），试下一条：' + (error && error.message ? error.message : '') }); continue; }",
  "            if (readyVideo(attempt.state || attempt)) { opened = attempt; break; }",
  "            this.onEvent({ type: 'watch.topic_retry', index: item.index, message: '这条不是可播放作品，试下一条。' });",
  "          }",
  "          if (!opened) throw failure('主题搜索的作品都打不开。', 'needs_user');",
  "          current = opened;",
  "        } catch (error) {",
  "          this.onEvent({ type: 'watch.topic_fallback', message: '主题搜索或打开作品失败，改用推荐流继续：' + (error && error.message ? error.message : '') });",
  "          current = await this.execute('douyin_open');",
  "        }",
  "      }",
  ""
].join('\n');
rep(oldStartup,
  "      const initialOptions = this.optionsService.state().policy;\n" +
  "      if (initialOptions.mode === 'topic') current = await this.recoverTopic();\n",
  'startup'
);

// 3) 观察到的作品记入已看集合
rep(
  "        const observedAt = this.now(), observedState = observation.state || observation;\n",
  "        const observedAt = this.now(), observedState = observation.state || observation;\n" +
  "        if (observedState.video?.id) (this.searchSeen ??= new Set()).add(observedState.video.id);\n",
  'seen-mark'
);

// 4) 非视频卡兜底：搜索页改为回主题，而不是推荐流
rep(
  "            current = st.pageKind === 'search' ? await this.execute('douyin_open') : await this.execute('douyin_next');",
  "            current = st.pageKind === 'search' ? await this.recoverTopic() : await this.execute('douyin_next');",
  'non-video'
);

// 5) 换片落空（没有视频）兜底
rep(
  "              this.onEvent({ type: 'watch.switch_recover', pageKind: cur.pageKind, message: '换片后没有就绪视频（可能是图文），自动回推荐流继续。' });\n              current = await this.execute('douyin_open');\n",
  "              this.onEvent({ type: 'watch.switch_recover', pageKind: cur.pageKind, message: '换片后没有就绪视频（可能是图文），回主题重新挑片。' });\n              current = await this.recoverTopic();\n",
  'switch-recover-1'
);

// 6) 换片未确认兜底
rep(
  "            this.onEvent({ type: 'watch.switch_recover', reasonCode, message: '下一条没有换成可核对的作品，退回推荐流继续。' });\n            current = await this.execute('douyin_open');\n",
  "            this.onEvent({ type: 'watch.switch_recover', reasonCode, message: '下一条没有换成可核对的作品，回主题重新挑片。' });\n            current = await this.recoverTopic();\n",
  'switch-recover-2'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch9 applied, chars:', t.length);
