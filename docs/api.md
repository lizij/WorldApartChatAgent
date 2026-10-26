# 管理接口与日志字段

> 从 AGENTS.md §5 抽离。管理接口只接受本机访问、无需游戏 Key；游戏侧接口需 API Key。

- `GET /api/status`：连接信息、上游状态、记忆/提示词开关、请求重写开关
- `GET/PUT /api/config`：查看/保存配置（上游 Key 掩码显示，留空不修改；保存即时生效；含 `prompts.enabled/global`、`requestRewrite.*`）
- `GET /api/events`：SSE，实时推送每条运行日志
- `GET /api/logs?limit=`：最近日志（接口按时间正序返回；管理页展示时按时间倒序，最新在上）
- `GET /api/logs/:rid/detail`：按日志的 `rid` 读取请求详情（完整 messages、reasoning、reply、usage；开启重写时含原始/重写后 system 与 diff；主日志只带 `hasDetail` 与 token 总数）
- `GET /api/npcs`、`GET /api/npcs/:slug`：NPC 名录、长期记忆、个人提示词与最近对话（含 `stage`、`aliases`、`hasIntake`、`castEnabled`）
- `GET/DELETE /api/npcs/:slug/stage`：查看 / 清空该 NPC 的共演在场状态
- `PUT /api/npcs/:slug/aliases`：保存别名（`{names: string[]}`，≤20 条、每条 ≤20 字），用于识别玩家点名
- `GET/PUT /api/npcs/:slug/cast`：查看 / 设置该 NPC 是否允许作为配角（`{enabled:boolean}`，默认关闭；无 intake 时拒绝启用）
- `PUT /api/npcs/:slug/prompt`：保存该 NPC 个人提示词（`{useGlobal,text}`；text 上限 4000 字，空文本且叠加全局时即删除 prompt.json）。旧路由 `PUT /api/npcs/:slug/style` 保留为兼容别名
- `POST /api/npcs/:slug/memory/rewrite`：按玩家一次性指令（`{prompt}`，上限 4000 字）用上游模型改写该 NPC 长期记忆，返回草稿 `{original,draft}`（**不落盘**；上游未配 Key 返 503）
- `PUT /api/npcs/:slug/memory`：用草稿（`{text}`）覆盖该 NPC `memory.md`；覆盖前按时间戳备份到 `npcs/<slug>/backups/`，返回备份文件名
- 游戏侧：`POST /v1/chat/completions`、`GET /v1/models`（需 API Key）；`GET /health` 免鉴权

日志记录包含：类型、slug、sessionId、玩家发言摘要、回复预览、首字节/内容首字/总耗时、
注入字符数、外置提示词字符数、请求重写状态与额外 token、是否新建档、warnings、上游状态；回复非 JSON 时在 NPC 页标 ⚠。

> **日志码与界面文案**：日志文件（`logs/YYYY-MM-DD.jsonl`）里 `kind` / `status` / `warnings` /
> `rewrite.error` 一律写**英文码**（如 `cast_stage_cleared:idle`、`memory_over_limit:3266>3000`），
> 便于 grep 与逐版本比对；管理页只负责翻译——中文说明在前，英文原码以小号灰字附在后面
> （悬停日志类型徽章也能看到原码）。新增码时在 `public/app.js` 的 `KIND_LABELS` /
> `STATUS_LABELS` / `REWRITE_ERROR_LABELS` / `ERROR_TEXT_LABELS` / `warningLabel()` 里补一条中文；
> **没登记的新码会自动退化为只显示原码**，不会空白，也不会挡住功能。
