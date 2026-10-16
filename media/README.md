# 可选音频与视频读取

媒体源码随刷视频工具保存，运行开关默认关闭。用户可以自己决定是否启用；模型工具不能更改开关。MiMo、MiniMax 都是可选后端，没有云 Key 也可以关闭能力，或在用户启用后使用本地 Whisper 转写对白。插件原生设置和独立软件均提供云端 Key 表单，共用本机媒体配置。

## 已内置的来源

这些是社区项目，不是 DeepSeek 官方插件。保留了三个项目的 MIT LICENSE、固定 commit 的原始文件及 SHA256 记录，详见 `PROVENANCE.json`。vendor 原文件未修改。

| 项目 | 固定 commit | 本工具使用的部分 |
| --- | --- | --- |
| [ch1bug/dsh-mimo-agent-tools](https://github.com/ch1bug/dsh-mimo-agent-tools/tree/38a7985d25090a4b87b987c2d99613a5c6b318d7) | `38a7985d25090a4b87b987c2d99613a5c6b318d7` | `driver/mimo_driver.py` 的 `build_body`，生成真实 `input_audio` / `video_url` 与提问正文 |
| [GooDAnDReaDY/dsh-voice](https://github.com/GooDAnDReaDY/dsh-voice/tree/e3e96e0bd3a34d73fec0edac45a1fba1cb7b6f6f) | `e3e96e0bd3a34d73fec0edac45a1fba1cb7b6f6f` | `providers.js` 和 `provider-http.js`；配置本机 whisper.cpp HTTP 服务时直接调用其 local-whisper provider |
| [moluyao/dsh-minimax-asr](https://github.com/moluyao/dsh-minimax-asr/tree/bbf79d17e32a1dab94bffba20fa6b1fbd8cf700e) | `bbf79d17e32a1dab94bffba20fa6b1fbd8cf700e` | 移植 ASR multipart 参数、`language` 请求头及转写结果合同，原始 `lib/index.js` 留作来源核对 |

本地 Python 入口另外使用 [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 1.2.1 和 [Whisper 模型](https://github.com/openai/whisper)。Python 依赖及模型属于可选安装，不随源码仓库提交。

## 适配内容

统一入口是 `index.mjs` 的 `MediaAdapter`。没有整体安装三个上游插件；原插件的 DSH SDK、UI、TTS、自动录音和插件更新器不随之加载。工具输出由刷视频项目适配当前 DSH 0.1.5-rc.2 的 JSON 合同。

MiMo 原来通过 Git Bash 包装驱动；这里以 `spawn(..., {shell:false})` 直接启动 Python，使用标准输入传递不含凭据的请求规格。驱动只构造请求正文，MiMo 网络请求由 Node 发起。MiniMax ASR 请求直接使用 Node `fetch`，未沿用旧 shell 管线。桌面软件保存媒体 Key 的原子文件写入是另一条用户设置流程，不把 Key 交给 Python 驱动。

媒体先用现有 `ffprobe` 核对音轨、视频轨与时长，再用 `ffmpeg` 提取指定片段。默认上限是 25 MiB、120 秒，云答复最多 1024 token。转写音频还会核对输出 WAV 的实测时长。浏览器 MediaRecorder 生成的本地 WebM 可能没有容器总时长；这一路只允许音频处理，用 `-t` 限定转码，成功后返回 `sourceDurationSeconds:null` 和 `durationVerifiedBy:'ffprobe-output'`，不会把请求秒数当成测量结果。视频片段的 `durationSeconds` 表示根据源时长限定的请求区间，编码后的帧边界可能有取整。

接受绝对文件路径或不带认证信息的公开 HTTPS 媒体 URL。拒绝私网、带密码、签名、token、有效期参数的地址；重定向逐次检查，连接实际使用的 DNS 地址也须通过公网核对。当前 URL 检查只支持公网 IPv4。受登录保护的抖音网页不能当成直接媒体 URL；需要由刷视频侧先在获授权的专用标签页采集成短本地文件，再交给这里。

## 用户运行设置与配置

运行设置保存在被 Git 忽略的媒体 `settings.local.json`，实际位置由共同 runtime 记录解析，不存在时等价于：

```json
{"enabled":false,"backend":"local-whisper"}
```

只有用户 UI/CLI 入口应调用以下方法，不应给模型注册启用工具：

```js
await adapter.saveSettings({enabled:true,backend:'local-whisper'},{explicit:true});
await adapter.setEnabled(false,{explicit:true});
```

软件 1.1.1 的 MiMo 填写路径为“业务设置 → 音频理解 → 音频后端选择 MiMo → MiMo API Key → 保存音频 Key”；MiniMax 选择对应后端后填写 MiniMax API Key。Whisper 不需要云 Key。

插件填写路径为“设置 → 刷抖音 → 音频与密钥”，页面分别提供 MiMo API Key 与 MiniMax API Key 的密码输入框和保存按钮。留空沿用已有凭据，不表示清除；本轮未新增清除媒体 Key 的入口。两项均不必填，使用本机 Whisper 时不需要云 Key。

软件表单调用窄 Electron IPC `saveMediaKey({backend,apiKey})`；插件表单调用 DSH 自身的同源设置接口 `POST /api/douyin-browser/media/credentials`，正文为 `{backend:'mimo'|'minimax',apiKey:string}`，沿用本机来源、同源与设置会话令牌检查。两条入口复用 `media/key-store.mjs` 的原子 writer，只更新共用媒体 `.env` 中的 `XIAOMI_API_KEY` 或 `MINIMAX_API_KEY`，保留其他配置。该文件以本机明文保存，不作加密承诺；输入值不放入 URL，也不回传给界面、状态或工具结果。保存本身不启用音频、不改变已保存的运行后端、不发起云请求；需要使用时由本人另行保存音频开关与后端设置。修改 Key 前须停止自主观看、自动问候和私信回复。

源码或插件用户也可参照 `.env.example` 手动填写共享文件。实际位置为 `runtime-location.json` 登记的 `mediaEnvFile`，也可由显式 `DOUYIN_MEDIA_ENV_FILE` 指定；未使用位置登记的源码默认路径为本目录 `.env`。媒体只读取白名单字段及同名进程环境变量，不读取 QQ `.env`；同名环境变量优先于文件值。MiMo、MiniMax 两项 Key 均不必填。

公开媒体下载可沿用进程已有的 `HTTPS_PROXY` / `HTTP_PROXY` 和 `NO_PROXY`，支持 HTTP CONNECT 代理。代理连接目标使用已核对的公网 IPv4，TLS 继续核对原域名证书；代理地址和凭据不出现在状态或错误结果里。其他代理协议会明确失败。

运行时从配置读入 Key 到进程内存；软件和插件的保存按钮会将其持久写入上述本机共享 `.env`，不能称为仅在内存保存。默认 `MediaAdapter` 在后续状态或处理调用中重新读取配置，文件更新后不必重建适配器；显式环境变量仍按原优先级生效。状态分别显示“文件已保存”及“当前已配置”，来源为共享文件、环境变量或显式注入；空的同名进程环境变量仍会覆盖已保存文件，此时会显示“已保存但当前未配置”，需本人在启动环境处理覆盖。状态只返回布尔和来源，不返回原值。Key 不返回 `status()`、模型工具结果、网页或日志，云调用时才按相应协议发送给所选服务。云后端未配置时返回 `unavailable`，关闭时返回 `disabled`。本地默认只做语音转写；通用音乐、环境声、视频理解需要用户明确选用 MiMo，不能把 ASR 文本当作已理解所有声音。

`backend` 是用户选择的处理方式。模型请求里的 `backend` 必须与运行设置相同；选择本地 Whisper 时，即使进程存在云 Key，也不会被模型改成云端上传。需要切换时由用户在控制台保存设置，模型请求不匹配会返回 `backend-not-selected`。

## 本地可选安装

本机验收使用 Codex 的 bundled Python 创建本目录 `.venv`，现有系统 `ffmpeg` / `ffprobe`。其他机器可以指定 `DOUYIN_MEDIA_PYTHON`、`DOUYIN_MEDIA_FFMPEG`、`DOUYIN_MEDIA_FFPROBE`。服务启动、状态检查和转写都不会自动安装依赖或下载模型。

用户选择本地方案后，可自行在项目根目录执行：

```powershell
python -m venv media/.venv
& './media/.venv/Scripts/python.exe' -m pip install -r media/requirements.txt
& './media/.venv/Scripts/python.exe' media/setup_local.py --download-model tiny
```

PyAV 固定为 16.0.1：本机首次验证发现 PyAV 19 已移除 `metadata_errors`，与 faster-whisper 1.2.1 不兼容，降到固定版本后真实识别通过。模型缓存保存在 `.models`，不进入 Git。

如已有本机 whisper.cpp 服务，可以在媒体 `.env` 配置 `DOUYIN_MEDIA_WHISPER_URL=http://127.0.0.1:8001/inference`，沿用 dsh-voice 的 provider。该 HTTP 路线本轮只验证了请求合同，没有启动真实 whisper.cpp 服务。

## 方法合同

```js
const adapter = new MediaAdapter();
await adapter.status();
await adapter.transcribeAudio({source,backend:'local-whisper',language:'zh',startSeconds:0,durationSeconds:10},{signal});
await adapter.analyzeAudio({source,backend:'mimo',question:'这段音频有哪些声音？',durationSeconds:10},{signal});
await adapter.analyzeVideo({source,backend:'mimo',question:'这段视频发生了什么？',fps:1,durationSeconds:10},{signal});
```

返回 `{ok,status?,backend,kind,text?,segments?,source?,interval?,limitations?,error?}`。`status()` 顶层包含 `enabled`、`backend`；云后端另含 `credential:{configured,source,saved,environmentOverride}`，只显示配置是否生效及来源，不含 Key、URL 或运行时路径。`available` 仅表示配置/依赖可用，云端仍需真实请求才能验证。

`interval` 含 `startSeconds`、`durationSeconds`、`requestedDurationSeconds`、`sourceDurationSeconds` 和 `durationVerifiedBy`。转写结果中每个 segment 的 `start` / `end` 是源音频时间，`relativeStart` / `relativeEnd` 是处理片段中的时间。无法核对的录音总时长保留为 `null`。

## 验证记录

1.1.1 软件界面完整测试 15／15 通过，其中新增输入外观 1／1、打开入口及音频 Key 合成流程 1／1；后者核对窄 IPC、敏感值不进 HTTP、保存不会启用音频。它们未使用真实云 Key，也没有把 MiMo／MiniMax 云服务计作通过。最终 Node、SDK、配置 writer 及软件包验收数字见 [desktop/VERIFICATION.md](../desktop/VERIFICATION.md)。

`node --test tests/media.test.mjs` 使用合成素材、真实 ffmpeg/Python 和替身云响应，核对开关、用户后端选择、并发设置、配置去敏、URL 拒绝、片段提取、无容器时长 WebM、MiMo 音视频请求、MiniMax 参数、dsh-voice provider 及 vendor SHA。这不是 MiMo/MiniMax 的真实云联调。

2026-10-14，本机 `node media/verify-local.mjs` 真正调用本地 Whisper，识别 Windows SAPI 生成的 6.498 秒英文合成录音，得到完整预定句子和两个时间段。素材为 `verification/synthetic.wav`，可读证据为 `verification/local-asr.json`。该验收只在临时设置文件中启用能力，未替用户开启默认开关。

同日本机开启 `RUN_REAL_MEDIA_ASR=1` 运行媒体测试，其中两个真实 Whisper 测试分别读取合成 WAV 和无容器时长的合成 WebM。WebM 的核对测试先确认输入确实没有 `format.duration`，再验证转码后实测时长及对白核心词句。另以 `RUN_REAL_MEDIA_URL=1` 核对已有代理下真实下载 whisper.cpp 上游公开样本，并用 ffmpeg 提取 0.5 秒；该下载测试的转写服务响应仍是替身。

```powershell
& './media/generate-synthetic.ps1'
node media/verify-local.mjs
$env:RUN_REAL_MEDIA_ASR='1'
$env:RUN_REAL_MEDIA_URL='1'
node --test tests/media.test.mjs
Remove-Item Env:RUN_REAL_MEDIA_ASR
Remove-Item Env:RUN_REAL_MEDIA_URL
```

这证明本地对白转写路线可运行，不证明中文识别准确率、音乐/环境声理解或真实抖音音轨采集已通过。MiMo/MiniMax 尚未使用真实 Key 验收，缺 Key 时明确不可用；浏览器采集和 DSH/API 入口联调由上层分别验收。
