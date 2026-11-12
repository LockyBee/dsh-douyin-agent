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

// 不再要求“叶子节点”，允许带图标/箭头的容器（文本长度上限 20）
rep(
  "      const all = [...document.querySelectorAll('button,span,div,a')].filter(el => el.childElementCount === 0 && visible(el));" + NL,
  "      const all = [...document.querySelectorAll('button,span,div,a')].filter(el => visible(el) && (el.textContent || '').trim().length > 0 && (el.textContent || '').trim().length <= 20);" + NL +
  "      const textOf = el => (el.textContent || '').trim();" + NL,
  'tap-all-elements'
);

rep(
  "      const exact = all.filter(el => (el.textContent || '').trim() === text);" + NL +
  "      const contains = all.filter(el => (el.textContent || '').trim().includes(text));" + NL +
  "      const hit = exact[0] || contains.sort((a, b) => (a.textContent || '').trim().length - (b.textContent || '').trim().length)[0];" + NL,
  "      const exact = all.filter(el => textOf(el) === text);" + NL +
  "      const contains = all.filter(el => textOf(el).includes(text));" + NL +
  "      const hit = exact[0] || contains.sort((a, b) => textOf(a).length - textOf(b).length)[0];" + NL,
  'tap-match-use-textof'
);

rep(
  "      if (!hit) return { ok: false, reason: 'not-found', nearby: all.map(el => (el.textContent || '').trim()).filter(Boolean).slice(0, 40) };" + NL,
  "      if (!hit) return { ok: false, reason: 'not-found', nearby: [...new Set(all.map(textOf).filter(Boolean))].slice(0, 40) };" + NL,
  'tap-nearby-dedupe'
);

rep(
  "      return { ok: true, matched: (hit.textContent || '').trim(), exact: exact.length > 0 };" + NL,
  "      return { ok: true, matched: textOf(hit), exact: exact.length > 0 };" + NL,
  'tap-return-matched'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch16 done, chars:', t.length);
