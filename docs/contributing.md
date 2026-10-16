# 开发协作规范

> 版本号、代码约束与协作红线的**权威说明**。项目总览与架构见 [AGENTS.md](../AGENTS.md)。
> 本文与 AGENTS.md 冲突时，以本文为准。

---

## 1. 版本号规约（重要：自更新）

- 版本号采用**标准 semver 三位**：`MAJOR.MINOR.PATCH`。

- **单一来源**：`package.json` 的 `version` 字段。**禁止在其他文件手写版本号**。
  - 命令行模式：由 [src/config.js](../src/config.js) 的 `pkgVersion()` 读取 `package.json`。
  - 便携版：Electron 主进程用 `app.getVersion()` 注入 `WFC_VERSION` 环境变量，
    `src/config.js` **优先读该环境变量**（打包后 asar 内读不到 package.json）。

- **自更新要求**：**每次对项目做出有效改动后，必须同步更新 `package.json` 的 `version`**，按下述规则递增：

  | 改动性质 | 递增位 | 示例 |
  | --- | --- | --- |
  | 破坏性变更（接口 / 配置结构 / 数据目录布局不兼容） | MAJOR | `0.3.1` → `1.0.0` |
  | 新增功能（向后兼容） | MINOR | `0.3.1` → `0.4.0` |
  | 修复缺陷 / 内部重构 / 文档 | PATCH | `0.3.1` → `0.3.2` |

- 同一批次内**同时包含新功能与修复**时，按其中**最高位**递增（即 MINOR 优先于 PATCH）。

- **递增粒度是「一个改动集合 / 一次交付」，不是「一次文件编辑」**：同一批次内的
  代码与文档同步只递增一次，避免版本号空转。

- **制品必须与仓库一致**：若重新构建了 `releases/` 里的 exe，仓库版本号必须与该产物
  版本号一致。**纯文档同步不递增**——这类改动并入原批次即可，不要因为"改了文档就 +1"，
  否则会出现"已交付的 exe 是 0.3.1、仓库却是 0.3.2"的错位。

- 版本号**无需改任何前端代码**，自动出现在以下位置（改完重启即生效）：
  - 便携版 **Electron 窗口标题**（测试档会额外显示 `[测试档]`）；
  - 管理页**顶部标题旁**（测试档显示 `vX.Y.Z · 测试档`）；
  - 命令行启动**横幅**；
  - `GET /api/status` 的 `version` 字段。

- **红线**：**不跳过版本号递增**。

---

## 2. 代码约束（不要破坏）

1. **运行时零第三方依赖**：`src/` 与 `public/` 只允许用 Node 内置模块（`node:*`）与浏览器原生
   API。第三方包只能作为 `devDependencies`（electron / electron-builder / esbuild 仅用于构建打包）。
2. **模块制式**：`src/**` 与 `public/app.js` 用 ESM；`electron/main.cjs` 用 CJS
   （它要 `require` 打包后的 `dist/backend.cjs`）。改主进程文件时不要改成 ESM。
3. **前后端共用一份装配逻辑**：命令行入口（`src/index.js`）与 Electron 主进程都必须通过
   `src/app.js` 的 `createApp()` 启动服务，**禁止复制粘贴启动代码**。
4. **环境变量契约**：`WFC_HOME`（数据目录）、`WFC_PUBLIC_DIR`（静态页面目录）、
   `WFC_VERSION`（版本号）、`WFC_TEST`（测试档）是桌面模式与命令行模式的契约，改动时需同步
   `electron/main.cjs` 与 `src/config.js`。
   **`WFC_PUBLIC_DIR` 必须在打包与开发两种模式下都显式注入**：后端被 esbuild 打成 CJS 后
   `import.meta.url` 失效，程序无法自行推断 `public/` 的位置（否则会出现"窗口打开但页面 404"）。
5. **档位隔离**：正式档 `data/`、测试档 `data_test/`（`--test` 参数或 `WFC_TEST=1` 触发）。
   **禁止把测试数据写进正式档**；`scripts/dist.mjs` 构建时必须**同时**备份/恢复这两个目录。
6. **关服必须强制断开存量连接**：`src/app.js` 的 `stop()` 里除了 `server.close()`，还必须调用
   `server.closeAllConnections()` 并叠加超时兜底。原因是管理页持有 SSE 长连接，
   `server.close()` 的回调会一直不触发，表现为"端口释放了但进程不退出"。
7. **无 daemon / 单实例**：保持"关窗即退出"与 `requestSingleInstanceLock()`；
   不要引入托盘常驻、开机自启、后台守护等行为。**任何内部定时器（如空闲兜底 `idleFlusher`）
   都必须 `unref()` 并在服务 `close` 时清除**，绝不能拖住进程退出。
8. **真流式不得破坏**：`src/upstream.js` 的转发必须**原样直通、不缓冲**；任何记忆类工作
   （落盘、摘要）都只能在**响应结束之后异步做**，绝不允许阻塞首字节回传。
9. **上游参数：默认不干涉**。转发前只做两件事——把 `model` 映射到配置的上游模型、在
   `memory.summarizer` 这条**内部**调用上补 `thinking:{type:"disabled"}`。
   游戏对话路径**不得**擅自增删采样/思考参数：游戏原始请求从不带 `thinking`，我们也不注入
   （默认 `upstream.disableThinking:false`）。实测禁用思考会让 NPC 忽略 system 里的复杂规则，
   破坏与裸模型一致的表现。调用方已带 `thinking` 时**任何情况下都不得覆盖**。
   另：记忆注入（`memory/inject.js`）与对话风格注入（同文件的 `injectStyle`）只**新增** system
   消息，绝不改写、替换或删除游戏原始 system；风格提示必须写明"与本轮系统规则／输出格式冲突时以系统为准"。
10. **记忆写入串行**：同一 NPC 的落盘与摘要必须走 `src/locks.js` 的 `KeyedQueue`；
    `conversations.jsonl` **只追加、不可改写历史**。
11. **安全默认值**：日志与接口中的密钥一律掩码；管理接口仅接受本机访问（`127.0.0.1`/`::1`）；
    游戏侧接口必须校验 API Key（`src/server.js` 的 `authed()`）。
12. **不要再造路由框架**：`node:http` 手写路由已足够，不要为几个接口引入 Express/Fastify。

---

## 3. 明确不要做的事

- 不要把 `node_modules/`、`dist/`、`releases/`、`data/`、`data_test/`、`.eb-cache/` 提交进仓库
  （`data*/config.json` 含**上游真实 API Key**，`data*/npcs/` 含玩家与 NPC 对话内容）。
- 不要把某个平台的二进制产物放进仓库；如需分发，在目标系统现场构建。
- 不要在日志中记录明文密钥。
- 不要让测试档数据与正式档互相污染（含端口冲突时的"关掉当前实例再切换"约定）。
- **不要跳过版本号递增**（见 §1）。
- 不要为了省事把服务拆成后台守护进程或常驻托盘。

---

## 4. 版本号与交付的对应（示例）

| 场景 | 该做什么 |
| --- | --- |
| 新增一个管理接口 / 配置项 / NPC 识别规则 | `package.json` 递增 MINOR，跑 `npm run dist:win` |
| 修 bug（不影响接口与配置结构） | 递增 PATCH，需要出包时再跑 `dist:win` |
| 只更新 AGENTS.md / 本文件 | **不递增**，并入当前批次 |
| 改了数据目录布局或配置结构（旧配置不兼容） | 递增 MAJOR，并在 AGENTS.md 标注迁移方式 |
| 调整 `server.port` 默认值等不兼容默认 | 视为 MAJOR 或 MINOR（视是否破坏既有部署），明确写入文档 |
