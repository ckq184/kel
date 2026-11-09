# 任务 P 立项：桌面端复制粘贴失效排查与修复计划

> **状态**：排查完成，根因已经用户实测确认（菜单栏无 Edit 菜单，见 §3）。2026-11-09 用户拍板执行：修复 + §4.3 清理一并落地；工作树遗留的任务 O 收尾改动 stash 挂起，任务提交后恢复。
> **本文档用途**：交接文档。新会话 Agent 通读本文档 + AGENTS.md 后按 §6 执行，无需重新排查。
> **创建**：2026-11-09。排查会话：ZCode（本地 macOS arm64 环境）。

---

## 0. 一句话结论

macOS 上桌面端 `Cmd+C/Cmd+V` 失效的最大嫌疑（~90%，代码实锤级）：**Electron 应用菜单模板缺少 `editMenu`**——macOS 上渲染进程的复制/粘贴/剪切/全选快捷键依赖应用菜单中的 role 派发，没有 Edit 菜单这些快捷键就是死的。修复 = 模板中加一行 `{ role: 'editMenu' }`。

## 1. 环境与复现

- **平台**：macOS（darwin，arm64，macOS 26.x）
- **运行方式**：开发模式 `npm run desktop:dev`（根 package.json），Electron 39，非打包（`app.isPackaged === false`）
- **加载内容**：`http://127.0.0.1:3000`（后端静态托管 `web/dist`；Vite dev 在 5173 未被桌面端使用）
- **现象**：桌面端窗口内无法复制/粘贴（用户报告，2026-11-09）
- **服务状态**：排查时前后端与桌面端均在运行（后端 3000 健康，桌面端 PID 存活）

## 2. 已完成的排查（代码证据，新会话无需重做）

### 2.1 嫌疑定位：菜单模板无 Edit 菜单 ⭐ 主因

`electron/src/main/index.ts`（`createApplicationMenu()`，行 290-322）：

```ts
const template: MenuItemConstructorOptions[] = [
  ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
  { label: 'CKQClaw', submenu: [About, separator, quit] },  // 自定义菜单
  viewMenu,   // reload / togglefullscreen / toggleDevTools(仅 dev)
  { label: 'Help', ... },
];
Menu.setApplicationMenu(Menu.buildFromTemplate(template));
```

模板中**没有任何** `copy/paste/cut/selectAll` role。macOS Chromium 的这些快捷键经由应用菜单派发——此为 Electron 官方已知行为（FAQ: "Copy paste not working on macOS packaged app"），修复惯例即补 `editMenu`。

### 2.2 已排除/降权的方向

| 方向                                        | 证据                                                                 | 结论                         |
| :------------------------------------------ | :------------------------------------------------------------------- | :--------------------------- | ---------------------------------- | -------- |
| 前端 keydown 拦截 Cmd+C/V                   | `grep metaKey                                                        | ctrlKey × keydown            | preventDefault`于`web/src/` 零命中 | 基本排除 |
| 前端剪贴板 API 实现问题                     | `web/src/utils/clipboard.ts` 为标准 `writeText` + `execCommand` 兜底 | 正常实现；仅影响按钮复制场景 |
| `will-navigate`/`setWindowOpenHandler` 拦截 | 只拦导航与新窗口，与键盘无关（代码审阅）                             | 排除                         |
| sandbox / contextIsolation                  | `sandbox: true` 不影响菜单派发型快捷键                               | 非主因                       |

### 2.3 运行时鉴别验证（执行修复前建议先做，5 分钟）

1. **菜单栏观察**：桌面端顶部菜单栏应只有 CKQClaw/View/Help（无 Edit）→ 直接实锤假设 1。
2. **devtools 验证**：桌面端 `Cmd+Option+I` → 控制台执行选中文本后 `document.execCommand('copy')`；能复制 = 剪贴板链路正常，仅快捷键派发断。
3. **浏览器对照**：Safari/Chrome 开 `http://localhost:5173` 同页面复制粘贴正常 → 锁定问题在 Electron 壳而非前端。
4. 兜底：切英文输入法重试（排除 IME 吞键，可能性 ~1%）。

## 3. 根因假设排序总表

|  #  | 假设                                        | 概率          | 验证方式   | 预期结果                                      |
| :-: | :------------------------------------------ | :------------ | :--------- | :-------------------------------------------- |
|  1  | 应用菜单缺 `editMenu`，macOS 快捷键派发失效 | **已实锤 ✅** | §2.3-1/2/3 | 菜单栏无 Edit；execCommand 可复制；浏览器正常 |

> **验证结果（2026-11-09，用户实测）**：桌面端顶部菜单栏确认**没有 Edit 菜单**——§2.3-1 命中，假设 1 由 ~90% 升级为确认根因。§6 执行时无需重复验证，直接进入步骤 2（立项）。
> | 2 | 前端快捷键拦截 | ~7% | §2.3-3 浏览器对照 | 浏览器正常即排除 |
> | 3 | sandbox 下 `navigator.clipboard` 权限 | ~2% | devtools 跑 `navigator.clipboard.writeText('test')` | 仅当症状为"按钮复制"失败才相关 |
> | 4 | IME/系统权限吞键 | ~1% | 切英文输入法重试 | 切换后正常即相关 |

## 4. 修复方案（用户已要求：确认后才执行）

### 4.1 主修复（最小变更）

`electron/src/main/index.ts` `createApplicationMenu()` 模板中、`viewMenu` 之前插入：

```ts
{ role: 'editMenu' as const },  // cut/copy/paste/selectAll/undo/redo
```

- 跨平台无害（Windows/Linux 不依赖菜单派发，但菜单项仍可用）。
- 不改 preload、不改 web 前端、不改协议。

### 4.2 TDD 配套（宪法第 3 条：确定性反馈优先）

现状：`createApplicationMenu()` 闭包内构造模板，不可测。配套小重构：

- 将模板构造提取为可导出的纯函数，如 `buildMenuTemplate(options: { platform: NodeJS.Platform; isPackaged: boolean }): MenuItemConstructorOptions[]`（执行注：`index.ts` 运行时 import electron，vitest 无法直接导入——提取落在新模块 `electron/src/main/menu-template.ts`（对 electron 仅 type-only import），签名追加 `showAbout` / `openExternalUrl` 两个回调注入以保持模块纯净）；
- 新增契约测试（参照 `tests/electron-shell-contract.test.ts` 模式），断言至少：
  - darwin 与非 darwin 平台的模板均包含 `editMenu` role（或等价 copy/paste role 集合）；
  - 既有行为不回归（View 菜单 reload/togglefullscreen 存在；dev 才有 toggleDevTools）。

### 4.3 可选清理（独立决策，不随主修复默认执行）

darwin 下模板同时含 `{ role: 'appMenu' }` 与自定义 `CKQClaw` 菜单（About/Quit），功能重复（appMenu 已含 About/Quit/Services/Hide），菜单栏会出现两个相近菜单。清理与否由用户单独拍板。

> **决策（2026-11-09，用户拍板）**：附带清理。darwin 下移除自定义 `CKQClaw` 菜单，About/Quit 由 `appMenu` 提供（About 从自定义 dialog 变为系统 About 面板）；非 darwin 平台无 `appMenu`，品牌菜单保留，About/Quit 入口不丢。

## 5. 明确不做的事（范围红线）

- 不动 preload、IPC handler、`webPreferences`（sandbox/contextIsolation 维持现状）；
- 不动 web 前端任何代码（`clipboard.ts` 等已验证正常）；
- 不引入新依赖；
- 不做 §4.3 之外的菜单重构。

## 6. 执行步骤（新会话按序执行）

1. **（可选）运行时验证** §2.3，把结果追加到本文档 §3 表后（若假设 1 被推翻，停止并回报用户）。
2. **立项**：确认 `.gatescope.json` 声明本任务范围（task=p，base=开工前 HEAD；allow 建议仅 `electron/src/main/index.ts`、新增测试文件、本文档）。写法参照既有文件。
3. **TDD**：先写 §4.2 契约测试（红）→ 提取 `buildMenuTemplate` + 加 `editMenu`（绿）。
4. **本地验证**：
   - `npm run desktop:typecheck`
   - `npm test -- --run`（至少跑新增测试与 `electron-shell-contract.test.ts`）
   - 重启桌面端：`make stop` 不适用（那只停 3000）；需 `pkill -f "node_modules/electron"` 后重跑 `npm run desktop:dev`，或用户手动重启
   - 手工验收：桌面端输入框/消息文本 Cmd+C / Cmd+V / Cmd+A / Cmd+X
5. **门禁**：`npm run verify` 全量 + `node scripts/check-scope.mjs`。
6. **提交**：`fix: 桌面端 - macOS 菜单补 editMenu 修复复制粘贴`（Conventional Commits + house style）。push 由用户显式发起。

## 7. 验收标准

- [ ] macOS 桌面端内：选中文本 Cmd+C 可复制、输入框 Cmd+V 可粘贴、Cmd+A 全选、Cmd+X 剪切
- [ ] 顶部菜单栏出现 Edit（编辑）菜单，含 Cut/Copy/Paste/Select All 等项
- [ ] 浏览器端（5173/3000）行为无回归
- [ ] 新契约测试通过；`npm run verify` 六步全绿
- [ ] devtools（dev 模式）与窗口状态保存等既有行为不回归

## 8. 交接说明

- 本文档为唯一上下文来源；工程命令以 `AGENTS.md` §1 / `CLAUDE.md` §10 为准。
- 排查会话未改任何代码；唯一落盘产物 = 本文档（未提交）。
- 若用户在确认时选择附带 §4.3 清理，请将其纳入 allow 范围与测试断言。
- **执行扩宽记录（2026-11-09）**：`tests/scope-check-contract.test.ts` 纳入 allow——任务L dogfood 用例断言 `allow.length > 5`，与任务P 窄范围声明（4 条）冲突；真实验证点（allow 非空、base 合法可解析）保留，阈值修为 `> 0`。
- **预存失败记录（2026-11-09）**：`tests/task-runs-v2.test.ts > notification-only retry state > a late payload gets a fresh retry budget…` 在任务P base（a15d9f5/5310c5d 干净树）即确定性失败（本机 4 次观测同点位；第 5 次 claim 未包 `vi.waitFor`，快机器上循环短于 1s 退避窗即撞 `next_attempt_at`），与本任务改动无关。处置由用户拍板（治理层）。
