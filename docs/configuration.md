# 配置项

> 配置存放于 `data/config.json`（正式档）或 `data_test/config.json`（测试档），也可在管理页编辑；保存即时生效（`server.port` 等需重启）。
> 与记忆语义相关的规则见 [memory-rules.md](memory-rules.md)。

| 字段 | 说明 |
| --- | --- |
| `server.host/port/apiKey/servedModel` | 本地监听与游戏侧凭证（改端口需重启）。**端口被占用时启动会自动向后顺延**（8790→8809 内找空闲端口），把实际端口写回 `config.json` 并在管理页提示改游戏 Base URL；不会自动切回 8790 |
| `upstream.baseUrl/apiKey/model` | 真实 Provider；baseUrl 带不带 `/v1` 均可 |
| `upstream.disableThinking` | 默认 `false`：**不干涉上游思考**，与游戏裸模型行为一致。设为 `true` 才会补 `thinking:{type:"disabled"}`（更低延迟，但会削弱对复杂 system 规则的遵从）；无论开关如何，调用方显式带 `thinking` 时都不覆盖 |
| `upstream.includeUsage` | 默认 `false`：流式请求不主动注入 `stream_options.include_usage`，避免多出的 `choices: []` 汇总 chunk 影响游戏端解析。开启后每轮可拿到精确 token 总数（执行日志仍只显示总数）；关闭时按字符估算并标 `≈` |
| `upstream.connectTimeoutMs/requestTimeoutMs` | 建立连接超时（默认 `15000`）/ 请求总超时兼流式空闲超时（默认 `300000`）。管理页「上游 Provider」可直接改，慢速 Provider（如 GLM）可调大；若游戏端自己先超时，调大这里无效 |
| `memory.enabled` | 记忆总开关；关闭等同纯透传 |
| `memory.injectMaxChars` | 注入长期记忆字符上限（默认 5600，= 记忆上限 + 200；比上限小会出现「写得进、注入不到」）。超出时**按分区优先级裁剪**：【赠予往来】→【同场】→【习惯与忌讳】→【经历与进度】→【未了之事】→【关系】→【身份与称呼】，身份与关系最后才动；裁剪只影响注入，不改磁盘文件 |
| `memory.snapshotSystem` | system 内容变化时存档原文。**只对设置类内容变化建档**：`【好感变化】`/`【赠出礼物】`/`【任务交付】` 等每轮结算事实不计入哈希，避免每轮都写一份 20KB+ 快照 |
| `memory.summarizer.everyTurns` | 每多少轮异步压缩一次（默认 4） |
| `memory.summarizer.idleFlushEnabled/idleFlushMs` | 空闲兜底：默认开；`idleFlushMs` 默认 5 分钟无请求即视为本段会话结束并补压（扫描周期固定 5 秒，不做配置项以免"改了不生效"） |
| `memory.summarizer.recentEntries/maxMemoryChars/maxTokens/timeoutMs/overLimitRetries` | 单次最多消费的新对话条数（默认 60，**摘要窗口已按行号水位切片**，这只是异常保护上限）/ 记忆字数上限（5000）/ 摘要调用 max_tokens（4000）/ 超时（120s）/ 超限重试次数（2，0~3） |
| `prompts.enabled` | 外置设定提示词总开关（默认 `true`）；关闭后全局与逐 NPC 提示都不注入 |
| `prompts.global` | 全局提示词（对所有 NPC 生效，留空不注入；上限 4000 字）。逐 NPC 个人提示与「是否叠加全局」存于 `data/npcs/<slug>/prompt.json`。旧键 `style` 会在启动时自动迁移为 `prompts` |
| `requestRewrite.enabled` | **实验性**请求重写总开关（默认 `false`）。每轮 NPC 对话额外调用一次上游，逐条改写**设定类** system 模块（世界观/场景/任务/输出格式等）；`【相关经历】`/`【人物关系】`/`【任务接取】`/`【任务交付】`/`【好感变化】` 等游戏事实模块**原样透传**。额外 token 消耗与首字延迟明显增加 |
| `requestRewrite.maxTokens/timeoutMs/temperature` | 重写调用参数：输出上限 6000（按模块总字数自动上调，最高 20000）/ 超时 60s / 温度 0.2；内部调用恒定 `thinking:{type:"disabled"}` |
| `requestRewrite.cache.mode/maxEntries/ttlDays` | 重写缓存机制（默认 `none` / 全局 1000 条 / 7 天）。`none` = 不启用；`exact` = **机制 1「模块级指纹缓存」**：按**单个 system 模块**（模块原文 + NPC + 外置设定/记忆 + 模型参数 + 上游地址）复用上次**已校验通过**的草稿，只有变化的模块才送去重写，全部命中时不调用上游（token 记 0）；校验不过的模块/条目下次重试。每个机制单独一个全局文件 `data/rewrite-cache-<mode>.json`；后续机制在 `REWRITE_CACHE_MODES` 登记。0.12.x 的布尔 `enabled` 启动时自动迁移为 `mode`，0.13.x 的逐 NPC 整轮缓存启动时直接清理 |
| `multiNpc.enabled` | **实验性**多 NPC 共演总开关（默认 `false`）。关闭时请求体与输出逐字节不变 |
| `multiNpc.maxCoStars/maxCallsPerTurn` | 同场配角上限（默认 1）/ 一轮最多几次 NPC 发言调用（默认 2；1 = 只跑主角） |
| `multiNpc.speakPolicy/outputStyle/allowASilence` | 配角开口策略 `addressed/always` / 多人输出格式 `script/inherit` / 允许主角只给在旁反应 |
| `multiNpc.coStarWritesMemory` | 配角是否写入自己的长期记忆（默认 `false`） |
| `multiNpc.autoStage` | **是否允许按台词自动进场/离场**（默认 `false`）。关闭时只认 `/invite`、`/add`、`/leave`、`/remove`，台词只作叙事事实；开启后才按括号动作/直呼其名调度 |
| `multiNpc.transcriptTurns/skipOnTask/autoExitIdleMs` | 共享对话条数（8）/ **真任务轮**退化单人戏（`## 任务：X` 的标题既不是“闲聊”也不是“话题闲聊”时才算；`本次话题`/`收尾判定` 属于话题闲聊，不退化）/ 超时清场（默认 **120 分钟**，管理页按分钟填写） |
| `multiNpc.actorTailWaitMs/actorMaxTokens/actorTimeoutMs` | 主角先说完时等待配角的上限（3s）/ 配角输出上限（300 tokens）/ 配角调用超时（20s） |
| `tts.enabled` | **实验性**语音朗读总开关（默认 `false`）。开启后管理页对每条新到的 NPC 回复自动调用系统语音朗读。**关闭时不合成、不启动任何子进程**；历史回复不补播（日志里点 ▶ 可手动朗读）。声音由管理页播放，关窗即停 |
| `tts.engine` | 音色引擎：`windows`（默认，系统自带语音，零下载、首音约 0.5s）/ `kokoro`（离线神经语音，需下载约 159MB，接近真人但**合成比播放慢**）。**它只决定"有哪些声音可选"**，因此在界面上位于「语音朗读 → 音色」小节内。`kokoro` 未安装或调用失败时**自动回退 `windows`**；切换到未安装的 `kokoro` 会被配置接口拒绝（400 `engine_not_installed`） |
| `tts.kokoro.voiceFemale` / `tts.kokoro.voiceMale` | Kokoro 女/男音色，只接受 `zf_xiaoxiao`（晓晓）/ `zf_xiaoyi`（小艺）/ `zm_yunxi`（云希），其它值返 400。逐 NPC 可在「NPC 记忆」页覆盖。与 `tts.voices.*`（Windows 音色）**各自独立**，切换引擎不会互相覆盖 |
| `tts.kokoro.threads` | Kokoro 合成线程数（默认 4，范围 1~8）。实测 4 最优：8 无提升，16/32 反而更慢 |
| `tts.readMode` | `all` 全部内容（含旁白）/ `dialogue` 只读引号内的对白；`dialogue` 抽不到引号时自动回退 `all` 并在界面提示 |
| `tts.skipActions` | `all` 模式下是否跳过 `（…）`/`(…)` 动作描写（默认 `true`）。2026-11 游戏契约已改为 `content` 只写台词，该开关主要服务于旧日志与自建提示词场景 |
| `tts.voices.male` / `tts.voices.female` | 全局男 / 女音色名（默认 `Microsoft Kangkang` / `Microsoft Huihui`）。取不到时回退到系统第一个同性别中文语音 |
| `tts.defaultGender` | 性别判定失败时用哪个音色（`female`/`male`，默认 `female`） |
| `tts.rate` / `tts.pitch` | 合成语速（0.5~3）/ 音调（0.5~2），默认 1.0；逐 NPC 可覆盖 |
| `tts.volume` | **播放音量**（0~1，默认 0.8）：只在页面 `<audio>.volume` 生效，不参与合成、不进缓存 |
| `tts.maxChars` | 单条朗读字数上限（默认 600）；超出按句切，不切半个词 |

> **`maxMemoryChars` 必须与 `maxTokens` 匹配（重要）**：实测中文约 **1.4 汉字/token**，
> 故有效上限 ≈ `maxTokens × 1.4`。上限若超过这个值，模型物理上写不出那么长——
> **调大 `maxMemoryChars` 不会让记忆变长**，只会让每次摘要都触发截断。默认 5000 / 4000 是匹配的
> （4000 × 1.4 = 5600，留有余量）。
>
> 程序会在运行时取 `min(maxMemoryChars, floor(maxTokens × 1.4))` 作为真实上限，
> 并把 `injectMaxChars` 抬到至少「真实上限 + 200」；管理页在两者不匹配时显示黄字提示。
> 配置加载时还会**只把仍是老默认值的项**升级到新默认（见上表），玩家自定义过的值不会被改。
