# 开源与社区目录提交

记录日期：2026-10-16。本项目原创代码采用 MIT，第三方源码保留原始版权、许可与来源清单。保留 Claude 的文档整理，补充发布所需元数据、通用安装示例与插件运行文件白名单。

## 公开前核对

- 检查本地全部引用中的 11 个历史提交、354 个唯一文本 blob，未发现真实 Key、Cookie、私信、联系人身份或手编人格原文；凭据和手机号候选均为明确合成测试。作者与提交者使用 GitHub noreply。该检查不涵盖远端隐藏引用或 GitHub 讨论附件，不声称绝对没有任何泄露。
- 旧提交和迁移兼容代码含本机目录常量，没有据此重写历史。当前面向安装的示例改用相对路径与用户指定的 DSH 安装目录；既有记忆迁移兼容保持原样。
- 白名单打包为 61 个文件，压缩 229,806 字节、展开 762,372 字节。没有桌面构建、测试、验收输出、真实配置、个人记忆、浏览器资料或模型缓存；7 份内置媒体来源与原始许可哈希匹配。
- 隔离解包后，复用已声明依赖，可导入原生入口、浏览器控制、媒体、观看、问候、评论和日报，工具定义为 32 项。没有安装用户 profile 或发出真实请求。
- 本轮发布准备、原生 SDK 与前端许可定向检查 52／52 通过。此前完整回归 459 项中 451 通过、1 失败、7 跳过；既有人格卡 `EPERM` 替换问题仍未解决，见 [v10 验证记录](verification/native-v10.md)。没有为申请隐去失败记录。

## 对照收录指南

目标目录：[awesome-dsh-plugin 贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。

| 要求 | 本项目情况 |
| --- | --- |
| 公开且维护中的仓库，创建满 1 天 | 仓库创建于 2026-10-14；已按用户授权公开，匿名网页也可访问 |
| 完整的 `dsh.bundle` | 根 manifest 指向 `./cordis.bundle.yml`，补丁已提交；同时提供客户端声明与导出 |
| 真实代码、描述准确 | 原生设置和打开入口已有实测；未验收的自主外发、静默等在 README 单列，不声称全部真实可用 |
| GitHub topic | 已添加 `dsh-plugin`、`deepseek-harness`、`douyin` |
| 单条 YAML、合理分类 | 只新增 `data/plugins/LockyBee__dsh-douyin-agent.yml`，分类 `browser`；不改他人条目或生成 README |
| npm 可选 | 当前保留 `private:true` 防止意外 npm 发布；GitHub 公开状态独立于此字段 |

另向 [DSH 1024Store 目录](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/blob/main/CONTRIBUTING.md) 提交单份 JSON。它允许未发布 npm 的插件先以浏览模式收录；不据此宣称已有 npm 安装命令。

两个目标均为社区目录，并非 DeepSeek 官方审批。申请、CI 通过、合并和市场同步分别确认；提交申请不代表已经收录。

## 已提交的申请

| 目标 | 申请 | 2026-10-16 核对状态 |
| --- | --- | --- |
| awesome-dsh-plugin（本机 dshmarket 使用的目录） | [PR #7509](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/7509) | PR check 与 Submission gate 均已通过，PR 仍为 OPEN，等待维护者合并；实时线上目录尚未包含本插件 |
| DSH 1024Store | [PR #613](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/pull/613) | static-review、merge 和 Catalog sync 均成功；匿名请求线上 `/api/v2/plugins?q=LockyBee%2Fdsh-douyin-agent&limit=10` 返回 200，并已找到本插件 |

两个 PR 均已独立核对差异，分别只有本插件的一份新增文件。目录审查没有代替插件运行测试或安全审查；npm 仍未发布，1024Store 按其规则先以浏览模式收录。

## 市场搜索说明

本机两个市场入口使用不同目录。`dshmarket` 使用 awesome-dsh-plugin 目录；自动检查通过后仍须合并申请，再等待目录同步，刷新本机不能补入尚未合并的条目。

`dsh-community-market` 的默认页面为“可安装”，会过滤没有可用 npm 包的条目。当前本插件未发布 npm，应在“发现”页选择“DSH 1024Store”来源，再搜索 `dsh-douyin-agent` 或 `LockyBee`。2026-10-16 匿名查询 1024Store 线上 API，搜索完整仓库名和“抖音”均能找到本插件；线上收录不代表本机已具备 npm 一键安装。

## 2026-10-17 npm 发布准备

包名保持 `dsh-douyin-browser-local`，待发布版本 `1.3.1`，包含本地已验证的观看决策参数修复。已取消 private 限制，指定 npm 官方 registry 与 public 可见性，声明 Windows 和 DSH 0.2.0-rc.2 宿主要求。保留白名单打包，不含本机配置、人格、凭据、浏览器资料和验收输出。此前未发布 npm 的说明为当时状态；最终发布状态以 npm registry 为准。

## 2026-10-17 npm 发布结果

已发布 dsh-douyin-browser-local@1.3.1，npm latest 已指向该版本。从官方 registry 在隔离目录安装成功，原生入口 apply 可导入，dsh.bundle.patch 存在，registry integrity 与已测试 tarball 一致。未重启用户 DSH，未声称本次已完成桌面端运行验收。1024Store 在线目录仍返回旧 GitHub 安装命令；awesome-dsh-plugin PR #7509 仍待合并，市场一键安装尚未验证。

