# THESIS-01 桌面端裁除

| 字段          | 值                                                                                                                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                                            |
| 领取人 / 分支 | `claude/thesis-01-desktop-removal`                                                                                                                                                                                                                                                |
| 优先级        | P1                                                                                                                                                                                                                                                                                |
| 类型          | 裁剪（整模块）                                                                                                                                                                                                                                                                    |
| 依赖          | 无。与其他 issue 没有文件交集，任何时候都可以并行                                                                                                                                                                                                                                 |
| 阻塞          | 无。先做可以让 THESIS-10 的核实项 V-E7（桌面壳对登录的依赖）直接失效                                                                                                                                                                                                              |
| 可并行        | ✅ 02、03、04、05、06、07、08、09、10、11、12、15。⚠️ 13（`AGENTS.md`、`README.md` 改相邻行）。❌ 14（按 D-F1 ① 最后单独执行）（口径见 [README 第三节](README.md)）                                                                                                               |
| 预计改动路径  | `electron/**`、`start-desktop.command`、`start-desktop.bat`、`restart-dev.command`、`package.json`、`package-lock.json`、`.gitignore`、`web/vite.config.ts`、`README.md`、`AGENTS.md`、`docs/desktop-identity-split-plan.md`（按 D-G1）、`tests/electron-*.test.ts`、新增契约测试 |
| 需用户决策    | **是**：D-G1、D-G2、D-G3                                                                                                                                                                                                                                                          |
| 来源          | 方案 §10（用户 2026-11-24 改裁，条件"删后仍能访问本地文件"已核实成立）                                                                                                                                                                                                            |

## 目标

删掉 Electron 桌面端，改用浏览器访问：生产模式 `http://127.0.0.1:3001`，开发模式 `http://127.0.0.1:5174`。文件上传下载、工作区文件面板、宿主机目录挂载、Agent 读写文件全部照常。

## 范围（锚点为 `d6e04aa`）

| 部分              | 内容                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 桌面端源码与配置  | `electron/` 目录 8 个文件（源码 3 个共 417 行、配置 3 个、图标 2 个）                                                                                                                                                                                              |
| 启动脚本          | 删除 `start-desktop.command`（58 行）、`start-desktop.bat`（22 行）；`restart-dev.command` 按 D-G2 处理（桌面端相关约 17 行：:5、:12、:17-18、:46-56、:64-66）                                                                                                     |
| 根 `package.json` | 七条 `desktop:*` 脚本（:25-31）；开发依赖 `electron`、`electron-builder`（:58-59），`esbuild`（:60）按 D-G3；关键字 `electron`、`desktop`（:90-91）；`allowScripts` 的 `electron@39.8.10`、`electron-winstaller@5.4.0`（:97-98），`esbuild` 两条（:99-100）按 D-G3 |
| 零散引用          | `.gitignore:6` 的 `/electron/release/`；`web/vite.config.ts:6-7` 注释里"两仓桌面端可同时运行"的措辞（端口 3001、5174 不变）                                                                                                                                        |
| 测试              | 删除 `tests/electron-menu-contract.test.ts`（126）、`tests/electron-shell-contract.test.ts`（38）                                                                                                                                                                  |
| 文档              | `README.md` 约 26 行（入口列表、截图说明、Electron Desktop 小节、启动说明、命令表）；`AGENTS.md` 3 行（:48-50：技术栈、目录结构、构建产物）；D-G1 涉及的历史文档                                                                                                   |

已核实，不需要改的：网页客户端没有任何 `ckqclawDesktop` 调用，`web/src` 里的 "Desktop:" 只是宽屏布局注释；后端、runner、脚本都不引用 electron；`CLAUDE.md` 和 `docs/API.md` 没有桌面端描述。

## 非目标

- 不改端口 3001 和 5174。
- 文件相关的后端与网页客户端代码不做功能性改动。
- 不动 `docs/dual-desktop-port-isolation-plan.md` 之外的历史交付档（第一轮交付档 §9 的桌面端登录记录保留作历史）。

## 需用户决策（领取前拍板）

| #    | 问题                  | 选项                                                                                                              | 方案默认 |
| ---- | --------------------- | ----------------------------------------------------------------------------------------------------------------- | -------- |
| D-G1 | 两份桌面端历史文档    | ① 删 `docs/desktop-identity-split-plan.md`，留 `docs/dual-desktop-port-isolation-plan.md`；② 两份都删；③ 两份都留 | ①        |
| D-G2 | `restart-dev.command` | ① 去掉桌面端部分，保留重启前后端；② 整个删除                                                                      | ①        |
| D-G3 | 开发依赖 `esbuild`    | ① 连同删除；② 保留                                                                                                | ①        |

## 执行前核实

- **V-G1**：除两条 `desktop:build:*` 脚本外，全仓是否还有地方直接调用 `esbuild`；`allowScripts` 里的 `esbuild@0.28.2` 是否被 vite、vitest 等其他依赖间接需要（删掉后 `npm ci` 的安装脚本会不会被拦）。
- **V-G3**：删掉开发依赖、更新 `package-lock.json` 之后，`make install` 能否通过。
- 删除前对 `electron`、`desktop:`、`start-desktop` 做一次 `git grep`，范围包含 `tests/` 和 `docs/`。

## 实现步骤（TDD）

1. **Red**：新增源码契约用例，断言 `package.json` 不再有 `desktop:*` 脚本，也不再有 `electron`、`electron-builder` 依赖（`esbuild` 按 D-G3），仓库里没有 `electron/` 目录。
2. **Green（依赖与脚本）**：改 `package.json`，执行 `npm install` 更新 lockfile（与第一轮删 `dingtalk-stream` 的做法相同）；按 D-G2 处理 `restart-dev.command`；删除两个启动脚本。
3. **Green（源码与测试）**：删除 `electron/` 和两个测试文件；清理 `.gitignore` 和 `web/vite.config.ts` 的注释。
4. **文档**：同步 `README.md`、`AGENTS.md`，按 D-G1 处理历史文档，跑 `npm run docs:check`。

## 验收条件

1. 仓库里没有 `electron/` 目录，`package.json` 没有 `desktop:*` 脚本和 electron 相关依赖。
2. `make install` 在新 lockfile 下通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
3. **人工冒烟（用户验收）**：启动服务 → 浏览器打开 → 登录 → 上传一个文件 → 在工作区文件面板里打开它 → 让 Agent 读取工作区里的一个文件。主机模式和容器模式各验一次。

## 风险与回滚

- **登录状态改由浏览器管理。** Cookie 不区分端口，本仓和主仓的 cookie 名相同、签名密钥不同，在同一个浏览器里同时登录两个仓库会互相顶掉。演示时用不同的主机名（`localhost` 和 `127.0.0.1`）或不同的浏览器配置文件。
- **回滚**：一到两个提交，`git revert <提交号>`，lockfile 一并回滚。

## 交付记录

- **提交**：`6e3a8af`（立项：拍板、plan、范围声明与状态领取）、`e78869d`（实现：删除桌面端，同步依赖/脚本/文档/契约测试）。
- **验证**：
  - `make install`：新 lockfile 下三侧 `npm ci`（根 / `container/agent-runner` / `web`）+ agent-runner build 全部通过（V-G3）。
  - `npm run verify`：6/6 全绿，总耗时 32.2s；测试 358 文件 2953 通过、23 跳过（2976）。
  - `node scripts/check-scope.mjs`：26 个路径全在 `.gatescope.json` 声明内（交付提交新增 `docs/issues2/task-thesis-trim-plan.md` 的范围扩宽，理由见交付提交信息）。
- **拍板落地**：D-G1 ① 删除 `docs/desktop-identity-split-plan.md`，保留 `docs/dual-desktop-port-isolation-plan.md` 原样（md5 与 HEAD 一致）；D-G2 ① `restart-dev.command` 去掉桌面端启动/等待/日志段，保留前后端重启；D-G3 ① 删除 `esbuild` 直依赖与 `allowScripts` 的 `esbuild@0.25.12`，保留 `esbuild@0.28.2`（tsx 带入）。
- **独立审查**：规格符合性审查结论"有条件通过"——唯一阻塞项是 `make install` 证据缺失（六步门禁不含 `npm ci`），已在交付前实跑并记入本记录；非阻塞建议采纳：契约测试补 lockfile electron 闭包断言、四依赖区段覆盖、allowScripts 前缀断言、README/AGENTS 断言收窄；保留 `exists('electron')` 的工作树强断言与 `esbuild@0.28.x` 显式契约。
- **偏差**：
  - README 实际清理约 45 行（方案估算约 26 行）；删除命令表最宽行后 Prettier 重排了表格列宽。
  - `npm install` 后 `esbuild@0.28.2` 从 `tsx/node_modules` 提升到根 `node_modules`，并同时满足 `vitest` 内嵌 `vite@8.2.1` 的可选 peer；未新增包。
  - 安装时 `npm install-scripts` 对 `@google/genai@1.52.0`（实际 2.21.0）与 `fsevents` 的未覆盖告警为本任务前既有状态，未处理（范围外）。
- **待用户验收**：浏览器冒烟（启动 → 登录 → 上传文件 → 工作区文件面板打开 → Agent 读取工作区文件；主机模式与容器模式各一次）。未做实机验收，不代替用户下结论。
