# 任务 F：侧车秘密过滤（Spec v1.1，已闭环）

> **立项来源**：`docs/TASK-C-ACCEPTANCE.md` §5 结论 3（s9 坐实 mem0ai 2.2.1
> 无秘密过滤——口令明文入库且明文可检索，建议另立任务在侧车层加过滤）。
> **写作时点**：2026-10-21。基线提交（回滚点候选）：`03df34f`。
> **状态**：✅ **已闭环（2026-10-21）**——F1 侧车过滤器（`9f4fa89`，TDD 红
> 绿 24/24）→ F2 回执可见性 + vitest 桥接（`7478329`，7/7）→ F3 真机复验
> 三项全过（本文件 §8）+ 收口（本提交）。Spec v1.0 经用户批准后成为目标
> 基线；v1.1 仅收口状态与实现细化登记（见 §3.1 注与 §8），无范围变更。
> **需求采访已确认的四决策**（2026-10-21，用户裁定）：
> ① 处置方式 = **脱敏后存储**（替换秘密值为占位符后仍走 add，mem0 自然抽出
> 「用户提供了凭据（内容未存储）」占位事实）；
> ② 检测范围 = **高精度最小集**（误报率优先控制）；
> ③ search/get 出口侧 = **同套脱敏**（纵深防御，顺带覆盖存量明文）；
> ④ 存量已入库明文 = **不动**（沿用此前「不做清理」裁定；出口侧脱敏盖住其
> 可检索面）。

## 1. 功能目标

在 auto-memory 侧车（`container/agent-runner/python/auto_memory_sidecar.py`，
宿主单例侧车，全部 runner 路径共用）落地**机械强制**的秘密过滤：

1. **入库端**：`add` 调用 `memory.add()` **之前**对输入做凭据检测与脱敏——
   秘密值不进入 mem0 管线（既不落 qdrant/history.db，也不再外发给
   llm/embedder 端点），占位事实保留「凭据存在」语义。
2. **出口端**：`search`/`get` 返回值在侧车侧过同一脱敏器——已入库的存量
   明文不再流回模型。
3. **可见性**：add 回执带 `intercepted` 字段，runner 工具层
   （`summarizeAutoMemoryAddResult`）向模型明示「凭据已脱敏未存储」，
   模型可如实告知用户。

**动机**：工具描述里 "Never store secrets" 是 prompt 层禁令，s9 实测证明
不可强制（用户明确要求存密码时模型照存）；本任务把禁令变为代码层不变量。

## 2. 用户故事

- 作为用户，我对 agent 说「记住店铺后台密码是 X」：系统记住「用户提供了
  店铺后台密码（内容未存储）」，X 不落库、不可被检索，且 agent 明确告诉我
  密码没有存明文。
- 作为运营者，即使某个工作区历史数据里已有明文凭据，`auto_memory_search`
  也不会把它原文带回模型上下文。

## 3. 设计（核心流程）

### 3.1 检测器（纯函数，Python stdlib 正则，预编译）

`redact_secrets(text) -> (redacted_text, findings)`；`findings` =
`[{pattern: <名称>, count: N}, ...]`。**不用 LLM 判定**（秘密不能在判定
阶段外发给任何端点）；纯函数 + 预编译正则，实践中不可抛。

v1 高精度最小集（模式名 → 形态）：

| 模式                | 形态                                                                                                                                                                      | 备注                                   |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------- |
| `keyword_value`     | 凭据关键词（密码/口令/密钥/凭据/password/passwd/pwd/secret/token/api[_ -]?key/apikey/access[_ -]?key/credential，忽略大小写）后跟分隔符（是/为/=/:/：/=>/空白）再跟**值** | 值的收紧规则见下，防「密码政策」类误报 |
| `openai_sk`         | `sk-[A-Za-z0-9]{16,}`（含 `sk-proj-`）                                                                                                                                    | 整体替换                               |
| `bearer`            | `(?i)bearer\s+[A-Za-z0-9._+/=-]{16,}`                                                                                                                                     | 整体替换                               |
| `aws_akid`          | `AKIA[0-9A-Z]{16}`                                                                                                                                                        | 整体替换                               |
| `private_key_block` | `-----BEGIN [A-Z ]*PRIVATE KEY-----` 起的整块（到 END 行或文本尾）                                                                                                        | 整块替换                               |
| `wellknown_token`   | `ghp/gho/github_pat_/xoxb/xoxp/xoxs/AIza` 前缀 + `[A-Za-z0-9_-]{16,}`                                                                                                     | 整体替换                               |

`keyword_value` 的值收紧（高精度的关键）：分隔符后取一段非空白可打印串，
仅当满足其一才算命中——① ASCII 字母数字+符号集（`[!-~]`）长度 ≥6 且含
至少一个数字或符号（挡纯 CJK 误报，如「密码政策」）；② 引号包裹
（`"…"`/`'…'`/`「…」`/`『…』`）且内容 ≥4 字符。**只替换值段**，关键词
保留——脱敏后文本形如「登录密码 [REDACTED-CREDENTIAL] 永久存在系统里」，
抽取模型据此自然产出占位事实。

占位符统一 `[REDACTED-CREDENTIAL]`（ASCII、稳定、抽取模型可读）。

> **实现细化（F1 落地时登记，超出 v1.0 分隔符表字面）**：引号**紧贴**关键词
> 的形态（如「口令「xxx」」）允许零分隔符直接进入值匹配——否则该形态漏拦；
> 代价是「密码『政策文件』」类紧贴引号内容会被脱敏（可接受取舍，与引号
> 形态既有取舍一致）。

### 3.2 注入点（全在侧车 `main()` 各 op 分支）

- **add**：对 `messages[*].content` 与 `metadata` 的全部字符串值（递归）跑
  脱敏器；脱敏后 content 为空串时置为占位符本身（IPC 层要求非空）；然后照常
  调 `memory.add()`。回执：在 mem0 返回的 result dict 上追加
  `intercepted: findings`（无命中时不加该键，保持旧形状）。
- **search / get**：对返回 JSON **递归遍历**，凡字符串值过同一脱敏器
  （命中才替换；uuid/score 等自然不命中）。出口侧命中**不**在回执加标注
  （脱敏静默生效；标注只在 add 端，那里用户有「存了什么」的预期）。
- `delete`/`delete_all`/`ping` 不涉及。

### 3.3 Runner / TS 侧（最小改动）

- `container/agent-runner/src/mcp-tools.ts`：
  - `summarizeAutoMemoryAddResult()`（L464）增加 `intercepted` 分支：命中时
    汇总行追加 `Secret filter: N credential-like value(s) redacted before
storage (plaintext not stored).`（`results:[]` + intercepted 非空的组合
    也要给出一句话，不落回「judged duplicate」误导文案）。
  - `auto_memory_add` 工具描述更新：说明凭据语义内容会被自动脱敏（用户
    可被告知「密码未存明文」），替换现有 "Never store secrets" 的裸禁令
    表述。
- 宿主 `src/auto-memory-ipc.ts` 透传 result，无需改动（未知字段向后兼容）。

## 4. 异常流程

- **脱敏器理论异常**：fail-closed——add/search/get 回 `ok:false` coded
  error（安全特性不允许 fail-open 放行明文）；设计上预编译纯函数不可抛，
  此条为防御兜底。
- **值长度 <6（引号形 <4）**：不判秘密（误报控制，接受短口令漏网——v1
  明示取舍）。
- **误报（非秘密被脱敏）**：接受——占位事实仍保留语义，用户可口头重述；
  模式集按「常见坑表」机制迭代。
- **存量明文**：不迁移不清理（决策④）；出口侧脱敏覆盖其可检索面。

## 5. 验收条件（TDD，先红后绿）

1. **Python 自测模式**：`py -3 auto_memory_sidecar.py --self-test` 以表驱动
   用例（中英文 × 各模式 × 误报对照「密码政策/password policy/sk- 短串/
   纯 CJK 值」× metadata 递归 × 出口递归）校验 `redact_secrets` 与回执
   形状，exit 0/1。
2. **vitest 桥接测试**（新 `tests/auto-memory-secret-filter.test.ts`）：
   spawn `py -3 … --self-test` 断言 exit 0（Windows `py -3`，同
   self-test-agent-runner 先例；host 缺 python 时该测试 skip 并注明）；
   - `summarizeAutoMemoryAddResult` intercepted 分支单测（纯函数，无需
     python；该函数当前零测试覆盖，一并补齐基础分支）。
3. **门禁**：提交前六步全跑（AGENTS.md §1；vitest 失败集 = 38 文件基线）。
4. **真机复验**（IPC 直驱，同 V2 法，mem0-e2e 工作区）：s9 等价句重放 →
   ① 回执 `intercepted` 非空且 `results` 中无明文；② `search 店铺后台
登录密码` 出口无明文（存量 s9 条目被出口侧脱敏盖住）；③ 无关正常句
   add 回执不带 `intercepted` 键（形状不变）。复验结论落
   `docs/TASK-C-ACCEPTANCE.md` §5（s9 建议标记已落地）与本 Spec 状态行。

## 6. 非目标

- 不做配置开关 / 白名单 / 每工作区差异（v1 恒开）。
- 不改 mem0ai 版本与 stdio 协议形状（`intercepted` 为新增可选字段）。
- 不做存量清理（决策④）。
- 不做 LLM 语义级检测（秘密不得在判定阶段外发）。
- 不动 Workspace Memory v2（`memory-service.ts`/`memory-store.ts`）与
  `memory_promote` 链路。
- 不覆盖侧车日志外的宿主日志面（侧车本就不打内容日志）。

## 7. 任务拆解（每任务一提交，回滚点 = 开工前 HEAD）

| #   | 内容                                                                         | 提交前缀 |
| :-- | :--------------------------------------------------------------------------- | :------- |
| F1  | 侧车脱敏器 + `--self-test` + add/search/get 三注入点（先写自测表=红）        | `feat:`  |
| F2  | TS 侧：summarize 分支 + 工具描述 + `tests/auto-memory-secret-filter.test.ts` | `feat:`  |
| F3  | 真机复验 + 文档收口（TASK-C §5 / 本 Spec 状态 / 审查记录）                   | `test:`  |

依赖：F2 的 spawn 测试依赖 F1 的 self-test 存在（顺序执行）；F3 依赖 F1+F2。

## 8. 真机复验记录（F3，2026-10-21，IPC 直驱 mem0-e2e）

环境：embedder 冒烟 200/2048 维先行；server `node dist/index.js` health
200；llm=glm-5.3-flash / embedder=embedding-3；注入句 metadata 带
`source: task-c-f3-secret-filter`；回执归档仓库外。三项验收全过：

1. **① s9 等价句重放 ×2**（不同口令值、不同措辞）：回执均为
   `{"results":[],"intercepted":[{"pattern":"keyword_value","count":1}]}`
   ——`intercepted` 非空、回执全程无明文（核心安全属性：值未进入
   mem0 管线，qdrant/history.db/llm/embedder 端点均未见明文）。两次
   抽取均判 NONE：脱敏后输入在存量 s9 事实的重复压力下未抽出占位事实
   ——与任务 C V2 矛盾句 NONE 同属抽取模型行为（登记不修）；工具层
   （F2）对该组合的文案如实为「未抽出新事实 + Secret filter 行」。
2. **② search 出口**（query=`店铺后台登录密码`）：存量 s9 条目
   `cf11a4c7` 返回「User 的店铺后台登录密码为 [REDACTED-CREDENTIAL]，
   User 要求将其永久保存在系统记忆中……」——入库明文被出口侧脱敏盖住，
   且 id/hash/score/metadata 形状未动；同榜其余 9 条（V1/V2/T6 样本）
   零误伤。
3. **③ 无关正常句**（客服响应时间目标）：回执 `{"results":[{…ADD}]}`
   **不带 `intercepted` 键**，抽取准确（月份/阈值/工作日周末区分完整）
   ——旧回执形状零扰动。

结论：侧车秘密过滤**生效**（入库端拦截 + 出口端盖存量 + 回执可见性），
Spec §1 三条功能目标全部落地。附带发现：占位事实抽取依赖抽取模型对
`[REDACTED-CREDENTIAL]` 的解读，glm-5.3-flash 在重复压力下倾向 NONE——
「凭据存在」语义保留在回执文案层（F2 Secret filter 行）仍然可见。
