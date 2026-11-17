# 任务 AP 立项：移除监控页「Anthropic 服务状态」卡片

> **状态**：方案已经用户确认（2026-11-17），待执行。
> **排查会话**：ZCode（2026-11-17，Explore 全仓 very thorough 搜索 + 人工核读 MonitorPage.tsx）。

---

## 0. 一句话结论

监控页（`/monitor`）顶部的「Anthropic 服务状态」卡片整体移除：它是纯前端行为（浏览器直连 `https://status.claude.com/api/v2/status.json` 拉取 + 每 5 分钟轮询，展示如 "Partially Degraded Service" 的第三方状态文案与官方状态页外链），**全部代码只在一个文件** `web/src/pages/MonitorPage.tsx`，用户不需要此功能。

## 1. 勘察结论（已逐项核实）

- 功能四件套全在 `web/src/pages/MonitorPage.tsx`：`ExternalLink` import（:18，仅此卡使用）、`claudeStatus` state（:43，不入 store 无 props）、fetch+轮询 `useEffect`（:55-81）、展示 `<Card>`（:157-178，含「官方状态页」外链）
- 后端 `src/` 零参与：无 API 路由、无定时任务、无缓存、无代理；fetch 发生在用户浏览器直连第三方
- 无配置/环境变量开关；无测试引用（`tests/`、`web/` 搜 MonitorPage/claudeStatus/Degraded/status.claude 均 0 命中）；无 CSP 牵连
- **两个同名功能不动**（易混淆项，已核实无关）：聊天页「智能体处理中」spinner（StreamingDisplay 的 `formatSystemStatus`，链路 session.setSystemStatus → SSE statusText → chat store）；ChatView 的 IM 通道未配置横幅（`/api/config/user-im/status`）。`/api/status` 与 `useMonitorStore` 是容器/队列监控，同样保留
- `web/dist/` 旧产物含该字符串：gitignored，verify 的 build 步骤自动重建，不手改

## 2. 方案

`web/src/pages/MonitorPage.tsx` 删四处：行 18 import、行 43 state、行 55-81 useEffect、行 157-178 Card。`status &&` 容器（space-y-6）首个子元素变为 Docker 镜像卡，纯删除不重排，无其他改动。

## 3. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 用户可见功能移除（监控页少一张卡） | 即需求本身 |
| R2 | 删除后监控页其余卡片回归 | 纯删除不动容器结构；浏览器目检 |
| R3 | dist 旧产物残留 | verify build 自动重建 |
| R4 | scope 漂移 | allow 仅 2 路径 + check-scope |

## 4. 验收标准

1. `npm run verify` 六步全过；`node scripts/check-scope.mjs` 过
2. 浏览器目检 `/monitor`：Anthropic 卡片消失，Docker 镜像/队列/系统信息/群组状态卡片正常
3. 全仓源码 grep `status.claude|claudeStatus` 仅剩本计划文档

## 5. 执行步骤

0. 立项（本文档 + `.gatescope.json`，base=70c697e）→ 立项 commit
1. MonitorPage.tsx 删四处
2. 验收（§4）
3. 任务 commit（push 由用户显式发起）
