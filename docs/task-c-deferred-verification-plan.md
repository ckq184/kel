# 任务 C 挂账补测方案：中文基线 s5–s10 + 冲突缓解复验（glm-5.3-flash）

> **文档定位**：任务 C（mem0 真实端到端验收）遗留两项外部阻塞工作（embedder
> 配额当时耗尽）的补测交接。自包含——新会话只读本文 + `docs/TASK-C-ACCEPTANCE.md`
> §2/§5 即可动工，无需任务 C 或侧车所有权会话的上下文。
> **建议注入语**：「阅读 docs/task-c-deferred-verification-plan.md，按任务 V1 开工。」
> **状态（2026-10-20）**：V1 已闭环（提交 `c8db1e3`，结论见
> `docs/TASK-C-ACCEPTANCE.md` §5）；V2/V3 已移交并修订为
> `docs/task-c-v2-v3-conflict-recheck-plan.md`（含 V1 后存储新事实与
> `linked_memory_ids` 取证口径修正），本文件 §3 的 V2/V3 小节仅供追溯。
> **写作时点**：2026-10-20。基线提交：`082e884`（回滚点）。
> **与任务 C 的差异**：抽取 LLM 已从 glm-4.6 换为 **glm-5.3-flash**（运行时配置，
> 2026-10-20 用户裁定），embedder key 已更换（embedding-3，2048 维，2026-10-20
> 真机验证可用）。补测结论代表当前生产配置，与 s1–s4（glm-4.6）对比时须注明
> 模型不同。

---

## 0. 一句话结论

用 IPC 直驱法（不依赖对话模型）对 mem0-e2e 工作区补测中文抽取基线余下 6 条
样本（s5–s10，按 TASK-C §5 描述重建等价样本），并在现存 npm/pnpm 矛盾簇上
复验侧车 `custom_instructions` 冲突缓解效果；结论续写进
`docs/TASK-C-ACCEPTANCE.md` §5/§2 并勾销 `docs/REMAINING-WORK.md` 挂账。

## 1. 背景

- 任务 C §5：中文基线 10 条只测了 s1–s4（glm-4.6，全部准确），s5 起 embedder
  429（bigmodel embedding 资源包耗尽）中断。余 6 条描述：**网盘路径、CIR 缩写、
  供应商拉黑+时间、生日隐私、密码拒存、SKU 退货率规则**；其中 s9（密码类）用于
  观察 mem0 **无秘密过滤**的行为边界。
- 任务 C §2：mem0ai 2.2.1 v2 管线 additive-only（矛盾不改写旧事实），已落侧车
  缓解（`custom_instructions` 强制矛盾句抽为自包含新事实 + `linked_memory_ids`
  链接；中文按中文抽取），缓解效果当时被配额阻塞未复验。glm-4-flash 时代还有
  「镜像纠正句被判 NONE 静默丢弃」的失败模式待观察。
- 2026-10-20 侧车所有权修复（`docs/auto-memory-sidecar-ownership-plan.md`，T6
  ✅）后宿主单例侧车全链路真机验证通过，**llm（glm-5.3-flash）/embedder
  （embedding-3）/对话模型（StepFun /anthropic）三者均可用**，本补测解除阻塞。

## 2. 现状关键事实（动工前必读）

| 事实 | 位置/值 |
|---|---|
| 测试工作区 | `mem0-e2e`，folder `flow-mvbyje5m-0wog`，container 模式；账号 `e2e_mem0`（member） |
| 侧车数据目录（container 模式） | `data/extra/flow-mvbyje5m-0wog/auto-memory/`（qdrant 集合 2048 维 + history.db） |
| 端点配置 | `data/config/auto-memory.json`：llm=glm-5.3-flash（bigmodel `/api/paas/v4`）、embedder=embedding-3；**llm+embedder 必须成对**，改后 30s 缓存过期生效；侧车在（re)spawn 时读取（TTL 默认 10 分钟或重启） |
| 存量记忆（不再干净） | npm/pnpm 矛盾簇 3 条（`00c72634…` pnpm、`19928df6…` 切换、`b2437b7a…` npm 偏好）+ T6/复验新增若干（Vitest 偏好等）——抽取质量判定以 **add 回执**为准即可隔离噪声；矛盾簇正好是 V2 的测试床 |
| **IPC 直驱法（推荐）** | server 在跑时写 `data/ipc/flow-mvbyje5m-0wog/tasks/<id>.json`：`{"type":"auto_memory","operation":"add"\|"search"\|"get",...,"requestId":"<合法 id>","timestamp"}`，轮询同目录 `auto_memory_result_<id>.json`（add 回执含逐条抽取结果+event；requestId 限 `[A-Za-z0-9_-]+`）。宿主 handler= `src/auto-memory-ipc.ts` |
| Agent 轮法（可选补充） | `POST /api/auth/login`（cookie 会话）→ `POST /api/messages`；密码临时文件可能已被清理，重置模式：bcryptjs 更新 `data/db/messages.db` users 表（参考 2026-10-20 会话做法，临时脚本用完即删、明文不落 repo） |
| 环境坑（不要再踩） | Docker Desktop 需先启动（本机装在 `D:\CKQ\DockerDesktop`）；Windows `python3` 是 WindowsApps stub（exit 49）——宿主侧车解释器解析已处理（env > `py -3` > `python3`）；mem0ai==2.2.1 已装宿主 `py -3`；spaCy stderr 告警是 mem0 可选依赖噪音，忽略 |
| 开工前冒烟 | 先直连探测 embedder 200 + 维度 2048（`POST {embedder.baseUrl}/embeddings`），再跑批量，避免配额再次中断造成半截结论 |
| 门禁基线 | 全量 vitest 失败**文件集合**与 stash/checkout 对比法（约 37 个预存失败文件是基线不是回归）；双侧 typecheck（root + `container/agent-runner`）；`docs:check` |

## 3. 任务拆解（回滚点 = 上一任务提交）

### V1 中文基线 s5–s10 补测（预计半天）

- **范围**：仅测试 + `docs/TASK-C-ACCEPTANCE.md` §5 续表；不改代码。
- **样本**：原文未存档（已核查 docs 与会话转录），按 §5 六条描述**重建等价中文
  样本**（风格对齐 s1–s4：真实电商/店铺运营口吻的中文陈述，专有名词保留原文），
  在交付报告中明示「重建等价样本，非原句」。
- **做法**：逐条 IPC 直驱 `add`（每条独立 requestId），从回执判定，与 s1–s4 同
  一评分口径：抽取准确（事实完整、无幻觉、单位/时间保留）、中文原生、粒度合理。
- **s9 特别项**：密码类样本记录 mem0 行为边界——预期**无秘密过滤**（原文/哈希
  可能入库），如实记录检索表现，不作为 fail；若确被抽取，评估是否需要侧车层
  秘密过滤规则（只提建议，不在本任务实现）。
- **验收**：§5 续表 6 行（样本原文、抽取结果原文、评价）+ 结论行（注明
  glm-5.3-flash 模型）；10/10 基线闭环（s1–s4 为 glm-4.6，跨模型结论分开表述）。

### V2 冲突缓解复验（预计半天）

- **范围**：仅测试 + `docs/TASK-C-ACCEPTANCE.md` §2 待办勾销；不改代码。
- **做法**（全部 IPC 直驱，工作区现成矛盾簇）：
  1. `search 包管理器` 存底（现状排序/共存的基线快照）；
  2. `add` 一条矛盾句（如「我现在又改回 pnpm 了，npm 太慢」），核对回执：
     event=ADD、表述自包含（含「previously/之前」语义 + 日期）、`linked_memory_ids`
     是否链接被取代条目（缓解机制的核心验证点）；
  3. `add` 一条镜像纠正句（glm-4-flash 时代被判 NONE 静默丢弃的失败模式），
     观察 glm-5.3-flash 下是否仍被丢弃（回执如实性：工具层已改为如实上报
     "No new facts were extracted"，确认该缓解在真机生效）；
  4. `search` 复核：新事实可召回、旧事实仍存活（additive 架构预期）、排序变化。
- **验收**：§2「待办」小节改写为复验结论（缓解生效/部分生效/不生效 + 证据）；
  结论与 mem0ai 2.2.1 additive 架构的已知限制分开表述。

### V3 收尾（预计 1 小时）

- **范围**：`docs/REMAINING-WORK.md`（状态快照与任务 C 小节勾销挂账、指向补测
  结论）、任务 C 文档（V1/V2 已写入）；全量门禁。
- **门禁**：全量 vitest 失败文件集合 = 基线；双侧 typecheck；`docs:check`。
- **提交**：每任务一提交（`test:`/`docs:` 前缀，Conventional Commits）。

## 4. 风险与缓解

1. **样本为重建等价文本**（原文未存档）——不可与 s1–s4 逐字对比，判定以 §5
   描述要点覆盖为准；交付报告明示。
2. **glm-5.3-flash 是 thinking 模型**：抽取延迟/tokens 高于 4.6。2026-10-20 已
   真机验证 add 管线正常（`[ADD]`、中文自包含抽取），风险低；若批量中出现
   content 为空导致抽取失败，如实记录（可能需要 mem0 调用层适配
   reasoning_content，届时按任务 C 模式：缺陷报告 + 带测试修复，单独提交）。
3. **embedder 配额可能再次耗尽**：开工前冒烟探测；中断即停，不做半截结论。
4. **存量记忆噪声**：V1 判定以 add 回执为准（隔离）；V2 利用噪声簇作测试床。

## 5. 非目标

- 不改 mem0ai 版本、不改侧车 stdio 协议、不动 Workspace Memory v2 与
  `memory-service.ts`/`memory-store.ts`。
- 不实现秘密过滤（s9 只观察记录，方案另议）。
- 不做抽取质量的多模型横向评测（只测当前生产配置 glm-5.3-flash）。
- 不改审批/门禁/工作流代码；发现与本补测无关的缺陷只登记不修。
