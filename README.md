# DSH 抖音助手

在专用 Edge 中浏览电脑网页版抖音，向模型提供实际视频采样画面。提供 DSH 原生插件、独立 API 桌面软件和旧版本机控制台。当前源码工具目录共 22 项；普通视频 API 模型不接收聊天和转发工具，私信由独立许可名单服务处理，转发由本人明确点击或执行可信 CLI 命令触发。

Windows 桌面软件直接输入 API Key 即可配置模型，使用随包 Node 后台，无需安装或运行 DSH、Cordis、QQ 服务。界面复用官方 MIT React 基础组件、主题和布局样式，软件自己的请求与业务交互独立实现。密钥可只用于本次运行，也可选择使用系统加密记住。软件与新版 DSH 插件共用本地记忆文件夹及精确数据库路径；源码构建、配置和验收范围见 [desktop/README.md](desktop/README.md)。

2026-10-15 原插件实机复验通过：DSH 工具目录完整 22 项，视频时限与音频状态、两位许可联系人的会话、指定表情图片和转发人工授权分支均完成真实调用。该轮私信自动回复和音频关闭，没有向真人发送消息或转发。这些结果不等于新独立软件已经完成打包和真实模型联调。

## 启动与时间限制

独立桌面软件的构建与使用见 [desktop/README.md](desktop/README.md)。以下命令用于保留的旧版本机 HTTP 控制台，需要 Windows、Microsoft Edge、Node.js 22.13+：

```powershell
pnpm install --frozen-lockfile
.\start-api.ps1
```

也可双击 `start-api.cmd`。页面为 `http://127.0.0.1:3218`，先在“刷视频时间”点击“开始新一轮”，再输入例如“搜索猫咪，打开第一条，观察 3 秒后暂停并告诉我看到什么”。页面显示工具回读和 API 用量，停止按钮中断当前模型任务。

每日可设多个允许窗口，按北京时间计算，支持 `23:00-01:00` 等跨午夜窗口；全天可用 `00:00-24:00`。单轮默认 10 分钟，可设为 1 至 1440 分钟的整数，不能设无穷时长或关闭全部上限。API 与 DSH 共用一轮时钟，连续调用、开页面或保存更长上限不会重置当前轮。到点、窗口结束或本人结束当前轮时，视频会实际暂停，继续切换和视频模型任务受阻；私信 worker 使用独立运行状态和预算。

旧控制台兼容从当前进程环境变量或 `DOUYIN_QQ_ROOT` 指定项目的 `.env` 在内存读取 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`。默认 QQ 项目路径为 `D:/codex分局/聊天机器人`；不需要运行 QQ 项目，不向 QQ 发消息。独立桌面软件只使用本人输入或本机加密保存的 API 设置，不借用此兼容配置。旧入口说明和预算见 [API-README.md](API-README.md)。

DSH 安装、当前进程热加载和工具验收范围见 [PLUGIN-README.md](PLUGIN-README.md)。本机维护命令 `douyin.ps1` 使用同一 CDP 底座；`session-start`、`session-end`、`video-policy` 是本人手动命令，模型没有任意续时或改设置的工具。写入安装配置不等于当前 DSH 已加载。

## 浏览器、聊天与媒体

专用持久资料在用户目录 `.dsh/douyin-browser/cli-profile`，CDP 仅监听 `127.0.0.1:9227`。API、DSH 和聊天入口各自拥有标签页；关闭客户端连接保留登录窗口。遇登录或验证码，在可见专用窗口手动完成。

作品状态包含实际 ID、作者、文案和播放时间、暂停状态。上下切换只有前后 ID 改变才算成功。采样保留作品 ID 和采样时间；登录、验证、私信面板或离开抖音的页面不作为视频画面发给模型。少量帧只说明那些采样时刻，不能证明看完完整作品。

私信自动回复仅处理本人确认的两个已关注个人联系人，启用时建立旧消息基线，只回复此后可靠的新消息。方向不明、消息变化、已有人工回复、草稿、模型错误或发送未确认时暂停或跳过；未确认不自动重发。两个入口共享 worker 锁、每日预算与本机水位；默认每日 40 次模型请求，每条最多生成 512 token，回复标注“自动回复”。回复请求只使用该联系人的本次相关消息，不读取 QQ 或其他联系人历史。

富媒体可截取指定表情或分享卡片的实际画面。分享视频只有在本轮时间允许时才打开公开作品并短时采样；图文作品目前只读取卡片封面、网页元数据和核实的公开 URL，没有读取整套图片。普通图片、收到的语音及撤回等尚未识别的类型不能当作已理解内容。

音频能力是可选模块，默认关闭。开启后可从当前视频录取短段实际音轨并交给用户所选后端；不会录麦克风或其他程序声音。本地 Whisper 不需要云端密钥，提供对白转写；MiniMax、MiMo 为可选云端后端，需要独立凭据。依赖可用、对白转写、音乐或环境声理解、真实视频音轨采集分别验收，不能混为一项。媒体源码、来源和配置见 [media/README.md](media/README.md)。

转发入口只允许本人选定许可好友和当前或指定作品。普通视频 API 模型没有转发工具；DSH 模型入口只提示使用本机按钮，实机已核对返回 `requiresUserAction=true`、`sent=false`。页面按钮或手动 `forward` CLI 命令才带可信授权；未确认不自动重试，暂不支持的平台界面不会自动改发文本 URL。一次真人作品卡片转发已通过随后只读回查核实；初始自动确认暴露了真实 DOM 消息逆序问题。逆序适配后的只读检查确认两人会话消息 ID 稳定，自动回复目前仍停止。

共享记忆接口由 `memory.mjs` 提供。新版插件和独立软件通过 `%USERPROFILE%/.dsh/douyin-browser/runtime-location.json` 共用同一 `memoryDir` 与精确 `memoryDbPath`；首次登记保留已存在的旧中央库 `D:/codex分局/大肥鱼/memory/shared.sqlite`，不复制或迁移数据库。新机器默认库为 `%USERPROFILE%/.dsh/douyin-browser/memory/shared.sqlite`。独立软件发现显式 `DEEPSEEK_SHARED_MEMORY_DB` 与既有登记冲突时拒绝切库；损坏记录也不会静默回落。QQ 与视频双向互通另有专项验收，视频或私信工具通过不代表该部分全部完成。

## 复用与来源

原生插件使用 Microsoft Playwright CLI/MCP 的浏览器库及 `connectOverCDP`、本机 DSH runtime、Loader 和附件接口。独立软件直接安装锁定的 `playwright-core`，复用官方 MIT React 基础组件与主题，使用 Electron、随包 Node 的 fetch、HTTP、IPC 和 SQLite；完整来源见 [desktop/UPSTREAM.md](desktop/UPSTREAM.md)。已研究的相关抖音插件未覆盖本项目全部需求，因此补了网页适配、受限工具与本机入口；不宣称首创。CDP 能力、网页 DOM 变化和登录验证仍会限制操作。

媒体模块实际保留三个社区项目的源码和 MIT LICENSE，固定 commit 及 SHA256 见 `media/PROVENANCE.json`：`ch1bug/dsh-mimo-agent-tools`、`GooDAnDReaDY/dsh-voice`、`moluyao/dsh-minimax-asr`。它们不是 DeepSeek 官方媒体插件；本项目补了独立开关、后端选择、预算、进程调用和配置去敏。具体复用文件及许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 验收记录

- 真实浏览器与 API：推荐播放时间推进、上下切换、暂停、猫咪搜索、开结果与三帧采样通过；DeepSeek 自主搜索、开作品、观察并暂停，本机 HTTP 控制台和启动脚本通过。
- 真实 DSH：旧版视频浏览、图片附件输入和两位许可会话读取已通过。旧任务 `d1d836bf-a85f-487c-925c-a8bd82579e23` 因 `remove` 未卸载旧 include 条目而热升级失败；原记录保留。用户追加授权的任务 `461ff7a2-5741-41bb-85c9-92b6e82bc71e` 使用修复后的 v5 helper，一次执行完成 22 项目录核对、时限与默认关闭音频状态、两位已关注个人会话及其顺序/最新端字段、精确表情图片和转发人工授权分支。Codex 独立核对原生日志，并回读 138×138 JPEG 附件，4355 字节及 SHA256 均与原生 ref 一致。本轮无外发、未改设置；执行回执和独立复核分别在 `verification/native-rich-workdir/recheck-20261015/native-v5-receipt.json`、`root-review.json`。桥状态仍为 `needs_review`，独立复核不冒充桥自动 accepted；Loader 运行态 URI 未单独导出，v5 由原文 helper 断言与实际工具调用核对。
- 私信发送：本人授权的一条明确测试消息已在真人会话发送，界面回读 `confirmed=true`，再次读取仍存在，`persisted=true`。证据为 `verification/chat-human-send-live.json`；这不代表新消息自动回复全过程已被真人触发验收。
- 富媒体：真实表情、分享卡片的精准截取和公开作品 URL 解析通过；另将一张精确表情截图送入真实 DeepSeek，得到回复但没有向真人发送，见 `verification/chat-rich-api-live.json`。两位联系人真实只读回查确认逆序 DOM 已按时间先后输出、最新端已核实、消息 ID 稳定，见 `verification/chat-chronology-readonly-live.json`。当前图文仅到封面、元数据和 URL，不能称全图文读取。
- 视频时限：共享时钟、跨午夜、到点取消任务及临时 Edge 视频定时暂停通过。真实 API、DSH 两个专用抖音页在到点前均播放，到点后由后台检查暂停；观测延迟为 2652 毫秒（约 2.65 秒），原策略已恢复，见 `verification/video-limits-live.json`。这次观测不保证所有环境都能零延迟暂停。
- 本地音频：Whisper 真正识别了合成 WAV 和无容器时长的 WebM 对白，返回文本及时间段。真实抖音已采到 3 秒音轨，但这段猫咪视频没有有效对白，不能据此验收 ASR 准确性或声称听懂音频。MiMo/MiniMax 没有做真实云联调。
- 原生转发：本人授权的一次发送点击最初回读未确认；随后没有再次发送，只读打开实际发出的作品卡片，公开作品 ID `7579432563794584933` 与所选作品精确一致，真实卡片转发及回查通过。原初失败保留于 `verification/video-forward-human-live.json`，回查为 `verification/video-forward-post-readback.json`。2026-10-15 的新版 DSH 工具仅实测人工授权提示分支，没有再执行发送；自动回复仍关闭。

自动测试包含替身模型/控制器、真实 HTTP、临时 Edge 页面、真实 DSH SDK 与本地媒体运行；这些与真人发送、真实模型调用分别记录：

2026-10-15 本次源码测试共 201 项，194 项通过、0 项失败，7 项按配置跳过可选实测。原生 SDK 适配上一次单独验证为 23 项通过。本地 Whisper 的单独真实转写记录见上文，跳过项不计作本次通过。

独立软件新增的 HTTP、真实 Node IPC、共享位置与临时 SQLite 验证另有记录：相关 23 项通过，包含软件及插件解析同一文件、原记忆库内容不变、密钥不回读、异常启动及退出清理；界面合成与许可检查 9 项通过。本机打包 EXE 另已验证启动、合成 Key 加密保存、重启恢复、清除和自有后台退出。没有调用真实模型或真人联系人，完整范围见 [desktop/VERIFICATION.md](desktop/VERIFICATION.md)。

```powershell
pnpm test
pnpm run test:native
pnpm run test:browser
```

原生测试依赖已安装 DSH，`DSH_NODE_MODULES` 可指定其 node_modules 目录。浏览器 live 测试需要专用窗口可登录使用，会执行普通浏览与暂停；真人发送只按本人明确授权范围执行。

运行状态、浏览器资料、密钥、SQLite 数据库、聊天正文、联系人标识和验证截图不提交 GitHub。仓库用于私有源码备份，第三方许可证随实际复用文件或依赖保留。
