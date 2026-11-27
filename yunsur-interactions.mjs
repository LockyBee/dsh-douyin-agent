import { setTimeout as delay } from 'node:timers/promises';
import { validateCommentText } from './autonomous-comments.mjs';
import { publicDiscussionExcerpts, repeatsPublicDiscussion } from './comment-novelty.mjs';
import { decimalId } from './yunsur-mcp.mjs';

export const reactionTools = Object.freeze({ like: 'digg_video', favorite: 'collect_video' });
const reactionValue = (work, action) => work[action === 'like' ? 'user_digged' : 'collect_stat'];
const cleaned = text => typeof text === 'string' ? text.normalize('NFC').trim() : '';
const commentId = row => decimalId(row?.cid);

export class YunsurVideoInteractions {
  constructor(controller) { this.controller = controller; }

  async account(signal) {
    await this.controller.ready;
    const status = await this.controller.client.call('check_login_status', {}, { signal });
    const uid = decimalId(status?.uid);
    if (status?.logged_in !== true || !uid || uid === '0') throw Error('后台互动需要已核对的登录身份。');
    return uid;
  }

  async check({ phase, videoId, action, signal, authorize }) {
    signal?.throwIfAborted();
    if (!/^\d{10,30}$/.test(videoId || '') || this.controller.currentVideoId() !== videoId ||
        typeof authorize?.beginDispatch !== 'function' ||
        await authorize({ phase, videoId, ...(action ? { action } : {}) }) !== true) {
      throw Error('后台互动与当前作品或许可不一致。');
    }
    signal?.throwIfAborted();
  }

  async react({ action, expectedVideoId: videoId }, { signal, authorize } = {}) {
    const tool = Object.hasOwn(reactionTools, action) && reactionTools[action];
    if (!tool) throw Error('后台只支持点赞或收藏当前作品。');
    const gate = phase => this.check({ phase, videoId, action, signal, authorize });
    await gate('prepare');
    const uid = await this.account(signal);
    const before = reactionValue(await this.controller.getWork(videoId, signal), action);
    await gate('monitor');
    if (before === 1 || before === true) return { videoId, action, alreadyActive: true, active: true, verified: true };
    if (before !== 0 && before !== false) return { videoId, action, verified: false };
    if (await this.account(signal) !== uid) return { videoId, action, verified: false };
    await gate('before-click');
    const release = authorize.beginDispatch();
    try {
      const args = action === 'like' ? { aweme_id: videoId, digg_type: '1' } : { aweme_id: videoId, action: '1' };
      await this.controller.client.call(tool, args, { signal, control: true });
    } finally { release(); }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await delay(400 * attempt, undefined, { signal });
      if (await this.account(signal) !== uid) break;
      const after = reactionValue(await this.controller.getWork(videoId, signal), action);
      await gate('monitor');
      if (after === 1 || after === true) return { videoId, action, active: true, verified: true };
    }
    return { videoId, action, deliveryUncertain: true };
  }

  async discussion(videoId, { signal } = {}) {
    const discussion = await this.controller.readPublicComments({ videoId, limit: 5, signal });
    return publicDiscussionExcerpts(discussion.rows.flatMap(row => [row.text, ...row.authorReplies.map(reply => reply.text)]));
  }

  async comments(videoId, signal) {
    const body = await this.controller.readCommentPage(videoId, '0', signal);
    const rows = body.comments ?? [];
    if (rows.some(row => row?.aweme_id != null && decimalId(row.aweme_id) !== videoId)) throw Error('后台评论页与当前作品不一致。');
    return rows.filter(row => commentId(row));
  }

  async post({ expectedVideoId: videoId, text }, { signal, authorize } = {}) {
    text = validateCommentText(text);
    const gate = phase => this.check({ phase, videoId, signal, authorize });
    await gate('prepare');
    const uid = await this.account(signal);
    const work = await this.controller.getWork(videoId, signal);
    const notSent = { videoId, confirmed: false, deliveryUncertain: false };
    if (work.status?.is_private === true || work.status?.is_private === 1 ||
        work.status?.allow_comment === false || work.status?.allow_comment === 0) return notSent;
    const before = await this.comments(videoId, signal);
    if (repeatsPublicDiscussion(text, before.map(row => row.text))) {
      return { ...notSent, skipped: true, code: 'COMMENT_DISCUSSION_DUPLICATE' };
    }
    const knownIds = new Set(before.map(commentId));
    if (await this.account(signal) !== uid) return notSent;
    await gate('before-click');
    const release = authorize.beginDispatch();
    let result;
    try {
      result = await this.controller.client.call('post_video_comment', { aweme_id: videoId, content: text }, { signal, control: true });
    } finally { release(); }
    const receipt = result?.comment;
    const id = commentId(receipt), uncertain = { videoId, confirmed: false, deliveryUncertain: true };
    if (result?.status_code !== 0 || !id || knownIds.has(id) ||
        receipt.aweme_id != null && decimalId(receipt.aweme_id) !== videoId ||
        receipt.user?.uid != null && decimalId(receipt.user.uid) !== uid ||
        receipt.text != null && cleaned(receipt.text) !== cleaned(text)) return uncertain;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await delay(400 * attempt, undefined, { signal });
      if (await this.account(signal) !== uid) break;
      const rows = await this.comments(videoId, signal);
      await gate('monitor');
      if (rows.some(row => commentId(row) === id && decimalId(row.aweme_id) === videoId &&
        decimalId(row.user?.uid) === uid && cleaned(row.text) === cleaned(text))) {
        return { videoId, confirmed: true, commentId: id, deliveryUncertain: false };
      }
    }
    return uncertain;
  }
}
