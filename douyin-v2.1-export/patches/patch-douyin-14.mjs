import fs from 'node:fs';

const base = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\';
const coreP = base + 'core.mjs';
const defP = base + 'tool-definitions.mjs';

const patchFile = (p, edits) => {
  if (!fs.existsSync(p + '.bak-20261107')) { fs.copyFileSync(p, p + '.bak-20261107'); console.log('backup:', p.split('\\').pop()); }
  let t = fs.readFileSync(p, 'utf8');
  const NL = t.includes('\r\n') ? '\r\n' : '\n';
  for (const [oldS, newS, tag] of edits) {
    const n = t.split(oldS).length - 1;
    if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
    t = t.replace(oldS, newS);
    console.log(tag, 'ok');
  }
  fs.writeFileSync(p, t, 'utf8');
};

// 1) 工具定义：douyin_search 增加可选 tap
patchFile(defP, [[
  "properties: { query: { type: 'string', minLength: 1, maxLength: 300, description: '要搜索的关键词，不能为空，最多 300 字。' } }, required: ['query'], additionalProperties: false }",
  "properties: { query: { type: 'string', minLength: 1, maxLength: 300, description: '要搜索的关键词，不能为空，最多 300 字。' }, tap: { type: 'string', minLength: 1, maxLength: 12, description: '可选：搜索后按可见文字点击一个按钮（如「筛选」「视频」「最新」），只点白名单里的按钮。' } }, required: ['query'], additionalProperties: false }",
  'def-tap'
]]);

// 2) core：新增 tapByText 并在搜索后调用
const method = [
  "  async tapByText(label, signal) {",
  "    const allowed = ['筛选', '视频', '用户', '直播', '综合', '最新', '最多点赞', '一天内', '一周内', '多列', '单列'];",
  "    if (!allowed.includes(label)) return { ok: false, reason: 'not-allowed' };",
  "    const result = await this.page.evaluate(text => {",
  "      const nodes = [...document.querySelectorAll('button,span,div,a')].filter(el => el.childElementCount === 0 && (el.textContent || '').trim() === text);",
  "      const hit = nodes.find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });",
  "      if (!hit) return { ok: false, reason: 'not-found' };",
  "      const target = hit.closest('button') || hit;",
  "      target.click();",
  "      return { ok: true };",
  "    }, label).catch(error => ({ ok: false, reason: String((error && error.message) || error) }));",
  "    await wait(900, signal);",
  "    return result;",
  "  }",
  ""
].join('\n');

patchFile(coreP, [
  [
    "  async scrollSearchResults(signal, pages = 1) {",
    method + "  async scrollSearchResults(signal, pages = 1) {",
    'core-tap-method'
  ],
  [
    "          await this.scrollSearchResults(signal, 1);\n",
    "          await this.scrollSearchResults(signal, 1);\n          if (args.tap) await this.tapByText(args.tap, signal);\n",
    'core-tap-call'
  ]
]);

console.log('patch14 done');
