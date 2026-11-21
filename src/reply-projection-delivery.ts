import type { StreamingSession } from './im-channel.js';
import { logger } from './logger.js';
import { buildSteeredReply, buildStoppedReply } from './reply-finalization.js';

/**
 * ISSUE-12 波 6 单元 6.3：回复投影投递自 src/index.ts 的 processGroupMessages /
 * processAgentConversation 两侧镜像收敛（原文搬运）。
 *
 * 两侧差异全部经参数注入：
 * - 持久化后端（§8.2）：A 经 sendMessage 产出 outcome（sendToIM:false +
 *   messageMeta）；B 经 storeMessageDirect + broadcastNewMessage 直投。以
 *   persist 回调注入，模块只保留公共骨架（建文案→卡收口→落库→状态收口→
 *   cursor 提交）。
 * - 分歧③ commitCursorOnInterrupt：A 不在中断路径 commit（由外层裁决）；
 *   B 直接 commit。本模块的 M25 骨架两侧均含 commitCursor 调用（A 传外层
 *   裁决后的提交函数、B 传直接提交），分歧语义由调用方闭包保留。
 * - 其余微差（buildStoppedReply 是否带 thinking、旗标名、日志文案/字段）
 *   均为同级参数。
 */

export interface InterruptedStreamPersistInput {
  steered: boolean;
  accumulatedText: string;
  /** A 传 thinking（buildStoppedReply 双参）；B 不传（原文单参）。 */
  stoppedThinking?: string;
  session?: StreamingSession;
  /** 持久化后端注入：A sendMessage(sendToIM:false)；B storeDirect+broadcast。 */
  persist: (interruptedText: string) => Promise<void>;
  /** 落库后的状态收口：旗标（A sentReply / B agentInterruptFinalized）、快照
   * 清理、累积文本清零——闭包变量归调用方。 */
  onPersisted: () => void;
  commitCursor: () => void;
  logContext: (err: unknown) => Record<string, unknown>;
  logMessage: string;
}

/** M25：中断状态事件到达时立即保存已输出内容（runner 中断后不退出进程，
 * finally 不会执行，必须在此处立即保存）。 */
export async function persistInterruptedStreamText(
  input: InterruptedStreamPersistInput,
): Promise<void> {
  const {
    steered,
    accumulatedText,
    stoppedThinking,
    session,
    persist,
    onPersisted,
    commitCursor,
    logContext,
    logMessage,
  } = input;
  const interruptedText = steered
    ? buildSteeredReply(accumulatedText)
    : buildStoppedReply(accumulatedText, stoppedThinking);
  try {
    if (session?.isActive()) {
      if (steered) {
        await session.complete(accumulatedText).catch(() => {});
      } else {
        await session.abort('已停止').catch(() => {});
      }
    }
    if (interruptedText) {
      await persist(interruptedText);
    }
    onPersisted();
    commitCursor();
  } catch (err) {
    logger.warn(logContext(err), logMessage);
  }
}
