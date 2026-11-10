# 抖音自主观看 · v2.1 改动集

本仓库只包含**对 `dsh-douyin-browser-local`（上游 v1.4.6）的改动**，不含插件完整源码、不含任何本机观看数据。

## 这是什么

- 上游：`dsh-douyin-browser-local` by LockyBee（第三方适配，非 DeepSeek 官方）
- 本改动：把一个"严格校验、一动就停"的自主观看，改成"被动记账、能连续跑、离题自动处置"的版本
- 版本号：`WATCH_VERSION = 'v2.1'`（`src/autonomous-watch.mjs`）

## 目录

```
src/        改动过的 6 个源文件（覆盖到插件目录即可用）
patches/    67 个补丁脚本，按编号顺序可重放
docs/       版本对照表（v0 → v2.1 的演进与已知问题）
```

## 应用方式

1. 安装上游插件 `dsh-douyin-browser-local@1.4.6`
2. 用 `src/` 下同名文件覆盖 `node_modules/dsh-douyin-browser-local/` 中的对应文件
3. 重启 DSH（`core.mjs` / `tool-definitions.mjs` / `daily-report.mjs` 是静态加载，必须重启）

或者按需重放 `patches/`：`node patches/patch-douyin-XX.mjs`（脚本内含锚点校验，顺序执行）。

## 改了什么（摘要）

| 方向 | 内容 |
|---|---|
| 播放不被打断 | 被动模式：判断只记账，换片交连播 |
| 搜索更准 | 最新发布 + 一周内 + 仅视频；按天去重（`state/seen`） |
| 三类分流 | 离题 `state/noise`、口味 `state/taste`、重复 `skip_duplicate` |
| 离题立即换片 | 判定当秒切走，不等 6 秒间隔 |
| 重播保护 | 同一视频播满 2 遍强制换片，长片 150 秒兜底 |
| 直播卡 | 识别并跳过，不废整个主题 |
| 浏览器关闭 | 干净收尾并出日报 |
| 主题枯竭 | 四主题全空 → 结束并视为当日完成 |
| 离题自动处置 | 同一作品连续 3 天判 `offtopic` → 第 3 天按 R「不感兴趣」 |
| 画像自净 | 离题判定以**类型词**（搞笑段子/男性出镜/影视剪辑…）写入兴趣负向证据 |
| 日报 | 原生「离题清单」章节；可转 Word |
| 热重启 | 每次启动重新加载实现模块，调参无需重启 DSH |

## 已知问题

双播放器页面（`candidateCount=2`）下 `douyin_next` 全部返回 `switch-control-ambiguous`，实际换片靠连播；`loop_break` 因此多为假警报。待验证"关闭抖音客户端、只留网页版"是否仍复现。

## 边界

- 不点赞、不关注、不发布、不购买、不发文字私信（上游明令禁止）
- 遇登录/验证一律停止，不绕过
- 不改用户额度、主题池、白名单

## 许可

沿用上游 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`。本改动集不修改上游版权声明。
