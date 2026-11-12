import fs from 'node:fs';

const p = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\core.mjs';
let t = fs.readFileSync(p, 'utf8');
const NL = t.includes('\r\n') ? '\r\n' : '\n';

const oldBlock = [
  "  async tapByText(label, signal) {",
  "    const allowed = ['筛选', '视频', '用户', '直播', '综合', '最新', '最多点赞', '一天内', '一周内', '多列', '单列'];",
  "    if (!allowed.includes(label)) return { ok: false, reason: 'not-allowed' };",
  "    const result = await this.page.evaluate(text => {",
  "      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };",
  "      const all = [...document.querySelectorAll('button,span,div,a')].filter(el => visible(el) && (el.textContent || '').trim().length > 0 && (el.textContent || '').trim().length <= 20);",
  "      const textOf = el => (el.textContent || '').trim();",
  "      const exact = all.filter(el => textOf(el) === text);",
  "      const contains = all.filter(el => textOf(el).includes(text));",
  "      const hit = exact[0] || contains.sort((a, b) => textOf(a).length - textOf(b).length)[0];",
  "      if (!hit) return { ok: false, reason: 'not-found', nearby: [...new Set(all.map(textOf).filter(Boolean))].slice(0, 40) };",
  "      const target = hit.closest('button') || hit;",
  "      target.click();",
  "      return { ok: true, matched: textOf(hit), exact: exact.length > 0 };",
  "    }, label).catch(error => ({ ok: false, reason: String((error && error.message) || error) }));",
  "    await wait(900, signal);",
  "    return result;",
  "  }"
].join(NL);

const newBlock = [
  "  async tapByText(label, signal) {",
  "    const allowed = ['筛选', '视频', '用户', '直播', '综合', '最新', '最多点赞', '一天内', '一周内', '多列', '单列'];",
  "    if (!allowed.includes(label)) return { ok: false, reason: 'not-allowed' };",
  "    const fingerprint = () => this.page.evaluate(() => (document.body ? document.body.innerText.slice(0, 200) + '|' + document.body.innerText.length : '')).catch(() => '');",
  "    const before = await fingerprint();",
  "    const attempts = [];",
  "    let clicked = false;",
  "    try {",
  "      const target = this.page.getByText(label, { exact: true });",
  "      const count = await target.count();",
  "      for (let i = 0; i < Math.min(count, 4); i++) {",
  "        const loc = target.nth(i);",
  "        try {",
  "          if (!(await loc.isVisible())) continue;",
  "          await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});",
  "          await loc.hover({ timeout: 1200 }).catch(() => {});",
  "          await loc.click({ timeout: 2500 });",
  "          attempts.push('playwright#' + i); clicked = true; break;",
  "        } catch (error) {",
  "          attempts.push('playwright#' + i + ':' + String((error && error.message) || error).slice(0, 70));",
  "          try {",
  "            const btn = loc.locator('xpath=ancestor-or-self::button[1]');",
  "            if (await btn.count()) { await btn.first().click({ timeout: 2000, force: true }); attempts.push('button-force#' + i); clicked = true; break; }",
  "          } catch (inner) { attempts.push('button-force#' + i + ':' + String((inner && inner.message) || inner).slice(0, 70)); }",
  "        }",
  "      }",
  "    } catch (error) { attempts.push('locator:' + String((error && error.message) || error).slice(0, 70)); }",
  "    await wait(800, signal);",
  "    let after = await fingerprint();",
  "    if (before === after) {",
  "      const dom = await this.page.evaluate(text => {",
  "        const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };",
  "        const all = [...document.querySelectorAll('button,span,div,a')].filter(el => visible(el) && (el.textContent || '').trim().length > 0 && (el.textContent || '').trim().length <= 20);",
  "        const textOf = el => (el.textContent || '').trim();",
  "        const exact = all.filter(el => textOf(el) === text);",
  "        const contains = all.filter(el => textOf(el).includes(text));",
  "        const hit = exact[0] || contains.sort((a, b) => textOf(a).length - textOf(b).length)[0];",
  "        if (!hit) return { ok: false, reason: 'not-found', nearby: [...new Set(all.map(textOf).filter(Boolean))].slice(0, 30) };",
  "        (hit.closest('button') || hit).click();",
  "        return { ok: true };",
  "      }, label).catch(error => ({ ok: false, reason: String((error && error.message) || error) }));",
  "      attempts.push('dom:' + (dom && dom.ok ? 'ok' : (dom && dom.reason) || 'fail'));",
  "      if (dom && dom.ok) clicked = true;",
  "      await wait(800, signal);",
  "      after = await fingerprint();",
  "    }",
  "    return { ok: clicked, changed: before !== after, label, attempts };",
  "  }"
].join(NL);

const n = t.split(oldBlock).length - 1;
if (n !== 1) throw new Error('tap block occurrences=' + n);
t = t.replace(oldBlock, newBlock);
fs.writeFileSync(p, t, 'utf8');
console.log('patch17 done, chars:', t.length);
