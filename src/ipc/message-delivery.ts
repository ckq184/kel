import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as fsp from 'fs/promises';
import { logger } from '../logger.js';
import { GROUPS_DIR } from '../config.js';
import type {
  MessageFinalizationReason,
  MessageSourceKind,
  RegisteredGroup,
} from '../types.js';
import {
  getAgent,
  getSessionChannelOwner,
  getTaskById,
  type TaskRunNotificationReceipt,
} from '../db.js';
import {
  getChannelType,
  type ChannelMessageDeliveryOptions,
} from '../im-channel.js';
import { detectImageMimeType } from '../image-detector.js';
import { preserveUnacknowledgedProactiveFinal } from '../proactive-final-recovery.js';
import { acknowledgeIpcReplyTurn } from '../reply-delivery.js';
import { resolveTaskRoutingDecision } from '../task-routing.js';
import { getUncertainChannelOutboxForTurn } from '../channel-reliability-store.js';
import { channelTurnScope } from '../channel-turn-registry.js';
import {
  resolveFrozenIpcInteractionMode,
  usesNativeMessagePresentation,
} from '../workspace-interaction-runtime.js';
import {
  resolveHostIpcLogicalChatJid,
  routeHostIpcOutput,
} from '../host-ipc-output-router.js';
import {
  activeChannelOutboxScopes,
  activeIpcReplyTurnTrackers,
  activeTurnOutputs,
} from '../host-state.js';
import type { TurnMessageDeliveryRole } from '../turn-output-coordinator.js';
import type { TaskNotificationDeliveryAttempt } from '../task-notification.js';

// ISSUE-12 波 4 单元 4.3：messages 侧 send_message 分支自 src/index.ts
// startIpcWatcher 的 processGroupIpc 扫描循环原文搬运（原 index.ts 9162-9685
// 的 if 体，523 行）。外围循环局部量经 input 显式传参、同名解构使搬运体
// 逐字节不变；18 个 index.ts 本地函数与 activeImReplyRoutes/
// REPLY_LIMIT_REACHED_ERROR 经 input 注入防 import 环（2.7 同名注入先例）；
// 可直接 import 的依赖（routeHostIpcOutput/resolveHostIpcLogicalChatJid/
// resolveFrozenIpcInteractionMode/usesNativeMessagePresentation/
// preserveUnacknowledgedProactiveFinal/acknowledgeIpcReplyTurn/
// resolveTaskRoutingDecision/getUncertainChannelOutboxForTurn/getAgent/
// getTaskById/getSessionChannelOwner/getChannelType/detectImageMimeType/
// 三注册表）自各源模块直引（对 index.ts 零反向依赖已核）。唯一控制流改写：
// 两处 `await fsp.unlink(filePath); continue;` 机械转换为 `return
// { skippedFile: true };`（调用点等价 continue，跳过共享尾胶水）；outcome
// 局部量五连在搬运体内声明不变，messageResultWritten 在体内新声明并经
// 返回值回传调用点（原本是循环体外围 let）。fsp 以 `import * as fsp
// from 'fs/promises'` 承接原 `const fsp = fs.promises`（同一绑定组）。

// index.ts:2084 的 ChannelOutboxDeliveryRef 结构副本（index.ts 本地接口未
// 导出，无法 import；字段与其逐字节一致，index.ts 构造 deps 时经结构化
// 类型自然校验）。
interface IpcChannelOutboxDeliveryRef {
  scopeKey: string;
  operationKey: string;
  scopeToken: string;
  ordinalSlot?: string;
}

export interface IpcSendMessageInput {
  /** 扫描循环解析出的 IPC 请求 JSON（原循环内 JSON.parse 结果，any 语义保留）。 */
  data: any;
  file: string;
  filePath: string;
  messageRequestId: string | undefined;
  messageResultsDir: string;
  sourceGroup: string;
  sourceGroupEntry: RegisteredGroup | undefined;
  ipcAgentId: string | null;
  ipcTaskId: string | null;
  durableTaskRunId: string | null;
  isHome: boolean;
  broadcastFolder: string;
  REPLY_LIMIT_REACHED_ERROR: string;
  activeImReplyRoutes: Map<string, string | null>;
  canSendCrossGroupMessage: (
    isHome: boolean,
    sourceFolder: string,
    targetGroup: RegisteredGroup | undefined,
  ) => boolean;
  getIpcDeliveryTargetGroup: (chatJid: string) => RegisteredGroup | undefined;
  writeIpcMessageResult: (
    resultsDir: string,
    requestId: string | undefined,
    payload: Record<string, unknown>,
  ) => boolean;
  isRetryDuplicateIpcSend: (
    sourceGroup: string,
    chatJid: string,
    text: string,
  ) => boolean;
  recordSuccessfulIpcSend: (
    sourceGroup: string,
    chatJid: string,
    text: string,
  ) => void;
  taskRunAcceptsLateIpcOutput: (runId: string | null) => boolean;
  resolveImRoute: (opts: {
    ipcAgentId: string | null | undefined;
    isHome: boolean;
    chatJid: string;
    sourceGroup: string;
  }) => string | null;
  extractFeishuCardText: (text: string) => string | null;
  extractLocalImImagePaths: (text: string, groupFolder?: string) => string[];
  channelOutboxRefForInput: (
    scopeKey: string,
    targetJid: string,
    inputTurnId: unknown,
    operationKey: string,
  ) => IpcChannelOutboxDeliveryRef | undefined;
  sendImWithRetry: (
    imJid: string,
    text: string,
    localImagePaths: string[],
    outbox?: IpcChannelOutboxDeliveryRef,
    deliveryOptions?: ChannelMessageDeliveryOptions,
    outboxMetadata?: {
      deliveryRole?: TurnMessageDeliveryRole | null;
      inputTurnId?: string | null;
      logicalChatJid?: string | null;
    },
  ) => Promise<boolean>;
  sendTaskImageWithRetry: (
    targetJid: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
    outbox?: IpcChannelOutboxDeliveryRef,
  ) => Promise<boolean>;
  broadcastToOwnerIMChannels: (
    userId: string,
    sourceFolder: string,
    alreadySentJids: Set<string>,
    sendFn: (jid: string) => void,
    notifyChannels?: string[] | null,
  ) => void;
  settleAndRecordTaskIpcDeliveries: (
    runId: string | null,
    attempts: TaskNotificationDeliveryAttempt[],
  ) => Promise<{ accepted: boolean; receipt: TaskRunNotificationReceipt }>;
  resolveIpcOutputRuntimeChatJid: (
    sourceGroup: string,
    ipcAgentId: string | null | undefined,
    inputTurnId: unknown,
    targetJid: string,
  ) => string | null;
  resolveIpcOutputWorkspaceJid: (chatJid: string) => string | null;
  sendMessageWithOutcome: (
    jid: string,
    text: string,
    options: {
      sendToIM?: boolean;
      messageId?: string;
      messageMeta?: {
        turnId?: string;
        sourceKind?: MessageSourceKind;
        finalizationReason?: MessageFinalizationReason;
      };
    },
  ) => Promise<{ targetDelivered: boolean }>;
}

export type IpcSendMessageOutcome =
  | { skippedFile: true }
  | { skippedFile: false; messageResultWritten: boolean };

export async function processIpcSendMessage(
  input: IpcSendMessageInput,
): Promise<IpcSendMessageOutcome> {
  const {
    data,
    file,
    filePath,
    messageRequestId,
    messageResultsDir,
    sourceGroup,
    sourceGroupEntry,
    ipcAgentId,
    ipcTaskId,
    durableTaskRunId,
    isHome,
    broadcastFolder,
    REPLY_LIMIT_REACHED_ERROR,
    activeImReplyRoutes,
    canSendCrossGroupMessage,
    getIpcDeliveryTargetGroup,
    writeIpcMessageResult,
    isRetryDuplicateIpcSend,
    recordSuccessfulIpcSend,
    taskRunAcceptsLateIpcOutput,
    resolveImRoute,
    extractFeishuCardText,
    extractLocalImImagePaths,
    channelOutboxRefForInput,
    sendImWithRetry,
    sendTaskImageWithRetry,
    broadcastToOwnerIMChannels,
    settleAndRecordTaskIpcDeliveries,
    resolveIpcOutputRuntimeChatJid,
    resolveIpcOutputWorkspaceJid,
    sendMessageWithOutcome,
  } = input;
  let messageResultWritten = false;
  const targetGroup = getIpcDeliveryTargetGroup(data.chatJid);
  let messageDelivered = false;
  let messageStaged = false;
  let messageDeliveryError: string | undefined;
  let messageDeliveryUncertain = false;
  let nativeDeliveryAcknowledged = false;
  let stagedDisposition: 'staged_progress' | 'staged_final' | undefined;
  const isTaskIpcMessage = !!(data.isScheduledTask || data.taskId || ipcTaskId);
  const frozenIpcMode = resolveFrozenIpcInteractionMode(data.interactionMode, {
    scheduledTask: isTaskIpcMessage,
    spawnAgent: !!ipcAgentId && getAgent(ipcAgentId)?.kind !== 'conversation',
  });
  if (!frozenIpcMode.valid) {
    messageResultWritten = writeIpcMessageResult(
      messageResultsDir,
      messageRequestId,
      {
        success: false,
        error: 'Invalid frozen interaction mode.',
      },
    );
    await fsp.unlink(filePath);
    return { skippedFile: true };
  }
  const ipcInteractionMode = frozenIpcMode.mode;
  const authorized = canSendCrossGroupMessage(isHome, sourceGroup, targetGroup);
  const hostOutputRoute = routeHostIpcOutput(
    {
      sourceGroup,
      agentId: ipcAgentId,
      inputTurnId: data.inputTurnId,
      text: data.text,
      deliveryRole: data.deliveryRole,
      authorized,
      scheduledTask: isTaskIpcMessage,
      interactionMode: ipcInteractionMode,
    },
    activeTurnOutputs,
  );
  const stagingAttempted = hostOutputRoute.path === 'primary_projection';
  if (hostOutputRoute.path === 'primary_projection') {
    messageDelivered = hostOutputRoute.delivered;
    messageStaged = hostOutputRoute.staged;
    stagedDisposition = hostOutputRoute.disposition;
    if (hostOutputRoute.stageResult.accepted) {
      logger.info(
        {
          sourceGroup,
          agentId: ipcAgentId,
          inputTurnId: data.inputTurnId,
          deliveryRole: hostOutputRoute.deliveryRole,
          duplicate: hostOutputRoute.stageResult.duplicate,
        },
        'IPC send_message joined the active primary reply',
      );
    } else {
      logger.warn(
        {
          sourceGroup,
          agentId: ipcAgentId,
          inputTurnId: data.inputTurnId,
          deliveryRole: hostOutputRoute.deliveryRole,
          reason: hostOutputRoute.stageResult.reason,
        },
        'IPC send_message could not join its exact active primary reply',
      );
    }
  }
  if (messageStaged || stagingAttempted) {
    // Staged progress/final text intentionally has no independent
    // DB/IM side effect. SDK Result will finalize the same primary
    // answer; a failed staging attempt must not fall through into
    // the legacy separate-message path.
  } else if (isRetryDuplicateIpcSend(sourceGroup, data.chatJid, data.text)) {
    // The deduplicator only records confirmed deliveries, so a
    // replay hit is itself evidence that the prior attempt reached
    // the user. Failed attempts are deliberately never recorded.
    messageDelivered = true;
    nativeDeliveryAcknowledged = true;
    logger.info(
      { sourceGroup, chatJid: data.chatJid },
      'Duplicate IPC send_message suppressed (retry replay window)',
    );
  } else if (authorized) {
    if (
      isTaskIpcMessage &&
      durableTaskRunId &&
      !taskRunAcceptsLateIpcOutput(durableTaskRunId)
    ) {
      messageResultWritten = writeIpcMessageResult(
        messageResultsDir,
        messageRequestId,
        {
          success: false,
          error: 'Task run was cancelled before message delivery.',
        },
      );
      await fsp.unlink(filePath);
      return { skippedFile: true };
    }
    // Conversation agents and isolated scheduled tasks route to
    // virtual JIDs so output appears in their own tab/session,
    // not the workspace main conversation.
    const effectiveChatJid = resolveHostIpcLogicalChatJid({
      sourceChatJid: data.chatJid,
      agentId: ipcAgentId,
      agentChatJid: ipcAgentId ? getAgent(ipcAgentId)?.chat_jid : undefined,
      taskRunId: ipcTaskId,
      scheduledTask: data.isScheduledTask === true,
      runtimeChatJid: resolveIpcOutputRuntimeChatJid(
        sourceGroup,
        ipcAgentId,
        data.inputTurnId,
        data.chatJid,
      ),
      resolveWorkspaceJid: resolveIpcOutputWorkspaceJid,
    });
    // Feishu card JSON: store extracted markdown for web, send raw JSON to IM
    const cardText = extractFeishuCardText(data.text);
    const webText = cardText || data.text;

    // Every non-task native send, including conversation agents,
    // resolves the sticky exact route and uses the Turn Outbox.
    // DB/Web stores markdown extracted from a Feishu card; the
    // connector receives the original JSON/text payload.
    if (!isTaskIpcMessage) {
      const ipcImRoute = resolveImRoute({
        ipcAgentId,
        isHome,
        chatJid: data.chatJid,
        sourceGroup,
      });
      if (ipcImRoute) {
        if (typeof data.inputTurnId !== 'string' || !data.inputTurnId) {
          messageDelivered = false;
          logger.error(
            {
              sourceGroup,
              agentId: ipcAgentId,
              chatJid: data.chatJid,
            },
            'Suppressed IPC send_message without an immutable inputTurnId',
          );
        } else {
          const messageScopeKey = channelTurnScope(sourceGroup, ipcAgentId);
          const messageScope = activeChannelOutboxScopes.resolveInput(
            messageScopeKey,
            data.inputTurnId,
            ipcImRoute,
          );
          if (
            !activeTurnOutputs.canDeliverUtterance({
              scopeKey: messageScopeKey,
              inputTurnId: data.inputTurnId,
            })
          ) {
            // Runaway-loop fuse. Already delivered messages stand;
            // the model gets a stable machine-readable reason so it
            // can tell "stop talking" from "retry later".
            messageDelivered = false;
            messageDeliveryError = REPLY_LIMIT_REACHED_ERROR;
            logger.warn(
              {
                sourceGroup,
                agentId: ipcAgentId,
                inputTurnId: data.inputTurnId,
              },
              'Suppressed IPC send_message: per-turn reply limit reached',
            );
          } else {
            messageDelivered = await sendImWithRetry(
              ipcImRoute,
              data.text,
              extractLocalImImagePaths(data.text, sourceGroup),
              channelOutboxRefForInput(
                messageScopeKey,
                ipcImRoute,
                data.inputTurnId,
                `ipc-message:${messageRequestId ?? file}`,
              ),
              usesNativeMessagePresentation(ipcInteractionMode)
                ? { presentation: 'native' }
                : undefined,
              {
                deliveryRole: hostOutputRoute.deliveryRole,
                inputTurnId: data.inputTurnId,
                logicalChatJid: effectiveChatJid,
              },
            );
            nativeDeliveryAcknowledged = messageDelivered;
            if (
              !messageDelivered &&
              messageScope &&
              getUncertainChannelOutboxForTurn(messageScope.turnRunId)
            ) {
              messageDeliveryUncertain = true;
              messageDeliveryError =
                'Message delivery is uncertain or fenced by an earlier uncertain channel mutation. Do not retry, sleep, switch to a card, or call a raw channel API; the framework will notify the user.';
            }
          }
        }
      } else if (getSessionChannelOwner(sourceGroup, ipcAgentId ?? null)) {
        // The session is owned by a native channel, so a missing
        // route means the route is unavailable — not that this is a
        // Web-only session. Reporting "delivered" here told the
        // model its message had reached the user while the IM side
        // stayed silent, which in Proactive mode (no published SDK
        // final) meant the user saw nothing at all.
        messageDelivered = false;
        messageDeliveryError =
          'Message could not be delivered: this session is bound to a native channel whose route is currently unavailable.';
        logger.error(
          {
            sourceGroup,
            agentId: ipcAgentId,
            chatJid: data.chatJid,
          },
          'Suppressed IPC send_message: native-owned session has no resolvable route',
        );
      } else {
        // A genuinely Web-only logical session is delivered by
        // durable persistence/broadcast below; it has no native
        // provider side effect to acknowledge first.
        messageDelivered = true;
      }
    }

    // Scheduled-task delivery uses its independent durable task
    // receipt ledger.
    if (!ipcAgentId) {
      // Scheduled-task output routing. Decision logic is in
      // resolveTaskRoutingDecision() (src/task-routing.ts) so it
      // can be unit-tested without booting this module.
      const routingDecision = resolveTaskRoutingDecision(
        data,
        ipcTaskId,
        !!sourceGroupEntry?.created_by,
        { getTaskById, getChannelType },
      );
      if (isTaskIpcMessage) {
        const taskLocalImages = extractLocalImImagePaths(
          data.text,
          sourceGroup,
        );
        const attempts: TaskNotificationDeliveryAttempt[] = [];
        const addTargetAttempts = (targetJid: string): void => {
          const channel = getChannelType(targetJid) ?? targetJid;
          attempts.push({
            channel,
            payload: {
              kind: 'im_message',
              targetJid,
              text: data.text,
              localImagePaths: [],
            },
            deliver: () => sendImWithRetry(targetJid, data.text, []),
          });
          for (const imagePath of taskLocalImages) {
            const imageBuffer = fs.readFileSync(imagePath);
            const mimeType = detectImageMimeType(imageBuffer);
            const fileName = path.basename(imagePath);
            attempts.push({
              channel,
              payload: {
                kind: 'im_image',
                targetJid,
                workspaceFolder: sourceGroup,
                filePath: path.relative(
                  path.resolve(GROUPS_DIR, sourceGroup),
                  imagePath,
                ),
                mimeType,
                fileName,
              },
              deliver: () =>
                sendTaskImageWithRetry(
                  targetJid,
                  imageBuffer,
                  mimeType,
                  undefined,
                  fileName,
                ),
            });
          }
        };
        if (routingDecision.mode === 'direct') {
          const targetJid = routingDecision.taskChatJid;
          addTargetAttempts(targetJid);
        } else if (
          routingDecision.mode === 'broadcast' &&
          sourceGroupEntry?.created_by
        ) {
          // Fallback: broadcast to all connected IM channels
          const alreadySent = new Set<string>(
            [data.chatJid, activeImReplyRoutes.get(sourceGroup)].filter(
              Boolean,
            ) as string[],
          );
          broadcastToOwnerIMChannels(
            sourceGroupEntry.created_by,
            broadcastFolder,
            alreadySent,
            (jid) => {
              addTargetAttempts(jid);
            },
            routingDecision.notifyChannels,
          );
        }
        const delivery = await settleAndRecordTaskIpcDeliveries(
          durableTaskRunId,
          attempts,
        );
        messageDelivered =
          delivery.accepted &&
          (delivery.receipt.status === 'success' ||
            delivery.receipt.status === 'skipped');
      }
    }
    const projectionMessageId = `ipc_${crypto
      .createHash('sha256')
      .update(
        [
          effectiveChatJid,
          typeof data.inputTurnId === 'string' ? data.inputTurnId : '',
          data.text,
        ].join('\0'),
      )
      .digest('hex')
      .slice(0, 32)}`;
    const isExplicitProactiveFinal =
      !isTaskIpcMessage &&
      ipcInteractionMode === 'proactive' &&
      hostOutputRoute.deliveryRole === 'final' &&
      typeof data.inputTurnId === 'string' &&
      Boolean(data.inputTurnId);

    // An unacknowledged native final must keep the exact answer in
    // the canonical Web session without replaying the provider
    // mutation. Its provenance remains visibly non-completed.
    if (!messageDelivered && isExplicitProactiveFinal) {
      const preserved = await preserveUnacknowledgedProactiveFinal({
        registry: activeTurnOutputs,
        scopeKey: channelTurnScope(sourceGroup, ipcAgentId),
        inputTurnId: data.inputTurnId,
        text: webText,
        uncertain: messageDeliveryUncertain,
        project: async (text, finalizationReason) => {
          const outcome = await sendMessageWithOutcome(effectiveChatJid, text, {
            sendToIM: false,
            messageId: projectionMessageId,
            messageMeta: {
              turnId: data.inputTurnId,
              sourceKind: 'sdk_send_message',
              finalizationReason,
            },
          });
          return outcome.targetDelivered;
        },
      });
      logger[preserved.projected ? 'warn' : 'error'](
        {
          chatJid: effectiveChatJid,
          sourceGroup,
          agentId: ipcAgentId,
          inputTurnId: data.inputTurnId,
          finalizationReason: preserved.finalizationReason,
        },
        preserved.projected
          ? 'Preserved unacknowledged Proactive final in canonical Web session'
          : 'Failed to preserve unacknowledged Proactive final in canonical Web session',
      );
    }
    if (messageDelivered) {
      const sendOutcome = await sendMessageWithOutcome(
        effectiveChatJid,
        webText,
        {
          // Native delivery above owns the physical ACK. Only
          // confirmed sends are projected into the canonical Web
          // session, using a replay-stable id.
          sendToIM: false,
          messageId: projectionMessageId,
          messageMeta: {
            turnId:
              typeof data.inputTurnId === 'string'
                ? data.inputTurnId
                : undefined,
            sourceKind: 'sdk_send_message',
            finalizationReason:
              hostOutputRoute.deliveryRole === 'final'
                ? 'completed'
                : undefined,
          },
        },
      );
      messageDelivered = sendOutcome.targetDelivered;
      if (!messageDelivered && nativeDeliveryAcknowledged) {
        // The provider side effect already ACKed. Reporting a tool
        // failure would invite a duplicate retry; preserve the ACK
        // while leaving the canonical projection failure visible
        // in logs for operator repair.
        messageDelivered = true;
        logger.error(
          {
            chatJid: effectiveChatJid,
            sourceGroup,
            agentId: ipcAgentId,
            inputTurnId: data.inputTurnId,
          },
          'Native IPC message ACKed but canonical Web projection failed',
        );
      }
    }
    if (messageDelivered) {
      recordSuccessfulIpcSend(sourceGroup, data.chatJid, data.text);
    }
    logger.info(
      {
        chatJid: effectiveChatJid,
        sourceGroup,
        agentId: ipcAgentId,
        delivered: messageDelivered,
      },
      messageDelivered
        ? 'IPC message delivered and projected'
        : 'IPC message was not delivered',
    );
  } else {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC message attempt blocked',
    );
  }
  const isMainUserTurnReply = !(
    data.isScheduledTask ||
    data.taskId ||
    ipcTaskId ||
    ipcAgentId
  );
  if (
    messageDelivered &&
    !messageStaged &&
    !isTaskIpcMessage &&
    typeof data.inputTurnId === 'string' &&
    data.inputTurnId
  ) {
    activeTurnOutputs.recordDeliveredUtterance({
      scopeKey: channelTurnScope(sourceGroup, ipcAgentId),
      inputTurnId: data.inputTurnId,
      role: hostOutputRoute.deliveryRole ?? undefined,
      text: data.text,
    });
  }
  if (
    messageDelivered &&
    !messageStaged &&
    isMainUserTurnReply &&
    typeof data.inputTurnId === 'string' &&
    data.inputTurnId
  ) {
    const activeTracker = activeIpcReplyTurnTrackers.get(sourceGroup);
    if (activeTracker) {
      acknowledgeIpcReplyTurn(activeTracker, data.inputTurnId);
    }
  }
  messageResultWritten = writeIpcMessageResult(
    messageResultsDir,
    messageRequestId,
    messageDelivered
      ? {
          success: true,
          disposition: stagedDisposition ?? 'delivered_separately',
        }
      : {
          success: false,
          error:
            messageDeliveryError ??
            'Message could not be delivered to its target.',
        },
  );
  return { skippedFile: false, messageResultWritten };
}
