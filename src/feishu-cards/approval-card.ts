/**
 * Tool approval request card for Feishu.
 *
 * Sent through the generic IM send pipeline as prebuilt card text
 * (`{"type":"interactive","card":{...}}` — the pass-through lane in
 * feishu.ts sendMessage, same convention as agent-authored card JSON), so the
 * approval push inherits the Turn Outbox durability of every other channel
 * message. The card body is the v1 element layout that
 * `extractFeishuCardText` (index.ts) knows how to flatten for web display.
 */

export interface ApprovalRequestCardInput {
  approvalId: string;
  toolName: string;
  inputSummary: string;
  groupFolder: string;
  /** Mount JID the card is sent to; echoed back by button callbacks. */
  chatJid: string;
}

export function approvalShortId(approvalId: string): string {
  // Raw-id prefix so `/approve <shortId>` prefix-matches the full UUID — for
  // UUID v4 the first 8 chars are the dash-free first segment.
  return approvalId.slice(0, 8);
}

export function buildApprovalRequestCardText(
  input: ApprovalRequestCardInput,
): string {
  const shortId = approvalShortId(input.approvalId);
  const actionValue = {
    action: 'approval_decide',
    approvalId: input.approvalId,
    chatJid: input.chatJid,
  };
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🔔 工具审批 · ${input.toolName}` },
      template: 'orange',
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**工作区**：${input.groupFolder}`,
          `**审批号**：\`${shortId}\`（也可回复 \`/approve ${shortId}\` 或 \`/deny ${shortId}\`）`,
          '**参数**：',
          '```json',
          input.inputSummary,
          '```',
        ].join('\n'),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 批准' },
            type: 'primary',
            value: { ...actionValue, approved: true },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⛔ 拒绝' },
            type: 'danger',
            value: { ...actionValue, approved: false },
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          { tag: 'plain_text', content: '仅工作区 owner 可批准或拒绝' },
        ],
      },
    ],
  };
  return JSON.stringify({ type: 'interactive', card });
}
