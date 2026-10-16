# 原生 v10 设置与浏览器启动修复

日期：2026-10-16。源码基于 `6264b99`。本次修复 DSH 内打开抖音失败，设置分类、模型选择、问候启动原因与媒体 Key 入口；独立软件未重新打包。

## 修复与复用

- Electron 内不再直接把桌面 EXE 当作 Node，自动核实已有独立 Node 22.13+，优先随包资源，再源码缓存与绝对 PATH。本机命中已有 Node 24.17.0，没有下载依赖。
- 删除页面标题下的介绍小字，设置分为基础设置、视频观看、好友互动、公开评论、音频与密钥、观看日报，仍使用 DSH 原生组件。
- 模型名称改为下拉。复用 LlmRuntime 已配置模型目录，60 秒缓存与并发共享；不调用主动发现或模型生成。真实 Cordis 服务每次读取可返回不同追踪代理，缓存与服务变更校验使用官方 `cordis.original` 身份，不能直接比较代理对象。
- 问候保存许可后仍不能启动时，显示缺模型、未保存许可等具体原因，并提供前往模型设置入口；停止只在运行时可用。没有自动开始发送。
- 音频子栏目提供 MiMo 与 MiniMax 密码输入框，复用并提取软件已有原子 Key writer。只返回是否配置及来源，识别进程环境覆盖，不回显 Key；空白保留旧值，保存不启用音频、不调用云。

## 测试结果

| 检查 | 结果 |
| --- | --- |
| 原生 SDK、命令与设置 | 46／46 通过；独立 Context 与替身生成，不调用真实模型 |
| 原生客户端临时 Edge 页面 | 3／3 通过，计入下列完整回归 |
| 模型目录单元检查 | 8／8 通过，计入完整回归 |
| 原生媒体 Key HTTP 检查 | 5／5 通过，计入完整回归 |
| 运行路径检查 | 12／12 通过，计入完整回归 |
| 根目录与桌面后台，文件并发 2 | 459 项：451 通过、1 失败、7 跳过，82.979 秒 |
| 同一源码完整复查，文件并发 1 | 459 项：451 通过、1 失败、7 跳过，160.430 秒 |

命令在仓库根目录使用本机 Node 24.17.0 运行：

```powershell
node --test --test-concurrency=2 --test-timeout=25000 verification/dsh-plugin.test.mjs verification/native-launch-command.test.mjs verification/native-settings.test.mjs
node --test --test-concurrency=2 --test-timeout=55000 tests/*.test.mjs desktop/tests/*.test.mjs
node --test --test-concurrency=1 --test-timeout=55000 tests/*.test.mjs desktop/tests/*.test.mjs
```

本机日志为 `verification/v10-sdk-tests.txt`、`verification/v10-backend-tests.txt` 与 `verification/v10-final-backend-tests.txt`，不提交其中的本机输出。早期组合日志 `verification/native-settings-fixes-tests.txt` 保留了升级 fixture 版本断言和真实 Cordis 代理身份问题修复前的失败，不替换为最终通过。

## 尚存的回归失败

两次完整回归均在 `tests/autonomous-comments.test.mjs` 的“另一入口关闭、结束轮次、丢失观察或更换run都在最终发布前撤回”失败。堆栈发生于构造观察证据的 `PersonaMemory.recordObservation → syncCard → renameSync`，Windows 返回 `EPERM`，尚未进入评论撤回断言。

该用例单独复查通过；同文件复查又有另一用例在相同人格卡替换处失败，因此不能将问题当作一次偶然或仅由测试并发造成。本轮没有修改 `persona-memory.mjs`，原有 900 毫秒有限重试仍存在；没有取得占用句柄证据，不能归因某具体软件。完整回归未全绿，文件占用问题仍待处理，不能将定向检查通过扩大为完整运行稳定。

## 当前 DSH 加载

当前安装核对为 DSH Desktop 2.0.17。页面源码更新已可看到分类和模型下拉。未调用模型、发送私信、问候、分享或公开评论，也未写入真实 Key。

仅修改 URI 名称不能证明模块已重载。尝试禁用受管配置后，未从实际接口确认卸载，因此已恢复原配置；随后备份并仅将原入口查询版本更新为 v10，其他插件不增加、不移除。

用户随后明确授权重启。通过原生“重启应用”确认后，旧进程退出，新进程与窗口实际建立；路径仍为同一份 DSH Desktop，版本 2.0.17。真实 `GET /api/douyin-browser/state` 返回 200，新增目录字段已生效，读取到 3 个提供商、9 个模型；MiMo／MiniMax 仅返回凭据配置状态和来源。模型尚未由本人选择保存，观看、问候、私信服务均未运行；其余 203 条有效插件配置摘要保持一致。

随后实际调用本插件的 `POST /api/douyin-browser/browser/open`，返回 HTTP 200、`opened=true`、`paused=true`；Windows 窗口列表出现专用抖音 Edge 窗口。这证明新版原生打开入口已实测成功，不证明开始自主观看或其他外发功能已验收。后续电脑操作工具因无法可靠确认浏览器 URL 而停止，没有完成页面视觉检查，也未改用其他界面控制方式绕过。
