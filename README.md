# DSH 抖音助手

让 DSH 里的 DeepSeek（大肥鱼）自己刷抖音：搜索、换片、看真实画面，把有意思的内容记下来，并在你许可的范围内分享给好友。

在专用 Edge 里浏览电脑网页版抖音，每隔几秒采样视频画面交给模型。所有外发功能默认关闭，每一项都有独立开关、次数上限和时间限制。这是第三方适配，不是 DeepSeek 官方出品。

## 能做什么

| 功能 | 说明 | 默认 |
| --- | --- | --- |
| 自主观看 | 按人格和兴趣自己搜索、换片、继续看或停止，并给出理由 | 需手动开始有限轮次 |
| 兴趣与人格 | 兴趣来自实际观看进度和已确认行为，不是看到主题就算喜欢 | 随观看自动积累 |
| 时间限制 | 每日允许时段（北京时间）加单轮时长，到点视频真的暂停 | 单轮 10 分钟 |
| 静默观看 | 静音，核对窗口归属后尝试最小化（仍是有窗口的 Edge，不是 headless） | 关闭 |
| 观看日报 | 把当天实际看过的标题、作者、链接汇总成 Markdown，不调用模型 | 可手动生成，每轮观看结束后也会尝试生成 |
| 主动分享 | 通过官方分享界面把当前看过的作品发给许可好友，每天默认 3 次 | 关闭 |
| 自动问候 | 每位许可好友每天最多一次，合计默认 2 次，带「自动问候」标记 | 关闭 |
| 私信自动回复 | 只处理你确认的最多两位好友，只回复启动之后的新消息 | 关闭 |
| 公开评论 | 每天默认 3 条，每轮 1 条，同一作品只评论一次 | 关闭 |
| 音频理解 | 本地 Whisper 转写对白，可选 MiMo 或 MiniMax 云端 | 关闭 |

发送结果不确定时一律暂停，不会自动重发。

## 两种用法

| | 插件版 | 软件版 |
| --- | --- | --- |
| 在哪用 | DSH 的「设置 → 刷抖音」，全部用按钮操作 | 独立的 Windows 桌面软件，对话式下任务 |
| 模型 | 用 DSH 里已配置的提供商 | 用你自己填的 DeepSeek API Key |
| 版本 | 1.3 | 已打包的是 1.2.0，1.3 尚未打包 |

两者共用同一份人格、兴趣和记忆，但同一时刻只会运行一个自主观看。

## 快速开始（插件版）

### npm 安装（1.3.1）

DSH Desktop：打开“应用 → 桌面插件”，在 npm 包输入框填写 `dsh-douyin-browser-local@1.3.1` 并点击“安装”。Desktop profile 由 Electron 管理，不能用普通 CLI 修改。

Web 版在终端运行：

```powershell
dsh plugin --profile web add dsh-douyin-browser-local@1.3.1
```

需要 Windows、已安装 Microsoft Edge 和 DSH 0.2.0-rc.2。安装后按宿主提示重新加载，在设置中打开“刷抖音”；抖音登录和验证由使用者自行完成。市场收录与 npm 包发布分别同步，不能把发布成功当成市场已刷新。

### 从源码安装


需要 Windows、Microsoft Edge、Node.js 22.13 以上，以及 DSH 0.2.0-rc.2 系列（已在 DSH Desktop 2.0.17 上核对过设置页）。

```powershell
git clone https://github.com/LockyBee/dsh-douyin-agent.git
cd dsh-douyin-agent
pnpm install --frozen-lockfile
$dshInstallDirectory = 'C:\Apps\DSH Desktop' # 替换为正在使用的 DSH 安装目录
.\install-native.ps1 -DshRoot $dshInstallDirectory
```

第一条命令安装依赖；不带 `-Install` 的脚本只做检查，不改配置也不开窗口。确认无误后完全退出 DSH，再执行：

```powershell
.\install-native.ps1 -DshRoot $dshInstallDirectory -Install
```

重新打开 DSH，在「设置」里找到「刷抖音」，按这个顺序用：

1. 基础设置：选提供商和模型（模型必须支持图片），保存。
2. 视频观看：点「打开抖音」，在专用 Edge 里自己登录或过验证。
3. 设置允许时段和单轮时长，点「开始有限轮次」，再点「开始自主观看」。

安装细节和本机现有入口的说明见 [插件说明](docs/plugin.md)。

## 当前验证状态

| 状态 | 内容 |
| --- | --- |
| 真实环境验证过 | 推荐播放、搜索、上下切换、暂停、画面采样、限时到点暂停；旧版 DSH 原生工具调用；表情图片采样；一次人工授权的好友转发；DSH 2.0.17 中设置页挂载并读回状态 |
| 只有合成测试 | 自主分享、行为偏好、自动问候、自主评论、静默、日报 |
| 还没验证 | 抖音最小化后的持续播放、真实评论区、收到新私信后的完整自动回复、MiMo 与 MiniMax 云端、标准 bundle 安装 |

合成测试用的是替身模型和临时页面，不能当作真实抖音上能用的证据。最新测试数字和已知失败见 [v10 验证记录](docs/verification/native-v10.md)。

## 目录

| 位置 | 内容 |
| --- | --- |
| `dsh-plugin.mjs`、`client.js`、`cordis.bundle.yml` | 原生插件入口、设置页前端、标准 bundle 声明 |
| `tool-definitions.mjs` | 32 项工具目录，插件和软件共用 |
| `native-*.mjs` | 设置页后端、模型路由、人格注入、问候与观看决策 |
| `core.mjs`、`browser-*.mjs` | 专用 Edge 的控制、采样、限时 |
| `video-limits.mjs`、`task-limits.mjs`、`watch-mode.mjs` | 时段与轮次、任务预算、静默 |
| `autonomous-*.mjs`、`spark-*.mjs`、`daily-report.mjs` | 自主观看、分享、评论、问候、日报 |
| `chat-*.mjs`、`message-tracker.mjs`、`outbound-send.mjs` | 私信自动回复和统一的发送账本 |
| `memory.mjs`、`persona-memory.mjs`、`qq-sync.mjs` | 共享记忆、人格卡、QQ 侧同步 |
| `app.mjs`、`api-agent.mjs`、`public/`、`start-api.*` | 旧的本机 HTTP 控制台（`http://127.0.0.1:3218`） |
| `desktop/` | Electron 桌面软件的源码、打包脚本和上游许可证 |
| `media/` | 可选音频模块，内置三份社区项目源码 |
| `tests/`、`verification/` | 单元测试，以及实机验收脚本 |
| `skill/SKILL.md` | 给模型看的使用说明 |

## 文档

| 文档 | 内容 |
| --- | --- |
| [插件说明](docs/plugin.md) | 插件安装、设置页逐项说明、预算、各项外发的规则 |
| [独立软件说明](docs/standalone-api.md) | 独立 API 控制台和软件版的配置 |
| [详细说明](docs/details.md) | 原 README 全文，按时间累积，内容多 |
| [功能复用与来源](docs/reuse.md) | 参考和复用的开源项目，以及边界 |
| [docs/verification/](docs/verification) | 各版本的测试记录 |
| [desktop/README.md](desktop/README.md) | 桌面软件的构建和使用 |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | 第三方许可证 |

## 开发

```powershell
pnpm test
pnpm run test:native
```

`pnpm test` 会起临时 Edge 页面，不碰真实抖音和你的账号。运行状态、浏览器资料、密钥、数据库、私信正文和联系人信息都只保存在本机，不进入仓库。

## 许可证

本项目原创代码采用 [MIT](LICENSE)。第三方源码和依赖的原许可证、版权及通知见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

公开准备、分发包检查与社区市场申请见 [发布记录](docs/publication.md)。
