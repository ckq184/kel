# 任务 AJ 立项：IM 渠道裁剪——删除 Telegram / Discord / WhatsApp,保留飞书 / QQ / 钉钉 / 微信

> **状态**:2026-11-12 用户指示立项(计划已经用户审批)。本文档即范围声明。
> **基线**:`.gatescope.json` base = `f1bfd12`(任务 AI 单提交)。

---

## 0. 一句话结论

产品只需国内四渠道(飞书/QQ/钉钉/微信)。把 Telegram、Discord、WhatsApp 三个渠道从后端接入能力、前端界面、类型枚举、runner prompts、依赖(baileys/discord.js/grammy)、测试与活文档中**全部移除**;存量数据按用户拍板走 **DB 迁移清理删除**(不留停用行、不留前缀识别键)。

## 1. 已拍板裁决(用户 2026-11-12 确认)

1. **存量 `channel_accounts` 行:写迁移清理删除**。不做「保留行+跳过防护」,不做「自动停用」——最干净路径,迁移前自动备份兜底(宪法第 2 条)。
2. **`CHANNEL_PREFIXES` 三键(telegram:/discord:/whatsapp:)彻底删除**,不保留历史识别;旧前缀 JID 的关联行由迁移一并清理,不留孤儿数据。
3. 界面与接入白名单只出现飞书/QQ/钉钉/微信四渠道。

## 2. 范围(三类)

- **整文件删除(8)**:`src/{telegram,telegram-pairing,discord,discord-streaming-edit,whatsapp}.ts`、`container/agent-runner/prompts/channels/{telegram,discord,whatsapp}.md`。
- **修改**:后端共享层(im-channel/im-manager/index/db/schemas/types/routes/runtime-config/web-context/web 等 ~28 文件)、container runner 侧 4 文件、前端 14 文件、测试 58 改 + 4 删 + 1 新增(迁移测试)、`package.json`(删三依赖与 keyword)、活文档 5(AGENTS/CLAUDE/README/SECURITY/docs/API)。
- **不动**:`data/` 敏感目录(运行时残留 `data/config/telegram-provider.json`、`data/config/user-im/<uid>/{telegram,discord,whatsapp}.json`、`whatsapp-auth/` 交付清单由用户自行清理);DB 历史迁移 SQL(append-only 保留);`qrcode` 依赖(微信扫码共用);electron/(零牵涉)。

## 3. 执行顺序(8 步,任务内一次完成,中间态编译不过属预期,不中途提交)

| 步  | 动作                                                                                                                            | 关键点                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | 立项(本文档 + `.gatescope.json`)                                                                                                | base=`f1bfd12`                                                                                                                                                                     |
| 1   | DB 迁移:`CURRENT_SCHEMA_VERSION`+1                                                                                              | 删 `channel_accounts` 三 provider 行;清各表三前缀 JID 关联行(执行时按 db.ts 全部含 jid/provider 列的表逐一盘点);剔除存量任务 `notify_channels` 三渠道值;带备份、前向升级、拒绝降级 |
| 2   | 删渠道本体 5 文件 + `im-channel.ts`/`im-manager.ts` 三适配器与连接管理                                                          | 七渠道共用枢纽,逐段核对不误伤保留渠道                                                                                                                                              |
| 3   | 宿主挂载:`index.ts` ~20 区段、`routes/config.ts`、`routes/channel-accounts.ts`、`runtime-config.ts`、`web-context.ts`、`web.ts` | index.ts 区段耦合,逐段核对                                                                                                                                                         |
| 4   | 外围共享层 + runner 侧 + 类型/前缀收窄,`make typecheck` 三侧扫尾                                                                | discord MCP 工具横跨宿主 IPC 与 runner 注册两侧;前缀表三副本同步                                                                                                                   |
| 5   | 前端 14 文件                                                                                                                    | QrOnboardingPanel 微信/WhatsApp 共用,删支路保微信扫码不回归                                                                                                                        |
| 6   | 测试:4 整删、import 断裂重写、~54 文件 fixture 批改、新增迁移测试                                                               | 断言弱化风险,重点文件逐一核对                                                                                                                                                      |
| 7   | 依赖清理:删 baileys/discord.js/grammy + telegram keyword,npm install 再生 lockfile                                              | qrcode 保留;确认 container 镜像不引三库                                                                                                                                            |
| 8   | 活文档同步 + `npm run verify` + `node scripts/check-scope.mjs` + 单提交                                                         | Conventional Commits                                                                                                                                                               |

## 4. 验收标准

1. `npm run verify` 六步全绿;`check-scope` 零越界。
2. `make dev` 冒烟:设置页「我的渠道」、新建账号表单、绑定 tabs、任务页渠道下拉**仅**飞书/QQ/钉钉/微信;微信扫码 onboarding 正常;保留渠道 test 连通不受影响。
3. 旧库升级:含三渠道账号行的库启动后迁移执行、版本号前进、降级被拒、无孤儿行。
4. 全仓(除 data/、历史迁移 SQL、历史任务文档)grep `telegram|discord|whatsapp`(大小写不敏感)在 src/web/container/shared/scripts/package.json 零业务命中。

## 5. 风险

| 风险                                         | 缓解                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| 迁移删数据不可逆(已拍板)                     | 迁移前自动备份 + 拒绝降级 + 新增迁移测试                |
| 中间态编译断裂横跨 ~40 后端文件              | 任务内一次完成,不中途提交,typecheck 三侧扫尾            |
| index.ts 区段耦合 / discord MCP 双侧链路漏删 | 逐区段核对 + 编译器扫尾 + 冒烟                          |
| 前端误伤微信扫码共用面板                     | QrOnboardingPanel 单独核对 + 前端测试                   |
| 58 个测试文件改动弱化断言                    | 重点测试逐一核对,不只跑绿                               |
| 宪法红线                                     | verify 六步 + check-scope 全跑;data/ 不动;DB 迁移带备份 |
