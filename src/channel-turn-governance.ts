import type { ContainerOutput } from './container-runner.js';
import { ChannelTurnRuntime } from './channel-turn-runtime.js';
import type { ActiveChannelOutboxScope } from './channel-outbox-runtime-scope.js';
import { getUncertainChannelOutboxForTurn } from './channel-reliability-store.js';
import { resolveContainerOutputInputTurnId } from './channel-output-correlation.js';
import { logger } from './logger.js';

/**
 * ISSUE-12 波 6 单元 6.4：ChannelTurnRuntime 集合编排自 src/index.ts 的
 * processGroupMessages / processAgentConversation 两侧镜像收敛（原文搬运）。
 *
 * 两侧差异全部经参数注入：
 * - 分歧②（拍板①）：complete 台账载荷键 A=sentReply / B=replyDelivered——经
 *   completePayloadKey 参数化保留原名，不统一、不做 DB 兼容读取；
 * - runtime/scope/ack/rejected 四张表与 healthy 集合由调用方持有（Map/Set 按
 *   引用读写），needsManualReconciliation 为调用方闭包旗标、经回调置位；
 * - manual-reconciliation 通知（index.ts 本地函数）与指标清理经回调注入；
 * - 日志文案与基础字段（B 含 agentId）参数化。
 */

export interface ChannelManualReconciliationNoticeArgs {
  targetJid: string;
  runtime: ChannelTurnRuntime;
  presentation: 'default' | 'native';
  route: {
    provider: string;
    accountId: string;
    sourceJid: string;
    chatId: string;
    rootId?: string | null;
    threadId?: string | null;
  };
}

export interface CompleteChannelRuntimesInput {
  result: ContainerOutput;
  runtimes: Map<string, ChannelTurnRuntime>;
  scopesByInput: Map<string, ActiveChannelOutboxScope>;
  ackByInput: Map<string, boolean>;
  markHealthyInput: (inputId: string) => void;
  clearIndicatorForInput: (inputId: string) => Promise<void>;
  onNeedsManualReconciliation: () => void;
  deliverManualReconciliationNotice: (
    args: ChannelManualReconciliationNoticeArgs,
  ) => Promise<boolean>;
  presentation: 'default' | 'native';
  fallbackInputId: string;
  publishesAnswer: boolean;
  /** 分歧②：A='sentReply' / B='replyDelivered'（保留原名，不统一）。 */
  completePayloadKey: 'sentReply' | 'replyDelivered';
  baseLogContext: Record<string, unknown>;
  refusalLogMessage: string;
  terminalFailureLogMessage: string;
}

export async function completeChannelTurnRuntimesForOutput(
  input: CompleteChannelRuntimesInput,
): Promise<boolean> {
  const { result } = input;
  if (!result.inputTurnCompleted) return false;
  let allCompleted = true;
  const inputIds = result.ipcReceipts?.length
    ? result.ipcReceipts.map((receipt) => receipt.deliveryId)
    : [result.inputTurnId ?? input.fallbackInputId];
  for (const inputId of inputIds) {
    input.markHealthyInput(inputId);
    const runtime = input.runtimes.get(inputId);
    if (!runtime) {
      await input.clearIndicatorForInput(inputId);
      continue;
    }
    const uncertainDelivery = getUncertainChannelOutboxForTurn(runtime.runId);
    if (uncertainDelivery) {
      input.onNeedsManualReconciliation();
      const interrupted = runtime.interrupt(
        `Channel delivery ${uncertainDelivery.id} is uncertain; manual reconciliation required`,
      );
      const exactScope = input.scopesByInput.get(inputId);
      const notified = exactScope?.chatId
        ? await input.deliverManualReconciliationNotice({
            targetJid: exactScope.sourceJid,
            runtime,
            presentation: input.presentation,
            route: { ...exactScope, chatId: exactScope.chatId },
          })
        : false;
      if (interrupted && notified) {
        await input.clearIndicatorForInput(inputId);
        runtime.dispose();
        input.runtimes.delete(inputId);
      } else {
        allCompleted = false;
      }
      continue;
    }
    const utteranceDelivered = input.ackByInput.get(inputId) === true;
    if (input.publishesAnswer && !utteranceDelivered) {
      allCompleted = false;
      logger.error(
        {
          ...input.baseLogContext,
          inputTurnId: inputId,
          runId: runtime.runId,
        },
        input.refusalLogMessage,
      );
      continue;
    }
    const ledgerPayload =
      input.completePayloadKey === 'sentReply'
        ? { sentReply: utteranceDelivered }
        : { replyDelivered: utteranceDelivered };
    const completed =
      runtime.markFinalizing() &&
      runtime.complete({
        cursorCommitted: true,
        ...ledgerPayload,
        silent: !utteranceDelivered,
        inputTurnId: inputId,
      });
    if (completed) {
      // Keep the immutable scope projection until the whole warm runner
      // exits. A late duplicate SDK callback for this already-completed
      // input must still resolve the same delivered Outbox item instead of
      // falling back to an ungoverned legacy send.
      await input.clearIndicatorForInput(inputId);
      runtime.dispose();
      input.runtimes.delete(inputId);
    } else {
      allCompleted = false;
      logger.error(
        {
          ...input.baseLogContext,
          inputTurnId: inputId,
          runId: runtime.runId,
          durabilityFailure: runtime.hasDurabilityFailure,
          lostFence: runtime.hasLostFence,
        },
        input.terminalFailureLogMessage,
      );
    }
  }
  return allCompleted;
}

export interface ChannelScopeForOutputInput {
  result: ContainerOutput;
  scopesByInput: Map<string, ActiveChannelOutboxScope>;
  rejectedInputTurns: Set<string>;
  fallbackInputId: string;
}

export interface ChannelScopeForOutputResult {
  inputId: string;
  scope?: ActiveChannelOutboxScope;
  rejected: boolean;
}

export function resolveChannelScopeForOutput(
  input: ChannelScopeForOutputInput,
): ChannelScopeForOutputResult {
  const inputIds = input.result.ipcReceipts?.length
    ? input.result.ipcReceipts.map((receipt) => receipt.deliveryId)
    : [];
  const inputId = resolveContainerOutputInputTurnId(
    input.result,
    input.fallbackInputId,
  );
  return {
    inputId,
    scope: input.scopesByInput.get(inputId),
    rejected: inputIds.some((id) => input.rejectedInputTurns.has(id)),
  };
}
