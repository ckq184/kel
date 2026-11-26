# 任务立项：THESIS-25 裁 Agent 档案生成与润色

> 立项日期：2026-11-26｜base：`48903d0`（main tip，personal-slim v1.1 池合入后）｜分支：`claude/thesis-25-drop-profile-generator`
> 来源：[docs/issues4/THESIS-25-drop-profile-generator.md](issues4/THESIS-25-drop-profile-generator.md)、[personal-slim 方案 P5](issues4/task-personal-slim-plan.md)

## 0. 需求采访结论

- 无新增用户决策：方案 P5 已定“裁掉档案生成/润色，保留对话式 Agent Builder 与档案管理”。
- **完成条件**：`POST /api/agent-profiles/generate` 与 `POST /api/agent-profiles/:id/refine-prompt` 返回 404；`src/agent-profile-generator.ts`、`web/src/components/agents/AgentPromptAssistant.tsx` 及对应 store action 不存在；手写四段 Prompt、版本历史、档案增删改与聊天里的 Agent Builder 不受影响；`npm run verify` 六步全绿、`node scripts/check-scope.mjs` 通过、THESIS-15 可达性契约通过。
- **实现决策（不改变产品边界）**：Agent 管理页“新建”的 AI 一句话生成入口一并下线。原 `AgentCreatePanel` 的内容（角色描述、示例、AI 生成、空白创建）全部服务于该入口，因此删除面板与 `createPanelOpen`/`createDescription` 状态，“新建”与 `?create=1` 直接进入空白草稿编辑；手写四段 Prompt 的入口保留。
- **非目标**：对话式 Agent Builder（`src/agent-builder.ts`、`agent_profile_*` MCP 工具、`agent_builder_drafts`）、Prompt 版本历史、档案增删改、`sdkQuery`（仍有 `/recall`、对话标题、AI 解析定时任务三个调用方）、`RECALL_MODEL` 本身。

## 1. 执行前核实（base `48903d0`）

| 项             | 复核结论                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端引用       | `src/routes/agent-profiles.ts` 导入并挂载 `/generate`（`:193`）、`/:id/refine-prompt`（`:364`）；生成器仅在 `src/routes/agent-profiles.ts` 与 `tests/agent-profile-generator.test.ts`、`tests/routes-agent-profiles.test.ts` 被引用。                                                                                                                                                                                                          |
| 生成器私有依赖 | `AgentProfileGenerateSchema` 与 `AgentProfileRefinePromptSchema` 仅用于这两个路由；`AgentPromptSectionsSchema` 只被 refine schema 使用。`agentProfilePromptsFromLegacy` 另被 `tests/agent-profile-prompts.test.ts` 直接覆盖，保留。                                                                                                                                                                                                            |
| 前端引用       | `AgentPromptAssistant` 仅由 `AgentProfilesPage.tsx` 挂载；`generateProfileDraft`/`refineProfilePrompt` 仅由该页与助手组件调用；store 内的 `AgentProfileDraft`、`AgentPromptChatMessage`、`AgentPromptRefinement` 为专属类型。                                                                                                                                                                                                                  |
| 新建入口       | `AgentCreatePanel` 只被 `AgentProfilesPage.tsx` 使用，内容为 AI 生成/空白创建双入口；`createDescription`、`generatingDraft`、`handleGenerateDraft` 仅服务 AI 生成。                                                                                                                                                                                                                                                                            |
| 锁定测试       | `tests/agent-profile-generator.test.ts`（专题测试，删除）；`tests/routes-agent-profiles.test.ts` 两个接口用例与生成器 mock（改为 404 断言）；`tests/agent-profiles-page-dom.test.tsx` 的助手 mock 与 `generateProfileDraft` mock；`tests/frontend-agent-create-workspace.test.ts`（新建面板源码契约，随新入口改写）；`tests/issue11-compat-and-duplicate-convergence.test.ts` 对 `AgentPromptAssistant.tsx` 的兜底文案抽样（随文件删除移除）。 |
| issue 差异     | issue 称 `tests/container-session-permissions.test.ts` 有引用；base 上 `grep agent-profile\|generator\|refine` 无结果，无需处理。                                                                                                                                                                                                                                                                                                              |
| 文档           | `docs/API.md` 路由清单两行；`CLAUDE.md` §9 `RECALL_MODEL` 一行列有“Agent Profile 生成”；`docs/ACL-MATRIX.md` 只有 `/api/agent-profiles/*` 的通用“登录，仅本人 Agent”边界，本包不改变该边界，预计无需改行。                                                                                                                                                                                                                                     |

## 2. 方案（TDD）

### 2.1 Red

新增 `tests/thesis-25-drop-profile-generator.test.ts`：

1. `src/agent-profile-generator.ts` 不存在；`src/routes/agent-profiles.ts` 不含 `generateAgentProfileDraft` / `refineAgentProfilePrompt` / `'/generate'` / `refine-prompt`。
2. `src/schemas.ts` 不含 `AgentProfileGenerateSchema` / `AgentProfileRefinePromptSchema` / `AgentPromptSectionsSchema`。
3. `web/src/components/agents/AgentPromptAssistant.tsx`、`AgentCreatePanel.tsx` 不存在；`web/src/stores/agent-profiles.ts` 不含 `generateProfileDraft` / `refineProfilePrompt`；`AgentProfilesPage.tsx` 不含 `AgentPromptAssistant` / `generateProfileDraft` / `createDescription`。
4. 保留面：`AgentPromptEditor`、`AgentPromptVersionHistory`、`AgentBuilder` 相关源码仍在。

在 `tests/routes-agent-profiles.test.ts` 增加 `POST /generate`、`POST /:id/refine-prompt` 均返回 404 的用例（base 上应失败），删除生成器 mock 与旧接口行为用例。

### 2.2 Green

1. 删 `src/routes/agent-profiles.ts` 两个路由、生成器 import；删 `src/agent-profile-generator.ts`；删三个专属 schema。
2. 删 `web/src/components/agents/AgentPromptAssistant.tsx` 与 `AgentCreatePanel.tsx`；删 store 的两个 action 与三个专属类型。
3. `AgentProfilesPage.tsx`：删除助手渲染与 `generateProfileDraft` 解构、`handleGenerateDraft`、描述/生成状态；`handleOpenCreatePanel` 改为直接空白草稿，`?create=1` 经导航守卫请求空白草稿；`useAgentProfileForm` 删除 `assistantSection`；`AgentPromptEditor` 删除 `onOpenAssistant` 按钮；`AgentProfilesSidebar` 删除面板状态。
4. `useUnsavedNavigationGuard`：`?create=1` 改为 `requestBlankDraft` 回调；`setDraftMode`/`setCreatePanelOpen` 参数收敛。
5. 删除 `tests/agent-profile-generator.test.ts`；更新 routes/page DOM/新建契约/ISSUE-11 抽样测试。

### 2.3 文档与门禁

- `docs/API.md` 删除两行路由；`CLAUDE.md` `RECALL_MODEL` 删除“Agent Profile 生成”。
- 执行 `git grep -n -E "agent-profile-generator|refine-prompt|refineProfilePrompt|generateProfileDraft|AgentPromptAssistant|AgentCreatePanel" -- src web/src tests web/tests` 只剩否定断言与新契约。
- `npm run format:changed`、`npm run verify` 六步、`node scripts/check-scope.mjs`；THESIS-15 可达性契约随全量测试通过。

## 3. 任务拆解

| #   | 任务       | 主要文件                                                                                | 独立验收                                     |
| --- | ---------- | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| T1  | Red 契约   | `tests/thesis-25-drop-profile-generator.test.ts`、`tests/routes-agent-profiles.test.ts` | 新契约与 404 用例在 base 上失败              |
| T2  | 后端下线   | `src/routes/agent-profiles.ts`、`src/agent-profile-generator.ts`、`src/schemas.ts`      | 两接口 404，生成器与 schema 零出现           |
| T3  | 前端下线   | 助手/新建面板、页面、store、表单 hook、编辑器、侧栏、导航守卫                           | 源码契约通过，手写四段 Prompt 与版本历史仍在 |
| T4  | 测试收敛   | 五个受影响测试文件                                                                      | 删除专题测试，其余断言对应新行为             |
| T5  | 文档与门禁 | `docs/API.md`、`CLAUDE.md`、`.gatescope.json`、issue/README/方案台账                    | verify 六步 + check-scope 通过               |

回滚点：base `48903d0`；实现提交可整体 `git revert`。

## 4. 范围声明（`.gatescope.json` allow）

`.gatescope.json`、`docs/thesis-25-drop-profile-generator-plan.md`、`docs/issues4/THESIS-25-drop-profile-generator.md`、`docs/issues4/README.md`、`docs/issues4/task-personal-slim-plan.md`、`docs/审查记录.md`、`docs/API.md`、`docs/ACL-MATRIX.md`、`CLAUDE.md`、`src/agent-profile-generator.ts`、`src/routes/agent-profiles.ts`、`src/schemas.ts`、`web/src/components/agents/AgentPromptAssistant.tsx`、`web/src/components/agents/AgentCreatePanel.tsx`、`web/src/components/agents/AgentPromptEditor.tsx`、`web/src/components/agents/AgentProfilesSidebar.tsx`、`web/src/hooks/useAgentProfileForm.ts`、`web/src/hooks/useUnsavedNavigationGuard.ts`、`web/src/pages/AgentProfilesPage.tsx`、`web/src/stores/agent-profiles.ts`、`tests/**`、`web/tests/**`。
