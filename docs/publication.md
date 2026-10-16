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
| 公开且维护中的仓库，创建满 1 天 | 仓库创建于 2026-10-14；本次准备按用户授权公开 |
| 完整的 `dsh.bundle` | 根 manifest 指向 `./cordis.bundle.yml`，补丁已提交；同时提供客户端声明与导出 |
| 真实代码、描述准确 | 原生设置和打开入口已有实测；未验收的自主外发、静默等在 README 单列，不声称全部真实可用 |
| GitHub topic | 公开时添加 `dsh-plugin`，配合 `deepseek-harness`、`douyin` 等分类 |
| 单条 YAML、合理分类 | 只新增 `data/plugins/LockyBee__dsh-douyin-agent.yml`，分类 `browser`；不改他人条目或生成 README |
| npm 可选 | 当前保留 `private:true` 防止意外 npm 发布；GitHub 公开状态独立于此字段 |

另向 [DSH 1024Store 目录](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/blob/main/CONTRIBUTING.md) 提交单份 JSON。它允许未发布 npm 的插件先以浏览模式收录；不据此宣称已有 npm 安装命令。

两个目标均为社区目录，并非 DeepSeek 官方审批。申请、CI 通过、合并和市场同步分别确认；提交申请不代表已经收录。本文件记录准备依据，最终 PR 链接与状态在本次交付消息中报告。
