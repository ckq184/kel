import type { StreamingSession } from './im-channel.js';
import { imManager } from './im-manager.js';
import {
  unregisterStreamingSession,
  type StreamingCardLifecycle,
} from './feishu-streaming-card.js';
import { logger } from './logger.js';

/**
 * ISSUE-12 波 6 单元 6.2：流式卡生命周期（M12 建卡 / M13 回滚 / M35 五分支
 * 收尾）自 src/index.ts 的 processGroupMessages / processAgentConversation
 * 两侧镜像收敛（原文搬运）。M24 卡喂入与 usage 补丁（target-ref /
 * pending-flag）及其余深水区镜像族（M7/M11/M16/M17/M22/M24/M27/M30/M36）
 * 经用户拍板"接受现状，修订收官"（2026-11-22）维持两侧现状，不迁本模块
 * ——见 docs/issues/ISSUE-12-structural-refactor.md 交付记录。
 *
 * 两侧差异全部经参数注入：
 * - 分歧① suppressOnRetry：A 重试轮静默不建卡（true）/ B 无此判断（false）；
 * - 分歧④ silentSuccess：A 以「本轮从未发过可见回复」判定 / B 以「cursor
 *   未提交」判定，调用方算好布尔传入；
 * - 其余微差（建卡目标 jid、error/closed 探针、silent 失败兜底是否先
 *   abort、日志文案与字段）均为同级参数。
 */

/** 分歧①：重试轮是否静默（不建卡）。A=true，B=false。 */
export interface StreamingCardCreationInput {
  /** 会话是否具备建卡资格（A: publishesFrameworkAnswer；B: 另需 replySourceImJid）。 */
  eligible: boolean;
  suppressOnRetry: boolean;
  retryAttempt: number;
  /** 建卡目标 jid（A: streamingSessionJid；B: replySourceImJid 原始 IM jid）。 */
  createSessionJid: string;
  onCardCreated?: (messageId: string) => void;
  lifecycle?: StreamingCardLifecycle;
}

export async function createStreamingCardOnTurnStart(
  input: StreamingCardCreationInput,
): Promise<StreamingSession | undefined> {
  const { eligible, suppressOnRetry, retryAttempt } = input;
  // 重试轮（指数退避后的重跑）静默执行，不新建流式卡片：否则一条持续失败的
  // 消息每轮都会在飞书发一张「生成中→处理出错」卡，最多刷 6 张（消息洪流）。
  // 重试成功时最终回复仍经静态 sendMessage 送达。
  if (!eligible) return undefined;
  if (suppressOnRetry && retryAttempt > 0) return undefined;
  return imManager.createStreamingSession(
    input.createSessionJid,
    input.onCardCreated,
    input.lifecycle,
  );
}

/** M13：runtime 只需卡预约回滚能力（结构收窄，避免引入 ChannelTurnRuntime）。 */
export interface CardReservationRuntime {
  rollbackUnpublishedStreamingCardReservation(): boolean;
}

export interface IdleCardReservationRollbackInput {
  sessionsByInput: Map<string, { session: StreamingSession; jid: string }>;
  inputTurnId: string;
  batchTerminalInputId: string;
  currentSession: StreamingSession | undefined;
  currentSessionJid: string | undefined;
  /** B：当前批 session 投影回退需 jid 同在（A 的 jid 恒为 string）。 */
  requireJidForCurrentProjection: boolean;
  getRuntime: (inputTurnId: string) => CardReservationRuntime | undefined;
  logContext: Record<string, unknown>;
  logMessage: string;
}

export interface IdleCardReservationRollbackResult {
  rolledBack: boolean;
  /** 回滚命中当前主 session：调用方需自行清 session/lifecycle 两个闭包引用。 */
  droppedCurrentSession: boolean;
}

export function rollbackIdleCardReservation(
  input: IdleCardReservationRollbackInput,
): IdleCardReservationRollbackResult {
  const {
    sessionsByInput,
    inputTurnId,
    batchTerminalInputId,
    currentSession,
    currentSessionJid,
    requireJidForCurrentProjection,
    getRuntime,
    logContext,
    logMessage,
  } = input;
  const projection =
    sessionsByInput.get(inputTurnId) ??
    (inputTurnId === batchTerminalInputId &&
    currentSession &&
    (!requireJidForCurrentProjection || currentSessionJid)
      ? { session: currentSession, jid: currentSessionJid! }
      : undefined);
  const runtime = getRuntime(inputTurnId);
  if (projection?.session.isActive()) {
    return { rolledBack: false, droppedCurrentSession: false };
  }
  if (!runtime?.rollbackUnpublishedStreamingCardReservation()) {
    // The reservation may already have reached Feishu. Activate the
    // controller so the normal complete/abort path can terminalize it.
    projection?.session.setThinking();
    return { rolledBack: false, droppedCurrentSession: false };
  }
  projection?.session.dispose();
  if (projection) unregisterStreamingSession(projection.jid);
  sessionsByInput.delete(inputTurnId);
  const droppedCurrentSession = projection?.session === currentSession;
  logger.info(logContext, logMessage);
  return { rolledBack: true, droppedCurrentSession };
}

export interface StreamingCardExitFinalizeInput {
  session: StreamingSession;
  sessionJid: string | undefined;
  accumulatedText: string;
  wasInterrupted: boolean;
  wasSteered: boolean;
  failoverPending: boolean;
  /** A: hadError || !output || output.status === 'error'；B: hadError。 */
  runnerError: boolean;
  /** A: output.status === 'closed'；B: agentClosed 标志。 */
  runnerClosed: boolean;
  /** 分歧④：A: !sentReply；B: !isCursorCommitted()。 */
  silentSuccess: boolean;
  logContext: (err: unknown) => Record<string, unknown>;
  silentFailureLogMessage: string;
  /** A: warn 后先 abort('') 再 dispose；B: warn 后直接 dispose。 */
  abortOnSilentFinalizeFailure: boolean;
}

/**
 * M35 五分支收尾：isActive() 仍为 true ⟹ 卡片从未被 complete()（result.result
 * 非空路径会在回复投递后令 isActive 转 false）。这里覆盖所有「卡片建了但没收
 * 口」的收尾场景，避免卡片永久停在「生成中」（僵尸卡片）。
 */
export async function finalizeStreamingCardOnExit(
  input: StreamingCardExitFinalizeInput,
): Promise<void> {
  const {
    session,
    sessionJid,
    accumulatedText,
    wasInterrupted,
    wasSteered,
    failoverPending,
    runnerError,
    runnerClosed,
    silentSuccess,
    logContext,
    silentFailureLogMessage,
    abortOnSilentFinalizeFailure,
  } = input;
  if (session.isActive()) {
    if (failoverPending) {
      await session.abort('模型服务切换中，正在重试').catch(() => {});
    } else if (runnerError) {
      await session.abort('处理出错').catch(() => {});
    } else if (wasInterrupted) {
      if (wasSteered) {
        await session.complete(accumulatedText).catch(() => {});
      } else {
        await session.abort('已停止').catch(() => {});
      }
    } else if (runnerClosed) {
      // closed：容器 drain/_close 中断了 in-flight query（runner 发
      // status:'closed' 而非 interrupt 流事件，streamInterrupted 仍为 false）。
      // 该消息会重试（保留 cursor），此处仅收口卡片避免僵尸卡 + 重试叠卡。
      // 文案区别于「已中断」：closed 是系统侧打断并自动重试，非用户主动中断。
      await session.abort('连接已切换，正在重试').catch(() => {});
    } else if (silentSuccess) {
      // 真 silent-success：本轮从未发过可见回复（agent 仅用 send_message 旁路
      // 回复、最终 result 为空，回复投递的门控跳过了 complete()）。
      // complete() 把卡片从 streaming 收口到 completed（空正文由
      // buildStructuredFinalCard 兜底为 "..."，并保留 thinking/工具统计），
      // 而非裸 dispose() 留下「生成中」僵尸卡。
      try {
        await session.complete(accumulatedText);
      } catch (err) {
        logger.warn(logContext(err), silentFailureLogMessage);
        if (abortOnSilentFinalizeFailure) {
          // dispose() 只清定时器不碰卡面，会留下永久「生成中」僵尸卡；
          // abort() 内部自带 catch，会尽力把卡面切到「已中断」终态。
          await session.abort('').catch(() => {});
        }
        session.dispose();
      }
    } else {
      // 已有正常回复 complete 后为「下一条消息」预建的空白 active 卡，本轮无
      // 后续 result。dispose() 丢弃，不可 complete()（否则会凭空渲染一张正文
      // 为 "..." 的完成卡）。
      session.dispose();
    }
  }
  if (sessionJid) {
    unregisterStreamingSession(sessionJid);
  }
}
