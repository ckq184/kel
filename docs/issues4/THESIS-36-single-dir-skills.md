# THESIS-36 Skills 与 feishu-cli 单一目录

| 字段          | 值                                                                                                                                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 状态          | 待领取                                                                                                                                                                                                                                  |
| 领取人 / 分支 | —                                                                                                                                                                                                                                       |
| 优先级        | P2                                                                                                                                                                                                                                      |
| 类型          | 裁减（按用户存储）                                                                                                                                                                                                                      |
| 依赖          | THESIS-19、20（`src/routes/skills.ts` 的宿主机 Skills 角色判断先删）                                                                                                                                                                    |
| 阻塞          | 28 至 31                                                                                                                                                                                                                                |
| 可并行        | 见 [README 3.1](README.md#31-并行矩阵) 第 36 行                                                                                                                                                                                         |
| 预计改动路径  | `src/routes/skills.ts`、`src/agent-profile-policy.ts`、`src/agent-builder.ts`、`src/agent-capability-preview.ts`、`src/claude-context-resolver.ts`、`src/container-runner.ts`、`src/ipc/skill-registry-ops.ts`、`tests/**`、`CLAUDE.md` |
| 需用户决策    | 否（方案 P8 已定）                                                                                                                                                                                                                      |
| 来源          | 方案 P8、§8.3                                                                                                                                                                                                                           |

## 目标

个人 Skills 存在一个固定目录 `data/skills/`，不再按账号分目录；feishu-cli 的登录状态存在一个固定目录。旧的按账号目录不再读取，不写搬迁（方案 P8）。

## 现状（`607d1b6`）

- `data/skills/{userId}/` 与 `.skills-manifest.json`：路径在 `src/routes/skills.ts:112`、:116、:120 构造；另有 `src/agent-profile-policy.ts:85`、`src/agent-builder.ts:209`、`src/agent-capability-preview.ts:160`、`src/claude-context-resolver.ts` 265–268、`src/container-runner.ts:578` 各一处。`src/routes/skills.ts` 约 85 处只是把用户 id 往下传。
- 派生缓存 `data/agent-profile-runtime/{ownerId}/{profile}/v{N}/skills`（`src/container-runner.ts:615`），里面是指向 `data/skills/{ownerId}` 的符号链接。
- feishu-cli 状态 `data/config/user-cli/{ownerId}/feishu-cli/`（`src/container-runner.ts:1161` 起），读写挂载到容器内 `/home/node/.feishu-cli`。
- 容器里看到的路径（`/workspace/effective-skills/{id}`、`/home/node/.feishu-cli`）都不含用户 id，Runner 不受影响。

## 非目标

- 不动 builtin（`data/builtin-skills`）、宿主机（`~/.claude/skills`）、项目（`container/skills`）、工作区（`.claude/skills`）这几层 Skills。
- 不删磁盘上的旧目录（用户自行处理）。
- 不动 MCP（THESIS-37）。

## 执行前核实

- 只读查看本机 `data/skills/` 下现有子目录，确认新固定目录与旧的按账号子目录不会同名冲突（例如账号 id 恰好与某个 skill 名相同）；冲突时改用 `data/skills/` 下的一个专用子目录并写进交付记录。
- 派生缓存改路径后，确认旧缓存里的符号链接不会被新代码误读。

## 实现步骤（TDD）

1. **Red**：安装、列出、删除一个 Skill 都落在固定目录；Agent 选择该 Skill 后容器内 `/workspace/effective-skills/{id}` 可读；feishu-cli 挂载源为固定路径。
2. **Green**：去掉路径里的用户段与沿途的用户 id 参数。
3. 同步 `CLAUDE.md` §7 的 `data/` 目录树（`skills/{userId}/` 改为 `skills/`）。

## 验收条件

1. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. **人工冒烟（用户）**：在"能力 → Skills"安装一个 Skill，给某个 Agent 选上并对话调用；容器模式与宿主机模式各一次。

## 风险与回滚

- 合入后本机原来按账号安装的个人 Skills 不再显示，需要重新安装（方案 P8 已接受）。
- 回滚：`git revert <提交号>`。

## 交付记录

（待填）
