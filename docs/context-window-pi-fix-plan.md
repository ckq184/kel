# 任务立项：修复 pi runner 下"上下文窗口"设置失效

> 立项日期：2026-11-18｜base：`64dbec3`｜状态：已获用户批准（死代码第二档连带孤儿核查报告后确认"立项修复"）
> 前序：`dead-code-tier2-prune-plan.md` 第 7 节登记的 `resolveDeclaredContextWindow` 核查；本任务修复其暴露的掉线逻辑。

## 1. 背景与根因

1. **症状**：Web「模型配置 → 第三方端点」里的"上下文窗口"选项（auto / 128K / 256K / 512K / 1M）保存后，在 pi runner 下**不产生任何效果**。
2. **断链位置**（链路逐段核实）：
   - 宿主 `src/runtime-config.ts` 的 `buildClaudeEnvLines` 在"已声明窗口或模型名带 `[1m]`"时注入 `CKQCLAW_CONTEXT_WINDOW`，并剥离模型名后缀——**正常**，`tests/runtime-config-env.test.ts` 已覆盖。
   - runner `provider-runtime.ts` 将其解析为 `declaredContextWindow`——**正常**。
   - **断点**：`declaredContextWindow` 无人读取；`runtime/pi/pi-provider.ts` 把第三方端点的模型窗口**写死为 `contextWindow: 200_000`**。
3. **影响**：pi 的压缩阈值为 `contextWindow - reserveTokens`（pi `compaction.js` 的 `shouldCompact`，`reserveTokens` 默认 16384）。声明 1M 的模型在约 184K 就被压缩，长上下文被浪费；声明 128K 的模型，压缩阈值（约 184K）高于其真实窗口，可能在压缩前就因超出窗口而报错。
4. **时间线**：断链发生在 pi 迁移时——`declaredContextWindow` 的唯一消费者 `resolveClaudeQueryModelRuntime` 属旧 Claude SDK 链路，pi 链路从未接过它。早于死代码清理，与之无因果。
5. **范围边界**：该选项只出现在第三方端点编辑器，对应 `pi-provider.ts` 的 custom 分支；官方端点走 pi 内置模型库的自带窗口，不受影响。

## 2. 方案（最小改动，沿用既有优先级）

数据流补全：

```text
pi-index.ts（provider.declaredContextWindow）
  → RuntimeSessionOptions.provider.contextWindow
  → pi-runtime.ts（传入 resolvePiProvider）
  → pi-provider.ts custom 分支：contextWindow = resolveDeclaredContextWindow(rawModel, input.contextWindow)
```

- **优先级**沿用任务 AL 认定矩阵：**声明 > `[1m]` 启发式（原始模型名） > 200K 默认**，直接复用 `context-window.ts` 已有且已测试的 `resolveDeclaredContextWindow`，不新写判定逻辑。
- **向后兼容**：未声明且无后缀 → 仍为 `200_000`，与今天一致；旧宿主不注入 → 同上。

## 3. 不做（范围外）

- 不改 `maxTokens: 32_000`（输出上限，与窗口无关）、pi 的 `reserveTokens`、`autoCompactEnabled`。
- 不覆盖官方端点内置模型的窗口（UI 不开放该入口）。
- 不改宿主注入逻辑（已正确且有测试）。
- 不处理 `provider-runtime.ts` 的 `queryModelOptions` 去后缀（旧宿主兼容，pi 链路未使用，另案）。
- 不恢复工具参数摘要与脱敏（核查报告第 1 项，属产品决策，另案）。

## 4. 实施步骤（立项 1 提交 + 修复 1 提交）

| 步骤 | 内容                                                                                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | 立项提交（本文档 + `.gatescope.json`，base=`64dbec3`）                                                                                                                                   |
| 1    | **Red**：新增 `tests/pi-provider-context-window.test.ts`，用最小 fake `ModelRuntime` 捕获 `registerProvider` 的入参，断言声明值进入模型窗口；先确认失败                                  |
| 2    | **Green**：改 `runtime/types.ts`（provider 增 `contextWindow?`）、`pi-index.ts`（传 `provider.declaredContextWindow`）、`pi-runtime.ts`（透传）、`pi-provider.ts`（custom 分支计算窗口） |
| 3    | 更新 `CLAUDE.md`「常见修改入口」中"上下文窗口声明"一行，写明 runner 落点在 `pi-provider.ts`                                                                                              |
| 4    | `npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过 + `fix:` 提交（不 push）                                                                                                 |

## 5. 风险清单

| #   | 风险                                       | 缓解                                                                                            |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 1   | **行为变化**：已声明大窗口的用户压缩更晚   | 这是其设置的本意；上下文变长会增加单次请求 token 与延迟，在提交信息中明示                       |
| 2   | 声明值超过模型真实上限，第三方端点拒绝请求 | 属用户配置；UI 预设值有限（128K / 256K / 512K / 1M），不做服务端校验                            |
| 3   | 测试需要伪造 `ModelRuntime`                | 只实现 `registerProvider` / `getModel` 的最小 fake，不触网、不依赖真实 pi 目录                  |
| 4   | 生效时机                                   | 窗口在 runner 创建 pi 会话时读取一次（与 `ANTHROPIC_MODEL` 同时机）；本任务不改 runner 重启策略 |
| 5   | 旧会话 JSONL 中已记录的压缩点              | 不迁移历史；仅影响新的压缩决策                                                                  |

## 6. 验证方式

1. 新测试先红后绿；覆盖：声明值生效、未声明走 `[1m]` 启发式、无声明无后缀保持 200K、官方端点分支不受影响。
2. `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
3. 宿主注入测试 `tests/runtime-config-env.test.ts` 保持通过（本任务不改宿主）。
