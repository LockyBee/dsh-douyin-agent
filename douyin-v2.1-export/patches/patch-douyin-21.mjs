import fs from 'node:fs';

const base = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\';
const NL_OF = s => (s.includes('\r\n') ? '\r\n' : '\n');

const allowedList = "['筛选', '视频', '用户', '直播', '综合', '最新', '最多点赞', '一天内', '一周内', '多列', '单列', '综合排序', '最新发布', '半年内', '1分钟以下', '1-5分钟', '5分钟以上', '关注的人', '最近看过', '还未看过', '图文', '不限', '排序依据', '发布时间', '视频时长', '搜索范围', '内容形式']";

// --- tool-definitions.mjs ---
{
  const p = base + 'tool-definitions.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const NL = NL_OF(t);
  const oldS = "tap: { type: 'string', minLength: 1, maxLength: 12, description: '可选：搜索后按可见文字点击一个按钮（如「筛选」「视频」「最新」），只点白名单里的按钮。' }";
  const newS = oldS + ", hover: { type: 'string', minLength: 1, maxLength: 12, description: '可选：搜索后把鼠标悬停到某个文字上（如「筛选」），用于展开悬停触发的菜单；悬停发生在点击之前。' }";
  if (t.split(oldS).length - 1 !== 1) throw new Error('def tap property not found uniquely');
  t = t.replace(oldS, newS);
  fs.writeFileSync(p, t, 'utf8');
  console.log('def hover ok');
}

// --- core.mjs ---
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

  // 扩充白名单
  rep(
    "    const allowed = ['筛选', '视频', '用户', '直播', '综合', '最新', '最多点赞', '一天内', '一周内', '多列', '单列'];" + NL,
    "    const allowed = " + allowedList + ";" + NL,
    'whitelist-tap'
  );

  // 新增 hoverByText
  const hoverMethod = [
    "  async hoverByText(label, signal) {",
    "    const allowed = " + allowedList + ";",
    "    if (!allowed.includes(label)) return { ok: false, reason: 'not-allowed' };",
    "    const target = this.page.getByText(label, { exact: true });",
    "    const count = await target.count().catch(() => 0);",
    "    for (let i = 0; i < Math.min(count, 4); i++) {",
    "      const loc = target.nth(i);",
    "      try {",
    "        if (!(await loc.isVisible())) continue;",
    "        await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});",
    "        await loc.hover({ timeout: 2000 });",
    "        await wait(700, signal);",
    "        return { ok: true, hovered: i, label };",
    "      } catch (error) { continue; }",
    "    }",
    "    return { ok: false, reason: 'not-found', label };",
    "  }"
  ].join(NL) + NL;

  rep(
    "  async tapByText(label, signal) {" + NL,
    hoverMethod + "  async tapByText(label, signal) {" + NL,
    'hover-method'
  );

  // 在 tap 之前执行 hover
  rep(
    "          if (args.tap) this.lastTapResult = await this.tapByText(args.tap, signal);" + NL,
    "          if (args.hover) this.lastHoverResult = await this.hoverByText(args.hover, signal);" + NL +
    "          if (args.tap) this.lastTapResult = await this.tapByText(args.tap, signal);" + NL,
    'hover-call'
  );

  // 把 hover 结果带回状态
  rep(
    "        if (this.lastTapResult) { finalState.tapResult = this.lastTapResult; this.lastTapResult = null; }" + NL,
    "        if (this.lastTapResult) { finalState.tapResult = this.lastTapResult; this.lastTapResult = null; }" + NL +
    "        if (this.lastHoverResult) { finalState.hoverResult = this.lastHoverResult; this.lastHoverResult = null; }" + NL,
    'hover-return'
  );

  fs.writeFileSync(p, t, 'utf8');
  console.log('core hover ok, chars:', t.length);
}

console.log('patch21 done');
