# 任务立项：死代码第二档清理（生产零调用、仅被测试保活的代码）

> 立项日期：2026-11-18｜base：`a04aa28`｜状态：已获用户批准（先分析并量化→用户选定 A+B 两组、按组分提交、自测段一并删）
> 前序：`dead-code-tier1-prune-plan.md`（提交 94b22c9 / a04aa28）。第一档处理"确认死"的残余；本任务处理第二档，且必须连带删除对应测试。

## 1. 背景结论

1. **严格标准**：生产代码零引用 + 所在文件内零使用 + 仅被测试引用。按此标准共 **51 个符号**（后端 34、runner 14、web 3）。
2. **口径更正**：第一档汇报里"约 128 个仅测试引用的导出"口径过宽——其中 **94 个文件内部仍在使用**（`export` 只是为了测试方便），是活代码，不属于死代码，本任务不动。
3. **分组与来源（Git 历史佐证）**：

| 组  | 内容                                                                                                                                                                                                                                                                                                      | 来源                                                                                             | 本次 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---- |
| A   | runner 14 个符号：`utils.ts`（`summarizeToolInput`、`isSuspectTruncatedStreamResult`、`shouldForceBackgroundTaskSummary`、`buildBackgroundTaskSummaryPrompt`、`AssistantTextTracker`）、`ipc-delivery.ts`（6 个）、`context-window.ts`（2 个）、`provider-runtime.ts`（`resolveClaudeQueryModelRuntime`） | 64d6d7b 删旧 Claude runner 集群后留下的孤儿                                                      | 做   |
| B   | `src/file-text-extractor.ts` 整模块（`extractFileText`）、`evaluateChannelAdmission`、`formatTokens`                                                                                                                                                                                                      | 前两者唯一调用方是已删的 `src/dingtalk.ts`（26b9c8c）；`formatTokens` 为 billing 残留（20febca） | 做   |
| C   | 约 30 个自基线起从未被生产调用的符号（`db.ts` 任务/会话访问器、`channel-reliability-store.ts` 7 个状态机函数、记忆/运行时/卡片辅助等）                                                                                                                                                                    | 历史无法判断是"被取代"还是"没接线"                                                               | 不做 |
| D   | 6 个 `ForTest` / `reset` / `clear` 测试辅助（`createAppForTest`、`createUploadBodyLimitForTest`、`resetTaskContinuationConfigCache`、`clearRunContextSnapshots`、`clearTaskRunKeysForTest`、`getActiveScriptCount`）                                                                                      | 有意的测试接缝                                                                                   | 保留 |

4. **B 组关键核实**：`extractFileText` 与 `evaluateChannelAdmission` 的调用点经 `git show 26b9c8c` 逐文件确认只在被删的 `src/dingtalk.ts`，不是通用文件处理逻辑；飞书/QQ 的准入走 `resolveAdmittedChannelRoute`，不受影响。

## 2. 误报修正与保留项（不按误报执行）

- **C 组不删**：删错可能掩盖"本应接线却没接线"的功能。后续如需处理，应逐个核对生产是否有等价内联逻辑，另案立项。
- **D 组保留**：测试接缝是有意设计。
- **94 个"仅为测试导出"的活代码保留**。
- **`container/Dockerfile` 的 `poppler-utils` / `unzip` 保留**：`file-text-extractor.ts` 删除后它们可能不再被需要，但本任务不改镜像；留作后续另案。
- 第一档登记的保留项（QQ aux 休眠钩子、有调用方的函数参数等）继续保留。

## 3. 已确认裁决

1. 本次做 **A + B**；C 不做、D 保留。
2. 提交粒度：立项 1 个 + A 实现 1 个 + B 实现 1 个，每个实现提交可单独 `git revert`。
3. `scripts/self-test-agent-runner.ts` 里对 `shouldForceBackgroundTaskSummary` / `buildBackgroundTaskSummaryPrompt` 的自测段**与函数一并删除**。
4. **测试随代码删**：测试只针对已删符号则整文件删；与活代码混合的测试文件只删对应用例。被删文件与用例清单写入各实现提交信息。这不是降低验收标准——被删的是对已删除代码的测试。
5. 删除后连带变成孤儿的符号（只被已删代码使用的辅助函数/类型/常量）一并清理；若涉及判断，回到用户确认。

## 4. 实施步骤（立项 1 提交 + 实现 2 提交）

| 步骤 | 内容                                                                                                                                                                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | 立项提交（本文档 + `.gatescope.json`，base=`a04aa28`）                                                                                                                                                                                                                                                                            |
| 1    | A 组：删 14 个 runner 符号；删 `tests/assistant-text-tracker.test.ts`、`tests/truncated-stream-detect.test.ts` 整文件；对 ipc-delivery / context-window / provider-runtime / background-task-summary-guard / utils-redact 五个测试文件删对应用例；删自测脚本对应段；连带孤儿；`npm run verify` + `check-scope` + `refactor:` 提交 |
| 2    | B 组：删 `src/file-text-extractor.ts` 与 `tests/file-text-extractor.test.ts`；删 `evaluateChannelAdmission`、`formatTokens` 及 `channel-admission.test.ts`、`feishu-card.test.ts` 中对应用例；连带孤儿；`npm run verify` + `check-scope` + `refactor:` 提交                                                                       |

## 5. 风险清单

| #   | 风险                                        | 缓解                                                                                                     |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | 误删仍被动态引用的符号                      | 第一档已排查：项目模块无命名空间导入、无计算键访问；runner 唯一动态 import 用的是保留的 `...Strict` 导出 |
| 2   | 混合测试文件删用例时误伤测活代码的用例      | 逐文件对照被删符号；删后重跑测试；用例数变化写入提交信息                                                 |
| 3   | 删除后连带暴露新孤儿，或测试/脚本引用悬空   | 每轮用分析器 + `tsc --noUnusedLocals` 复核，直至仅剩登记的保留项                                         |
| 4   | 自测脚本删段后脚本失效                      | 删后实际运行 `self-test:agent-runner`，确认脚本仍可解析、可执行                                          |
| 5   | 删 `file-text-extractor` 后镜像依赖成为冗余 | 已登记为后续另案，本任务不动 Dockerfile                                                                  |

## 6. 验证方式

1. 每个实现提交前 `npm run verify` 六步全绿；`node scripts/check-scope.mjs` 通过。
2. 分析器重跑：A、B 组符号在代码与测试中零残留；第二档严格清单只剩 C、D 两组。
3. `tsc --noUnusedLocals --noUnusedParameters` 仅剩登记的保留项。
4. ~~`self-test:agent-runner` 仍能运行~~——已被第 7 节第 1 条取代（脚本随用户批准删除）；`npm run self-test` 仍可用。

## 7. 执行期登记（A 组）

1. **自测脚本与 CI（用户单独批准）**：`scripts/self-test-agent-runner.ts` 整个脚本只回放"后台任务摘要守卫"，只调用被删的 `shouldForceBackgroundTaskSummary` / `buildBackgroundTaskSummaryPrompt`，故整文件删除。这牵涉 `package.json`（移除 `self-test:agent-runner`，`self-test` 改为 `build:all` + 测试）与 `.github/workflows/ci.yml`（移除 "Agent runner self-test" 步骤）。按 `AGENTS.md`，CI 配置变更须用户单独批准——用户已于执行期明确批准。`.gatescope.json` 的 `allow` 因此扩宽 3 项：`package.json`、`.github/workflows/ci.yml`、`container/agent-runner/src/types.ts`。
2. **连带孤儿已清理（零引用，代码与测试均无人使用）**：`ClaudeQueryModelRuntime`、`SessionEntry`、`ImageMediaType`、`shorten`、`AssistantContentBlock`，及随之失效的导入。
3. **连带孤儿暂不处理，待用户判断（仍被测试保活，且可能是"掉线的逻辑"而非死代码）**：
   - `redactSensitive` + `redactInlineSecrets`：密钥脱敏工具对。唯一调用方（旧 `summarizeToolInput`）已删；runner 内无其他脱敏实现。
   - `resolveDeclaredContextWindow`（`context-window.ts`）：唯一调用方（旧 `resolveClaudeQueryModelRuntime`）已删；`provider-runtime.ts` 仍读取 `CKQCLAW_CONTEXT_WINDOW`，`CLAUDE.md` 仍描述 runner 认定声明窗口——需核对 pi runner 是否另有消费方。
   - `isStaleBackgroundWaitReply`、`serializeIpcInputMessage`：仅被测试使用。
   - `image-detector.ts` 的 `detectImageMimeType`：是 `shared/` 的同步副本，runner 内无使用，但删除会破坏同步源结构，保持不动。
4. **A 组被删测试清单**：整文件删 `tests/assistant-text-tracker.test.ts`（11 例）、`tests/truncated-stream-detect.test.ts`（7 例）；删部分用例——`agent-runner-ipc-delivery.test.ts` 7 例、`agent-runner-provider-runtime.test.ts` 7 例、`agent-runner-utils-redact.test.ts` 5 例（整个 `summarizeToolInput` describe）、`background-task-summary-guard.test.ts` 3 例、`agent-runner-context-window.test.ts` 3 例；并清理 `agent-runner-ipc-delivery.test.ts` 中随之无用的 `afterEach` / `tempDirs` / `fs` / `os` / `path`。

## 8. 执行期登记（B 组）

1. **已删除**：`src/file-text-extractor.ts` 整模块（`extractFileText`，唯一调用方是已删的 `src/dingtalk.ts`）与 `tests/file-text-extractor.test.ts`（8 例，整文件）；`evaluateChannelAdmission`（同样仅被 `dingtalk.ts` 调用）；`formatTokens`（`src/feishu-cards/sections.ts`，billing 残留）。
2. **连带零引用孤儿已清理**：`ChannelAdmissionDecision`、`ChannelAdmissionInput`，及随之失效的导入。
3. **B 组被删测试清单**：`tests/channel-admission.test.ts` 3 例（`evaluateChannelAdmission` 相关）、`tests/feishu-card.test.ts` 1 例（`formatTokens`）。
4. **连带孤儿暂不处理，待用户判断**：`parseChannelPairingCode`（`channel-admission.ts`）。其唯一生产调用方 `evaluateChannelAdmission` 已删，现仅剩 1 个测试用例使用。核实结论：配对功能**未断线**——QQ（`qq.ts`）与微信（`wechat.ts`）在各自代码里内联解析 `/pair <code>` 并调用 `onPairAttempt`，该函数是被它们重复实现的共享辅助。是否删除、或改为让 QQ/微信复用它，属另案判断。
5. **同名不同物，未受影响**：`web/src/components/usage/format.ts` 的 `formatTokens` 是 web 用量页自己的实现，与已删的飞书卡片格式化函数无关。
6. **`container/Dockerfile` 保留**：`poppler-utils`（`file-text-extractor` 的 `pdftotext` 依赖）与 `unzip` 本任务不动，留作后续另案。
