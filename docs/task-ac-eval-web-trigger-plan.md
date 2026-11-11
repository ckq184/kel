# 任务 AC 立项:评测中心 Web 触发(命令行执行器上移为看板按钮)

> **状态**:2026-11-11 用户批准立项(用户提出「为什么测评不做可视化,还要去终端执行命令行」并裁决「做」;设计轮廓即对话中给出的 trigger + WS 进度 + 互斥 + 费用确认方案)。实现未开始,按 §3 顺序 TDD 执行。基线 `1f7d035`(任务 AB 收官提交)。
> **回滚点**:立项提交的父 HEAD `1f7d035`(`.gatescope.json` 的 base;实现 diff 基线=立项提交)。
> **前置条件**:任务 AB 已交付(eval.db + `/api/eval` 只读 API + 评测页;`scripts/eval-auto-recall.ts` 默认落库)。

---

## 0. 一句话结论

给「评测」页 Tab1 加一个 admin-only 的「运行评测」按钮:宿主以**子进程**方式 spawn 既有命令行执行器(`npx tsx scripts/eval-auto-recall.ts`),进度日志经 WS(admin-only)实时回传,完成自动刷新 run 列表——执行器本体零改动,平台仍不内嵌评测管线(langfuse「外部执行器」分工不变,只是把终端搬进看板)。

## 1. 已拍板裁决(2026-11-11 用户确认)

1. **子进程 spawn,不把管线搬进服务进程**:评测绑宿主环境(Python 侧车/embedder 端点/golden set),长阻塞任务留在独立进程;服务重启产生的孤儿评测进程自行跑完落库,状态丢失无害(文档注明)。
2. **仅 `manage_system_config` 可触发**:费用敏感(真实 embedder/LLM 请求),按钮带费用确认弹窗;进度 status 端点同为 admin-only(日志含 golden query 文本片段)。
3. **互斥 + 超时**:同一时刻仅一个评测(409);15 分钟超时强杀(monitor docker-pull 10 分钟先例的量级放宽,embedder 慢)。
4. **进度通道 = WS(admin-only)+ 初始 status 拉取**:`eval_run_log`/`eval_run_complete` 事件,沿 `docker_pull_log/complete` 先例(web.ts 注入广播)。
5. **参数白名单**:k(整数 1–10)、runName(`/^[\w-]{1,64}$/`,缺省脚本时间戳)、reset(布尔);Windows spawn 走 `shell:true`,白名单闭合注入面。

## 2. 方案设计

- `src/eval-trigger.ts`(新):模块级状态机 `{running, startedAt, startedBy, lines(环形 200), result}`;`startEvalRun({k, runName, reset, startedBy}) → {ok:true}|{ok:false,error:'busy'}`;spawn 默认实现 `npx tsx scripts/eval-auto-recall.ts …`(cwd=PROJECT_ROOT;win32 加 shell:true);stdout/stderr 逐行收集+广播;close/error/timeout→result+`eval_run_complete`;`injectEvalTriggerDeps({broadcastLog, broadcastComplete})`(web.ts 两处注入,沿 injectMonitorDeps);spawn 工厂可注入(测试)。
- `src/routes/eval.ts`(改):`POST /runs/trigger`(authMiddleware+systemConfigMiddleware;校验→busy 409→202)、`GET /runs/trigger/status`(同权限,返回状态+日志 tail)。
- `src/web.ts`(改):`broadcastEvalRunLog/broadcastEvalRunComplete`(safeBroadcast adminOnly=true)+ startWebServer 与 createAppForTest 两处注入。
- `web/src/pages/EvalPage.tsx`(改):admin 见「运行评测」按钮 → Dialog(k 下拉 1–10 默认 5、runName 输入、reset 复选、费用确认文案)→ 运行中禁用按钮 + 日志面板(WS 订阅 + 初始 status)+ complete 后刷新 run 列表。

## 3. 执行顺序(TDD,每批次先写测试见红)

1. **批次 1 触发器**:`tests/eval-trigger.test.ts` 见红(状态机/busy/参数拼装/日志环形/超时/广播回调注入 spawn 全 mock)→ `src/eval-trigger.ts`。
2. **批次 2 API+WS**:`tests/eval-routes.test.ts` 扩展见红(401/403/400/409/202/status 形状)→ routes + web.ts 注入。
3. **批次 3 前端**:`tests/eval-frontend.test.tsx` 扩展见红(按钮仅 admin/弹窗字段/运行中禁用)→ EvalPage。
4. **批次 4 文档+门禁**:API.md/AGENTS.md/CLAUDE.md → `npm run verify` → `node scripts/check-scope.mjs` → 单提交 `feat: 观测 - 评测中心 Web 触发（任务AC）`。

## 4. 文件清单(= `.gatescope.json` allow)

新增:`docs/task-ac-eval-web-trigger-plan.md`、`src/eval-trigger.ts`、`tests/eval-trigger.test.ts`
修改:`src/routes/eval.ts`、`src/web.ts`、`web/src/pages/EvalPage.tsx`、`tests/eval-routes.test.ts`、`tests/eval-frontend.test.tsx`、`docs/API.md`、`AGENTS.md`、`CLAUDE.md`
(不动:`scripts/eval-auto-recall.ts`、eval-store、turn-observer、recall-judge。)

## 5. 风险与边界

1. **孤儿进程**:宿主重启不杀评测子进程——它自行落库后退出,仅 UI 状态丢失;status 端点重启后回到 idle(可接受,文档注明)。
2. **生产环境 tsx 可用性**:`make install` 装全量依赖(含 tsx);spawn 失败立即进 result.error 可见,不静默。
3. **Windows**:npx 需 shell:true;参数全白名单(k 数字、runName `[\w-]`、固定旗标),注入面闭合。
4. **费用**:确认弹窗明示真实 embedder/LLM 请求费用;仅 admin。
5. **并发**:模块级互斥挡住双击/多 admin;不做排队(v1 显式 409)。

## 6. 门禁与验收

- 门禁:`npm run verify` + `node scripts/check-scope.mjs`。
- 真机验收(用户执行):评测页(admin)→「运行评测」→ 弹窗确认 → 进度日志滚动 → 完成后列表新增 run 且可进详情;期间 member 账号无按钮且 POST 403;运行中再次触发 409;15 分钟超时路径(可省,靠单测覆盖)。
