// 页面归属与用量来源分开：两个入口共用作品页和消息页，用量仍记在原入口。
export function browserPageSource(source) {
  if (source === 'api' || source === 'dsh') return 'api';
  if (source === 'api-chat' || source === 'dsh-chat') return 'api-chat';
  if (source === 'verification') return source;
  throw new TypeError('浏览器页面入口无效。');
}
export const browserPageLabel = source => `deepseek-douyin-${browserPageSource(source)}`;
export const browserPageLock = source => `tab-${browserPageSource(source)}`;
export function browserPageAliases(source) {
  const role = browserPageSource(source);
  return role === 'api' ? ['deepseek-douyin-api', 'deepseek-douyin-dsh']
    : role === 'api-chat' ? ['deepseek-douyin-api-chat', 'deepseek-douyin-dsh-chat']
      : [browserPageLabel(source)];
}

export async function findSharedPage(browser, source, signal) {
  const aliases = browserPageAliases(source), matches = [];
  for (const page of browser.contexts().flatMap(context => context.pages())) {
    signal?.throwIfAborted();
    if (page.isClosed() || !/^(?:about:blank|https:\/\/www\.douyin\.com(?:\/|$))/.test(page.url())) continue;
    const label = await page.evaluate(() => window.name).catch(() => null);
    if (aliases.includes(label)) matches.push({ page, label });
  }
  const canonical = matches.filter(item => item.label === aliases[0]);
  const selected = canonical.length ? canonical : matches;
  if (selected.length > 1) throw new Error('发现多个归属相同的标签（同一用途多个专用页），未新建或关闭页面。');
  return selected[0]?.page ?? null;
}

// 准备页只在没有草稿、登录或验证提示时转为作品页；保留当前地址，不另开第三页。
export async function adoptSharedPreparePage(browser, { signal } = {}) {
  const matches = [];
  for (const page of browser.contexts().flatMap(context => context.pages())) {
    signal?.throwIfAborted();
    if (!page.isClosed() && /^https:\/\/www\.douyin\.com(?:\/|$)/.test(page.url()) && await page.evaluate(() => window.name).catch(() => null) === 'deepseek-douyin-launcher') matches.push(page);
  }
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('准备页不唯一，未新建作品页。');
  const page = matches[0];
  const adopted = await page.evaluate(() => {
    if (location.origin !== 'https://www.douyin.com' || window.name !== 'deepseek-douyin-launcher') return false;
    const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
    if ([...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"]')].some(visible)) return false;
    if ([...document.querySelectorAll('body *')].some(node => !node.childElementCount && visible(node) && /扫码登录|验证码登录|登录后即可|手机扫码登录|请完成下方验证|请完成验证|安全验证|拖动滑块/.test(node.textContent || ''))) return false;
    if ([...document.querySelectorAll('input,textarea,[contenteditable="true"]')].some(element => element.files?.length || element.type === 'file' && element.value || ['INPUT','TEXTAREA'].includes(element.tagName) && !['button','submit','reset','checkbox','radio'].includes(element.type) && String(element.value || '').trim() || element.isContentEditable && String(element.textContent || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim())) return false;
    const entry = window.__dafeiyuPrepareLease;
    if (entry && (entry.version !== 2 || entry.label !== window.name || typeof entry.release !== 'function')) return false;
    entry?.release();
    window.name = 'deepseek-douyin-api';
    return true;
  });
  signal?.throwIfAborted();
  if (!adopted) throw Object.assign(new Error('准备页有草稿、登录或验证提示，保留原页，未另开作品页。'), { code: 'BROWSER_PREPARE_PROTECTED' });
  return page;
}
