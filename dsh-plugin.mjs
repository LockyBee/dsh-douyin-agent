import { TOOL_DEFINITIONS, validateToolArguments } from './tool-definitions.mjs?v=5';

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

export function createNativeToolDefinitions({ ctx, getController }) {
  return TOOL_DEFINITIONS.map((definition) => ({
    ...definition,
    parameters: nativeParameters(definition.parameters),
    timeoutMs: 90000,
    output: { schema: NATIVE_OUTPUT_SCHEMA, render: renderNativeValue },
    async execute(args, exec = {}) {
      validateToolArguments(definition, args);
      exec.signal?.throwIfAborted();
      const controller = await getController();
      const result = await controller.execute(definition.name, args, { signal: exec.signal });
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

export async function apply(ctx, config = {}) {
  let controllerPromise;
  let disposed = false;
  const getController = () => {
    if (disposed) throw new Error('抖音插件已卸载。');
    // 加载插件时只注册工具，首次调用时才创建控制器、启动浏览器。
    controllerPromise ??= import('./core.mjs?v=5')
      .then(({ BrowserController }) => new BrowserController({ ...config, source: 'dsh' }))
      .catch((error) => { controllerPromise = undefined; throw error; });
    return controllerPromise;
  };
  const definitions = createNativeToolDefinitions({ ctx, getController });
  const disposers = [];
  try { for (const tool of definitions) disposers.push(ctx.tools.register(tool)); }
  catch (error) { for (const dispose of disposers.reverse()) dispose?.(); throw error; }
  ctx.effect?.(() => async () => {
    disposed = true;
    for (const dispose of disposers.reverse()) dispose?.();
    if (controllerPromise) await controllerPromise.then((controller) => controller.close?.()).catch(() => {});
  });
}

export default { name, inject, apply };
