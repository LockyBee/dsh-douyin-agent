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

// 1) 新增：当天已看集合的读写
rep(
  "  recordTaste(item) {" + NL,
  [
    "  loadSeenToday() {",
    "    try {",
    "      const file = path.join(this.stateDir, 'seen', day(this.now()) + '.json');",
    "      const list = JSON.parse(fs.readFileSync(file, 'utf8'));",
    "      if (Array.isArray(list)) return new Set(list.filter(item => typeof item === 'string' && /^\\d{10,30}$/.test(item)));",
    "    } catch (error) { /* 首次运行没有文件 */ }",
    "    return new Set();",
    "  }",
    "  saveSeenToday(set) {",
    "    try {",
    "      const dir = path.join(this.stateDir, 'seen');",
    "      fs.mkdirSync(dir, { recursive: true });",
    "      const list = [...set].filter(item => typeof item === 'string').slice(-5000);",
    "      fs.writeFileSync(path.join(dir, day(this.now()) + '.json'), JSON.stringify(list));",
    "    } catch (error) { /* 落盘失败不影响观看 */ }",
    "  }",
    "  recordTaste(item) {"
  ].join(NL) + NL,
  'seen-persist-methods'
);

// 2) 启动时载入当天已看集合
rep(
  "      this.passiveWatch = true; // 被动模式：判断只记账，不打断播放" + NL,
  "      this.passiveWatch = true; // 被动模式：判断只记账，不打断播放" + NL +
  "      this.searchSeen = this.loadSeenToday();" + NL,
  'seen-load-at-start'
);

// 3) 记录尝试时落盘
rep(
  "      seen.add(item.id);" + NL,
  "      seen.add(item.id); this.saveSeenToday(seen);" + NL,
  'seen-save-on-try'
);

// 4) 观察到作品时也落盘
rep(
  "        if (observedState.video?.id) (this.searchSeen ??= new Set()).add(observedState.video.id);" + NL,
  "        if (observedState.video?.id) { (this.searchSeen ??= new Set()).add(observedState.video.id); this.saveSeenToday(this.searchSeen); }" + NL,
  'seen-save-on-observe'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch40 done, chars:', t.length);
