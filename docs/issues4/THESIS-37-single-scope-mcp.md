# THESIS-37 MCP 单一作用域

| 字段          | 值                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 领取人 / 分支 | —                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 优先级        | P2                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 类型          | 裁减（多用户作用域与按用户存储）                                                                                                                                                                                                                                                                                                                                                                                          |
| 依赖          | THESIS-19、20                                                                                                                                                                                                                                                                                                                                                                                                             |
| 阻塞          | 28 至 31                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 37 行                                                                                                                                                                                                                                                                                                                                                                           |
| 预计改动路径  | `src/mcp-utils.ts`、`src/routes/mcp-servers.ts`、`src/capability-runtime-mutation.ts`、`src/capability-lock.ts`、`src/container-runner.ts`、`src/agent-capability-preview.ts`、`src/agent-profile-policy.ts`、`src/agent-builder.ts`、`web/src/pages/McpServersPage.tsx`、`web/src/components/mcp-servers/**`、`web/src/utils/mcp-servers.ts`、`web/src/stores/mcp-servers.ts`、`tests/**`、`web/tests/**`、`docs/API.md` |
| 需用户决策    | 否（方案 P8、P9 已定）                                                                                                                                                                                                                                                                                                                                                                                                    |
| 来源          | 方案 P8、P9、§8.3                                                                                                                                                                                                                                                                                                                                                                                                         |

## 目标

MCP 只有一个列表、一份存储：`data/mcp-servers/servers.json` 与 `secrets.json`。"系统 MCP / 个人 MCP"两个作用域、成员可见性（`memberAccess`）、伪用户 `system` 全部删除。旧的两份存储不再读取，不写搬迁（方案 P8）。

## 现状（`607d1b6`）

- 存储：`data/mcp-servers/{userId}/` 与伪用户 `data/mcp-servers/system/`（`src/mcp-utils.ts:59` 起；`system` 在 :331、:414–415 与 `src/routes/mcp-servers.ts` 178–179、316）。
- 可见性层（约 170 行）：`memberAccess`、仅管理员系统 MCP、成员只读视图——`src/mcp-utils.ts` 11、23–24、46–56、330–340、414–431；`src/routes/mcp-servers.ts` 182–188、249–288、385–405、480–482、555–580；`src/agent-capability-preview.ts` 184–255、295–299；`src/agent-profile-policy.ts` 115–123；`src/container-runner.ts` 514–523、672–678；`src/agent-builder.ts` 231–233。
- 作用域机制（后端约 200 行）：分层与"个人优先"合并（`src/mcp-utils.ts` 433–474）、`scopeOwnerId`/`requestedScope`（`src/routes/mcp-servers.ts` 173–180）、遍历所有用户（291–310）、合并 GET（313–334）、按作用域失效运行时（`src/capability-runtime-mutation.ts` 24–27、57–77）、`system` 锁键（`src/capability-lock.ts:12`）。
- 前端（约 155 行）：`McpServersPage.tsx` 56–57、128、215–259，`AddMcpServerDialog.tsx` 34–48、137–166，`McpServerCard.tsx` 70–75，`McpServerDetail.tsx` 63–66、149–154，`web/src/utils/mcp-servers.ts`，`web/src/stores/mcp-servers.ts` 12–66。
- `agent_profiles.runtime_policy.mcp.ids` 里存的是带 `system:`/`user:` 前缀的引用（`src/mcp-utils.ts` 443–444 有不带前缀的兼容解析）。
- 测试：`tests/routes-mcp-server-isolation.test.ts`（389，43–306 为多用户）、`tests/mcp-servers-frontend.test.ts`（300，双作用域）、`tests/mcp-runtime-secret-boundary.test.ts` 268–394。

## 非目标

- 保留宿主机 `~/.claude` MCP 导入（`src/routes/mcp-servers.ts` 796–921），导入目标改为单一存储；保留工作区 `.mcp.json` 层。
- 保留密钥迁移锁与密钥文件格式（`src/mcp-utils.ts` 81–294，属存储加固，不是多用户）。
- 不改 Agent 档案的存储格式。

## 引用变化（须写进交付记录）

- Agent 档案里带 `system:`/`user:` 前缀的旧引用不再识别。按 CLAUDE.md §5"禁用、删除或缺失的精确选择能力必须让配置失败，不得静默替换"，这些档案会提示 MCP 缺失，需要在档案里重新选择。新写入的引用只用不带前缀的 id。

## 执行前核实

- 只读查看本机数据库 `agent_profiles.runtime_policy`，统计带前缀引用的档案数，写进交付记录（预期都是测试数据）。
- 确认 MCP 名称在单一存储里唯一：新建时重名按现有校验报错。

## 实现步骤（TDD）

1. **Red**：新建、编辑、删除 MCP 都落在单一存储；列表接口只返回一个列表、不含 `scope`/`memberAccess`；宿主机导入写入单一存储；带前缀的旧引用让档案校验失败并给出可读提示；运行时只加载单一存储与工作区层。
2. **Green**：删作用域与可见性代码、伪用户 `system`、按用户循环；前端改单列表。
3. 改写上列测试：多用户部分删除，宿主机导入、密钥边界的单用户部分保留。同步 `docs/API.md` 的 MCP 接口说明。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. `git grep -n -E "memberAccess|requestedScope|scopeOwnerId|'system'" -- src/mcp-utils.ts src/routes/mcp-servers.ts web/src` 只剩否定断言或与 MCP 无关的命中。
3. **人工冒烟（用户）**：添加一个 MCP，给某个 Agent 选上并对话调用；从宿主机 `~/.claude` 导入一次；编辑与删除。

## 风险与回滚

- 合入后本机原来的系统 MCP 与个人 MCP 都不再显示，需要重新添加（方案 P8 已接受）。
- 回滚：`git revert <提交号>`。

## 交付记录

（待填）
