import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { GROUPS_DIR } from '../config.js';
import type { RegisteredGroup } from '../types.js';
import { getTaskById, type TaskRunNotificationReceipt } from '../db.js';
import { getChannelType } from '../im-channel.js';
import { broadcastToWebClients } from '../web.js';
import { resolveTaskRoutingDecision } from '../task-routing.js';
import type { TaskNotificationDeliveryAttempt } from '../task-notification.js';
import { channelTurnScope } from '../channel-turn-registry.js';
import { activeTurnOutputs, canDeliverTurnUtterance } from '../host-state.js';
import { imManager } from '../im-manager.js';
import {
  resolveSendFileRoots,
  resolveSendFilePath,
} from '../send-file-path.js';
import { isRealpathInside } from '../utils.js';

// ISSUE-12 波 4 单元 4.7：send_file case 体自 src/index.ts processTaskIpc
// 的 switch 原文搬运（原 index.ts 11012-11359，348 行）。10 个外围局部量经
// input 显式传参、同名解构使搬运体逐字节不变；12 项 index.ts 本地依赖
// （writeTaskResult/taskRunAcceptsLateIpcOutput/getIpcDeliveryTargetGroup/
// canSendCrossGroupMessage/resolveImRoute/channelOutboxRefForInput/
// sendImWithRetry/sendTaskFileWithRetry/broadcastToOwnerIMChannels/
// settleAndRecordTaskIpcDeliveries/REPLY_LIMIT_REACHED_ERROR）经 input 注入
// 防环（4.3 同款）；可直引依赖（imManager/send-file-path 双解析/
// isRealpathInside/broadcastToWebClients/resolveTaskRoutingDecision/
// getTaskById/getChannelType/channelTurnScope/canDeliverTurnUtterance/
// activeTurnOutputs）自各源模块 import（对 index.ts 零反向依赖已核）。
// 唯一控制流改写：五处 case 级 `break;`（finishSendFile 早退路径）机械转
// 换为 `return;`——switch 为 processTaskIpc 末语句，break≡return 语义等
// 价，体内无内嵌循环/内嵌 switch（已逐处核实），尾随 break 留在壳层。

// index.ts:2084 的 ChannelOutboxDeliveryRef 结构副本（同单元 4.3 留痕）。
interface IpcChannelOutboxDeliveryRef {
  scopeKey: string;
  operationKey: string;
  scopeToken: string;
  ordinalSlot?: string;
}

export interface IpcSendFileInput {
  /** processTaskIpc 解析出的 IPC 请求 JSON（结构类型同壳层，any 语义保留）。 */
  data: any;
  sourceGroup: string;
  isHome: boolean;
  sourceGroupEntry: RegisteredGroup | undefined;
  tasksDir: string;
  ipcAgentId: string | null;
  ipcTaskId: string | null;
  durableTaskRunId: string | null;
  broadcastFolder: string;
  writeTaskResult: (
    tasksDir: string,
    type: string,
    requestId: string | undefined,
    payload: Record<string, unknown>,
  ) => void;
  taskRunAcceptsLateIpcOutput: (runId: string | null) => boolean;
  getIpcDeliveryTargetGroup: (chatJid: string) => RegisteredGroup | undefined;
  canSendCrossGroupMessage: (
    isHome: boolean,
    sourceFolder: string,
    targetGroup: RegisteredGroup | undefined,
  ) => boolean;
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
  sendImWithRetry: (
    imJid: string,
    text: string,
    localImagePaths: string[],
    outbox?: IpcChannelOutboxDeliveryRef,
  ) => Promise<boolean>;
  sendTaskFileWithRetry: (
    targetJid: string,
    filePath: string,
    fileName: string,
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
  REPLY_LIMIT_REACHED_ERROR: string;
  findFileInSubdirs: (
    dir: string,
    fileName: string,
    depth?: number,
  ) => string | null;
}

export async function processIpcSendFile(
  input: IpcSendFileInput,
): Promise<void> {
  const {
    data,
    sourceGroup,
    isHome,
    sourceGroupEntry,
    tasksDir,
    ipcAgentId,
    ipcTaskId,
    durableTaskRunId,
    broadcastFolder,
    writeTaskResult,
    taskRunAcceptsLateIpcOutput,
    getIpcDeliveryTargetGroup,
    canSendCrossGroupMessage,
    resolveImRoute,
    channelOutboxRefForInput,
    sendImWithRetry,
    sendTaskFileWithRetry,
    broadcastToOwnerIMChannels,
    settleAndRecordTaskIpcDeliveries,
    REPLY_LIMIT_REACHED_ERROR,
    findFileInSubdirs,
  } = input;
  const finishSendFile = (success: boolean, error?: string): void => {
    writeTaskResult(tasksDir, 'send_file', data.requestId, {
      success,
      ...(error ? { error } : {}),
    });
  };
  logger.debug(
    { data, sourceGroup, isHome },
    'processTaskIpc send_file reached',
  );
  if (data.chatJid && data.filePath && data.fileName) {
    if (durableTaskRunId && !taskRunAcceptsLateIpcOutput(durableTaskRunId)) {
      finishSendFile(false, 'Task run was cancelled before file delivery.');
      return;
    }
    // Cross-group authorization check (same as send_message)
    const targetGroup = getIpcDeliveryTargetGroup(data.chatJid);
    if (!canSendCrossGroupMessage(isHome, sourceGroup, targetGroup)) {
      logger.warn(
        { chatJid: data.chatJid, sourceGroup },
        'Unauthorized IPC send_file attempt blocked',
      );
      finishSendFile(false, 'Unauthorized file delivery target.');
      return;
    }

    try {
      // Resolve against the workspace the runner actually operates in:
      // host workspaces with a custom cwd deliver from that directory,
      // not data/groups/<folder>. Relative paths mirror the runner spawn
      // cwd; absolute paths are accepted only inside an allowed root.
      const sendRoots = resolveSendFileRoots(
        GROUPS_DIR,
        sourceGroup,
        sourceGroupEntry,
      );
      const resolution = resolveSendFilePath(sendRoots, data.filePath);

      // Path traversal protection: ensure resolved path stays within the
      // allowed roots (primary workspace + canonical group folder).
      if (!resolution.ok) {
        logger.warn(
          {
            sourceGroup,
            filePath: data.filePath,
            resolvedPath: resolution.candidate,
          },
          'Path traversal attempt blocked in send_file IPC',
        );
        finishSendFile(false, 'Invalid file path.');
        return;
      }
      let resolvedPath = resolution.path;

      if (!fs.existsSync(resolvedPath)) {
        // Fallback: search in downloads subdirs (IM channel files land here)
        const downloadsDir = path.join(GROUPS_DIR, sourceGroup, 'downloads');
        const fileName = data.fileName || path.basename(data.filePath);
        const foundPath = fs.existsSync(downloadsDir)
          ? findFileInSubdirs(downloadsDir, fileName)
          : null;
        if (foundPath) {
          logger.info(
            { originalPath: resolvedPath, foundPath },
            'send_file: fell back to downloads subdirectory',
          );
          resolvedPath = foundPath;
        } else {
          const warnMsg = `⚠️ 文件 "${data.fileName}" 未找到（路径 "${data.filePath}" 不存在）。请引导用户确认正确的文件路径，或使用 'send_file' 时提供正确的相对路径。`;
          broadcastToWebClients(sourceGroup, warnMsg, { notice: true });
          // Also notify via IM channel for conversation agents bound to IM
          const imRoute = resolveImRoute({
            ipcAgentId,
            isHome,
            chatJid: data.chatJid,
            sourceGroup,
          });
          if (imRoute) {
            try {
              const ref = channelOutboxRefForInput(
                channelTurnScope(sourceGroup, ipcAgentId),
                imRoute,
                data.inputTurnId,
                `ipc-file-not-found:${data.requestId ?? data.filePath}`,
              );
              if (ref) {
                await sendImWithRetry(imRoute, warnMsg, [], ref);
              } else if (ipcTaskId || data.isScheduledTask) {
                // Scheduled tasks use a separate durable receipt ledger;
                // retain the legacy notification until that branch records
                // its task-scoped failure below.
                await imManager.sendMessage(imRoute, warnMsg);
              } else {
                logger.error(
                  { sourceGroup, agentId: ipcAgentId, imRoute },
                  'Suppressed file-not-found warning without exact channel Turn scope',
                );
              }
            } catch {
              // ignore
            }
          }
          logger.warn(
            { filePath: data.filePath, resolvedPath },
            'send_file: file not found',
          );
          finishSendFile(false, 'File not found.');
          return;
        }
      }

      const fileRoutingDecision = ipcAgentId
        ? { mode: 'none' as const }
        : resolveTaskRoutingDecision(
            data,
            ipcTaskId,
            !!sourceGroupEntry?.created_by,
            { getTaskById, getChannelType },
          );
      const regularFileImRoute =
        fileRoutingDecision.mode === 'none'
          ? resolveImRoute({
              ipcAgentId,
              isHome,
              chatJid: data.chatJid,
              sourceGroup,
            })
          : null;
      if (regularFileImRoute || fileRoutingDecision.mode !== 'none') {
        // Symlink-escape protection: the lexical startsWith check above does
        // not stop a symlink (inside the workspace) pointing at host/other-user
        // files. Re-verify the final path (original OR downloads fallback)
        // resolves inside an allowed root before reading it for delivery.
        if (
          !isRealpathInside(resolvedPath, [
            sendRoots.primary,
            sendRoots.workspace,
          ])
        ) {
          logger.warn(
            { sourceGroup, filePath: data.filePath, resolvedPath },
            'Symlink traversal attempt blocked in send_file IPC',
          );
          finishSendFile(false, 'Invalid file path.');
          return;
        }
        const imFileName = data.fileName || path.basename(resolvedPath);
        if (fileRoutingDecision.mode === 'direct') {
          const targetJid = fileRoutingDecision.taskChatJid;
          const delivery = await settleAndRecordTaskIpcDeliveries(
            durableTaskRunId,
            [
              {
                channel: getChannelType(targetJid) ?? targetJid,
                payload: {
                  kind: 'im_file',
                  targetJid,
                  workspaceFolder: sourceGroup,
                  filePath: data.filePath,
                  fileName: imFileName,
                },
                deliver: () =>
                  sendTaskFileWithRetry(targetJid, resolvedPath, imFileName),
              },
            ],
          );
          const sent =
            delivery.accepted && delivery.receipt.status === 'success';
          if (!sent) {
            broadcastToWebClients(
              sourceGroup,
              `⚠️ 文件 "${data.fileName}" 发送失败，请稍后重试。`,
              {
                notice: true,
              },
            );
          }
          finishSendFile(
            sent,
            sent
              ? undefined
              : delivery.receipt.error || 'File delivery failed.',
          );
        } else if (fileRoutingDecision.mode === 'broadcast') {
          const attempts: TaskNotificationDeliveryAttempt[] = [];
          broadcastToOwnerIMChannels(
            sourceGroupEntry!.created_by!,
            broadcastFolder,
            new Set<string>(),
            (jid) => {
              attempts.push({
                channel: getChannelType(jid) ?? jid,
                payload: {
                  kind: 'im_file',
                  targetJid: jid,
                  workspaceFolder: sourceGroup,
                  filePath: data.filePath!,
                  fileName: imFileName,
                },
                deliver: () =>
                  sendTaskFileWithRetry(jid, resolvedPath, imFileName),
              });
            },
            fileRoutingDecision.notifyChannels,
          );
          const delivery = await settleAndRecordTaskIpcDeliveries(
            durableTaskRunId,
            attempts,
          );
          const sent =
            delivery.accepted &&
            (delivery.receipt.status === 'success' ||
              delivery.receipt.status === 'skipped');
          finishSendFile(
            sent,
            sent
              ? undefined
              : delivery.receipt.error || 'File delivery failed.',
          );
        } else if (
          regularFileImRoute &&
          !canDeliverTurnUtterance(sourceGroup, ipcAgentId, data.inputTurnId)
        ) {
          // Runaway-loop fuse, sharing send_message's budget. A delivered
          // file is user-visible speech and is recorded against the turn,
          // so it must be gated by the same bound.
          logger.warn(
            {
              sourceGroup,
              agentId: ipcAgentId,
              inputTurnId: data.inputTurnId,
            },
            'Suppressed IPC send_file: per-turn reply limit reached',
          );
          finishSendFile(false, REPLY_LIMIT_REACHED_ERROR);
        } else if (regularFileImRoute) {
          const regularFileOutboxRef = channelOutboxRefForInput(
            channelTurnScope(sourceGroup, ipcAgentId),
            regularFileImRoute,
            data.inputTurnId,
            `ipc-file:${data.requestId ?? ipcTaskId ?? data.filePath}`,
          );
          const durableScopedFile = Boolean(regularFileOutboxRef);
          const sent = await sendTaskFileWithRetry(
            regularFileImRoute,
            resolvedPath,
            imFileName,
            regularFileOutboxRef,
          );
          if (!sent) {
            const failMsg = durableScopedFile
              ? `⚠️ 文件 "${data.fileName}" 的投递结果待确认，系统不会自动重发，以免产生重复文件。`
              : `⚠️ 文件 "${data.fileName}" 发送失败，请稍后重试。`;
            broadcastToWebClients(sourceGroup, failMsg, { notice: true });
            if (!durableScopedFile) {
              try {
                await imManager.sendMessage(regularFileImRoute, failMsg);
              } catch {
                // ignore — failure notification itself failing should not crash
              }
            }
          }
          // A delivered file is user-visible speech; record it so the turn
          // is not treated as silent and replayed.
          if (
            sent &&
            typeof data.inputTurnId === 'string' &&
            data.inputTurnId
          ) {
            activeTurnOutputs.recordDeliveredUtterance({
              scopeKey: channelTurnScope(sourceGroup, ipcAgentId),
              inputTurnId: data.inputTurnId,
            });
          }
          finishSendFile(
            sent,
            sent
              ? undefined
              : durableScopedFile
                ? 'File delivery outcome is uncertain; do not retry automatically.'
                : 'File delivery failed.',
          );
        }
      } else {
        logger.debug(
          { chatJid: data.chatJid, sourceGroup },
          'No IM route for send_file, skipped IM delivery',
        );
        // Notify the user that file delivery to IM was skipped
        const skipMsg = `⚠️ 文件 "${data.fileName}" 未发送到 IM 通道（当前会话无 IM 路由绑定，文件仅保存在工作区）。`;
        broadcastToWebClients(data.chatJid ?? sourceGroup, skipMsg, {
          notice: true,
        });
        finishSendFile(false, 'No IM route is available for file delivery.');
      }
      logger.info(
        {
          sourceGroup,
          chatJid: data.chatJid,
          fileName: data.fileName,
          imRoute:
            fileRoutingDecision.mode === 'direct'
              ? fileRoutingDecision.taskChatJid
              : regularFileImRoute,
          taskRoutingMode: fileRoutingDecision.mode,
        },
        'File sent via IPC',
      );
    } catch (err) {
      logger.error({ err, data }, 'Failed to send file via IPC');
      finishSendFile(false, err instanceof Error ? err.message : String(err));
    }
  } else {
    logger.warn(
      { data },
      'Invalid send_file request - missing required fields',
    );
    finishSendFile(false, 'Invalid send_file request.');
  }
}
