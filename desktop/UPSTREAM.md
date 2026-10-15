# 官方 UI 源码来源

独立软件复用 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness/tree/fb2c4b9e698e30edb738bca4cf0618587db7d203) 的 React 基础组件、主题与布局 CSS。固定标签为 `dsh-v0.1.5-rc.2`，commit 为 `fb2c4b9e698e30edb738bca4cf0618587db7d203`。范围见 [API_REUSE.md](API_REUSE.md) 和 [REUSE.md](REUSE.md)。

实际前端入口为 `packages/client/ui-primitives`、`packages/client/ui-theme/src/styles` 及 `packages/client/ui-layout/src/client/AppFrame.module.css`。这些源码在构建时进入浏览器产物；模型请求、软件设置、任务轮询、业务表单与本机 IPC 由本项目实现。软件运行不需要 DSH Host、Cordis、DSH SDK、社区桌面壳或 DSH RPC 服务。

## 获取与校验

`UPSTREAM.json` 保存官方源码压缩包、完整缓存树、关键文件和内部链接清单的校验信息。原始源码包为 19,474,104 字节，SHA-256 为 `60038295d9ea8849dc50a9d77dfcbed6c14397f0d54fadb035f768841415a3bd`。

在仓库根目录执行：

```powershell
node desktop/scripts/acquire-upstream.mjs
node desktop/scripts/acquire-upstream.mjs --verify
```

脚本使用 Node 内置模块和 Windows 系统 `curl.exe`、`tar.exe`，只获取固定公开源码，不安装或启动 DSH。源码缓存位于 `desktop/.cache/upstream/fb2c4b9e698e30edb738bca4cf0618587db7d203/`，压缩包和缓存均被 Git 忽略。网络下载沿用调用进程的代理环境，脚本不输出代理值。

为兼容无需管理员权限的 Windows，脚本将清单中指向仓库内部的 11 个链接物化为文件或目录副本。完整源码树摘要以这个明确适配后的缓存为准，原始压缩包哈希仍对应官方档案。请保留缓存不变，在项目自己的输出目录构建；在固定缓存内安装依赖或写产物会使校验失败。

完整缓存用于固定来源和核查，只将实际使用的组件构建产物及所需通知加入软件。未复用用户现有 DSH 的外观图片、桌宠、音效、凭据、会话或历史。

## 版本与许可

桌面构建使用 Electron `44.0.0`、electron-builder `26.15.3`、esbuild `0.28.1`。界面使用 React `18.3.1`；其余前端版本以 `ui-api/package.json` 和 `ui-api/pnpm-lock.yaml` 为准。后台物理 Node 为 `24.17.0`，独立 npm 依赖为 `playwright-core` 与 `yaml`，版本和完整性记录见 `runtime-api-template/package-lock.json`。这些是本项目的构建输入，不代表所有上游工作区依赖都会分发。

[官方根 LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/LICENSE) 为 `Copyright (c) 2026 DeepSeek` 的 MIT 许可，完整原文保存在 [licenses/DeepSeek-Harness-MIT.txt](licenses/DeepSeek-Harness-MIT.txt)。复制、修改及分发适用源码时，须保留版权和许可通知。

`licenses/` 还保留同一提交的上游第三方通知和 vendor 来源记录，供来源核查；它们不表示软件使用了上游全部组件。Electron/Chromium、Node、React、字体、图标和其他实际依赖各自适用原许可证，分发时按软件中实际包含的资源保留相应通知。媒体社区源码的 MIT 与来源另见[根第三方声明](../THIRD_PARTY_NOTICES.md)。

本项目使用自己的应用标识、打包配置和便携包名称，是独立适配软件，不代表 DeepSeek 官方发行。当前 Windows 构建采用未签名开发配置；发布与打包后验收状态见 [README.md](README.md)。
