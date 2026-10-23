# 开发、测试、打包与发布流程

> 本文只讲**怎么改、怎么验、怎么出包、怎么发**。产品形态、运行原理、配置项见 [AGENTS.md](../AGENTS.md)；
> 版本号规约、代码约束与协作红线见 [contributing.md](contributing.md)（与本文件冲突时以该文为准）。

---

## 0. 总链路

```text
改代码 → 递增版本号 → 本地起服务 → 分层验证 → git commit
      → npm run dist:win 出 exe → git push → 打 v<version> tag → CI 发 Release
```

没有服务器部署：交付物就是 portable exe（本地出包或从 GitHub Release 下载）。

---

## 1. 开发环境

- **Node.js >= 20**（见 `package.json` 的 `engines`）；开发在 Windows 上进行，产物只有 Windows portable x64。
- **运行时零第三方依赖**：`src/`、`public/` 只允许 `node:*` 与浏览器原生 API；
  第三方包只能进 `devDependencies`（electron / electron-builder / esbuild 仅用于构建打包）。
- **模块制式**：`src/**`、`public/app.js` 用 ESM；`electron/main.cjs` 用 CJS（需 `require` 打包后的
  `dist/backend.cjs`），改主进程时不要改成 ESM。
- **统一装配入口**：CLI（`src/index.js`）与 Electron 主进程都必须经 `src/app.js` 的 `createApp()` 启动，
  禁止复制粘贴启动代码。
- **环境变量契约**：`WFC_HOME`、`WFC_PUBLIC_DIR`、`WFC_VERSION`、`WFC_TEST`，改动时需同步
  `electron/main.cjs` 与 `src/config.js`；`WFC_PUBLIC_DIR` 在开发与打包两种模式下都必须显式注入。

### 启动方式

| 命令 | 作用 | 数据目录 |
| --- | --- | --- |
| `npm start` | 仅启动后端（CLI），浏览器访问 `http://127.0.0.1:8790/` | `data/`（正式档） |
| `npm run start:test` | CLI 启动测试档 | `data_test/` |
| `npm run dev:desktop` | 先 `build:backend`，再启动 Electron 窗口 | `data/`（加 `--test` 走 `data_test/`） |
| `npm run build:backend` | 仅用 esbuild 生成 `dist/backend.cjs` | — |
| `npm run dist:win` | 构建便携版 exe，见 §3 | — |

- 两档**完全隔离**：各有独立 `config.json`（各自 API Key）、`npcs/`、`logs/`；调试一律用测试档，
  禁止把测试数据写进正式档。
- 受单实例锁约束，同一时间只能运行一个档位；先关掉当前实例再切换。
- 管理页保存的配置即时生效；`server.port` 这类改动需重启。

---

## 2. 本地验证

项目**没有 `npm test`，也没有单测框架**。每批改动按影响面选择验证方式，验证结论必须回写到
[docs/verification-log.md](verification-log.md)（附日期与版本号，写清验了什么、结果如何、修了什么），
并在 [AGENTS.md](../AGENTS.md) §6 摘要里同步一行。

常用四层，按改动风险从低到高叠加：

1. **模块级回归**：用临时 Node 脚本直接调用目标模块（`identify.js`、`cast/plan.js`、
   `requestRewrite.js`、`rewriteCache.js` 等），断言输入输出。适用纯函数与规则改动。
2. **假上游端到端**：本地起一个假 OpenAI 兼容上游，走真实 HTTP/SSE 路径，覆盖注入顺序、
   逐字节直通、失败回退、共演插入等路径。共演与请求重写必须过这一层。
3. **真实日志回放**：用 `data*/logs/details` 里的真机请求重放，覆盖真实 system 的 CRLF、
   多 system 模块、纯文本回复等形态（历史上多个 bug 只有真实日志能暴露）。
4. **浏览器实测**：在 `http://127.0.0.1:8790/` 实测管理页——配置保存与持久化、日志与详情渲染、
   无 JS 报错、刷新后状态正确。

出包后追加**便携版冒烟**：带 `--test` 启动 exe，确认窗口能打开、`/api/status` 的 `version`
与 `package.json` 一致、数据写进 exe 同级 `data_test/`、关窗进程全退。

> 临时脚本、假上游代码、调试截图一律不作为交付物提交；需要长期保留的验证结论写进
> [verification-log.md](verification-log.md)。

---

## 3. 打包（Windows portable exe）

`npm run dist:win` → [scripts/dist.mjs](../scripts/dist.mjs)，流程：

1. 把 `releases/data` 与 `releases/data_test`（含真实上游 Key、NPC 记忆、日志）备份到仓库外的临时目录；
2. [scripts/build-backend.mjs](../scripts/build-backend.mjs) 用 esbuild 把 `src/app.js` 打成单文件
   `dist/backend.cjs`（CJS，供 asar 内加载）；
3. electron-builder 出 `releases/WorldApartNpcAgent-<version>-win-portable.exe`（x64，未签名）；
4. 恢复两个数据目录并逐文件大小校验，然后清理 `win-unpacked`、`.blockmap`、`latest.yml` 等中间产物。

注意事项：

- **国内网络 / 沙箱环境必须先设镜像变量**，否则打包阶段连 GitHub 超时（缺 `ELECTRON_MIRROR` 时
  electron 本体仍走 GitHub，最容易漏）：
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`、
  `ELECTRON_CACHE=<项目内目录>`、`ELECTRON_BUILDER_CACHE=<项目内目录>`、
  `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`。
- `releases/`、`data/`、`data_test/`、`dist/`、`.eb-cache/` 均**不进仓库**；也不要提交任何平台二进制产物。
- exe 未签名，首次运行会有 SmartScreen 提示。
- 重新出包后，**仓库版本号必须与产物文件名里的版本一致**（见 [contributing.md](contributing.md) §1）。

---

## 4. 提交与发布

### 4.1 提交前

- 按 [contributing.md](contributing.md) §1 递增 `package.json` 的 `version`（单一来源，禁止别处手写；
  纯文档同步并入当前批次、不递增）。
- 过一遍 [contributing.md](contributing.md) §2 的代码约束与 §3「明确不要做的事」。

### 4.2 commit

- 信息格式：`类型: 中文摘要`，类型沿用仓库现有风格——`feat`（新功能）/ `fix`（缺陷修复）/
  `chore`（构建、CI、杂项）。
- 一个改动集合一个提交；代码、文档、版本号在同一批次内一起提交。
- 只提交源码与文档，不提交密钥与运行数据（`data*/config.json` 含真实 API Key）。

### 4.3 push 与 CI

- 推送 `main` 触发 [build-win.yml](../.github/workflows/build-win.yml)：`windows-latest` 上
  `npm ci` → `npm run dist:win` → 上传 exe artifact（用于验证可打包，不发版）。
  该工作流不设镜像变量，Runner 直连。
- 发布 Release 需另打 tag：`git tag v<version>` 后推送。CI 会校验 tag 与 `package.json` 版本一致
  （不一致直接失败），并把 exe 发到 Release、自动生成 release notes。
- `electron` / `electron-builder` 的下载缓存放在仓库内 `.eb-cache/`（与 `.gitignore` 一致），
  CI 用 `package-lock.json` 哈希做缓存键。

### 4.4 交付形态

运行时数据写在 exe 同级 `data/`（正式档）或 `data_test/`（测试档），单进程、关窗即退、无后台服务、
无托盘常驻、无开机自启。
