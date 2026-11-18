# 任务立项：死代码第一档清理（64d6d7b 之后的残余）

> 立项日期：2026-11-18｜base：`4379013`｜状态：已获用户批准（先审计→选定第一档→严格复核后再确认立项并应用）
> 前序：`dead-code-sqlite-prune-plan.md`（提交 64d6d7b）之后的残余死代码；本任务只做经多方法交叉验证的"确认死"第一档。

## 1. 背景结论（只读审计 + 严格复核）

1. **审计方法**：用仓库自带 `typescript` 的 findReferences 判定每个导出的真实使用方（含 `tests/`），再用 `tsc --noUnusedLocals` 找局部死符号与死导入，最后全仓 `git grep -w` 复核。未引入任何新依赖。
2. **第一档（本任务范围）**：
   - 后端 `src/`：`feishu.ts` 末尾 `@deprecated` 全局单例块（`_defaultInstance` 从未被赋值）、`types.ts` 末尾 Billing 类型区、`runtime-config.ts` 死函数与类型及其连带死声明、`db.ts` / `channel-mount-service.ts` / `middleware/auth.ts` / `schemas.ts` / `wechat-crypto.ts` / `web-context.ts` / `config.ts` / `index.ts` / `file-manager.ts` / `routes/config.ts` 的零引用导出与局部死函数；约 45 处未使用导入。
   - runner：`types.ts`、`utils.ts`、`workspace-memory-context.ts` 的零引用声明；`channel-prefixes.ts` 副本整文件（无任何 import）及其三处同步配置；5 处未使用导入。
   - web：`LoadingSpinner` 组件（仅被 barrel 重导出）、`DateSection` 类型。
   - shared：`image-detector.ts` 的 `detectImageMimeTypeFromBase64`（各副本均零使用），并同步到副本。
3. **严格复核（四种独立方法，结论一致）**：① 含 `docs/`、`tests/`、`scripts/` 的全仓词级 grep；② 隔离副本应用补丁后对 `src/` + `tests/` 做类型检查，前后诊断集一致（无新增、无提及被删名字）；③ 动态加载排查——项目模块无 `import * as` 命名空间导入、无计算键访问，runner 唯一动态 import（`mcp-tools.ts` → `image-detector`）用的是保留的 `detectImageMimeTypeFromBase64Strict`；④ Git 历史——被删符号均无近期新增，皆为 64d6d7b / billing 裁剪 / plugins 裁剪删除其调用方后变孤儿，或自基线起未变。
4. **与保留清单对照**：`task-thesis-lite-plan.md` 附录保留 `channel-prefixes`（src 与 shared 双份），本任务只删 runner 副本，不触 src 与 shared；裁决 #2「砍 billing 订阅体系」与删除 Billing 残留类型一致。

## 2. 误报修正（不按误报执行）

- `qq-streaming-card.ts` 的 `lastAuxFlushTime` / `AUX_FLUSH_INTERVAL` / `buildAuxPrefix`：头部注释明确是为将来带外通道**有意保留的休眠钩子**——**保留**。
- 有调用方的函数参数（`container-runner.ts` 的 `registeredJids`、`index.ts` 的 `senderImId`、`qq.ts` 的 `isResume`、`routes/agents.ts` 的 `imGroup`、`pi-runner.ts` 的 `containerInput`）与 `db.ts` 迁移代码里的回调参数 `p`：删除需改签名与全部调用点，属重构而非死代码——**保留**。
- `shared/` 三个文件在后端程序里显示"不可达"：它们是同步源，设计如此——**保留**。
- `web/src/components/ui/*` 约 27 个未使用的 shadcn 子组件导出：脚手架惯例——**保留**。
- `tests/` 中两处 mock 仍含 `MAIN_GROUP_FOLDER`：无害残留，不在本任务范围。

## 3. 已确认裁决

1. 范围仅限第一档（确认死）；第二档（仅被测试保活的代码，如 `src/file-text-extractor.ts`、runner `ipc-delivery.ts` 一批函数、`db.ts` 若干任务函数）**另案**，需逐项确认并连带删测试。
2. 删除后连带暴露的死声明（`MAX_DIR_DEPTH`、`CURRENT_CONFIG_VERSION`、`ClaudeProviderMode`、`ClaudeStoredProfileResolved`、`buildOfficialClaudeProviderConfig`）与新增的未使用导入，属同一批死代码的残余，一并清理。
3. 顺带修正两处会悬空的注释：`middleware/auth.ts`（提到已删的 `parseCookie()`）、`wechat.ts`（提到已删的 `uploadMediaFile`）。
4. 不引入 lint / noUnusedLocals 等配置变更；不 push。

## 4. 实施步骤（立项 1 提交 + 实现 1 提交）

| 步骤 | 内容                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | 立项提交（本文档 + `.gatescope.json`，base=`4379013`）                                                                                                                                |
| 1    | 后端：删 `feishu.ts` 单例块、`types.ts` Billing 区与全部确认死导出/局部函数；`tsc --noUnusedLocals` 迭代到收敛（保留项除外）                                                          |
| 2    | runner / web / shared：删零引用声明与 `LoadingSpinner`、runner `channel-prefixes.ts`；同步改 `Makefile`、`sync-stream-event.sh`、`check-stream-event-sync.sh`；运行 `make sync-types` |
| 3    | 修正两处悬空注释                                                                                                                                                                      |
| 4    | `npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过 + `refactor:` 提交（不 push）                                                                                         |

## 5. 风险清单

| #   | 风险                                                 | 缓解                                                                                          |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | 误删被动态引用的符号                                 | 已排查：无命名空间导入、无计算键访问；`image-detector` 的 Strict 导出未动；tsc + 构建闭合校验 |
| 2   | 测试里引用被删类型（tsc 与 vitest 都不检查测试类型） | 已用隔离副本对 `tests/` 做前后类型诊断对比，无新增                                            |
| 3   | runner 副本删除后同步脚本把文件拷回或门禁误报        | 同步改三处配置；`check-stream-event-sync.sh` 纳入 `make typecheck` 链，必须通过               |
| 4   | 与主仓 `shared/` 同步结构出现差异                    | 已知取舍：本仓两份副本语义不变；主仓如需对齐由其属主决定                                      |
| 5   | 删除连带暴露新的未使用符号                           | 每轮 tsc 收敛，直至仅剩保留项                                                                 |

## 6. 验证方式

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. 全仓 `git grep -w`：被删符号在代码、文档、脚本中零残留（悬空注释已修）。
3. `tsc --noUnusedLocals --noUnusedParameters` 仅剩第 2 节登记的保留项。
