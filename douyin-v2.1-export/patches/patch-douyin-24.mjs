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

// tap 支持用竖线分隔多个标签，例如 "最新发布|视频#2"
rep(
  "          const tapLabels = Array.isArray(args.taps) && args.taps.length ? args.taps.slice(0, 3) : (args.tap ? [args.tap] : []);" + NL,
  "          const rawTap = Array.isArray(args.taps) && args.taps.length ? args.taps : (typeof args.tap === 'string' ? args.tap.split('|') : []);" + NL +
  "          const tapLabels = rawTap.map(item => String(item).trim()).filter(Boolean).slice(0, 3);" + NL,
  'tap-pipe-split'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch24 done, chars:', t.length);
