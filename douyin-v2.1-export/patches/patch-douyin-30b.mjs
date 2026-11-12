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

rep(
  "  const u = new URL(location.href);" + NL,
  "  let identityDiagnostics = null;" + NL +
  "  if (!video?.id && !livePreview) {" + NL +
  "    try {" + NL +
  "      const attr = el => el ? { tag: el.tagName, id: el.id || null, cls: String(el.className || '').slice(0, 120), e2e: el.getAttribute('data-e2e') || null } : null;" + NL +
  "      const cards = [...document.querySelectorAll('[data-e2e]')].filter(visible).slice(0, 12).map(attr);" + NL +
  "      const links = [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 10).map(el => ({ href: el.getAttribute('href'), text: (el.textContent || '').trim().slice(0, 30) }));" + NL +
  "      const liveLike = [...document.querySelectorAll('*')].filter(el => visible(el) && el.childElementCount === 0 && /直播/.test(el.textContent || '')).slice(0, 6).map(el => ({ text: (el.textContent || '').trim().slice(0, 20), ...attr(el) }));" + NL +
  "      identityDiagnostics = { cards, links, liveLike, path: location.pathname, search: location.search.slice(0, 200) };" + NL +
  "    } catch (error) { identityDiagnostics = { error: String((error && error.message) || error) }; }" + NL +
  "  }" + NL +
  "  const u = new URL(location.href);" + NL,
  'identity-diagnostics'
);

rep(
  "  return { url: u.href, title: document.title, video,",
  "  return { url: u.href, title: document.title, video, ...(identityDiagnostics ? { identityDiagnostics } : {}),",
  'identity-diagnostics-return'
);

fs.writeFileSync(p, t, 'utf8');
console.log('patch30b done, chars:', t.length);
