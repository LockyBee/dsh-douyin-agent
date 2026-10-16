import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserController, readPageState } from './core.mjs?v=9';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { validateCommentText } from './autonomous-comments.mjs';

const stop = signal => signal?.throwIfAborted();
const cleanDraft = value => String(value ?? '').replace(/[\u200B-\u200F\uFEFF]/g, '').trim();
const EDITORS = '.comment-input-container [contenteditable="true"],.comment-input-container textarea,[data-e2e="comment-input"] [contenteditable="true"],textarea[data-e2e="comment-input"],[contenteditable="true"][data-e2e="comment-input"]';
const BUTTONS = '[data-e2e="comment-post"],[data-e2e="comment-submit"],button,[role="button"]';
const write = (file, value) => { const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`; try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } };

// 只读公开评论的编号、正文和自身发出状态；不采集其他评论者的账号、昵称或头像。
export function readCommentDom(expectedVideoId) {
  const visible = element => { const r = element.getBoundingClientRect(), s = getComputedStyle(element); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden'; };
  const result = [];
  for (const row of document.querySelectorAll('[data-e2e="comment-item"]')) {
    if (!visible(row) || row.closest('[data-e2e="im-dialog"]')) continue;
    const ancestorVideoId = row.closest('[data-aweme-id],[data-video-id]')?.getAttribute('data-aweme-id') || row.closest('[data-video-id]')?.getAttribute('data-video-id');
    if (ancestorVideoId && ancestorVideoId !== expectedVideoId) continue;
    const rawId = row.getAttribute('data-comment-id') || row.querySelector('[id^="tooltip_"]')?.getAttribute('id')?.replace(/^tooltip_/, '') || /^comment_(\d+)$/.exec(row.id)?.[1];
    const textNode = row.querySelector('[data-e2e="comment-content"],.comment-item-content');
    const text = (textNode?.innerText || textNode?.textContent || '').trim();
    const mine = row.getAttribute('data-is-self') === 'true' || row.getAttribute('data-author-is-self') === 'true' || Boolean(row.querySelector('[data-e2e="comment-self"]'));
    const status = row.getAttribute('data-send-status') || row.getAttribute('data-comment-status') || '';
    const pending = /^(?:sending|pending|reviewing)$/.test(status) || Boolean(row.querySelector('[data-e2e="comment-pending"],[aria-busy="true"],[class*="sending" i]'));
    const failed = /^(?:failed|rejected|error)$/.test(status) || Boolean(row.querySelector('[data-e2e="comment-failed"],[class*="sendFail"]'));
    const sent = /^(?:sent|published|success)$/.test(status) || mine && /^\d{1,64}$/.test(rawId || '') && !pending && !failed;
    result.push({ commentId: /^\d{1,64}$/.test(rawId || '') ? rawId : null, videoId: ancestorVideoId || expectedVideoId, text, mine, sent, pending, failed });
  }
  return { rows: result };
}

function assertVideo(state, expectedVideoId) {
  if (state?.loginRequired || state?.verificationRequired || state?.unsupportedPage || state?.privateChatVisible || state?.blocked || state?.video?.id !== expectedVideoId || state.video.readyState < 2) throw new Error('当前作品、登录状态或页面遮挡无法核对，未发布评论。');
  const url = state.video.url || state.url;
  if (url) { let current; try { current = new URL(url); } catch {} if (!current || current.origin !== 'https://www.douyin.com' || /^\/video\/(\d+)\/?$/.exec(current.pathname)?.[1] !== expectedVideoId) throw new Error('当前作品链接与预期不一致，未发布评论。'); }
}

export class CommentBrowser {
  constructor({ source = 'api', controller, videoLimits, stateDir = resolveRuntimePaths().stateDir } = {}) {
    if (!['api', 'dsh'].includes(source)) throw new TypeError('评论入口只能是 api 或 dsh。');
    this.source = source; this.stateDir = stateDir;
    this.videoLimits = videoLimits ?? new VideoLimits({ stateDir });
    // 默认创建独立的同入口控制器，不能复用正在等待评论结果的父控制器队列。
    this.controller = controller ?? new BrowserController({ source, videoLimits: this.videoLimits }); this.ownsController = !controller;
    this.receiptsFile = path.join(stateDir, 'comment-browser-receipts.json'); this.guardFile = path.join(stateDir, 'comment-post.guard');
  }
  receipts() { try { const value = JSON.parse(fs.readFileSync(this.receiptsFile, 'utf8')); if (!value || value.version !== 1 || !Array.isArray(value.operations) || value.operations.some(item => !item || typeof item.operationId !== 'string' || !/^\d{1,64}$/.test(item.videoId) || !['clicking', 'confirmed', 'uncertain'].includes(item.status))) throw Error(); return value; } catch (error) { if (error.code === 'ENOENT') return { version: 1, operations: [] }; throw new Error('原评论发布收据无法核对，未自动重发。'); } }
  record(operation) { const value = this.receipts(), index = value.operations.findIndex(item => item.operationId === operation.operationId); if (index < 0) value.operations.push(operation); else value.operations[index] = operation; write(this.receiptsFile, value); }
  acquire() { fs.mkdirSync(this.stateDir, { recursive: true }); let descriptor; try { descriptor = fs.openSync(this.guardFile, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') throw new Error('其他评论仍在处理，或发布锁需要核对；未抢锁重试。'); throw error; } const owner = { pid: process.pid, token: randomUUID() }; try { fs.writeFileSync(descriptor, JSON.stringify(owner)); } finally { fs.closeSync(descriptor); } return () => { const current = JSON.parse(fs.readFileSync(this.guardFile, 'utf8')); if (current?.pid === owner.pid && current.token === owner.token) fs.unlinkSync(this.guardFile); }; }
  async gate(signal) { stop(signal); const state = this.videoLimits.state(); if (!state.allowed) throw new Error(state.reason || '有限观看时段已结束，未发布评论。'); }
  async post({ expectedVideoId, text, ...extra } = {}, { signal: parentSignal, authorize, autonomousRunId } = {}) {
    if (typeof expectedVideoId !== 'string' || !/^\d{1,64}$/.test(expectedVideoId) || Object.keys(extra).length) throw new TypeError('评论只能指定当前作品编号与纯文字。');
    text = validateCommentText(text);
    if (typeof authorize !== 'function' || typeof authorize.beginDispatch !== 'function') return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '评论缺少可信本机许可与最终短输入控制，未发布。' };
    const interrupt = new AbortController(), signal = AbortSignal.any([interrupt.signal, ...(parentSignal ? [parentSignal] : [])]);
    const authorized = async phase => { stop(signal); if (await authorize({ phase, videoId: expectedVideoId }) !== true) throw new Error('自主评论许可已撤回，未继续发布。'); stop(signal); };
    await authorized('prepare'); await this.gate(signal);
    const release = this.acquire(), operation = { operationId: randomUUID(), videoId: expectedVideoId, startedAt: new Date().toISOString(), status: 'clicking' };
    let clicked = false, dispatched = false, receiptWritten = false;
    try {
      if (this.receipts().operations.some(item => item.videoId === expectedVideoId)) throw new Error('同一作品已有发布或待核对评论收据，未再次点击。');
      return await this.controller.withPage(async page => {
        await authorized('monitor'); await this.gate(signal); assertVideo(await page.evaluate(readPageState), expectedVideoId);
        const editors = page.locator(EDITORS).filter({ visible: true });
        if (await editors.count() !== 1) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '当前页面没有唯一可核对的评论输入框，需要先打开评论面板或等待适配。' };
        const editor = editors;
        const root = editor.locator('xpath=ancestor::*[contains(concat(" ",normalize-space(@class)," ")," comment-input-container ") or @data-e2e="comment-input"][1]');
        if (await root.count() !== 1) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '当前评论输入区域归属尚未支持，未发布。' };
        const send = root.locator(BUTTONS).filter({ hasText: /^(?:发布|发送|发表评论|发布评论)$/ }).filter({ visible: true });
        if (await send.count() !== 1) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, needsUserAction: true, reason: '当前评论区域没有唯一的官方发布按钮，未发布。' };
        const draft = () => editor.evaluate(element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.innerText);
        if (cleanDraft(await draft()) || await editor.locator('img,video,audio,a,[data-slate-void="true"]').count()) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '评论输入框已有草稿或媒体内容，已保留原内容。' };
        if (await root.locator('[data-e2e="comment-reply-target"],.PPsJmqBy').filter({ visible: true }).count() || await editor.getAttribute('aria-label').then(value => /回复\s*[@＠]/.test(value || ''))) return { confirmed: false, deliveryUncertain: false, videoId: expectedVideoId, reason: '当前输入框处于回复他人的状态，未改发回复或@。' };
        const before = await page.evaluate(readCommentDom, expectedVideoId), knownIds = new Set(before.rows.map(item => item.commentId).filter(Boolean));
        let monitoring = true, polling, prepared = false, releaseDispatch;
        const witnessId = operation.operationId;
        await send.evaluate((button, token) => { const entries = window.__deepseekCommentInputs ??= Object.create(null), entry = { dispatched: false }; const witness = event => { if (event.isTrusted && (event.target === button || button.contains(event.target))) entry.dispatched = true; }; document.addEventListener('click', witness, true); entry.cleanup = () => document.removeEventListener('click', witness, true); entries[token] = entry; }, witnessId);
        const inputDispatched = () => page.evaluate(token => window.__deepseekCommentInputs?.[token]?.dispatched === true, witnessId);
        const check = async () => {
          if (clicked && await inputDispatched()) return;
          await authorized('monitor'); await this.gate(signal); assertVideo(await page.evaluate(readPageState), expectedVideoId);
          if (await editors.count() !== 1 || await send.count() !== 1 || prepared && cleanDraft(await draft()) !== text || await root.locator('[data-e2e="comment-reply-target"],.PPsJmqBy').filter({ visible: true }).count()) throw new Error('等待期间评论输入、发布目标或草稿发生变化，未发布。');
          stop(signal);
        };
        const timer = setInterval(() => { if (!monitoring || polling) return; polling = check().catch(async error => { if (monitoring && !await inputDispatched().catch(() => false)) interrupt.abort(error); }).finally(() => { polling = null; }); }, 40);
        try {
          await check(); await editor.click({ timeout: 1000 }); stop(signal);
          // 使用浏览器真实文字输入触发受控编辑器；填写与页面回读一致后才等待发布按钮。
          await editor.pressSequentially(text, { delay: 10 }); stop(signal); prepared = true; await check();
          await send.click({ trial: true, timeout: 3000 }); stop(signal); await check();
          if (await inputDispatched()) { dispatched = true; throw new Error('等待期间已发生发布输入，未再点击一次。'); }
          await authorized('before-click'); releaseDispatch = await authorize.beginDispatch(); if (typeof releaseDispatch !== 'function') throw new Error('最终评论输入未取得可释放的本机许可。');
          stop(signal); this.record(operation); receiptWritten = true; clicked = true;
          await send.click({ timeout: 350, noWaitAfter: true }); releaseDispatch?.(); releaseDispatch = null;
          dispatched = await inputDispatched(); if (!dispatched) throw new Error('没有核对到真实发布输入，评论结果需要核对。');
          monitoring = false; clearInterval(timer); let previousId;
          for (let attempt = 0; attempt < 12; attempt++) {
            stop(signal); assertVideo(await page.evaluate(readPageState), expectedVideoId);
            const current = await page.evaluate(readCommentDom, expectedVideoId);
            const matches = current.rows.filter(item => item.commentId && !knownIds.has(item.commentId) && item.videoId === expectedVideoId && item.text === text && item.mine && item.sent && !item.failed && !item.pending);
            if (matches.length > 1 || new Set(current.rows.map(item => item.commentId).filter(Boolean)).size !== current.rows.filter(item => item.commentId).length) break;
            if (matches.length === 1 && previousId === matches[0].commentId && !cleanDraft(await draft())) { const result = { confirmed: true, deliveryUncertain: false, operationId: operation.operationId, videoId: expectedVideoId, commentId: matches[0].commentId }; this.record({ ...operation, status: 'confirmed', completedAt: new Date().toISOString(), commentId: result.commentId }); return result; }
            previousId = matches.length === 1 ? matches[0].commentId : null;
            await page.waitForTimeout(150);
          }
          this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() });
          return { confirmed: false, deliveryUncertain: true, operationId: operation.operationId, videoId: expectedVideoId, reason: '已尝试一次发布，但没有同作品的新本人评论编号与发出状态回读；请核对，未重试。' };
        } catch (error) { dispatched ||= await inputDispatched().catch(() => false); throw error; }
        finally { monitoring = false; clearInterval(timer); releaseDispatch?.(); await page.evaluate(token => { const entry = window.__deepseekCommentInputs?.[token]; entry?.cleanup(); if (window.__deepseekCommentInputs) delete window.__deepseekCommentInputs[token]; }, witnessId).catch(() => {}); }
      }, { signal, autonomousRunId });
    } catch (error) {
      if (clicked || dispatched) { try { this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() }); } catch { /* 保留原始发布收据，未自动重试。 */ } return { confirmed: false, deliveryUncertain: true, operationId: operation.operationId, videoId: expectedVideoId, reason: '发布输入后的结果不明，请人工核对，未再次点击。' }; }
      if (receiptWritten) this.record({ ...operation, status: 'uncertain', completedAt: new Date().toISOString() });
      return { confirmed: false, deliveryUncertain: false, operationId: operation.operationId, videoId: expectedVideoId, reason: error.message || '评论发布前检查未通过，草稿已保留。' };
    } finally { release(); }
  }
  async close() { if (this.ownsController) await this.controller.close(); }
}
