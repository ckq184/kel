# 任务 Y3 立项：会话内按消息选择提炼（任务 Y2 延伸）——交接文档

> **状态**：2026-11-10 用户确认计划执行（三项裁决均按推荐拍板，见 §1）。基线 = 任务 Y2
> 提交 `47b895f`；实现按 §3 批次 TDD 执行（先见红再实现），不做 §5 非目标。
> **回滚点**：`47b895f`（`.gatescope.json` base）。

---

## 0. 一句话结论

Y2 的「提炼记忆」按会话整体提炼；本任务把粒度细化到**消息级**：在提炼对话框内切换
「按消息」模式，勾选当前会话窗口内的具体文本消息（分页加载、不限最新 400 条窗口），
只把这批送 mem0 提炼。零新增依赖、不动 DB schema（`src/db.ts` 仅新增只读查询函数）、
权限面不变。

## 1. 已拍板裁决（2026-11-10 用户确认，无需再问）

1. **交互 = 对话框内「按消息」模式**：CaptureMemoryDialog 顶部模式切换（按会话 =
   Y2 多选语义不变 / 按消息 = 当前会话内勾选），消息选择区拆新子组件
   `CaptureMessagePicker.tsx`。聊天窗口 MessageList 内联多选被否决（热点组件）。
2. **超预算 = 宁拒勿截 400**：ids ≤400、合计 ≤60k，超出 400 `invalid_args`
   （提示减少选择）。与全文模式「截断保最新」明确分叉；前端本地合计前置禁用 +
   服务端兜底双保险。
3. **范围 = 按 id 直查、不限 400 条窗口、动 db.ts**：新增只读函数
   `getMessagesByIds(chatJid, ids)`，翻页加载到的更早历史消息均可选。
   限最新 400 条窗口方案被否决（窗口外勾选被静默丢弃的暗坑）。

**安全红线（非裁决）**：客户端只传消息 id，绝不传内容——服务端以 DB 为真相源
组装，防内容注入伪造会话历史。`messages` 表主键为复合键 `(id, chat_jid)`
（db.ts DDL 取证），id 单独不全局唯一：按 id 查询必须绑定单一会话 jid
（`WHERE chat_jid = ? AND id IN (...)`），天然完成归属校验——其他会话/工作区的
id 在该 jid 下查不到即剔除。

## 2. API 契约（任务 Y3 增量）

- `POST /api/auto-memory/workspaces/:workspaceJid/capture` body 第二种模式：
  `{ messageIds: string[], agentId?: string }`（`agentId` 定位会话：缺省/空 = 主
  会话，非空 = 子会话虚拟 jid；trim 后 ≤128 字符）。
- 与既有 `{ agentIds?: string[] }` 会话级模式**互斥，同传 400**。
- messageIds：非空字符串数组，去重后 ≤400，超出 400；行按 timestamp 正序、
  角色 `is_from_me` 映射；系统/计费/空行剔除（服务端兜底）；剔除后为空 → 400；
  合计字符 >60k → 400（宁拒勿截，不截断）。
- metadata：`{ source: 'chat_capture', mode: 'message_pick', agentId?,
messageCount: N, capturedAt }`——不存 messageIds 全量（几百 uuid 会随每条
  提炼记忆入库膨胀）。
- 回执与会话级模式相同：`{ ok, captured, added, intercepted }`。
- preview 不加端点：前端本地合计（消息 content 在手），服务端 capture 兜底。

## 3. 批次（TDD，每步先写测试见红再实现）

1. **批次 1 后端**：`tests/auto-memory-routes.test.ts` 新增消息级用例（按 id 取行/
   角色/正序、跨会话与未知 id 剔除、系统行兜底、全空 400、ids>400 400、
   合计>60k 400 且零侧车调用、与 agentIds 同传 400、malformed 校验、无 400 条
   窗口——最旧消息可选中、metadata 形状）→ `src/db.ts` 新增
   `getMessagesByIds`（getMessagesPage 旁，同列清单、ASC 排序）→
   `src/routes/auto-memory.ts` capture 第二模式。
2. **批次 2 store**：`tests/auto-memory-frontend.test.ts` 新 action
   `captureMessages(workspaceJid, agentId, messageIds)`（agentId 空串省略字段、
   body 形状、90_000 钉住、失败 actionError+throw）→
   `web/src/stores/auto-memory.ts`。
3. **批次 3 UI**：断言见红 → 新增 `web/src/components/chat/CaptureMessagePicker.tsx`
   （checkbox 行 = 角色标签+时间+截断文本，最新在前，加载更早分页，本地合计与
   超限禁用）→ `CaptureMemoryDialog.tsx` 模式 radio（按会话/按消息，互斥）→
   `ChatView.tsx` 传入当前会话 agentId 与消息分页回调（小改）。
4. **批次 4 文档+门禁**：`docs/API.md` capture 小节补消息级模式与预算分叉语义
   （ACL 面不变）→ `npm run verify` → `node scripts/check-scope.mjs` → 单提交
   `feat: 记忆 - 按消息选择提炼入自动记忆（任务Y3）`（push 由用户发起）。

## 4. 文件清单（= `.gatescope.json` allow）

新增：`docs/task-y3-message-pick-capture-plan.md`、
`web/src/components/chat/CaptureMessagePicker.tsx`
修改：`src/db.ts`（仅新增只读函数）、`src/routes/auto-memory.ts`、
`web/src/stores/auto-memory.ts`、`web/src/components/chat/CaptureMemoryDialog.tsx`、
`web/src/components/chat/ChatView.tsx`、`tests/auto-memory-routes.test.ts`、
`tests/auto-memory-frontend.test.ts`、`docs/API.md`
（不动：schema/迁移、`docs/ACL-MATRIX.md`——权限面不变。）

## 5. 非目标（防蔓延）

- 跨多会话混选消息（消息级限定单会话，会话级多选维持 Y2）。
- 附件/图片参与提炼（仅文本 content）。
- 全选/区间选/搜索过滤消息。
- 会话级模式的预算语义改动（截断保最新维持）。
- message-pick 的服务端 preview 端点。

## 6. 风险

1. `src/db.ts` 首次入范围（纪律敏感）——仅只读 SELECT，零 schema/迁移/既有
   查询改动；SQL 参数 ≤401（SQLite 变量上限内）；gatescope 扩宽由用户复核。
2. 复合主键 `(id, chat_jid)`——契约强制 agentId+messageIds 绑定单会话，跨会话
   id 剔除测试钉死。
3. 预算语义分叉（全文=截断 vs 按消息=拒绝）——API.md 与确认文案明示，测试
   分别钉死。
4. 对话框复杂度——消息选择区拆子组件，两模式互斥。
5. 前后端合计一致性——本地合计 = ∑content.length（与服务端同算法）。
6. 零散消息提炼上下文不足——产品语义由用户权衡，非代码风险。

## 7. 门禁与验收

- 门禁：`npm run verify`（六步）+ `node scripts/check-scope.mjs`。
- 真机验收（用户执行）：点「提炼记忆」→ 切「按消息」→ 勾选若干条 → 合计实时
  更新 → 提炼 → toast 回执 → 设置「自动记忆」tab 出现新条目；勾选超 60k 字时
  确认禁用；翻到更早历史仍可勾选；「按会话」模式行为与 Y2 完全一致。
