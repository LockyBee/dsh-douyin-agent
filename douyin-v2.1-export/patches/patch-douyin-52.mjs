import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\core.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';

const oldS = [
  "          if (!opened || String(after.visibleText || '') === beforeText) {",
  "            const target = await this.currentVideo().catch(() => null);"
].join(NL) + NL;

const newS = [
  "          if (!opened || String(after.visibleText || '') === beforeText) {",
  "            const targetForRight = await this.currentVideo().catch(() => null);",
  "            if (targetForRight) {",
  "              const boxRight = await targetForRight.boundingBox().catch(() => null);",
  "              if (boxRight) {",
  "                try {",
  "                  await this.page.mouse.click(boxRight.x + boxRight.width / 2, boxRight.y + boxRight.height / 2, { button: 'right' });",
  "                  opened = true;",
  "                  await wait(900, signal);",
  "                  const rightAfter = await this.state({ record: false });",
  "                  if (String(rightAfter.visibleText || '') !== beforeText) after = rightAfter;",
  "                } catch (error) { /* 右键失败再试长按 */ }",
  "              }",
  "            }",
  "          }",
  "          if (!opened || String(after.visibleText || '') === beforeText) {",
  "            const target = await this.currentVideo().catch(() => null);"
].join(NL) + NL;

const n = t.split(oldS).length - 1;
if (n !== 1) throw new Error('anchor occurrences=' + n);
t = t.replace(oldS, newS);
fs.writeFileSync(p, t, 'utf8');
console.log('patch52 done, chars:', t.length);
