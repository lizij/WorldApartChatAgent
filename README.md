# WorldApartChatAgent

《不问凡尘》外置 AI NPC 对话 Agent：把游戏里的 NPC 对话请求转发给真实大模型，
并为每个 NPC 维护**互相隔离的长期记忆**。

游戏侧只把它当成一个本地 OpenAI 兼容服务（`/v1/chat/completions`，SSE 流式）。
回复并不由本程序生成——它做的是身份识别、记忆注入与转发，模型每轮仍只做一次直出回复，
因此响应速度与裸模型一致。

- 版本号以 `package.json` 为**唯一来源**，运行时自动显示在 Electron 窗口标题、
  管理页顶部与启动横幅。
- 完整架构、代码约束与红线见 [AGENTS.md](AGENTS.md) 与 [docs/contributing.md](docs/contributing.md)。

## 特性

- **零运行时第三方依赖**：`src/` 与 `public/` 只用 Node 内置模块与浏览器原生 API。
- **真流式**：转发不缓冲；记忆落盘与摘要只发生在响应结束之后，不占用首字节延迟。
- **按 NPC 隔离**：每个 NPC 独立 slug / sessionId / 数据目录，请求间无状态，不存在会话串扰。
- **默认不干涉思考链**：与游戏原始请求保持一致，避免削弱 NPC 对复杂 system 规则的遵从。
- **单进程、关窗即退**：无后台守护进程、无托盘常驻，也没有开机自启。
- **正式档 / 测试档完全隔离**：两档各有独立的 Key、NPC 记忆与日志，互不污染。

## 快速开始

### 1. 启动程序

从 `releases/` 取出 `WorldApartNpcAgent-<version>-win-portable.exe`，双击即可：

- 在 **exe 同级 `data/`** 下写配置、记忆与日志；首次启动自动生成 API Key。
- 打开管理窗口：游戏连接信息、上游与记忆配置（保存即时生效）、实时执行日志、NPC 记忆浏览。
- 关窗即完全退出，无后台残留。

### 2. 在游戏里填写连接信息

| 项 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:8790/v1` |
| API Key | 管理页顶部可复制（首次启动自动生成） |
| Model ID | 任意模型名，都会被映射到配置的上游模型 |

### 3. 配置上游 Provider

在管理页「上游」区域填入真实 Provider 的 `baseUrl` / `apiKey` / `model`
（默认指向 `https://api.deepseek.com` 的 `deepseek-flash`），保存即时生效。

> 未配置上游 Key 时，游戏请求会得到 503。

## 测试档

同一个 exe 带 `--test` 参数（或设置环境变量 `WFC_TEST=1`）启动，数据目录改用 exe 同级
**`data_test/`**：拥有独立的 `config.json`（各自 API Key）、`npcs/`（NPC 记忆与会话历史）、
`logs/`，与正式档互不影响。标题栏与管理页概览会显示 `[测试档]` 标识。
受单实例锁约束，同一时间只能运行一个档位。

## 开发

环境：Node.js >= 20。

```bash
npm start            # 仅启动后端（正式档 data/），浏览器访问 http://127.0.0.1:8790/
npm run start:test   # 命令行启动测试档（data_test/）
npm run dev:desktop  # 打包后端后启动 Electron 窗口（加 --test 走测试档）
npm run dist:win     # 构建 releases/WorldApartNpcAgent-<version>-win-portable.exe
```

> 国内网络 / 沙箱环境构建前需设置 electron 与 electron-builder 的镜像环境变量
> （含 `ELECTRON_MIRROR`、`ELECTRON_CACHE`、`ELECTRON_BUILDER_CACHE`、
> `ELECTRON_BUILDER_BINARIES_MIRROR`），否则打包阶段会连 GitHub 超时。详见
> [AGENTS.md](AGENTS.md) §2「开发」。

## 目录结构

```text
WorldApartProject/
├─ electron/main.cjs      # Electron 主进程：起后端、开窗、单实例、关窗即退、便携 data/ 或 data_test/
├─ scripts/               # 构建后端（esbuild → dist/backend.cjs）与 portable 打包
├─ public/                # 管理页（原生 HTML/CSS/JS，无框架）
├─ src/                   # 后端：HTTP 服务、上游转发、NPC 识别、记忆层
├─ docs/contributing.md   # 版本号规约 / 代码约束 / 红线
├─ AGENTS.md              # 项目总览（产品形态、运行原理、规则）
├─ dist/backend.cjs       # 构建产物（gitignore）
└─ releases/              # portable exe 与其同级 data/、data_test/（gitignore）
```

运行时数据（**不进仓库**）：正式档 `data/`、测试档 `data_test/`，两者结构一致：

```text
data/ 或 data_test/
├─ config.json
├─ logs/YYYY-MM-DD.jsonl
└─ npcs/<slug>/
   ├─ state.json            # slug / sessionId / 轮次 / 摘要水位 / 最近游戏状态
   ├─ memory.md             # 长期记忆（摘要器重写；回复前注入）
   ├─ conversations.jsonl   # 该 NPC 的完整会话历史（只追加）
   └─ intake/               # system 原文快照
```

## 工作方式（简）

```text
游戏请求
  → 本程序本地服务（127.0.0.1:8790）
      Key 鉴权 → 确定性分类 → 正则解析「## 角色设定」得角色名与 slug
      → 注入该 NPC 的长期记忆 → 映射模型并转发上游
  → SSE 真流式原样回传游戏
  → 响应结束后异步：追加对话、更新状态、每 N 轮（含空闲兜底）压缩重写 memory.md
```

身份识别、记忆注入、落盘与摘要全部是确定性代码；模型每轮只做一次直出回复。
更详细的运行原理、NPC 识别与记忆规则见 [AGENTS.md](AGENTS.md) §1 / §4。

## 管理接口（仅本机）

`GET /api/status`、`GET/PUT /api/config`、`GET /api/events`（SSE 实时日志）、
`GET /api/logs`、`GET /api/npcs`、`GET /api/npcs/:slug`；
游戏侧为 `POST /v1/chat/completions`、`GET /v1/models`（需 API Key），`GET /health` 免鉴权。

## 许可

[MIT](LICENSE)
