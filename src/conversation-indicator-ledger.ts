import { getChannelType } from './im-channel.js';
import { imManager } from './im-manager.js';
import { logger } from './logger.js';

/**
 * ISSUE-12 波 6 单元 6.1：会话处理指标台账（M6 typing/processing 四表+clear
 * 闭包）自 src/index.ts 的 processGroupMessages / processAgentConversation
 * 两侧镜像收敛（原文搬运）。两侧差异全部经构造参数注入：
 * - logicalJid：track/untrack/typing 清理的逻辑键（A=chatJid，B=virtualChatJid）；
 * - logScopeLabel：日志文案范围标签（A=''，B='agent '，保留两侧原文案）；
 * - logContext：日志基础字段（A={chatJid}，B={chatJid, agentId}）；
 * - 冷启动 jid 回退：A=directImReply ? chatJid : null，B=replySourceImJid；
 * - 暖启动 jid 回退：A=newImJid，B=targetSourceJid（逐调用传入）。
 */
export interface ConversationIndicatorLedgerDeps {
  logicalJid: string;
  logScopeLabel: string;
  logContext: Record<string, unknown>;
  trackProcessingIndicator: (
    logicalJid: string,
    inputTurnId: string,
    transportJid: string,
  ) => void;
  untrackProcessingIndicator: (logicalJid: string, inputTurnId: string) => void;
  clearTrackedTypingIndicator: (
    logicalJid: string,
    leaseId: string,
    fallbackTransportJid?: string,
  ) => Promise<void>;
}

export interface LedgerColdMessage {
  id: string;
  source_jid?: string | null;
}

export interface LedgerCoveredInput {
  id: string;
  sourceJid?: string;
}

export class ConversationIndicatorLedger {
  readonly jidsByInput = new Map<string, string>();
  // One cold SDK turn may cover several rapidly-arriving DB inputs. Each
  // provider reaction is owned by the original DB message id, while the SDK
  // completion is correlated to the batch's terminal input id.
  readonly inputsByCompletion = new Map<string, string[]>();
  readonly typingLeaseIdsByCompletion = new Map<string, string>();

  constructor(private readonly deps: ConversationIndicatorLedgerDeps) {}

  seedColdBatch(
    batchTerminalInputId: string,
    missedMessages: LedgerColdMessage[],
    coldFallbackJid: string | null,
  ): void {
    this.inputsByCompletion.set(batchTerminalInputId, [
      ...new Set(missedMessages.map((message) => message.id)),
    ]);
    this.typingLeaseIdsByCompletion.set(
      batchTerminalInputId,
      batchTerminalInputId,
    );
    for (const message of missedMessages) {
      const indicatorJid =
        message.source_jid && getChannelType(message.source_jid)
          ? message.source_jid
          : coldFallbackJid;
      if (!indicatorJid) continue;
      this.jidsByInput.set(message.id, indicatorJid);
      this.deps.trackProcessingIndicator(
        this.deps.logicalJid,
        message.id,
        indicatorJid,
      );
    }
  }

  registerWarmCompletion(
    inputTurnId: string,
    coveredInputs: LedgerCoveredInput[] | undefined,
    newSourceJid: string | null,
    warmFallbackJid: string | null,
  ): void {
    const exactInputs =
      coveredInputs && coveredInputs.length > 0
        ? coveredInputs
        : [{ id: inputTurnId, sourceJid: newSourceJid ?? undefined }];
    const exactInputIds = [...new Set(exactInputs.map((input) => input.id))];
    this.inputsByCompletion.set(inputTurnId, exactInputIds);
    this.typingLeaseIdsByCompletion.set(inputTurnId, inputTurnId);
    const fallbackProcessingIndicatorJid =
      newSourceJid && getChannelType(newSourceJid)
        ? newSourceJid
        : warmFallbackJid;
    for (const exactInput of exactInputs) {
      const processingIndicatorJid =
        exactInput.sourceJid && getChannelType(exactInput.sourceJid)
          ? exactInput.sourceJid
          : fallbackProcessingIndicatorJid;
      if (processingIndicatorJid) {
        this.jidsByInput.set(exactInput.id, processingIndicatorJid);
        this.deps.trackProcessingIndicator(
          this.deps.logicalJid,
          exactInput.id,
          processingIndicatorJid,
        );
      }
    }
  }

  async clearForInput(inputTurnId: string): Promise<void> {
    const { logicalJid, logScopeLabel, logContext } = this.deps;
    const exactInputIds = this.inputsByCompletion.get(inputTurnId) ?? [
      inputTurnId,
    ];
    const typingLeaseId =
      this.typingLeaseIdsByCompletion.get(inputTurnId) ?? inputTurnId;
    let typingCleared = false;
    await this.deps
      .clearTrackedTypingIndicator(
        logicalJid,
        typingLeaseId,
        this.jidsByInput.get(exactInputIds[0]) ?? logicalJid,
      )
      .then(
        () => {
          typingCleared = true;
        },
        (err) => {
          logger.debug(
            { err, ...logContext, inputTurnId, typingLeaseId },
            `Failed to clear exact ${logScopeLabel}processing typing lease`,
          );
        },
      );
    if (typingCleared) {
      this.typingLeaseIdsByCompletion.delete(inputTurnId);
    }
    const failedExactInputIds: string[] = [];
    for (const exactInputId of new Set(exactInputIds)) {
      const indicatorJid = this.jidsByInput.get(exactInputId);
      if (!indicatorJid) continue;
      let ackCleared = false;
      await imManager.clearAckReaction(indicatorJid, exactInputId).then(
        () => {
          ackCleared = true;
        },
        (err) => {
          logger.debug(
            {
              err,
              ...logContext,
              inputTurnId: exactInputId,
              indicatorJid,
            },
            `Failed to clear exact ${logScopeLabel}processing indicator`,
          );
        },
      );
      if (ackCleared) {
        this.jidsByInput.delete(exactInputId);
        this.deps.untrackProcessingIndicator(logicalJid, exactInputId);
      } else {
        failedExactInputIds.push(exactInputId);
      }
    }
    if (failedExactInputIds.length > 0) {
      this.inputsByCompletion.set(inputTurnId, failedExactInputIds);
    } else {
      this.inputsByCompletion.delete(inputTurnId);
    }
  }
}
