# 许可证原文

`DeepSeek-Harness-MIT.txt` 原样复制自官方 `deepseek-ai/deepseek-harness` 的固定 commit `fb2c4b9e698e30edb738bca4cf0618587db7d203` 根目录 `LICENSE`。获取脚本同时核对源码中的原件和这里保留的副本。

官方 React 基础组件和主题样式的复用来源见 `../UPSTREAM.json` 与 `../UPSTREAM.md`。这份 MIT 通知随软件分发。独立版不捆绑官方 Host 或 Cordis。

这里还保留同一 commit 的完整 `THIRD_PARTY_NOTICES.md`、`vendor/README.md` 和 9 份 vendored MIT 许可证原文，文件哈希记录在 `UPSTREAM.json` 的 `retainedNotices`。这些是上游工作区的来源材料，并非本应用实际安装包依赖清单；通知中的相对链接按原文保留，可在固定源码中追溯。

此目录的 DeepSeek 通知不覆盖第三方运行时和依赖。界面构建会把实际打入产物的依赖许可证写入 `ui-api/dist/licenses/`，字体另保留 OFL 通知；后台构建保留 Node、Playwright、YAML 与媒体模块许可证。Electron/Chromium 的许可文件由 Electron 分发包提供。pnpm 只用于构建，不随软件分发。
