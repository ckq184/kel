# 任务立项：THESIS-01 桌面端裁除

> 立项日期：2026-11-24｜base：`11eeeae`｜分支：`claude/thesis-01-desktop-removal`
> 来源：[docs/issues2/THESIS-01-desktop-removal.md](issues2/THESIS-01-desktop-removal.md)（方案 §10）

## 0. 需求采访结论（2026-11-24，用户拍板）

- **目标**：删掉 Electron 桌面端，改用浏览器访问（生产 `http://127.0.0.1:3001`，开发 `http://127.0.0.1:5174`）。文件上传下载、工作区文件面板、宿主机目录挂载、Agent 读写文件全部照常。
- **完成条件**：仓库无 `electron/`、无 `desktop:*` 脚本与 electron 相关依赖；`make install` 在新 lockfile 下通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过；用户完成浏览器冒烟（主机/容器各一次）。
- **约束**：端口 3001/5174 不变；文件相关后端与网页客户端代码不做功能性改动；历史交付档保留。

| #    | 问题                  | 拍板                                                                                                                            |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| D-G1 | 两份桌面端历史文档    | ① 删 `docs/desktop-identity-split-plan.md`，留 `docs/dual-desktop-port-isolation-plan.md`（按历史档原样保留）                   |
| D-G2 | `restart-dev.command` | ① 去掉桌面端部分，保留重启前后端（杀 3001/5174 → `dev:all` → 等 `/api/health`）                                                 |
| D-G3 | 开发依赖 `esbuild`    | ① 连同删除直依赖 `^0.25.0` 与 `allowScripts` 的 `esbuild@0.25.12` 条目；`tsx` 仍带入的 `esbuild@0.28.2` 条目保留，lockfile 更新 |

## 1. 关键事实（开工前核实）

- **V-G1（esbuild）**：根目录 `esbuild` 只被 `desktop:build:main`、`desktop:build:preload` 两条脚本直接调用，全仓（含 `tests/`、`docs/`）无其他调用点；`web/` 是独立 npm 项目，自带 Vite 的 esbuild。根 lockfile 中 `esbuild@0.28.2` 是 `tsx@4.22.4` 的依赖（`~0.28.0`），删直依赖后仍在；`vitest` 内嵌 `vite@8.2.1` 把 esbuild 列为可选 peer（`^0.27||^0.28`），当前 `0.25.12` 本就被 npm 标记 invalid，删除不影响 vite。`allowScripts` 在仓库内无消费方，按"lockfile 里仍存在的版本"保守保留 0.28.2。
- **V-G2（文档）**：`CLAUDE.md`、`docs/API.md`、`docs/ACL-MATRIX.md` 无桌面端描述；README 实际桌面端相关约 45 行（方案估算约 26 行，按实际清理），AGENTS.md 3 行（:48-50）。
- **D-G1（文档）**：两份文档各 37/38 行，均无其他文档链接引用；`desktop-identity-split-plan.md` 只讲桌面端身份/userData/单例锁，随桌面端失效；`dual-desktop-port-isolation-plan.md` 的 3001/5174 端口约定在纯网页并排运行时仍成立。
- **D-G2（脚本）**：`restart-dev.command` 66 行，桌面端相关约 17 行；核心价值（杀端口、启动 `dev:all`、等健康检查）与桌面端解耦。
- **测试面**：只有 `tests/electron-menu-contract.test.ts`、`tests/electron-shell-contract.test.ts` 引用 electron 源码，随目录一并删除。
- **其余引用**：`README.md`、`AGENTS.md`、`.gitignore:6`、`web/vite.config.ts:6-7` 注释、`package.json`（脚本/依赖/关键字/allowScripts）；历史文档（`docs/task-thesis-lite-*.md`、`docs/dead-code-review-r2.md` 等）按非目标保留。

## 2. 实现步骤（TDD）

1. **Red**：新增 `tests/desktop-removal-contract.test.ts`，断言 `package.json` 无 `desktop:*` 脚本、无 `electron`/`electron-builder`/`esbuild` 依赖、无桌面端关键字与 `allowScripts` 条目；`electron/` 目录不存在；`start-desktop.command`/`start-desktop.bat` 不存在；`restart-dev.command` 不含 electron/桌面端启动段；`.gitignore` 不含 `/electron/release/`；`web/vite.config.ts` 注释不提桌面端；`README.md`/`AGENTS.md` 不再出现 Electron/桌面端入口。
2. **Green（依赖与脚本）**：改 `package.json`；`npm install` 更新 `package-lock.json`；精简 `restart-dev.command`；删除两个启动脚本。
3. **Green（源码与测试）**：删除 `electron/` 全目录与两个 electron 测试；清理 `.gitignore`、`web/vite.config.ts` 注释。
4. **文档**：同步 `README.md`、`AGENTS.md`；按 D-G1 删除 `docs/desktop-identity-split-plan.md`；`npm run docs:check`。
5. **验证**：`npm run verify` 六步 + `node scripts/check-scope.mjs`；新 lockfile 下跑 `make install`（V-G3）。

## 3. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/issues2/THESIS-01-desktop-removal.md`、`docs/issues2/README.md`、`docs/thesis-01-desktop-removal-plan.md`、`docs/desktop-identity-split-plan.md`、`electron/**`、`start-desktop.command`、`start-desktop.bat`、`restart-dev.command`、`package.json`、`package-lock.json`、`.gitignore`、`web/vite.config.ts`、`README.md`、`AGENTS.md`、`tests/electron-menu-contract.test.ts`、`tests/electron-shell-contract.test.ts`、`tests/desktop-removal-contract.test.ts`。

## 4. 验收条件

1. 仓库无 `electron/` 目录；`package.json` 无 `desktop:*` 脚本与 electron 相关依赖（`esbuild` 按 D-G3 删除）。
2. `make install` 在新 lockfile 下通过；`npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
3. 人工冒烟（用户验收）：启动服务 → 浏览器打开 → 登录 → 上传一个文件 → 在工作区文件面板打开 → 让 Agent 读取工作区文件；主机模式与容器模式各一次。

## 5. 非目标

- 不改端口 3001/5174。
- 文件相关后端与网页客户端代码不做功能性改动。
- 不动历史交付档（`docs/task-thesis-lite-*.md`、`docs/dead-code-review-r2.md` 等）；`docs/dual-desktop-port-isolation-plan.md` 按 D-G1 ① 原样保留。

## 6. 风险与回滚

- **登录状态改由浏览器管理**：cookie 不区分端口，本仓与主仓同名 cookie + 不同签名密钥会互相顶掉；演示时用不同主机名（`localhost`/`127.0.0.1`）或不同浏览器配置。
- **回滚**：实现提交一到两笔，`git revert <提交号>`，lockfile 一并回滚。
