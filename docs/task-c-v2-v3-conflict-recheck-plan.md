# 任务 C 补测 V2+V3：冲突缓解复验与收尾（glm-5.3-flash）

> **文档定位**：任务 C 遗留工作的第二棒交接，取代
> `task-c-deferred-verification-plan.md` §3 的 V2/V3 小节（该文件 V1 已闭环）。
> 相比原方案，本文件含 **V1 补测之后存储层的新事实清单** 与 **一处取证口径
> 修正**（`linked_memory_ids` 在 mem0ai 2.2.1 不进回执、疑似不落地，见 §2）。
> 自包含——新会话只读本文 + `docs/TASK-C-ACCEPTANCE.md` §2/§5 即可动工。
> **建议注入语**：「阅读 docs/task-c-v2-v3-conflict-recheck-plan.md，按任务 V2 开工。」
> **写作时点**：2026-10-20（V1 闭环后）。基线提交：`c8db1e3`（V1 提交，回滚点）。

---

## 0. 一句话结论

在 mem0-e2e 工作区现存的 npm/pnpm 矛盾簇上用 IPC 直驱法复验侧车
`custom_instructions` 冲突缓解（矛盾句是否 ADD+自包含、镜像翻回句是否复现
glm-4-flash 时代的 NONE 丢弃、search 排序变化），结论改写
`docs/TASK-C-ACCEPTANCE.md` §2 待办小节；随后 V3 收尾（REMAINING-WORK
勾销挂账 + 全量门禁），任务 C 全部闭环。

## 1. 背景

- **V1 已闭环**（2026-10-20，提交 `c8db1e3`）：中文基线 s5–s10 六条重建等价
  样本 IPC 直驱补测，6/6 最终准确（s10 一次偶发空抽取、重试成功）；s9 坐实
  mem0 无秘密过滤（口令明文入库可检索）；`docs/TASK-C-ACCEPTANCE.md` §5 已
  续写、结论总览行已同步。
- 任务 C 剩两项（即本文 V2/V3）：V2 = TASK-C §2 冲突缓解复验（2026-10-17 被
  embedder 配额阻塞至今）；V3 = 收尾。
- **缓解机制**（TASK-C §2，已在代码中）：侧车
  `container/agent-runner/python/auto_memory_sidecar.py` 的 `EXTRACTION_RULES`
  （经 mem0 `custom_instructions` 注入）：矛盾/偏好变更必须抽为自包含新事实
  （"now uses X (previously Y, changed on <date>)"）并链接被取代条目；中文输入
  按中文抽取。`auto_memory_add` 如实上报 mem0 明细（NONE 显式可见，不再永远报
  Captured）。glm-4-flash 时代失败模式：镜像纠正句判 NONE **静默丢弃**；
  glm-4.6 可抽自包含新事实但无链接标记。

## 2. 现状关键事实（动工前必读）

| 事实 | 位置/值 |
|---|---|
| 测试工作区 | `mem0-e2e`，folder `flow-mvbyje5m-0wog`，container 模式；V2 全程无需登录/agent 轮（IPC 直驱） |
| 侧车数据目录 | `data/extra/flow-mvbyje5m-0wog/auto-memory/`（qdrant 集合 2048 维 + history.db） |
| 端点配置 | `data/config/auto-memory.json`：llm=glm-5.3-flash（bigmodel `/api/paas/v4`）、embedder=embedding-3；成对配置；侧车在 (re)spawn 时读取（TTL 默认 10 分钟或重启 server） |
| **V2 测试床：npm/pnpm 矛盾簇** | 3 条（英文表述，早于侧车中文抽取规则）：① `00c72634-e833-4192-8cb6-657b34070a7b`「User prefers using pnpm … does not use npm」（2026-10-17T05:56Z）；② `19928df6-c661-4950-a0ec-0506db859daf`「User switched from using pnpm to using npm … around October 17, 2026」（06:00Z，已是自包含表述）；③ `b2437b7a-c7b9-44d1-908e-206e3ff5741d`「User prefers using npm … never uses pnpm」（06:08Z） |
| 簇外参照（判读时按 metadata 隔离） | V1 样本 6 条（`dadade6f`/`91ffcf39`/`86241c7c`/`b50b8ae6`/`cf11a4c7`/`65e2cdc9`，metadata `{sample, source:"task-c-v1-baseline"}`）+ T6 期 2 条（`84288d30` Vitest 偏好、`186193d5` T6 召回链路）。簇条目 metadata 是 `sessionId/turnId`，一眼可分 |
| **取证口径修正（相对原方案 V2）** | **add 回执不可能出现 `linked_memory_ids`**：宿主安装的 mem0ai 2.2.1（`py -3` site-packages）add 主路径响应项固定构造 `{id, memory, event:"ADD"}`（`memory/main.py:1209-1212`）；全包检索显示事实级 `linked_memory_ids` 只有 prompt 承诺（`configs/prompts.py:936/1031`），**主路径无任何消费点**（其余命中全在 entity store 旁路与 `client/main.py` 的 v3 文档串）——「链接被取代条目」在 2.2.1 很可能根本不落地。**V2 缓解判定以可观测面为准**：① 矛盾句 event=ADD（不被 NONE 丢弃）；② 抽取文本自包含（「previously/之前」语义 + 日期）；③ search 复核召回与排序。链接半边作为独立发现登记（修法 = 升级 mem0ai v3 client 或侧车后处理自实现，均非本任务范围） |
| IPC 直驱协议 | server 在跑时写 `data/ipc/flow-mvbyje5m-0wog/tasks/<任意名>.json`：add = `{"type":"auto_memory","operation":"add","messages":[{"role":"user","content":"<文本>"}],"metadata":{...},"requestId":"<合法id>","timestamp":"<ISO>"}`；search = `{"type":"auto_memory","operation":"search","query":"<≤500字>","limit":10,"requestId":"..."}`。`requestId` 限 `[A-Za-z0-9_-]+`。轮询同目录 `auto_memory_result_<requestId>.json`（server 每 2s 扫描；处理后删除请求文件；**回执文件超 10 分钟会被自动清理——拿到就读并归档到仓库外**）。宿主 handler=`src/auto-memory-ipc.ts` |
| 回执形态（V1 实测） | add = `{"success":true,"result":{"results":[{"id","memory","event"}]}}`；**`results:[]` = NONE/漏抽**（如实上报缓解生效的体现）；search = `{"success":true,"result":[{id,memory,hash,metadata,score,created_at,user_id,attributed_to},…]}` |
| 延迟与可靠性参考（V1 实测） | add 10–35s（thinking 模型），search 2–5s；**偶发空抽取 1/7**——`results:[]` 时换 requestId 重试一次再定性（两次皆空才是模型判 NONE） |
| server 启动 | dist 须与 src 一致（`npm run build` 幂等，incremental tsbuildinfo）；`node dist/index.js` 后台启动 → `http://127.0.0.1:3000/api/health` 返回 200；测完停进程 |
| embedder 冒烟（开工前必做） | 内联 python 读 `data/config/auto-memory.json` 取 baseUrl/key（**key 不回显不落任何文档**）POST `/embeddings`，期望 200 + 维度 2048；中断即停不做半截结论 |
| 环境坑（不要再踩） | Windows `python3` 是 WindowsApps stub（exit 49）——用 `py -3`；mem0ai==2.2.1 已装宿主 `py -3`；spaCy stderr 告警是噪音；Docker Desktop 本机常驻运行中（写作时点实测），**IPC 直驱不经容器**（宿主单例侧车 + qdrant local + 直连端点），若 server 启动报容器错误再查 Docker（装在 `D:\CKQ\DockerDesktop`）；V1 会话的驱动脚本在 `%TEMP%\zcode-v1\`（临时目录可能已清，按上文协议重写约 40 行：写请求→轮询回执→归档打印即可） |
| 门禁基线 | 全量 vitest 失败**文件集合**与基线对比法（约 37 个预存失败文件是基线不是回归）；双侧 typecheck（root `npm run typecheck` + `cd container/agent-runner && npx tsc --noEmit`）；`npm run docs:check`。注意 `npm test` 默认 watch，跑全量用 `npm test -- --run` |

## 3. 任务拆解（回滚点 = `c8db1e3`，每任务一提交）

### V2 冲突缓解复验（预计半天）

- **范围**：仅测试 + `docs/TASK-C-ACCEPTANCE.md` §2 待办改写；不改代码。
- **样本说明**：原句未存档，按 TASK-C §2 的实验意图**重建等价中文样本**
  （同 V1 先例，交付时明示）；措辞可微调，但须保持两个意图类不变。
- **步骤**（全部 IPC 直驱；顺序与原方案相反——先镜像后矛盾，保证镜像句
  判读时簇未被新事实污染，属有意的测试设计修正）：
  1. `search 包管理器`（limit 10）**存底快照**：记录三簇条目 + 噪声的现状排序
     与 score。
  2. **镜像翻回句**（复刻 glm-4-flash 时代判 NONE 静默丢弃的历史条件：纯翻回
     旧偏好、无理由无新信息，对簇内旧 pnpm 条目产生重复压力）：
     「更正一下：我包管理已经改回 pnpm 了。」
     → 观察判 ADD 还是 NONE；`results:[]` 时换 requestId 重试一次区分偶发漏抽
     与真 NONE；无论结果，核对回执**如实性**（空就是空，不报 Captured）。
  3. **矛盾句**（缓解主验证：翻回 + 理由 + 范围限定）：
     「我现在又改回 pnpm 了，npm 太慢，前端项目一律用回 pnpm。」
     → 核对回执：event=ADD；表述自包含（含「previously/之前」语义 + 日期）。
     **不核对 `linked_memory_ids`**（2.2.1 回执不带，见 §2 取证口径修正）。
     建议 metadata 带 `{"source":"task-c-v2-conflict-recheck"}` 便于事后区分。
  4. `search 包管理器` **复核**：新事实可召回；旧事实仍存活（additive 架构
     预期）；排序变化（新事实是否反超旧事实，对照步骤 1 快照）。
- **验收**：`docs/TASK-C-ACCEPTANCE.md` §2 末尾「待办」bullet（「缓解效果的
  真机复验被 embedder 配额阻塞…」）改写为复验结论——缓解生效/部分生效/不
  生效 + 证据（回执与 search 原文摘录、score 对比）；**「链接不消费」作为
  独立发现单列**（附 §2 的源码证据行）；缓解结论与 mem0ai 2.2.1 additive
  架构已知限制分开表述；注明 glm-5.3-flash 模型与重建样本声明。提交
  `test:` 前缀。

### V3 收尾（预计 1 小时）

- **范围**：`docs/REMAINING-WORK.md` 勾销挂账 + 全量门禁；不改代码。
- **REMAINING-WORK.md 三处**：
  1. 「状态快照」中任务 C bullet（「…遗留两项待配额恢复…」）——改为全部
     闭环，列 V1（`c8db1e3`）与 V2（V2 提交号）两个提交与结论指向；
  2. 「任务 C」小节顶部状态注（「…补测方案自包含落档
     `docs/task-c-deferred-verification-plan.md`…」）——改为指向
     `docs/TASK-C-ACCEPTANCE.md` §2/§5 的最终结论；
  3. 「建议顺序」中任务 C 相关条目（「任务 C 的配额依赖补测」等）——标记
     完成（该小节第 3 条 Qdrant 单写者锁已在 TASK-C「已知限制」勾销，核对后
     保持一致）。
- **全量门禁**：
  1. 全量 vitest：`npm test -- --run`，收集**失败文件集合**，与基线对比——
     不一致时 checkout 回滚点 `c8db1e3` 复跑同法对比，若集合相同则差异为
     本链路引入（按任务 C 模式缺陷报告 + 带测试修复、单独提交），相同则为
     预存基线漂移（如实记录）；
  2. 双侧 typecheck（root + `container/agent-runner`）；
  3. `npm run docs:check`。
- **提交**：`docs:` 前缀（含 REMAINING-WORK 改写与门禁结果记录）。V1 已按
  `test:` 前缀单独提交（`c8db1e3`），勿合并。

## 4. 风险与缓解

1. **矛盾/镜像句触发与 s10 同款偶发空抽取**（V1 实测 1/7）——`results:[]`
   一律先换 requestId 重试一次再定性；若两次皆空且句子明显含事实，在结论中
   如实记录（可能是 thinking 模型 content 为空，见原补测方案 §4-2，登记不修）。
2. **镜像句与簇内 `b2437b7a`（npm 偏好）近乎重复**——这正是历史 NONE 失败
   模式的成因（翻回句对旧 pnpm 条目产生重复压力）；缓解规则要求 never skip
   as duplicate，因此 ADD 与 NONE 都是有效测量点，如实记录即可，不算测试
   失败。
3. **V2 会再加 1–2 条矛盾记忆，簇噪声增大**——mem0-e2e 为专用测试工作区，
   可接受；**不做清理**（delete 属侧车内部能力且会破坏 additive 证据链）。
4. **embedder 配额再次耗尽**——开工前冒烟探测；中断即停，不做半截结论。

## 5. 非目标

- 不改 mem0ai 版本（链接不消费只登记，修复另议）、不改侧车 stdio 协议、
  不动 Workspace Memory v2 与 `memory-service.ts`/`memory-store.ts`。
- 不实现秘密过滤（V1 s9 的建议已记录在 TASK-C §5，方案另议）。
- 不做抽取质量的多模型横向评测（只测当前生产配置 glm-5.3-flash）。
- 不改审批/门禁/工作流代码；发现与本任务无关的缺陷只登记不修。
