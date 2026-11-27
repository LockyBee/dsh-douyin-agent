import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { readPageState } from './core.mjs';
import { readCommentSelfIdentity } from './comment-browser.mjs';

// 只接受同作品内有明确开关语义的控件；图标颜色和点赞数字不代表本人状态。
export function readReactionTarget({ action, expectedVideoId, token, mark = false }) {
  if (location.origin !== 'https://www.douyin.com' || !['like', 'favorite'].includes(action) || !/^\d{1,64}$/.test(expectedVideoId)) return null;
  const visible = node => { const r = node.getBoundingClientRect(), s = getComputedStyle(node); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0; };
  const excluded = '[data-e2e="im-dialog"],[data-e2e="comment-item"],[data-e2e="comment-list"],[data-e2e="danmaku-container"]';
  const names = action === 'like' ? ['点赞', '取消点赞'] : ['收藏', '取消收藏'];
  const roots = [...document.querySelectorAll('[data-aweme-id],[data-video-id]')].filter(node => (node.getAttribute('data-aweme-id') || node.getAttribute('data-video-id')) === expectedVideoId && visible(node) && !node.closest(excluded));
  const candidates = [...new Set(roots.flatMap(root => [...root.querySelectorAll('button,[role="button"],[aria-label],[title]')]))].filter(node => {
    if (!visible(node) || node.closest(excluded) || node.matches('[disabled],[aria-disabled="true"]')) return false;
    const owner = node.closest('[data-aweme-id],[data-video-id]');
    const name = node.getAttribute('aria-label') || node.getAttribute('title');
    return owner && (owner.getAttribute('data-aweme-id') || owner.getAttribute('data-video-id')) === expectedVideoId && names.includes(name);
  });
  if (candidates.length !== 1) return null;
  const node = candidates[0], name = node.getAttribute('aria-label') || node.getAttribute('title'), pressed = node.getAttribute('aria-pressed');
  if (pressed !== null && !['true', 'false'].includes(pressed)) return null;
  const active = name === names[1];
  if (!active && pressed !== 'false') return null;
  if (pressed !== null && (pressed === 'true') !== active) return null;
  const rectangle = node.getBoundingClientRect();
  if (mark) node.setAttribute('data-dafeiyu-reaction', token);
  return { action, videoId: expectedVideoId, active, rectangle: { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height } };
}

export async function reactToVideo(controller, { action, expectedVideoId }, { signal, authorize } = {}) {
  if (!controller?.withPage || typeof authorize !== 'function') throw new Error('点赞收藏缺少可信浏览器入口。');
  return controller.withPage(async page => {
    const check = async phase => {
      signal?.throwIfAborted();
      if (await authorize({ phase, videoId: expectedVideoId, action }) !== true) throw new Error('互动授权已撤回。');
      const state = await page.evaluate(readPageState);
      if (state.video?.id !== expectedVideoId || state.loginRequired || state.verificationRequired || state.privateChatVisible || state.unsupportedPage || state.livePreview?.recognized || state.videoSelection?.identityConflict) throw new Error('互动前作品或页面状态已变化。');
      const self = await page.evaluate(readCommentSelfIdentity);
      if (!self.ready) throw new Error('无法确认当前登录账号，未执行互动。');
      return self.ownProfileId;
    };
    const account = await check('prepare'), token = randomUUID();
    const request = { action, expectedVideoId, token };
    let clicked = false, releaseDispatch;
    try {
      const target = await page.evaluate(readReactionTarget, { ...request, mark: true });
      if (!target) return { action, videoId: expectedVideoId, active: null, verified: false };
      if (target.active) {
        if (await check('monitor') !== account) throw new Error('核对互动状态时账号已变化。');
        return { action, videoId: expectedVideoId, active: true, verified: true, alreadyActive: true };
      }
      if (await check('monitor') !== account) throw new Error('互动前登录账号已变化。');
      const locator = page.locator(`[data-dafeiyu-reaction="${token}"]`);
      if (await locator.count() !== 1) throw new Error('互动目标已变化。');
      const installed = await page.evaluate(input => {
        const node = document.querySelector(`[data-dafeiyu-reaction="${input.token}"]`);
        if (!node) return false;
        const originalOwner = node.closest('[data-aweme-id],[data-video-id]');
        const name = node.getAttribute('aria-label') || node.getAttribute('title');
        const pressed = node.getAttribute('aria-pressed');
        const selfLink = document.querySelector('.tab-user_self a[href]')?.getAttribute('href');
        try { const self = new URL(selfLink, location.origin); if (self.origin !== location.origin || self.pathname !== `/user/${input.account}`) return false; } catch { return false; }
        let clicked = false;
        const guard = event => {
          const owner = node.closest('[data-aweme-id],[data-video-id]'), rect = node.getBoundingClientRect();
          const samePoint = ['x', 'y', 'width', 'height'].every(key => Math.abs(rect[key] - input.rectangle[key]) <= 0.5);
          const valid = event.isTrusted && node.isConnected && originalOwner === owner && (owner?.getAttribute('data-aweme-id') || owner?.getAttribute('data-video-id')) === input.expectedVideoId && (node.getAttribute('aria-label') || node.getAttribute('title')) === name && node.getAttribute('aria-pressed') === pressed && name === (input.action === 'like' ? '点赞' : '收藏') && selfLink && selfLink === document.querySelector('.tab-user_self a[href]')?.getAttribute('href') && samePoint && !document.querySelector('[data-e2e="im-dialog"],iframe[src*="captcha"]') && !clicked;
          if (!valid) { event.preventDefault(); event.stopImmediatePropagation(); }
          else if (event.type === 'click') clicked = true;
        };
        for (const type of ['pointerdown', 'mousedown', 'click']) node.addEventListener(type, guard, true);
        window.__dafeiyuReactionGuards ||= new Map();
        window.__dafeiyuReactionGuards.set(input.token, () => { for (const type of ['pointerdown', 'mousedown', 'click']) node.removeEventListener(type, guard, true); });
        return true;
      }, { ...request, account, rectangle: target.rectangle });
      if (!installed || await check('monitor') !== account) throw new Error('互动目标或账号已变化。');
      if (await authorize({ phase: 'before-click', videoId: expectedVideoId, action }) !== true) throw new Error('最终互动授权已撤回。');
      releaseDispatch = authorize.beginDispatch?.();
      clicked = true;
      try { await locator.click({ timeout: 2000 }); } finally { releaseDispatch?.(); releaseDispatch = null; }
      for (let sample = 0; sample < 8; sample++) {
        if (await check('monitor') !== account) throw new Error('互动后账号已变化，未确认结果。');
        const after = await page.evaluate(readReactionTarget, request);
        if (after?.active) return { action, videoId: expectedVideoId, active: true, verified: true, alreadyActive: false };
        await wait(150, undefined, { signal });
      }
      return { action, videoId: expectedVideoId, active: null, verified: false, deliveryUncertain: true };
    } catch (error) {
      if (clicked) return { action, videoId: expectedVideoId, verified: false, deliveryUncertain: true };
      throw error;
    } finally {
      releaseDispatch?.();
      await page.evaluate(token => {
        window.__dafeiyuReactionGuards?.get(token)?.(); window.__dafeiyuReactionGuards?.delete(token);
        if (window.__dafeiyuReactionGuards?.size === 0) delete window.__dafeiyuReactionGuards;
        for (const node of document.querySelectorAll('[data-dafeiyu-reaction]')) if (node.getAttribute('data-dafeiyu-reaction') === token) node.removeAttribute('data-dafeiyu-reaction');
      }, token).catch(() => {});
    }
  }, { signal, launch: false, create: false });
}
