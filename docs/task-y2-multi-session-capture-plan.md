# 任务 Y2 立项：多会话选择提炼记忆（任务 Y 延伸）——交接文档

> **状态**：2026-11-10 用户确认计划执行（三项设计裁决已拍板，见 §1）。基线 = 任务 Y 提交
> `c4e808f`；实现按 §3 批次 TDD 执行（先见红再实现），不做 §5 非目标。
> **回滚点**：`c4e808f`（`.gatescope.json` base）。

---

## 0. 一句话结论

任务 Y 的「提炼记忆」只提炼当前所在的单个会话。本任务把 preview/capture 扩展为
**多会话合并**：对话框勾选「主会话 + 各 conversation 子会话」→ 合并后仍按共享预算
（最新 400 条 / 60k 字）封顶 → 一次模型调用提炼。零新增依赖、不动 DB schema、
权限面不变（preview=read / capture=write）。

## 1. 已拍板裁决（2026-11-10 用户确认，无需再问）

1. **预算 = 共享封顶**：合并所选会话全部消息后，从最新往回保留 ≤400 条且 ≤60k 字
   （先触先停）。单次成本封顶、一次模型调用、前端 90s 超时不变的承诺延续。
   每会话独立预算（N 倍成本 + 单次 add 输入过大）已被否决。
2. **API = 纯复数、不留单数兼容**：capture 端点未发布、唯一调用方同仓同批改造。
   preview 用重复 query 参数 `?agentId=&agentId=a1`（Hono `queries()` 原生）；
   capture body 用 `{ agentIds: string[] }`。缺省/无参数 = 仅主会话。
3. **交互 = 独立对话框一体化**：新组件 `CaptureMemoryDialog.tsx`（勾选列表 +
   勾选变化 300ms 防抖重新 preview + 实时合计 + 「提炼」确认 busy 防重入 +
   回执/失败 toast）。默认勾选当前所在会话。ChatView 只动接线（~30 行）。

## 2. 会话标识约定（API 契约核心）

- `agentIds` 元素 `''`（空串）= **主会话**，其余 = agentId（子会话虚拟 jid
  `${jid}#agent:${agentId}`）。空串永不可能是真实 agent id，与任务 Y「缺省 =
  主会话」语义连续。
- 解析规则：无参数/缺省 → `['']`；显式空数组 → 400 `invalid_args`（调用方
  bug，前端空选禁用确认）；元素逐个 trim 后去重（保序）；元素非字符串或
  trim 后 >128 字符 → 400。未知/已删除的 agentId 贡献 0 条、静默跳过；
  全部目标为空 → capture 400（空会话语义沿用任务 Y）。
- metadata：`{ source: 'chat_capture', agentIds, capturedAt }`（agentIds 原样
  含空串标记）。

## 3. 批次（TDD，每步先写测试见红再实现）

1. **批次 1 后端**：`tests/auto-memory-routes.test.ts` 改写任务 Y 用例为复数
   形态 + 新增多会话用例（合并跨会话时间交错排序、共享预算保最新、条数封顶
   跨会话混合、空串主会话、未知 agentId、去重、数组校验）→
   `src/routes/auto-memory.ts`：`assembleCaptureMessages` 改接收 jid 数组
   （每目标各取 400 条 → 按 timestamp 全局正序 → 剔除 → 共享预算从最新往回），
   preview 收重复 `agentId` query，capture 收 `agentIds[]`。
2. **批次 2 store**：`tests/auto-memory-frontend.test.ts` store 两 action 新
   签名 `(workspaceJid, agentIds: string[])`（query/body 新形状、90_000 钉住）
   → `web/src/stores/auto-memory.ts` 改造。
3. **批次 3 UI**：对话框文件断言见红 → 新增
   `web/src/components/chat/CaptureMemoryDialog.tsx` →
   `web/src/components/chat/ChatView.tsx` 接线（按钮打开对话框、移除任务 Y
   inline ConfirmDialog 与 capturePreview 状态）。
4. **批次 4 文档+门禁**：`docs/API.md` capture 小节改写多会话语义 →
   `npm run verify` → `node scripts/check-scope.mjs` → 单提交
   `feat: 记忆 - 多会话选择提炼入自动记忆按钮（任务Y2）`（push 由用户发起）。

## 4. 文件清单（= `.gatescope.json` allow）

新增：`docs/task-y2-multi-session-capture-plan.md`、
`web/src/components/chat/CaptureMemoryDialog.tsx`
修改：`src/routes/auto-memory.ts`、`web/src/stores/auto-memory.ts`、
`web/src/components/chat/ChatView.tsx`、`tests/auto-memory-routes.test.ts`、
`tests/auto-memory-frontend.test.ts`、`docs/API.md`
（不动：`src/db.ts`、`docs/ACL-MATRIX.md`——权限面不变。）

## 5. 非目标（防蔓延）

- 跨工作区多选（权限按 `:workspaceJid` 授权，不做聚合）。
- 每会话独立预算 / 分批多次 add。
- 任务/定时类 agent（kind!=='conversation'）参与提炼。
- 按会话细粒度条数配额、提炼历史记录页。

## 6. 风险

1. ChatView 热点文件——对话框逻辑全部外置，ChatView 仅接线，文件断言钉锚点。
2. 合并排序正确性——不同会话时间交错须按行内 timestamp 全局排序，交错
   seed 测试钉死。
3. 语义变化文案——勾多会话时较旧内容可能被共享预算挤掉，对话框文案明示
   「所选会话合并后最新 N 条」。
4. API 破坏性变更——旧测试全部改写；无外部调用方。
5. 防抖 preview 为纯 DB 读无成本，300ms 足够。

## 7. 门禁与验收

- 门禁：`npm run verify`（六步）+ `node scripts/check-scope.mjs`。
- 真机验收（用户执行）：点「提炼记忆」→ 对话框列出主会话与子会话、默认勾选
  当前会话 → 勾选多个 → 合计实时更新 → 提炼 → toast 回执 → 设置「自动记忆」
  tab 出现新条目；空选时确认禁用；未配置环境 toast 明确提示。
