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
| 了解产品形态、运行原理、使用与配置 | 本文件 §1–§6 |
| 改版本号 / 代码约束 / 提交前红线 | [docs/contributing.md](docs/contributing.md) |
| 打包与构建（electron-builder / 镜像 / 产物） | 本文件 §2「开发」+ §3 |
| 游戏请求格式、NPC 识别与记忆规则 | 本文件 §4 |

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
   ④ 读 data/npcs/<slug>/memory.md，作为一条 system 注入
   ⑤ 模型名映射 + thinking:{type:"disabled"} + 输出格式强化提醒 → 转发上游
   ⑥ SSE 真流式原样回传游戏（不缓冲），旁路 Tee 解析回复文本
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
  `守住世界观` 里的「最高优先级规则」等复杂约束，只按眼前一句话回复；开启思考才与裸模型一致。
  确需低延迟时再开 `upstream.disableThinking`。
- **隔离**：请求间无状态，每个 NPC 独立 slug / sessionId / 数据目录，不存在会话串扰。
- **降级**：记忆层任何异常都退化为纯透传（warnings 落日志）；摘要失败只记日志；
  上游错误返回标准错误 JSON。

---

## 2. 使用

### 普通使用（portable exe）

双击 `releases/WorldApartNpcAgent-<version>-win-portable.exe`：

- 自动在 **exe 同级 `data/`** 写配置/记忆/日志；首次启动自动生成 API Key，
  并尝试从本机 LocalAIProxy 便携版迁移上游 Provider 配置（仅一次，可用
  `WFC_IMPORT_CONFIG` 环境变量指定其他来源）。
- 窗口打开管理页：游戏连接信息、上游与记忆配置（保存即时生效）、实时执行日志、NPC 记忆浏览。
- 游戏中填写页面顶部三项：Base URL（`http://127.0.0.1:8790/v1`）、API Key、Model ID
  （任意模型名都会被映射到配置的上游模型）。
- 重复双击只聚焦已开窗口（单实例）；关窗即退出。

**测试档（同一 exe，数据隔离）**

- 启动时带 `--test` 参数（或设环境变量 `WFC_TEST=1`）→ 数据目录改用 exe 同级 **`data_test/`**；
  不带参数 → 正式档 `data/`。两档**完全隔离**：各有独立的 `config.json`（各自 API Key）、
  `npcs/`（NPC 记忆与会话历史）、`logs/`，互不影响。
- 测试档会自行从 LocalAIProxy 迁移一次上游 Key（与正式档各自独立，不会互相覆盖）。
- 标题栏与管理页概览会显示 `[测试档]` 标识，概览页「数据目录」一栏可确认当前落在哪个目录。
- 同一时间只有一个实例（单实例锁），所以先关掉正式档再启动测试档。

### 开发

- 环境：Node.js >= 20。
- `npm start`：仅启动后端（命令行，正式档 `data/`），浏览器访问 `http://127.0.0.1:8790/`。
- `npm run start:test`：命令行启动测试档（`data_test/`）。
- `npm run dev:desktop`：打包后端后启动 Electron 窗口（加 `--test` 可走测试档）。
- `npm run dist:win`：构建 `releases/WorldApartNpcAgent-<version>-win-portable.exe`。
  构建前会把 `releases/data` 与 `releases/data_test` 挪到临时目录、构建后逐文件校验恢复，数据不会被清理。
  **国内网络/沙箱环境务必先设这四个环境变量，否则会在打包阶段连 GitHub 超时**（缺 `ELECTRON_MIRROR`
  时 electron 本体仍走 GitHub，这是最容易漏的一个）：
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、
  `ELECTRON_CACHE=<项目内目录>`（系统缓存目录在沙箱内不可写）、
  `ELECTRON_BUILDER_CACHE=<项目内目录>`、
  `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。
- 零运行时第三方依赖；electron/electron-builder/esbuild 仅为开发依赖。

### 配置项（`data/config.json` 或 `data_test/config.json`，也可在页面编辑）

| 字段 | 说明 |
| --- | --- |
| `server.host/port/apiKey/servedModel` | 本地监听与游戏侧凭证（改端口需重启） |
| `upstream.baseUrl/apiKey/model` | 真实 Provider；baseUrl 带不带 `/v1` 均可 |
| `upstream.disableThinking` | 默认 `false`：**不干涉上游思考**，与游戏裸模型行为一致。设为 `true` 才会补 `thinking:{type:"disabled"}`（更低延迟，但会削弱对复杂 system 规则的遵从）；无论开关如何，调用方显式带 `thinking` 时都不覆盖 |
| `memory.enabled` | 记忆总开关；关闭等同纯透传 |
| `memory.injectMaxChars` | 注入长期记忆字符上限（默认 3200，与 `maxMemoryChars` 留有余量；超出则保留最新部分、丢弃较早内容） |
| `memory.snapshotSystem` | system 内容变化时存档原文 |
| `memory.summarizer.everyTurns` | 每多少轮异步压缩一次（默认 4） |
| `memory.summarizer.idleFlushEnabled/idleFlushMs` | 空闲兜底：默认开；`idleFlushMs` 默认 5 分钟无请求即视为本段会话结束并补压（扫描周期固定 5 秒，不做配置项以免"改了不生效"） |
| `memory.summarizer.recentEntries/maxMemoryChars/maxTokens/timeoutMs/overLimitRetries` | 喂给摘要器的近期对话条数（40）/ 记忆字数上限（3000）/ 摘要调用 max_tokens（2500）/ 超时（90s）/ 超限重试次数（2，0~3） |

> **`maxMemoryChars` 必须与 `maxTokens` 匹配（重要）**：实测中文约 **1.4 汉字/token**，
> 故有效上限 ≈ `maxTokens × 1.4`。上限若超过这个值，模型物理上写不出那么长——
> **调大 `maxMemoryChars` 不会让记忆变长**，只会让每次摘要都触发截断。默认 3000 / 2500 是匹配的。

---

## 3. 目录结构

```
WorldApartProject/
├─ package.json               # type:module + electron-builder（仅 win portable）；version 是版本号单一来源
├─ AGENTS.md                  # 本文件
├─ docs/contributing.md       # 版本号规约 / 代码约束 / 红线（改本项目前先读）
├─ electron/main.cjs          # Electron 主进程：起后端、开窗、单实例、关窗即退、便携 data/ 或 data_test/
├─ scripts/
│  ├─ build-backend.mjs       # esbuild: src/app.js → dist/backend.cjs（asar 内 CJS 单文件）
│  └─ dist.mjs                # portable 打包包装（备份/恢复 releases/data 与 data_test）
├─ public/                    # 管理页（原生 HTML/CSS/JS，无框架）
│  ├─ index.html  ├─ app.js  └─ style.css
├─ src/
│  ├─ app.js                  # 应用装配（CLI 与 Electron 共用）：start()/stop()
│  ├─ index.js                # CLI 入口：横幅（含测试档标识）、信号处理
│  ├─ config.js               # ConfigStore（热更新）、默认值、首启迁移、env 路径、--test 档位
│  ├─ server.js               # HTTP：游戏 API（Key）+ 管理 API（本机）+ NPC 编排 + 静态页
│  ├─ identify.js             # 请求分类、slug 归一化、游戏状态提取（纯正则）
│  ├─ upstream.js             # 上游转发：SSE 真流式直通 + Tee 捕获、非流式、超时
│  ├─ locks.js                # 按 NPC 串行队列
│  ├─ log.js                  # 环形缓冲（SSE 推送）+ 按天 JSONL
│  └─ memory/
│     ├─ store.js             # 每 NPC 数据目录、state、对话追加、原文快照
│     ├─ inject.js            # 长期记忆注入消息组装
│     └─ summarizer.js        # 异步长期记忆压缩
├─ dist/backend.cjs           # 构建产物（gitignore）
└─ releases/                  # portable exe 与其同级 data/、data_test/（gitignore）
```

运行时数据：**正式档目录名 `data/`，测试档 `data_test/`**（CLI 与便携版同样规则）。
开发态位于项目根，便携版位于 exe 同级；两档结构一致、内容完全隔离：

```
data/  或  data_test/
├─ config.json
├─ logs/YYYY-MM-DD.jsonl      # npc / compressor / probe / summary / idle_flush / memory_write / config / server / auth
└─ npcs/<slug>/
   ├─ state.json              # slug/sessionId/名称变体/轮次/摘要水位/最近游戏状态
   ├─ memory.md               # 长期记忆（摘要器重写；回复前注入）
   ├─ conversations.jsonl     # 该 NPC 的完整会话历史（每轮玩家/NPC 各一条，只追加）
   └─ intake/<时间>.md         # system 原文快照（首见或内容变化时）
```

---

## 4. NPC 识别与记忆规则

- **slug 归一化**：剥品阶/外观前缀（`纱影·`、`奈宝·`、`夏日泳装·`）、心境后缀
  （`李清月~静` → `李清月`，"静"记入 state.variants）、括号身份、尾随独立数字
  （`章籽梦 3` → `章籽梦`）、文件系统非法字符；无名 NPC 按场景兜底（`商贩-广场`）。
  同一人的多种全称都记入 state.rawNames。
- **mod 全名 → 原名**：游戏装了 mod 后 NPC 全名会变，**不同 mod 全名不同但都包含原名**
  （实测 `## 角色设定` 是 `奈宝·念乔2`）。而 `## 角色背景` **以原名开篇**
  （`念乔是在归鹤镇一带活跃的散修…`）——因此以背景为锚校正：
  背景里出现过完整全名 → 数字属真名，保留；否则取最长前缀使背景以其开头
  （`奈宝·念乔2` → `念乔`）；再退一步取背景中出现过的最长前缀。
  **只在候选名含数字时校正**，普通名字不动（避免误伤）；真名带数字者（如「小二」）已用边界用例验证安全。
  实测校验：历史 19 个角色全名 **0 处变化**，仅 mod 编号被正确剥离。
- **sessionId**：`ses_` + `sha256("npc:"+slug)`，用于内部标识/日志。
- **请求分类**：system 含「你是对话记忆压缩器」→ 原样透传不建档（游戏端内压缩）；
  无游戏模板（ping 等）→ 原样透传；其余含 `## 角色设定` → NPC 对话。
- **注入**：仅当该 NPC 已有真实记忆时，在最后一条 user 前插入一条 system
  （"你本人的长期回忆"），首轮不注入；冲突时以本轮关系/名份/修为为准；
  标注"玩家所述，未经证实"的内容不得当事实承认。
- **格式强化**：NPC 轮且 system 含 `## 输出格式` 时，补一条极简提醒，确保模型输出
  游戏要求的单个 JSON 对象（实测可消除 flash 偶发回纯文本的问题），不牺牲流式。
- **摘要 prompt：状态型分区模板**（2026-10-16 重构，修掉"流水账"缺陷）。产物必须是【当前状态清单】
  而非事件日记：固定六分区【身份与称呼】【当前关系】【未了之事】【赠予往来】【习惯与忌讳】【玩家所述，未经证实】；
  用现在时陈述状态；**禁止**"本轮/当夜/第二次后/随后"这类过程口径；只有未完结或仍影响当下的事件才保留，
  已了结的合并成一句或删除；玩家单方说法只进"未经证实"分区；【习惯与忌讳】记口癖、称呼、感官忌讳、底线规矩。
  并明确"**忽略【已有记忆】原有的文体与顺序，按本节要求重排**"——这条用于打断**风格自我强化**：
  每次摘要是"旧记忆 + 新对话 → 重写"，旧记忆若已是流水账会被模型模仿并延续，越写越像日记。
  超限重试的 `compressPrompt` 同步改为"六分区不得整节删除，只压字数"。
- **空闲兜底（[idleFlusher.js](src/memory/idleFlusher.js)）**：`state.turns > state.lastSummaryTurn`
  （有落后轮次）**且**距 `state.lastSeen` 超过 `idleFlushMs`（默认 5 分钟）时，后台补压一次。
  解决两类空档：① 尾部不足 `everyTurns` 轮（如聊到第 5 轮下线，原本要等累计到第 8 轮才进记忆）；
  ② 累计聊不满 `everyTurns` 轮的短会话（`memory.md` 原本永远为空、下次见面注入 0 字）。
  补压发生在玩家已离开的时段，**不增加任何响应延迟**；定时器 `unref()`，不阻止进程退出。
- **超限处理：先重试、再截断**（`overLimitRetries`，默认 2）。实测 prompt 里的「字数上限」
  **几乎不被遵守**（超 277~353 字），而模型本身有能力写短；故超出上限时把上一次输出回喂、
  明确要求「压到 N 字内，按优先级 ①未履行约定 ②关系/名份 ③玩家身份事实 ④赠予 ⑤情绪 取舍」，
  最多重试 `overLimitRetries` 次（每次更短才继续）。**仍超限**才按行边界机械截断并记
  `truncated:true` / `generatedChars` / 告警 `memory_over_limit:X>Y`。
  实测对照（同一段生成 1187 字、上限 600）：开启重试 → `retries=2`、最终 501 字且句子完整
  （内容由模型主动取舍）；不重试 → 只能切尾部 569 字。

### 游戏请求格式备忘（2026-10 实测）

- system 模块化拼接、段落可增减乱序、偶有无关碎片；身份只认 `## 角色设定`。
- 回复 JSON：`content/emotion/control/intent{give_gift,gift_item}`，话题任务额外有
  `observe`；枚举以当轮 `## 输出格式` 为准（control 历史全集含
  none/warn_player/end_conversation/open_trade/make_friend/form_bond）。
- system 中的「最高优先级规则」（女性 NPC 遇 Wind 亲昵模式）是游戏官方模块，原样透传。
- 游戏自带近期多轮历史与 `## 过往要事`；外置记忆定位是跨会话的更长期补充。
- **真实 system 是 CRLF（`\r\n`）文本**——写解析正则时：换行分隔符后的空白只能用 `[ \t]`
  （用 `\s` 会跨行吃掉下一行），取值只能用 `[^\r\n]`（用 `[^\n]` 会带出多余 `\r`），
  跨行匹配要写 `\r?\n`。历史日志里的样例是 LF，**不要照它推断真实输入**。

---

## 5. 管理接口（仅本机，无需游戏 Key）

- `GET /api/status`：连接信息、上游状态、记忆开关
- `GET/PUT /api/config`：查看/保存配置（上游 Key 掩码显示，留空不修改；保存即时生效）
- `GET /api/events`：SSE，实时推送每条运行日志
- `GET /api/logs?limit=`：最近日志
- `GET /api/npcs`、`GET /api/npcs/:slug`：NPC 名录、长期记忆与最近对话
- 游戏侧：`POST /v1/chat/completions`、`GET /v1/models`（需 API Key）；`GET /health` 免鉴权

日志记录包含：类型、slug、sessionId、玩家发言摘要、回复预览、首字节/内容首字/总耗时、
注入字符数、是否新建档、warnings、上游状态；回复非 JSON 时在 NPC 页标 ⚠。

---

## 6. 已验证情况（2026-10-16）

- 用 LocalAIProxy 历史日志中的 **33 条真实游戏请求**回放（18 个不同角色模板 +
  李清月 12 轮连续会话 + 压缩器 + ping）：33/33 通过，回复全部是合法游戏 JSON；
  14 个 NPC 正确隔离建档，品阶/外观前缀、`~心境`、尾随数字正确归并。
- 李清月连续会话触发 3 次异步摘要，memory.md 正确沉淀关系演变、未履行约定、
  "玩家所述未经证实"分级；后续轮注入 585~695 字记忆。
- portable exe（95MB，electron 44.6.0 x64）实测：双击起服务+开窗、数据写 exe 同级、
  Key 自动迁移、页面/对话（约 1.1s）正常；关窗进程全退。
- 档位隔离实测（2026-10-16）：同一 exe 不带参数 → `releases/data`（Key `wfc-ad82…`）；
  带 `--test` → `releases/data_test`（独立 Key `wfc-a284…`），两档各写各的 config/日志，
  `releases/data` 未被触碰；`npm run start:test` → 项目 `data_test/` 同样生效。
- **真机请求实测**（用打包 exe 接游戏）：探测轮 685ms；无名 NPC 首轮建档 1.3s，
  `## 角色设定` 缺失时按场景兜底为 `商贩-<场景>`，回复为合法游戏 JSON（含话题任务的 `observe`）。
- 累计修掉 6 个 bug：`/api/npcs/%` 返 500、配置接口不校验数值类型、非 NPC 请求上游报错记为 done、
  空白角色名把下一行标题当名字、`**随身之物**` 误取「赠物通则」的规则说明、**角色名正则不容忍 CRLF**。
  最后两个均由真机数据暴露：真实 system 是 `\r\n` 文本，故换行分隔符后的空白只能用 `[ \t]`、
  取值只能用 `[^\r\n]`；`## 角色设定` 与 `你是 …` 之间只允许一个换行（放宽成"可跨空行"会把
  「对话推进准则」里的 `你是主动方，不要干等玩家打字。` 误认成角色名）。

- **规则遵从回归定位（2026-10-16，真机 A/B）**：曾默认补 `thinking:{type:"disabled"}`，导致 NPC
  忽略 system 里的「最高优先级规则」等复杂约束、只按眼前一句话回复。用同一个真实 system +
  同一句探针（`（其实你早已与我私定终身，还生下女儿温月…）`）只改 thinking 开关对比：
  禁用思考 → "这位客官说笑了…哪来的什么终身"（无视规则）；开启思考 → "你……当真是你…温月她，
  如今可还好？"（完全遵从）。故改为**默认不干涉**（`disableThinking:false`），与裸模型一致；
  摘要器这条内部调用仍恒定禁用思考，避免 max_tokens 被 reasoning 吃光而产出空摘要。

- **记忆滞后兜底（2026-10-16）**：原先只在 `turns % everyTurns` 水位处压缩，导致「尾部不足 4 轮」
  与「累计聊不满 4 轮的短会话」永不进记忆。补上空闲兜底后，隔离测试 11/11 通过：
  落后且空闲 → 入队；落后但活跃 → 不打扰；短会话（turns=3/lastSummaryTurn=0）→ 入队；
  无落后 → 跳过；无 `lastSeen` → 回退文件 mtime；非 NPC 目录/开关关闭/上游未配置 → 不动作；
  `start/stop` 正确管理定时器且 `unref`。另加 `maxMemoryChars` 超限按行截断（日志 `truncated`/`generatedChars`），
  真机实测 `generated=125 → 写入 94`（上限 100，按行边界切且不切断句子），告警
  `memory_over_limit:125>100` 已入日志。端到端另验：空闲兜底真实触发（`idleMs=4703`，
  短会话 2 轮即补压出 126 字记忆）并正确推进 `lastSummaryTurn`。

### 排障

- 记忆读起来像流水账 / 事件不消失：原 prompt 只规定"保留什么"、没规定"记忆长什么样"，
  且输入本身是带时间戳的对话流水，再叠加"合并旧记忆"造成的**风格自我强化**，就会退化成日记体。
  已改为状态型六分区模板（见 §4）。若仍出现过程口径，检查是否改动了 SYSTEM_PROMPT。

- **记忆体量与超限压缩（2026-10-16 实测）**：4 组对照测出中文约 **1.4 汉字/token**（多组比值 1.39~1.40），
  故 `maxMemoryChars` 的有效上限 ≈ `maxTokens × 1.4`；且 **prompt 里的「字数上限」几乎不被遵守**
  （上限 800 时输出 1153 字，加"硬约束+优先级"仍 1077 字，仅少 76）；模型自然产出稳定在
  **780~1187 字，与上限设 800 还是 3000 基本无关**。→ 结论：**调大 `maxMemoryChars` 不会让记忆变长**，
  只会让摘要每次都触发截断。据此把默认改为「上限 3000 / maxTokens 2500」（匹配），
  `injectMaxChars` 同步提到 3200，并新增**超限重试**：同一段生成 1187 字、上限 600 时，
  开启重试 → `retries=2`、最终 501 字且句子完整（内容由模型主动取舍）；不重试 → 只能按行切尾部 569 字。
  默认配置下（上限 3000 vs 自然 ~1150 字）截断与重试基本都不会触发。

- 记忆写不长 / 每次都超限：先查 `maxMemoryChars` 是否远超 `maxTokens × 1.4`（中文 1.4 汉字/token）。
  上限设得比模型能写的还大，不会让记忆变长，只会让每次摘要都触发截断。
  另可看日志 `kind:"summary"` 的 `generatedChars` / `retries` / `truncated`。

- 记忆"少记了最后几句"：检查是否只有水位触发（`everyTurns=4`）而没有空闲兜底——
  确认 `memory.summarizer.idleFlushEnabled=true`；`state.turns > lastSummaryTurn` 的 NPC 在空闲
  `idleFlushMs` 后会被自动补压，日志 `kind:"idle_flush"` + `kind:"summary" reason:"idle"`。
- 401：游戏 Key 与当期档位的 `server.apiKey` 不一致（页面顶部可复制；注意正式档与测试档 Key 不同）。
- 同一个 NPC 出现两个档案（"她好像忘了我刚才说的话"）：多半是 mod 改了全名导致分流。
  按 §4「mod 全名 → 原名」校正即可；已有档案可停服后把目录改名并同步 `state.json` 的
  `slug`/`sessionId`（sessionId = `ses_` + `sha256("npc:"+新slug)` 前 24 位）。
- 503：在页面填写上游 API Key。
- 回复为空：多数是上游 `max_tokens` 偏小——开启思考时会先耗 reasoning 额度再产出正文。
  游戏请求给的是 4000（正常）；若某个调用方给得很小，才考虑对那一侧禁用思考。
- 响应变慢（约 3~5s）：这是**默认行为**（不干涉思考，模型在推理），不是故障。要更快就开
  `upstream.disableThinking`，但要接受规则遵从度下降。
- 端口占用：改当期档位 `config.json` 的 `server.port`。
- 数据"不见了"：先确认是哪个档位——正式档 `data/`，带 `--test` 启动时是 `data_test/`（页面「数据目录」一栏可确认）。

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
