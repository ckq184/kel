import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

describe('Feishu route safety integration', () => {
  test('treats a configured resolver returning null as a dropped message', () => {
    // ISSUE-12 单元 2.8：路由准入决策体（resolveAdmittedChannelRoute 调用与
    // 拒绝文案）自 src/feishu.ts 主管道原文搬运至
    // src/feishu-inbound-admission.ts，断言目标随搬迁同提交改锚新模块切片，
    // 文案与终态语义不变（binding_rejected 终态记账仍由主管道 verdict 分支
    // 执行，见 feishu-inbox-claim-lifecycle.test.ts 的 21 行表）。
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/feishu-inbound-admission.ts'),
      'utf8',
    );

    // 带尾随 "(" 的调用形（排除头部 AdmittedFeishuRoute 类型别名同名
    // instantiation 表达式，锚真正的 fail-closed 路由调用）。
    expect(source).toContain('resolveAdmittedChannelRoute<FeishuMessageMeta>(');
    expect(source).toContain(
      'Feishu binding resolver rejected route; dropping message',
    );
    expect(source).not.toContain('agentRouting?.effectiveJid ?? chatJid');
  });

  test('bootstraps an unregistered P2P chat before the route check, so the first-ever DM is not fail-closed forever', () => {
    // ISSUE-12 单元 2.8：P2P 自举探测与严格路由检查同段搬运，顺序锚随迁。
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/feishu-inbound-admission.ts'),
      'utf8',
    );

    // P2P has no external "bot added" event like groups (onBotAddedToGroup)
    // and no /pair step like other channels, so the first DM must be able
    // to register the chat itself before resolveAdmittedChannelRoute is
    // consulted — otherwise a brand-new chat can never pass the route check
    // that must precede its own registration, dropping every message
    // forever. See channel-admission.ts's "pairing establishes ownership
    // before routing" contract.
    //
    // Only the ORDER is pinned here (the first onNewChat call precedes the
    // strict route check); the behavior itself — including that the
    // im-manager wrapper throws ChannelRouteRejectedError instead of
    // returning null — is covered end to end by
    // feishu-p2p-first-dm-bootstrap.test.ts.
    const bootstrapIdx = source.indexOf(
      'onNewChat?.(chatJid, resolvedChatName)',
    );
    // 带尾随 "(" 以排除文件头部 AdmittedFeishuRoute 类型别名中的同名
    // instantiation 表达式（ReturnType<typeof resolveAdmittedChannelRoute<
    // FeishuMessageMeta>>），只锚真正的路由调用。
    const routeCheckIdx = source.indexOf(
      'resolveAdmittedChannelRoute<FeishuMessageMeta>(',
    );

    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(routeCheckIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeLessThan(routeCheckIdx);
  });
});
