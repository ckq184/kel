import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

/**
 * Source-string contract tests for the approval notification wiring
 * (Task B: 审批通知与 Web 审批页). These invariants span index.ts / feishu.ts
 * / im-manager.ts and have no cheap runtime harness (they need a live IM
 * connection), so they are pinned the same way as
 * channel-side-effect-ack-contract.test.ts: read the shipped source and
 * assert the wiring exists. Renaming any of these markers must update this
 * file — that is the point.
 */

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('approval IM push & decision wiring contract', () => {
  test('approval events fan out to WS broadcast and channel push before the scan service starts', () => {
    const source = readSource('src/index.ts');
    const mainIndex = source.indexOf('async function main(): Promise<void> {');
    expect(mainIndex).toBeGreaterThanOrEqual(0);
    const registerIndex = source.indexOf('registerApprovalNotifications();');
    const startIndex = source.indexOf('startApprovalService();');
    expect(registerIndex).toBeGreaterThan(mainIndex);
    expect(startIndex).toBeGreaterThan(registerIndex);

    const register = source.slice(
      source.indexOf('function registerApprovalNotifications(): void {'),
      source.indexOf('async function deliverProactiveTailInterruptionNotice('),
    );
    expect(register).toContain('onApprovalEvent(');
    expect(register).toContain('broadcastApprovalRequested(event.approval)');
    expect(register).toContain(
      'void deliverApprovalChannelNotices(event.approval)',
    );
    expect(register).toContain('broadcastApprovalDecided(event.approval)');
  });

  test('channel push reuses the outbox-backed independent notice with per-mount idempotency', () => {
    const source = readSource('src/index.ts');
    const pusher = source.slice(
      source.indexOf('async function deliverApprovalChannelNotices('),
      source.indexOf('/**\n * Wire approval events to WS broadcast'),
    );
    expect(pusher).toContain('listChannelMountsByWorkspace(workspaceJid)');
    expect(pusher).toContain('buildApprovalRequestCardText({');
    expect(pusher).toContain(
      'externalMessageId: `approval:${approval.id}:${mountJid}`',
    );
    expect(pusher).toContain("operationPrefix: 'approval-notice'");
    expect(pusher).toContain('return deliverIndependentChannelSystemNotice({');
  });

  test('/approve and /deny are owner-gated commands routed to decideApproval', () => {
    const commandUtils = readSource('src/im-command-utils.ts');
    expect(commandUtils).toMatch(/'approve',/);
    expect(commandUtils).toMatch(/'deny',/);

    const source = readSource('src/index.ts');
    const switchBlock = source.slice(
      source.indexOf('async function handleCommand('),
      source.indexOf('async function handleClearCommand('),
    );
    expect(switchBlock).toContain("case 'approve':");
    expect(switchBlock).toContain("case 'deny':");
    expect(switchBlock).toContain('handleApprovalDecisionCommand(');

    const handler = source.slice(
      source.indexOf('async function handleApprovalDecisionCommand('),
      source.indexOf('/** Feishu approval card button callback'),
    );
    expect(handler).toContain('matchApprovalByIdPrefix(');
    expect(handler).toContain('decideApproval(match.id, approved, decidedBy)');
  });

  test('Feishu approval card buttons reach the host owner gate through all three option layers', () => {
    const feishu = readSource('src/feishu.ts');
    const trigger = feishu.slice(feishu.indexOf("'card.action.trigger'"));
    expect(trigger).toContain("action === 'approval_decide'");
    expect(trigger).toContain('onApprovalCardAction?.({');

    const imChannel = readSource('src/im-channel.ts');
    expect(imChannel).toContain('onApprovalCardAction?: (input: {');
    expect(imChannel).toContain(
      'onApprovalCardAction: opts.onApprovalCardAction,',
    );

    const imManager = readSource('src/im-manager.ts');
    expect(imManager).toContain('onApprovalCardAction?: (input: {');
    expect(imManager).toContain('opts.onApprovalCardAction!(input)');

    const source = readSource('src/index.ts');
    const cardHandler = source.slice(
      source.indexOf('async function handleApprovalCardAction('),
    );
    expect(cardHandler).toContain(
      "checkImOwnerCommand('approve', group, input.operatorImId)",
    );
    expect(cardHandler).toContain(
      'decideApproval(input.approvalId, input.approved, decidedBy)',
    );
    // Both connect sites must forward the callback (initial connect + hot reload).
    expect(
      source.match(/onApprovalCardAction: handleApprovalCardAction,/g),
    ).toHaveLength(2);
  });

  test('approval card text goes through the prebuilt interactive lane with owner-gated button values', () => {
    const card = readSource('src/feishu-cards/approval-card.ts');
    expect(card).toContain("action: 'approval_decide'");
    expect(card).toContain('approvalId: input.approvalId');
    expect(card).toContain('chatJid: input.chatJid');
    expect(card).toContain('{ ...actionValue, approved: true }');
    expect(card).toContain('{ ...actionValue, approved: false }');
    expect(card).toMatch(/JSON\.stringify\(\{ type: 'interactive', card \}\)/);
  });

  test('WS top-level approval messages exist with workspace-owner filtering', () => {
    const types = readSource('src/types.ts');
    expect(types).toContain("type: 'approval_requested';");
    expect(types).toContain("type: 'approval_decided';");

    const web = readSource('src/web.ts');
    expect(web).toContain('function resolveApprovalBroadcastAudience(');
    expect(web).toContain('getGroupAllowedUserIds(workspaceJid)');
    expect(web).toContain('export function broadcastApprovalRequested(');
    expect(web).toContain('export function broadcastApprovalDecided(');
  });
});
