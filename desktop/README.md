# 大肥鱼抖音助手独立软件

Windows 桌面软件，直接使用用户填写的 API Key 调用模型，控制本机专用 Edge 浏览抖音。基础运行资源随软件提供，使用时无需安装或启动 DSH、Cordis、QQ 服务及 Node.js。原有 DSH 插件继续保留，两种入口共用本地刷视频记忆。

界面复用 DeepSeek Harness 固定 MIT 源码中的 React 基础组件、主题和布局样式，任务、设置及业务状态由本软件实现。它不是 DeepSeek 官方发行版。来源及复用范围见 [UPSTREAM.md](UPSTREAM.md)、[API_REUSE.md](API_REUSE.md) 和 [REUSE.md](REUSE.md)。

## 使用与设置

需要 Windows x64 和 Microsoft Edge。软件启动后打开设置，填写 API Key；接口地址和模型可按所用兼容服务修改。密钥通过桌面预加载层交给主进程，再通过私有 IPC 交给随包 Node 后台；普通 HTTP 接口不提供密钥设置与回读。独立软件不会借用旧 DSH 或 QQ 项目的模型凭据。

密钥默认只用于本次运行。选择记住时，软件使用 Electron `safeStorage` 的系统加密，将加密结果保存到 `%APPDATA%/DafeiyuDouyinAPI/api-settings.json`；公开设置只返回是否已配置、接口地址、模型和记住状态。无法加密时只在内存使用，保存失败会提示原磁盘记录可能仍保留。

程序资源首次安装到 `%APPDATA%/DafeiyuDouyinAPI/runtimes/<资源摘要>/`。此目录独立于现有 DSH Desktop 的安装和用户目录，不复制其配置、密钥或会话。

在“刷视频时间”设置每日允许时段和每轮分钟数，点击开始后再提交浏览任务。支持多个时段及跨午夜时段，按北京时间计算；单轮默认 10 分钟，须为 1 至 1440 分钟的整数。保存设置、重新开窗口或模型连续调用都不会延长已开始的一轮；到期后暂停视频并阻止后续浏览。模型任务另有最多 20 步、20 次工具调用和 180 秒的预算。

音频默认关闭，可选本地 Whisper、MiMo 或 MiniMax。基础刷视频功能无需接入音频；本地路径仍需另装 Python、FFmpeg 和相应模型，云端后端需独立凭据。模型权重、个人媒体配置不随软件提供。

私信自动回复默认停止，只处理明确保存的最多两位已关注个人联系人，保留新消息基线、发送核对和每日预算。普通视频模型没有私信发送及视频转发工具。转发通过界面明确选择许可好友和作品后提交，结果未确认时不会自动重发。

关闭软件会停止它拥有的 API 后台、任务及私信服务，释放客户端连接；专用 Edge 登录窗口继续保留。遇登录或验证码，需要在该窗口手动完成。

## 与插件共用记忆

软件和新版 DSH 插件都读取 `%USERPROFILE%/.dsh/douyin-browser/runtime-location.json`。这是本机位置记录，目录名称沿用已有约定，不要求安装 DSH。记录内的 `memoryDir` 指向共同记忆文件夹，`memoryDbPath` 精确保留数据库文件名；软件设置中可直接打开该文件夹。

首次登记时优先保留已存在的旧中央库，写入其原位置，不复制、搬迁或清空数据库。新机器默认使用 `%USERPROFILE%/.dsh/douyin-browser/memory/shared.sqlite`。已有非标准数据库文件名也可登记；插件随后只读同一位置记录即可找到同一个文件，无需两边各自维护相同环境变量。

位置记录也可保留业务状态和媒体配置的绝对路径，不包含密钥、消息或数据库内容。损坏记录、目录与数据库不一致，或显式 `DEEPSEEK_SHARED_MEMORY_DB` 与已登记路径冲突时，软件拒绝启动，避免生成另一套记忆。修改或升级插件后需重新加载相应源码，才会读取新版定位逻辑。

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

新增后台及路径验证已用真实临时 HTTP、真实 Node 子进程和临时 SQLite 检查配置、IPC 启停、断线退出、密钥不回读、共享记忆路径及原库不变，相关 23 项通过。界面合成流程与许可检查 9 项通过。后台验证没有调用真实模型、浏览器或真人联系人；界面测试也不代表真实模型或抖音发送已经验收。

在仓库根目录可运行：

```powershell
node --test tests/api-desktop.test.mjs tests/runtime-paths.test.mjs desktop/tests/api-worker.test.mjs desktop/tests/api-process.test.mjs desktop/tests/prepare-api-runtime.test.mjs
node --test desktop/ui-api/tests/*.test.mjs
```

本机打包 EXE 另已验证实际启动、合成 Key 加密保存、重启恢复、清除和自有后台退出，详见 [VERIFICATION.md](VERIFICATION.md)。新软件的真实模型、音频云服务、抖音发送及其他机器兼容性未在本次验收。原插件与旧本机 API 的实测记录保留在[主 README](../README.md)。
