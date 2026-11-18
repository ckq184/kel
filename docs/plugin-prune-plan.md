# 任务立项：裁剪 plugins 功能（pi 内核下不可用的 Claude 遗留体系）

> 立项日期：2026-11-18｜base：`19ccd1d`｜状态：已获用户批准
> 本文档为任务立项与实施计划落档，替代已删除的 `docs/claude-code-plugin-automation-design.md` 成为本次裁剪的决策记录。

## 1. 背景与结论

**pi 内核下插件功能确实无法使用，做彻底裁剪。** 证据链：

1. **pi SDK 零 plugin API**：`@earendil-works/pi-coding-agent` 1.3.0 导出面无任何 plugin 概念（其扩展体系叫 Extension，是完全不同的机制）。
2. **本仓库 plugins 是 Claude 时代遗产**：整套为 `@anthropic-ai/claude-agent-sdk` 的 `options.plugins`（→ claude CLI `--plugin-dir`）设计（原 `src/plugin-utils.ts:1-14` 头注释、原设计文档自证）。
3. **生产链路已断**：生产 runner 入口 `container/agent-runner/src/pi-index.ts` 不消费 `ContainerInput.plugins`；唯一消费方是已废弃的 Claude 回滚 runner（`container/agent-runner/src/index.ts`），该文件不在 tsconfig 编译范围（仅 include `pi-index.ts`），且 agent-runner 依赖树中已无 Claude SDK（`docs/runtime-migration.md:123-127`）。
4. **插件子资源逐一判定**：plugin skills 被显式 skip 不物化（`effective-skill-resolver.ts` 依赖不存在的 `options.plugins`）；plugin MCP 只进审计预览不进运行时（`effective-mcp-manifest.ts`）；唯一存活的是 host 层 slash 命令展开（纯文本替换，不过内核）——已裁决一并删除（catalog/导入链删除后展开器无命令来源，保留即死功能）。
5. 本仓库现役扩展通道是 MCP（pi Extension 形态）+ skills 目录加载 + pi-subagents，与 plugins 无关，删除不影响。

## 2. 已确认的范围决策（用户选定）

1. **彻底删除**：含 plugin-expander（slash 命令展开）、命令索引、inline-bash、catalog/导入/物化全套。
2. **本次连同 `data/plugins/` 数据一并删除**（含共享 catalog 快照、各用户启用态 plugins.json、runtime 树；不可恢复，用户已明确授权）。
3. **`'plugin'` 类型字面量彻底收窄**：三副本（shared/stream-event.ts + 两个同步副本）skill 来源联合类型删除 `| 'plugin'`，前端「插件」标签一并删；历史会话审计残留旧记录的展示行为实现时核实。

## 3. 不动的同名撞车（防误伤）

- `web/vite.config.ts` / `web/package.json`（@vitejs/plugin-react）、`web/src/components/chat/MarkdownRenderer.tsx`（KaTeX 注释）、`tests/frontend-pwa-retirement.test.ts`（vite-plugin-pwa）
- `container/agent-runner/src/index.ts` 与 `runtime/claude/`（已废弃回滚参考，不在编译范围，保持原样）；`runtime-mcp-policy.ts` 注释、`stream-processor.ts` SDK 事件透传（实现时核实属主，pi 链路共用则保留）
- `electron/` 零涉及

## 4. 实施步骤（立项 1 提交 + 实现 1 提交）

| 步骤 | 内容                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | 立项提交：本文档 + `.gatescope.json`（base=19ccd1d）                                                                                                                                                                                                                                                                                                                   |
| 1    | 类型契约收窄：`shared/stream-event.ts` 删 `'plugin'`、`container/agent-runner/src/types.ts` 删 `ContainerInput.plugins` 字段；`make sync-types`；typecheck 让残留引用显形                                                                                                                                                                                              |
| 2    | 后端拆除：删 12 个 `src/plugin-*.ts` + `src/routes/plugins.ts` + `config/plugin-deps-override.json`；拆 `web.ts` / `index.ts` / `container-runner.ts` / `db.ts`（updateMessageAttachments，不动 schema）/ `schemas.ts` + `runtime-config.ts`（pluginAutoScan）/ effective-\* / claude-context-resolver / agent-capability-preview / group-queue / web-context 的集成点 |
| 3    | 前端拆除：删 `PluginsPage.tsx`、`stores/plugins.ts`；改 App.tsx / CapabilitiesPage / SettingsPage / SystemSettingsSection / settings/types / types.ts / capability-sources / AgentProfilesPage 文案                                                                                                                                                                    |
| 4    | 测试清理：删 14 个 plugin 专用测试；改 ~10 个部分覆盖测试                                                                                                                                                                                                                                                                                                              |
| 5    | 数据与基建：停服务后删 `data/plugins/`；`Makefile` 备份目录清单、`scripts/backup-manifest.mjs`、`scripts/restore-backup.mjs` 同步                                                                                                                                                                                                                                      |
| 6    | 文档同步（API.md / ACL-MATRIX.md / PROMPT-SKILL-RUNTIME-TEST-PLAN.md / README / CLAUDE.md / SECURITY.md）+ `npm run verify` + `check-scope` + `refactor:` 实现提交（不 push）                                                                                                                                                                                          |

## 5. 风险清单

| #   | 风险                                                                 | 缓解                                                                      |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | `src/index.ts` 61 处触点含消息热路径与 IM ACK 契约，误删破坏消息链路 | 每拆一区即 typecheck；`channel-side-effect-ack-contract.test.ts` 契约兜底 |
| 2   | `'plugin'` 字面量收窄后历史审计记录展示异常（用户已知情选定）        | 实现时逐处核实消费路径                                                    |
| 3   | shared 三副本同步漏改                                                | `make sync-types` + `check-stream-event-sync.sh` 机制化兜底               |
| 4   | `docs:check` 文档与实现一致性                                        | 文档与代码同批完成，verify 机审                                           |
| 5   | `data/plugins/` 不可恢复删除                                         | 用户明确授权；执行前停服务防旧进程重建                                    |
| 6   | verify 全量下少数边缘预算用例可能轮换翻红                            | 已知现象，冷却复测再定性（AGENTS.md 注明）                                |

## 6. 验证方式

1. `npm run verify` 六步全绿
2. `node scripts/check-scope.mjs` 范围核对通过
3. 冒烟：启动后能力页无 plugins Tab、设置页无插件分区、Web 发消息链路正常
4. 全仓 `grep -ri plugin` 复核：仅剩命名撞车白名单与旧 runner 回滚参考
