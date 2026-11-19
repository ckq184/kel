# 任务立项：私聊绑定入口与后端策略对齐（方案 A'）

> 立项日期：2026-11-19｜base：`e6f199c`｜状态：方案已获用户确认（本对话）
> 性质：纯缺陷修复（UI/文案对齐既有后端策略），不改任何后端绑定语义。

## 1. 背景与取证

### 1.1 现象与根因

用户私聊（QQ/微信 direct）执行 `/bind 资料整理` 被 bot 拒绝（"普通群和私聊只能绑定具体会话"，`src/index.ts:3693`）。
追查发现 **Web UI 提供了后端必拒的选项**：

- `web/src/components/settings/hooks/useImBindings.ts:84-94` 为每个工作区无条件构建
  `type:'main'`（主会话）目标；
- `web/src/components/settings/BindingsSection.tsx:504` 对非群聊天传 `targetType='both'`，
  换绑对话框同时展示主会话与会话目标；
- `web/src/components/settings/BindingTargetDialog.tsx` **不按 targetType 过滤渲染**（仅影响标题/文案）；
- 用户点击「绑定到此工作区」→ PUT `target_main_jid` → 后端
  `conversationBindingPolicyError('direct','workspace')` 必 400
  （`src/routes/config.ts:3522`，`tests/channel-conversation-kind.test.ts:38` 钉死该拒绝）。

同时 `/list` 提示语（`src/index.ts:3589`）「使用 /bind \<workspace\> 或 /bind \<workspace\>/\<会话短ID\>」
对私聊教了会被拒绝的用法。

### 1.2 既定策略（本任务不改）

`conversationBindingPolicyError`：group→工作区、direct→会话、unknown 拒绝。
私聊「回到主会话」的既有合法路径是「恢复账号默认工作区」（unbind 分支，无策略限制）。

## 2. 方案（A'）

1. **`BindingTargetDialog` 按 `targetType` 过滤渲染**：
   - `'workspace'` → 仅渲染 `type:'main'` 目标；
   - `'session'` → 仅渲染 `type:'session'` 目标；
   - `'both'` → 全渲染（保留类型分支，不删）。
2. **`BindingsSection` 私聊改传 `'session'`**：`kind→targetType` 映射提为纯函数
   `resolveBindingTargetType(kind)`（group→`'workspace'`，其余→`'session'`），置于
   `useImBindings.ts` 导出，可单测。
3. **页面描述文案**（BindingsSection.tsx:325）：改为「群聊绑定工作区，私聊绑定指定会话；
   私聊回到主会话请使用"恢复账号默认工作区"」。
4. **`/list` 提示语按可绑定性区分**：`src/im-command-utils.ts` 新增纯函数
   `buildBindHint(threadMapCapable: boolean)`：
   - 话题群（threadMapCapable）：`💡 /bind <工作区> 绑定工作区`
   - 私聊/普通群：`💡 /bind <工作区>/<会话短ID> 绑定会话；/unbind 恢复默认工作区`
     `handleListCommand`（index.ts:3589）按与 `handleBindCommand` 同源的
     `threadMapCapable` 判定调用。
5. 徽章文案（「工作区绑定/主会话绑定/会话绑定」）描述当前状态，语义正确，不动。

## 3. 裁决（用户已确认）

| 方案                        | 评估                                                |
| --------------------------- | --------------------------------------------------- |
| **A' 前端对齐后端（采纳）** | 纯缺陷修复，无语义变更，成本小                      |
| A 后端放行 direct→workspace | 产品语义变更（私聊与 Web 主会话共享上下文），暂不做 |
| C 仅改文案                  | 换绑对话框仍提供必拒选项，未除根                    |

## 4. 已知边界（接受）

- `unknown` kind（飞书元数据缺失）同样映射到 `'session'`：其会话目标提交仍会被策略拒
  （"Unable to determine…"），但比原先 `'both'` 少展示一半必拒选项；根治需元数据同步。
- `targetType='both'` 类型保留但无调用方（为将来策略放开预留）。

## 5. 不做

- 不改后端策略、不改 `/bind` 命令语义、不改 `conversationBindingPolicyError`。
- 不改配对/换绑/恢复默认的任何行为；不碰 `data/`；不 push；不重启服务。

## 6. 步骤（TDD）

1. 立项提交（本文档 + `.gatescope.json`，base `e6f199c`）。
2. 新增 `tests/direct-bind-ui-alignment.test.tsx`（happy-dom）+ 纯函数用例，先红：
   - `BindingTargetDialog` targetType='session'：含 main+session 的 targets 只渲染会话项；
   - targetType='workspace'：只渲染主会话项（「绑定到此工作区」）；
   - targetType='both'：全部渲染（回归）；
   - `resolveBindingTargetType`：group→workspace、direct/unknown→session；
   - `buildBindHint`：两种分支文案。
3. 实现第 2 节改动，测试转绿。
4. `npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过，实现单独提交，不 push。

## 7. 风险与未验证项

| 风险                                        | 应对                                                              |
| ------------------------------------------- | ----------------------------------------------------------------- |
| BindingsSection 整体未做 DOM 测试（依赖重） | 映射提为纯函数单测 + 对话框过滤单测；504 行调用改动由类型检查兜底 |
| 过滤后 direct 无会话目标时空态文案          | 沿用对话框既有 'session' 空态文案（"暂无可绑定的会话…"）          |
| 用户验收需要真实渠道环境                    | 修复后由用户在 Web 换绑对话框目视确认私聊不再出现主会话选项       |
