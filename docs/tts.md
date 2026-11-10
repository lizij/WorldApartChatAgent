# 语音朗读（TTS）方案

> 状态：**一期方案已定稿，待实现**。
> 本文是落地依据：引擎选型、后端模块、接口、管理页交互、配置项、验证计划。
> 实现完成后，结论与证据回写到 [verification-log.md](verification-log.md)，配置键并入
> [configuration.md](configuration.md)，接口并入 [api.md](api.md)。

---

## 0. 目标与边界

**目标**：NPC 回复生成后，用本机**免费、离线、公开**的语音方案把台词读出来；一期只做最基本的
**男 / 女**两个音色。

**形态**

1. 「实验功能」页新增「语音朗读」栏位，其中有**自动播放开关（默认关闭）**；开启后，每条新的
   NPC 回复日志生成时自动朗读。
2. 「执行日志」里每条成功的 NPC 回复增加 **▶ 播放** 按钮，可手动朗读。

**明确不做（一期）**

- 不边生成边读（不干扰真流式，留到二期）。
- 不做游戏内音频 / 口型：本工具不改游戏文件（见 [workshop/README.md](../workshop/README.md)，
  工坊包不是可加载的 mod），声音只能由本程序所在进程发出。
- 不做配角独立音色：共演一期用主角音色读整段回复。
- 不接 Edge 在线神经语音：实测本机合成接口 403，且属非官方接口，无 SLA。
- 不做情绪变声、逐句分角色、字幕同步。

---

## 1. 引擎选型（已本机实测）

| 方案 | 免费 / 公开 | 音质 | 离线 | 额外依赖 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **Windows 内置语音（WinRT）** | 系统自带，永久免费，无需 Key | 机械但清楚 | ✅ | 零 npm 依赖，调用系统 `powershell.exe` | **一期采用** |
| Edge 神经语音（edge-tts 那套） | 免费无需 Key，但非官方 | 接近真人 | ❌ 需联网 | 可用原生 WebSocket 实现 | 实测 403，放弃 |
| 本地开源神经 TTS（Piper / Kokoro / IndexTTS） | 开源免费 | 最好 | ✅ | 需打包模型 + ONNX 运行时（100MB~1GB） | 违反便携 + 零依赖，二期再议 |
| 云厂商免费额度（Azure 等） | 需注册、需 Key | 很好 | ❌ | 需管理 Key | 不满足「公开」诉求 |
| 浏览器 Web Speech API | 系统语音 | 同 Windows | ✅ | 零依赖 | 备选：Chromium 对中文男声不可靠 |

### 1.1 本机验证数据（Windows 环境）

- WinRT `SpeechSynthesizer.AllVoices` 可枚举到 6 个语音，中文三个：
  `Microsoft Kangkang`（男）、`Microsoft Huihui`（女）、`Microsoft Yaoyao`（女）。
- 经典 SAPI（`System.Speech`）的注册表里只有 `Huihui`，**男声必须走 WinRT**。
- 合成耗时：87 字 ≈ 66ms；32 字 ≈ 176ms。
- 端到端（起 PowerShell → 合成 → 取回 WAV）≈ **0.45~0.8 秒**。
- 输出格式：16kHz / 16bit / 单声道 WAV。
- 可调参数实测范围：`SpeakingRate` 0.5~3、`AudioPitch` 0.5~2、`AudioVolume` 0~1。
- 玩家装了 Windows 11「自然语音」后，它们会直接出现在枚举列表里，**同一套代码自动升级音质**。

---

## 2. 整体链路

```text
游戏请求 → 本程序 → 上游模型 → 回复照常返回游戏（一个字节都不变）
                                    │
                            日志落盘（detail.reply）
                                    │ SSE 推送
                     ┌──────────────┴──────────────┐
                自动朗读开着                    玩家点 ▶
                     └──────────────┬──────────────┘
                                    ▼
                 GET /api/tts/audio/<rid>?mode=all|dialogue
                                    ▼
                  文本清洗 → 选音色 → WinRT 合成 → WAV 字节
                                    ▼
                          管理页 <audio> 播放
```

**关键点：合成是按需的。** 不点播放、也没开自动朗读时，**不会启动任何 PowerShell 进程**，
对现有对话零开销、零延迟影响。

---

## 3. 后端改动

### 3.1 新增 `src/tts/`

| 文件 | 职责 |
| --- | --- |
| `text.js` | 纯函数文本清洗与截断（无 IO，便于模块级回归） |
| `voice.js` | 系统语音枚举与缓存、男/女声解析、逐 NPC 音色与性别判定 |
| `synth.js` | 调 PowerShell 合成 WAV：超时、并发、内存缓存、回退 |
| `index.js` | 对外导出 `listVoices` / `synthForRid` / `preview` / `resolveVoiceOf` |

#### `text.js`

- 统一去掉 markdown 标记（`**`、`#`、`>`、列表符）与表情符号。
- 模式 `all`（全部朗读）：保留正文叙述；`skipActions=true` 时删除 `（…）`、`(…)`
  （全角半角都处理，支持嵌套一层）。
- 模式 `dialogue`（仅对白）：只抽取 `「…」`、`『…』`、`“…”`、`"…"` 内的文字，按出现顺序拼接。
  **抽取结果为空时自动回退为 `all`**，并在响应里带 `fallback:"dialogue_empty"` 供前端提示。
- 截断：超过 `maxChars`（默认 600）按句号 / 问号 / 感叹号 / 换行切句，保留最后一段完整句子，
  不硬切半个词。

#### `voice.js`

- **枚举**：WinRT `AllVoices` 中 `Language` 以 `zh` 开头的语音，缓存 10 分钟。
- **音色解析优先级**：逐 NPC `voice.json` 指定 → 全局 `tts.voices.male/female` →
  系统里第一个中文语音 → 失败（返回明确错误）。
- **性别判定**（仅 `gender:"auto"` 时）：读该 NPC 最新 `intake/*.md` 的 `## 角色设定` /
  `## 角色背景`，复用 `src/cast/card.js` 的 `sectionsOf()`，按顺序判定：
  1. 显式「性别：男 / 女」、「男，」「女，」；
  2. 称谓关键词：姑娘 / 女子 / 少女 / 仙子 / 娘亲 / 母亲 ↔ 公子 / 男子 / 少年 / 道友 / 父亲；
  3. `她` 与 `他` 出现次数比较；
  4. 都不成立 → 用 `tts.defaultGender`（默认 `female`）。
- 判定结果**连同依据**一起返回（如 `她×12，他×0`），管理页可见，避免「为什么是女声」说不清。

#### `synth.js`

- 临时文件放 `data*/tmp/tts/`，启动时清一次；用完即删。
- 调用方式：写 job JSON → 起
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <固定脚本>`，
  `windowsHide: true`；**文本与音色参数只走数据文件，不拼命令行**。
- 脚本走 WinRT 合成 WAV；Node 读入内存后返回，不长期留盘。
- 并发上限 2；单次超时 20s（超时杀进程）。
- 内存 LRU 缓存：`sha1(文本 + 音色 + rate + pitch + volume)` → WAV Buffer，最多 30 条
  （重复点同一条不重复合成）。
- PowerShell 失败回退一次：改用经典 `System.Speech`（保证女声可用）；仍失败返回明确错误。
- 每次合成写一条日志 `kind:"tts"`，字段 `slug / chars / mode / voice / synthMs / bytes /
  status / error`，**不记录台词正文**。

### 3.2 `src/server.js`

新增接口（全部沿用现有「仅本机 127.0.0.1 可访问」限制）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tts/voices` | 系统中文语音列表 + 男/女声建议；无可用语音时返回 `ok:false` 与安装指引 |
| GET | `/api/tts/audio/:rid?mode=all\|dialogue` | 按日志 `rid` 取 `detail.reply` 合成，返回 `audio/wav`；详情过期返回 404 |
| POST | `/api/tts/preview` | `{text?, gender, rate, pitch, volume}` 试听，返回 `audio/wav`（不带 `text` 用内置示例句） |
| PUT | `/api/npcs/:slug/voice` | 保存该 NPC 的 `voice.json` |

原有接口补充字段：

- `/api/status`、`/api/config`：带 `tts` 配置与语音可用性（缺失语音时前端可提示安装）。
- `/api/npcs/:slug`：带该 NPC 的 `voice` 与性别判定结果（含依据）。
- 执行日志详情：确保 `slug` 与 `reply`（纯文本）可用，供播放时解析音色与朗读文本。

**主对话链路不改**：`handleChat` 不加任何 `await`、不合成、不改响应字节。

### 3.3 数据文件

```text
data*/npcs/<slug>/voice.json      # 新增，可选；缺失即全用全局设置
  { "enabled": true, "gender": "auto", "rate": 1.0, "pitch": 1.0, "volume": 1.0 }
data*/tmp/tts/                    # 合成临时目录，启动清空
```

### 3.4 配置默认值（`src/config.js`）

```json
"tts": {
  "enabled": false,
  "readMode": "all",
  "skipActions": true,
  "voices": { "male": "Microsoft Kangkang", "female": "Microsoft Huihui" },
  "defaultGender": "female",
  "rate": 1.0,
  "pitch": 1.0,
  "volume": 1.0,
  "maxChars": 600
}
```

| 键 | 含义 |
| --- | --- |
| `enabled` | 自动播放总开关，默认关闭（升级后不会突然出声） |
| `readMode` | `all` 全部朗读 / `dialogue` 仅对白 |
| `skipActions` | `all` 模式下是否跳过括号内的动作描写 |
| `voices.male` / `voices.female` | 全局男 / 女音色名（取不到时按 §3.1 优先级回退） |
| `defaultGender` | 性别判定失败时的兜底音色 |
| `rate` / `pitch` / `volume` | 全局语速 / 音调 / 音量 |
| `maxChars` | 单条朗读字数上限，超出按句截断 |

范围校验与现有 `handlePutConfig` 一致（数值走 `intIn`，布尔直接断言，枚举取值走白名单）。

---

## 4. 管理页改动（`public/`）

### 4.1 实验功能页：「语音朗读」卡片

- 自动朗读开关（默认关）+ 说明「开启后，每条新的 NPC 回复会自动朗读；关闭时完全不会合成」。
- 朗读范围：`全部内容` / `仅对白`；选「全部内容」时显示「跳过括号内的动作描写」开关。
- 音色：男声下拉、女声下拉（只列系统中文语音；缺失项显示「未安装」并给出 Windows 设置路径提示）。
- 试听：**男声试听** / **女声试听** 按钮（走 `/api/tts/preview`）。
- 语速 / 音调 / 音量滑块，单条朗读字数上限。
- 播放器区：当前播放条目、▶ / ⏸、⏹ 停止、音量、队列长度。

### 4.2 执行日志

- `kind=npc && status=done && replyChars>0` 的记录，日志头部加 **▶ 播放** 按钮
  （`stopPropagation`，点击不触发展开详情）。
- 新增筛选 chip：`语音`（`kind=tts`），展示合成成功 / 失败摘要。
- 播放时按钮变 ⏸，再点停止；同一条命中缓存，不重复合成。

### 4.3 自动播放的边界处理

- **不补播历史**：开启开关时记录当前最大 `seq` 作为水位，只自动播放其后新到的记录；
  刷新页面不重播。
- **去重**：同一 `rid` 只自动播一次（内存 Set）；手动播放不受限。
- **串行播放**：单个 `<audio>` 元素 + 最多 2 条待播队列；新回复排队，不打断当前句。
- **被浏览器拦截**：Electron 侧通过 `autoplay-policy=no-user-gesture-required` 放行；
  CLI / 浏览器模式下若 `play()` 被拒，卡片顶部提示「点一下页面任意位置即可恢复自动朗读」。

### 4.4 NPC 记忆页

新增「语音」块：显示自动判定结果与依据、`自动 / 男声 / 女声` 选择、逐 NPC 语速 / 音调 / 音量、
该 NPC 试听、是否参与自动朗读（`enabled`）。

### 4.5 `electron/main.cjs`

- `app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')`
- `webPreferences` 增加 `backgroundThrottling: false`（窗口最小化时自动播放不被节流）

---

## 5. 打包影响

- **零新增运行时依赖**：只用 `node:*`（`child_process` / `fs` / `crypto` / `path`）与浏览器原生
  `<audio>`，符合 [contributing.md](contributing.md) 的依赖红线。
- PowerShell 脚本以**字符串常量**内联在 `synth.js`，会被 esbuild 打进 `dist/backend.cjs`，
  无需新增 `extraResources`。
- `public/` 已作为 `extraResources` 打包，UI 改动无需调整构建配置。

---

## 6. 版本号与文档

- `package.json`：按实现时的当前版本递增 MINOR（0.17.x 起，具体基版本以实现当天为准；
  版本号单一来源，不在本文写死）。
- 新增本文件 `docs/tts.md`（方案已随 0.17.0 批次入库）。
- 同步更新：
  - `AGENTS.md`：文档路由表、运行原理图（新增第 ⑦ 步之后的语音分支）、目录树、§5 管理接口。
  - `docs/configuration.md`：`tts` 全部键与默认值。
  - `docs/api.md`：4 个新接口、`tts` 日志字段。
  - `docs/verification-log.md`：本次验证结论与证据。

---

## 7. 验证计划

项目没有单测框架，按 [dev-workflow.md](dev-workflow.md) §2 的四层叠加：

| 层 | 内容 |
| --- | --- |
| 模块级 | `text.js`：括号剥离、引号抽取、空对白回退、截断不切词；`voice.js`：性别判定各分支、音色解析优先级 |
| 真实合成 | 直接调 `synth.js`：Kangkang / Huihui 各合成一段，核对 WAV 头、时长、耗时；自动测试用 `volume=0` 静音跑 |
| 假上游端到端 | 起假上游走真实 HTTP 路径：响应字节与改动前**完全一致**；关闭 TTS 时无任何 `tts` 日志、无子进程 |
| 浏览器实测 | 保存配置、男女试听、日志 ▶ 播放、自动播放开关（含水位不补播）、停止、`dialogue` 空回退提示 |
| 故障注入 | 禁用 PowerShell → 对话照常，仅 `tts` 错误日志；删除语音 → 界面提示安装 |
| 便携版冒烟 | `--test` 启动 exe，确认 asar 内能拉起 PowerShell、数据落 `data_test/`、关窗全退 |

---

## 8. 风险与已知限制

1. **音质偏机械** —— 免费离线方案的上限；装 Windows 11 自然语音后自动改善。
2. **首音约 0.6~1 秒**（日志出现 → 请求 → 合成 → 播放），不是流式朗读。
3. **管理窗必须开着**才能出声（它本来就是程序本体；最小化正常，关窗即退出）。
4. **杀软可能提示** —— 会短时启动 `powershell.exe`；脚本固定、参数走数据文件，不拼命令行。
5. **共演时配角用主角音色** —— 一期限制，二期可扩。
6. **详情只保留 14 天** —— 更早日志的 ▶ 会返回「详情已过期」。

---

## 9. 实施顺序

1. `src/tts/`（`text` → `voice` → `synth` → `index`）
2. 配置默认值与 `handlePutConfig` 校验
3. 4 个接口 + `/api/npcs/:slug/voice`
4. 实验功能「语音朗读」卡片 + 试听
5. 执行日志 ▶ 播放 + `语音` 筛选
6. NPC 记忆页语音块
7. Electron autoplay 开关
8. 版本号 + 文档
9. 按 §7 分层验证
