import { logger } from '../logger.js';
import {
  isFeishuCapabilityMutation,
  type FeishuCapabilityOperation,
  type FeishuCapabilityRequest,
} from '../feishu-capability.js';
import { deliverFeishuCapabilityMutation } from '../feishu-capability-outbox.js';
import { channelTurnScope } from '../channel-turn-registry.js';
import {
  activeChannelOutboxScopes,
  activeChannelTurns,
  activeTurnOutputs,
  canDeliverTurnUtterance,
} from '../host-state.js';
import { imManager } from '../im-manager.js';

// ISSUE-12 波 4 单元 4.9：feishu_capability case 体自 src/index.ts
// processTaskIpc 的 switch 原文搬运（原 index.ts 10712-10858，147 行）。
// 四个外围局部量经 input 显式传参、同名解构使搬运体逐字节不变；3 项
// index.ts 本地依赖（SAFE_REQUEST_ID_RE / REPLY_LIMIT_REACHED_ERROR /
// writeTaskResult）经 input 注入防环；isFeishuCapabilityMutation/
// deliverFeishuCapabilityMutation/双类型/imManager/三注册表+熔断均自
// 各源模块直引（对 index.ts 零反向依赖已核）。无控制流改写：case 内
// 早退全走 throw→本 case catch，无中段 break；尾随 break 留壳层。

export interface IpcFeishuCapabilityInput {
  /** processTaskIpc 解析出的 IPC 请求 JSON（结构类型同壳层，any 语义保留）。 */
  data: any;
  sourceGroup: string;
  ipcAgentId: string | null;
  tasksDir: string;
  SAFE_REQUEST_ID_RE: RegExp;
  REPLY_LIMIT_REACHED_ERROR: string;
  writeTaskResult: (
    tasksDir: string,
    type: string,
    requestId: string | undefined,
    payload: Record<string, unknown>,
  ) => void;
}

export async function processIpcFeishuCapability(
  input: IpcFeishuCapabilityInput,
): Promise<void> {
  const {
    data,
    sourceGroup,
    ipcAgentId,
    tasksDir,
    SAFE_REQUEST_ID_RE,
    REPLY_LIMIT_REACHED_ERROR,
    writeTaskResult,
  } = input;
  const startedAt = Date.now();
  try {
    if (!data.requestId || !SAFE_REQUEST_ID_RE.test(data.requestId)) {
      throw new Error('Invalid Feishu capability requestId');
    }
    if (!data.inputTurnId) {
      throw new Error('Feishu capability inputTurnId is required');
    }
    const allowedOperations = new Set<FeishuCapabilityOperation>([
      'get_chat',
      'list_members',
      'get_user',
      'get_history',
      'send_card',
      'add_reaction',
      'remove_reaction',
      'edit_message',
      'recall_message',
      'api_request',
    ]);
    if (
      !data.operation ||
      !allowedOperations.has(data.operation as FeishuCapabilityOperation)
    ) {
      throw new Error('Unknown Feishu capability operation');
    }
    const scope = channelTurnScope(sourceGroup, ipcAgentId);
    const activeTurn = activeChannelTurns.require(scope, data.inputTurnId);
    const request: FeishuCapabilityRequest = {
      operation: data.operation as FeishuCapabilityOperation,
      params: data.params,
    };
    // Runaway-loop fuse, sharing send_message's budget. `send_card` is the
    // only capability that emits new user-visible content, and it is the
    // only one recorded against the turn — so it is the only one gated.
    // Reactions, edits and recalls act on existing messages.
    if (
      request.operation === 'send_card' &&
      !canDeliverTurnUtterance(sourceGroup, ipcAgentId, data.inputTurnId)
    ) {
      logger.warn(
        {
          sourceGroup,
          agentId: ipcAgentId,
          inputTurnId: data.inputTurnId,
        },
        'Suppressed IPC feishu send_card: per-turn reply limit reached',
      );
      throw new Error(REPLY_LIMIT_REACHED_ERROR);
    }
    let result;
    if (isFeishuCapabilityMutation(request)) {
      const outboxScope = activeChannelOutboxScopes.resolveInput(
        scope,
        data.inputTurnId,
        activeTurn.sourceJid,
      );
      if (!outboxScope) {
        throw new Error(
          'Exact durable scope for this Feishu mutation is unavailable; operation suppressed.',
        );
      }
      const mutation = await deliverFeishuCapabilityMutation({
        ...outboxScope,
        requestId: data.requestId,
        request,
        owner: `ckqclaw-feishu-capability:${process.pid}:${outboxScope.turnRunId}`,
        execute: () =>
          imManager.executeFeishuCapability(
            activeTurn.sourceJid,
            activeTurn.context,
            request,
          ),
      });
      if (mutation.delivery.status !== 'delivered') {
        throw new Error(
          mutation.delivery.status === 'uncertain'
            ? 'Feishu mutation delivery is uncertain; do not retry automatically. An operator must confirm the provider result.'
            : mutation.delivery.error ||
                `Feishu mutation did not complete (${mutation.delivery.status}).`,
        );
      }
      result =
        mutation.result ??
        ({
          operation: request.operation,
          data: {
            deliveryStatus: 'already_delivered',
            providerReceipt:
              mutation.delivery.receipt?.providerMessageId ?? null,
          },
        } satisfies Awaited<
          ReturnType<typeof imManager.executeFeishuCapability>
        >);
    } else {
      result = await imManager.executeFeishuCapability(
        activeTurn.sourceJid,
        activeTurn.context,
        request,
      );
    }
    // `send_card` is the only capability that emits new user-visible
    // content, so it is the only one that counts as speech for turn
    // settlement. Reactions, edits and recalls act on existing messages.
    if (
      request.operation === 'send_card' &&
      typeof data.inputTurnId === 'string' &&
      data.inputTurnId
    ) {
      activeTurnOutputs.recordDeliveredUtterance({
        scopeKey: channelTurnScope(sourceGroup, ipcAgentId),
        inputTurnId: data.inputTurnId,
      });
    }
    writeTaskResult(tasksDir, 'feishu_capability', data.requestId, {
      success: true,
      ...result,
    });
    logger.info(
      {
        sourceGroup,
        agentId: ipcAgentId,
        operation: request.operation,
        channelAccountId: activeTurn.context.channelAccountId,
        chatId: activeTurn.context.chat.id,
        inputTurnId: data.inputTurnId,
        durationMs: Date.now() - startedAt,
      },
      'Feishu capability executed through bound Bot',
    );
  } catch (error) {
    writeTaskResult(tasksDir, 'feishu_capability', data.requestId, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    logger.warn(
      {
        sourceGroup,
        agentId: ipcAgentId,
        operation: data.operation,
        inputTurnId: data.inputTurnId,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      },
      'Feishu capability request rejected or failed',
    );
  }
}
