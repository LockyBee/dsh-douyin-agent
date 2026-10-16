import { TOOL_DEFINITIONS, validateToolArguments } from './tool-definitions.mjs?v=9';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimePaths } from './runtime-paths.mjs';
import { createNativeWatchDecision } from './native-watch-decision.mjs';
import { createNativeSparkGreeting } from './native-spark-greeting.mjs?v=9';
import { bindNativePersonaContext } from './native-persona-context.mjs';
import { createNativeSettingsRoute } from './native-settings.mjs?v=9';
import { NativeModelSettings } from './native-model-settings.mjs?v=9';
import { randomUUID } from 'node:crypto';

export const name = 'douyin-browser';
export const inject = ['tools'];

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// 原生 ToolRuntime 接收领域 JSON 值，再由 output.render 生成模型上下文。
// 图片必须保存成 DSH attachment ref；MCP 的 base64 图片块不能直接用于这里。
export const NATIVE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string' },
    result: { type: 'object', additionalProperties: true },
    images: { type: 'array', items: { type: 'object', additionalProperties: true } },
    imageStatus: { type: 'string' },
  },
  required: ['tool', 'result', 'images', 'imageStatus'],
};

function optionalService(ctx, service) {
  try { return ctx?.get?.(service); } catch { return undefined; }
}

function decodeFrames(frames) {
  return frames.map((frame) => {
    if (!frame || !IMAGE_MIME_TYPES.has(frame.mimeType) || typeof frame.data !== 'string' || frame.data.length === 0 || !CANONICAL_BASE64.test(frame.data)) throw new Error('画面不是支持的图片格式或有效 base64。');
    const data = Buffer.from(frame.data, 'base64');
    if (data.toString('base64') !== frame.data) throw new Error('画面数据不是规范 base64。');
    return { data, mediaType: frame.mimeType };
  });
}

async function projectFrames(ctx, exec, frames) {
  if (frames.length === 0) return { images: [], imageStatus: '本次操作没有采集画面。' };
  try {
    const decoded = decodeFrames(frames);
    const attachments = optionalService(ctx, 'attachments');
    const llm = optionalService(ctx, 'llm');
    if (typeof attachments?.saveImages !== 'function') throw new Error('当前 DSH 未挂载图片附件存储。');
    const route = exec.agent?.session?.requestHeader?.()?.config;
    const provider = route?.provider ?? exec.agent?.options?.provider;
    const model = route?.model ?? exec.agent?.options?.model;
    if (!provider || !model || typeof llm?.resolveModelInfo !== 'function') throw new Error('无法核实当前 DSH 模型的图像输入能力。');
    let info;
    try { info = await llm.resolveModelInfo(provider, model, exec.signal); }
    catch { throw new Error('无法核实当前 DSH 模型的图像输入能力。'); }
    if (!info?.inputModalities?.includes('image')) throw new Error(`当前模型 ${model} 未声明支持图像输入。`);
    exec.signal?.throwIfAborted();
    let images;
    try { images = await attachments.saveImages(decoded); }
    catch { throw new Error('DSH 图片附件存储未接收本次画面。'); }
    if (!Array.isArray(images) || images.length !== frames.length || images.some((ref) => !ref?.attachmentId)) throw new Error('DSH 图片附件存储返回了不完整的引用。');
    return { images, imageStatus: `已向模型提供 ${images.length} 张画面。` };
  } catch (error) {
    if (exec.signal?.aborted) throw error;
    return { images: [], imageStatus: `画面未送入模型：${error instanceof Error ? error.message : String(error)} 仍可读取播放状态和可见文字。` };
  }
}

function frameAdmission(result, frames) {
  const state = result.state ?? result;
  const protectedScreen = result.loginRequired === true || result.verificationRequired === true
    || state.loginRequired === true || state.verificationRequired === true;
  if (protectedScreen || frames.some((frame) => frame?.sensitive === true)) {
    return { frames: [], imageStatus: '登录或验证画面未送入模型，请在专用浏览器窗口完成操作。' };
  }
  return { frames };
}

function renderNativeValue(_args, value) {
  const content = [{ type: 'text', text: JSON.stringify({ tool: value.tool, ...value.result, imageStatus: value.imageStatus }, null, 2) }];
  for (const attachment of value.images) content.push({ type: 'image', attachment });
  return content;
}

function nativeParameters(schema) {
  // 当前 DSH 的 schema 子集不接收长度或数值边界；执行时仍由统一验证器检查。
  return {
    ...schema,
    properties: Object.fromEntries(Object.entries(schema.properties).map(([key, field]) => {
      const { minLength, maxLength, minimum, maximum, ...supported } = field;
      return [key, supported];
    })),
  };
}

export function createNativeToolDefinitions({ ctx, getController, getWatch, getSpark, attachPersona }) {
  return TOOL_DEFINITIONS.map((definition) => ({
    ...definition,
    parameters: nativeParameters(definition.parameters),
    timeoutMs: 90000,
    output: { schema: NATIVE_OUTPUT_SCHEMA, render: renderNativeValue },
    async execute(args, exec = {}) {
      validateToolArguments(definition, args);
      exec.signal?.throwIfAborted();
      attachPersona?.(exec.agent);
      const controller = await getController();
      let result;
      if (getSpark && definition.name.startsWith('douyin_spark_')) {
        const spark = await getSpark(exec, definition.name === 'douyin_spark_start');
        if (definition.name === 'douyin_spark_start') result = await spark.start({ schedule: true, explicit: true });
        else if (definition.name === 'douyin_spark_stop') result = await spark.stop({ explicit: true });
        else result = spark.state();
      } else if (getWatch && definition.name.startsWith('douyin_watch_')) {
        const watch=await getWatch(exec,definition.name==='douyin_watch_start');
        if(definition.name==='douyin_watch_start') result=await watch.start({startSession:false,maxRequests:args.maxRequests??30},{explicit:true});
        else if(definition.name==='douyin_watch_stop') result=await watch.stop({explicit:true});
        else result=watch.state();
      } else result = await controller.execute(definition.name, args, { signal: exec.signal });
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('浏览器控制器未返回 JSON 对象。');
      if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message ?? '抖音工具执行失败。');
      const { frames = [], ...state } = result;
      if (!Array.isArray(frames)) throw new Error('浏览器控制器返回的 frames 不是数组。');
      const admitted = frameAdmission(result, frames);
      const projected = admitted.imageStatus
        ? { images: [], imageStatus: admitted.imageStatus }
        : await projectFrames(ctx, exec, admitted.frames);
      // 持久日志与对话只保留画面概要和 attachment ref，避免把 base64 写进文本。
      const publicResult = JSON.parse(JSON.stringify({ ...state, ...(admitted.frames.length ? { frames: admitted.frames.map((frame) => ({ mimeType: frame?.mimeType ?? 'unknown', time:frame.time,videoId:frame.videoId, bytes: typeof frame?.data === 'string' ? Buffer.byteLength(frame.data, 'base64') : 0 })) } : {}) }));
      return { tool: definition.name, result: publicResult, ...projected };
    },
  }));
}

// 原生命令由人类界面直接分派，不进入模型或视频工具执行链。
export function createNativeLaunchCommand({ getController, lifetimeSignal } = {}) {
  return {
    name: 'douyin-open',
    description: '打开抖音专用窗口，不开始或延长刷视频轮次',
    recordInput: false,
    async handler({ rawInput, attachments, signal }) {
      if (rawInput.trim() || attachments.length) return { kind: 'error', text: '/douyin-open 不接收参数或附件。' };
      const signals = [signal, lifetimeSignal].filter(Boolean);
      const currentSignal = signals.length ? AbortSignal.any(signals) : undefined;
      currentSignal?.throwIfAborted();
      const controller = await getController();
      currentSignal?.throwIfAborted();
      const result = await controller.openBrowser({ signal: currentSignal });
      currentSignal?.throwIfAborted();
      if (result?.opened !== true) return { kind: 'error', text: '未确认抖音专用窗口已打开，请稍后重试。' };
      return { kind: 'success', text: typeof result.message === 'string' && result.message.length <= 1000 ? result.message : '已打开抖音专用窗口，未开始或延长刷视频轮次。' };
    },
  };
}

export async function apply(ctx, config = {}) {
  let controllerPromise;
  let watchPromise;
  let disposed = false;
  const modelSettings = new NativeModelSettings({ getLlm: () => optionalService(ctx, 'llm') });
  const settingsSessionId = `douyin-settings:${randomUUID()}`;
  const settingsExec = (starting = false) => {
    const route = modelSettings.state();
    if (starting && !route.configured) throw Object.assign(new Error('请先在刷抖音设置页选择 DSH 提供商和模型。'), { status: 400 });
    return { agent: { options: { provider: route.provider, model: route.model }, session: { id: settingsSessionId } } };
  };
  const getController = () => {
    if (disposed) throw new Error('抖音插件已卸载。');
    // 加载插件时只注册工具，首次调用时才创建控制器、启动浏览器。
    controllerPromise ??= import('./core.mjs?v=9')
      .then(({ BrowserController }) => new BrowserController({ ...config, source: 'dsh', personaMemory: sharedPersona }))
      .catch((error) => { controllerPromise = undefined; throw error; });
    return controllerPromise;
  };
  const {PersonaMemory}=await import('./persona-memory.mjs?v=9');
  const sharedPersona=new PersonaMemory();
  const personaBinding=bindNativePersonaContext(ctx,{workspacePaths:[path.dirname(resolveRuntimePaths().memoryDir),path.dirname(fileURLToPath(import.meta.url))],getPersonaMemory:()=>{
    // 提示词读取不触发浏览器或模型，按每次生成时的文件内容刷新。
    return sharedPersona;
  }});
  const getWatch=async(exec,starting)=>{
    if (!watchPromise) watchPromise=Promise.all([getController(),import('./autonomous-watch.mjs?v=9')]).then(async ([controller,{AutonomousWatch}])=>{
      if(starting) sharedPersona.initialize({importLegacy:false});
      const route=exec.agent?.session?.requestHeader?.()?.config ?? exec.agent?.options ?? {};
      return new AutonomousWatch({controller,videoLimits:controller.limits(),personaMemory:sharedPersona,commentService:await controller.getComments(),reportService:await controller.getReport(),source:'dsh',config:{apiKey:'',baseUrl:'https://api.deepseek.com',model:route.model||'deepseek-flash'},...(starting?{decisionProvider:createNativeWatchDecision({llm:optionalService(ctx,'llm'),attachments:optionalService(ctx,'attachments'),agent:exec.agent})}:{})});
    }).catch(error=>{watchPromise=undefined;throw error;});
    const watch=await watchPromise;
    if(starting) {
      if(watch.state().worker?.alive) throw new Error('已有自主观看在运行，请先停止。');
      watch.decisionProvider=createNativeWatchDecision({llm:optionalService(ctx,'llm'),attachments:optionalService(ctx,'attachments'),agent:exec.agent});
      sharedPersona.initialize({importLegacy:false});
    }
    return watch;
  };
  const getSpark = async (exec, starting) => {
    const spark = await (await getController()).getSparkService();
    if (starting && !spark.running && !spark.starting && !spark.busy) spark.setGreetingProvider(createNativeSparkGreeting({ llm: optionalService(ctx, 'llm'), agent: exec.agent }));
    return spark;
  };
  const definitions = createNativeToolDefinitions({ ctx, getController, getWatch, getSpark, attachPersona:personaBinding.attach });
  const disposers = [];
  const launchLifetime = new AbortController();
  let commandFiber, settingsFiber, cleanupPromise;
  const teardown = () => cleanupPromise ??= (async () => {
    disposed = true;
    launchLifetime.abort(new Error('抖音打开命令已卸载。'));
    await commandFiber?.dispose();
    await settingsFiber?.dispose();
    personaBinding.close();
    const sharedState=watchPromise?await watchPromise.then(watch=>watch.state()).catch(()=>null):null;
    if(watchPromise) await watchPromise.then(watch=>watch.close()).catch(()=>{});
    for (const dispose of disposers.reverse()) dispose?.();
    if (controllerPromise) await controllerPromise.then((controller) => {if(sharedState?.worker?.alive&&!sharedState.owned&&sharedState.worker.source==='dsh')controller.limitsEnabled=false;return controller.close?.();}).catch(() => {});
  })();
  try {
    for (const tool of definitions) disposers.push(ctx.tools.register(tool));
    if (typeof ctx.inject === 'function') {
      // commands 只作为子作用域依赖；缺少该服务时仍注册完整视频工具目录。
      commandFiber = ctx.inject(['commands'], commandCtx => {
        const dependencyLifetime = new AbortController();
        commandCtx.effect(() => () => dependencyLifetime.abort(new Error('原生命令服务已卸载。')));
        commandCtx.commands.register(createNativeLaunchCommand({ getController, lifetimeSignal: AbortSignal.any([launchLifetime.signal, dependencyLifetime.signal]) }));
      });
      if (optionalService(ctx, 'commands')) await commandFiber.await();
      settingsFiber = ctx.inject(['webServer'], settingsCtx => {
        settingsCtx.effect(() => settingsCtx.webServer.register(createNativeSettingsRoute({
          getController, modelSettings,
          getComments: async () => (await getController()).getComments(),
          getReport: async () => (await getController()).getReport(),
          getSpark: async () => (await getController()).getSparkService(),
          getShare: async () => (await getWatch(settingsExec(), false)).getShareService(),
          getChat: async () => (await getController()).getChatService(),
          getMedia: async () => (await getController()).getMediaAdapter(),
          getWatch: async () => getWatch(settingsExec(), false),
          getMode: async () => (await getController()).getWatchMode(),
          configureMode: async input => {
            const controller = await getController(), mode = await controller.getWatchMode();
            const saved = mode.configure(input, { explicit: true });
            const application = await controller.applyWatchMode({ minimize: saved.silent });
            return { ...saved, application };
          },
          startWatch: async input => {
            const watch = await getWatch(settingsExec(true), true);
            const result = watch.start({ ...input, startSession: false }, { explicit: true });
            (await getController()).applyWatchMode({ minimize: true }).catch(() => {});
            return result;
          },
          startSpark: async () => (await getSpark(settingsExec(true), true)).start({ schedule: true, explicit: true }),
          startChat: async () => {
            const chat = await (await getController()).getChatService();
            chat.setReplyProvider(createNativeWatchDecision({ llm: optionalService(ctx, 'llm'), attachments: optionalService(ctx, 'attachments'), agent: settingsExec(true).agent, maxTokens: 512 }));
            return chat.start();
          },
        })));
      });
      if (optionalService(ctx, 'webServer')) await settingsFiber.await();
    } else {
      const commands = optionalService(ctx, 'commands');
      if (commands) disposers.push(commands.register(createNativeLaunchCommand({ getController, lifetimeSignal: launchLifetime.signal })));
    }
    ctx.effect?.(() => teardown);
  } catch (error) { await teardown(); throw error; }
}

export default { name, inject, apply };
