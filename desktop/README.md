# 大肥鱼抖音助手独立软件

Windows 桌面软件 1.2.0，直接使用用户填写的 API Key 调用模型，控制本机专用 Edge 浏览抖音。基础运行资源随软件提供，使用时无需安装或启动 DSH、Cordis、QQ 服务及 Node.js。原生 v8 插件仍为 27 工具，两种入口共用本地记忆、大肥鱼人格与兴趣。本版补可配置手动任务预算、行为偏好和默认关闭的自主分享；1.1.1、1.1.0 与 1.0.1 验收各自保留，不能替代新版验收。

界面复用 DeepSeek Harness 固定 MIT 源码中的 React 基础组件、主题和布局样式，任务、设置及业务状态由本软件实现。它不是 DeepSeek 官方发行版。来源及复用范围见 [UPSTREAM.md](UPSTREAM.md)、[API_REUSE.md](API_REUSE.md) 和 [REUSE.md](REUSE.md)。

## 使用与设置

需要 Windows x64 和 Microsoft Edge。首页标题栏和首次 Key 表单均有“打开抖音”按钮，不需 Key，可先打开专用窗口手动登录或验证。准备入口会暂停视频，不开始或延长计时；已有自主观看运行时只聚焦现有页，不改它的播放状态。正式浏览仍需本人开始有限轮次。

配置模型时填写 API Key，接口地址和模型可按所用兼容服务修改。主模型密钥通过桌面预加载层交给主进程，再通过私有 IPC 交给随包 Node 后台；普通 HTTP 接口不提供密钥设置与回读。独立软件不会借用旧 DSH 或 QQ 项目的模型凭据。

密钥默认只用于本次运行。选择记住时，软件使用 Electron `safeStorage` 的系统加密，将加密结果保存到 `%APPDATA%/DafeiyuDouyinAPI/api-settings.json`；公开设置只返回是否已配置、接口地址、模型和记住状态。无法加密时只在内存使用，保存失败会提示原磁盘记录可能仍保留。

程序资源首次安装到 `%APPDATA%/DafeiyuDouyinAPI/runtimes/<资源摘要>/`。此目录独立于现有 DSH Desktop 的安装和用户目录，不复制其配置、密钥或会话。

在“刷视频时间”设置每日允许时段和每轮分钟数，点击开始后再提交浏览任务。支持多个时段及跨午夜时段，按北京时间计算；单轮默认 10 分钟，须为 1 至 1440 分钟的整数。保存设置、重新开窗口或模型连续调用都不会延长已开始的一轮；到期后暂停视频并阻止后续浏览。

“手动任务预算”默认 20 步、20 次工具调用、180 秒，可分别设为 1–1000 步、1–1000 次、10–86400 秒，保存后用于后续手动任务。修改前须停止当前任务、自主观看和转发。它与视频时段、单轮截止及自主观看预算独立，任一上限先到便停，不自动续时；持续挑片可用自主观看。

音频默认关闭，可选本地 Whisper、MiMo 或 MiniMax。基础刷视频功能无需接入音频；本地路径仍需另装 Python、FFmpeg 和相应模型，云端后端需独立凭据。模型权重、个人媒体配置不随软件提供。

MiMo 的填写位置为“业务设置 → 音频理解 → 音频后端选择 MiMo → MiMo API Key → 保存音频 Key”。MiniMax 同样先选对应后端，再填 MiniMax API Key。Whisper 不需要云 Key。保存通过窄 Electron IPC 写入与插件共用的媒体 `.env`，这是本机明文配置，与主模型 Key 的可选系统加密保存不同；已保存值不会回显，也不经过本机 HTTP。

保存音频 Key 不开启音频、不切换已保存的运行后端，也不发起云请求。需要处理声音时，再明确设置“读取视频声音”和音频后端，点击“保存音频设置”。`MediaAdapter` 后续读取配置时刷新，无须为了更新文件重建适配器。更换 Key 前须停止正在执行的任务、自主观看和自动回复。

私信自动回复默认停止，只处理明确保存的最多两位已关注个人联系人，保留新消息基线、发送核对和每日预算。普通手动视频模型没有私信发送及可信转发工具。

“自主分享”默认关闭，每日默认 3 次尝试，可设 1–20 次。开启总许可后，自主观看可在现有两位许可好友中自行选择好友与当前已观察作品，通过抖音官方分享界面发送作品卡片，不逐次要求选人或确认。界面显示名单和次数，不发送私信正文、人格或私密记忆，也不增加联系人。预留即计数，失败或人工核对不返还；不确定回执会暂停，须本人在抖音核对后记录“已送达／未送达”，不会自动重发。观看中可随时关闭总开关，无需先停止观看。旧接口仍保留明确选人、选作品的手动转发兼容入口。

“自主观看”须先由本人开始一个尚有效的有限轮次，再明确点击启动。它按大肥鱼的人格与兴趣选择内容，展示剩余时间、当前理由及观察依据；不会自行新开、延长或预约下一轮。默认每轮最多 30 次模型决策，可填 1–100 的整数，同一轮停止再开启不清零；软件与插件每日合计最多 200 次。时限或预算先到便停止。它不发私信、不点赞或评论，视频分享另受总许可约束。

两个入口共享自主 worker 锁，不能各开一条循环；软件可请求停止插件发起的自主观看，反之亦然。手动视频任务与手动转发需等自主观看停止。运行期间不能修改或清除模型配置；程序重启不自动恢复自主循环。自动回复由用户明确启用，本次实现没有代用户修改模型配置或运行设置。

关闭软件会停止它拥有的 API 后台、任务及私信服务，释放客户端连接；专用 Edge 登录窗口继续保留。遇登录或验证码，需要在该窗口手动完成。

## 与插件共用记忆

软件和新版 DSH 插件都读取 `%USERPROFILE%/.dsh/douyin-browser/runtime-location.json`。这是本机位置记录，目录名称沿用已有约定，不要求安装 DSH。记录内的 `memoryDir` 指向共同记忆文件夹，`memoryDbPath` 精确保留数据库文件名；软件设置中可直接打开该文件夹。

首次登记时优先保留已存在的旧中央库，写入其原位置，不复制、搬迁或清空数据库。新机器默认使用 `%USERPROFILE%/.dsh/douyin-browser/memory/shared.sqlite`。已有非标准数据库文件名也可登记；插件随后只读同一位置记录即可找到同一个文件，无需两边各自维护相同环境变量。

位置记录也可保留业务状态和媒体配置的绝对路径，不包含密钥、消息或数据库内容。损坏记录、目录与数据库不一致，或显式 `DEEPSEEK_SHARED_MEMORY_DB` 与已登记路径冲突时，软件拒绝启动，避免生成另一套记忆。修改或升级插件后需重新加载相应源码，才会读取新版定位逻辑。

人格独立位于同一 `memoryDir/persona/`：`role-card.md` 保留手编正文与自动生成区，`state.json` 保存实际观察及大肥鱼自己的兴趣依据。界面可打开人格目录、查看生效人格，并通过显式“编辑人格／保存人格”修改手编正文；兴趣方向、依据数量、更新时间和反思单独展示，不混入编辑框。外部更新或保存版本冲突会保留草稿，不自动覆盖或重试。

兴趣依据来自实际媒体进度和墙钟核算的观看时长、比例，以及已确认的继续停留、跳过、分享行为。帧仅说明采样画面，识别到某主题不等于喜欢；旧记录缺少行为依据时显示“待观察”。界面同时显示时长、比例、动作、判定依据与正负计数，同主题同作品不重复加权。

人格与兴趣仅按本机内部参考使用，不能改变工具权限、时间预算、许可名单或发送规则。代理兴趣不等于用户偏好。QQ 侧可见范围和公开分享授权尚未核实，不能因为两入口共用文件就向 QQ 群聊、公共导出或其他公开渠道传播。

前端通过同源 `/api/watch/state`、`/api/watch/start`、`/api/watch/stop` 读取和控制自主观看，启动固定传 `startSession:false`；人格通过 `/api/persona` 和带 `expectedRevision` 的 `/api/persona/card` 读取、保存。打开人格目录使用无参 `window.douyinDesktop.openPersonaFolder()`，不开放任意路径或 HTTP 打开目录接口。

## 从源码构建

构建环境需 Windows x64、Node.js 24 和 pnpm。首次需要下载公开源码、Electron、Node 和 npm 依赖。固定源码缓存与运行资源均位于 `.cache/`，不提交 Git。

先在 `desktop` 安装桌面构建依赖和固定官方 UI 源码：

```powershell
pnpm --ignore-workspace install --ignore-scripts --frozen-lockfile
node node_modules/electron/install.js
node scripts/acquire-upstream.mjs
node scripts/stage-api-runtime.mjs --prepare-node-only
```

再按界面、后台、桌面入口、打包的顺序执行：

```powershell
cd ui-api
pnpm --ignore-workspace install --ignore-scripts --frozen-lockfile
node build.mjs
cd ..
node scripts/stage-api-runtime.mjs
node scripts/build-api-desktop.mjs
pnpm package:dir
pnpm package:portable
```

`--prepare-node-only` 只准备经官方压缩包与 SHASUMS 核对的 Node/npm。默认的 `stage-api-runtime.mjs` 也会自动完成这一步，再准备白名单领域文件、界面产物、私有 IPC worker 与两项后台 npm 依赖。它校验固定 Node/SQLite、媒体来源哈希、依赖锁文件及运行文件范围；运行目录中不包含 DSH Host、Cordis、账号配置或个人状态。前端许可证随界面产物保留，后台与 Electron/Node 的许可证随实际分发资源保留。

输出位于 `release-api/`，便携包文件名为 `Dafeiyu-Douyin-API-<版本>-win-x64.exe`。这是未签名的 Windows 开发版本，分发前仍需完成签名及其他机器的兼容性验收。

## 验证范围

1.2.0 的新设置、轮询草稿保护、自主分享异常核对和行为依据已用合成服务、headless 临时 Edge 验证。启动导航只对受控本机首页的特定瞬时错误有限重试，先检查 HTTP 内容与页面就绪；窗口销毁或后台退出不重试。`%APPDATA%/DafeiyuDouyinAPI/startup-diagnostics/` 保留去敏时间线，错误历史在 `startup-errors/`，成功后归档并清除旧 `startup-error.txt`。此前真实 `ERR_FAILED(-2)` 成因仍未确定，不能宣称所有启动故障已解决。

截图 caret／页面状态修复已在临时页面验证，尚不能称真实抖音所有画面问题已修复。当前完整测试、包哈希与真实窗口范围统一见 [VERIFICATION.md](VERIFICATION.md)；以下为旧版记录。

旧版后台及路径验证已用真实临时 HTTP、真实 Node 子进程和临时 SQLite 检查配置、IPC 启停、断线退出、密钥不回读、共享记忆路径及原库不变，相关 23 项通过。1.1.0 阶段的根目录与 desktop 完整回归实际运行 237 项，230 项通过、0 项失败、7 项可选检查跳过，用时约 19.7 秒。

1.1.0 界面合成流程与许可检查 12／12 通过，包含两个临时 Edge 流程，覆盖预算、入口互斥、协作停止、人格草稿与版本冲突、重载不自启。新版原生 SDK 测试另有 25／25 通过。界面使用合成服务，SDK 使用独立 Context 与临时配置、附件；没有调用真实模型或真人联系人。

1.1.0 的 `win-unpacked` 已实际打包回读：随包物理 Node 24.17.0、SQLite 3.53.0、27 项工具及 persona／watch 模块可导入，没有 DSH 运行包。这证明该版本运行资源可用，不代表 1.1.1 新窗口已经验收。

1.1.1 阶段 UI 完整测试 15／15 通过，其中新增输入外观 1／1，临时 Edge 实际核对单层焦点环、密码遮挡和数字步进；打开入口及音频 Key 合成流程另有 1／1，验证不需主模型 Key 的准备入口、窄 IPC、保存后仍关闭音频及敏感值不进入 HTTP。一键打开后端 6／6、相关回归 32／32，原生 SDK 的原有 25 项加命令新增 7 项合计 32／32 通过。它们没有访问真实抖音或验证云端 Key。最终完整回归数字、软件包验收及哈希统一见 [VERIFICATION.md](VERIFICATION.md)，不把历史结果混算为本版通过。

在仓库根目录可运行：

```powershell
node --test tests/api-desktop.test.mjs tests/runtime-paths.test.mjs desktop/tests/api-worker.test.mjs desktop/tests/api-process.test.mjs desktop/tests/prepare-api-runtime.test.mjs
node --test desktop/ui-api/tests/*.test.mjs
```

历史 1.0.1 打包 EXE 已验证实际启动、合成 Key 加密保存、重启恢复、清除和自有后台退出，详见 [VERIFICATION.md](VERIFICATION.md)；该记录不覆盖 1.1.0 的人格与自主观看。新版本的真实模型、音频云服务、抖音发送及其他机器兼容性未在本次验收。原插件与旧本机 API 的实测记录保留在[主 README](../README.md)。
