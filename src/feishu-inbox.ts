import {
  advanceChannelCursor,
  claimChannelInboxById,
  claimNextChannelInbox,
  completeChannelInbox,
  failChannelInbox,
  ignoreChannelInbox,
  listChannelCursors,
  recordChannelInbox,
  renewChannelInboxClaim,
  type ClaimedChannelInboxItem,
} from './channel-reliability-store.js';
import { logger } from './logger.js';
import { FEISHU_CURSOR_SCOPE } from './feishu-backfill.js';

// ISSUE-12 单元 2.7：durable Inbox 辅助群（F2 进度 / F3 心跳与恢复调度 /
// F4 游标恢复 / F10 入口 handleIncomingMessage / F13 信封解析 / F14 恢复
// 循环）自 src/feishu.ts 原文搬运。reliabilityAccountId 与 inboxOwner 的
// 推导留在 feishu.ts 原位（持久键不得漂移），经 input 值注入；可变
// connectOptions / inboxRecoveryTimer 经访问器注入；knownChatIds /
// chatTypeById / inboxHeartbeatByClaim 为跨模块共享引用，本体仍归
// feishu.ts 状态装配区所有（stop() 的清理行不变）。唯一的机械改写：
// handleIncomingMessage 与 scheduleInboxRecovery 里对闭包
// connectOptions/inboxRecoveryTimer 的直读改为访问器调用。
// IncomingMessagePayload / FeishuMentionLike 随本单元从 feishu.ts 迁出并
// 导出，feishu-backfill.ts / feishu-events.ts 的本地结构副本同步收编
// （type-only import，无运行时环）。

export const FEISHU_INBOX_LEASE_MS = 5 * 60 * 1000;
const FEISHU_INBOX_HEARTBEAT_MS = 60 * 1000;
const FEISHU_INBOX_RETRY_DELAY_MS = 5_000;
export const FEISHU_INBOX_GATE_RETRY_DELAY_MS = 250;
const FEISHU_INBOX_RECOVERY_LIMIT = 500;

export interface FeishuMentionLike {
  key?: string;
  name?: string;
  id?: { open_id?: string; user_id?: string; union_id?: string };
}

export interface IncomingMessagePayload {
  chatId: string;
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  createTimeMs: number;
  messageType: string;
  content: string;
  chatType?: string;
  mentions?: FeishuMentionLike[];
  senderOpenId?: string;
  senderUserId?: string;
  senderUnionId?: string;
  senderName?: string;
  senderTenantKey?: string;
  senderType?: string;
}

/** handleIncomingMessage / scheduleInboxRecovery 读到的 connectOptions 子集。 */
export interface FeishuInboxConnectOptions {
  normalizeIncomingJid?: (jid: string) => string;
}

export interface FeishuInboxInput {
  /** feishu.ts 原位推导的 reliabilityAccountId（持久键，值传递）。 */
  accountId: string;
  /** feishu.ts 原位推导的 inboxOwner（持久键，值传递）。 */
  owner: string;
  knownChatIds: Set<string>;
  chatTypeById: Map<string, string>;
  inboxHeartbeatByClaim: Map<string, NodeJS.Timeout>;
  getInboxRecoveryTimer: () => NodeJS.Timeout | null;
  setInboxRecoveryTimer: (timer: NodeJS.Timeout | null) => void;
  getConnectOptions: () => FeishuInboxConnectOptions | null;
  processClaimedIncomingMessage: (
    payload: IncomingMessagePayload,
    source: 'ws' | 'backfill',
    claim: ClaimedChannelInboxItem,
  ) => Promise<void>;
}

export function createFeishuInboxController(input: FeishuInboxInput) {
  const reliabilityAccountId = input.accountId;
  const inboxOwner = input.owner;
  const {
    knownChatIds,
    chatTypeById,
    inboxHeartbeatByClaim,
    getInboxRecoveryTimer,
    setInboxRecoveryTimer,
    getConnectOptions,
    processClaimedIncomingMessage,
  } = input;

  function rememberChatProgress(
    chatId: string,
    createTimeMs: number,
    chatType?: string,
  ): void {
    knownChatIds.add(chatId);
    if (chatType) chatTypeById.set(chatId, chatType);
    void createTimeMs;
  }

  function inboundPosition(
    payload: IncomingMessagePayload,
    claim?: Pick<ClaimedChannelInboxItem, 'createdAt'>,
  ): number {
    if (
      Number.isSafeInteger(payload.createTimeMs) &&
      payload.createTimeMs > 0
    ) {
      return payload.createTimeMs;
    }
    const recordedAt = claim ? Date.parse(claim.createdAt) : Number.NaN;
    return Number.isSafeInteger(recordedAt) && recordedAt > 0
      ? recordedAt
      : Date.now();
  }

  /**
   * A terminal Inbox row and its cursor intentionally form a recoverable pair:
   * if the process dies between the two writes, a duplicate WS/backfill event
   * sees the terminal row and calls this again, repairing the cursor without
   * re-running user code.
   */
  function rememberTerminalProgress(
    payload: IncomingMessagePayload,
    claim?: Pick<ClaimedChannelInboxItem, 'createdAt'>,
  ): void {
    const position = inboundPosition(payload, claim);
    try {
      advanceChannelCursor({
        provider: 'feishu',
        accountId: reliabilityAccountId,
        scope: FEISHU_CURSOR_SCOPE,
        chatId: payload.chatId,
        cursor: payload.messageId,
        position,
        tieBreaker: payload.messageId,
      });
      rememberChatProgress(payload.chatId, position, payload.chatType);
    } catch (err) {
      logger.error(
        { err, chatId: payload.chatId, messageId: payload.messageId },
        'Failed to advance durable Feishu cursor; a duplicate/backfill will repair it',
      );
    }
  }

  function completeClaimedInbound(
    claim: ClaimedChannelInboxItem,
    payload: IncomingMessagePayload,
  ): void {
    stopInboxHeartbeat(claim);
    if (!completeChannelInbox(claim)) {
      logger.warn(
        { inboxId: claim.id, messageId: payload.messageId },
        'Lost Feishu Inbox lease before completion',
      );
      return;
    }
    rememberTerminalProgress(payload, claim);
  }

  function ignoreClaimedInbound(
    claim: ClaimedChannelInboxItem,
    payload: IncomingMessagePayload,
    reason: string,
  ): void {
    stopInboxHeartbeat(claim);
    if (!ignoreChannelInbox(claim, reason)) {
      logger.warn(
        { inboxId: claim.id, messageId: payload.messageId, reason },
        'Lost Feishu Inbox lease before ignore transition',
      );
      return;
    }
    rememberTerminalProgress(payload, claim);
  }

  function failClaimedInbound(
    claim: ClaimedChannelInboxItem,
    payload: IncomingMessagePayload,
    error: unknown,
    retry: boolean,
    retryDelayMs = FEISHU_INBOX_RETRY_DELAY_MS,
  ): void {
    stopInboxHeartbeat(claim);
    const message = error instanceof Error ? error.message : String(error);
    const changed = failChannelInbox(claim, {
      error: message,
      ...(retry
        ? {
            retryAt: new Date(Date.now() + retryDelayMs).toISOString(),
          }
        : {}),
    });
    if (!changed) {
      logger.warn(
        { inboxId: claim.id, messageId: payload.messageId, retry },
        'Lost Feishu Inbox lease before failure transition',
      );
      return;
    }
    if (!retry) {
      rememberTerminalProgress(payload, claim);
    } else {
      scheduleInboxRecovery(retryDelayMs);
    }
  }

  function claimHeartbeatKey(
    claim: Pick<ClaimedChannelInboxItem, 'id' | 'leaseToken'>,
  ): string {
    return `${claim.id}:${claim.leaseToken}`;
  }

  function stopInboxHeartbeat(
    claim: Pick<ClaimedChannelInboxItem, 'id' | 'leaseToken'>,
  ): void {
    const key = claimHeartbeatKey(claim);
    const timer = inboxHeartbeatByClaim.get(key);
    if (!timer) return;
    clearInterval(timer);
    inboxHeartbeatByClaim.delete(key);
  }

  function startInboxHeartbeat(claim: ClaimedChannelInboxItem): void {
    const key = claimHeartbeatKey(claim);
    stopInboxHeartbeat(claim);
    const timer = setInterval(() => {
      try {
        if (!renewChannelInboxClaim(claim, FEISHU_INBOX_LEASE_MS)) {
          stopInboxHeartbeat(claim);
          logger.warn(
            { inboxId: claim.id, leaseToken: claim.leaseToken },
            'Lost Feishu Inbox lease during heartbeat renewal',
          );
        }
      } catch (err) {
        // A transient SQLite error must not permanently disable renewal. The
        // next tick retries while the current lease remains fenced.
        logger.warn(
          { err, inboxId: claim.id, leaseToken: claim.leaseToken },
          'Feishu Inbox heartbeat renewal failed',
        );
      }
    }, FEISHU_INBOX_HEARTBEAT_MS);
    timer.unref?.();
    inboxHeartbeatByClaim.set(key, timer);
  }

  function scheduleInboxRecovery(delayMs = FEISHU_INBOX_RETRY_DELAY_MS): void {
    if (!getConnectOptions()) return;
    // A startup/shutdown gate requests a prompt drain. Replace a slower
    // generic retry timer instead of making the just-opened service wait 5s.
    const existingTimer = getInboxRecoveryTimer();
    if (existingTimer) clearTimeout(existingTimer);
    const inboxRecoveryTimer = setTimeout(
      () => {
        setInboxRecoveryTimer(null);
        void recoverQueuedInbox('retry-timer').catch((err) => {
          logger.error({ err }, 'Scheduled Feishu Inbox recovery failed');
        });
      },
      Math.max(25, delayMs) + 50,
    );
    setInboxRecoveryTimer(inboxRecoveryTimer);
    inboxRecoveryTimer.unref?.();
  }

  function restoreDurableChatProgress(): void {
    try {
      for (const cursor of listChannelCursors({
        provider: 'feishu',
        accountId: reliabilityAccountId,
        limit: 10_000,
      })) {
        if (cursor.scope !== FEISHU_CURSOR_SCOPE || !cursor.chatId) continue;
        rememberChatProgress(cursor.chatId, cursor.position);
      }
    } catch (err) {
      // Some isolated transport tests intentionally instantiate Feishu without
      // initializing the application DB. Production startup always binds it.
      logger.warn(
        { err, accountId: reliabilityAccountId },
        'Unable to restore durable Feishu cursors',
      );
    }
  }

  async function handleIncomingMessage(
    payload: IncomingMessagePayload,
    source: 'ws' | 'backfill',
  ): Promise<void> {
    const { chatId, messageId } = payload;
    if (!chatId || !messageId) return;
    const rawChatJid = `feishu:${chatId}`;
    const sourceJid =
      getConnectOptions()?.normalizeIncomingJid?.(rawChatJid) ?? rawChatJid;
    let recorded: ReturnType<typeof recordChannelInbox>;
    try {
      recorded = recordChannelInbox({
        provider: 'feishu',
        accountId: reliabilityAccountId,
        externalMessageId: messageId,
        sourceJid,
        chatId,
        rootId: payload.rootId,
        threadId: payload.threadId,
        rawPayload: { version: 1, source, payload },
        status: 'queued',
      });
    } catch (err) {
      // Never fall back to volatile execution: without the Inbox uniqueness
      // fence, two WS clients or a reconnect can launch the same Agent turn.
      logger.error(
        { err, messageId, chatId, source },
        'Failed to durably record Feishu message; refusing unfenced execution',
      );
      throw err;
    }

    if (
      recorded.item.status === 'processed' ||
      recorded.item.status === 'ignored' ||
      recorded.item.status === 'failed'
    ) {
      rememberTerminalProgress(payload);
      logger.debug(
        { messageId, inboxStatus: recorded.item.status, source },
        'Duplicate terminal Feishu message, skipping execution',
      );
      return;
    }

    const claim = claimChannelInboxById(
      recorded.item.id,
      inboxOwner,
      FEISHU_INBOX_LEASE_MS,
    );
    if (!claim) {
      logger.debug(
        { messageId, inboxStatus: recorded.item.status, source },
        'Feishu message already claimed or awaiting retry',
      );
      return;
    }
    await processClaimedIncomingMessage(payload, source, claim);
  }

  function parseRecoveredInbox(
    claim: ClaimedChannelInboxItem,
  ):
    | { source: 'ws' | 'backfill'; payload: IncomingMessagePayload }
    | undefined {
    const raw = claim.rawPayload;
    if (!raw || typeof raw !== 'object') return undefined;
    const envelope = raw as {
      source?: unknown;
      payload?: Partial<IncomingMessagePayload>;
    };
    if (
      (envelope.source !== 'ws' && envelope.source !== 'backfill') ||
      !envelope.payload ||
      typeof envelope.payload.chatId !== 'string' ||
      !envelope.payload.chatId.trim() ||
      typeof envelope.payload.messageId !== 'string' ||
      !envelope.payload.messageId.trim() ||
      typeof envelope.payload.createTimeMs !== 'number' ||
      typeof envelope.payload.messageType !== 'string' ||
      !envelope.payload.messageType.trim() ||
      typeof envelope.payload.content !== 'string'
    ) {
      return undefined;
    }
    return {
      source: envelope.source,
      payload: envelope.payload as IncomingMessagePayload,
    };
  }

  async function recoverQueuedInbox(reason: string): Promise<void> {
    let recovered = 0;
    while (recovered < FEISHU_INBOX_RECOVERY_LIMIT) {
      let claim: ClaimedChannelInboxItem | undefined;
      try {
        claim = claimNextChannelInbox(inboxOwner, FEISHU_INBOX_LEASE_MS, {
          provider: 'feishu',
          accountId: reliabilityAccountId,
        });
      } catch (err) {
        logger.warn(
          { err, reason, accountId: reliabilityAccountId },
          'Unable to recover durable Feishu Inbox',
        );
        return;
      }
      if (!claim) break;
      const envelope = parseRecoveredInbox(claim);
      if (!envelope) {
        failClaimedInbound(
          claim,
          {
            chatId: claim.chatId || '',
            messageId: claim.externalMessageId,
            createTimeMs: Date.parse(claim.createdAt),
            messageType: '',
            content: '',
          },
          new Error('Invalid durable Feishu Inbox payload'),
          false,
        );
        continue;
      }
      await processClaimedIncomingMessage(
        envelope.payload,
        envelope.source,
        claim,
      );
      recovered++;
    }
    if (recovered > 0) {
      logger.info(
        { reason, recovered, accountId: reliabilityAccountId },
        'Recovered queued Feishu Inbox messages',
      );
    }
  }

  return {
    rememberChatProgress,
    inboundPosition,
    rememberTerminalProgress,
    completeClaimedInbound,
    ignoreClaimedInbound,
    failClaimedInbound,
    stopInboxHeartbeat,
    startInboxHeartbeat,
    scheduleInboxRecovery,
    restoreDurableChatProgress,
    handleIncomingMessage,
    recoverQueuedInbox,
  };
}
