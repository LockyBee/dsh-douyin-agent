import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');
const rep = (oldS, newS, tag) => {
  const n = t.split(oldS).length - 1;
  if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
  t = t.replace(oldS, newS);
  console.log(tag, 'ok');
};

// 主题模式启动：搜索或打开作品失败（例如落到图文）时退回推荐流，而不是直接停机
rep(
  "      if (initialOptions.mode === 'topic') {\n" +
  "        current = await this.execute('douyin_search', { query: initialOptions.topics[0] });\n" +
  "        const first = (current.state || current).searchResults?.find(item => Number.isSafeInteger(item.index) && /^\\d{10,30}$/.test(item.id));\n" +
  "        if (!first) throw failure('主题搜索没有可核实的作品结果，请更换主题后重试。', 'needs_user');\n" +
  "        current = await this.execute('douyin_open_video', { index: first.index });\n" +
  "      }\n",
  "      if (initialOptions.mode === 'topic') {\n" +
  "        try {\n" +
  "          current = await this.execute('douyin_search', { query: initialOptions.topics[0] });\n" +
  "          const first = (current.state || current).searchResults?.find(item => Number.isSafeInteger(item.index) && item.index >= 0);\n" +
  "          if (!first) throw failure('主题搜索没有可核实的作品结果，请更换主题后重试。', 'needs_user');\n" +
  "          current = await this.execute('douyin_open_video', { index: first.index });\n" +
  "        } catch (error) {\n" +
  "          this.onEvent({ type: 'watch.topic_fallback', message: '主题搜索或打开作品失败，改用推荐流继续：' + (error && error.message ? error.message : '') });\n" +
  "          current = await this.execute('douyin_open');\n" +
  "        }\n" +
  "      }\n",
  'topic-fallback'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch6 applied, chars:', t.length);
