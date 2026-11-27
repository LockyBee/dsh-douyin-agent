import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sharePreflightError } from './autonomous-share.mjs';
import { hasStableConversationIdentity, matchesAuthorizedContact } from './contact-authorization.mjs';
import { OutboundCoordinator } from './outbound-send.mjs';

const exactID = value => {
  const text = Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && /^[1-9]\d{0,29}$/.test(text) ? text : '';
};

export class YunsurVideoForwarder {
  constructor({ chat, stateDir, source, currentVideoId, supportsNativeShare }) {
    Object.assign(this, { chat, currentVideoId, supportsNativeShare });
    this.outbound = new OutboundCoordinator({ stateDir, source });
  }

  forward() {
    throw Object.assign(new Error('后台模式暂未开放手动转发。'), { code: 'BACKGROUND_MANUAL_SHARE_UNAVAILABLE' });
  }

  async forwardAutonomous({ recipientId, expectedVideoId: videoId, ...extra } = {}, { signal, authorize } = {}) {
    if (!/^conv:[a-f0-9]{64}$/.test(recipientId) || typeof videoId !== 'string' || !/^\d{10,30}$/.test(videoId) || Object.keys(extra).length || typeof authorize !== 'function' || typeof authorize.beginDispatch !== 'function') {
      throw new TypeError('后台自主分享需要当前作品、许可会话和本机发送授权。');
    }
    const operationId = randomUUID();
    const preflight = (code, stage, message) => sharePreflightError({ code, stage, message }, { forwardOperationId: operationId, videoId, recipientId });
    const check = async phase => {
      signal?.throwIfAborted();
      if (this.currentVideoId() !== videoId) throw Error('当前观察作品已变化，未继续分享。');
      if (await authorize({ phase, recipientId, videoId }) !== true) throw Error('本次分享未取得本机许可。');
      signal?.throwIfAborted();
    };
    await check('prepare');
    if (!await this.supportsNativeShare({ signal })) throw preflight('MCP_SHARE_TOOL_UNAVAILABLE', 'preparation', '后台连接器暂未提供原生分享。');

    const contact = () => this.chat.getPolicy().allowlist.find(item => item.id === recipientId);
    let targets, accountUID;
    try {
      await this.chat.prepareChat({ signal });
      accountUID = exactID(this.chat.selfUID);
      targets = await this.chat.listContacts({ signal });
    } catch {
      signal?.throwIfAborted();
      throw preflight('MCP_SHARE_CONTACT_UNAVAILABLE', 'contact-identity', '未能读取该许可会话。');
    }
    const stored = contact();
    const current = targets.contacts.find(item => item.id === recipientId);
    const bound = this.chat.mapping.get(recipientId)?.conversation;
    const shortID = exactID(bound?.conversation_short_id);
    if (!accountUID || !hasStableConversationIdentity(stored) || !matchesAuthorizedContact(stored, current) || !shortID || !bound?.conversation_id || bound.conversation_type !== (stored.isGroup ? 2 : 1)) {
      throw preflight('MCP_SHARE_CONTACT_UNAVAILABLE', 'contact-identity', '该许可会话的稳定身份暂未对上。');
    }

    const snapshot = async () => {
      const result = await this.chat.client.call('get_conversation_history', { conversation: bound.conversation_id, count: 50 }, { signal });
      if (result?.conversation_id !== bound.conversation_id || result.conversation_type !== bound.conversation_type || !Array.isArray(result.messages) || result.messages.length > 50) throw Error('会话历史与目标不一致。');
      return result.messages;
    };
    const card = row => row?.conversation_id === bound.conversation_id && row.conversation_type === bound.conversation_type
      && exactID(row.conversation_short_id) === shortID && exactID(row.sender) === accountUID && row.message_type === 8 && exactID(row.content?.itemId) === videoId;
    let entered = false;
    try {
      return await this.outbound.run({ recipientId, purpose: 'video', signal }, async () => {
        entered = true;
        let before;
        try { before = await snapshot(); }
        catch {
          signal?.throwIfAborted();
          throw preflight('MCP_SHARE_BASELINE_UNAVAILABLE', 'conversation-baseline', '未能核对分享前的会话记录。');
        }
        if (before.some(row => card(row) && exactID(row.server_message_id))) throw preflight('MCP_SHARE_ALREADY_IN_HISTORY', 'conversation-baseline', '该会话已有本人发出的同一作品卡片。');
        const previous = new Set(before.map(row => exactID(row?.server_message_id)));
        const sendBlock = await this.chat.sendAuthorizationBlock({ signal });
        if (sendBlock) throw preflight(sendBlock.code, 'send-authorization', sendBlock.message);
        await check('monitor');
        if (!matchesAuthorizedContact(contact(), current)) throw preflight('MCP_SHARE_CONTACT_UNAVAILABLE', 'contact-identity', '提交前许可会话的身份已变化。');
        await check('before-click');
        const release = authorize.beginDispatch();
        let submitted;
        try {
          signal?.throwIfAborted();
          submitted = await this.chat.client.call('share_conversation_aweme', {
            conversation_id: bound.conversation_id, conversation_short_id: shortID, conversation_type: bound.conversation_type, account_uid: accountUID, aweme_id: videoId,
          }, { signal, control: true });
        } finally { release(); }
        const shareID = submitted?.share_id;
        if (submitted?.state !== 'submitted' || typeof shareID !== 'string' || !shareID.startsWith(`${accountUID}_`) || !shareID.endsWith(`_${videoId}`) || !/^\d+_\d+_\d+$/.test(shareID)) throw Error('未取得可核对的卡片提交回执。');

        for (let attempt = 0; attempt < 5; attempt++) {
          signal?.throwIfAborted();
          const matches = (await snapshot()).filter(row => {
            const id = exactID(row?.server_message_id);
            return id && !previous.has(id) && card(row) && row.content.share_id === shareID;
          });
          if (matches.length === 1) {
            const messageId = 'msg:' + createHash('sha256').update(`${bound.conversation_id}\0${exactID(matches[0].server_message_id)}`).digest('hex');
            return { confirmed: true, deliveryType: 'native-card', videoId, messageId, operationId };
          }
          if (matches.length > 1) break;
          if (attempt < 4) await delay(500, undefined, { signal });
        }
        return { confirmed: false, deliveryUncertain: true, deliveryType: 'native-card', videoId, operationId, failure: { code: 'MCP_SHARE_RECEIPT_UNCONFIRMED', stage: 'receipt', message: '已提交分享，未回读到对应的新卡片。' } };
      });
    } catch (error) {
      if (!entered && !signal?.aborted && error.code === 'OUTBOUND_BUSY' && error.beforeDelivery === true) throw preflight('OUTBOUND_BUSY', 'outbound-wait', '其他消息正在发送，本次尚未提交。');
      throw error;
    }
  }
}
