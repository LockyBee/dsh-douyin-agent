import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\core.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';
const rep = (oldS, newS, tag) => {
  const n = t.split(oldS).length - 1;
  if (n !== 1) throw new Error(`${tag}: occurrences=${n}`);
  t = t.replace(oldS, newS);
  console.log(tag, 'ok');
};

const oldClick = [
  "          if (!(await loc.isVisible())) continue;",
  "          await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});",
  "          let done = false;",
  "          const btnBox = loc.locator('xpath=ancestor-or-self::button[1]');",
  "          try {",
  "            if (await btnBox.count()) {",
  "              await btnBox.first().hover({ timeout: 1200 }).catch(() => {});",
  "              await btnBox.first().click({ timeout: 2500 });",
  "              attempts.push('button#' + i); done = true;",
  "            }",
  "          } catch (error) { attempts.push('button#' + i + ':' + String((error && error.message) || error).slice(0, 60)); }",
  "          if (!done) {",
  "            await loc.hover({ timeout: 1200 }).catch(() => {});",
  "            await loc.click({ timeout: 2500 });",
  "            attempts.push('playwright#' + i); done = true;",
  "          }",
  "          clicked = done; if (done) break;"
].join(NL);

const newClick = [
  "          if (!(await loc.isVisible())) continue;",
  "          await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});",
  "          let done = false;",
  "          const btnBox = loc.locator('xpath=ancestor-or-self::button[1]');",
  "          try {",
  "            if (await btnBox.count()) {",
  "              await btnBox.first().hover({ timeout: 1200 }).catch(() => {});",
  "              await btnBox.first().click({ timeout: 2500 });",
  "              attempts.push('button#' + i); done = true;",
  "            }",
  "          } catch (error) { attempts.push('button#' + i + ':' + String((error && error.message) || error).slice(0, 60)); }",
  "          if (!done) {",
  "            const box = await loc.boundingBox().catch(() => null);",
  "            if (box && box.width > 0) {",
  "              try {",
  "                await this.page.mouse.click(box.x + box.width + 14, box.y + box.height / 2);",
  "                attempts.push('arrow-right#' + i); done = true;",
  "              } catch (error) { attempts.push('arrow-right#' + i + ':' + String((error && error.message) || error).slice(0, 60)); }",
  "            }",
  "          }",
  "          if (!done) {",
  "            await loc.hover({ timeout: 1200 }).catch(() => {});",
  "            await loc.click({ timeout: 2500 });",
  "            attempts.push('playwright#' + i); done = true;",
  "          }",
  "          clicked = done; if (done) break;"
].join(NL);

rep(oldClick, newClick, 'arrow-coordinate-click');

fs.writeFileSync(p, t, 'utf8');
console.log('patch20 done, chars:', t.length);
