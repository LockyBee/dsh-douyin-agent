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

// 1) 匹配改成“先精确、再包含”，并返回诊断信息
rep(
  "      const nodes = [...document.querySelectorAll('button,span,div,a')].filter(el => el.childElementCount === 0 && (el.textContent || '').trim() === text);" + NL +
  "      const hit = nodes.find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });" + NL +
  "      if (!hit) return { ok: false, reason: 'not-found' };" + NL +
  "      const target = hit.closest('button') || hit;" + NL +
  "      target.click();" + NL +
  "      return { ok: true };" + NL,
  "      const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };" + NL +
  "      const all = [...document.querySelectorAll('button,span,div,a')].filter(el => el.childElementCount === 0 && visible(el));" + NL +
  "      const exact = all.filter(el => (el.textContent || '').trim() === text);" + NL +
  "      const contains = all.filter(el => (el.textContent || '').trim().includes(text));" + NL +
  "      const hit = exact[0] || contains.sort((a, b) => (a.textContent || '').trim().length - (b.textContent || '').trim().length)[0];" + NL +
  "      if (!hit) return { ok: false, reason: 'not-found', nearby: all.map(el => (el.textContent || '').trim()).filter(Boolean).slice(0, 40) };" + NL +
  "      const target = hit.closest('button') || hit;" + NL +
  "      target.click();" + NL +
  "      return { ok: true, matched: (hit.textContent || '').trim(), exact: exact.length > 0 };" + NL,
  'tap-match-diag'
);

// 2) 把 tap 结果带回返回状态
rep(
  "          if (args.tap) await this.tapByText(args.tap, signal);" + NL,
  "          if (args.tap) this.lastTapResult = await this.tapByText(args.tap, signal);" + NL,
  'tap-store'
);

rep(
  "        aborted(signal);" + NL +
  "        return this.state();" + NL,
  "        aborted(signal);" + NL +
  "        const finalState = await this.state();" + NL +
  "        if (this.lastTapResult) { finalState.tapResult = this.lastTapResult; this.lastTapResult = null; }" + NL +
  "        return finalState;" + NL,
  'tap-return'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch15 done, chars:', t.length);
