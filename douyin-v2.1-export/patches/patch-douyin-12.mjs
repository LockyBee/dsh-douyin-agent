import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\core.mjs';
const bak = p + '.bak-20261107';
if (!fs.existsSync(bak)) { fs.copyFileSync(p, bak); console.log('backup created'); }
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
  "  async scrollSearchResults(signal, pages = 1) {",
  "    for (let i = 0; i < pages; i++) {",
  "      aborted(signal);",
  "      try {",
  "        await this.page.evaluate(() => {",
  "          const card = document.querySelector('.search-result-card,[data-e2e=\"search-card\"],[data-e2e=\"search-result\"]');",
  "          let node = card;",
  "          while (node && node !== document.body) {",
  "            const style = getComputedStyle(node);",
  "            if (/(auto|scroll)/.test(String(style.overflowY))) {",
  "              const step = Math.round(node.clientHeight * 0.85);",
  "              if (step > 0 && node.scrollHeight - node.scrollTop - node.clientHeight > 40) { node.scrollBy(0, step); return; }",
  "              break;",
  "            }",
  "            node = node.parentElement;",
  "          }",
  "          window.scrollBy(0, Math.round(innerHeight * 0.85));",
  "        });",
  "      } catch (error) { /* 滚动失败不影响搜索 */ }",
  "      await wait(700, signal);",
  "    }",
  "  }"
].join(NL) + NL;

rep(
  "  execute(name, args = {}, { signal, humanAuthorized = false, autonomousRunId, expectedVideoId, sharedCaptureMode } = {}) {" + NL,
  method + "  execute(name, args = {}, { signal, humanAuthorized = false, autonomousRunId, expectedVideoId, sharedCaptureMode } = {}) {" + NL,
  'scroll-method'
);

rep(
  "        if (name==='douyin_search') await this.navigate(`https://www.douyin.com/search/${encodeURIComponent(args.query)}`,signal);" + NL,
  "        if (name==='douyin_search') {" + NL +
  "          await this.navigate(`https://www.douyin.com/search/${encodeURIComponent(args.query)}`,signal);" + NL +
  "          await this.scrollSearchResults(signal, 1);" + NL +
  "        }" + NL,
  'search-scroll'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch12 applied, chars:', t.length);
