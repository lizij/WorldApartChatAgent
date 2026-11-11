# 管理接口与日志字段

> 从 AGENTS.md §5 抽离。管理接口只接受本机访问、无需游戏 Key；游戏侧接口需 API Key。

- `GET /api/status`：连接信息（`baseUrl` 反映**实际监听端口**，另给 `port`）、上游状态、记忆/提示词开关、请求重写开关
- `GET/PUT /api/config`：查看/保存配置（上游 Key 掩码显示，留空不修改；保存即时生效；含 `prompts.enabled/global`、`requestRewrite.*`）
- `GET /api/events`：SSE，实时推送每条运行日志
- `GET /api/logs?limit=`：最近日志（接口按时间正序返回；管理页展示时按时间倒序，最新在上）
- `GET /api/logs/:rid/detail`：按日志的 `rid` 读取请求详情（完整 messages、reasoning、reply、usage；开启重写时含原始/重写后 system 与 diff；主日志只带 `hasDetail` 与 token 总数）
- `GET /api/npcs`、`GET /api/npcs/:slug`：NPC 名录、长期记忆、个人提示词与最近对话（含 `stage`、`aliases`、`hasIntake`、`castEnabled`、`voiceEnabled`；详情另带 `voice` 与 `voiceResolved:{gender,voiceName,reason}`）
- `GET/DELETE /api/npcs/:slug/stage`：查看 / 清空该 NPC 的共演在场状态
- `PUT /api/npcs/:slug/aliases`：保存别名（`{names: string[]}`，≤20 条、每条 ≤20 字），用于识别玩家点名
- `GET/PUT /api/npcs/:slug/cast`：查看 / 设置该 NPC 是否允许作为配角（`{enabled:boolean}`，默认关闭；无 intake 时拒绝启用）
- `PUT /api/npcs/:slug/prompt`：保存该 NPC 个人提示词（`{useGlobal,text}`；text 上限 4000 字，空文本且叠加全局时即删除 prompt.json）。旧路由 `PUT /api/npcs/:slug/style` 保留为兼容别名
- `POST /api/npcs/:slug/memory/rewrite`：按玩家一次性指令（`{prompt}`，上限 4000 字）用上游模型改写该 NPC 长期记忆，返回草稿 `{original,draft}`（**不落盘**；上游未配 Key 返 503）
- `PUT /api/npcs/:slug/memory`：用草稿（`{text}`）覆盖该 NPC `memory.md`；覆盖前按时间戳备份到 `npcs/<slug>/backups/`，返回备份文件名
- `GET /api/tts/voices`：系统中文语音清单 + 引擎状态（`{ok, voices, suggested, engines:{current, configured, kokoro:{installed, bytes, downloadBytes, voices, state}}, hint}`）。枚举要起一次 PowerShell，后端缓存 10 分钟；`?refresh=1` 强制刷新
- `POST /api/tts/install`：开始下载 Kokoro 引擎（运行时 + 模型，约 159MB）。**立即返回**，下载在后台进行；重复调用会返回 `already_running` 或 `alreadyInstalled`
- `GET /api/tts/install`：安装状态与进度 `{installed, bytes, downloadBytes, state:{running, step, doneBytes, totalBytes, speedBps, error}}`，管理页每 800ms 轮询
- `GET /api/tts/audio/:rid?mode=all|dialogue&auto=1&slug=<slug>`：按日志 `rid` 朗读该条 NPC 回复，返回 `audio/wav`。只接受 **NPC 对话**的详情（其它记录返 400 `not_npc_reply`）；`mode` 省略时用配置 `readMode`；`auto=1` 时该 NPC 已静音则返 **204**（手动播放不带 `auto`，不受任何静音开关影响）；详情过期返 404 `detail_not_found`；无文字可读返 400 `empty_text`/`not_plain_text`
- `POST /api/tts/preview`：试听，`{text?, engine?, gender, voice?, rate?, pitch?}` → `audio/wav`。`engine=kokoro` 时 `voice` 是 Kokoro 音色名（`zf_xiaoxiao` 等），否则是系统语音名；`text` 缺省用内置示例句，上限受 `tts.maxChars` 约束
- `PUT /api/npcs/:slug/voice`：保存逐 NPC 语音设置 `{enabled, gender:'auto'|'male'|'female', rate, pitch, voice}`（`rate`/`pitch` 传 `null` 表示跟随全局；`voice` 是 Kokoro 音色名，只接受清单内的值，否则 400）；全默认值时不落盘，删除 `voice.json`
- 游戏侧：`POST /v1/chat/completions`、`GET /v1/models`（需 API Key）；`GET /health` 免鉴权

日志记录包含：类型、slug、sessionId、玩家发言摘要、回复预览、首字节/内容首字/总耗时、
注入字符数、外置提示词字符数、请求重写状态与额外 token、是否新建档、warnings、上游状态；回复非 JSON 时在 NPC 页标 ⚠。

请求重写（`rewrite`）额外字段：

- `skippedFacts`：原样透传、未参与重写的游戏事实模块数（`【相关经历】`/`【任务交付】`/`【好感变化】` 等）。
- `cachedModules`：命中模块级缓存的模块数；`cacheHit` 只在**全部模块命中**时为 `true`。
- `changedModules` / `repairedModules` / `failedModules` / `droppedModules`：改写/修复/失败/整模块删除数量。
  `repairedModules` 不再把「补回枚举后与原文等价」的 noop 计入。
- `warnings` 新增 `reply_not_json_stream`：流式回复不是合法 JSON（已逐字节发出，无法回改），
  与非流式的 `reply_not_json` 区分；另有 `rewrite_skipped:mixed_fact_module`：某条消息把事实块
  与 `## 设定` 混在一起，已整条透传（该设定本轮不会被改写）。
- `notes` 的 `reply_wrapped_json`：非流式纯文本回复已按当轮模板包成 JSON（中性提示，不标红）。

语音朗读（`kind:"tts"`）字段：`slug` / `mode`（`all`/`dialogue`）/ `chars` / `voice` /
`gender` / `auto` / `synthMs` / `cached` / `bytes` / `action`（`preview` 表示试听）/
`status` / `error`。错误码：`tts_no_voice`、`tts_timeout`、`tts_powershell_failed`、
`tts_empty_text`、`tts_empty_audio`、`tts_stopping`。**日志里不记录台词正文**。

> **语音朗读的成功记录只落盘（带 `uiHidden:true`），不会出现在执行日志里**：
> 朗读是高频动作，每播一条记一条会刷屏并把环形缓冲里真正的对话记录挤掉。
> 失败记录（`status:"error"`）仍会显示在「仅异常」里。落盘记录可直接
> `grep '"kind":"tts"' data*/logs/<日期>.jsonl` 查看。

> **日志码与界面文案**：日志文件（`logs/YYYY-MM-DD.jsonl`）里 `kind` / `status` / `warnings` /
> `rewrite.error` 一律写**英文码**（如 `cast_stage_cleared:idle`、`memory_over_limit:3266>3000`），
> 便于 grep 与逐版本比对；管理页只负责翻译——中文说明在前，英文原码以小号灰字附在后面
> （悬停日志类型徽章也能看到原码）。新增码时在 `public/app.js` 的 `KIND_LABELS` /
> `STATUS_LABELS` / `REWRITE_ERROR_LABELS` / `ERROR_TEXT_LABELS` / `warningLabel()` 里补一条中文；
> **没登记的新码会自动退化为只显示原码**，不会空白，也不会挡住功能。
