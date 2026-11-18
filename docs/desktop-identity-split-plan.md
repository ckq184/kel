# 任务立项：桌面端身份拆分（本仓与 Personnal-agent-main 双开互不干扰）

> 立项日期：2026-11-18｜base：`64d6d7b`｜状态：已获用户批准

## 1. 问题

两仓（本仓 Personnal-agent-thesis 与 Personnal-agent-main）的 Electron 桌面端身份完全相同：

- `appId` 均为 `cc.ckqclaw.desktop`、`productName`/`APP_NAME` 均为 `CKQClaw`；
- `app.setName('CKQClaw')` → userData 同为 `~/Library/Application Support/CKQClaw/`；
- `requestSingleInstanceLock()` 锁键基于 userData 路径 → 后启动的实例拿锁失败 `app.quit()`，只把先启动的旧窗口唤起到前台——用户双击任一仓的 `start-desktop.command` 看到的都是同一个桌面端。

## 2. 方案（最小改动：仅改本仓，主仓保持 CKQClaw 身份不动）

本仓身份改为 `CKQClaw Thesis`：

| 文件                                                  | 改动                                                                                                                                                                       |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron/src/main/index.ts`                          | `APP_NAME = 'CKQClaw Thesis'`（单源驱动 setName→userData→单例锁→窗口标题）；`showAbout`/`errorPageHtml` 文案改用 APP_NAME 模板，消除硬编码双源                             |
| `electron/src/main/menu-template.ts`                  | options 新增必填 `appName`，品牌菜单 label / `About ${appName}` 注入（沿用现有依赖注入模式，名字保持单源）；`CKQClaw on GitHub` 保留——链接指向项目仓库，是项目名不是实例名 |
| `electron/src/main/index.ts`（createApplicationMenu） | 传入 `appName: APP_NAME`                                                                                                                                                   |
| `electron/electron-builder.yml`                       | `productName: CKQClaw Thesis`；`appId: cc.ckqclaw.thesis.desktop`（打包产物名 + macOS bundle id / Windows AppUserModelID 分离，避免安装互顶）                              |
| `tests/electron-menu-contract.test.ts`                | baseOptions 注入 `appName: 'CKQClaw Thesis'`，品牌菜单断言同步                                                                                                             |

不动的：`electron/package.json` name（运行时标识被 `setName` 覆盖，打包名由 productName 决定）；图标（两仓共用同一 icon，Dock 中靠应用名区分；换图标超出最小范围）；start-desktop 脚本（端口属主校验已就位）。

## 3. 已知影响（用户已知情）

- userData 新目录 `~/Library/Application Support/CKQClaw Thesis/` 从零开始：本仓桌面端**首次启动需重新登录**，窗口状态重置。旧共享目录里的 cookie 正是此前登录循环问题的脏状态来源，不迁移、不删除（主仓继续用它）。
- 两仓可同时运行各自的桌面端，互不抢锁、互不共享 cookie。

## 4. 验证

1. `desktop:typecheck` + `desktop:build` 通过；编译产物 `electron/dist/main.cjs` 含新 APP_NAME
2. 菜单契约测试通过（vitest 单文件）
3. userData 分离冒烟：短暂拉起 Electron（指向不存在的后端），确认新 userData 目录被创建
4. `npm run verify` + `node scripts/check-scope.mjs`
