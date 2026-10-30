# Auto-memory 侧车所有权架构修复方案（Qdrant local 单写者锁）

> **文档定位**：任务 C 验收发现的新遗留的架构级修复方案。自包含交接——新会话
> 只读本文即可动工，无需任务 C 会话上下文。
> **建议注入语**：「阅读 docs/auto-memory-sidecar-ownership-plan.md，按任务 T1 开工。」
> **写作时点**：2026-10-17。基线提交：`f7afd08`（任务 C 验收提交，即回滚点）。
> **路线裁决状态**：推荐 R1（宿主单例侧车 + 文件 IPC），备选对比见 §3；
> 动工前需用户对 §6 风险 1（宿主 mem0ai 依赖）点头。
> **执行状态（2026-10-17 更新）**：T1 ✅ `9588099`（宿主 AutoMemorySidecarManager
> + 契约测试）｜T2 ✅ `331e68e`（IPC handler case 'auto_memory'）｜T3 ✅
> `1abdd24`（runner 传输切换文件 IPC，ctx 收窄）｜T4 ✅ `8944c17`（宿主输入
> 收窄，秘钥面测试）｜T5 ✅ 本提交（runner sidecar-client 删除 +
> install-host-tools.sh mem0ai + 文档同步）｜T6 ✅ 真机验收完成（2026-10-17 场景
> 执行 + 2026-10-20 召回内容复验：embedder 换新 key 后经 IPC 直驱请求文件全链路
> 实测——search `success:true` 召回任务 C 存量 3 条记忆、add `[ADD]` 抽取正常，
> glm-4.6/embedding-3 均健康；六项清单全绿。最终验收签收待用户）。

---

## 0. 一句话结论

auto-memory 侧车从「每个 runner 进程各养一个」改为「宿主 server 按 workspace
单例持有」，runner 经现有文件 IPC 通道（`data/ipc/{folder}/tasks/`，与
workspace_memory 同款协议）访问；Qdrant local 的单写者锁由构造保证不再冲突，
同时把 llm/embedder 端点从容器 stdin 中彻底移除（秘钥面收窄）。

---

## 1. 缺陷与实测证据

- **现象**（任务 C 验收 4，证据 `docs/TASK-C-ACCEPTANCE.md`）：交互 turn 的暖
  容器存活期间，`POST /api/tasks/:id/runs` 拉起的隔离任务容器里，
  `auto_memory_search` 侧车 init 失败：
  `Storage folder /workspace/extra/auto-memory is already accessed by another
  instance of Qdrant client.` 任务轮记忆不可读（显式降级，v2 不受影响）。
- **根因**：侧车是 **per-runner-process 单例**
  （`container/agent-runner/src/auto-memory/sidecar-client.ts` 的
  `configureAutoMemory`/`getAutoMemory`，`mcp-tools.ts:2912` 装配）。暖交互
  容器跨 turn 常驻（`pi-index.ts` runTurn 循环 + `waitForNextInput`），其侧车
  持有 Qdrant local 对 `data/extra/{folder}/auto-memory` 的排他锁（`.lock`）
  贯穿容器生命周期；隔离任务容器是独立进程/容器，必然后到。
- **为什么小修不行**：锁重试/退避救不了——暖容器存活期锁不释放，任务轮将
  永远等待或降级；「空闲释放锁」方案引入侧车反复冷启动（mem0 init 秒级）且
  仍存在竞态窗口。锁冲突是 per-runner 所有权模型的构造性问题。

## 2. 现状关键事实（改动前必读）

| 事实 | 位置 |
|---|---|
| 侧车 Python 脚本（stdio JSON-lines：init/add/search/get/delete/delete_all/ping） | `container/agent-runner/python/auto_memory_sidecar.py` |
| Node 桥（spawn/init 握手/请求超时/重启预算——任务 C 已修：成功握手归零） | `container/agent-runner/src/auto-memory/sidecar-client.ts` |
| 工具层装配（ctx.autoMemory → configureAutoMemory → 三工具；`callAutoMemory` 包装 `{available}` 降级） | `container/agent-runner/src/mcp-tools.ts:2906-3050` |
| 宿主端点配置（`MINICLAW_AUTO_MEMORY` env > `data/config/auto-memory.json`；llm+embedder 成对；30s 缓存） | `src/auto-memory-config.ts` |
| 端点注入容器：docker `/workspace/extra/auto-memory` | `src/container-runner.ts:1861`（dockerInput） |
| 端点注入容器：host-mode `data/groups/{folder}/extra/auto-memory` | `src/container-runner.ts:2888`（hostInput） |
| `buildAutoMemoryInput` | `src/container-runner.ts:346` |
| `ContainerInput.autoMemory` 双镜像（字段必须同步） | `src/container-runner.ts:395-405` ↔ `container/agent-runner/src/types.ts:239` |
| **可复用的 IPC 通道**：runner 请求方 `pollIpcResult(tasksDir, request, prefix, timeoutMs)` | `container/agent-runner/src/mcp-tools.ts:104`（用法见 :267 workspace_memory） |
| **可复用的 IPC 通道**：宿主应答方 `case 'workspace_memory'`（owner/actor/workspaceJid 解析链 + `writeTaskResult`） | `src/index.ts:12157`（`writeTaskResult` :11709） |
| 请求文件落点 = `ctx.workspaceIpc/tasks/`（`data/ipc/{folder}/tasks/`） | 同上 |
| 侧车脚本解析（env 覆盖 `MINICLAW_AUTO_MEMORY_SIDECAR` > 包根上溯 > `/app/python` 回退） | `sidecar-client.ts` `findSidecarScript` |
| 秘钥面现状：llm/embedder apiKey 随 stdin bootstrap 进容器 | `ContainerInput.autoMemory.llm/embedder` |

## 3. 路线对比（已裁决推荐 R1，勿重新发明）

| 路线 | 思路 | 结论 |
|---|---|---|
| **R1 宿主单例侧车 + 文件 IPC**（推荐） | 宿主 server 按 folder 持有唯一侧车进程；runner 走 `data/ipc/{folder}/tasks/` 请求/应答文件 | 单写者由构造保证；秘钥全部收回宿主；复用 workspace_memory 成熟通道；代价=宿主需 mem0ai（§6 风险 1） |
| R2 锁重试/空闲释放 | 任务轮侧车 init 退避重试；或暖 runner 侧车空闲 N 分钟自杀放锁 | 否决：暖容器存活期锁不放，任务轮永远不可读；空闲释放有竞态窗口 + 反复冷启动 |
| R3 容器间互访（锁持有者代理） | 首个抢到锁的侧车做 owner，其他 runner 经 socket/文件代理 | 否决：`docker run --rm` 临时容器无稳定互访通道；Windows 卷上 unix socket 不可靠 |
| R4 外挂 Qdrant server 容器 | 本地模式换 server 模式 | 否决：推翻任务 0 侦察结论（免外挂向量容器）；多一个常驻服务与治理面。若未来多写者压力真实出现再议 |

## 4. 目标架构

```
runner 容器/进程（Pi 路径，无变化感知）
  └─ mcp-tools 三工具（auto_memory_search/add、memory_promote）
       └─ callAutoMemory ──改为──> pollIpcResult(type='auto_memory')   [文件 IPC]
                                        │  写请求文件 data/ipc/{folder}/tasks/*.json，轮询应答
宿主 server（唯一写者）
  ├─ IPC dispatch 新 case 'auto_memory'（src/index.ts，仿 :12157 workspace_memory）
  │    folder/workspaceJid/owner 从 IPC 命名空间推导（不信任模型提供的任何标识）
  ├─ AutoMemorySidecarManager（新 src/auto-memory-sidecar-manager.ts）
  │    per-folder 单例：懒 spawn `python <repo>/container/agent-runner/python/auto_memory_sidecar.py`
  │    init 握手（snake_case 协议，任务 C 已定）；op 串行队列；空闲 TTL 关停；崩溃重启（成功握手归零预算）
  └─ 端点配置（src/auto-memory-config.ts，零改动）只喂给侧车进程，不再进任何 runner
```

设计要点：

1. **宿主侧数据路径按 workspace 执行模式解析**（host 上没有 /workspace）：
   `execution_mode=container` → `data/extra/{folder}/auto-memory`（现有数据原位，
   免迁移）；`host` → `data/groups/{folder}/extra/auto-memory`。`folder` 一律取自
   IPC 命名空间。
2. **op 串行**：mem0 Memory 实例非线程安全，per-folder 单队列即可，不做并发优化。
3. **空闲 TTL**：实测侧车 RSS ≈140MB；默认空闲 10 分钟关停（可配
   `data/config/auto-memory.json` 扩展字段或 env），下次调用懒重启（崩溃恢复
   同一条路径，任务 C 已验证该模式）。
4. **Python 解释器解析（Windows 坑）**：本机 `python3` 是 WindowsApps stub
   （exit 49）。解析顺序：新 env `MINICLAW_AUTO_MEMORY_PYTHON` > win32 下
   `py -3` > `python3`。解析失败 = 显式 unavailable 降级，不崩。
5. **降级语义不变**：一切失败仍收敛到 `{available:false}` → 工具层显式
   unavailable 文案；「auto memory 永不弄挂 turn」契约保持。
6. **秘钥面收窄（顺带的安全收益）**：`ContainerInput.autoMemory` 不再携带
   llm/embedder（docker 与 host-mode 两侧），容器 stdin 只有 `enabled` 标志。
   `src/auto-memory-config.ts` 顶部「endpoints ride stdin」注释随之更新。

## 5. 任务拆解（TDD，每任务独立提交；回滚点 = 上一任务提交）

| # | 任务 | 范围 | 验收 |
|---|---|---|---|
| T1 | 宿主 `AutoMemorySidecarManager`：spawn/init/op 队列/空闲 TTL/崩溃重启/解释器解析 | 新 `src/auto-memory-sidecar-manager.ts`；测试 fixture 复用 `container/agent-runner/tests/fixtures/fake-auto-memory-sidecar.mjs`（复制到根 `tests/fixtures/`） | fake 侧车契约测试：懒 spawn、握手、串行、TTL 关停、连续崩溃恢复（4 轮）、解析失败显式降级 |
| T2 | 宿主 IPC handler `case 'auto_memory'`（search/add/get 三操作） | `src/index.ts` dispatch；复用 workspace_memory 的 owner/actor/workspaceJid 解析链 | 集成测试：伪造请求文件 → 侧车被调 → 应答文件落盘；非法 requestId 拒绝 |
| T3 | runner 传输切换：`callAutoMemory` 改走 `pollIpcResult(type='auto_memory')`；工具注册门不变 | `mcp-tools.ts`；`pi-index.ts`/`index.ts` ctx.autoMemory 收窄；`types.ts` 双侧镜像同步 | 既有测试全绿（`pi-auto-memory-wiring.test.ts` 改写为新契约：ctx 不再需要端点）；新增 IPC 客户端单测 |
| T4 | 宿主输入收窄：`buildAutoMemoryInput` 不再携带端点进任何 runner；docker/host 两侧 | `src/container-runner.ts` | 秘钥面测试：stdin bootstrap 断言无 `apiKey`/`baseUrl` 键 |
| T5 | 清理与文档：runner 内 `sidecar-client.ts` 迁移/删除；AGENTS.md 速览与安装说明（宿主 mem0ai 前置 + `install-host-tools.sh` 扩展项）；`workspace-memory-v2.md` 自动层承载描述；`TASK-C-ACCEPTANCE.md` 已知限制勾销；本文件状态更新 | docs + 脚本 | docs:check 绿；文档与实现一致 |
| T6 | 真机验收（§7） | dev server + container 工作区 | 清单全绿 |

工作量估计：1~1.5 天（T1/T2 各半天，T3 半天，T4/T5/T6 合计半天）。

## 6. 风险与缓解

1. **宿主 mem0ai 依赖（需用户确认）**：侧车迁宿主后，宿主机需要
   `pip install mem0ai==2.2.1`（含 openai、qdrant-client）。此前 docker 模式
   靠镜像内预装、宿主可无 Python。缓解：`install-host-tools.sh` 扩展 mem0ai
   安装（版本钉 `scripts/builtin-mcp-catalog.mjs`）；宿主缺 mem0ai 时显式
   unavailable 降级（同「未配置」文案语义）；镜像预装保留（回滚保险）。
2. **文件 IPC 延迟**：轮询应答有几十至几百 ms 开销；auto_memory 操作大头是
   embedder 网络往返（百 ms 级），可接受。`pollIpcResult` 间隔沿用现状。
3. **host-mode 数据路径分叉**：container/host 两种 workspace 的侧车数据目录
   不同（§4-1）；按 `execution_mode` 解析，写表驱动测试钉住，防串目录。
4. **多 server 实例**：与 workspace_memory 同假设（单 server）。无新增风险。

## 7. 验收清单（真机，T6）

1. **原始缺陷翻转**：交互 turn 暖容器存活期间，`POST /api/tasks/:id/runs`
   隔离任务轮 prompt 要求 `auto_memory_search` → 成功召回此前存入的事实
   （修复前报 already accessed by another instance）。
2. **任务 C 回归**：验收 1（跨 Session 召回）、6（侧车崩溃恢复——改为
   kill 宿主侧侧车进程，下一次调用自动重启）经新路径复验通过。
3. **任务轮只读不变**：任务轮 `auto_memory_add`/`memory_promote` 不注册、
   `auto_memory_search` 在（`tests/mcp-memory-promote-idempotency.test.ts`
   既有断言保持绿）。
4. **未配置/缺 mem0ai 降级**：三工具显式 unavailable 文案、`workspace_memory_*`
   不受影响。
5. **秘钥面**：容器 stdin bootstrap 无 llm/embedder 端点键（T4 测试 + 真机
   `docker exec … cat /tmp/input.json` 复核）。
6. **门禁**：全量 vitest 失败文件集合 = 基线（stash 对比法，同任务 C）；
   双侧 typecheck；`build:all`；`docs:check`。

## 8. 非目标

- 不引入外挂向量库容器（R4 留档不实施）。
- 不改 mem0ai 版本、不改冲突消解语义（另有配额依赖补测，见
  `docs/REMAINING-WORK.md`）。
- 不做多 server / 多机共享侧车。
- 不动 Workspace Memory v2（宿主 `memory-service.ts`/`memory-store.ts`）。
