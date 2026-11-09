# 任务 S 立项：路线 B——Electron 内嵌后端的一键单机版（交接文档）

> **状态**：2026-11-09 用户批准立项（「先做路线 B」），**计划待用户确认后执行**。
> **本文档用途**：交接文档。新窗口开发 Agent 通读本文档 + AGENTS.md 后按 §6 顺序执行，无需重新排查。所有事实均带文件行号，2026-11-09 本机（macOS arm64）取证。
> **回滚点**：开工前 HEAD 写入 `.gatescope.json`（建议值见 §7）。

---

## 0. 一句话结论

CKQClaw 桌面端目前是**瘦客户端**（`electron/src/main/index.ts` 只连 `http://127.0.0.1:3000`，不启动服务）。路线 B = 打包时把后端编译产物（`dist/`、`web/dist`、agent-runner）捆进 Electron 资源目录，main 进程用 `process.execPath + ELECTRON_RUN_AS_NODE=1` spawn 内嵌后端，健康检查通过后开窗——实现「双击 exe/dmg 即完整服务」。核心工程量：①数据目录可覆盖（一行）；②main 进程服务管理器；③staging 打包流水线（关键：`better-sqlite3`/`node-pty` 两个原生模块必须重装为 **Electron ABI**）；④runner 的 Electron-as-Node 运行链打通。

## 1. 目标与非目标

**目标**：`npm run desktop:package`（升级后）产出的安装包（Win=NSIS exe / mac=dmg）双击安装启动即得完整可用服务（Web UI + 后端 + host 模式 agent），无需预装 Node.js、无需手工起服务。

**非目标**（防蔓延，勿顺手做）：

- 自动更新（electron-updater）、代码签名/公证（未签名包在 mac/Win 的安全提示由用户右键打开绕过，见 §5-R7）；
- docker 容器模式支持（打包版仅 host 模式）；
- 远程服务模式改造（现有 `--server-url`/`CKQCLAW_SERVER_URL` 行为原样保留，作为连接远程部署的旧路径）；
- Python 侧车（mem0）捆绑——已有显式 unavailable 降级机制（AGENTS.md §2），非阻塞；
- 体积优化（asar 内嵌 node_modules 的精细裁剪）。

## 2. 已探明的架构事实（新会话直接使用）

### 2.1 路径全部锚定 `process.cwd()`（好消息：cwd 重定向即全通）

| 路径      | 代码位置                                                                             | 解析方式                                           |
| --------- | ------------------------------------------------------------------------------------ | -------------------------------------------------- |
| 项目根    | `src/config.ts:25` `PROJECT_ROOT = process.cwd()`                                    | cwd                                                |
| 数据目录  | `src/config.ts:33` `DATA_DIR = resolve(PROJECT_ROOT,'data')`                         | cwd 相对，**无环境变量覆盖**                       |
| 前端静态  | `src/web.ts:1269` `STATIC_DIST_ROOT = resolve('./web/dist')`                         | cwd 相对                                           |
| runner 根 | `src/container-runner.ts:2774` `path.join(process.cwd(),'container','agent-runner')` | cwd 相对，含 node_modules 存在性预检（:2778-2793） |

→ 后端进程只要以「资源目录」为 cwd 启动，前端托管与 runner 解析即天然正确；**唯一必须改的是 DATA_DIR**（资源目录只读，数据须落 `app.getPath('userData')`，见 §3-步1）。

### 2.2 进程链与运行时

- 桌面 main：`electron/src/main/index.ts`（330 行）；`DEFAULT_SERVER_URL='http://127.0.0.1:3000'`（:7），`--server-url=` 内联参数 / `CKQCLAW_SERVER_URL` / `CKQCLAW_RENDERER_URL` 可覆盖（:62-71）。
- 后端端口：`src/config.ts:60` `WEB_PORT = env.WEB_PORT || 3000` ✓ 可配。
- host 模式 runner spawn：`src/container-runner.ts:2868-2869` `resolveHostNodeBinary(hostEnv)` → `spawn(hostNodeBinary, [agentRunnerDist])`；`resolveHostNodeBinary`（`src/node-resolver.ts:96-106`）以 `process.execPath` 为候选之一、支持 env 覆盖（具体优先级读 `src/node-resolver.ts` 的 `resolveNodeBinary`，有既有测试 `tests/node-resolver*.test.ts` 锁行为）。
- 关键含义：后端进程若以 `ELECTRON_RUN_AS_NODE=1` 跑在 Electron 二进制上，其 `process.execPath` 即 Electron 可执行文件；runner 需要同样的 `ELECTRON_RUN_AS_NODE=1` 环境才能被同一二进制执行——`src/container-runner.ts` 构造 `hostEnv` 时需透传该变量（§3-步5）。

### 2.3 原生依赖（ABI 风险源，仅两个）

- 根 `package.json` dependencies 中原生模块：`better-sqlite3`（^12.10）、`node-pty`（^1.1.0）。其余（hono/ws/bcryptjs/baileys/grammy/discord.js 等）纯 JS。
- runner 侧（`container/agent-runner/package.json`）：全部纯 JS。
- Electron 39.8.10（内置 Node 22.x，ABI 与官方 Node 不同）→ **staging 打包目录里的 `better-sqlite3`/`node-pty` 必须安装 Electron ABI 版本**；仓库工作树的 node_modules 保持系统 Node ABI 不动（开发模式不受影响）。两者均发布 electron prebuilds，`prebuild-install --runtime=electron` 或 `electron-rebuild` 可解，执行时验证（§5-R1）。

### 2.4 打包设施现状

- 命令：`npm run desktop:package`（= `build:all` + `desktop:build` + `electron-builder --projectDir electron --config electron-builder.yml`）；`desktop:package:dir` 免安装版。
- `electron/electron-builder.yml`：files 仅 `dist/**`+assets+package.json（**不含后端**——本任务补）；win target=nsis、mac=dmg+zip；输出 `electron/release/`。
- electron main 编译：esbuild bundle（`desktop:build:main` → `electron/dist/main.cjs`）。
- 数据目录内的只读资源：`data/builtin-skills`（`Makefile` 的 `_ensure-builtin-skills` 生成；`src/agent-capability-preview.ts:154`、`src/claude-context-resolver.ts:266` 以 `DATA_DIR/builtin-skills` 引用）——打包时捆入资源、首启播种到 userData（§3-步3）。

## 3. 分步实现计划（每步：改什么文件 + 做什么 + 测试）

### 步 1：DATA_DIR 环境变量覆盖（1 行 + 测试）

- **文件**：`src/config.ts`（:33 一行）
  `export const DATA_DIR = process.env.CKQCLAW_DATA_DIR ? path.resolve(process.env.CKQCLAW_DATA_DIR) : path.resolve(PROJECT_ROOT, 'data');`
- **文件**：`tests/config-data-dir.test.ts`（新）：设/不设 `CKQCLAW_DATA_DIR` 两种解析断言（注意 vitest 内改 env 后动态 import 重新求值，参考仓库既有 env 敏感模块的测试写法）。
- 兼容性：不设变量行为不变（开发模式零影响）。

### 步 2：Electron main 内嵌服务管理器（核心新代码）

- **文件**：`electron/src/main/embedded-server.ts`（新）——可单测的纯逻辑与副作用分离：
  - `resolveEmbeddedLayout({resourcesPath, isPackaged})` → 资源根、后端入口、数据目录（`app.getPath('userData')/data`）、日志目录；
  - `pickPort({preferred})` → 空闲端口（`net.createServer().listen(0)` 探测，`WEB_PORT` 优先）；
  - `buildServerEnv(...)` → `{ELECTRON_RUN_AS_NODE:'1', CKQCLAW_DATA_DIR, WEB_PORT, ...继承 PATH/HOME}`；
  - `startEmbeddedServer()` → spawn `process.execPath [serverDist/index.js]`（cwd=资源根）；stdout/stderr 追加写 userData/logs/server.log；
  - `waitForHealthy(url, {timeoutMs, intervalMs})` → 轮询 `GET /` 至 200/30x，超时返回日志尾部 50 行；
- **文件**：`electron/src/main/index.ts`（改造，最小侵入）：
  - `app.isPackaged === true`（或 `--embedded` 调试开关）走内嵌模式：先起服务 → healthy 后按现有逻辑开窗（serverUrl = `http://127.0.0.1:<pickedPort>`）；非 packaged 保持现状（dev 连 3000）；
  - `before-quit`/窗口全关 → 杀后端进程树（`tree-kill` 语义：mac `SIGTERM` 进程组 / win `taskkill /T`，或后端自身监听父进程退出——执行时选最小方案）；
  - 服务启动失败 → `dialog.showErrorBox` + 日志路径提示后退出。
- **文件**：`tests/embedded-server.test.ts`（新）：纯函数部分（layout/env 构造/端口回退/健康重试时序用假 fetch）全覆盖；spawn 侧不进单测，靠步 6 冒烟。
- 单实例锁：确认现状（main 是否已有 `requestSingleInstanceLock`；330 行内未见则补——避免双击两次拉两个后端抢端口）。

### 步 3：builtin-skills 首启播种

- **文件**：`electron/src/main/embedded-server.ts`（内）：资源目录 `builtin-skills/` → `userData/data/builtin-skills` 不存在则 `fs.cpSync(recursive)`。
- 打包侧由步 4 把 `data/builtin-skills` 放进资源根（见 §3-步4 布局表）。

### 步 4：staging 打包流水线（最大新增，纯脚本）

- **文件**：`scripts/package-desktop.mjs`（新）——现有 `npm run desktop:package` 的编排替换为：
  1. `npm run build:all`（后端 tsc + web vite build + runner tsc）；
  2. 组装 `electron/release/staging/`（**不污染仓库工作树 node_modules**）：
     ```
     staging/
       dist/                        ← 根 tsc 产物（后端）
       web/dist/                    ← 前端产物
       container/agent-runner/dist/ ← runner 产物
       container/agent-runner/package.json + tsconfig（供 npm ci --omit=dev）
       package.json + package-lock.json（根，供 npm ci --omit=dev）
       builtin-skills/              ← data/builtin-skills
     ```
  3. staging 内两次 `npm ci --omit=dev`（根 + agent-runner，`--prefix`）；
  4. **ABI 对齐**：对 staging 的 `node_modules/{better-sqlite3,node-pty}` 与 runner 无（纯 JS）——执行 `npx prebuild-install --runtime=electron --target=39.8.10 --arch=<arm64|x64>`（在两包目录内）；失败回退 `npx electron-rebuild -f -o better-sqlite3,node-pty -d <staging>`（需本机构建工具链，§5-R1）；
  5. 调 `electron-builder --projectDir electron --config electron-builder.yml`（dir 版复用同脚本加 `--dir`）。
- **文件**：`electron/electron-builder.yml`：增 `extraResources: [{from: release/staging, to: server}]`（产物资源根 = `process.resourcesPath/server`）。
- **文件**：`package.json` scripts：`desktop:package` / `desktop:package:dir` 改为调 `node scripts/package-desktop.mjs [--dir]`（其余 desktop:\* 命令不动）。
- 可测性：脚本按仓库惯例（scripts/\*.mjs）为编排代码；关键子步骤函数化，`tests/package-desktop.test.ts`（新）覆盖 staging 布局构造与 ABI 步骤的命令拼装（不真跑 npm ci）。

### 步 5：runner 运行链打通（Electron-as-Node 透传）

- **文件**：`src/container-runner.ts`（hostEnv 构造处，~:2740-2790 区间）：当 `process.env.ELECTRON_RUN_AS_NODE` 存在时把它加入 runner 的 `hostEnv`（使 `resolveHostNodeBinary` 解析出的 Electron 二进制能以 Node 语义执行 pi-index.js）。同时验证 `resolveNodeBinary` 在后端为 Electron-as-Node 进程时 `process.execPath` 候选可命中（读 `src/node-resolver.ts` + 既有测试确认优先级；若 env 覆盖变量更干净则给 embedded main 传该变量并在文档落档）。
- **文件**：`tests/`（扩展 node-resolver 既有测试）：ELECTRON_RUN_AS_NODE 透传断言。

### 步 6：冒烟验收（本机 dir 包全链路）

1. `npm run desktop:package:dir`；
2. 运行 `electron/release/mac-arm64/CKQClaw.app`（**先 `make stop`/关掉 dev，避免 3000 冲突——内嵌模式虽会选新端口，但隔离环境更干净**）；
3. 验证：窗口打开 → 会话/消息正常 → 发「你好」agent 回复（走内嵌后端 + 内嵌 runner）→ `userData/data/db/messages.db` 生成 → 退出 app 后无残留 node 进程；
4. `npm run verify` 六步 + `node scripts/check-scope.mjs` + 提交（`feat: 桌面端 - 内嵌后端服务的一键单机版`）。

## 4. 交付物与文件清单（= .gatescope.json allow，见 §7）

改：`src/config.ts`、`src/container-runner.ts`、`electron/src/main/index.ts`、`electron/electron-builder.yml`、`package.json`（scripts 两行）、`web/package.json`（若 vite base 路径需适配资源托管——执行时验证，大概率不动）。
新：`electron/src/main/embedded-server.ts`、`scripts/package-desktop.mjs`、`tests/config-data-dir.test.ts`、`tests/embedded-server.test.ts`、`tests/package-desktop.test.ts`、`tests/node-resolver-electron-as-node.test.ts`（或并入既有文件）、本文档。

## 5. 风险与对策（按严重度）

| #   | 风险                                                                                 | 概率/影响   | 对策                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| R1  | **原生模块 ABI**：better-sqlite3/node-pty 未按 Electron ABI 安装 → 后端/PTY 首启即崩 | 高/阻塞     | staging 独立 node_modules + prebuild-install electron；冒烟首启即暴露；回退 electron-rebuild；再回退：把 node-pty 相关功能（若为终端类可选特性）标记暂缺——**执行时先确认 node-pty 的运行时调用点**再定 |
| R2  | 资源目录不可写而代码有 cwd 相对**写路径**遗漏（除 DATA_DIR 外）                      | 中/首启失败 | 冒烟全链路 + server.log 落 userData 可诊断；grep `process.cwd                                                                                                                                          | './'` 写路径清单复查（步 2 执行时做） |
| R3  | Windows NSIS 必须在 Windows/CI 打包                                                  | 确定/流程   | mac 本机只验 dmg/dir；exe 打包另排（用户提供 Windows 环境 或 GitHub Actions；CI 属宪法第 6 条需单独批准，不在本任务内）                                                                                |
| R4  | 端口冲突/双实例                                                                      | 中/体验     | 内嵌模式动态选端口 + requestSingleInstanceLock                                                                                                                                                         |
| R5  | 后端优雅退出不干净（子进程残留）                                                     | 中/可感知   | before-kill 进程树 + 冒烟检查无残留；后端已有 SIGTERM 处理则简化（执行时确认 src/index.ts 信号处理）                                                                                                   |
| R6  | 包体积大（Electron + 双 node_modules ≈ 250MB+）                                      | 确定/可接受 | 非目标不做裁剪；记录实测值                                                                                                                                                                             |
| R7  | 未签名包安全提示（mac Gatekeeper / Win SmartScreen）                                 | 确定/文档   | README/发布说明写「右键打开/更多信息」；签名公证列遗留                                                                                                                                                 |
| R8  | `desktop:package` 命令语义变更影响既有习惯                                           | 低          | 保留 `--server-url` 远程模式不变；提交信息说明                                                                                                                                                         |

## 6. 执行顺序与门禁

1→2→3→4→5 依次实现（步 2 可与步 4 的脚本骨架并行，但串行最稳）；每步 TDD；步 6 收口。
门禁照旧：`npm run verify` 六步 + `node scripts/check-scope.mjs` + 每任务一提交（本任务单提交；若步 4/5 过大经用户批准可拆两提交）。

## 7. 建议 .gatescope.json（用户确认计划后由执行会话落档）

```json
{
  "task": "任务S - Electron内嵌后端的一键单机版（路线B，用户 2026-11-09 批准，计划见 docs/task-s-desktop-embedded-server-plan.md）",
  "base": "<开工前 HEAD>",
  "allow": [
    "src/config.ts",
    "src/container-runner.ts",
    "electron/src/main/index.ts",
    "electron/src/main/embedded-server.ts",
    "electron/electron-builder.yml",
    "scripts/package-desktop.mjs",
    "package.json",
    "tests/config-data-dir.test.ts",
    "tests/embedded-server.test.ts",
    "tests/package-desktop.test.ts",
    "tests/node-resolver-electron-as-node.test.ts",
    "docs/task-s-desktop-embedded-server-plan.md"
  ]
}
```
