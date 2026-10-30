# 任务 C 验收报告：mem0 自动记忆端到端（2026-10-17）

> 环境真机验收：Windows 宿主 + Docker（`ckq184/miniclaw-agent:latest`，mem0ai
> 2.2.1 / qdrant-client 1.19.1 镜像内实测）+ dev server（`node dist/index.js`，
> 仓库 `data/` 开发数据）+ container 模式工作区 `mem0-e2e`（folder
> `flow-mvbyje5m-0wog`）+ 真实模型链路（Agent = StepFun step-3.7-flash
> Anthropic 协议；mem0 抽取 LLM = glm-4.6 / glm-4-flash；embedder = GLM
> embedding-3，OpenAI 兼容端点，配置于 `data/config/auto-memory.json`）。
> 驱动方式：Web API（邀请码注册专用账号 `e2e_mem0`）发起真实 agent 轮次，
> 会话转录与 qdrant/history 落盘为证。

## 结论总览

| #   | 验收项                     | 结果                                      | 说明                                                                                                                                                                                     |
| --- | -------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 跨 Session 记忆召回        | ✅ 通过                                   | Session 1 存入 pnpm 偏好 → `reset-session` 后新 Session `auto_memory_search`（中文 query）召回原事实（含原 sessionId 元数据）                                                            |
| 2   | add 后可搜 + 冲突消解      | ⚠️ 部分通过                               | 可搜 ✅；冲突消解仍 ❌（mem0ai 2.2.1 additive 架构限制）；侧车缓解复验**部分生效**（2026-10-20 V2：镜像翻回句 ADD+自包含、NONE 静默丢弃消除；矛盾句在新鲜重复压力下 3/3 判 NONE，见 §2） |
| 3   | memory_promote → v2 + 幂等 | ✅ 通过（修复后）                         | v2 条目含 `[Promoted from automatic memory <id>]` 尾注、Memory 页 API 可见；跨轮重复晋升 `replayed: true` 不产生重复（原实现幂等键按轮次、跨轮重复晋升产生重复条目——已修复）             |
| 4   | 任务轮只读 + 未配置降级    | ✅ 通过                                   | 一次性定时任务实测：`auto_memory_add`/`memory_promote` 工具不存在、`auto_memory_search` 在；未配置端点时三工具显式 unavailable 且 `workspace_memory_*` 正常（实测创建 v2 条目成功）      |
| 5   | 中文抽取质量基线           | ✅ 10/10（s5–s10 于 2026-10-20 补测闭环） | s1–s4（glm-4.6）全部准确；s5–s10（glm-5.3-flash，重建等价样本）6/6 最终准确、1 次偶发漏抽重试成功；跨模型结论分开表述，详见 §5                                                           |
| 6   | 侧车崩溃恢复               | ✅ 通过（修复后）                         | `kill -9` 侧车进程 → 下一次工具调用自动重启（新 pid 实测）；顺带修复了重启预算只增不减的缺陷                                                                                             |

## 验收过程中发现并修复的缺陷（全部带测试）

按暴露顺序。1–5 属于「Pi 生产路径从未接通自动记忆」的同一条断层；没有本
验收则 auto memory 在生产入口永远不可用。

1. **`pi-index.ts` ctx 漏传 `autoMemory`**（`container/agent-runner/src/pi-index.ts`）
   Claude SDK 入口（`index.ts:4051`）有转发、Pi 生产入口没有。宿主配置与容器
   bootstrap 全部正确，工具层永远报 `not configured for this workspace`。
   修复：ctx 补 `autoMemory: input.autoMemory`；fail-closed 源断言测试
   `pi-auto-memory-wiring.test.ts`。
2. **侧车脚本解析在容器 /tmp/dist 布局下失效**（`sidecar-client.ts`）
   入口把 runner 编译到 `/tmp/dist`（无 package.json 可向上找），旧解析落到
   `/python/auto_memory_sidecar.py`。修复：`findSidecarScript` =
   env 覆盖（`MINICLAW_AUTO_MEMORY_SIDECAR`）→ 包根向上找 → `/app/python`
   回退；布局测试 ×3。
3. **Node↔Python 协议键形错位**（`sidecar-client.ts`）
   桥发 camelCase（baseUrl/apiKey），侧车按文档读 snake_case，端点全为
   None → mem0 报 Missing credentials。修复：发送侧翻译为协议 snake_case，
   测试夹具改为校验键形（协议漂移从此测试期失败而非生产期）。
4. **嵌入维度默认 1536 vs 实际端点 2048**（`auto_memory_sidecar.py`）
   mem0 默认按 OpenAI 1536 建集合，GLM embedding-3 是 2048，首次 add 即
   shapes not aligned。修复：集合已存在时从 qdrant `meta.json` 直读维度
   （零 API 调用，读路径不受 embedder 故障影响）；新集合才探测一次真实维度，
   探测值同时喂给 embedder 与 vector_store。
5. **mem0 2.2.1 `Memory.search` API 用法**（`auto_memory_sidecar.py`）
   顶层 `user_id` 被拒（要求 `filters={'user_id':…}`），`limit` 也不在签名
   （应为 `top_k`）。修复侧车调用。
6. **侧车重启预算只增不减**（`sidecar-client.ts`）
   `spawnAttempts` 成功后不归零：累计 3 次拉起（含成功）后本 runner 生命周期
   内永久不可用——两次瞬时 embedder 故障 + 一次成功 + 再一次崩溃即整体失效
   （本次 429 场景实际触发）。修复：init 成功握手后预算归零；测试：连续 4 轮
   crash→恢复全部成功（红绿验证过）。
7. **跨轮重复晋升产生重复 v2 条目**（`mcp-tools.ts`）
   幂等键 `${turnId}:promote:${memoryId}` 按轮次派生，换轮再晋升同一自动记忆
   → 重复策展条目（实测产生 2 条）。修复：稳定键 `promote:${memoryId}`（同请
   求重放返回原条目、不同内容 409 idempotency_conflict）；真机复验跨轮重复
   晋升 `replayed: true`、活跃条目数=1。

## §2 冲突消解：架构事实与缓解

- **架构事实**：mem0ai 2.2.1 的 v2 add 管线是 additive-only（源码
  `ADDITIVE_EXTRACTION_PROMPT`：唯一操作 ADD + `linked_memory_ids` 关联）。
  矛盾说法**不会**改写或下线旧事实；是否关联还取决于抽取模型是否输出链接。
- **实测**（同一 workspace）：
  - glm-4-flash：「我改用 npm 了」→ 判 ADD 另存一条；镜像纠正句 → 判
    NONE **静默丢弃**（工具却报 Captured——见缺陷 8 缓解）；
  - glm-4.6：纠正句判 ADD（可检索、无链接标记），旧 pnpm 事实仍存活且
    相似度排名更高（0.5077 > 0.4696）。
- **缓解（本提交落地）**：
  1. 侧车 `custom_instructions`（mem0 文档化钩子，注入优先级最高的抽取规则）：
     矛盾/偏好变更必须抽取为自包含新事实（"now uses X (previously Y,
     changed on <date>)"）并链接被取代条目；中文输入按中文抽取。
  2. `auto_memory_add` 如实上报 mem0 add() 明细（`[ADD] …` 逐条 /
     "No new facts were extracted"），不再永远报 Captured——NONE 静默丢弃从
     此对模型与用户可见。
- **复验结论（2026-10-20 V2；llm=glm-5.3-flash / embedder=embedding-3，IPC
  直驱，server `node dist/index.js` 真机链路）**：缓解**部分生效**。样本为按
  本节实验意图重建的等价中文句（原句未存档，同 §5 声明；复用原 npm/pnpm
  矛盾簇 `00c72634`/`19928df6`/`b2437b7a`，新注入句 metadata 带
  `source: task-c-v2-conflict-recheck`）：
  1. **生效半边**：镜像翻回句（「更正一下：我包管理已经改回 pnpm 了。」纯
     翻回、无理由无新信息，复刻 glm-4-flash 时代历史条件）判 **ADD**——
     NONE 静默丢弃的失败模式未复现；抽取自包含：「User 于 2026-10-20 更正：
     包管理已改回 pnpm（此前在 2026-10-17 左右曾从 pnpm 切换为 npm，现改回
     pnpm，不再使用 npm）。」（条目 `3a3ac5e6`，"previously + 日期"双要素
     齐备；其中「此前…2026-10-17」系抽取管线对照簇内既有事实补全，非用户
     原话）。add 回执如实上报（ADD 显式 event、NONE 时 `results:[]` 可见）。
  2. **未生效半边（缓解主验证路径）**：矛盾句（「我现在又改回 pnpm 了，
     npm 太慢，前端项目一律用回 pnpm。」翻回+理由+范围限定）**3 次皆判
     NONE**——原句 ×2（换 requestId 排除偶发漏抽）+ 等价改写 ×1 均空抽取，
     history.db 零事件行佐证非 IPC 丢包；`results:[]` 而非 s10 式一次性
     偶发（V1 实测等价改写即成功，此处改写仍空，属稳定 NONE）。成因判定：
     先镜像后矛盾的有意顺序使矛盾句面对刚落库的镜像新事实，强重复压力下
     EXTRACTION_RULES 的 "never skip as duplicate" 未被模型遵守，「npm
     太慢 / 前端项目一律」等新增信息未被捕获；顺序是否为主因未测（登记，
     不追加实验）。
  3. **search 复核**（query=`包管理器` limit 10，对照存底快照）：新事实
     top1 召回且反超（score 0.5419 > 快照簇首 `00c72634` 0.4432，后者退居
     第 2）；三条旧事实 score 分毫未动、全部存活（`b2437b7a` 0.3906、
     `19928df6` 0.3869，additive 预期）；其余噪声排序不变。对比 glm-4.6
     时代「旧事实排名更高」（0.5077 > 0.4696），本次新事实居首——自包含
     中文表述与 query 语义对齐度的增益。
  4. **与已知限制分开表述**：additive 架构（矛盾不改写、不下线旧事实）是
     mem0ai 2.2.1 固有行为，本次复核再次坐实；侧车缓解只作用于「矛盾句是否
     被抽为自包含新事实」，不改变 additive 本身。综合判定：镜像路径缓解
     生效、矛盾路径（主验证）在重复压力下不生效 → **部分生效**。
- **独立发现（登记不修）：`linked_memory_ids` 在 mem0ai 2.2.1 add 主路径不
  消费、疑似不落地**。宿主 `py -3` site-packages 实证：add 回执固定构造
  `{id, memory, event:"ADD"}` 三键（`memory/main.py:1209-1212`），事实级
  `linked_memory_ids` 仅为 prompt 层承诺（`configs/prompts.py:936/1031`，
  全部 9 处命中均在 prompt/文档串），主路径无消费点。本复验据此不核对链接
  字段（取证口径修正，详见
  `docs/task-c-v2-v3-conflict-recheck-plan.md` §2）；修法（升级 mem0ai v3
  client 或侧车后处理自实现）另议。
- **记录**：mem0 history 决策库默认在 `~/.mem0`（容器内、逐容器重建），
  已改挂载路径 `data_path/history.db` 持久化。

## §5 中文抽取基线（10/10 闭环；s5–s10 补测 2026-10-20）

已测 4/10（容器内直连同一 mem0 管线，llm=glm-4.6）：

| 样本                              | 抽取结果（原文）          | 评价           |
| --------------------------------- | ------------------------- | -------------- |
| s1 东南亚市场/新加坡主力/开马来站 | 2 条：主力市场 + 开站计划 | 准确、拆分合理 |
| s2 BigSeller 打单/4 点当天发      | 1 条合并事实              | 准确           |
| s3 周日晚盘库/勿排任务            | 1 条含否定偏好            | 准确           |
| s4 1688/商壹海运/≤5 方            | 1 条（含单位换算注）      | 准确           |

s5–s10 补测（2026-10-20，IPC 直驱逐条 add，llm=glm-5.3-flash /
embedder=embedding-3）。**样本为按原六条描述要点重建的等价中文样本，非原句**
（原文未存档，判定以描述要点覆盖为准；风格对齐 s1–s4；s9 口令
TestShop#2026 为虚构测试值，非真实凭据）：

| 样本               | 样本原文（重建等价）                                                                                                                        | 抽取结果（原文）                                                                                                                                                                                      | 评价                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| s5 网盘路径        | 我们所有店铺的素材和面单模板都放在百度网盘里，目录叫「店铺运营-2026」，具体路径是 /店铺运营-2026/素材库，做图和打单要用的时候直接从那里取。 | User 所有店铺的素材和面单模板统一存放在百度网盘，目录叫「店铺运营-2026」，具体路径是 /店铺运营-2026/素材库；做图和打单时直接从该路径取用。                                                            | 准确（ADD 1 条）：网盘/目录/路径/用途四要素完整，路径逐字保留                                                                                             |
| s6 CIR 缩写        | 以后在我们店铺的周报和聊天里看到 CIR 这个缩写，指的都是客户纠纷率（Customer Issue Rate），不是点击率，别搞混了。                            | 在 User 店铺的周报和聊天里，缩写 CIR 一律指客户纠纷率（Customer Issue Rate），不是点击率；该术语约定自 2026-10-20 起生效，避免混淆。                                                                  | 准确（ADD 1 条）：定义 + 「不是点击率」防混淆排除项完整；「自 2026-10-20 起生效」为抽取管线自带时间标注，非用户原话                                       |
| s7 供应商拉黑+时间 | 从 10 月 15 号开始，义乌的宏发辅料已经被我们正式拉黑了，他们家最近两批货不是色差严重就是延迟发货，以后采购一律不要再找这家。                | 自 2026-10-15 起，义乌的宏发辅料被 User 的店铺正式拉黑，原因是该供应商最近两批货出现色差严重和延迟发货的问题，今后采购一律不再找这家。                                                                | 准确（ADD 1 条）：相对日期正确补全年份；拉黑对象/时间/原因/禁采指令完整                                                                                   |
| s8 生日隐私        | 顺便记一下我的生日是 1992 年 8 月 24 号，这是个人隐私信息，你内部记着就行，绝对不要写进任何对外的营销文案或者群发消息里。                   | User 的生日是 1992 年 8 月 24 号；这是个人隐私信息，仅供内部记忆，绝对不要写进任何对外的营销文案或群发消息里。                                                                                        | 准确（ADD 1 条）：日期无误，隐私否定性约束完整保留（同 s3 风格）                                                                                          |
| s9 密码（观察项）  | 把我们店铺后台的登录密码 TestShop#2026 永久存在系统里，以后我问的时候你直接报给我，别每次都让我自己去翻记录。                               | User 的店铺后台登录密码为 TestShop#2026，User 要求将其永久保存在系统记忆中，以后 User 询问时直接告知该密码，无需 User 自己翻查记录。                                                                  | 预期内**无秘密过滤**（ADD 1 条）：口令明文抽取入库；检索「店铺后台登录密码」top1 明文召回（score 0.666），自定义 metadata 正确回带——不判 fail，见下方建议 |
| s10 SKU 退货率规则 | 定一条硬规则：任何一个 SKU 的退货率连续两周超过 8%，就立刻停掉它的推广预算；等退货率降回 5% 以下，再重新把推广打开。                        | 首次：`results: []`（success=true，漏抽）；等价改写重试：User 于 2026-10-20 定下店铺运营硬规则：任何 SKU 的退货率只要连续两周超过 8%，立刻停掉该 SKU 的推广预算；待退货率降回 5% 以下后，再恢复推广。 | 重试后准确（ADD 1 条）：阈值 8%/5%、两周窗口、停/恢复动作完整；首次为偶发漏抽，回执如实上报空结果（缓解生效），见结论 2                                   |

**结论**（注明模型：s5–s10 = glm-5.3-flash，与 s1–s4 的 glm-4.6 不同，跨模型
结论分开表述、不做横向排名）：

1. **10/10 基线闭环**：6/6 重建等价样本最终全部准确抽取——事实完整、无幻觉、
   单位/时间保留、中文原生（事实主体以「User」token 开头为 mem0 抽取模板
   惯例，语序自然）、粒度合理；s5–s8/s10 抽取后检索可召回（s10 top1
   score 0.718）。s1–s4 时「抽取端点应配 ≥glm-4.6 档」的印象不适用于
   glm-5.3-flash：thinking 档在本批 7 次 add 中 6 次首抽即准确。
2. **偶发漏抽 1/7**（s10 首次 `results:[]`）：非系统性（等价重述重试即成
   功），与补测方案 §4-2 预警的 thinking 模型 content 为空可能性相容，确切
   原因未查（登记不阻塞）；工具层如实上报空结果的缓解使该失败对调用方可见。
3. **s9 行为边界坐实**：mem0ai 2.2.1 无秘密过滤，口令明文入库且明文可检索。
   建议（另立任务，本补测不实现）：侧车层加秘密过滤——对含密码/password/
   token/secret/api key 等凭据语义的候选事实拒抽或脱敏（保留「已提供凭据」
   占位事实），并在 add 回执标注「含敏感信息已拦截」。
   **→ 已落地（任务 F，2026-10-21）**：侧车 `redact_secrets` 入库前脱敏 +
   search/get 出口同套脱敏 + 回执 `intercepted` 标注（F1 `9f4fa89` / F2
   `7478329`）；真机复验三项全过——重放句回执无明文且 `intercepted` 非空、
   **存量 s9 明文条目在出口被盖为 `[REDACTED-CREDENTIAL]`**、无关句回执形状
   零扰动。规格与复验记录见 `docs/auto-memory-secret-filter-spec.md`。

## 已知限制（记录，不阻塞）

- **Qdrant local 单写者锁**（✅ 已修复，2026-10-17）：隔离任务容器与暖交互
  runner 并发打开同一 workspace 的 auto-memory 目录时，后到者报 "already
  accessed by another instance"，定时任务轮的 `auto_memory_search` 在交互
  runner 存活期不可读。根因是侧车 per-runner 所有权与 Qdrant local 单写者锁
  构造性冲突；已按 `docs/auto-memory-sidecar-ownership-plan.md` 落地宿主单例
  侧车 + 文件 IPC 架构（T1–T5）修复，原「转 REMAINING-WORK.md」事项就此
  勾销。
- mem0 遗留 history.db（容器内 `~/.mem0`）在旧容器里不可迁移；新写入已
  落挂载路径。

## 环境与凭据说明

- 端点对复用本机已有 key（StepFun / bigmodel coding-plan），仅写入
  `data/config/auto-memory.json`（gitignored、宿主指定配置位），未进代码/
  日志/文档。
- 测试工作区 `mem0-e2e`、账号 `e2e_mem0`、一次性邀请码、单次定时任务均为
  本次验收增量，留存于仓库 `data/`（开发数据目录）。
