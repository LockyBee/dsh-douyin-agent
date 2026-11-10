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

// 1) 只有「筛选」这种下拉触发器才按坐标点右侧箭头；菜单选项一律点文字
rep(
  "          if (!done) {" + NL +
  "            const box = await loc.boundingBox().catch(() => null);" + NL,
  "          if (!done && label === '筛选') {" + NL +
  "            const box = await loc.boundingBox().catch(() => null);" + NL,
  'arrow-only-for-trigger'
);

// 2) 点击后多等一会儿，让筛选结果重新加载
rep(
  "    await wait(800, signal);" + NL +
  "    let after = await fingerprint();" + NL,
  "    await wait(1500, signal);" + NL +
  "    let after = await fingerprint();" + NL,
  'wait-longer-after-tap'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch22 done, chars:', t.length);
