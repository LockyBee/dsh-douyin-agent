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

// Playwright 点成功就不要再用 DOM 兜底（避免把刚打开的面板又点关）
rep(
  "    await wait(800, signal);" + NL +
  "    let after = await fingerprint();" + NL +
  "    if (before === after) {" + NL,
  "    await wait(800, signal);" + NL +
  "    let after = await fingerprint();" + NL +
  "    if (!clicked && before === after) {" + NL,
  'skip-double-click'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch18 done, chars:', t.length);
