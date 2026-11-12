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

// 1) 读页面与滑动校验用同一个种子，保证身份一致
rep(
  "      const seed = clean((activeContainer?.innerText) || text || '').slice(0, 160);" + NL,
  "      const seed = (document.body?.innerText || '').slice(0, 200);" + NL,
  'seed-align'
);

// 2) 滑动校验侧也识别直播卡（同源同算法）
rep(
  "        const rooms=[...new Set([...cards[0].querySelectorAll('a[href]')].filter(visible).flatMap(link=>{try{const url=new URL(link.href);const id=url.origin==='https://live.douyin.com'?/^\\/(\\d{4,30})\\/?$/.exec(url.pathname)?.[1]:null;return id?[id]:[];}catch{return[];}}))];" + NL +
  "        return rooms.length===1?`live:${rooms[0]}`:null;" + NL,
  "        const rooms=[...new Set([...cards[0].querySelectorAll('a[href]')].filter(visible).flatMap(link=>{try{const url=new URL(link.href);const id=url.origin==='https://live.douyin.com'?/^\\/(\\d{4,30})\\/?$/.exec(url.pathname)?.[1]:null;return id?[id]:[];}catch{return[];}}))];" + NL +
  "        if(rooms.length===1)return `live:${rooms[0]}`;" + NL +
  "        const hasLiveAvatar=[...document.querySelectorAll('[data-e2e=\"live-avatar\"]')].some(visible);" + NL +
  "        const hasLiveTag=[...document.querySelectorAll('div,span')].some(el=>visible(el)&&!el.childElementCount&&(el.textContent||'').trim()==='直播中');" + NL +
  "        if(hasLiveAvatar||hasLiveTag){" + NL +
  "          const seed=(document.body?.innerText||'').slice(0,200);" + NL +
  "          let h=0;for(let i=0;i<seed.length;i++)h=(h*31+seed.charCodeAt(i))%10000000000;" + NL +
  "          return `live:${1000000000+(h%9000000000)}`;" + NL +
  "        }" + NL +
  "        return null;" + NL,
  'switch-identity-live'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch34 done, chars:', t.length);
