# 第三方来源与许可证

## 浏览器、运行时及接口

- Microsoft Playwright CLI 0.1.22、Playwright MCP 0.0.83 及锁定的 playwright-core：Apache-2.0，来源为 [Microsoft Playwright](https://github.com/microsoft/playwright)。依赖由包管理器安装，原 LICENSE 和版权声明保留在包内；分发时须保留 Apache-2.0 要求的声明和通知。
- DSH 原生插件使用本机已安装产品的 runtime、schema、Cordis Loader 与附件接口，相关包的 MIT LICENSE 留在依赖内。独立软件的 UI 源码复用范围另见下文；账号配置和个人历史不随源码或软件提供。
- DeepSeek API：按官方 Chat Completions 协议调用，使用用户已有账户配置；接口服务使用与费用另受供应商条款约束。
- 相关抖音方案研究：`chu557/douyin-plugin-dsh-plugin`（MIT）、`AnacondaKC/dsh-douyin`（BSD-3-Clause）、`q35888/dsh-plugin-browser`（MIT）。本项目没有复制这三个抖音插件的业务实现。

## 1.3 安装、设置与日报流程参考

参考 MIT 项目 [c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll/tree/a047fde1df2be1ec1d9d7551aa0b5eae6626b319) 的标准 bundle 安装声明、原生设置入口与 Markdown 日报流程，核对提交为 `a047fde1df2be1ec1d9d7551aa0b5eae6626b319`。本项目自行实现抖音设置、模型路由、报告汇总与手改保护，没有复制或打包其 Python、B 站 MCP、字幕获取、登录凭据和定时 headless 任务。

续火花另核对 MIT 项目 [HRuiCcc/dy-xuhuohua](https://github.com/HRuiCcc/dy-xuhuohua) 及 MIT 与 NOTICE 项目 [dr-190/ScriptCat-Douyin-Fire-Helper](https://github.com/dr-190/ScriptCat-Douyin-Fire-Helper)；未复制其发送实现或新增其运行依赖。固定提交、未采用原因与本地复用范围见 [功能复用与来源](docs/reuse.md)。来源核查不代表新版插件已实机加载，也不证明评论发布、平台火花或最小化持续播放已通过。

## 实际保存的媒体源码

下列三个社区项目的原始源码和 MIT LICENSE 已复制到 `media/vendor/`，不是仅安装依赖或参考名称。固定 commit、原始路径、SHA256 和 `modified:false` 记录见 [media/PROVENANCE.json](media/PROVENANCE.json)；本机核对全部记录的文件哈希与清单一致。

| 来源 | 固定 commit | 本机文件与用途 | 保留的许可证 |
| --- | --- | --- | --- |
| [ch1bug/dsh-mimo-agent-tools](https://github.com/ch1bug/dsh-mimo-agent-tools/tree/38a7985d25090a4b87b987c2d99613a5c6b318d7) | `38a7985d25090a4b87b987c2d99613a5c6b318d7` | `media/vendor/mimo/driver/mimo_driver.py`；桥接调用其 `build_body` 构造 MiMo 音频、视频请求正文 | [media/vendor/mimo/LICENSE](media/vendor/mimo/LICENSE)，MIT，Copyright © 2026 lihao (ch1bug) |
| [GooDAnDReaDY/dsh-voice](https://github.com/GooDAnDReaDY/dsh-voice/tree/e3e96e0bd3a34d73fec0edac45a1fba1cb7b6f6f) | `e3e96e0bd3a34d73fec0edac45a1fba1cb7b6f6f` | `media/vendor/voice/lib/providers.js`、`provider-http.js`；配置本机 Whisper HTTP 服务时调用其 local-whisper provider | [media/vendor/voice/LICENSE](media/vendor/voice/LICENSE)，MIT，Copyright © 2026 GooDAnDReaDY |
| [moluyao/dsh-minimax-asr](https://github.com/moluyao/dsh-minimax-asr/tree/bbf79d17e32a1dab94bffba20fa6b1fbd8cf700e) | `bbf79d17e32a1dab94bffba20fa6b1fbd8cf700e` | `media/vendor/minimax/lib/index.js`；保留为 MiniMax ASR 请求参数来源，网络请求由本项目 Node.js fetch 适配 | [media/vendor/minimax/LICENSE](media/vendor/minimax/LICENSE)，MIT，Copyright © 2026 moluyao |

三个 MIT LICENSE 均允许使用、修改、分发及商用，同时要求在副本或重要部分中保留版权和许可声明；原许可证全文随源码保留。它们是社区项目，不是 DeepSeek 官方插件；许可证许可不等于云服务可免费调用或保证适配成功。

本地语音路径另依赖 Python、Whisper/faster-whisper、FFmpeg 等已安装运行环境，安装清单见 `media/requirements.txt`；模型权重与运行依赖按各自许可证和使用条件管理。媒体开关默认关闭，本项目没有打包个人凭据或模型缓存。云端后端尚未做真实请求验收，本地合成对白转写已单独验证。实际抖音采到的 3 秒猫咪片段音轨没有有效对白，不作为 ASR 准确性或声音理解验收。

媒体与插件的适配验收分开记录：本地 Whisper 已真实处理合成 WAV、WebM；精确表情截图进入 DeepSeek 的真实请求不使用上述云音频后端，也没有向真人发送。2026-10-15 又独立完成真实 DSH 的 22 项工具目录核对、状态/许可会话读取、表情图片附件和人工转发提示分支；云端音频仍未联调。具体结果及元数据读取限制见主 README 和 PLUGIN-README；上游许可证不改变这些验收边界。

本项目原创代码采用根目录 [LICENSE](LICENSE) 中的 MIT 许可证；第三方源码、字体及依赖继续按各自许可证分发，保留原版权、许可和必要通知。第三方许可和上游测试不替本项目作交付保证。

## 独立 API 桌面软件

界面复用 `deepseek-ai/deepseek-harness` 固定提交 `fb2c4b9e698e30edb738bca4cf0618587db7d203` 中的 `ui-primitives` React 基础组件、`ui-theme` 样式及 `ui-layout` 的 `AppFrame.module.css`。官方 MIT 全文保存在 [desktop/licenses/DeepSeek-Harness-MIT.txt](desktop/licenses/DeepSeek-Harness-MIT.txt)，固定下载与来源校验见 [desktop/UPSTREAM.json](desktop/UPSTREAM.json) 和 [desktop/UPSTREAM.md](desktop/UPSTREAM.md)。同目录留存的完整上游第三方通知用于来源核查，不表示本软件使用了上游全部依赖。

独立软件的模型请求、业务表单、桌面生命周期及 IPC 由本项目实现，运行资源不包含 DSH Host、Cordis、DSH SDK 或社区桌面壳。它不代表 DeepSeek 官方发行，也不复制用户 DSH 的外观图片、桌宠、音效、凭据、会话或历史。

桌面构建使用 Electron `44.0.0`、electron-builder `26.15.3`、esbuild `0.28.1`；后台使用 Node.js `24.17.0`、`playwright-core` `1.64.0-alpha-1790635538000` 和 `yaml` `2.9.0`。Node 完整许可、Playwright 的 Apache-2.0/NOTICE/ThirdPartyNotices 和 YAML 的 ISC 许可随后台实际运行包保留。React、KaTeX 字体、Markdown、Shiki 及其他前端组件以 `desktop/ui-api` 的锁文件和实际构建产物为准，各自版权与许可证随界面产物保存；Electron/Chromium 的通知由桌面分发层保留。

上述依赖的许可不代替模型接口服务的条款，也不构成软件联调保证。可选音频仍使用前述三个社区项目的来源与 MIT；Python、FFmpeg、音频模型及个人密钥不随基础软件提供。构建与验收范围见 [desktop/README.md](desktop/README.md)。
