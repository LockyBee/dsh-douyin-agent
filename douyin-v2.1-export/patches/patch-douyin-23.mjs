import fs from 'node:fs';

const base = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\';
const NL_OF = s => (s.includes('\r\n') ? '\r\n' : '\n');

// --- tool-definitions: 增加 taps 数组 ---
{
  const p = base + 'tool-definitions.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const oldS = ", hover: { type: 'string', minLength: 1, maxLength: 12, description: '可选：搜索后把鼠标悬停到某个文字上（如「筛选」），用于展开悬停触发的菜单；悬停发生在点击之前。' }";
  const newS = oldS + ", taps: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 16 }, maxItems: 3, description: '可选：悬停后依次点击的多个按钮文字（最多 3 个），用于叠加筛选，例如先「最新发布」再「视频」。文字后加 #N 表示点第 N 个同名元素，如「视频#2」。' }";
  if (t.split(oldS).length - 1 !== 1) throw new Error('def hover prop not found');
  t = t.replace(oldS, newS);
  fs.writeFileSync(p, t, 'utf8');
  console.log('def taps ok');
}

// --- core ---
{
  const p = base + 'core.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const NL = NL_OF(t);
  const rep = (oldS, newS, tag) => {
    const n = t.split(oldS).length - 1;
    if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
    t = t.replace(oldS, newS);
    console.log(tag, 'ok');
  };

  // 支持 "文字#N" 选择第 N 个同名元素
  rep(
    "  async tapByText(label, signal) {" + NL,
    "  async tapByText(label, signal) {" + NL +
    "    const pickMatch = /^(.+)#(\\d+)$/.exec(label);" + NL +
    "    const wantIndex = pickMatch ? Math.max(0, Number(pickMatch[2]) - 1) : 0;" + NL +
    "    if (pickMatch) label = pickMatch[1];" + NL,
    'tap-index-parsing'
  );

  rep(
    "      for (let i = 0; i < Math.min(count, 4); i++) {" + NL +
    "        const loc = target.nth(i);" + NL,
    "      for (let i = wantIndex; i < Math.min(count, wantIndex + 2); i++) {" + NL +
    "        const loc = target.nth(i);" + NL,
    'tap-index-loop'
  );

  // 支持 taps 数组，按顺序点击
  rep(
    "          if (args.tap) this.lastTapResult = await this.tapByText(args.tap, signal);" + NL,
    "          const tapLabels = Array.isArray(args.taps) && args.taps.length ? args.taps.slice(0, 3) : (args.tap ? [args.tap] : []);" + NL +
    "          this.lastTapResults = [];" + NL +
    "          for (const label of tapLabels) { this.lastTapResult = await this.tapByText(label, signal); this.lastTapResults.push(this.lastTapResult); }" + NL,
    'taps-loop'
  );

  rep(
    "        if (this.lastTapResult) { finalState.tapResult = this.lastTapResult; this.lastTapResult = null; }" + NL,
    "        if (this.lastTapResult) { finalState.tapResult = this.lastTapResult; this.lastTapResult = null; }" + NL +
    "        if (Array.isArray(this.lastTapResults) && this.lastTapResults.length) { finalState.tapResults = this.lastTapResults.slice(); this.lastTapResults = []; }" + NL,
    'taps-return'
  );

  fs.writeFileSync(p, t, 'utf8');
  console.log('core taps ok, chars:', t.length);
}

console.log('patch23 done');
