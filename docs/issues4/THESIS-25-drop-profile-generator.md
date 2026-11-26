# THESIS-25 裁 Agent 档案生成与润色

| 字段          | 值                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                                                            |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                                 |
| 优先级        | P2                                                                                                                                                                                                                                                                                                |
| 类型          | 裁减（功能下线）                                                                                                                                                                                                                                                                                  |
| 依赖          | 无                                                                                                                                                                                                                                                                                                |
| 阻塞          | 无                                                                                                                                                                                                                                                                                                |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 25 行                                                                                                                                                                                                                                                   |
| 预计改动路径  | `src/routes/agent-profiles.ts`、`src/agent-profile-generator.ts`、`web/src/components/agents/AgentPromptAssistant.tsx`、`web/src/pages/AgentProfilesPage.tsx`、`web/src/stores/agent-profiles.ts`、`web/src/api/**`、`tests/**`、`web/tests/**`、`docs/API.md`、`docs/ACL-MATRIX.md`、`CLAUDE.md` |
| 需用户决策    | 否（方案 P5 已定）                                                                                                                                                                                                                                                                                |
| 来源          | 方案 P5、§6                                                                                                                                                                                                                                                                                       |

## 目标

Agent 管理页的"AI 助手"（一句话生成四段 Prompt、对已有 Prompt 润色）下线。手写四段 Prompt 与聊天里的对话式 Agent Builder 保留。

## 现状（`248c7cb`）

- 后端：`POST /api/agent-profiles/generate`（`src/routes/agent-profiles.ts:193`）、`POST /api/agent-profiles/:id/refine-prompt`（:364）；实现 `src/agent-profile-generator.ts`（约 265 行，调用 `sdkQuery`）。
- 前端：`AgentPromptAssistant.tsx`（约 312 行）挂在 `AgentProfilesPage.tsx`；store 里的 `refineProfilePrompt` 等 action（`web/src/stores/agent-profiles.ts`）。
- 测试：`tests/agent-profile-generator.test.ts`；`tests/container-session-permissions.test.ts` 有引用，需核实是否只是顺带。
- 文档：`CLAUDE.md` §9 `RECALL_MODEL` 一行列了"Agent Profile 生成"。

## 非目标

- 不动对话式 Agent Builder（`src/agent-builder.ts`、`agent_profile_*` MCP 工具、`agent_builder_drafts`）。
- 不动 Prompt 版本历史、档案增删改。
- 不动 `sdkQuery`。

## 执行前核实

- `git grep -n -E "agent-profile-generator|refine-prompt|refineProfilePrompt|generateProfile|AgentPromptAssistant" -- src web/src tests web/tests docs` 列全引用。
- `tests/container-session-permissions.test.ts` 里的引用若只是路由清单，删对应条目；若断言了权限行为，保留其余部分。

## 实现步骤（TDD）

1. **Red**：两个接口 404；`web/src` 无 `AgentPromptAssistant` 与对应 store action；档案页其余功能用例保持通过。
2. **Green**：删后端两个路由、生成器模块、前端组件、store action 与专属测试。
3. 同步 `docs/API.md`、`docs/ACL-MATRIX.md`、`CLAUDE.md` `RECALL_MODEL` 说明。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过；THESIS-15 可达性契约通过。
2. **人工冒烟（用户）**：Agent 管理页能新建、编辑、保存四段 Prompt，查看版本历史；在聊天里让主 Agent 起草并发布一个新 Agent 仍可用。

## 风险与回滚

- 回滚：`git revert <提交号>`。

## 交付记录

（待填）
