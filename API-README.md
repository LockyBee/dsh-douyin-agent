# 大肥鱼 · 独立视频助手

双击本目录的 `start-api.cmd`，或执行：

```powershell
& 'D:/codex分局/dsh配置/douyin-browser/start-api.ps1'
```

启动后打开 `http://127.0.0.1:3218`，在“刷视频时间”点击“开始新一轮”，再输入“搜索猫咪，观察当前视频 3 秒，告诉我看到了什么”等任务。DeepSeek 自己发出工具调用，读回浏览器结果再决定下一步。可以点击“停止”中断任务；抖音窗口和登录资料会保留。遇到登录、验证码请在专用 Edge 窗口手动完成，再重新发起任务。

运行需要 Node.js 22.13+、本目录已安装的 Playwright 依赖和 Microsoft Edge。本机当前为 Node.js 24.19.0。工具不要求 DSH、QQ 机器人或 QQ 服务正在运行。

2026-10-15 整理时，本机控制台服务已恢复，私信自动回复仍关闭。下面是启动和使用说明，用户要求继续工作并不表示自动回复已启用。

## 复用与配置

复用 QQ 机器人项目 `D:/codex分局/聊天机器人` 的 `.env` 配置方式，用 Node.js 内置的 [util.parseEnv](https://nodejs.org/api/util.html#utilparseenvcontent) 解析文件，仅选取 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`，在当前服务进程的内存中使用。不复制 `.env`，不载入其余账号字段，不向网页返回密钥，也不改变 QQ 机器人的模型配置。启动进程环境变量优先于该文件；无需安装或启动 QQ 项目的依赖。

默认模型为 `deepseek-flash`；浏览器画面以少量图片输入返回给模型。2026-10-14 核对的 [DeepSeek Chat Completions 官方协议](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/) 支持 `tool_calls`、非思考模式与 `image_url` Base64 输入。本工具使用该协议，图片仅通过实际浏览器采样取得。兼容供应商是否支持图片，以实际请求为准；如果图片被拒绝会报告失败，不会用网页标题代替画面理解。需要临时指定模型或端口时，在启动前设置环境变量：

```powershell
$env:DOUYIN_MODEL = 'deepseek-flash'
$env:DOUYIN_API_PORT = '3218'
& 'D:/codex分局/dsh配置/douyin-browser/start-api.ps1' -Port 3218
```

`DOUYIN_QQ_ROOT` 可指定另一个 QQ 机器人项目目录。也可以只设置当前进程的 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_BASE_URL`，无需读取 QQ 项目。不要把密钥写入此文档、命令参数或网页。

浏览器控制与记忆读写复用 `core.mjs` 和 `tool-definitions.mjs`，当前原生工具目录有 22 项；普通视频 API 模型过滤所有聊天工具和转发工具。API 请求采用 Node.js 内置 `fetch`，不新增框架依赖。QQ 与刷视频的统一记忆库默认位于 `D:/codex分局/大肥鱼/memory/shared.sqlite`；视频侧通过 `douyin_recall` / `douyin_remember` 接入，是否连通应查看实际检索结果和专项验证。空检索词只查看已同步笔记；检索 QQ 聊天时需要输入相关词。

读取作品状态时会自动记录该作品的来源和文案，作为浏览记录；`douyin_remember` 另存用户指定的笔记。页面检索会显示来源和 QQ 是否可读，相关聊天历史保留“未确认为偏好”标记。

## 能力与限制

- 工具允许打开抖音、搜索、上下切换、播放与暂停、读取状态、采样画面、截图、记录和检索记忆。
- 视频任务没有点赞、关注、评论、裸私信发送、发布和购买工具。私信自动回复由下述独立许可名单服务处理。
- 每个任务最多 20 轮模型请求、20 次工具调用、180 秒；每次模型请求最多 60 秒、生成最多 2048 token。达到限制或响应被截断会报告未完成，不会自动重试新任务。页面显示 API 报告的累计 token 用量。
- 模型调用会使用 DeepSeek API 额度。浏览器截图和任务相关的检索记忆会进入该次模型请求；每次最多保留最新 4 张、每张不超过 2 MB。旧采样从后续请求中移除，文字状态保留。服务日志和网页事件中不记录图片 Base64、密钥、Cookie 或模型推理内容。
- 音频理解默认关闭，单独开启后才交给所选音频后端；仅有画面采样时不能声称听懂声音或看完全部视频。网页变化可能使工具失败，以实际回读为准。
- 服务只监听 `127.0.0.1`，校验 Host、Origin 和内存会话令牌。不要把本地端口代理到公网。

控制台停止按钮用于结束当前模型任务。达到时间限制、正在等待 API 或正在采样时，停止信号也会传给当前操作。等待页面显示“任务已停止”后可开始下一次任务。

若要关闭本机 HTTP 服务，可在任务管理器结束 `state/api-server.pid` 对应的 Node.js 进程。请先核对进程命令行为本目录的 `app.mjs`。自定义端口的日志及 PID 文件会增加端口后缀，例如 `state/api-server-3219.pid`。浏览器窗口不会因停止模型任务而关闭。也可在本目录运行 `node app.mjs`，以 `Ctrl+C` 结束服务。

## 视频时间、音频和转发

“刷视频时间”可设置 1 至 16 个每日允许窗口，按北京时间计算，每行一个 `HH:MM-HH:MM`；跨午夜可写 `23:00-01:00`，全天可用 `00:00-24:00`。每轮默认 10 分钟，可改为 1 至 1440 分钟的整数；不接受无穷时长、零上限或空窗口。设置保存在本机 `state/video-policy.json`，API 与 DSH 共用 `state/video-sessions.json` 中的一轮时钟。切视频、重新打开或重新调用工具不会重置它；保存更长上限也不会延长已经开始的这一轮。只有本人点击“开始新一轮”或执行用户专用 CLI 命令才重新计时。

到单轮上限或允许窗口结束时，服务会实际暂停 API、DSH 的专用视频页面，并取消正在执行的视频模型任务与分享操作。点击“结束当前轮”也会暂停。私信回复 worker 使用自己的运行状态和预算，不受视频时限影响。

“可选音频理解”有独立开关和 `local-whisper`、`minimax`、`mimo` 后端选择。默认关闭，本机 Whisper 不需要云端密钥；两个云端后端需要独立配置凭据。当前上层可录取视频短音轨并转写，收到的语音私信仍为未支持类型。页面只读回启用设置和依赖是否可用，不接收密钥。本地 Whisper 已真实转写合成 WAV 和无容器时长 WebM。真实抖音已采到 3 秒音轨，但猫咪片段没有有效对白，未验收 ASR 准确性，也不能称听懂声音；见 `verification/audio-browser-live.json`。MiMo/MiniMax 尚未真实云联调。

媒体源码随工具保存，实际复用三个社区项目的固定 commit 原文件及 MIT LICENSE：`ch1bug/dsh-mimo-agent-tools` 的 MiMo 请求正文驱动、`GooDAnDReaDY/dsh-voice` 的本机 Whisper HTTP provider、`moluyao/dsh-minimax-asr` 的 ASR 参数来源。来源、文件哈希和许可见 `media/PROVENANCE.json` 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，安装和开关说明见 [media/README.md](media/README.md)。这些社区源码不是 DeepSeek 官方媒体插件。

“转发作品给好友”可留空使用当前作品，或输入标准 `https://www.douyin.com/video/数字` 链接，再选择许可名单中的当前已关注个人好友并点一次“转发这条作品”。普通视频模型没有转发工具；明确按钮请求或本人手动 CLI 命令才传入可信的 `humanAuthorized` 选项。DSH 的模型入口只提示使用按钮，2026-10-15 实机返回 `requiresUserAction=true`、`sent=false`。发送前还会核对名单和关注关系。分享面板可能开始播放，因此转发也受本轮视频时限约束。未确认结果提示人工核对，不自动重试；暂不支持的平台界面不会自动改发文本链接。

真实作品卡片转发已执行一次本人授权的点击，初始自动回读未确认。随后没有重发，只读打开实际发出的卡片，公开作品 ID `7579432563794584933` 与所选作品一致，转发和再次回查通过。初始失败与后续证据分别保留在 `verification/video-forward-human-live.json`、`verification/video-forward-post-readback.json`。真实 DOM 消息逆序问题修正后的两人只读回查确认消息 ID 稳定，私信自动回复仍停止。

对应本机接口为 `GET /api/video/status`、`POST /api/video/policy|start|end`、`GET /api/media/state`、`POST /api/media/configure`、`GET /api/forward/contacts` 和 `POST /api/forward`。设置和转发接口都需要控制台当前会话令牌，拒绝跨来源、非本机地址、超长内容和非法参数。

## 开发与验证

```powershell
node --test 'D:/codex分局/dsh配置/douyin-browser/tests/api-agent.test.mjs'
```

定向测试使用假的模型和控制器，覆盖工具回读、图片回传与预算、停止、截断与损坏响应、凭据去敏，以及真实 HTTP 请求下的 Host、Origin、令牌、JSON 内容和大小限制。临时 Edge 测试检验任务填入、开始、停止、笔记检索和桌面/手机宽度布局；它使用替身控制器，不操作登录资料。启用页面测试：

```powershell
$env:DOUYIN_UI_TEST = '1'
node --test 'D:/codex分局/dsh配置/douyin-browser/tests/api-agent.test.mjs'
```

2026-10-14 完成两次最小真实 API 请求，均为 HTTP 200，返回模型为 `deepseek-flash`：一项按要求发出了 `douyin_status` 工具调用；另一项接收已有的真实抖音截图，答出了中间人物的外套、内搭和户外树林背景。该验证只证明当前接口的工具协议与图片输入可用，没有在这两次请求中调用浏览器。

完整真实 API 任务也已通过，证据见 `verification/api-live.json`：DeepSeek 自主调用搜索、打开第 0 条作品、播放、状态回读、截图、观察 3 秒和暂停，共 8 轮模型请求、7 次工具调用。视频 ID 为 `7392936380776647970`；3 张实际采样的播放时间从 2.780735 秒推进到 5.948728 秒，最后回读 `paused=true`。首次播放遇到视频尚未进入视口的错误，模型重新读取状态后恢复，证据保留了该次失败，没有将它计为播放成功。

启动脚本和 HTTP 页面也已实测。`start-api.ps1 -NoOpen` 成功启动 `http://127.0.0.1:3218`；在真实临时 Edge 的控制台提交读取当前播放状态的任务，DeepSeek 自主调用工具后答出了对应作品作者与已暂停状态，页面无脚本错误，桌面和手机宽度均无横向溢出。证据见 `verification/api-console-live.json` 与 `verification/api-console-live.png`。

上述 API 验证与 DSH 插件加载、QQ 双向记忆分别验收。旧热升级失败回执保留在 `verification/native-rich-workdir/native-rich-receipt.json`。2026-10-15 用户追加授权的桥任务 `461ff7a2-5741-41bb-85c9-92b6e82bc71e` 已刷新到完整 22 项工具，并真实核对时间/音频状态、两位许可会话、精确表情附件与转发人工授权提示；Codex 独立回读原生日志及附件哈希、尺寸。详细结果及 Loader 元数据读取限制见 PLUGIN-README 和 `verification/native-rich-workdir/recheck-20261015/`，桥状态仍保留 `needs_review`，不冒充自动 accepted。

视频时限、音频设置和转发入口通过真实 HTTP 校验、跨午夜及共享时钟、到点取消模型任务、两页真实 HTML 视频被定时暂停，以及临时 Edge 中修改设置和点一次合成好友转发。音频后端和好友发送在这些控制台测试中使用替身，没有调用云端音频或发送真人私信。

实际抖音到期暂停也已通过：API、DSH 两个专用页到点前都在播放，之后仅由后台时限检查暂停，观测延迟为 2652 毫秒（约 2.65 秒），原策略已恢复，见 `verification/video-limits-live.json`。这是本次实测延迟，不是所有环境的暂停时延保证。

```powershell
$env:DOUYIN_UI_TEST = '1'
node --test tests/api-agent.test.mjs tests/video-limits.test.mjs tests/api-settings.test.mjs
```

## 私信自动回复

控制台下方可读取当前联系人、选择最多两个已核对的关注联系人、设置每日模型请求上限，再启用自动回复。服务每 15 秒检查新私信，没有新消息不请求模型。默认每日最多 40 次请求，每条最多生成 512 token，回复带“自动回复”标记。DSH 原生入口通过同一个 `ChatService` 启停；两个入口共用 worker 锁，不会各自回复一遍。

启用时重新读取关注关系并建立现有消息基线，只回复之后新到达且方向、会话身份和消息指纹可确认的消息。文字、已识别的表情与分享卡片可进入回复；表情和卡片只截取精确的指定消息，实际分享视频采样另受本轮时间门控。图文作品目前只读取封面、网页元数据及核实的公开 URL，没有读取整套图片。普通图片、收到的语音、撤回等未支持类型记录跳过。生成期间本人已回复、私信被撤回或媒体信息改动时不发送；发送前再次核对消息水位。发送未确认会挂起联系人，用户核对后可解除暂停，不自动重发。模型错误、预算限制或停止时的未答消息保留在本机待核对清单；重新启用也不会自动补发旧消息。

回复模型只接收该白名单会话在本次启动后的相关消息，不接入 QQ 或其他联系人历史，不提供任意工具或裸发送接口。私信正文、联系人标识、白名单、水位和发送日志都留在本机 `state/`，不得上传源码仓库。关闭一个入口只关闭它自己运行的回复 worker；另一个入口可根据当前运行 ID 发送停止请求。服务进程重新启动后需再次启用。

私信模型与服务的合成测试在 `tests/chat.test.mjs`；跨进程锁测试确实使用两个本机 Node.js 进程，消息、控制器和发送结果为合成替身。控制台白名单、启停与预算经过临时 Edge 检查，真实 ChatAgent API 协议与联系人关系另有记录。

本人授权的一条明确功能测试消息已发给真人联系人，回读 `confirmed=true`，再次读取仍存在、`persisted=true`，见 `verification/chat-human-send-live.json`。这证明该次文字发送和回读，不证明收到新消息后的自动模型回复已经被真人触发。真实表情、分享卡片精准截取及公开 URL 解析也已通过；当前图文仍只到封面、元数据和 URL。私人正文、名单和日志不发布到源码仓库。

一张精确表情截图已送入真实 DeepSeek 并生成回复，这次没有真人发送，见 `verification/chat-rich-api-live.json`。`verification/chat-chronology-readonly-live.json` 对两位联系人的真实会话做了只读回查：DOM 为新消息在前，输出已按旧到新排序，最新端核实且两人的消息 ID 稳定；该检查没有模型调用或发送点击。它们不代表当前自动回复已启用。
