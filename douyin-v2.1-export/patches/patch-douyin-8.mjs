import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\autonomous-watch.mjs';
let t = fs.readFileSync(p, 'utf8');

const oldBlock = [
  "      if (initialOptions.mode === 'topic') {",
  "        try {",
  "          current = await this.execute('douyin_search', { query: initialOptions.topics[0] });",
  "          const first = (current.state || current).searchResults?.find(item => Number.isSafeInteger(item.index) && item.index >= 0);",
  "          if (!first) throw failure('主题搜索没有可核实的作品结果，请更换主题后重试。', 'needs_user');",
  "          current = await this.execute('douyin_open_video', { index: first.index });",
  "        } catch (error) {",
  "          this.onEvent({ type: 'watch.topic_fallback', message: '主题搜索或打开作品失败，改用推荐流继续：' + (error && error.message ? error.message : '') });",
  "          current = await this.execute('douyin_open');",
  "        }",
  "      }",
  ""
].join('\n');

const newBlock = [
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

const n = t.split(oldBlock).length - 1;
if (n !== 1) throw new Error('target occurrences=' + n);
t = t.replace(oldBlock, newBlock);
fs.writeFileSync(p, t, 'utf8');
console.log('patch8 applied, chars:', t.length);
