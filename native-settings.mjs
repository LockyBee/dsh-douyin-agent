import { randomBytes, timingSafeEqual } from 'node:crypto';

const PREFIX = '/api/douyin-browser';
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('只接收JSON设置。'), { status: 400 });
  let size = 0; const chunks = []; for await (const bytes of req) { size += bytes.length; chunks.push(bytes); if (size > 262_144) throw Object.assign(new Error('设置请求过长。'), { status: 413 }); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0; return value; } catch { throw Object.assign(new Error('设置必须是JSON对象。'), { status: 400 }); }
}
const empty = value => { if (Object.keys(value).length) throw Object.assign(new Error('此操作不接收参数。'), { status: 400 }); };
const active = state => Boolean(state?.running || state?.starting || state?.busy || state?.worker?.alive);

// 复用 DSH 原生 WebServer 和设置页插槽，不启动独立软件或第二个端口。
export function createNativeSettingsRoute({ getController, getComments, getReport, getSpark, getWatch, getMode, getShare, getChat, getMedia, modelSettings, configureMode, startWatch, startSpark, startChat } = {}) {
  const token = randomBytes(32).toString('hex');
  return { kind: 'prefix', path: PREFIX, async handler(req, res) {
    try {
      const host = req.headers.host;
      if (!host || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return send(res, 403, { error: '设置页只接受本机来源。' });
      const origin = `http://${host}`, url = new URL(req.url, origin);
      if (url.origin !== origin || req.headers.origin && req.headers.origin !== origin || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return send(res, 403, { error: '拒绝跨来源设置请求。' });
      const controller = await getController();
      if (req.method === 'GET' && url.pathname === `${PREFIX}/state`) {
        const [spark, comments, reports] = await Promise.all([getSpark(), getComments(), getReport()]);
        return send(res, 200, { token, video: controller.limits().state(), spark: spark.state(), comments: comments.state(), reports: await reports.state(), persona: controller.getPersonaMemory().snapshot(), mode: (await getMode()).state(), model: modelSettings.state(), watch: (await getWatch()).state(), ...(getShare ? { share: (await getShare()).state() } : {}), ...(getChat ? { chat: (await getChat()).state() } : {}), ...(getMedia ? { media: await (await getMedia()).status() } : {}), setup: { browser: 'Microsoft Edge', audioOptional: true, independentAppRequired: false, model: '使用 DSH 已配置提供商，不需要在这里填写 API Key。' } });
      }
      if (req.method === 'GET' && url.pathname === `${PREFIX}/reports/read`) return send(res, 200, await (await getReport()).read({ date: url.searchParams.get('date') }));
      if (req.method !== 'POST') return send(res, 404, { error: '设置地址不存在。' });
      const supplied = req.headers['x-douyin-settings-token'];
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return send(res, 403, { error: '请刷新原生设置页后重试。' });
      const input = await body(req); let value;
      switch (url.pathname.slice(PREFIX.length)) {
        case '/video/configure': value = controller.limits().savePolicy(input, { explicit: true }); break;
        case '/video/start': empty(input); if ((await getWatch()).state().running) throw Object.assign(new Error('请先停止自主观看，再开始新一轮。'), { status: 409 }); await controller.pauseForLimits?.(); value = controller.limits().markSession('dsh', { explicit: true }); break;
        case '/video/stop': empty(input); value = controller.limits().endSession({ explicit: true }); await controller.pauseForLimits?.(); break;
        case '/browser/open': empty(input); value = await controller.openBrowser(); break;
        case '/persona/configure': {
          if (Object.keys(input).some(key => !['content', 'expectedRevision'].includes(key))) throw Object.assign(new Error('人格设置只接收正文和读取版本。'), { status: 400 });
          if (active((await getWatch()).state()) || active((await getSpark()).state()) || getChat && active((await getChat()).state())) throw Object.assign(new Error('请先停止自主观看、自动问候和私信回复，再保存人格。'), { status: 409 });
          const persona = controller.getPersonaMemory();
          persona.saveManualText({ text: input.content, expectedRevision: input.expectedRevision }, { explicit: true });
          value = persona.initialize({ importLegacy: false }); break;
        }
        case '/model/configure': {
          const assertStopped = async () => {
            const spark = (await getSpark()).state(), chat = getChat ? (await getChat()).state() : null;
            if (active((await getWatch()).state()) || active(spark) || active(chat)) throw Object.assign(new Error('请先停止自主观看、自动问候和私信回复，再修改模型。'), { status: 409 });
          };
          await assertStopped();
          value = await modelSettings.configure(input, { explicit: true, beforeCommit: assertStopped }); break;
        }
        case '/mode/configure': value = await configureMode(input); break;
        case '/watch/start': {
          if (Object.keys(input).some(key => key !== 'maxRequests')) throw Object.assign(new Error('自主观看只接收本轮请求上限。'), { status: 400 });
          value = await startWatch(input); break;
        }
        case '/watch/stop': empty(input); value = await (await getWatch()).stop({ explicit: true }); break;
        case '/spark/configure': value = await (await getSpark()).configure(input, { explicit: true }); break;
        case '/spark/stop': empty(input); value = await (await getSpark()).stop({ explicit: true }); break;
        case '/spark/start': empty(input); value = await startSpark(); break;
        case '/spark/resolve': value = await (await getSpark()).resolve(input, { explicit: true }); break;
        case '/comments/configure': value = await (await getComments()).configure(input, { explicit: true }); break;
        case '/comments/resolve': value = await (await getComments()).resolve(input, { explicit: true }); break;
        case '/share/configure': value = await (await getShare()).configure(input, { explicit: true }); break;
        case '/share/resolve': value = await (await getShare()).resolve(input, { explicit: true }); break;
        case '/chat/contacts': empty(input); value = await (await getChat()).listContacts({ signal: AbortSignal.timeout(45_000) }); break;
        case '/chat/configure': {
          if (Object.keys(input).some(key => !['recipientIds', 'dailyReplyLimit'].includes(key))) throw Object.assign(new Error('私信设置只接收许可联系人和每日上限。'), { status: 400 });
          value = await (await getChat()).configure(input); break;
        }
        case '/chat/start': empty(input); value = await startChat(); break;
        case '/chat/stop': empty(input); value = await (await getChat()).stop(); break;
        case '/chat/resolve': if (Object.keys(input).length !== 1 || typeof input.recipientId !== 'string') throw Object.assign(new Error('只接受已核对的许可联系人。'), { status: 400 }); value = await (await getChat()).resumeContact(input.recipientId); break;
        case '/media/configure': {
          if (Object.keys(input).some(key => !['enabled', 'backend'].includes(key)) || typeof input.enabled !== 'boolean' || !['local-whisper', 'mimo', 'minimax'].includes(input.backend)) throw Object.assign(new Error('音频只接收开关和有效后端。'), { status: 400 });
          const media = await getMedia(); await media.saveSettings(input, { explicit: true }); value = await media.status(); break;
        }
        case '/reports/generate': empty(input); value = await (await getReport()).generate({ reason: 'manual' }); break;
        default: return send(res, 404, { error: '设置地址不存在。' });
      }
      return send(res, 200, value);
    } catch (error) { return send(res, error.code === 'PERSONA_REVISION_CONFLICT' ? 409 : Number.isInteger(error.status) ? error.status : error.code?.startsWith('PERSONA_') ? 400 : 500, { error: error.message || String(error) }); }
  } };
}
