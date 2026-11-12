# 语音朗读（TTS）方案

> 状态：**已实现（0.18.0）**。基线代码：**0.17.2**，实现版本 **0.18.0**。
> 实现前的两轮复核见 §11/§12；落地后的实测结论见 §13。
> 配置键已并入 [configuration.md](configuration.md)，接口并入 [api.md](api.md)，
> 验证证据并入 [verification-log.md](verification-log.md)。

---

## 0. 目标与边界

**目标**：NPC 回复生成后，用本机**免费、离线、公开**的语音方案把台词读出来；一期只做最基本的
**男 / 女**两个音色。

**形态**

1. 「实验功能」页新增「语音朗读」卡片，其中**自动播放开关默认关闭**；开启后，每条新到的
   NPC 回复日志自动朗读。
2. 「执行日志」每条成功的 NPC 回复带 **▶ 播放** 按钮，可手动朗读。

**明确不做（一期）**

- 不边生成边读（不干扰真流式，留到二期）。
- 不做游戏内音频 / 口型：本工具不改游戏文件（[workshop/README.md](../workshop/README.md)），
  声音只能由本程序所在进程发出。
- 不做配角独立音色：共演一期用主角音色读整段（二期可低成本拆分，见 §8 第 5 条）。
- 不接 Edge 在线神经语音：实测本机合成接口 403，且属非官方接口，无 SLA。
- 不做情绪变声、逐句分角色、字幕同步。

---

## 1. 引擎选型

| 方案 | 免费 / 公开 | 音质 | 离线 | 额外依赖 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **Windows 内置语音（WinRT）** | 系统自带，永久免费，无需 Key | 机械但清楚 | ✅ | 零 npm 依赖，调用系统 `powershell.exe` | **一期采用** |
| Edge 神经语音（edge-tts 那套） | 免费无需 Key，但非官方 | 接近真人 | ❌ 需联网 | 原生 WebSocket 可实现 | 本机实测 403，放弃 |
| 本地开源神经 TTS（Piper / Kokoro / IndexTTS） | 开源免费 | 最好 | ✅ | 打包模型 + ONNX 运行时（100MB~1GB） | 违反便携 + 零依赖，二期再议 |
| 云厂商免费额度（Azure 等） | 需注册、需 Key | 很好 | ❌ | 需管理 Key | 不满足「公开」诉求 |
| 浏览器 Web Speech API | 系统语音 | 同 Windows | ✅ | 零依赖 | 备选：Chromium 对中文男声不可靠 |

### 1.1 本机语音清单（2026-11-11）

| 语音 | 性别 | 语言 |
| --- | --- | --- |
| Microsoft Kangkang | Male | zh-CN |
| Microsoft Huihui | Female | zh-CN |
| Microsoft Yaoyao | Female | zh-CN |
| Microsoft David / Zira / Mark | Male / Female / Male | en-US |

- 经典 SAPI（`System.Speech`）的注册表里只有 `Huihui`，**中文男声必须走 WinRT**。
- **更正（2026-11-11）**：Windows 11 讲述人的「自然语音」（Xiaoxiao / Yunxi 等）**第三方程序用不了**。
  它们属于第四套独立的语音系统（Azure 内嵌语音，微软限制访问），只供讲述人使用，
  **不会出现在 WinRT `SpeechSynthesizer.AllVoices` 里**——本程序装了自然语音也不会自动变好。
  社区的 `NaturalVoiceSAPIAdapter` 是提取系统密钥的 hack，仅供 SAPI5，且可能随系统更新失效，
  不作为本项目的依赖。要更好的音质必须换引擎，见 §14。

### 1.2 实测耗时（本机，走完整链路）

| 场景 | 结果 |
| --- | --- |
| 44 字，Kangkang | 597 ms / 240,910 B |
| 44 字，Huihui | 390 ms / 261,326 B |
| 44 字，rate 1.3 + pitch 0.9 | 427 ms / 186,140 B |
| 空文本 | 374 ms / 46 B（**只有 WAV 头**，必须提前拦掉） |
| 并发 2 个 | 总墙钟 447 ms（互不阻塞） |
| 输出格式 | 16 kHz / 16 bit / 单声道 WAV，`RIFF`/`WAVE` 头正确 |

参数实测范围：`SpeakingRate` 0.5~3、`AudioPitch` 0.5~2。

> **音量不走合成**：`AudioVolume` 虽然能设，但实测 `volume=0` 生成的仍是「有内容」的 WAV
> （只随语速变化大小），用它静音不可靠。**音量一律在页面 `<audio>.volume` 上调**，
> 合成端固定默认音量。这样也少一个缓存维度。

---

## 2. 整体链路

```text
游戏请求 → 本程序 → 上游模型 → 回复照常返回游戏（一个字节都不变）
                                    │
                            日志落盘（detail.reply）
                                    │ SSE 推送
                     ┌──────────────┴──────────────┐
              自动播放开关开着                  玩家点 ▶
                     └──────────────┬──────────────┘
                                    ▼
              fetch /api/tts/audio/<rid>?auto=1   （auto=1 时服务端判静音）
                                    ▼
              文本清洗 → 选音色 → PowerShell+WinRT → WAV
                                    ▼
                 页面 blob → objectURL → <audio> 播放
```

**合成按需**：不点播放、也没开自动播放时，**不会启动任何 PowerShell 进程**，
对现有对话零开销、零延迟影响。

---

## 3. 后端改动

### 3.1 新增 `src/tts/`

| 文件 | 职责 |
| --- | --- |
| `text.js` | 纯函数：JSON 兜底解包、清洗、按模式抽取、截断（无 IO） |
| `voice.js` | 语音枚举缓存、音色解析、逐 NPC 设置、性别判定 |
| `synth.js` | PowerShell + WinRT 合成 WAV：超时、并发、内存缓存、进程回收 |
| `index.js` | 对外导出 `listVoices / synthForRid / readVoice / saveVoice / shutdown` |

#### `text.js`

处理顺序（每一步都必须能单独测）：

1. **JSON 兜底解包**（重要）：`detail.reply` 正常就是纯文本，但流式路径下
   `parsedA.content` 可能仍是内层 JSON 字符串（模型双层 JSON、非流式才自动修复）。
   若文本 `trim()` 后以 `{` 开头且含 `"content"`，尝试 `JSON.parse`，取 `.content`，
   最多解包 2 层；仍像 JSON 则返回 `{ok:false, reason:'not_plain_text'}`，**不朗读**
   （避免把 `{"content":...}` 念出来）。这条同时防住所有历史脏数据。
2. 去 markdown（`**`、`#`、`>`、列表符）与表情符号。
3. 模式 `all`：保留正文；`skipActions=true` 时删除 `（…）`、`(…)`（全角半角，支持嵌套一层）。
4. 模式 `dialogue`：只抽 `「…」`、`『…』`、`“…”`、`"…"` 内的文字，按序拼接；
   **为空则回退 `all`** 并返回 `fallback:'dialogue_empty'`。
5. 截断：超过 `maxChars`（默认 600）按句号 / 问号 / 感叹号 / 换行切句，保留完整句子。
6. **空结果**直接返回 `{ok:false, reason:'empty_text'}`（实测空文本会产出 46 字节空 WAV），
   接口层据此返回 400 并记 `tts_empty_text`。

> **0.17 复核**：2026-11 游戏更新后 `## 输出格式` 的契约是「`content` 只写台词、不写括号旁白」
> （见 `src/server.js` 的 `FORMAT_REMINDER`）。因此 `skipActions` 在新日志上多半无事可做，
> 但旧日志与「玩家自建提示词要求写旁白」的场景仍会带括号动作，保留开关并默认 `true`。
> `dialogue` 同理，保留给旁白多的玩法。

#### `voice.js`

- **枚举**：WinRT `AllVoices` 里 `Language` 以 `zh` 开头的语音，缓存 10 分钟。
  枚举本身要起一次 PowerShell（约 0.4s），只在打开实验功能页/首次合成时调用。
- **音色解析优先级**：逐 NPC `voice.json` → 全局 `tts.voices.male/female` →
  系统里第一个中文语音 → 失败（返回 `tts_no_voice`）。
- **性别判定**（仅 `gender:'auto'`）：
  1. `voice.json.gender` 显式 `male/female`；
  2. 最新 intake 的 `## 角色属性`（若存在）与 `【角色属性】` 事实块里的「外貌 / 善恶」；
  3. `## 角色设定` + `## 角色背景` + 上述属性块里 `她` / `他` 的词频；
  4. 都不成立 → `tts.defaultGender`（默认 `female`）。

  实现要点：
  - **禁止**用 `- 性别：` 这一行：`identify.js` 的 `extractGameState()` 取的是**玩家**性别
    （`state.lastGame.player.gender`），用错会让所有 NPC 变成玩家性别。同理禁止用
    `state.lastGame.player.*`。
  - 复用现成解析：`cast/card.js` 的 `sectionsOf()`（已导出）、`identify.js` 的
    `extractFactBlocks()`（已导出）。**另把 `cast/card.js` 的 `latestIntake()` 改为导出**，
    避免重复实现「按 mtime 取最新 intake」。
  - **不要复用 `buildCard()`**：它按共演需要做了截断与命名，不适合性别判定。
  - intake 是完整 system 快照，`memory.snapshotSystem=false` 时没有 intake → 直接用默认性别。
  - 返回判定依据（如 `来源：【角色属性】外貌「身着白衣的少女」` 或 `她×12 / 他×0`），
    管理页可见。

#### `synth.js`

- 临时目录 `DATA_DIR/tmp/tts/`（`DATA_DIR` 已由 `config.js` 导出）。**首次使用时**
  `mkdir -p` 并清掉该目录下所有 `.json` / `.wav`（避免上次异常退出残留）。
- 调用：写 job JSON → `execFile('powershell.exe', [...])`，参数为
  `-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <base64>`，
  选项 `{ windowsHide: true, timeout: 20000 }`。
  **job 路径走环境变量 `WFC_TTS_JOB`**，文本与音色只写在 job 文件里，不拼命令行。
- job 字段：`{ text, voice, rate, pitch, out }`（**不含 volume**，见 §1.2）。
- 脚本行为：读 job → 选音色（找不到就用系统默认）→ 设 rate/pitch → 合成 →
  `AsStreamForRead` 落 WAV → 退出。脚本以**字符串常量**内联在 `synth.js`。
- **stderr 不可信**：成功时 PowerShell 仍会往 stderr 吐 CLIXML 进度噪音。
  判定成功只看「退出码 0 且输出文件存在且 > 44 字节」，stderr 仅在失败时截前 200 字记日志。
- 输出为 0 字节或只有 44 字节头 → 视为失败（`tts_empty_audio`）。
- 并发上限 2，超出排队；单次超时 20s（`execFile` 的 `timeout` 会 SIGKILL）。
- **进程回收**：记录在飞的子进程，`shutdown()` 全部 `kill()` 并清空队列；
  在 `src/server.js` 的 `server.on('close')` 里与 `idleFlusher.stop()` 一起调用
  ——对应 [contributing.md](contributing.md) 代码约束 7「不能拖住进程退出」。
- 内存 LRU：`sha1(text + voice + rate + pitch)` → WAV Buffer，最多 20 条（约 8MB）。
- 每次合成写一条日志 `kind:'tts'`，字段 `slug / chars / mode / voice / synthMs / bytes /
  status / error`，**不写台词正文**。

### 3.2 `src/server.js`

**必须先补一处**：NPC 的请求详情没有 `slug`（只有 `baseLog` 有），而音频接口要按 slug 选音色。

```js
// 约 L1515
const detail = {
  kind: 'npc',
  slug: info.slug,   // ← 新增（就这一行；不影响响应字节）
  ...
};
```

新增接口（挂在 `/api/` 内，自动继承「仅本机」限制）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tts/voices` | 系统中文语音列表、男/女声建议、可用性；无语音时 `ok:false` + 安装指引 |
| GET | `/api/tts/audio/:rid?mode=all\|dialogue&auto=1&slug=<slug>` | 合成 `detail.reply`，返回 `audio/wav`；`mode` 省略时用配置 `readMode`；`auto=1` 时该 NPC 静音则返 **204** |
| POST | `/api/tts/preview` | `{text?, gender, rate, pitch}` → WAV 试听；`text` 缺省用内置示例句 |
| PUT | `/api/npcs/:slug/voice` | 保存 `voice.json` |

实现要点：

- 回复正文一律取 `logger.getDetail(rid).reply`。**不要用主日志的 `replyPreview`**（只有 500 字）。
- 音色归属：优先用 `detail.slug`；**0.18.0 之前写下的旧日志没有这个字段**，此时回退到页面传入的
  `?slug=`；两者都没有（旧日志 + 非 NPC 页调用）就用全局默认性别，不报错。
- `?slug=` 来自 URL，属不可信输入：**必须**按 `resolveNpcDir()` 同样的方式校验
  （`path.join(NPCS_DIR, slug)` 后 `startsWith(NPCS_DIR + path.sep)`），禁止直接拼路径读文件。
- `auto=1` 才检查该 NPC 的 `voice.json.enabled`；**手动播放（不带 `auto`）不受全局
  `tts.enabled` 与逐 NPC 静音影响**，随时可播。
- `detail.reply` 是 `finalContent`（共演时已合并 B 的台词），纯文本，不需要再剥 JSON
  （但仍走 `text.js` 的解包兜底）。
- 详情保留 `log.maxDays`（默认 14 天）。过期/不存在 → 404 `detail_not_found`，
  前端提示「详情已过期」。
- `preview` 的 `text` 截到 `maxChars`，避免把管理页当通用合成接口。
- `PUT /api/npcs/:slug/voice` 复用 `resolveNpcDir()`（约 L405）做路径校验，勿自己拼路径。
- 响应头：`content-type: audio/wav`、`content-length`、`cache-control: no-store`。
  **不实现 Range**（页面用 fetch + blob，不需要）。
- 原有接口补字段：
  - `/api/status`、`/api/config`：`tts` 配置段（**不含语音清单**，避免每次拉状态都起一次
    PowerShell；清单只在 `/api/tts/voices` 里按需给）。
  - `/api/npcs/:slug`：`voice`（原始设置）与 `voiceResolved`（`{gender, voiceName, reason}`）。
  - `/api/npcs`：`voiceEnabled`（供列表显示「已静音」）。
- **主对话链路不改**：不加 `await`、不合成、不改响应字节。注意 `handleChat` 在
  `logger.append` 之后还有 `if (!memEnabled || !bundle || !result.ok || !finalContent.trim()) return;`
  ——**日志已落盘**，所以记忆关闭时自动朗读同样可用。

### 3.3 数据文件

```text
data*/npcs/<slug>/voice.json   # 可选；缺失即全用全局设置
  { "enabled": true, "gender": "auto", "rate": 1.0, "pitch": 1.0 }
data*/tmp/tts/                 # 合成临时目录（job.json / *.wav），启动首次使用时清空
```

`data*/` 已被 `.gitignore` 整体忽略，无需改忽略规则。

### 3.4 配置默认值（`src/config.js` 的 `defaults()`）

```json
"tts": {
  "enabled": false,
  "readMode": "all",
  "skipActions": true,
  "voices": { "male": "Microsoft Kangkang", "female": "Microsoft Huihui" },
  "defaultGender": "female",
  "rate": 1.0,
  "pitch": 1.0,
  "volume": 0.8,
  "maxChars": 600
}
```

| 键 | 含义 |
| --- | --- |
| `enabled` | 自动播放总开关，默认关闭（升级后不会突然出声） |
| `readMode` | `all` 全部朗读 / `dialogue` 仅对白 |
| `skipActions` | `all` 模式下跳过括号内动作描写 |
| `voices.male` / `voices.female` | 全局男 / 女音色名 |
| `defaultGender` | 性别判定的兜底音色 |
| `rate` / `pitch` | 合成语速 / 音调（0.5~3 / 0.5~2，超出夹取） |
| `volume` | **播放音量**（仅前端 `<audio>.volume`，不参与合成与缓存） |
| `maxChars` | 单条朗读字数上限，超出按句截断 |

校验加在 `handlePutConfig` 的 `safe` 段：布尔断言；`maxChars` 用 `intIn` 夹取；
`volume` / `rate` / `pitch` 手工夹取（`Math.min(Math.max(Number(v), min), max)`）并
`Math.round(v*100)/100` 保留两位小数，非法值直接忽略（**不要用 `intIn`**：它 `Math.floor`，
会把 `0.8` 压成 `0`）；枚举 `readMode` / `defaultGender` 走白名单。
旧配置没有 `tts` 段由 `deepMerge` 自动补，无需迁移。

---

## 4. 管理页改动（`public/`）

### 4.1 实验功能页：「语音朗读」卡片

放在「请求重写」卡片之后。**引擎是音色的一部分，不再单独成卡片**：
卡片内顺序为 自动朗读 → 朗读范围 → **【音色】小节（引擎 + 男女声）** → 语速/音调/字数 → 音量/默认音色 → 保存。

- **自动播放开关**：变更即保存（单独 `PUT {tts:{enabled}}`），并同步水位（见 §4.3）。
- 朗读范围 `全部内容 / 仅对白`；选「全部内容」时显示「跳过括号内的动作描写」。
- **【音色】小节**（`h4.tts-sub`）：
  - **音色引擎** `Windows 内置语音（即时）` / `Kokoro 神经语音（接近真人）`。
    换引擎后**男声/女声两个下拉立刻换成对应的可选声音**（系统中文语音 ↔ Kokoro 说话人），
    这是「引擎只决定有哪些声音可选」的直接体现。
  - 男声 / 女声下拉：内容随引擎变化；Kokoro 未安装时 `kokoro` 选项不可选（选了会回退并提示下载）。
  - Kokoro 状态 + 未安装时的「下载并安装」按钮与进度条（已安装后自动隐藏，只留一行就绪提示）。
  - **男声试听 / 女声试听**（`POST /api/tts/preview`，同时带 `engine` 与 `voice`）。
  - 两套音色配置**各自独立保存**：Windows 存 `tts.voices.male/female`，
    Kokoro 存 `tts.kokoro.voiceMale/voiceFemale`；切换引擎不会互相覆盖，切回来还是原来的选择。
  - 语音清单**在切到本页时才拉** `/api/tts/voices`（枚举系统语音要起一次 PowerShell，约 0.4s），
    不要放进首屏 `loadStatus()`。
- 语速 / 音调 / 播放音量，单条字数上限。
- 播放器：当前条目名、▶/⏸、⏹ 停止、队列长度、错误提示区。
- 「保存语音设置」按钮（除自动播放开关外的字段）。
- `public/index.html` 的 `</main>` 前加一个全局播放元素 `<audio id="ttsAudio" hidden></audio>`
  （页面里只保留一个，供自动播放与手动播放共用）。

### 4.2 执行日志

- 在 `renderLog()` 的 `.log-head` 里插入 **▶ 播放**，条件：
  `rec.kind === 'npc' && rec.status === 'done' && rec.hasDetail && (rec.replyChars || 0) > 0`。
- 现有日志项点击已排除 `button`（`e.target.closest('button, a, input, textarea, .log-detail')`），
  放按钮安全；仍在按钮上显式 `stopPropagation()` 防回归。
- 按钮需在 `div.innerHTML = ...` 之后单独 `querySelector('.log-play').addEventListener(...)`。
- 新增筛选 chip `语音`（`data-kind="tts"`）。
- **`public/style.css` 必须补样式**（否则徽章白字无底色、看不见）：
  `.badge.tts { background: #4a6b52; }`、`.log-item.tts { border-left-color: #4a6b52; }`。
- `public/app.js` 的 `KIND_LABELS` 补 `tts: '语音朗读'`；
  `ERROR_TEXT_LABELS` 补错误码（见 §4.6）。

### 4.3 自动播放的边界处理（重要）

- **挂载点必须是 SSE 消息处理，不是 `addLog()`**：`addLog()` 开头有
  `if (!matchFilter(rec)) return;`——用户切到「仅异常」等筛选时，新 NPC 日志会被直接丢弃，
  自动朗读也跟着失效。正确做法：
  ```js
  es.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'snapshot') renderLogs(msg.records);
    else if (msg.type === 'log') { maybeAutoPlay(msg.record); addLog(msg.record); }
  };
  ```
- **不补播历史**：`maybeAutoPlay` 只播 `rec.seq > autoplaySeq`；`autoplaySeq` 在**每次**
  收到日志时更新（无论开关是否打开），在开关打开那一刻取当前最大值。
  `snapshot` 只渲染，不触发朗读——刷新页面不会重播。
- **去重**：同一 `rid` 只自动播一次（内存 `Set`）。
- **串行**：单 `<audio>` + 最多 2 条待播；新回复排队，不打断当前句。
- **静音 NPC**：`auto=1` 由服务端判 `voice.json.enabled === false` 并返 204，
  前端无需同步 NPC 列表。
- **取音频用 `fetch` + blob + `URL.createObjectURL`**，不用 `<audio src>` 直连：
  可以读到 404/204/错误 JSON，也能统一做 LRU（保留最近 20 条 blob，超出 `revokeObjectURL`）。
  URL 形如 `/api/tts/audio/<rid>?slug=<slug>&auto=1`（`slug` 供旧日志兜底，见 §3.2）。
- **被浏览器拦截**：Electron 侧放行自动播放；CLI / 浏览器模式下 `audio.play()` 被拒时，
  卡片顶部提示「点一下页面任意位置即可恢复自动朗读」。

### 4.4 NPC 记忆页

`loadNpcDetail()` 里新增「语音」块：显示判定结果与依据、`自动 / 男声 / 女声`、
逐 NPC 语速 / 音调、该 NPC 试听、是否参与自动朗读（`enabled`）。
保存走 `PUT /api/npcs/:slug/voice`，保存后刷新列表标签。

### 4.5 `electron/main.cjs`

- `app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')`（需在 `app.whenReady()` 前）。
- `webPreferences` 增加 `backgroundThrottling: false`。
- 窗口已 `sandbox: true` / `contextIsolation: true`，`<audio>` 与 `fetch` 都不受影响。

### 4.6 新增日志码（需在 `public/app.js` 登记中文）

| 码 | 中文 |
| --- | --- |
| `tts_no_voice` | 系统里没有可用的中文语音，请在 Windows 设置里添加 |
| `tts_timeout` | 语音合成超时（20 秒） |
| `tts_powershell_failed` | 调用系统语音失败（可能被安全策略拦截） |
| `tts_empty_text` | 这条回复里没有可朗读的文字 |
| `tts_empty_audio` | 系统语音返回了空音频（文本可能全是符号） |
| `tts_not_plain_text` | 回复里没有可朗读的纯文本 |

---

## 5. 打包影响

- **零新增运行时依赖**：`node:child_process` / `fs` / `crypto` / `path` + 浏览器原生 API。
- **本项目首次使用 `child_process`**（当前 `src/` 零子进程）。这不违反约束 1，但要在
  [contributing.md](contributing.md) §2 补一句说明：TTS 是唯一允许的子进程用途，
  参数走 job 文件、脚本内联常量、必须有 20s 超时与 `shutdown()` 回收。
- 脚本是字符串常量，esbuild 会打进 `dist/backend.cjs`，`scripts/build-backend.mjs` 无需改。
- `public/` 已作为 `extraResources` 打包，UI 改动无需调整构建配置。
- `scripts/dist.mjs` 已改为「只补回缺失文件」，`tmp/tts/` 无需纳入备份/校验。

---

## 6. 版本号与文档

- `package.json`：**0.17.2 → 0.18.0**（新功能 = MINOR）。
- 新增本文件 `docs/tts.md`。
- 同步更新：
  - `AGENTS.md`：文档路由（已加）、运行原理图（新增语音分支）、目录树
    （`src/tts/`、`voice.json`、`tmp/tts/`）、§5 管理接口一行。
  - `docs/configuration.md`：`tts` 全部键与默认值。
  - `docs/api.md`：4 个新接口、`tts` 日志字段、NPC 详情新增 `voice`/`voiceResolved`。
  - `docs/contributing.md`：§2 补「子进程」一条。
  - `docs/verification-log.md`：本次实测数据与验证结论。

---

## 7. 验证计划

| 层 | 内容 |
| --- | --- |
| 模块级 | `text.js`：双层 JSON 解包、括号剥离、引号抽取、空对白回退、空结果拒绝、截断不切词；`voice.js`：性别判定各分支（**含「不得用玩家性别」用例**）、音色解析优先级、intake 缺失 |
| 真实合成 | 直接调 `synth.js`：Kangkang / Huihui 各一段，核对 `RIFF/WAVE`、字节数、耗时、并发 2、超时、空文本拒绝 |
| 假上游端到端 | 响应字节与改动前**完全一致**；关闭 TTS 时无 `tts` 日志、无子进程；开记忆/重写/共演时 `detail.slug`、`detail.reply` 正确 |
| 浏览器实测 | 切到「仅异常」筛选后自动朗读仍生效（§4.3 的坑）；刷新不重播；试听；▶ 播放；停止；静音 NPC 返 204；过期 rid 提示 |
| 故障注入 | 禁用/拦截 PowerShell → 对话照常、仅 `tts` 错误日志；删除语音 → 提示安装；关窗时在飞子进程被杀 |
| 便携版冒烟 | `--test` 启动 exe，asar 内能拉起 PowerShell、数据落 `data_test/`、关窗全退 |

---

## 8. 风险与已知限制

1. **音质偏机械** —— 系统自带的是 2013~2016 年的 MSTTS 参数式语音，这是引擎上限；
   Windows 11 自然语音不对外开放，无法改善（见 §1.1）。换引擎见 §14。
2. **首音约 0.6~1.0 秒**（日志出现 → 请求 → 合成 → 播放），实测单次合成 0.39~0.60s。
3. **管理窗必须开着**才能出声（它是程序本体；最小化正常，关窗即退出）。
4. **杀软/组策略可能拦截** 短时启动的 `powershell.exe`（`-ExecutionPolicy Bypass` 也可能被
   企业策略禁掉），失败只影响朗读并记 `tts_powershell_failed`。
5. **共演时配角用主角音色**：`detail.cast` 里只有 `segments` 的**说话人名**（`segments.map(s=>s.who)`）
   与 `bLine` 正文，读整段时无法逐句分角色；二期可结合 `bLine`/`inserted`/`mode` 拆分。
6. **详情只保留 14 天** —— 更早日志的 ▶ 返 404「详情已过期」。
7. **详情上限 256KB**（`log.js` 的 `DETAIL_MAX_CHARS`）—— 极端超长请求/回复会被截断，
   朗读可能少一截；正常一轮远小于该值。
8. **旧 rid 回读是同步整文件扫描**（`logger.#readDetailFromDisk`）——只在点击「不在内存最近
   100 条」的老日志时触发，日志量极大时会有一次可感知的卡顿；自动播放只碰新日志，不受影响。
9. **不实现 HTTP Range**：页面用 fetch+blob，所以 `<audio>` 拖进度条不适用（一期不需要）。

---

## 9. 实施顺序

1. `card.js` 导出 `latestIntake`；`src/tts/`（`text` → `voice` → `synth` → `index`）
2. `detail` 补 `slug`；`config.js` 默认值；`handlePutConfig` 校验；`server.on('close')` 挂 `tts.shutdown()`
3. 4 个接口 + `/api/npcs/:slug/voice` + status/config/npcs 字段
4. 实验功能「语音朗读」卡片 + 试听 + `style.css`
5. 执行日志 ▶ 播放 + `语音` 筛选 + 日志码中文
6. NPC 记忆页语音块
7. Electron autoplay 开关
8. 版本号 + 文档
9. 按 §7 分层验证

---

## 10. 与 0.17.2 代码的对接点

| 对接点 | 位置 |
| --- | --- |
| 请求详情补 `slug` | `src/server.js` `const detail = { kind:'npc', … }`（约 L1515） |
| 取回复正文 | `logger.getDetail(rid).reply`（`src/log.js`：内存 100 条 + 按 rid 日期回读磁盘） |
| 回复正文生成 | `finalContent = parsedA.content`，共演时按 `segments` 合并（约 L1660） |
| 新增 `tts` 默认值 | `src/config.js` `defaults()` |
| 配置校验 | `handlePutConfig` 的 `safe` 段（约 L492 起） |
| 路由挂载 | `if (normPath.startsWith('/api/'))` 块（约 L1903） |
| NPC 路径校验 | 复用 `resolveNpcDir()`（约 L405） |
| NPC 详情返回语音 | `handleNpcDetail`（约 L686） |
| 关服回收子进程 | `server.on('close', () => idleFlusher.stop())`（L1957）旁加 `tts.shutdown()` |
| 日志播放按钮 | `public/app.js` `renderLog()` 的 `.log-head`（约 L950） |
| 自动播放挂载 | `public/app.js` `connectEvents()` 的 `msg.type === 'log'` 分支（约 L1027），**不要挂 `addLog()`** |
| 实验功能卡片 | `public/index.html` `#tab-labs`（约 L101） |
| 日志筛选 chip | `public/index.html` `#kindFilters`（约 L164） |
| 日志类型中文 | `public/app.js` `KIND_LABELS`（L375）/ `ERROR_TEXT_LABELS` |
| 徽章样式 | `public/style.css`（`.badge.*` 约 L129、`.log-item.*` 约 L120） |
| Electron 放行自动播放 | `electron/main.cjs`（`app.commandLine` + `webPreferences`） |

---

## 11. 相对前两版方案的修订

| 原假设 | 复核结论 | 影响 |
| --- | --- | --- |
| `detail` 已有 slug | **错**，只有 `kind`；slug 在 `baseLog` | 必须补一行 `slug: info.slug` |
| 用 `- 性别：` 判 NPC 性别 | **危险**，那是**玩家**性别 | 只用 `## 角色属性` / `## 角色背景` / `## 角色设定` + 代词词频 |
| `content` 含括号动作 | 2026-11 契约改为「只写台词」 | `skipActions` 降级为兼容项，默认仍 `true` |
| 用 `AudioVolume` 控制音量，测试时 `volume=0` 静音 | **实测无效**（空音仍产出内容） | 音量移到前端 `<audio>.volume`，合成端去掉 volume |
| 空文本也合成 | **会产出 46 字节空 WAV** | 前置拒绝，返回 `tts_empty_text` |
| stderr 出错才非空 | **成功时也有 CLIXML 噪音** | 成功只看退出码 + 文件大小 |
| 自动播放挂 `addLog()` | **会因当前筛选而失效** | 改挂 SSE 的 `log` 分支 |
| `<audio src>` 直连 | 要处理 Range/错误码 | 改 fetch + blob + objectURL |
| 徽章自动有样式 | **没有**，`.badge` 无默认底色 | 必须补 `.badge.tts` / `.log-item.tts` |
| `detail.cast.segments` 含台词 | 只有说话人名 + 单独的 `bLine` | 二期拆分需结合 `bLine` |
| 版本 `0.16.0 → 0.17.0` | 基线已是 **0.17.2** | 目标版本 **0.18.0** |
| 子进程无额外义务 | 约束 7 要求不拖住退出 | 增加 `tts.shutdown()` 并在 `server close` 调用 |
| 音频接口只靠 `detail.slug` | 0.18.0 之前的旧日志没有该字段 | 增加 `?slug=` 兜底，并对该参数做路径校验 |

---

## 12. 本次实测记录（2026-11-11）

用与实现完全一致的方式跑通链路（临时脚本，不入库）：

```text
Node execFile('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
  '-EncodedCommand', base64(utf16le(脚本))], { env: { WFC_TTS_JOB: job }, timeout: 20000,
  windowsHide: true })
  → 脚本读 job JSON → WinRT 合成 → 写 WAV → Node 读回
```

结果：

| 用例 | ok | WAV 头 | 字节 | 耗时 |
| --- | --- | --- | --- | --- |
| Kangkang，44 字 | ✅ | RIFF/WAVE | 240,910 | 597 ms |
| Huihui，44 字 | ✅ | RIFF/WAVE | 261,326 | 390 ms |
| Kangkang，rate 1.3 / pitch 0.9 | ✅ | RIFF/WAVE | 186,140 | 427 ms |
| 空文本 | ✅（需拦） | 仅头 | 46 | 374 ms |
| 并发 2 个 | ✅ | RIFF/WAVE | — | 墙钟 447 ms |

结论：

1. 「Node → 内联 PowerShell → WinRT」这条路可行，耗时符合预期（<0.6s）。
2. 必须自己校验「文件 > 44 字节」，不能只看退出码。
3. 成功时 stderr 有 CLIXML 噪音，不能据此判失败。
4. `AudioVolume` 不用于静音。
5. 并发 2 不会互相拖慢，队列上限可保持 2。

---

## 13. 落地实测（2026-11-11，0.18.0）

### 13.1 模块级

`src/tts/text.js`：

| 用例 | 输入 | 结果 |
| --- | --- | --- |
| 纯文本 | `你好，今天天气不错。` | `ok:true`，10 字 |
| 跳过动作 | `（她抿了口茶）你好呀。` | `你好呀。`（4 字） |
| 保留动作 | 同上 + `skipActions:false` | 原样 11 字 |
| 仅对白 | `她笑了笑：「道友请留步。」又补了一句「可好？」` | `道友请留步。\n可好？` |
| 无引号回退 | `她笑了笑，没有开口。` | 全量 + `fallback:"dialogue_empty"` |
| 双层 JSON | `{"content":"{\"content\":\"台词\"}"}` | 解包出 `台词` |
| 坏 JSON | `{"content":"没闭合` | `ok:false` / `not_plain_text`（不朗读） |
| markdown | `## 标题 / **加重** / 😀` | 去标记、去表情 |
| 纯符号 | `（）` | `ok:false` / `empty_text` |
| 超长 | 长句 + `maxChars:50` | 按句切到 `第一句。第二句！第三句？`，不切词 |

`src/tts/voice.js` + `synth.js`：

- 枚举到 3 个中文语音：`Huihui`(女)、`Yaoyao`(女)、`Kangkang`(男)。
- 合成：Kangkang 240,910 B / 462ms；Huihui 261,326 B / 387ms；同参数二次调用 `cached:true`。
- 不存在的音色名自动回退系统默认，仍能出声。
- 空文本前置拒绝（`empty_text`），不会生成 46 字节空 WAV。

### 13.2 端到端（假上游 + 真实后端，测试档）

| 项 | 结果 |
| --- | --- |
| 关闭 TTS 时跑一轮游戏对话 | **新增 `tts` 日志 0 条**、PowerShell 进程数不变（2→2） |
| TTS 开/关两次请求的回复正文 | **逐字节一致** |
| `detail.slug` | 已带上（`章籽梦`） |
| `GET /api/tts/voices` | `ok:true`，3 个中文语音 |
| `GET /api/tts/audio/<rid>` | 200 / `audio/wav` / RIFF 头正确 |
| `?mode=dialogue` 与 `?mode=all` | 13 字 vs 21 字（差异符合预期） |
| `POST /api/tts/preview` | 200，80,366 B |
| 逐 NPC 静音 + `?auto=1` | **204**（静默跳过） |
| 逐 NPC 静音 + 手动播放 | **200**（手动不受静音影响） |
| `detail_not_found`（过期 rid） | 404 + 中文提示 |
| 配置往返 | `enabled/readMode/skipActions/volume/rate/maxChars/defaultGender` 全部保留 |
| 非法值夹取 | `rate:99→3`、`pitch:-5→0.5`、`volume:9→1`、`maxChars:0→50`、`readMode:'bogus'` 被忽略 |

### 13.3 管理页实测（浏览器）

- 实验功能页：卡片渲染正常，男/女声自动填入 `Kangkang`/`Huihui`，无可用语音时显示安装提示。
- 保存语音设置 → `✓ 语音设置已保存`，回读一致。
- 自动朗读开关 → 提示「只播之后的新回复」，水位正确记为当前最大 `seq`。
- 新回复到达 → 自动合成（日志 `auto:true`、`synthMs:417`、音色按 NPC 判定）。
- 逐 NPC 静音后自动朗读**静默跳过**（204），手动 ▶ 仍可播。
- 日志 ▶：点击 → `■ 停止`，再点 → 停止；同一条命中缓存。
- **刷新页面不重播**（水位来自已渲染记录的最大 `seq`）。
- 日志筛选新增「语音」chip，`语音朗读` 徽章有底色、可读。
- NPC 记忆页语音块：显示判定依据、可改 自动/男/女、逐 NPC 语速音调、试听；保存后列表出现「已静音」标签。
- 浏览器控制台**无报错**。

### 13.4 实现中修掉的问题

| 问题 | 处理 |
| --- | --- |
| `Number(null) === 0` 导致 `pitch:null` 被读成 `0` | 新增 `numOrNull()`，`null`/`undefined`/`''` 一律视为"跟随全局" |
| 空 WAV 只有 46 字节，`> 44` 判断漏判 | 改为解析 `data` 块长度，`<= 0` 即失败 |
| 全局音量用 `intIn` 会被 `Math.floor` 压成 0 | `volume`/`rate`/`pitch` 改走独立的 `clampFloat` |
| 自动朗读挂在 `addLog()` 会因日志筛选失效 | 改挂 SSE `msg.type === 'log'` 分支 |

### 13.5 二次自查与回归（0.18.0 收尾）

实现完成、出包之后又做了一轮完整自查（对照代码逐条走读 + 重跑全部用例），
共修掉 8 个问题，全部已复测：

| 问题 | 现象 | 处理 |
| --- | --- | --- |
| `.check { display:flex }` 覆盖 `[hidden]` | 「跳过括号动作」开关切到「仅对白」时**仍然显示** | CSS 加 `.check[hidden] { display:none }` |
| 半角双引号按嵌套计数 | `"你好" 她说` 会被当成无限嵌套，把**后文整段吞进来** | 开闭同形时直接找下一个同形引号 |
| 预览接口 `rate:null` → 0.5 | 不传 `rate` 的试听会被夹到**最慢语速** | `clampFloat` 先排除 `null/undefined/''` |
| 非 NPC 记录也能被朗读 | 用记忆摘要 / 压缩器的 `rid` 调音频接口会**合成摘要正文** | 只放行 `detail.kind === 'npc'`，否则 400 `not_npc_reply` |
| 男/女音色是只读 input | 玩家无法选择 `Yaoyao` 等其它语音，且 `tts.voices` 从未被保存 | 改成 `<select>`，从 `/api/tts/voices` 填充并在保存时写回 |
| 播放按钮切换不恢复 | 点 A 播放、再点 B，A 会**一直停在「■ 停止」** | 记录 `ttsActiveBtn`，换播放对象时统一复位 |
| 在飞的合成结果抢占播放器 | 连点两条时，先发起的那条可能**后返回并覆盖**播放器 | 加请求序号，过期结果直接丢弃 |
| 语音枚举失败不缓存 | PowerShell 被拦时，每次打开 NPC 页都会**再卡 15 秒** | 失败也缓存 10 分钟；超时降到 6 秒；新增「重新检测语音」按钮 |

另外补了两处体验细节：静音 NPC 手动点 ▶ 会提示「这个 NPC 已静音」；
NPC 语音保存后先重渲染再写「已保存」，避免提示被新元素覆盖。

**收尾回归（全部通过）**：

| 套件 | 项数 | 结果 |
| --- | --- | --- |
| 模块级（文本 / 音色 / 合成） | 24 | 24 passed |
| 引号解析专项 | 8 | 8 passed |
| 端到端（假上游 + 真实后端） | 25 | 25 passed |

其中包含关键回归：`rate:null` 不再被当成 0、ASCII 引号不再吞后文、
非 NPC 记录返 400、静音 NPC 自动播放返 204 而手动返 200、
关闭 TTS 时无 `tts` 日志且回复逐字节一致、刷新页面不重播。

### 13.6 音色选择失效与关服状态残留（0.18.0 热修）

**现象**：两个中文女声（`Huihui` / `Yaoyao`）听起来完全一样。

**排查**：

| 检查 | 结果 |
| --- | --- |
| 合成层是否真的换音色 | **正常**。同参数下 `Huihui` 176,366 B / `Yaoyao` 166,590 B，MD5 不同 |
| 合成是否确定性 | **是**。同一音色换尾部空格绕过缓存重合成 3 次，MD5 完全一致 |
| 两个音色是否本质相同 | **否，但很接近**：F0 中位数 211 vs 203 Hz，频谱质心 1138 vs 1053 Hz，时长 8.16 vs 7.57 s；同一 MSTTS 引擎 CLSID，本就高度相似 |
| 试听接口是否真的用了选中的音色 | **没有** ← 根因 |

**根因**：`POST /api/tts/preview` 只接受 `gender`，永远取 `config.tts.voices[gender]`。
管理页换了下拉框里的音色再点「女声试听」，后端仍然合成配置里那个固定女声，
所以两个女声**逐字节相同**。同理「试听本 NPC」也永远用全局女声。

**修复**：

1. 预览接口新增 `voice` 参数：命中系统语音清单就照用，否则按 `gender` 回退到配置默认。
2. 管理页「男声/女声试听」把下拉框**当前选中项**一起发过去。
3. 「试听本 NPC」在自动判定时用该 NPC 解析出的 `voiceName`，并带上逐 NPC 的语速/音调。
4. 顺带修掉一个同批问题：`synth.shutdown()` 把模块级 `stopping` 置 true 后**永不复位**，
   同一进程内再次启动服务会导致所有合成直接返回 `tts_stopping`。
   新增 `reset()` 并在 `createServer()` 里调用。

**修复后实测**：同一段文本，`voice=Huihui` → 176,366 B、`voice=Yaoyao` → 166,590 B、
`voice=Kangkang` → 163,598 B，三者互不相同；不传 `voice` 时等于配置默认；
传不存在的音色名自动回退。浏览器里两次试听时长 8.16 s / 7.57 s，确认换声生效。

**回归**：23 项（模块级 8 + 端到端 15）全部通过，其中包含
「`shutdown()` 之后再 `createServer()` 仍能正常合成」这一条。

### 13.7 语音朗读日志不再进执行日志（0.18.0 热修）

**反馈**：语音朗读的日志堆在执行日志里，把真正的对话记录冲掉了。

**改动**：

- `Logger.append(rec, detail, { fileOnly })` 新增 fileOnly 模式：**只写
  `logs/YYYY-MM-DD.jsonl`，不进内存环形缓冲、不推 SSE**，并给记录打上 `uiHidden: true`。
- 语音朗读用它记录**成功/跳过**；**失败仍进界面**（数量少、有诊断价值，会出现在「仅异常」）。
- 「这条没东西可读」（`empty_text` / `not_plain_text`）从 `error` 降级为 `skipped`：
  它不是故障，也不该占界面。
- 启动回读历史日志时按 `uiHidden` 过滤，并**兼容 0.18.0 之前的旧文件**（旧 tts 记录没有该标记，
  按 `kind === 'tts' && status !== 'error'` 一并滤掉）。
- 管理页移除「语音」筛选 chip；`kind === 'tts'` 的渲染分支改为按异常显示。

**验证**（9 项，全部通过）：连续朗读 3 次 + 试听 2 次后，界面日志里 `tts` 记录数为 **0**、
NPC 记录仍在；磁盘上这些记录**确实写入**且全部带 `uiHidden: true`；
重启服务回读历史后界面依旧看不到 tts 成功记录、NPC 记录正常保留。

**完整回归**：27 项（模块级 10 + 端到端 17）全部通过，包含音色可区分、
关闭 TTS 时零子进程、静音 NPC 204/手动 200、非 NPC 记录 400、配置往返与夹取。

---

## 14. 音质优化方案（2026-11-11 定稿）

> 前提两点（依反馈）：**① 现有朗读方案基本可用，只做小幅调整；② 可以外挂引擎，但必须国内可下载。**

### 14.1 为什么现在机械

系统自带中文语音是 **MSTTS V110**（`Huihui` 2016 / `Yaoyao` 2013 / `Kangkang` 2013），
16 kHz、**参数式（非神经）**合成，为「读菜单」设计。机械感来自引擎本身，调参数只能减轻、不能消除。

**Windows 11「自然语音」不可用**：Xiaoxiao / Yunxi 等属于第四套独立语音系统（Azure 内嵌语音），
微软限制第三方访问，**不会出现在 WinRT `AllVoices`**。社区 `NaturalVoiceSAPIAdapter` 是提取
系统密钥桥接到 SAPI5 的 hack（可能随系统更新失效），**不作为依赖**。

所以提升音质只有一条路：**换神经 TTS 引擎**。

### 14.2 国内可下载性实测（关键结论）

| 资源 | 来源 | 大小 | 实测速度 | 预计耗时 |
| --- | --- | --- | --- | --- |
| HuggingFace **直连** | huggingface.co | — | **失败（10.7s 超时）** | ❌ 不可用 |
| Piper 引擎 | GitHub Releases | 21.4 MB | 846 KB/s | ~26 s |
| Piper 中文模型（huayan-medium） | **hf-mirror** | 60.3 MB | 824 KB/s | ~75 s |
| sherpa-onnx 运行时 | GitHub Releases | 18.0 MB | 201 KB/s | ~90 s |
| Kokoro int8 模型 | **hf-mirror** | 108.9 MB | 836 KB/s | ~2.2 min |
| Kokoro voices.bin | **hf-mirror** | 26.9 MB | ~800 KB/s | ~35 s |
| Kokoro 中文词典 | **hf-mirror** | 2.3 MB | — | ~5 s |
| sherpa TTS 大模型走 GitHub | GitHub Releases | 140~350 MB | **~56 KB/s** | ❌ 42 分钟起 |

**结论**：

1. **HuggingFace 直连必须放弃**，一律走 `hf-mirror.com`（API 与文件都可用，实测 800+ KB/s）。
2. **大模型不要从 GitHub Releases 下**（56 KB/s）；GitHub 只用来取 20 MB 级别的**引擎本体**。
3. 总下载量控制在 **160 MB 以内、4 分钟以内**是国内网络的现实上限。

### 14.3 候选引擎（本地 / 免费 / 开源 / 国内可下）

| 方案 | 许可证 | 总下载 | 中文音色 | 自然度 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **Windows MSTTS（现状）** | 系统自带 | 0 | 1 男 2 女 | ★☆☆☆☆ | 保留为默认与兜底 |
| **sherpa-onnx + Kokoro int8** | Apache-2.0 | **~156 MB** | **4 男 4 女** | ★★★★☆ | **推荐外挂引擎** |
| sherpa-onnx + MeloTTS zh_en int8 | MIT | ~80 MB | 1 女（单说话人） | ★★★★☆ | 轻量备选（缺男声） |
| **Piper** | MIT | ~82 MB | 3 个中文音色（**均为女声**，实现时复核） | ★★★☆☆ | 备选（体积小、缺男声） |
| IndexTTS2 / CosyVoice2 | Apache-2.0 | 数 GB | 可克隆 | ★★★★★ | ❌ 需 Python + GPU（4~8 GB 显存） |
| ChatTTS | AGPL-3.0 + 权重 CC BY-NC | ~1 GB | 口语化最强 | ★★★★☆ | ❌ 许可证不适合 |

**选 Kokoro 的理由**：中文 8 个说话人（`zf_xiaobei / zf_xiaoni / zf_xiaoxiao / zf_xiaoyi` 女，
`zm_yunjian / zm_yunxi / zm_yunxia / zm_yunyang` 男）**天然满足「男/女」需求且可选**，
82M 参数在 CPU 上够快，Apache-2.0 可商用，全部资源都在 hf-mirror。

### 14.4 第一条线：现有引擎的小幅调整（不下载任何东西）

| 改动 | 依据（本机实测） | 预期收益 |
| --- | --- | --- |
| **SSML 标点停顿** | `SynthesizeSsmlToStreamAsync` 可用：加 0.7 s 停顿后音频 166,862 → 219,432 B | 有呼吸感，最直接减少「一口气念完」 |
| **常驻 PowerShell worker** | 单句合成仅 **8~12 ms**，而一次进程启动约 400 ms | 首音 0.6 s → **~0.15 s** |
| **按句流式播放** | 同上 | 不必等整段合成完，接话更快 |
| **对白/旁白分速** | 引号内台词 `rate=0.95`、旁白 `rate=1.08`；问句 `pitch` 微降 | 听感从「念」变「演」 |
| 数字/多音字 `<say-as>`、`<phoneme>` | SSML 支持 | 少念错（如「二〇二六」） |

**如实说明**：这一条线改善的是**节奏与呼吸**，音色本身的电子味消不掉；
按反馈的预期，收益「有限但便宜」，值得做，不能指望脱胎换骨。

### 14.5 第二条线：外挂引擎（Kokoro）

**体积实测（决定「打包」还是「下载」）**

| 组成 | 文件 | 大小 |
| --- | --- | --- |
| 运行时 | `sherpa-onnx-offline-tts.exe` | 1.76 MB |
| 运行时 | `onnxruntime.dll` | 13.55 MB |
| 模型 | `model.int8.onnx` | **108.91 MB** |
| 模型 | `voices.bin`（53 个说话人） | 26.89 MB |
| 模型 | `lexicon-us-en.txt` | 5.68 MB |
| 模型 | `lexicon-zh.txt` | 2.26 MB |
| 模型 | `tokens.txt` / `number-zh.fst` / `date-zh.fst` / `phone-zh.fst` | 0.20 MB |
| **合计** | | **≈ 159.3 MB** |

**结论：远超 100 MB，不能打包进 exe。** 仅 `model.int8.onnx` 一个文件就 108.9 MB，
即使把 `voices.bin` 裁剪到只保留 3 个说话人（约省 25 MB），总量仍有约 134 MB。
因此走**点击后下载**。

**目录约定**（在 **exe 同层**，不在 `data/` 内）：

```text
tts-engines/                        # 正式档与测试档共用，切换档位不必重下 144MB
└─ kokoro/
   ├─ runtime/
   │  ├─ sherpa-onnx-offline-tts.exe
   │  └─ onnxruntime.dll
   ├─ model.int8.onnx
   ├─ voices.bin
   ├─ tokens.txt
   ├─ lexicon-zh.txt
   ├─ lexicon-us-en.txt
   └─ number-zh.fst / date-zh.fst / phone-zh.fst
```

> 已 gitignore。运行时只保留 2 个文件（实测 15.3 MB 即可独立跑通），
> 不必带整套 53.7 MB 的 `bin/` + `lib/`。

**引擎抽象**（`src/tts/index.js` + `kokoro.js` / `synth.js`）：

```js
// 统一接口：返回 WAV Buffer
synthesize({ text, voice, rate, pitch }) -> { ok, wav, synthMs, reason? }
```

- `windows`：WinRT + PowerShell，**默认 + 兜底**
- `kokoro`：子进程调 `sherpa-onnx-offline-tts.exe`，用 `--sid` 选说话人
- 引擎目录缺失 / 调用失败 → **自动回退 `windows`**，只记一条日志，不打断朗读

**逐 NPC 音色模型**（`voice.json` 扩展，向后兼容）：

```json
{ "enabled": true, "engine": "kokoro", "voice": "zm_yunxi", "ssml": true, "rate": 1.0 }
```

原有 `gender: male/female` 保留：`engine=kokoro` 时映射到该 NPC 的 Kokoro 音色；
未设置时按性别取默认（男 `zm_yunxi`、女 `zf_xiaoxiao`）。

**下载器**（管理页，新增「语音引擎」区块）：

- 按「引擎 → 模型」两步下载，显示进度、速度、剩余时间
- 镜像顺序：**hf-mirror → ModelScope → GitHub**，失败自动换下一个并提示
- 断点续传（`Range`）；下载完校验 SHA-256（随清单内置）
- 全部走 Node 原生 `https`，**不引入 npm 依赖**
- 下载中允许继续游戏（后台进行），完成后按钮变「已就绪 / 试听」

### 14.6 交付分档

| 档位 | 玩家需要做什么 | 音色 | 体积 |
| --- | --- | --- | --- |
| **默认（开箱）** | 什么都不做 | Windows 内置：1 男 2 女（机械） | 0 |
| **Kokoro（已实装）** | 点一下下载（159 MB，实测约 3~5 分钟） | **晓晓 / 小艺（女）、云希（男）** | +159 MB |
| Piper（备选） | 点一下下载（约 82 MB） | 仅 1 个中文女声，无男声 | +82 MB |
| 真人级 | 自备 Python + 显卡 | IndexTTS2 / CosyVoice2 | 数 GB |

> 只有 Kokoro 同时满足「接近真人」与「有中文男声」，因此实装它；
> Piper 的中文模型 `chaowen` / `xiao_ya` 在本机实测**直接报错退出**
> （`"ai" is not a single codepoint`），实际只有 `huayan` 一个女声可用。

### 14.7 实施顺序

1. **第一步（本轮）**：引擎抽象层 + 现有实现迁入 `windows` 引擎（行为不变，先保证可插拔）
2. **第二步**：SSML 停顿 / 分速 / 常驻 worker / 按句流式（纯本地，无下载）
3. **第三步**：下载器（hf-mirror 优先、断点续传、校验）+ 管理页进度 UI
4. **第四步**：接入 Kokoro（选说话人、逐 NPC 音色、试听）
5. **第五步**：Piper 作为轻量备选；更新文档与验证记录

> **红线不变**：不引入运行时 npm 依赖、不改游戏请求链路、关窗即退、
> 引擎调用必须可超时可 kill（与现有 `synth.js` 同一套约束）。

### 14.8 明确不做

- IndexTTS2 / CosyVoice2 / ChatTTS：需 Python 或 GPU、或 AGPL/非商用权重，破坏便携与许可边界
- Windows 自然语音 hack（`NaturalVoiceSAPIAdapter`）：依赖提取系统密钥，随更新失效
- 云端 TTS：与「离线、免费、无 Key」的产品承诺冲突

---

## 15. 引擎实现与实测（0.19.0）

### 15.1 落地形态

| 项 | 值 |
| --- | --- |
| 默认引擎 | `windows`（系统 WinRT 语音），零下载、首音约 0.5 s |
| 可选引擎 | `kokoro`（sherpa-onnx + Kokoro-82M int8），开箱不用，玩家点一下下载 |
| 可选音色 | **晓晓（zf_xiaoxiao, 47, 女）· 小艺（zf_xiaoyi, 48, 女）· 云希（zm_yunxi, 50, 男）** |
| 下载体积 | **159.2 MB**（运行时 15.3 + 模型 143.9） |
| 安装位置 | exe 同层 `tts-engines/kokoro/`（正式档与测试档共用，切档不重下） |
| 实测下载 | **106 秒**（运行时走 GitHub 约 0.2 MB/s，模型走 hf-mirror 7~17 MB/s） |

### 15.2 为什么没打包进 exe

实测精确体积：`model.int8.onnx` 一个文件就 **108.91 MB**，总量 159.25 MB，
远超 100 MB 的门槛。即使把 `voices.bin` 的 53 个说话人裁到 3 个（省约 25 MB），
仍有约 134 MB。因此**运行时与模型全部按需下载**，exe 保持约 100 MB 不变。

### 15.3 下载器

- 镜像顺序：模型走 **hf-mirror**（HF 直连实测超时 10.7s，不可用）；
  运行时走 **GitHub → gh-proxy.com → ghproxy.net**
- **断点续传**（HTTP Range），换镜像时保留半截文件继续
- **逐文件 SHA-256 校验**，不匹配即删除重下
- 运行时只保留 `sherpa-onnx-offline-tts.exe` + `onnxruntime.dll` 两个文件
  （实测 15.3 MB 可独立跑通，不必带整套 53.7 MB 的 `bin/`+`lib/`）
- 全部 Node 原生 API + 系统自带 `tar`（Windows 的 bsdtar 支持 bz2），**零 npm 依赖**
- 后台下载，管理页每 800ms 轮询进度（含速度、剩余秒数），期间可继续游戏

### 15.4 速度与体验取舍（如实说明）

| 场景 | Windows 引擎 | Kokoro |
| --- | --- | --- |
| 模型加载 | 无 | 每次调用约 1.6 s |
| 24 字台词 | 0.45 s 出声 | **6.7 s 合成**（音频 3.7 s） |
| 首音延迟 | 约 0.5 s | 约 2~7 s |

Kokoro **比实时慢**（RTF≈1.3~1.7），因此：

- 默认仍是 `windows`；**装完不会自动切换**，玩家自己试听后决定；
- 长句等待明显，短句体验尚可；
- 已做单并发（1 个进程）避免互相拖慢，线程数默认 4（实测 8 无提升，16/32 更慢）。

### 15.5 回退与安全

- Kokoro 未安装 → 直接走 `windows`，不报错
- Kokoro 合成失败 / 超时（180 s）/ 模型缺失 → **自动回退 `windows`**，只记一条 `tts` 日志，玩家仍有声音
- 配置接口拒绝切到未安装的引擎（400 `engine_not_installed`）、拒绝未知音色（400）
- 关服时两个引擎的在飞子进程都会被 `kill`（`ttsShutdown()`），不拖住进程退出

### 15.6 验收记录（2026-11-12）

**安装器**：从零安装 → `installed: true`，实际体积 159.2 MB，用时 106 s，10 个文件全部通过 SHA-256。

**端到端 22 项全通过**：

| 组 | 覆盖 |
| --- | --- |
| 引擎状态 | `/api/tts/voices` 报告 `kokoro.installed=true`、3 个音色、`current=windows` |
| 配置校验 | 拒绝未知引擎（400）、拒绝未知 Kokoro 音色（400）、正常切换并持久化 |
| 朗读 | 走 Kokoro 成功返回 RIFF/WAV（179 KB，6.7 s）；切回 Windows 仍正常 |
| 日志 | 朗读成功仍**不进执行日志**（`tts` 记录 0 条） |
| 试听 | `engine=kokoro` 下 `zf_xiaoxiao` 与 `zf_xiaoyi` 输出不同（音色确实切换） |
| NPC 详情 | 返回 `engine` 与 `voiceResolved`；逐 NPC 指定 `zm_yunxi` 生效；未知音色 400 |
| 安装状态 | `/api/tts/install` 返回 `installed=true`、体积 > 150 MB |

**修复过的问题**：

| 问题 | 处理 |
| --- | --- |
| 运行时 tar 的字节数手写成 18,010,241（实际 18,893,451） | 长度校验永远失败、无限重试且进度累加到 51MB 卡住；改用 API 给出的精确值 |
| 镜像重试时进度重复累加 | 进度改为「已完成文件字节 + 本文件当前字节」，重试不再叠加 |
| 镜像不支持 Range 却按续传写 | 检测响应码：非 206 时强制从头写 |
| 两个引擎各自清理同一个临时目录 | 统一到 `src/tts/util.js` 的 `ensureTmpDir()`，全进程只清一次 |

---

## 16. 预置引擎与分发（0.19.0 收尾）

### 16.1 为什么预置

Kokoro 引擎 159 MB，下载对玩家是门槛（虽实测 106 秒，但依赖网络与镜像）。
既然要发 Steam 工坊，直接把引擎放进分发包，**玩家订阅后开箱即用，不需要任何下载**。

### 16.2 目录与流转

```text
<仓库根>/tts-engines/kokoro/          ← 开发者放一份（gitignore，159 MB）
        │  npm run dist:win 时自动同步（缺文件才复制，避免每次重拷）
        ▼
<仓库根>/releases/tts-engines/kokoro/ ← 与 exe 并排（便携版运行时查找位置）
        │  node workshop/publish.mjs 时整目录复制进内容包
        ▼
workshop/release/tts-engines/kokoro/  ← 工坊分发包
workshop/release/WorldApartNpcAgent-<ver>-win-portable.exe
```

Steam 订阅后玩家拿到：
```text
SteamLibrary\steamapps\workshop\content\4209920\<物品ID>\
├─ WorldApartNpcAgent-0.19.0-win-portable.exe
├─ tts-engines\kokoro\...      ← 引擎就在这里，程序启动直接识别
├─ README.txt
└─ LICENSE
```

### 16.3 启动即检测（不重复下载）

`kokoro.isInstalled()` 检查 `tts-engines/kokoro/` 下 **10 个文件是否都非空**：
8 个模型文件 + 运行时 `sherpa-onnx-offline-tts.exe` / `onnxruntime.dll`。

| 情形 | 行为 |
| --- | --- |
| 10 个文件齐备 | `kokoroInstalled=true`，**不发起任何下载**；`POST /api/tts/install` 直接返回 `alreadyInstalled` |
| 缺任一文件（含 0 字节） | 判定未安装，管理页显示「未安装 + 下载按钮」，运行时自动回退系统语音 |
| 引擎在但配置仍是 windows | 保持 windows（装完不自动切换，见 §15.4） |

启动横幅会打印一行：
```text
语音引擎 : 已就绪（Kokoro 159 MB，目录 ...\tts-engines\kokoro）
```
`/api/status` 与 `/api/tts/voices` 同步暴露 `engine` / `activeEngine` / `kokoroInstalled` / `bytes`。

### 16.4 工坊发布校验

`workshop/publish.mjs` 的 `validateContentDir()` 放行且**只放行**：
1 个 exe + `README.txt` + `LICENSE` + 可选的 `tts-engines/`。
若 `tts-engines/` 存在但缺文件，直接中止并列出缺失项 ——
避免把「半套引擎」发出去，让玩家误以为装好了却用不了。

体积上限从 100 MB 提到 400 MB（exe 95 + 引擎 159 ≈ 255 MB），
超过就说明混进了 `data/` 之类运行数据。

### 16.5 验收（2026-11-12）

| 项 | 结果 |
| --- | --- |
| 源码目录 `tts-engines/` | 10 个文件 / 159.2 MB |
| `npm run dist:win` 首次同步 | `复制语音引擎到 releases/tts-engines/（缺 10 个文件）` → `就绪 159.2 MB` |
| 再次打包 | `releases/tts-engines/ 已就绪，跳过复制`（不重拷） |
| 便携版启动 | `语音引擎 : 已就绪（Kokoro 159 MB…）`；`/api/status` → `kokoroInstalled=true` |
| 引擎已存在时 `POST /api/tts/install` | `alreadyInstalled=true`，未触发下载 |
| 删掉 `voices.bin` 后启动 | `kokoroInstalled=false`、`activeEngine=windows`、占用显示 132 MB（部分文件） |
| 恢复文件后 | `kokoroInstalled=true` |
| `node workshop/publish.mjs --pack-only` | `已预置语音引擎：tts-engines/（159.2 MB）`，内容总大小 **254.7 MB** |
| 工坊内容包结构 | exe 95.4 + `tts-engines/` 159.2 + README + LICENSE，引擎 10 个文件齐全 |

回归 **34 项全部通过**（模块级 14 + 端到端 20），含新增的
`engine-dir-outside-data`、`partial-not-installed`、`status-kokoro-installed`、
`install-noop-when-present`、`source-engine-exists`。

---

## 17. 引擎入库与 GitHub 体积限制（0.19.0）

### 17.1 硬限制

GitHub 对**单个文件**的限制（官方文档）：

| 阈值 | 行为 |
| --- | --- |
| > 50 MiB | 只是警告，push 仍成功 |
| **> 100 MiB** | **直接拒绝 push**（blocks） |
| 浏览器上传 | 单文件 ≤ 25 MiB |

我们的引擎总量 159.2 MB，单个最大文件 `model.int8.onnx` = 114,202,993 字节 = **108.91 MiB**
→ 超过 100 MiB，**普通 git 提交必然被拒**。

其余文件都没问题：
`voices.bin` 26.89、`onnxruntime.dll` 13.55、`lexicon-us-en.txt` 5.68、`lexicon-zh.txt` 2.26、
exe 1.76、三个 `.fst` < 0.1 MiB、`tokens.txt` < 1 KiB。

### 17.2 采用方案：分片入库（不用 Git LFS）

把模型切成 2 片（60 MiB + 48.91 MiB），全部 < 100 MiB：

```text
tts-engines/kokoro/model.int8.onnx.part00   62,914,560 B (60.00 MiB)   ← 入库
tts-engines/kokoro/model.int8.onnx.part01   51,288,433 B (48.91 MiB)   ← 入库
tts-engines/kokoro/model.int8.onnx         114,202,993 B (108.91 MiB)  ← .gitignore
```

- `scripts/split-tts-model.mjs`：换模型后重新切分。
- `src/tts/assemble.js` 的 `ensureModelAssembled(dir)`：完整文件不存在时按 `part00`→`part01`
  顺序拼接（先写 `.assembling` 再 rename，失败不留半个文件），幂等。
- 触发点：`isInstalled()` 首次调用（进程内只查一次）、`scripts/dist.mjs`、`workshop/publish.mjs`。
- `.gitattributes`：`tts-engines/** -text`，**禁用换行转换** ——
  否则 `lexicon-zh.txt` 等在 checkout 时被写成 CRLF，字节变化会导致 sha256 校验失败、分词异常。

**为什么不选 Git LFS**：LFS 免费额度是 1 GiB 存储 + 1 GiB/月流量，一次 clone 就吃掉 159 MB，
加上 CI 与多机开发很容易超；分片入库没有配额，clone/CI 都能直接拿到文件。

### 17.3 验证

| 项 | 结果 |
| --- | --- |
| 分片大小 | 60.00 / 48.91 MiB，均 < 100 MiB |
| 拼回结果 | 114,202,993 字节，与原文件一致 |
| 幂等 | 第二次调用 `assembled:false`，不重复写 |
| 入库文件最大 | 60.00 MiB（`part00`） |
| 完整模型是否入库 | 否（`git check-ignore` 命中 `.gitignore:6`） |
| 文本文件字节一致性 | `lexicon-zh` / `lexicon-us-en` / `tokens` 的 `git hash-object` 与索引 blob 完全一致 |
| 删掉完整模型后启动 | 自动拼回并打印 `已由分片拼回模型（108.9 MB）` |

---

## 18. 界面迭代记录

### 18.1 界面归位：引擎并入「音色」（0.19.0 修订）

**反馈**：引擎本来就属于语音朗读的一部分，它影响的是音色，不该单独占一张卡片。

**改法**：

- 删掉独立的「语音引擎」卡片；在「语音朗读」卡片内新增 **【音色】小节**，
  顺序为：音色引擎 → Kokoro 状态/下载 → 男声音色 → 女声音色 → 试听。
- **男/女声下拉随引擎切换**：`windows` 列系统中文语音，`kokoro` 列 Kokoro 说话人
  （晓晓 / 小艺 / 云希）。这正是「引擎只决定有哪些声音可选」的直观表达。
- 两套音色配置**互不覆盖**：Windows 存 `tts.voices.male/female`，
  Kokoro 存 `tts.kokoro.voiceMale/voiceFemale`；切换引擎后切回来仍是原来的选择。
- 引擎下拉文案随安装状态变化（未安装时显示「需下载约 162 MB」）；
  未安装时选 kokoro 会被拦下并回退到 windows。
- 删掉旧的 `#ttsKokoroFemale` / `#ttsKokoroMale` 与 `renderKokoroVoices()`、
  `renderVoiceOptions()`，统一为 `renderVoiceSelects()`（按 `currentEngine()` 填两组下拉）。
- 引擎值以 `/api/tts/voices` 的 `engines.configured` 为准回填，
  避免「配置是 kokoro 但引擎没装」时下拉与实际不符。

**实测**：

| 项 | 结果 |
| --- | --- |
| 实验功能页卡片数 | 3（多 NPC 共演 / 请求重写 / 语音朗读），引擎卡片已并入 |
| 卡片内元素顺序 | 自动朗读 → 朗读范围 → 【音色】→ 引擎 → Kokoro 状态 → 男/女声 → 试听 → 语速/音调/字数 → 音量/默认音色 |
| kokoro 下男/女声下拉 | `zm_yunxi` / `zf_xiaoxiao, zf_xiaoyi` |
| windows 下男/女声下拉 | 3 个系统语音，默认选中 `Microsoft Kangkang` / `Microsoft Huihui` |
| 切 windows → kokoro → windows | 每次下拉都正确换表并保留各自已选值；配置里两套并存 |
| 试听（kokoro 小艺） | 200，播放完成后正常复位 |
| NPC 记忆页 | Kokoro 专属音色下拉仍正常，显示「当前引擎：Kokoro 神经语音 · 当前音色：云希（男）」 |
| 浏览器控制台 | 无报错 |

**回归 35 项全通过**（模块级 9 + 端到端 26），含引擎切换后音频不同、
两套音色配置互不覆盖、非法值拒绝、静音 204 / 手动 200、安装幂等、tts 日志不进界面。


### 18.2 复查修复（0.19.1）

界面归位后做了一轮全量复查，修掉 3 个真实缺陷：

| # | 问题 | 现象 | 修复 |
| --- | --- | --- | --- |
| 1 | Kokoro 音色配置从前端拿不到 | `loadTtsEngines` 从 `/api/status` 读 `tts.kokoro.voiceMale/voiceFemale`，但该接口**没有这两项** → 每次重载页面 Kokoro 音色都回退成第一个（存的小艺显示成晓晓） | `/api/tts/voices` 的 `engines.kokoro` 增加 `voiceMale/voiceFemale/threads`，前端改从该接口读取 |
| 2 | 首屏并发竞态 | `loadConfig()` 可能在 `loadStatus()` 之前完成，此时 `statusCache` 为空被判为"未安装"，把引擎下拉**强制重置为 windows**，覆盖掉 `loadTtsEngines` 已设好的 kokoro | 只有**确认未安装**时才降级；未知状态下忠实显示配置值（后端本就会自动回退） |
| 3 | 切页重复枚举系统语音 | `ttsVoicesLoaded` 只写不读，每次切到「实验功能」都重新起 PowerShell 枚举（约 0.4s） | `loadTtsEngines` 增加 `if (ttsVoicesLoaded && !force) return`，命中时只重填下拉 |
| 4 | NPC 页拿不到 Kokoro 音色清单 | 没先打开「实验功能」就直接进 NPC 页时，`ttsKokoro.voices` 为空 → 专属音色下拉不显示 | `loadNpcDetail` 在清单未加载时先 `await loadTtsEngines()`；切到 NPC tab 时也触发一次 |

另外清理：`install.js` 未使用的 `MODEL_FILES` 导入。

**复查后回归 34 项全通过**，新增覆盖：
`voices-kokoro-voice-saved`（重载后音色不回退）、`save-windows-only`（保存一套不影响另一套）、
`kokoro-kept` / `windows-voices-kept`（切引擎后两套配置各自保留）。

浏览器实测：重载后引擎显示 `kokoro`、女声 `zf_xiaoyi`、男声 `zm_yunxi` 与配置一致；
直接进 NPC 页也能看到「Kokoro 专属音色」下拉；控制台无报错；全站无重复 id。
