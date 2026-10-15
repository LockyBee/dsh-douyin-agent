# 独立软件复用记录

独立软件直接连接用户填写的模型接口，使用 Electron 桌面窗口和随包 Node 后台。无需安装、启动或捆绑 DSH Host、Cordis、QQ 服务或社区 Desktop 壳。原生 DSH 插件作为同仓库的另一个入口继续维护。

界面选择官方 `deepseek-ai/deepseek-harness` 固定提交 `fb2c4b9e698e30edb738bca4cf0618587db7d203` 的 MIT React 基础组件、主题和布局 CSS。它们可独立编译到前端，保留原许可证；软件自行实现任务、API 设置、时间限制、私信与转发表单的状态和交互。复用文件及来源校验见 [UPSTREAM.md](UPSTREAM.md)。

业务层沿用本项目已有的 `BrowserController`、`ChatService`、`VideoLimits`、媒体适配及记忆存储。后台使用物理 Node 的 HTTP、SQLite 和 IPC，浏览器通过 Playwright 连接系统 Edge。新增桌面生命周期、API Key 输入及可选系统加密、静态资源服务、可信转发按钮和 Windows 打包入口。

两种入口读取同一个全局位置记录，使用 `memoryDir` 与精确的 `memoryDbPath` 访问同一记忆文件夹和数据库。登记时保留旧库，不复制或迁移数据；发现路径冲突或损坏记录便停止，不静默创建另一套记忆。

主要限制为抖音网页 DOM 与平台登录状态、用户设置的每日窗口及单轮时长、模型任务预算和私信许可名单。音频默认关闭，可选本地与云端后端；Python、FFmpeg、模型权重和个人凭据不随基础软件提供。

Node、依赖锁文件、来源与许可证在构建阶段分别核对；后台测试、界面合成测试、打包后的软件冷启动、真实模型和真人发送分开记录。新增软件不会重复原先已授权完成的真人私信或作品转发测试。当前验收范围见 [README.md](README.md)。
