import fs from 'node:fs';

const base = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\';

// A. daily-report.mjs：新增离题清单
{
  const p = base + 'daily-report.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const NL = t.includes('\r\n') ? '\r\n' : '\n';
  const rep = (oldS, newS, tag) => {
    const n = t.split(oldS).length - 1;
    if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
    t = t.replace(oldS, newS);
    console.log(tag, 'ok');
  };

  // A1. 渲染：在“题材倾向”之前插入离题清单
  rep(
    "  lines.push('## 题材倾向', '', '以下按当日作品行为重新计数，不代表今天新产生的兴趣，也不把历史累计喜好算作今天的变化。', '');" + NL,
    [
      "  if (Array.isArray(summary.offtopic) && summary.offtopic.length) {",
      "    lines.push('## 离题清单（同类连续 3 天将自动标记“不感兴趣”）', '');",
      "    for (const row of summary.offtopic) lines.push(`- ${markdown(row.author || '未登记作者')} · ${markdown(row.title || '无文案作品')} · 第 ${row.days} 天 · ${row.auto ? '已自动处理' : '待累积'} · [打开作品](${row.url})`);",
      "    lines.push('');",
      "  }",
      "  lines.push('## 题材倾向', '', '以下按当日作品行为重新计数，不代表今天新产生的兴趣，也不把历史累计喜好算作今天的变化。', '');"
    ].join(NL) + NL,
    'render-offtopic'
  );

  // A2. 生成时把清单放进去
  rep(
    "      summary.interactions = this.interactions(selected);" + NL,
    "      summary.interactions = this.interactions(selected);" + NL + "      summary.offtopic = this.offtopic(selected);" + NL,
    'generate-offtopic'
  );

  // A3. 新增 offtopic 方法（放在 interactions 之前）
  rep(
    "  interactions(date) {" + NL,
    [
      "  offtopic(date) {",
      "    const base = this.stateDir || resolveRuntimePaths().stateDir;",
      "    if (!base) return null;",
      "    try {",
      "      const dir = path.join(base, 'noise');",
      "      if (!fs.existsSync(dir)) return [];",
      "      const entries = new Map();",
      "      for (const name of fs.readdirSync(dir).filter(item => /^\\d{4}-\\d{2}-\\d{2}\\.jsonl$/.test(item))) {",
      "        for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split('\\n')) {",
      "          if (!line.trim()) continue;",
      "          let row; try { row = JSON.parse(line); } catch { continue; }",
      "          if (!row.videoId) continue;",
      "          if (row.skipKind && row.skipKind !== 'offtopic') continue;",
      "          const entry = entries.get(row.videoId) || { videoId: row.videoId, days: new Set(), author: row.author || '', title: (row.title || '').slice(0, 60), url: row.url || `https://www.douyin.com/video/${row.videoId}`, today: false };",
      "          const dayKey = name.slice(0, 10);",
      "          entry.days.add(dayKey);",
      "          if (dayKey === date) { entry.today = true; entry.author = row.author || entry.author; entry.title = (row.title || entry.title || '').slice(0, 60); }",
      "          entries.set(row.videoId, entry);",
      "        }",
      "      }",
      "      return [...entries.values()].filter(item => item.today).map(item => ({ videoId: item.videoId, author: item.author, title: item.title, url: item.url, days: item.days.size, auto: item.days.size >= 3 })).sort((a, b) => b.days - a.days);",
      "    } catch (error) { return []; }",
      "  }",
      "  interactions(date) {"
    ].join(NL) + NL,
    'offtopic-method'
  );

  fs.writeFileSync(p, t, 'utf8');
}

// B. autonomous-watch.mjs：把 stateDir 传给日报
{
  const p = base + 'autonomous-watch.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const oldS = "if (!this.reportService && this.personaMemory.stateFile) this.reportService = new DailyReport({ personaMemory: this.personaMemory, now: this.now });";
  const newS = "if (!this.reportService && this.personaMemory.stateFile) this.reportService = new DailyReport({ personaMemory: this.personaMemory, now: this.now, stateDir: this.stateDir });";
  const n = t.split(oldS).length - 1;
  if (n !== 1) throw new Error('watch stateDir occurrences=' + n);
  t = t.replace(oldS, newS);
  fs.writeFileSync(p, t, 'utf8');
  console.log('watch-stateDir ok');
}

console.log('patch57 done');
