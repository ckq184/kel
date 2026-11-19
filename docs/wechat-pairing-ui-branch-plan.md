# 任务立项：微信账号连接弹窗补上配对码区块

> 立项日期：2026-11-19｜base：`c011258`｜状态：方案已获用户确认（本对话，按正式修复立项）
> 性质：真 Bug 修复（前端渲染位置错误，无后端/schema 改动）。

## 1. 背景与取证

### 1.1 现象

用户用微信扫码完成 bot 账号授权（UI 显示已连接、测试连接通过），微信会话发消息只收到
「此微信会话尚未配对。请在网页设置中生成配对码，然后发送 /pair <配对码>。」；
但 CKQClaw 前端（web 与桌面同源，Electron 仅 `loadURL` 同一 React 前端）里**拿不到微信的配对码**，
QQ 账号却可以。

### 1.2 根因（已读代码复核）

- 后端完全支持微信配对：`src/routes/channel-accounts.ts` `PAIRING_CHANNEL_PROVIDERS = {'qq','wechat'}`
  （`POST /api/channel-accounts/:id/pairing-code` 对已授权 `qr_session` 账号可用；`has_credentials` 对
  `auth_status==='authorized'` 的扫码账号恒为 true）。
- 前端 `web/src/components/settings/ChannelAccountsManager.tsx` `AccountConnectionDialog` 按
  `definition.authMode` 三元分支渲染弹窗主体：`qr_session`（仅微信）分支只渲染
  「网络方式 + 扫码与连接状态」；**`AccountPairingSection`（生成配对码 UI）位于 else
  （credentials）分支内**，因此微信弹窗永远不渲染配对区，QQ（credentials）正常。
- 桌面端与 web 端为同一前端（`electron/src/main/index.ts` `loadURL(rendererUrl)`），两端表现一致，
  非桌面/web 差异。

### 1.3 关联事实（本任务不改，仅记录）

微信扫码授权 ≠ 会话配对（`src/routes/config.ts` QR 确认路由注释明确扫码人不自动配对），
会话仍须 `/pair <配对码>`；本任务只修「配对码 UI 拿不到」，不改配对协议本身。

## 2. 方案

`AccountConnectionDialog` 内把配对区渲染从 credentials 分支提出：

```tsx
const pairingSection =
  supportsChannelPairing(account.provider) && account.has_credentials ? (
    <AccountPairingSection account={account} />
  ) : null;
```

- credentials 分支原位置渲染 `{pairingSection}`（QQ/飞书视觉零变化；飞书 `supportsPairing=false` 不渲染）；
- `qr_session` 分支在「扫码与连接状态」之后渲染 `{pairingSection}`（微信新增）；
- `PairingSection` 自带 `mt-4 border-t border-border pt-4` 分隔样式，两分支无需额外包装。
- 条件 `account.has_credentials` 对已授权扫码账号为 true、未扫码为 false，天然保持
  「未授权不显示配对区」的现有语义。

## 3. 裁决（用户已确认）

| 方案                                     | 评估                                                            |
| ---------------------------------------- | --------------------------------------------------------------- |
| **配对区移出分支、两分支各渲染（采纳）** | 一处 JSX 重组；QQ 零视觉变化；微信补齐入口                      |
| 扫码确认后自动配对扫码人                 | 属配对协议语义变更（弃用 `ilink_user_id` 的既有设计），另立任务 |
| 仅文档指导用户用 API 直取配对码          | 临时方案，UI 缺陷仍在                                           |

## 4. 已知边界（接受）

- 未扫码授权（`has_credentials=false`）的微信账号仍不显示配对区——与修复前一致，属预期。
- 配对码生成/校验逻辑（5 分钟过期、一次性、账号归属校验）不在本任务范围，行为不变。

## 5. 不做

- 不改后端、不改配对协议、不改 schema、不碰 `data/`；不改 CI/lint/门禁配置；不 push、不重启服务。
- 不新增依赖。

## 6. 步骤（TDD）

1. 立项提交（本文档 + `.gatescope.json`，base `c011258`）。
2. 新增 `tests/wechat-pairing-dialog-dom.test.tsx`（happy-dom + createRoot/createMemoryRouter，
   mock `stores/channel-accounts` 与 `hooks/usePairingCode`/`usePairedChats`）：
   - 微信 `qr_session` 已授权账号渲染 `AccountConnectionDialog` → 弹窗包含「聊天配对」与「生成配对码」（先红）；
   - QQ credentials 账号回归：配对区仍存在；
   - 微信未授权账号（`has_credentials=false`）：不渲染配对区。
   - 为可测性将 `AccountConnectionDialog` 从模块导出（仅加 `export`，无行为变化）。
3. 实现第 2 节方案，测试转绿。
4. `npm run verify` 六步全绿 + `node scripts/check-scope.mjs` 通过，实现单独提交，不 push。

## 7. 风险与未验证项

| 风险                                       | 应对                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Radix Dialog 在 happy-dom 下的 portal 渲染 | 仓库已有 happy-dom DOM 测试先例；断言基于 `document.body` 文本；若 portal 不渲染则改为断言组件树输出 |
| mock store 形状与真实 store 漂移           | mock 仅覆盖渲染所需字段；类型由 `ChannelAccount` 接口约束不了运行时，评审时人工核对                  |
| 用户侧验证需要真实扫码环境                 | 修复后由用户在桌面端「管理连接」弹窗目视确认配对区出现并生成配对码                                   |
