# 独立 API 后台的第三方来源

此目录只声明独立 Node 后台。React 界面的许可证随 `public` 构建产物保存，Electron 主程序的许可证由桌面打包层保留。

| 来源 | 固定版本 | 用途与许可证文件 |
| --- | --- | --- |
| Node.js | 24.17.0 Windows x64 | 物理 Node 子进程及内置 SQLite；完整上游通知见 `licenses/node/LICENSE` |
| Microsoft Playwright | 1.64.0-alpha-1790635538000 | 通过系统 Edge 操作网页；Apache-2.0、NOTICE、ThirdPartyNotices 均见 `licenses/playwright-core/`，安装包内原件也保留 |
| eemeli/yaml | 2.9.0 | 可选 QQ 共享范围配置的 YAML 解析；ISC，见 `licenses/yaml/LICENSE` |
| 三个社区媒体项目 | 固定 Git commit | 仅复用 `media/PROVENANCE.json` 列出的驱动与 provider；三个完整 MIT LICENSE 位于 `media/vendor/*/LICENSE` |

后台不依赖 DSH、Cordis 或社区 Desktop Host。MiniMax 的 vendor 原始入口只用于来源核对，不由后台加载；其中的 DSH import 不构成运行依赖。媒体功能默认关闭，本地 Python、FFmpeg 和 Whisper 模型为可选安装，不在本目录的基础运行资源中。

`package-lock.json` 的两份公开 npm 包及完整性记录取自已核对的本地固定依赖，安装使用 `npm ci --ignore-scripts`，不执行依赖安装脚本，也不下载 Playwright 浏览器。
