# THESIS-25 裁 Agent 档案生成与润色

| 字段          | 值                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 已完成                                                                                                                                                                                                                                                                                            |
| 领取人 / 分支 | claude/thesis-25-drop-profile-generator                                                                                                                                                                                                                                                           |
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

- **提交**：`43112bf`（立项）、`b2f89bb`（实现）、`824f839`（审查处置），审查记录与交付随本提交（分支 `claude/thesis-25-drop-profile-generator`，基于 main `48903d0`）。
- **实现**：删除 `src/agent-profile-generator.ts`；删除 `POST /api/agent-profiles/generate`、`POST /api/agent-profiles/:id/refine-prompt` 与三个专属 schema；删除 `AgentPromptAssistant.tsx`、`AgentCreatePanel.tsx`、store 的 `generateProfileDraft`/`refineProfilePrompt` 与三个专属类型；新建入口改为直接进入空白草稿，`?create=1` 经导航守卫请求空白草稿；删除 `AgentPromptEditor` 的“用 AI 优化这一段”与表单 `assistantSection`。保留手写四段 Prompt、Prompt 版本历史、档案增删改、对话式 Agent Builder 与 `sdkQuery` 的其他调用方。
- **验证**：`npm run verify` 六步全绿（370 文件，3031 通过 / 23 跳过 / 0 失败，30.2s）；`node scripts/check-scope.mjs` 23 个路径全在声明范围内；新增两个 404 用例与源码契约在 base 上先失败、实现后转绿；THESIS-15 可达性契约通过；规格审查通过（零阻塞），质量审查通过（Critical 0 / Major 0 / Minor 5）。
- **偏差**：删除 `AgentCreatePanel`，并让“新建/`?create=1`”直接进入空白草稿。该面板的描述、示例与双入口都服务于一句话生成，AI 入口下线后保留面板即为空壳；不改变“手写四段 Prompt 保留”的边界。
- **范围外登记**：`src/agent-profile-prompts.ts` 的 `AGENT_PROMPT_SECTION_MAX_LENGTH`（生成器删除后无生产调用）与 `agentProfilePromptsFromLegacy`（仅测试引用）未清理，`src/schemas.ts` 仍硬编码 `20000`；建议在 THESIS-28 零引用导出清理时处理。
- **未实机验收**：人工冒烟（新建/编辑/保存四段 Prompt、查看版本历史；聊天里让主 Agent 起草并发布新 Agent）待用户在浏览器执行；本环境未启动服务。
