# 独立 API 软件复用记录

独立软件直接连接用户填写的模型接口，不安装、启动或捆绑 DSH Host、Cordis、社区桌面壳或插件市场。复用已有浏览器领域层、有限视频轮次、许可私信服务、媒体可选模块和共享记忆存储，保留真实工具结果与原有安全边界。

界面复用官方 `deepseek-ai/deepseek-harness` 固定提交 `fb2c4b9e698e30edb738bca4cf0618587db7d203` 中可独立使用的 React UI primitives、主题样式。API 请求、软件设置与界面状态由本软件实现；没有模拟 DSH RPC 或冒充其运行会话。官方 MIT 全文保存在 `licenses/DeepSeek-Harness-MIT.txt`。

桌面壳使用 Electron，浏览器控制使用 Playwright，后台使用随包 Node.js 的 HTTP、SQLite 与进程 IPC。可选音频模块保留既有三个社区项目的 MIT 与来源说明，不捆绑个人凭据或模型权重。未使用鲸鱼插件的受限图片或音效资产。

主进程接收 API Key，通过本机进程 IPC 交给自有后台；普通 HTTP 接口不设置或返回密钥。可选记住密钥使用 Electron safeStorage 的系统加密。两种入口通过同一全局位置记录解析同一个记忆文件夹及精确数据库路径，不复制正在运行的 DSH 的凭据、会话或插件目录。
