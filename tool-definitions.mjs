// 两个入口共用工具目录，避免原生插件与 API 小工具的参数发生漂移。
const empty = () => ({ type: 'object', properties: {}, additionalProperties: false });

export const TOOL_DEFINITIONS = [
  { name: 'douyin_open', description: '打开抖音网页版推荐流。需要登录或验证时交给用户操作。', parameters: empty() },
  {
    name: 'douyin_search',
    description: '在抖音网页版搜索关键词，并返回当前可见结果。',
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 300, description: '要搜索的关键词，不能为空，最多 300 字。' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'douyin_open_video',
    description: '打开刚刚读取的搜索结果，或用户提供的抖音公开视频链接。index 与 url 至少提供一个。',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 0, description: '已读取搜索结果中的 index。' },
        url: { type: 'string', description: 'https://www.douyin.com/video/作品ID 公开链接。' },
      },
      additionalProperties: false,
    },
  },
  { name: 'douyin_next', description: '切换到下一条抖音视频，并返回切换后的状态。', parameters: empty() },
  { name: 'douyin_previous', description: '切换到上一条抖音视频，并返回切换后的状态。', parameters: empty() },
  { name: 'douyin_status', description: '读取抖音当前页面、可见文字与播放状态。文字不能代替视频画面内容。', parameters: empty() },
  {
    name: 'douyin_observe',
    description: '观察当前视频一小段时间，采集画面和播放状态。只有支持图像输入的模型才能理解画面。',
    parameters: { type: 'object', properties: { seconds: { type: 'number', minimum: 1, maximum: 10, description: '观察秒数，默认 3 秒，范围 1 到 10 秒。' } }, additionalProperties: false },
  },
  { name: 'douyin_screenshot', description: '获取当前抖音可见画面，供支持图像输入的模型查看。', parameters: empty() },
  { name: 'douyin_pause', description: '暂停当前抖音视频。', parameters: empty() },
  { name: 'douyin_play', description: '播放当前抖音视频，并返回实际播放状态。', parameters: empty() },
  {
    name: 'douyin_remember',
    description: '把用户明确要求记住的内容写入与 QQ 机器人互通的记忆。不要保存凭据或推测为事实的内容。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 4000, description: '需要记住的内容，不能为空，最多 4000 字。' },
        kind: { type: 'string', maxLength: 40, description: '可选记忆类型，最多 40 字，由共享记忆适配器处理。' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'douyin_recall',
    description: '检索与 QQ 机器人互通的既有记忆。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 300, description: '可选检索词，最多 300 字。空查询不读取 QQ 聊天历史。' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认由适配器决定，范围 1 到 20。' },
      },
      additionalProperties: false,
    },
  },
  { name:'douyin_chat_contacts',description:'读取本机抖音私信联系人元数据并核对关注关系，不读取其他会话正文。',parameters:empty() },
  { name:'douyin_chat_status',description:'读取私信自动回复的许可名单、运行状态、预算和暂停原因。',parameters:empty() },
  { name:'douyin_chat_start',description:'按已核对的本机许可名单启动私信自动回复，只处理启动后新消息。需要用户明确要求启动，不修改许可名单。',parameters:empty() },
  { name:'douyin_chat_stop',description:'停止正在运行的私信自动回复，取消待生成回复并保留发送核对记录。',parameters:empty() },
  {
    name:'douyin_chat_read',description:'读取许可名单内一个指定联系人的私信。名单外、身份歧义或群聊会拒绝。',
    parameters:{type:'object',properties:{recipientId:{type:'string',minLength:1,maxLength:500,description:'由douyin_chat_contacts返回的精确本机联系人ID。'}},required:['recipientId'],additionalProperties:false},
  },
  {
    name:'douyin_chat_observe',description:'读取许可名单内指定表情或分享卡片的实际画面；分享视频只在允许的刷视频时间内采样，不能把封面当成看完整条作品。',
    parameters:{type:'object',properties:{recipientId:{type:'string',minLength:1,maxLength:500},messageId:{type:'string',minLength:1,maxLength:80}},required:['recipientId','messageId'],additionalProperties:false},
  },
  {name:'douyin_video_limits_status',description:'读取自定义刷视频时间段、单轮时长及剩余时间。开始新一轮只能由用户在控制台或CLI操作。',parameters:empty()},
  {name:'douyin_media_status',description:'读取可选音频能力的开关、后端及依赖状态；默认关闭，不返回任何密钥。',parameters:empty()},
  {name:'douyin_listen',description:'在音频开关开启且刷视频时间允许时，录取当前抖音视频最多10秒实际音轨并转写。不会录麦克风或其他程序声音。',parameters:{type:'object',properties:{seconds:{type:'number',minimum:1,maximum:10,description:'录取秒数，默认8，范围1至10。'}},additionalProperties:false}},
  {name:'douyin_forward_video',description:'为用户明确选择的好友转发当前作品或公开作品链接。实际发送由本机转发按钮的可信授权入口执行，自动回复和普通视频模型不能发起转发。',parameters:{type:'object',properties:{recipientId:{type:'string',minLength:1,maxLength:500},url:{type:'string',maxLength:1000}},required:['recipientId'],additionalProperties:false}},
];

// 注册前和执行前均使用同一份定义；只接受目录中声明的简单参数。
export function validateToolArguments(definition, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('工具参数必须是 JSON 对象。');
  const schema = definition.parameters;
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(args, key)) throw new TypeError(`缺少参数：${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (!field) throw new TypeError(`不支持的参数：${key}`);
    if (field.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== field.type) throw new TypeError(`参数 ${key} 类型错误。`);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`参数 ${key} 必须是有限数值。`);
    if (typeof value === 'string' && field.maxLength !== undefined && [...value].length > field.maxLength) throw new RangeError(`参数 ${key} 最多 ${field.maxLength} 字。`);
  }
  for (const key of ['query', 'content','recipientId','messageId']) {
    if (schema.required?.includes(key) && args[key].trim().length === 0) throw new TypeError(`参数 ${key} 不能为空。`);
  }
  if (args.seconds !== undefined && (args.seconds < 1 || args.seconds > 10)) throw new RangeError('观察时间须在 1 到 10 秒之间。');
  if (args.limit !== undefined && (args.limit < 1 || args.limit > 20)) throw new RangeError('返回条数须在 1 到 20 之间。');
  if(definition.name==='douyin_chat_observe' && !/^msg:[a-f0-9]{64}$/.test(args.messageId)) throw new TypeError('需要已读取的精确消息ID。');
  if(definition.name==='douyin_forward_video' && args.url!==undefined && !/^https:\/\/(?:www\.)?douyin\.com\/video\/\d+\/?(?:\?[^#]*)?(?:#.*)?$/.test(args.url)) throw new TypeError('转发链接必须是抖音公开video链接。');
  if (definition.name === 'douyin_open_video') {
    if (args.index === undefined && args.url === undefined) throw new TypeError('打开作品需要 index 或 url。');
    if (args.index !== undefined && args.index < 0) throw new RangeError('搜索结果 index 不能为负数。');
    if (args.url !== undefined && !/^https:\/\/(?:www\.)?douyin\.com\/video\/\d+\/?(?:\?[^#]*)?(?:#.*)?$/.test(args.url)) throw new TypeError('作品链接必须是抖音公开 video 链接。');
  }
  return args;
}

export default TOOL_DEFINITIONS;
