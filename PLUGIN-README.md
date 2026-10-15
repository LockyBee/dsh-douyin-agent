# DSH 原生抖音插件

原生入口为 `dsh-plugin.mjs`，当前 v6 源码工具目录共 27 个 `douyin_*` 工具。通过 `new BrowserController({source:'dsh'})` 接入同一个浏览器底座；加载插件时不启动浏览器，也不创建或改名工作区。工具注册、运行时加载和真实工具调用分别验收。

2026-10-15 的 v5 实机复验核对了当时的 22 项工具目录，并真实调用时限、媒体状态、两位许可会话、精确表情观察与转发人工授权提示。该轮自动回复和音频关闭，没有外发。新增 v6／27 工具尚未做当前 DSH 进程的实际加载与模型联调；真实 SDK 临时测试通过不能代替这项验收。

## 复用的接口

核查日期为 2026-10-14，本机 DSH Desktop 2.0.11 的相关包版本为 `0.1.5-rc.2`：

- `@deepseek-ai/dsh-tools`：工具注册、schema 校验、取消及执行管线。
- `@deepseek-ai/cordis-plugin-loader`：本地 `file:` 模块加载与释放。
- `@deepseek-ai/dsh-attachment-local`：图片保存、校验和 attachment ref 回读。
- `@deepseek-ai/dsh-cordis-host-runner`：纯 host 包动态加载及 Loader 服务注入。
- `@deepseek-ai/dsh-system-prompt`：共用人格的动态变量和上下文注册、每次生成时刷新及卸载释放。

上述包来自 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)，本机许可证为 MIT。这里调用已安装接口，没有复制或替换 DSH 产品包。接口适配、工具目录、画面过滤和安装脚本由本项目补齐，浏览器与共享记忆由 `core.mjs`、`memory.mjs` 提供。

DSH 的固定 JSON schema 子集不支持部分边界关键字；原生适配去掉不兼容字段，执行前仍用本项目验证器检查参数。视频观察为 1–10 秒，回忆为 1–20 条，关键词、记忆和联系人字段均有长度上限，不能通过模型参数绕过。

可选媒体能力实际保存三个社区项目的固定版本源码和 MIT LICENSE，不是 DSH 官方媒体插件。来源为 `ch1bug/dsh-mimo-agent-tools`、`GooDAnDReaDY/dsh-voice`、`moluyao/dsh-minimax-asr`，固定 commit 与文件哈希见 [media/PROVENANCE.json](media/PROVENANCE.json)，具体用途和许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 持久安装与当前进程加载

从本目录上一级运行：

```powershell
node douyin-browser/plugin-install.mjs --dry-run
node douyin-browser/plugin-install.mjs
node douyin-browser/plugin-install.mjs --status
```

安装器只维护 `%USERPROFILE%/.dsh/cordis.patch.yml` 中 `# BEGIN DSH DOUYIN BROWSER` 到 `# END DSH DOUYIN BROWSER` 的条目。改写前保存原始字节备份，写入前检查文件变化，写入后回读。同 ID 的非托管条目、损坏标记或并发改写会停止安装。卸载托管配置：

```powershell
node douyin-browser/plugin-install.mjs --uninstall
```

`installed` 只表示持久配置存在，`runtimeLoaded:null` 表示未检查当前 DSH。安装脚本不重启 DSH；Desktop 启动时使用配置快照，保存配置后仍须核对当前工具。

`plugin-hotload.js` 是 `cordis_define` 的 `code.host` 函数体，不能当作普通模块直接导入。先核实当前 DSH 提供 `cordis_define`、`cordis_run` 和 Loader 服务，再按其加载回执执行。对本项目已有的 include 条目，通过公开 `Loader.update` 原位切换到 v6，保留 ID、配置和归属；加载失败或工具不完整时回滚。已有完整工具名也须核对自有条目的版本与活动状态。其他来源或多个同源条目存在歧义时停止，不覆盖其他会话的包。聊天增量适配为 `chat-hotload.js`，具体注册范围由当前目录和回执核对。

原位升级的托管条目在辅助热加载包停止后仍保留，持久配置负责下次启动。没有已有条目时才创建临时挂载，辅助包停止时仅清理自己创建且未被替换的条目。通过 Codex 与 DSH 合作必须使用本项目 `bridge.ps1`，遵守原有轮数和尝试预算，不能新建任务绕过耗尽的验收。

## 工具范围

工具涵盖推荐、搜索、开作品、上下切换、状态、画面采样、播放、暂停、记忆，以及许可私信的联系人、读取、指定媒体观察、状态和启停。另有视频时限状态、媒体状态、短音轨转写和转发提示入口。v6 在旧 22 项基础上新增 `douyin_persona_status`、`douyin_interest_record`、`douyin_watch_status`、`douyin_watch_start`、`douyin_watch_stop`。没有点赞、评论、关注、购买或发布操作。

图片只来自实际页面。先核对模型图像能力，再保存为 DSH attachment ref；不把 Base64 写入对话文本。不支持图像的模型收到明确说明，不能以标题或作者替代画面理解。登录、验证和敏感画面不进入附件；网页文字不作为新的用户指令。

刷视频使用本机共享时间策略，默认每轮 10 分钟，可按本人设置多个每日窗口和有限单轮时长。API/DSH 共用一轮时钟，开页面和继续调用不会续时。到点暂停视频并拒绝继续切换；模型只能读时限状态。本人在控制台点击或手动执行 `session-start`、`session-end`、`video-policy` 管理时间。

音频默认关闭，`douyin_listen` 在开关开启且时间允许时录取当前视频最多 10 秒音轨；不会录麦克风或其他程序。只按用户选定的后端处理，模型不能开启或切换后端。本机 Whisper 提供对白转写，MiMo/MiniMax 云端后端需独立凭据，云端尚未真实验收。

`douyin_forward_video` 不向模型开放可信授权参数，只提示使用本机控制台选择好友并点转发；本人明确的页面按钮或手动 CLI 才执行发送。当前 DSH 已真实核对该工具返回 `requiresUserAction=true`、`sent=false`。普通视频 API 模型过滤此工具及所有聊天工具。转发受同一视频时限和许可名单约束，未确认不自动重发，未支持的界面不自动改发链接。

## 共用人格与有限自主观看

软件 1.1.0 与 v6 插件读取同一全局位置记录中的 `memoryDir`，人格文件为 `memoryDir/persona/role-card.md`，兴趣和公开视频观察为 `memoryDir/persona/state.json`。手编正文只由用户在软件显式保存，自动生成区根据实际作品证据整理；模型没有修改手编人格、许可名单或时间策略的工具。代理自己的兴趣不代表用户偏好。

人格通过 SystemPrompt 的动态变量与上下文附加到匹配的大肥鱼及本插件工作区，每次组装读取最新内容；其他工作区不自动附加。它只影响身份、表达和选题，不执行人格、页面文字或反思中的命令，也不授予工具权限。人格资料仅按本机内部参考使用，QQ 侧可见范围及公开分享授权尚未核实，不能据此向 QQ 群聊、公共导出或其他公开渠道传播。

本人须先在软件或 CLI 开始一个允许时段内的有限轮次，再明确要求 `douyin_watch_start` 自主挑片。该工具不能开始或延长视频轮次。默认每轮最多 30 次模型决策，可设 1–100 次，同一轮停止后重开不清零；软件和插件每日合计最多 200 次。时限或预算先到便停止并暂停视频，不自动恢复、预约或新开下一轮。

两个入口共用自主运行锁和预算，同一时刻只运行一个 worker；`douyin_watch_stop` 与软件停止按钮均可请求协作停止。手动视频任务、转发与自主观看互斥。自主循环只做公开视频选择、短时观察和有依据的兴趣更新，不发私信或转发，不点赞或评论。普通视频 API 模型不接收自主观看启停工具。DSH 原生自主决策复用当前代理的模型路由、`llm.stream` 与图片附件接口；独立软件仍使用用户自己输入的 API Key。

软件由用户自行配置模型接口，私信自动回复与音频均需明确开启。本次实现没有代用户修改模型配置或运行设置，也没有执行真人消息或视频转发。

## 私信和富媒体

私信工具共用本机许可名单，只处理本人授权的当前两个已关注个人联系人；模型不能增加收件人或修改名单。自动回复由独立 `ChatService` 直接调用 DeepSeek API，两个入口共用 worker 锁、消息水位和预算。

启用时重新核对关注关系，将现有消息设为基线。随后仅可靠的新消息触发模型；默认每日最多 40 次，每条最多生成 512 token。发送前核对会话、消息和草稿，发送后确认新发出气泡；未确认挂起，不自动重试。停止或模型错误时未答记录留在本机待核对清单。

`douyin_chat_observe` 只截取指定许可会话中的精确消息。表情可读实际图片，分享卡片可读封面与元数据；分享视频的实际作品采样另受共享时间门控。图文作品目前只核实封面、元数据和公开 URL，没有读取整套图片。普通图片、收到的语音和未识别类型仍跳过，不假称已理解。

私信正文与联系人标识只留本机，回复模型只接收该许可会话本次相关消息，不接入 QQ 或其他联系人历史。

## 验收记录

```powershell
node --test douyin-browser/verification/dsh-plugin.test.mjs
```

本次 v6 原生适配测试 25／25 通过，真实使用本机 schema、ToolRuntime、Cordis Loader、DynamicCordisRunnerService 沙箱、SystemPrompt 和 LocalAttachmentStore。保留旧 17 项、旧 v5／22 项及旧满目录升级，覆盖 include 卸载失效、原位升级、异常回滚、活动状态、临时条目清理和实际附件回读；另核对 watch 服务路由及人格变量每次组装刷新、重复附加保护与释放。测试使用独立 Context，写入的配置、附件及 fixture 均在系统临时目录；控制器和模型返回使用替身，没有操作当前 DSH 进程或发模型请求。

软件新界面合成与许可证测试 12／12 通过，包含两个临时 Edge 流程；根目录与 desktop 完整回归实际运行 237 项，230 项通过、0 项失败、7 项可选检查跳过，用时约 19.7 秒。1.1.0 的 `win-unpacked` 已实际打包回读，随包 Node 24.17.0、SQLite 3.53.0、27 项工具及 persona／watch 模块可导入，没有 DSH 运行包。新版真实 Electron 窗口尚未验收，便携包结果与最终哈希另记于 [desktop/VERIFICATION.md](desktop/VERIFICATION.md)。下列 17／22 项历史实机结果不计为 v6 新工具或自主模型循环已通过。

真实视频联合验收通过，见 `verification/native-live-workdir/native-plugin-receipt.json`：模型搜索、开作品、收到图片附件并暂停。整体聊天热加载曾因旧动态包冲突失败，回执保留；追加授权验收通过了真实联系人、状态及两人会话读取，旧版原生 17 项工具范围已实际核对。

旧桥任务 `d1d836bf-a85f-487c-925c-a8bd82579e23` 热升级失败，原 `remove` 未卸载配置中的 `include:douyin-browser` 条目，随后创建新版发生同名冲突。原始失败保留在 `verification/native-rich-workdir/native-rich-receipt.json`。用户明确追加 1 轮／1 次后，任务 `461ff7a2-5741-41bb-85c9-92b6e82bc71e` 使用原文 v5 helper 运行成功，刷新目录完整 22 项，真实状态和许可会话读取通过。辅助包保持运行，其他插件未动，没有自动追加预算。

本轮指定表情经真实 DSH image content block 进入模型；Codex 从原生日志核对 ref，并独立读取持久 JPEG，尺寸 138×138、4355 字节、SHA256 与 ref 一致。两位会话均返回 `orderMode=relative` 和已核实最新端标记；音频为 `enabled=false`，视频轮次仍结束，转发入口只提示本人操作。执行回执与独立复核在 `verification/native-rich-workdir/recheck-20261015/`，桥状态保留 `needs_review`，不写成自动 accepted。

当前 Inspect 未提供 Loader 条目的直接导出，helper 的 console JSON 也未落入可回读日志；v5 版本以逐字 helper 中的活动状态/URI/完整目录断言及真实调用核对，没有把运行态 URI 字符串标作独立读取结果。

2026-10-15 还单独核查了桌面启动：用户截图中的 `Failed to load plugins` 来自已装 `dsh-web-ui-notify@0.1.6`。该扩展要求核心 `0.1.7-rc.2+`，当前 Desktop 2.0.11 内置核心为 `0.1.5-rc.2`，缺少它直接订阅的 `uiSession.sessionStatus`。本机备份 profile 后，仅从启用的 bundles 移除该通知扩展，保留依赖文件；重新启动后，实际窗口的会话列表和输入框恢复，错误页消失。抖音插件不依赖该通知扩展。工具后端验收与桌面启动验收分别记录，不能仅凭后端 health 判断界面可用。

真人私信发送已做一条本人授权的明确功能测试：`confirmed=true` 且二次读取 `persisted=true`，见 `verification/chat-human-send-live.json`。这证明该次发送与回读，不证明收到新消息后的自动模型回复已由真人触发。

真实表情和分享卡片的精准截取、公开 URL 解析通过；一张精确表情截图已送入真实 DeepSeek 并生成回复，没有向真人发送，见 `verification/chat-rich-api-live.json`。两位联系人真实只读回查确认时间顺序、最新端及消息 ID 稳定，见 `verification/chat-chronology-readonly-live.json`。2026-10-15 又单独完成上述 DSH 原生表情附件验收；图文仍只到封面、元数据和 URL。

真实 API、DSH 两个专用抖音页到期后由后台检查暂停通过，观测延迟为 2652 毫秒（约 2.65 秒），原策略已恢复，见 `verification/video-limits-live.json`；这是本次观测值，不保证零延迟。Whisper 本地合成 WAV、WebM 对白转写通过，实际猫咪视频已采到 3 秒音轨但没有有效对白，ASR 准确性未验；MiMo/MiniMax 云联调未做，音频默认关闭。

真人作品卡片转发已执行一次本人授权的点击；初始自动确认未通过，随后只读打开实际发出的卡片，精确核实公开作品 ID 为 `7579432563794584933`，没有再次发送。证据分别为 `verification/video-forward-human-live.json` 与 `verification/video-forward-post-readback.json`。2026-10-15 的原生转发工具实测仅覆盖人工授权提示分支，没有再发送；自动回复目前仍停止。
