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

## 省图片成本的视频分镜

复用 SAOS-3624/dsh-video-storyboard 0.4.4 固定提交 2ba682d471a0e63defdb5e8e023465ab59806b05 的纯 RGB 布局、编号和拼图代码，按 MIT 分发。适配只作用于本项目已核实的视频采样，不启用上游下载器、全局 ASR 或进程托管。版权及完整许可见 storyboard/vendor/LICENSE，原 NOTICE 与逐文件来源见 storyboard/PROVENANCE.json。上游文档中的作者视频图片未复制。

JPEG 编解码复用 jpeg-js 0.4.4，保留 BSD-3-Clause 许可证；其 decoder.js 原有 Copyright 2011 notmasteryet 的 Apache-2.0 声明及完整 Apache 文本均保留，encoder.js 的 Adobe BSD 声明也保留。文件见 storyboard/vendor/jpeg-js/。不新增原生图片库或自动下载运行依赖。拼成一张图不等于所有模型固定计费384 token，实际以所选模型返回的用量为准。
