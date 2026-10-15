# 独立 API 桌面界面

界面直接连接本项目 `app.mjs` 的同源 REST 服务，不启动 DSH、Cordis 或社区插件。API Key 只通过 `window.douyinDesktop.saveSettings()` 提交给主进程，网页请求沿用 `x-session-token`。

复用官方固定提交 `fb2c4b9e698e30edb738bca4cf0618587db7d203` 的 `ui-primitives` React 组件、主题 CSS 与 `AppFrame.module.css`。组件源码在构建时进入浏览器产物；布局状态、任务轮询和业务表单由本界面维护。没有读取或打包用户 DSH 外观、图片、桌宠、凭据、私信和历史。

在本目录运行：

```powershell
pnpm --ignore-workspace install --ignore-scripts
node build.mjs
node --test tests/*.test.mjs
```

运行产物为 `dist/index.html`、`dist/app.js`、`dist/app.css` 及 `dist/assets/`。后端应把 `dist` 作为静态根目录，以同一 HTTP 来源提供界面和 API。KaTeX 字体随产物提供，不依赖 CDN。

每次构建按 esbuild 实际输出贡献图生成 `dist/THIRD_PARTY_NOTICES.md` 与 `dist/licenses/`，保留所有运行依赖的许可证、版权声明、输入与产物哈希。KaTeX 字体另保留内嵌的 OFL 1.1 声明与保留字体名；字体哈希或版本改变时须重新核对，构建不会自动沿用旧记录。通知生成不访问网络。

桌面预加载层提供五个方法：`getSettings()`、`saveSettings({apiKey,baseUrl,model,remember})`、`clearApiKey()`、`openMemoryFolder()`、`openPersonaFolder()`。前三个设置方法返回公开设置时只包含 `configured/baseUrl/model/remember/memoryFolder`，不得回传密钥。两个打开目录的方法均不接受自定义路径。`memoryFolder` 必须由主进程解析为软件与插件实际共用的本机目录，人格文件放在其中的 `persona` 子目录。

首次配置前锁住模型任务与自动回复；保存后继续轮询 `/api/bootstrap`，直到后端确认已配置。转发需要可信用户事件，同一次提交无论是否收到送达确认都会锁定，人工核对并重新选择后才允许下一次操作。

“自主观看”复用既有视频时段与本轮时限。界面只在用户亲自开始的有效轮次内提交 `/api/watch/start`，固定 `startSession:false`，请求预算默认 30 次，可填 1 至 100 的整数。初始化、重连和重载只读状态，不恢复运行。停止后再次开启不会清零该轮已用预算；选择理由、剩余时间、入口归属、兴趣与实际观察记录分别来自后端状态。自主观看与手动视频任务、转发互斥，运行时也禁止修改或清除模型配置。

“共享记忆与人格”读取 `/api/persona`，分别显示手编人格、当前生效人格、兴趣方向、依据数量、反思与最近观察。只有点击“编辑人格”再“保存人格”才向 `/api/persona/card` 提交手编正文及原版本号；兴趣记录不会进入编辑框。轮询发现新版本或保存返回 409 时均保留草稿，不自动重试。用户可载入最新正文，或明确保留草稿、采用最新版本号后再保存。人格编辑不修改时段、联系人许可或发送权限。

MIT 源码复用须保留官方许可证和来源，发布包的通知由桌面总构建统一收集。此目录的合成测试不代表真实模型、抖音发送或桌面打包已经验收。
