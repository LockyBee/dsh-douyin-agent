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

桌面预加载层提供四个方法：`getSettings()`、`saveSettings({apiKey,baseUrl,model,remember})`、`clearApiKey()`、`openMemoryFolder()`。前三个设置方法返回公开设置时只包含 `configured/baseUrl/model/remember/memoryFolder`，不得回传密钥。`memoryFolder` 必须由主进程解析为软件与插件实际共用的本机目录。

首次配置前锁住模型任务与自动回复；保存后继续轮询 `/api/bootstrap`，直到后端确认已配置。转发需要可信用户事件，同一次提交无论是否收到送达确认都会锁定，人工核对并重新选择后才允许下一次操作。

MIT 源码复用须保留官方许可证和来源，发布包的通知由桌面总构建统一收集。此目录的合成测试不代表真实模型、抖音发送或桌面打包已经验收。
