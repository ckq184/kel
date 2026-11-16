# 任务 AL 立项：上下文窗口声明化——预设档位（128k/256k/512k/1M）+ `[1m]` 后缀剥离 + 旧配置兼容

> **状态**：方案已经用户确认升级为完整方案（2026-11-16），待新会话按 §6 执行。
> **本文档用途**：交接文档。新会话 Agent 通读本文档 + AGENTS.md 后按 §6 执行，无需重新排查。
> **排查会话**：ZCode（2026-11-14~16，含 `[1m]` 400 故障取证与本轮链路调研）。

---

## 0. 一句话结论

把「上下文窗口大小」从模型名字符串（`[1m]` 后缀启发式）中解耦为**独立的声明字段**（provider 级预设：自动/128k/256k/512k/1M），宿主发送前剥离 `[1m]` 后缀（根治第三方端点 400），旧带后缀配置经兼容路径继续按 1M 认定。**改动的本质是拆开一个字段上耦合的两种语义：路由用模型 ID（协议层）与窗口声明（元数据层）。**

## 1. 背景与根因（为什么做）

### 1.1 故障实证（前序会话取证）

- 模型名带 `[1m]` 后缀 → 模型串**原样上送 API** → 第三方端点（GLM 等 Anthropic 兼容端点）400 `[1211] 模型不存在`（docs/task-g-runtime-defects-fix-plan.md:222 记录过同款；2026-11-14 会话复现确认）
- Pi Agent SDK（`@earendil-works/pi-coding-agent` 1.3.0）发行代码对 `[1m]` **零处理**（bundle 内 grep 0 处真实匹配）——后缀在 Pi 时代已无协议作用
- 但 runner 的窗口认定**仍然只认后缀**：`container/agent-runner/src/context-window.ts` `isExtendedContextModel`（`/(\[1m\])+$/i`）
- 死锁：模型真支持 1M，却没有任何不破坏模型名的方式让系统按 1M 认定

### 1.2 历史成因

`[1m]` 是 Claude Code 生态协议约定（Anthropic 官方端点解析后缀开 1M beta）。CKQClaw 早期基于 Claude Agent SDK，模型名=协议信道，本地预算计算搭便车认后缀；Pi 迁移后协议意义消失，启发式遗留成唯一认知通道。

## 2. 现状链路（代码坐标，已全部核实）

```
provider 配置 claude-provider.json（anthropicModel 可能带 [1m]）
  → src/runtime-config.ts:2425  写 env 行 ANTHROPIC_MODEL=<原样含后缀>
  → :2440-2446                  写 ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL=<原样含后缀>
  → :2456-2459                  CLAUDE_CODE_AUTO_COMPACT_WINDOW 预填：isOneMillionContextModel(:139，正则认后缀) ? 1M : 200k
  → src/container-runner.ts:1424-1435  envLines 注入 runner 进程（spawn 时固化）
  → container/agent-runner/src/provider-runtime.ts:40  读 env.ANTHROPIC_MODEL（:34 注释：runner 启动时解析一次）
  → index.ts:2686-2720（每 query 执行）：
      AUTO_COMPACT_PERCENTAGE（优先）→ resolveAutoCompactWindow(model, pct)   ← context-window.ts，窗口=后缀启发式
      否则 AUTO_COMPACT_WINDOW        → resolveLegacyAutoCompactWindow(model, v)（90% 安全钳制，天花板=启发式窗口）
      → flagSettings.autoCompactWindow → SDK settings（index.ts:2828，本就逐 query 传递）
```

关键既有事实：

- 绝对值合法域：`auto_compact_window` 0 或 100k~1M（src/schemas.ts:296）——128k/256k/512k/1M 四值全部可存，**零 DB/schema 迁移**
- env 先例常量：`CKQCLAW_CLAUDE_ENDPOINT_KIND`（provider-runtime.ts:1-2 双名兼容模式，新 env 照此命名）
- 前端 provider 类型：web/src/components/settings/types.ts:10,62（anthropicModel）；「1M 上下文」开关在 ProviderEditor.tsx:860-885（自动追加后缀——**本任务要替换的病灶 UI**）
- 档案级百分比/绝对值编辑已存在：AgentProfilesPage.tsx:409-419；系统级默认：SystemSettingsSection.tsx:672-751（不动）

## 3. 方案设计

### 3.1 数据模型（provider 级新可选字段）

provider 配置对象新增 `contextWindow?: 'auto' | 128000 | 256000 | 512000 | 1000000`（缺省 `auto`）。选 `auto` = 现行为（`[1m]` 启发式 → 1M，否则 200k）。**窗口是 provider/model 的属性，放 provider 级一处声明，所有用该 provider 的档案同时受益。**

### 3.2 认定优先级（runner 侧，单一真相）

```
声明窗口（新 env CKQCLAW_CONTEXT_WINDOW，宿主按 provider 字段+旧后缀归一后注入）
  > [1m] 启发式（兼容路径：宿主未升级/直传场景，仅用于认定，不外发）
  > 200k 默认
```

### 3.3 后缀剥离（根治 400）

- **宿主侧**：runtime-config `buildClaudeEnvLines` 写 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*_MODEL` 前剥离 `[1m]`（剥离结果仍过 `sanitizeEnvValue`）；检测到后缀且无显式声明时，自动注入 `CKQCLAW_CONTEXT_WINDOW=1000000`（旧配置等价迁移，无感）
- **runner 侧**：provider-runtime 组 `queryModelOptions.model` 时再剥一道（纵深防御，覆盖 per-query modelOverride 直传路径）
- 官方 Anthropic 端点无损失：Pi 本就不解析后缀、不开 1M beta，剥了不改变任何现有行为

### 3.4 消费点升级

- `resolveAutoCompactWindow` / `resolveLegacyAutoCompactWindow`（context-window.ts）：签名从吃 model 串改为吃**已认定的窗口数值**（或加重载），90% 钳制天花板随之用认定值
- `index.ts:2686-2720`：从 `queryModelRuntime` 取新字段 `contextWindow`（provider-runtime 解析产物）
- 宿主 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 预填（runtime-config:2456）：声明值优先于 `isOneMillionContextModel`

## 4. 执行步骤（7 步，TDD，一次任务完成）

| 步                              | 做什么                                                                                                                                                                                                                                                                                 | 动哪些文件                                                                                                                                                      |
| :------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 立项**                      | 本文档落档 + 范围声明；base pin 开工时 HEAD（排查会话末为 `ef64b06`，任务AJ收官）                                                                                                                                                                                                      | `docs/task-al-context-window-declaration-plan.md`（本文）、`.gatescope.json`                                                                                    |
| **1 runner 纯函数（先写测试）** | `context-window.ts` 加 `resolveDeclaredContextWindow(model, declared?): number`（声明>启发式>200k）与 `stripOneMillionSuffix(model): string`；改 `resolveAutoCompactWindow`/`resolveLegacyAutoCompactWindow` 接收窗口数值                                                              | `container/agent-runner/src/context-window.ts`、`tests/` 新增（优先级矩阵/剥离幂等/钳制天花板三组用例）                                                         |
| **2 runner 接线**               | provider-runtime.ts：`ClaudeProviderRuntime` 加 `contextWindow` 字段（读 `CKQCLAW_CONTEXT_WINDOW`，参照 :1-2 双名常量先例），`queryModelOptions.model` 用剥离后的串；index.ts:2686-2720 改用 `queryModelRuntime.contextWindow`                                                         | `container/agent-runner/src/provider-runtime.ts`、`container/agent-runner/src/index.ts`                                                                         |
| **3 宿主注入**                  | runtime-config `buildClaudeEnvLines`：三处模型 env 行剥离后缀；有声明或检测到后缀时写 `CKQCLAW_CONTEXT_WINDOW`；:2456 预填用认定值；新 env 加入 :90-102 `INHERITED_CLAUDE_PROVIDER_ENV_KEYS`（防宿主残留串扰，同 `ANTHROPIC_MODEL` 待遇）与 :2738 附近清理逻辑                         | `src/runtime-config.ts`、`src/container-runner.ts`（若 envLines 白名单需登记）、`tests/` 既有 env 行测试扩展                                                    |
| **4 provider 配置链**           | schemas.ts:610/617/625/948/1123 附近 provider 校验加 `contextWindow` 可选枚举；`ClaudeConfigPublic`（src 侧与 web/src/components/settings/types.ts:10,62）同步字段；routes/config.ts 透传                                                                                              | `src/schemas.ts`、`src/routes/config.ts`、类型双侧重跑 `make sync-types`（若涉 shared）、`tests/` round-trip 用例                                               |
| **5 前端 UI**                   | ProviderEditor 的「1M 上下文」开关（:860-885）**替换**为窗口选择器（自动/128k/256k/512k/1M），存 `contextWindow` 字段、**不再向后缀追加方向写**；提示文案：「请按模型真实支持的最大上下文选择；声明过大时上游会按其真实窗口截断/报超长」；旧带后缀存量值经 parseProviderModel 兼容展示 | `web/src/components/settings/ProviderEditor.tsx`、`web/src/utils/provider-model.ts`（保留解析、停用追加）、`tests/channel-accounts-frontend.test.ts` 式组件用例 |
| **6 联动文案（最小）**          | AgentProfilesPage:2029/2097 的「[1m] 时按 1M」提示补一句声明窗口语义（有声明值时以声明为准）                                                                                                                                                                                           | `web/src/pages/AgentProfilesPage.tsx`                                                                                                                           |
| **7 门禁提交**                  | `npm run verify` 六步 + `node scripts/check-scope.mjs` + 单提交；CLAUDE.md 压缩配置描述处同步一句                                                                                                                                                                                      | 文档同步极小化                                                                                                                                                  |

## 5. 风险清单

| #   | 风险                                                                   | 对策                                                                                                                                             |
| :-- | :--------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **声明值 > 模型真实窗口 → 超长溢出报错**（声明的本质是放弃启发式保护） | UI 明示语义（§4 步5 文案）；90% 钳制仍以声明值为天花板（防切换回归的旧防线保留）；这是用户可自行纠正的配置错误，非系统缺陷                       |
| 2   | 新旧宿主/runner 混跑                                                   | `CKQCLAW_CONTEXT_WINDOW` 可选 env：旧 runner 忽略之且宿主已剥后缀（连通性反而修复）；新 runner 无该 env 走启发式——双向不劣于现状；契约测试锁双向 |
| 3   | 后缀剥离改官方端点行为                                                 | 实证 Pi 无后缀处理，剥离为中性变更；用例锁「剥离后行为逐字节等价」（除模型串本身）                                                               |
| 4   | env 白名单遗漏 → 新 env 被清/被继承串扰                                | 步 3 显式登记 `INHERITED_CLAUDE_PROVIDER_ENV_KEYS` 与清理逻辑，用例锁                                                                            |
| 5   | 既有 `[1m]` 相关测试破绿                                               | 逐个核对：语义仍成立（认定保留）的改断言坐标，语义废除的（如「开关追加后缀」）有意更新并记录于提交信息                                           |
| 6   | 范围蔓延                                                               | 非目标（§6 红线）之外一律不做                                                                                                                    |

**非目标（范围红线）**：不做会话级热切换（独立需求，前序会话另有方案）；不动系统级默认（SystemSettings 百分比制保持）；不做真实窗口自动探测；不动 DB schema（`auto_compact_window` 字段复用，无迁移）；`sdk-query.ts:57` 的硬编码 `contextWindow: 200_000` 仅调查是否受影响（执行时核实其调用链，属只读判断，改不改报用户定）。

## 6. 执行说明（新会话）

1. 读 AGENTS.md → 本文档 → 按 §4 步 0 开始；**先跑 `git log --oneline -1` 确认 base，写 `.gatescope.json`**（allow 按 §4 文件清单）。
2. TDD：每步先红后绿；步 1 纯函数测试是全任务地基。
3. 真机验收（本地服务可用 `./restart-dev.command` 一键起）：
   - GLM 类端点 + 声明 1M + 模型名**无后缀** → 连通正常（无 400）且预算按 1M 算（百分比 80% → 800k）
   - 存量带 `[1m]` 的 provider → 仍连通（已剥离）且按 1M 认定
   - 无声明无后缀 → 与现行为逐字节等价（200k）
4. 门禁：`npm run verify` 全绿 + `check-scope` 通过后单提交：`feat: 运行时 - 上下文窗口声明化预设与 1m 后缀剥离（任务AL）`。push 由用户显式发起。

## 7. 验收标准

- [ ] 四档预设 + 自动，在 provider 设置中可选、可存、可回显
- [ ] 第三方端点：声明 1M、模型名无后缀 → 无 400、压缩预算按 1M 生效
- [ ] 存量 `[1m]` 配置：连通性恢复（剥离生效）、窗口按 1M 认定（兼容承诺）
- [ ] 无声明无后缀：行为与改动前一致（回归零）
- [ ] 优先级矩阵（声明>启发式>默认）与剥离幂等有契约测试锁定
- [ ] `npm run verify` 六步全绿；`check-scope` 通过

## 8. 交接备注

- 排查会话未改任何代码；唯一落盘产物 = 本文档（未提交）。
- 当前本地服务由 `restart-dev.command` 托管（脱离会话存活）；执行任务时重启不影响。
- 远端 `origin = https://github.com/ckq184/Personnal-agent.git`，本地与远端一致于任务AJ收官点附近；推送一律用户显式发起。
