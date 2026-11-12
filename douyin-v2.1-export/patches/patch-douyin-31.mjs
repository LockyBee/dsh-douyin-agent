import fs from 'node:fs';

const base = 'C:\\Users\\alantaylor\\.dsh\\profiles\\desktop\\node_modules\\dsh-douyin-browser-local\\';
const NL_OF = s => (s.includes('\r\n') ? '\r\n' : '\n');

// --- core.mjs：用 live-avatar 兜底识别直播卡 ---
{
  const p = base + 'core.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const NL = NL_OF(t);
  const oldS = "  const searchResults = [];" + NL;
  const newS = [
    "  if (!livePreview && !video?.id && !privateChatVisible && !loginRequired && !verificationRequired && recommendFeed) {",
    "    const hasLiveAvatar = [...document.querySelectorAll('[data-e2e=\"live-avatar\"]')].some(visible);",
    "    if (hasLiveAvatar) {",
    "      const seed = clean((activeContainer?.innerText) || text || '').slice(0, 160);",
    "      let hash = 0; for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 10000000000;",
    "      const r = (element || activeContainer).getBoundingClientRect();",
    "      livePreview = { recognized: true, source: 'active-feed-live-avatar', scope: 'recommend-feed', roomId: String(1000000000 + (hash % 9000000000)),",
    "        viewport: { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.min(innerWidth,r.right)-Math.max(0,r.left), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.top) } };",
    "    }",
    "  }",
    "  const searchResults = [];"
  ].join(NL) + NL;
  if (t.split(oldS).length - 1 !== 1) throw new Error('core anchor not unique');
  t = t.replace(oldS, newS);
  fs.writeFileSync(p, t, 'utf8');
  console.log('core live-avatar ok');
}

// --- autonomous-watch.mjs：isLivePreview 接受新来源 ---
{
  const p = base + 'autonomous-watch.mjs';
  let t = fs.readFileSync(p, 'utf8');
  const NL = NL_OF(t);
  const oldS = "state.livePreview.source === 'active-feed-live-link'";
  const newS = "['active-feed-live-link','active-feed-live-avatar'].includes(state.livePreview.source)";
  if (t.split(oldS).length - 1 !== 1) throw new Error('watch anchor not unique');
  t = t.replace(oldS, newS);
  fs.writeFileSync(p, t, 'utf8');
  console.log('watch isLivePreview ok');
}

console.log('patch31 done');
