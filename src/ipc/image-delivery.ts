import crypto from 'crypto';
import * as fsp from 'fs/promises';
import { logger } from '../logger.js';
import { ASSISTANT_NAME } from '../config.js';
import type { RegisteredGroup } from '../types.js';
import {
  ensureChatExists,
  getAgent,
  getTaskById,
  recordTaskRunNotificationReceipt,
  storeMessageDirect,
  type TaskRunNotificationReceipt,
} from '../db.js';
import { getChannelType } from '../im-channel.js';
import { broadcastNewMessage, broadcastToWebClients } from '../web.js';
import { resolveTaskRoutingDecision } from '../task-routing.js';
import {
  buildFailedTaskImageNotification,
  type TaskNotificationDeliveryAttempt,
} from '../task-notification.js';
import { channelTurnScope } from '../channel-turn-registry.js';
import { resolveHostIpcLogicalChatJid } from '../host-ipc-output-router.js';
import { activeTurnOutputs, canDeliverTurnUtterance } from '../host-state.js';
import { canDeleteAcknowledgedIpcSource } from '../isolated-task-ipc.js';

// ISSUE-12 波 4 单元 4.4：messages 侧 send_image 分支自 src/index.ts
// startIpcWatcher 的 processGroupIpc 扫描循环原文搬运（原 index.ts
// 9691-10039 的 else-if 体，349 行）。外围循环局部量经 input 显式传参、
// 同名解构使搬运体逐字节不变；12 个 index.ts 本地函数经 input 注入防
// import 环（单元 4.3 同款）；可直接 import 的依赖（canDeleteAcknowledged-
// IpcSource/broadcastToWebClients/broadcastNewMessage/ensureChatExists/
// storeMessageDirect/recordTaskRunNotificationReceipt/buildFailedTaskImage-
// Notification/ASSISTANT_NAME/resolveTaskRoutingDecision/getTaskById/
// getChannelType/getAgent/resolveHostIpcLogicalChatJid/channelTurnScope/
// canDeliverTurnUtterance/activeTurnOutputs）自各源模块直引（对 index.ts
// 零反向依赖已核）。唯一控制流改写：两处 `await fsp.unlink(filePath);
// continue;` 机械转换为 `return { skippedFile: true };`（调用点等价
// continue）；分支内 try/catch 的 `throw err` 穿越调用边界落回循环外层
// catch，语义不变；outcome 三连（taskImageTargetJids/taskImageDelivery-
// Settled/isTaskIpcImage）搬运体内声明不变，messageResultWritten 体内
// 新声明并经返回值回传调用点。fsp 以 `import * as fsp from
// 'fs/promises'` 承接原 `const fsp = fs.promises`（同一绑定组）。

// index.ts:2084 的 ChannelOutboxDeliveryRef 结构副本（同单元 4.3 留痕）。
interface IpcChannelOutboxDeliveryRef {
  scopeKey: string;
  operationKey: string;
  scopeToken: string;
  ordinalSlot?: string;
}

export interface IpcSendImageInput {
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
  taskRunAcceptsLateIpcOutput: (runId: string | null) => boolean;
  resolveImRoute: (opts: {
    ipcAgentId: string | null | undefined;
    isHome: boolean;
    chatJid: string;
    sourceGroup: string;
  }) => string | null;
  channelOutboxRefForInput: (
    scopeKey: string,
    targetJid: string,
    inputTurnId: unknown,
    operationKey: string,
  ) => IpcChannelOutboxDeliveryRef | undefined;
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
}

export type IpcSendImageOutcome =
  | { skippedFile: true }
  | { skippedFile: false; messageResultWritten: boolean };

export async function processIpcSendImage(
  input: IpcSendImageInput,
): Promise<IpcSendImageOutcome> {
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
    canSendCrossGroupMessage,
    getIpcDeliveryTargetGroup,
    writeIpcMessageResult,
    taskRunAcceptsLateIpcOutput,
    resolveImRoute,
    channelOutboxRefForInput,
    sendTaskImageWithRetry,
    broadcastToOwnerIMChannels,
    settleAndRecordTaskIpcDeliveries,
    resolveIpcOutputRuntimeChatJid,
    resolveIpcOutputWorkspaceJid,
  } = input;
  let messageResultWritten = false;
  // Handle image IPC messages from send_image MCP tool
  const targetGroup = getIpcDeliveryTargetGroup(data.chatJid);
  let taskImageTargetJids: string[] = [];
  let taskImageDeliverySettled = false;
  let isTaskIpcImage = false;
  if (canSendCrossGroupMessage(isHome, sourceGroup, targetGroup)) {
    try {
      const imageBuffer = Buffer.from(data.imageBase64, 'base64');
      const mimeType = data.mimeType || 'image/png';
      const caption = data.caption || undefined;
      const fileName = data.fileName || undefined;

      isTaskIpcImage = !!(data.isScheduledTask || data.taskId || ipcTaskId);
      if (
        isTaskIpcImage &&
        durableTaskRunId &&
        !taskRunAcceptsLateIpcOutput(durableTaskRunId)
      ) {
        messageResultWritten = writeIpcMessageResult(
          messageResultsDir,
          messageRequestId,
          {
            success: false,
            error: 'Task run was cancelled before image delivery.',
          },
        );
        if (
          !canDeleteAcknowledgedIpcSource(
            messageRequestId,
            messageResultWritten,
          )
        ) {
          throw new Error('Failed to acknowledge cancelled image request');
        }
        await fsp.unlink(filePath);
        return { skippedFile: true };
      }
      // Runaway-loop fuse, sharing send_message's budget. An image
      // is an irreversible side effect in a real chat, so it must
      // be gated too: otherwise images drain the budget silently
      // and the turn's actual answer is the delivery that gets
      // refused. Task images keep their own accounting.
      if (
        !isTaskIpcImage &&
        !canDeliverTurnUtterance(sourceGroup, ipcAgentId, data.inputTurnId)
      ) {
        logger.warn(
          {
            sourceGroup,
            agentId: ipcAgentId,
            inputTurnId: data.inputTurnId,
          },
          'Suppressed IPC send_image: per-turn reply limit reached',
        );
        messageResultWritten = writeIpcMessageResult(
          messageResultsDir,
          messageRequestId,
          { success: false, error: REPLY_LIMIT_REACHED_ERROR },
        );
        if (
          !canDeleteAcknowledgedIpcSource(
            messageRequestId,
            messageResultWritten,
          )
        ) {
          throw new Error('Failed to acknowledge reply-limited image request');
        }
        await fsp.unlink(filePath);
        return { skippedFile: true };
      }
      const imgImRoute = isTaskIpcImage
        ? null
        : resolveImRoute({
            ipcAgentId,
            isHome,
            chatJid: data.chatJid,
            sourceGroup,
          });
      let regularImageDelivered: boolean | null = null;
      let durableScopedImage = false;
      if (isTaskIpcImage) {
        const imgRoutingDecision = resolveTaskRoutingDecision(
          data,
          ipcTaskId,
          !!sourceGroupEntry?.created_by,
          { getTaskById, getChannelType },
        );
        if (imgRoutingDecision.mode === 'direct') {
          taskImageTargetJids = [imgRoutingDecision.taskChatJid];
        } else if (
          imgRoutingDecision.mode === 'broadcast' &&
          sourceGroupEntry?.created_by
        ) {
          const alreadySent = new Set<string>(
            [data.chatJid, imgImRoute].filter(Boolean) as string[],
          );
          broadcastToOwnerIMChannels(
            sourceGroupEntry.created_by,
            broadcastFolder,
            alreadySent,
            (jid) => taskImageTargetJids.push(jid),
            imgRoutingDecision.notifyChannels,
          );
        }
      }
      if (imgImRoute) {
        const imageOutboxRef = channelOutboxRefForInput(
          channelTurnScope(sourceGroup, ipcAgentId),
          imgImRoute,
          data.inputTurnId,
          `ipc-image:${messageRequestId ?? file}`,
        );
        durableScopedImage = Boolean(imageOutboxRef);
        regularImageDelivered = await sendTaskImageWithRetry(
          imgImRoute,
          imageBuffer,
          mimeType,
          caption,
          fileName,
          imageOutboxRef,
        );
        if (!regularImageDelivered) {
          const failMsg = durableScopedImage
            ? `⚠️ 图片 "${fileName || caption || 'image'}" 的投递结果待确认，系统不会自动重发，以免产生重复图片。`
            : `⚠️ 图片 "${fileName || caption || 'image'}" 发送失败（IM 通道发送失败），请稍后重试。`;
          broadcastToWebClients(sourceGroup, failMsg, {
            notice: true,
          });
        }
      } else if (!isTaskIpcImage) {
        logger.debug(
          { chatJid: data.chatJid, sourceGroup },
          'No IM route for send_image, skipped IM delivery',
        );
        const skipImgMsg = `⚠️ 图片 "${fileName || 'image'}" 未发送到 IM 通道（当前会话无 IM 路由绑定）。`;
        broadcastToWebClients(data.chatJid ?? sourceGroup, skipImgMsg, {
          notice: true,
        });
      }

      // Conversation agents and isolated scheduled tasks store in
      // virtual JIDs (agent/task tab), not the main conversation.
      // Shares the text path's resolver so images are attributed to
      // the bound workspace instead of the raw IM row.
      const imgChatJid = resolveHostIpcLogicalChatJid({
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

      // Persist image message to DB and broadcast to WebSocket (same as sendMessage flow)
      const displayText = caption
        ? `[图片: ${fileName || 'image'}]\n${caption}`
        : `[图片: ${fileName || 'image'}]`;
      const imgMsgId = crypto.randomUUID();
      const imgTimestamp = new Date().toISOString();
      ensureChatExists(imgChatJid);
      const persistedImgMsgId = storeMessageDirect(
        imgMsgId,
        imgChatJid,
        'ckqclaw-agent',
        ASSISTANT_NAME,
        displayText,
        imgTimestamp,
        true,
        { meta: { sourceKind: 'sdk_send_message' } },
      );
      broadcastNewMessage(imgChatJid, {
        id: persistedImgMsgId,
        chat_jid: imgChatJid,
        sender: 'ckqclaw-agent',
        sender_name: ASSISTANT_NAME,
        content: displayText,
        timestamp: imgTimestamp,
        is_from_me: true,
        turn_id: null,
        session_id: null,
        source_kind: 'sdk_send_message',
        finalization_reason: null,
      });

      // Scheduled-task image routing uses the same direct target /
      // notify-channel fan-out contract as text and file outputs.
      if (isTaskIpcImage) {
        const attempts: TaskNotificationDeliveryAttempt[] = [];
        const relativeImagePath =
          typeof data.filePath === 'string' ? data.filePath : '';
        const imageAttempt = (
          targetJid: string,
        ): TaskNotificationDeliveryAttempt => ({
          channel: getChannelType(targetJid) ?? targetJid,
          payload: {
            kind: 'im_image',
            targetJid,
            workspaceFolder: sourceGroup,
            filePath: relativeImagePath,
            mimeType,
            caption,
            fileName,
          },
          deliver: () =>
            sendTaskImageWithRetry(
              targetJid,
              imageBuffer,
              mimeType,
              caption,
              fileName,
            ),
        });
        for (const targetJid of taskImageTargetJids) {
          attempts.push(imageAttempt(targetJid));
        }
        const delivery = await settleAndRecordTaskIpcDeliveries(
          durableTaskRunId,
          attempts,
        );
        taskImageDeliverySettled = true;
        const delivered =
          delivery.accepted &&
          (delivery.receipt.status === 'success' ||
            delivery.receipt.status === 'skipped');
        messageResultWritten = writeIpcMessageResult(
          messageResultsDir,
          messageRequestId,
          delivered
            ? { success: true }
            : {
                success: false,
                error:
                  delivery.receipt.error ||
                  'Image could not be delivered to its target.',
              },
        );
      } else {
        messageResultWritten = writeIpcMessageResult(
          messageResultsDir,
          messageRequestId,
          regularImageDelivered
            ? { success: true }
            : {
                success: false,
                error: durableScopedImage
                  ? 'Image delivery outcome is uncertain; do not retry automatically.'
                  : 'Image could not be delivered to its IM target.',
              },
        );
        // An image is user-visible speech. Without this the turn
        // looks silent, so a later runner error replays the input
        // and the user receives the artifact twice.
        if (
          regularImageDelivered &&
          typeof data.inputTurnId === 'string' &&
          data.inputTurnId
        ) {
          activeTurnOutputs.recordDeliveredUtterance({
            scopeKey: channelTurnScope(sourceGroup, ipcAgentId),
            inputTurnId: data.inputTurnId,
          });
        }
      }

      logger.info(
        {
          chatJid: imgChatJid,
          sourceGroup,
          mimeType,
          size: imageBuffer.length,
          agentId: ipcAgentId,
        },
        'IPC image sent',
      );
    } catch (err) {
      if (isTaskIpcImage && durableTaskRunId && !taskImageDeliverySettled) {
        const failed = buildFailedTaskImageNotification({
          targetJids: taskImageTargetJids,
          workspaceFolder: sourceGroup,
          filePath: typeof data.filePath === 'string' ? data.filePath : '',
          mimeType: data.mimeType || 'image/png',
          caption: data.caption || undefined,
          fileName: data.fileName || undefined,
          error: err,
          getChannel: getChannelType,
        });
        if (failed) {
          recordTaskRunNotificationReceipt(
            durableTaskRunId,
            failed.receipt,
            failed.payload,
          );
        }
      }
      logger.error(
        { chatJid: data.chatJid, sourceGroup, err },
        'Failed to process IPC image',
      );
      throw err;
    }
  } else {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC image attempt blocked',
    );
    messageResultWritten = writeIpcMessageResult(
      messageResultsDir,
      messageRequestId,
      { success: false, error: 'Unauthorized image target.' },
    );
  }
  return { skippedFile: false, messageResultWritten };
}
