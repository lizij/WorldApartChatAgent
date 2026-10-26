# AGENTS.md — 《不问凡尘》外置 AI NPC 对话 Agent

一个 **Windows 桌面程序**：双击 portable exe 即在本进程内启动本地 OpenAI 兼容服务并打开管理窗口；
游戏把 NPC 对话请求发到本程序，本程序转发给真实 Provider（默认 deepseek-flash），
并为每个 NPC 维护**互相隔离的长期记忆**。关窗即完全退出，无后台残留。

不使用任何通用 agent 工具：身份识别、记忆注入、落盘、摘要全部是确定性代码，
模型每轮只做一次直出回复，真流式返回，响应速度与裸模型一致。

**版本号**：标准 semver 三位，**单一来源是 `package.json`**（禁止别处手写）；按
「破坏性变更→MAJOR / 新功能→MINOR / 修复·文档→PATCH」**每次有效交付递增一次**，
自动展示在 Electron 窗口标题、管理页顶部与启动横幅。完整规约见
[docs/contributing.md](docs/contributing.md)（版本号 / 代码约束 / 红线，改本项目前先读）。

---

## 0. 文档路由

| 我要做什么 | 看哪个文件 |
| --- | --- |
| 了解产品形态、运行原理与使用 | 本文件 §1–§2 |
| 改版本号 / 代码约束 / 提交前红线 | [docs/contributing.md](docs/contributing.md) |
| 开发 / 测试 / 打包 / 提交发布全流程 | [docs/dev-workflow.md](docs/dev-workflow.md) |
| 配置项（全部键、默认值与注意点） | [docs/configuration.md](docs/configuration.md) |
| NPC 识别、注入优先级与记忆摘要规则 | [docs/memory-rules.md](docs/memory-rules.md) |
| 管理接口与日志字段 | [docs/api.md](docs/api.md) |
| 历史验证证据、缺陷复盘与排障 | [docs/verification-log.md](docs/verification-log.md) |
| 目录结构、构建产物与文件职责 | 本文件 §3 |

---

## 1. 运行原理

```
游戏（NPC 对话，OpenAI 协议 /v1/chat/completions，SSE 流式）
   │  system（世界观/角色设定/当前场景/输出格式）+ 玩家发言
   ▼
本程序（127.0.0.1:8790，单进程：Electron 窗口 + 内嵌 HTTP 服务）
   ① Key 鉴权
   ② 确定性分类：NPC 对话 / 对话记忆压缩器 / 探测
   ③ NPC 对话：正则解析「## 角色设定 你是 XXX」→ 稳定 slug + sessionId
   ④ 读 data/npcs/<slug>/memory.md 与该 NPC 的 prompt.json，准备 system 注入
      （长期记忆 + 外置设定提示词；提示词独立于记忆开关，插在记忆之后、输出格式提醒之前）
   ④.5 【可选·实验性】请求重写：开启时先额外调用一次上游，逐条改写游戏下发的
      **全部 system 模块**，删除或改写与外置提示词/记忆冲突的描述
      （`## 输出格式` 逐字保留；单模块失败自动回退该模块原文）
   ⑤ 模型名映射（默认不干涉思考）+ 输出格式强化提醒 → 转发上游
   ⑥ SSE 真流式原样回传游戏（不缓冲），旁路 Tee 解析回复文本、思维链与 usage
   ⑦ 响应结束后异步（不阻塞玩家）：
      - conversations.jsonl 追加 player/npc 两条
      - state.json 更新（轮次、最近游戏状态）
      - 每 N 轮一次非流式短调用，合并压缩重写 memory.md
      - 空闲兜底：该 NPC 空闲超时且记忆仍有落后轮次时补压一次（后台每 5s 扫描）
   ▼
真实 Provider（默认 https://api.deepseek.com → deepseek-flash）
```

### 关键设计点

- **快**：回复路径只有一次模型调用、真流式直通；异步摘要在回复结束后才发生。
  默认（不干涉思考）内容首字约 **3~5s**（reasoning 占 1000 字上下）；若把
  `upstream.disableThinking` 设为 `true` 可降到约 0.6~1.8s，但会牺牲规则遵从（见下一条）。
- **思考链：默认不干涉**。游戏原始请求**从不带** `thinking`/`reasoning_effort`（351 条历史请求实测为 0），
  因此转发时也不注入，让上游用默认行为（deepseek-flash 默认开思考）。
  **不要**为了压延迟而默认禁用思考：实测同一 system 下，禁用思考会让 NPC 忽略
  游戏在 system 里下发的复杂约束（世界观规则等），只按眼前一句话回复；开启思考才与裸模型一致。
  确需低延迟时再开 `upstream.disableThinking`。
- **回复格式兜底**：游戏侧多为 `stream:false`。模型偶发违约——把整段游戏 JSON 又塞进 `content`（双层 JSON）、
  `content` 里写了未转义的双引号、或输出被截断——这会让游戏把原始 JSON 当正文显示。
  非流式回包会先做确定性修复（`src/replyRepair.js`）再返回，日志记 `reply_repaired`；
  流式已逐字节发出，无法回改，只能记账。
- **隔离**：请求间无状态，每个 NPC 独立 slug / sessionId / 数据目录，不存在会话串扰。
- **外置设定提示词**：玩家可设**全局提示词**（对所有 NPC 生效）与**逐 NPC 个人提示词**
  （`data/npcs/<slug>/prompt.json = {useGlobal, text}`，兼容旧版 `style.json` 并自动迁移）。
  二者合为一条 system，插在最后一条 user 前（记忆之后、输出格式提醒之前），
  **独立于记忆开关**，首轮即生效。内容不限于说话风格，可写人物设定、世界观、口吻、
  称谓、尺度、长度、禁忌、剧情走向等一切方面。逐 NPC 可勾选"不叠加全局"。
  全局与逐 NPC 各限 4000 字。
- **优先级（重要）**：唯一不可覆盖的技术底线是**本轮 JSON 输出格式 / 必需字段 / 枚举取值**
  （否则游戏无法解析）；其下依次为 **全局/个人提示词 > 长期记忆 > 游戏下发的全部内容**
  （含角色设定、角色背景、世界观、表演尺度、时间地点场景）。注入文案与位置共同声明该层级。
- **多 NPC 共演（实验性，默认关闭）**：玩家用括号把另一位**已有档案与 intake** 的 NPC 拉进
  当前对话（`（章籽梦走进来）`、`章籽梦，你怎么看`、`（章籽梦离开了）`）。配角走**独立请求**：
  用 B 自己的 intake 角色卡、B 的长期记忆、本工具账本里的共享对话、双方提示词构造；
  主角的请求里只有“B 在场”与 B 的公开台词，**拿不到 B 的设定、记忆与心里活动**。
  一轮最多 2 次**发言调用**：谁被点名谁先跑，后者看到前者输出再生成；超出预算的反应
  顺延到玩家下一轮。B 的台词由系统插入 A 回复的 `content` 字符串内部（JSON 转义），
  仍是单条 JSON、真流式（只对插入点做局部缓冲）。**B 先跑失败 → 整轮作废、不落盘**；
  A 先说完后 B 失败 → B 缺席，不写任何“未接话”叙事。B 不产出 `emotion/control/intent`，
  不参与游戏结算，也不得声称赠物、交易、关系或任务结果。B 写自己的记忆默认关闭。
  共演开启时请求重写同样覆盖 B 的世界规则与角色卡（姓名/身份硬校验，失败只回退 B）。
  **每个 NPC 需单独开启**（`data/npcs/<slug>/cast.json={enabled:true}`，默认关闭）：
  未开启的 NPC 不参与任何共演判定，括号里的名字/台词只作为事实与导演指令。
  调试可用显式指令 `/invite 名字`、`/add 名字`（入场）与 `/leave 名字`、`/remove 名字`（离场）
  （始终生效，优先于台词，remove/leave 优先，指令会从
  发给模型的玩家文本里剥离；剥离后为空时模型看到“（玩家没有开口）”）。
- **请求重写（实验性，默认关闭）**：开启后，NPC 对话在注入之前先额外调用一次上游，
  **逐条重写游戏下发的全部 system 模块**（真实请求通常拆成多条，且可能与历史消息交错），
  删除/改写与外置提示词、长期记忆冲突的描述；任一模块中 `## 输出格式` 里的 **JSON 结构**
  必须逐字保留（标题下的规则说明允许被删改，游戏会把「最高优先级规则」也塞在该标题下）。
  每模块独立校验（输出格式结构一致、长度 30%~150%；非 `## 输出格式` 模块允许整模块删空，
  删空即从请求里移除该条 system），失败只回退该模块；
  枚举漏值/字段缺失会先用原 schema 自动补回（结构被改则仍判失败）；解析失败、
  上游报错或客户端断开时全部回退原文，不影响游戏请求。每轮多一次**接近整个 system 体量**
  的输入+输出，首字延迟与 token 消耗明显高于单模块版本；不做缓存。
- **执行日志详情**：每条请求可在管理页点击展开，查看最终发送给上游的完整 messages
  （标注游戏原始 / 游戏重写后 / 外置记忆 / 外置提示词 / 格式提醒 / 历史对话 / 玩家本轮）、思维链、
  完整回复与 token 总数；开启请求重写时另有「请求重写」区块（原始/重写后 system、
  行级增删、耗时、额外 token）。主日志只保留轻量摘要。请求详情落盘到
  `logs/details/YYYY-MM-DD.jsonl`，保留 14 天；内存只缓存最近 100 条，更早的按 `rid`
  从磁盘读取。流式精确 token 需开启 `upstream.includeUsage`（默认关闭），否则按字符估算
  并在界面标 `≈`。
- **降级**：记忆层任何异常都退化为纯透传（warnings 落日志）；摘要失败只记日志；
  上游错误返回标准错误 JSON。

---

## 2. 使用

### 普通使用（portable exe）

双击 `releases/WorldApartNpcAgent-<version>-win-portable.exe`：

- 自动在 **exe 同级 `data/`** 写配置/记忆/日志；首次启动自动生成 API Key。
- 窗口打开管理页，顶部 5 个 tab：**概览**（游戏连接信息 + 上游 Provider）、**记忆与提示词**、
  **实验功能**（多 NPC 共演 + 请求重写）、**执行日志**、**NPC 记忆**（保存均即时生效）。
  停留的 tab 会记在本地（`localStorage` + `#hash`），刷新后回到上次页面，也可直接用 `#labs`、`#npcs` 等直达。
- 游戏中填写页面顶部三项：Base URL（`http://127.0.0.1:8790/v1`）、API Key、Model ID
  （任意模型名都会被映射到配置的上游模型）。
- 重复双击只聚焦已开窗口（单实例）；关窗即退出。

**测试档（同一 exe，数据隔离）**

- 启动时带 `--test` 参数（或设环境变量 `WFC_TEST=1`）→ 数据目录改用 exe 同级 **`data_test/`**；
  不带参数 → 正式档 `data/`。两档**完全隔离**：各有独立的 `config.json`（各自 API Key）、
  `npcs/`（NPC 记忆与会话历史）、`logs/`，互不影响。
- 标题栏与管理页概览会显示 `[测试档]` 标识，概览页「数据目录」一栏可确认当前落在哪个目录。
- 同一时间只有一个实例（单实例锁），所以先关掉正式档再启动测试档。

### 开发

> 环境要求、启动命令、本地验证方式、打包出包、提交与 CI 发布的完整流程，统一见
> [docs/dev-workflow.md](docs/dev-workflow.md)。本节只保留速查：
>
> - `npm start` / `npm run start:test` / `npm run dev:desktop` / `npm run dist:win`
> - 调试一律用测试档 `data_test/`，禁止污染正式档 `data/`
> - 国内网络/沙箱打包前必须设 electron 与 electron-builder 的镜像变量（详见该文 §3）

### 配置项（`data/config.json` 或 `data_test/config.json`，也可在页面编辑）

> 全部键、默认值与注意点见 [docs/configuration.md](docs/configuration.md)。页面保存即时生效（端口类需重启）。
>
> 三条最容易踩的：`upstream.disableThinking` 默认 `false`（不干涉思考，开思考才与裸模型一致）；`maxMemoryChars` 必须与 `maxTokens` 匹配（中文约 1.4 汉字/token，调大不会让记忆变长）；`requestRewrite` 与 `multiNpc` 默认关闭，开启后 token 与延迟明显增加。

---

## 3. 目录结构

```
WorldApartProject/
├─ package.json               # type:module + electron-builder（仅 win portable）；version 是版本号单一来源
├─ AGENTS.md                  # 本文件（总览与文档路由）
├─ docs/                      # 分工文档：contributing / dev-workflow / memory-rules / configuration / api / verification-log / multi-npc
├─ electron/main.cjs          # Electron 主进程：起后端、开窗、单实例、关窗即退、便携 data/ 或 data_test/
├─ scripts/
│  ├─ build-backend.mjs       # esbuild: src/app.js → dist/backend.cjs（asar 内 CJS 单文件）
│  └─ dist.mjs                # portable 打包包装（备份/恢复 releases/data 与 data_test）
├─ public/                    # 管理页（原生 HTML/CSS/JS，无框架）
│  ├─ index.html  ├─ app.js  └─ style.css
├─ src/
│  ├─ app.js                  # 应用装配（CLI 与 Electron 共用）：start()/stop()
│  ├─ index.js                # CLI 入口：横幅（含测试档标识）、信号处理
│  ├─ config.js               # ConfigStore（热更新）、默认值、env 路径、--test 档位
│  ├─ server.js               # HTTP：游戏 API（Key）+ 管理 API（本机）+ NPC 编排 + 静态页
│  ├─ identify.js             # 请求分类、slug 归一化、游戏状态提取（纯正则）
│  ├─ upstream.js             # 上游转发：SSE 真流式直通 + Tee 捕获、非流式、超时
│  ├─ requestRewrite.js       # 【实验性】请求重写：改写游戏 system、校验、行级 diff
│  ├─ cast/                   # 【实验性】多 NPC 共演
│  │  ├─ plan.js              # 指令解析结果 → 在场状态 → 谁先开口
│  │  ├─ stage.js             # 括号入场/离场、正文点名、在场状态机
│  │  ├─ registry.js          # 名字/别名 → slug 名册（60s 缓存）
│  │  ├─ card.js              # 从 intake 抽取配角角色卡；A 是否认识 B
│  │  ├─ actor.js             # 配角独立请求、输出清洗
│  │  └─ merge.js             # 台词 JSON 转义 + 流内插入（content 内）
│  ├─ locks.js                # 按 NPC 串行队列
│  ├─ log.js                  # 环形缓冲（SSE 推送）+ 按天 JSONL
│  └─ memory/
│     ├─ store.js             # 每 NPC 数据目录、state、对话追加、原文快照、逐 NPC 提示词
│     ├─ inject.js            # 长期记忆 / 外置设定提示词注入文本组装
│     └─ summarizer.js        # 异步长期记忆压缩
├─ dist/backend.cjs           # 构建产物（gitignore）
└─ releases/                  # portable exe 与其同级 data/、data_test/（gitignore）
```

运行时数据：**正式档目录名 `data/`，测试档 `data_test/`**（CLI 与便携版同样规则）。
开发态位于项目根，便携版位于 exe 同级；两档结构一致、内容完全隔离：

```
data/  或  data_test/
├─ config.json
├─ rewrite-cache-exact.json   # 机制 1 全局 LRU 缓存（默认 1000 条，防抖落盘）
├─ logs/YYYY-MM-DD.jsonl      # npc / compressor / probe / summary / idle_flush / memory_write / memory_edit / config / server / auth
├─ logs/details/YYYY-MM-DD.jsonl # 请求详情（完整 prompt / 思维链 / 回复 / usage），保留 14 天
└─ npcs/<slug>/
   ├─ state.json              # slug/sessionId/名称变体/轮次/摘要水位/最近游戏状态
   ├─ memory.md               # 长期记忆（摘要器重写；回复前注入）
   ├─ prompt.json             # 该 NPC 个人提示词 {useGlobal,text}（可选；回复前注入）
   ├─ aliases.json            # 玩家可编辑的别名 {names:[]}（可选；共演点名识别用）
   ├─ cast.json               # 是否允许作为配角参与共演 {enabled:true}（可选；缺失=关闭）
   ├─ stage.json              # 共演在场状态 {sceneKey,onStage,updatedAt}（可选）
   ├─ conversations.jsonl     # 该 NPC 的完整会话历史（每轮玩家/NPC 各一条，只追加）
   ├─ backups/memory-<时间戳>.md # 「AI 修改记忆」保存前的时间戳备份（全部保留，可手工回滚）
   └─ intake/<时间>.md         # system 原文快照（首见或内容变化时）
```

---

## 4. NPC 识别与记忆（摘要）

- **识别**：解析 `## 角色设定` 得角色名 → 归一化（剥品阶/外观前缀、`~心境`、尾随数字）→ 稳定 slug；mod 全名按 `## 角色背景`「以原名开篇」校正，只在候选名含数字时生效。
- **注入**：只新增 system，绝不改写游戏原文；仅当该 NPC 已有真实记忆时注入，首轮不注入。
- **优先级**：本轮 JSON 输出格式/必需字段（唯一底线）> 全局/个人提示词 > 长期记忆 > 游戏下发全部内容。
- **摘要**：七分区「状态卡」模板（身份与称呼/关系/经历与进度/未了之事/赠予往来/习惯与忌讳/同场），
  一行只写一件事 ≤60 字、【经历】【未了】用编号；**禁**「她已认下/应下/受住/放话」这类复述前缀与
  「于是/随后/接着/又」这类过程连接词；`{GIFT}` 必须换成真名。旧「玩家所述，未经证实」分区已删除。
- **兜底**：水位触发 + 空闲 `idleFlushMs` 补压；超限先重试、仍超限才按行截断。
  摘要窗口按 `state.lastSummaryLine`（`conversations.jsonl` 非空行水位）切片，**只喂新对话**，
  不再「取最近 N 条」重复摘要同一段；注入裁剪按分区优先级，身份与关系最后才动。
- **重写缓存**：`cache.mode=exact` 时按最终请求体逐字节指纹复用已校验结果，`mode=none` 与未加缓存逐字节一致。
- **解析红线**：真实 system 是 CRLF——换行后的空白只用 `[ \t]`、取值只用 `[^\r\n]`、跨行写 `\r?\n`。

> 完整规则（归一化与 mod 校正细节、摘要六分区与归类边界、空闲兜底、超限重试、缓存机制 1、游戏请求格式备忘）见 [docs/memory-rules.md](docs/memory-rules.md)。

---

## 5. 管理接口（仅本机，无需游戏 Key）

游戏侧 `POST /v1/chat/completions`、`GET /v1/models`（需 API Key），`GET /health` 免鉴权；管理侧提供状态、配置、SSE 日志、日志详情、NPC 记忆/提示词/别名/共演在场与记忆改写等接口，均只接受本机访问。

> 完整接口清单、参数与日志字段见 [docs/api.md](docs/api.md)。

---

## 6. 已验证情况（摘要）

- 33 条真实游戏请求回放全部通过（14 个 NPC 正确隔离建档）；连续会话异步摘要、portable exe、档位隔离、真机接游戏均实测。
- 0.6.x 起逐版本复盘：请求重写（全部 system 模块、格式校验、整模块删除）、多 NPC 共演（插入/兜底/在场状态）、纯文本回复包 JSON、`{GIFT}` 意图修正等，均有假上游端到端或真机日志回归。
- 已知结论：中文约 1.4 汉字/token；调大 `maxMemoryChars` 不会让记忆变长；默认不干涉思考才与裸模型一致。

> 逐条验证证据、修过的缺陷与排障手册见 [docs/verification-log.md](docs/verification-log.md)。

---

## 7. 红线（简版）

1. **版本号不跳过**：有效改动必须按 [docs/contributing.md](docs/contributing.md) §1 递增 `package.json`
   的 `version`（单一来源，禁止别处手写）；纯文档同步并入原批次、不递增；重出 exe 后仓库版本须与产物一致。
2. 不提交密钥与运行数据：`data/`、`data_test/`、`node_modules/`、`dist/`、`releases/`、`.eb-cache/`
   一律不进仓库（`data*/config.json` 含上游真实 API Key）。
3. 不引入运行时第三方依赖（`src/`、`public/` 只允许 `node:*` 与浏览器原生 API）。
4. 不破坏真流式：转发不缓冲；落盘与摘要只能发生在响应结束之后。
5. 不破坏「关窗即退出 / 单实例 / 关服必须 `closeAllConnections()`」语义。
6. 不让测试档与正式档数据互相污染。
7. 日志与接口中的密钥一律掩码；管理接口仅监听本机。

> 红线完整说明、代码约束 12 条与版本号对应表见 [docs/contributing.md](docs/contributing.md)。
