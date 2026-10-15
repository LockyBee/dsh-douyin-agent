# 第三方来源与许可证

## 浏览器、运行时及接口

- Microsoft Playwright CLI 0.1.22、Playwright MCP 0.0.83 及锁定的 playwright-core：Apache-2.0，来源为 [Microsoft Playwright](https://github.com/microsoft/playwright)。依赖由包管理器安装，原 LICENSE 和版权声明保留在包内；分发时须保留 Apache-2.0 要求的声明和通知。
- DSH 原生 runtime、schema、Cordis Loader 与附件接口：调用本机已安装产品的公开接口，相关包的 MIT LICENSE 留在依赖内。本仓库没有复制 DSH 产品文件或账号配置。
- DeepSeek API：按官方 Chat Completions 协议调用，使用用户已有账户配置；接口服务使用与费用另受供应商条款约束。
- 相关抖音方案研究：`chu557/douyin-plugin-dsh-plugin`（MIT）、`AnacondaKC/dsh-douyin`（BSD-3-Clause）、`q35888/dsh-plugin-browser`（MIT）。本项目没有复制这三个抖音插件的业务实现。

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

本仓库目前是私有源码备份，尚未为本项目自身指定开源许可证。第三方许可和上游测试不替本项目作交付保证。
