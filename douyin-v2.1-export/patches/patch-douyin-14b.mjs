import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\core.mjs';
if (!fs.existsSync(p + '.bak-20261107')) { fs.copyFileSync(p, p + '.bak-20261107'); console.log('backup created'); }
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';
console.log('line ending:', NL === '\r\n' ? 'CRLF' : 'LF');

const rep = (oldS, newS, tag) => {
  const n = t.split(oldS).length - 1;
  if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
  t = t.replace(oldS, newS);
  console.log(tag, 'ok');
};

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
  "  }"
].join(NL) + NL;

rep(
  "  async scrollSearchResults(signal, pages = 1) {" + NL,
  method + "  async scrollSearchResults(signal, pages = 1) {" + NL,
  'core-tap-method'
);

rep(
  "          await this.scrollSearchResults(signal, 1);" + NL,
  "          await this.scrollSearchResults(signal, 1);" + NL + "          if (args.tap) await this.tapByText(args.tap, signal);" + NL,
  'core-tap-call'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch14b done, chars:', t.length);
