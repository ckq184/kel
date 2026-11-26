import fs from 'fs';
import path from 'path';
import * as fsp from 'fs/promises';
import { logger } from '../logger.js';
import { DATA_DIR } from '../config.js';
import type { RegisteredGroup } from '../types.js';
import {
  deleteMessagesForChatJid,
  deleteSession,
  finalizeTaskRunNotificationIfPending,
  getUserHomeGroup,
  type TaskRunNotificationReceipt,
} from '../db.js';
import { resolveBroadcastFolder } from '../task-routing.js';
import {
  canDeleteAcknowledgedIpcSource,
  extractDurableTaskRunIdFromNamespace,
  tryCleanupCompletedIsolatedTaskRunIpc,
} from '../isolated-task-ipc.js';
import { cleanupContainerTaskRuntimeEnvDirs } from '../container-runner.js';
import type { TaskNotificationDeliveryAttempt } from '../task-notification.js';
import { type ChannelMessageDeliveryOptions } from '../im-channel.js';
import { type TurnMessageDeliveryRole } from '../turn-output-coordinator.js';
import type { MessageFinalizationReason, MessageSourceKind } from '../types.js';
import { processIpcSendMessage } from './message-delivery.js';
import { processIpcSendImage } from './image-delivery.js';

// ISSUE-12 波 4 单元 4.2：IpcWatcherManager 类、其模块级单例 ipcWatcherManager
// 与 startIpcWatcher 函数体自 src/index.ts 原文搬运（原 index.ts 820/823-969/
// 9011-9512）。分支已由单元 4.3/4.4 抽出为兄弟模块，本模块只保留目录扫描/
// 身份解析/命名空间善后与事件驱动 + 5s 兜底轮询。可直引依赖自各源模块
// import（对 index.ts 零反向依赖已核）；25 项 index.ts 本地依赖经 deps 同名
// 解构注入防环（4.3 同款）。五处留痕改写：①类注入 isShuttingDown 构造参数
// （类内 1 处读改 this.isShuttingDown()）②体内 shuttingDown 读 ×2 改
// isShuttingDown() ③registeredGroups 有整体重赋值故注入 getter，体内唯一
// 读点 Object.values(getRegisteredGroups()) ④实例化传入 isShuttingDown
// ⑤index.ts 四处 ipcWatcherManager?.watchGroup/unwatchGroup 外部调用点改
// 本模块导出的 watchIpcGroup/unwatchIpcGroup。ipcWatcherRunning 状态唯一
// 消费点在本体，随体迁移；processTaskIpc/writeTaskResult/writeIpcMessageResult/
// cleanupStaleIpcMessageResults 留守 index.ts（已是 4.3/4.4 注入面）经
// deps 注入，计划表 10130-10348 区段三回执助手不随迁的取舍已留痕。
// fsp 以 `import * as fsp from 'fs/promises'` 承接原 `const fsp =
// fs.promises`（同一绑定组）。

// ── IPC Watcher Manager (event-driven fs.watch + fallback polling) ──

class IpcWatcherManager {
  private watchers = new Map<
    string,
    { watchers: fs.FSWatcher[]; refCount: number }
  >();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processingFolders = new Set<string>();
  private pendingReprocess = new Set<string>();
  private fallbackTimer: ReturnType<typeof setInterval> | null = null;
  private processGroupFn: ((folder: string) => Promise<void>) | null = null;
  private processFullFn: (() => Promise<void>) | null = null;

  private isShuttingDown: () => boolean;

  constructor(isShuttingDown: () => boolean) {
    this.isShuttingDown = isShuttingDown;
  }

  /** Bind the per-group and full-scan processing functions (set once from startIpcWatcher). */
  bind(
    processGroup: (folder: string) => Promise<void>,
    processFull: () => Promise<void>,
  ): void {
    this.processGroupFn = processGroup;
    this.processFullFn = processFull;
  }

  /** Start watching a group's IPC directories. Called when a container/process starts. */
  watchGroup(folder: string): void {
    const existing = this.watchers.get(folder);
    if (existing) {
      existing.refCount++;
      return;
    }

    const groupIpcRoot = path.join(DATA_DIR, 'ipc', folder);
    const dirsToWatch = [
      path.join(groupIpcRoot, 'messages'),
      path.join(groupIpcRoot, 'tasks'),
    ];

    const folderWatchers: fs.FSWatcher[] = [];
    for (const dir of dirsToWatch) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        // Listen to all event types — 'rename' covers atomic writes on Linux,
        // but Docker bind mounts (macOS virtiofs) may emit 'change' instead.
        const w = fs.watch(dir, () => {
          this.debouncedProcess(folder);
        });
        w.on('error', () => {
          // Watcher error — fallback polling will handle it
        });
        folderWatchers.push(w);
      } catch {
        // Watch failed — fallback polling will handle it
      }
    }
    this.watchers.set(folder, { watchers: folderWatchers, refCount: 1 });
  }

  /** Stop watching a group's IPC directories. Called when a container/process stops. */
  unwatchGroup(folder: string): void {
    const entry = this.watchers.get(folder);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0) return;

    for (const w of entry.watchers) {
      try {
        w.close();
      } catch {}
    }
    this.watchers.delete(folder);
    const timer = this.debounceTimers.get(folder);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(folder);
    }
  }

  private debouncedProcess(folder: string): void {
    const existing = this.debounceTimers.get(folder);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      folder,
      setTimeout(() => {
        this.debounceTimers.delete(folder);
        // Skip if a previous processGroupIpc call for this folder is still running;
        // the pending flag ensures we re-process after the current run finishes.
        if (this.processingFolders.has(folder)) {
          this.pendingReprocess.add(folder);
          return;
        }
        this.processingFolders.add(folder);
        this.processGroupFn?.(folder)
          .catch((err) => {
            logger.error({ err, folder }, 'Error processing IPC for group');
          })
          .finally(() => {
            this.processingFolders.delete(folder);
            // Files may have arrived during processing — run once more
            if (
              this.pendingReprocess.delete(folder) &&
              this.watchers.has(folder)
            ) {
              this.debouncedProcess(folder);
            }
          });
      }, 100),
    );
  }

  /** Trigger processing for a folder through the concurrency guard. */
  triggerProcess(folder: string): void {
    this.debouncedProcess(folder);
  }

  /** Start fallback polling (every 5s) as safety net for inotify failures. */
  startFallback(): void {
    this.fallbackTimer = setInterval(() => {
      if (this.isShuttingDown()) return;
      this.processFullFn?.().catch((err) => {
        logger.error({ err }, 'Error in IPC fallback scan');
      });
    }, 5000);
    this.fallbackTimer.unref(); // Don't prevent process from naturally exiting
  }

  /** Close all watchers and timers. */
  closeAll(): void {
    for (const [, entry] of this.watchers) {
      for (const w of entry.watchers) {
        try {
          w.close();
        } catch {}
      }
    }
    this.watchers.clear();
    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }
}

let ipcWatcherManager: IpcWatcherManager | null = null;

// ISSUE-12 波 4 单元 4.2：随体迁移的启动去重状态（原 index.ts:820，
// 唯一消费点在 runIpcWatcher）。
let ipcWatcherRunning = false;

/** 群聊容器启停的外部入口（原 index.ts ipcWatcherManager?.watchGroup 调用点）。 */
export function watchIpcGroup(folder: string): void {
  ipcWatcherManager?.watchGroup(folder);
}

/** 停看群聊 IPC 目录（原 index.ts ipcWatcherManager?.unwatchGroup 调用点）。 */
export function unwatchIpcGroup(folder: string): void {
  ipcWatcherManager?.unwatchGroup(folder);
}

/** 关停钩子（原 index.ts 关停处理器 ipcWatcherManager?.closeAll() 调用点改经此转发）。 */
export function closeIpcWatchers(): void {
  ipcWatcherManager?.closeAll();
}

// index.ts:2084 的 ChannelOutboxDeliveryRef 结构副本（同单元 4.3/4.4 留痕）。
interface IpcChannelOutboxDeliveryRef {
  scopeKey: string;
  operationKey: string;
  scopeToken: string;
  ordinalSlot?: string;
}

export interface IpcWatcherDeps {
  isShuttingDown: () => boolean;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  cleanupStaleIpcMessageResults: (resultsDir: string) => Promise<void>;
  processTaskIpc: (
    data: any,
    sourceGroup: string,
    isHome: boolean,
    sourceGroupEntry: RegisteredGroup | undefined,
    tasksDir: string,
    ipcAgentId: string | null,
    ipcTaskId: string | null,
  ) => Promise<void>;
  writeTaskResult: (
    tasksDir: string,
    type: string,
    requestId: string | undefined,
    payload: Record<string, unknown>,
  ) => void;
  writeIpcMessageResult: (
    resultsDir: string,
    requestId: string | undefined,
    payload: Record<string, unknown>,
  ) => boolean;
  REPLY_LIMIT_REACHED_ERROR: string;
  activeImReplyRoutes: Map<string, string | null>;
  canSendCrossGroupMessage: (
    isHome: boolean,
    sourceFolder: string,
    targetGroup: RegisteredGroup | undefined,
  ) => boolean;
  getIpcDeliveryTargetGroup: (chatJid: string) => RegisteredGroup | undefined;
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

export function runIpcWatcher(deps: IpcWatcherDeps): void {
  const {
    isShuttingDown,
    getRegisteredGroups,
    cleanupStaleIpcMessageResults,
    processTaskIpc,
    writeTaskResult,
    writeIpcMessageResult,
    REPLY_LIMIT_REACHED_ERROR,
    activeImReplyRoutes,
    canSendCrossGroupMessage,
    getIpcDeliveryTargetGroup,
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
  } = deps;
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const fsp = fs.promises;

  // ISSUE-12 波 4 单元 4.3：messages 侧投递分支的 index.ts 本地依赖注入
  // 对象（防 src/ipc/message-delivery.ts ↔ index.ts import 环）。运行期
  // 构造，函数声明提升使下方定义先于构造求值无碍。
  const ipcMessageDeliveryDeps = {
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
  };

  // ISSUE-12 波 4 单元 4.4：send_image 分支的 index.ts 本地依赖注入
  // 对象（防 src/ipc/image-delivery.ts ↔ index.ts import 环，4.3 同款）。
  const ipcImageDeliveryDeps = {
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
  };

  const processGroupIpc = async (sourceGroup: string) => {
    if (isShuttingDown()) return;
    // Determine if this IPC directory belongs to a Home workspace
    const sourceFolderEntries = Object.values(getRegisteredGroups()).filter(
      (group) => group.folder === sourceGroup,
    );
    // A home runtime can serve sibling channel JIDs that share its folder.
    // Prefer the home record so folder-level IPC gets the identity of the
    // process that actually owns it, independent of object insertion order.
    const sourceGroupEntry =
      sourceFolderEntries.find((group) => group.is_home) ??
      sourceFolderEntries[0];
    const isHome = !!sourceGroupEntry?.is_home;

    // Collect all IPC roots: main group dir + agents/*/ + tasks-run/*/
    // Tag agent roots with their agentId so we can route messages to virtual JIDs.
    const groupIpcRoot = path.join(ipcBaseDir, sourceGroup);
    const ipcRoots: Array<{
      path: string;
      agentId: string | null;
      taskId: string | null;
    }> = [{ path: groupIpcRoot, agentId: null, taskId: null }];
    try {
      const agentsDir = path.join(groupIpcRoot, 'agents');
      const agentEntries = await fsp.readdir(agentsDir, {
        withFileTypes: true,
      });
      for (const entry of agentEntries) {
        if (entry.isDirectory()) {
          ipcRoots.push({
            path: path.join(agentsDir, entry.name),
            agentId: entry.name,
            taskId: null,
          });
        }
      }
    } catch {
      /* agents dir may not exist */
    }
    try {
      const tasksRunDir = path.join(groupIpcRoot, 'tasks-run');
      const taskRunEntries = await fsp.readdir(tasksRunDir, {
        withFileTypes: true,
      });
      for (const entry of taskRunEntries) {
        if (entry.isDirectory()) {
          ipcRoots.push({
            path: path.join(tasksRunDir, entry.name),
            agentId: null,
            taskId: entry.name,
          });
        }
      }
    } catch {
      /* tasks-run dir may not exist */
    }

    // Broadcast folder: the workspace folder whose IPC message we are
    // processing. Fix F: use sourceGroup (the emitting workspace's folder),
    // NOT the owner's home folder — non-home workspaces bind to their own
    // IM groups and must route replies to those bindings.
    //
    // Go through resolveBroadcastFolder so the choice between sourceGroup
    // and ownerHome is locked by a unit test. Reverting this line to
    // `ownerHome?.folder || sourceGroup` (the pre-fix F behavior) must
    // break the helper's test, not silently pass CI.
    const ownerHomeFolderCandidate = sourceGroupEntry?.created_by
      ? getUserHomeGroup(sourceGroupEntry.created_by)?.folder
      : null;
    const broadcastFolder = resolveBroadcastFolder(
      sourceGroup,
      ownerHomeFolderCandidate,
    );

    for (const {
      path: ipcRoot,
      agentId: ipcAgentId,
      taskId: ipcTaskId,
    } of ipcRoots) {
      const durableTaskRunId = extractDurableTaskRunIdFromNamespace(ipcTaskId);
      const messagesDir = path.join(ipcRoot, 'messages');
      const messageResultsDir = path.join(ipcRoot, 'message-results');
      const tasksDir = path.join(ipcRoot, 'tasks');

      await cleanupStaleIpcMessageResults(messageResultsDir);

      // Process messages from this group's IPC directory
      try {
        const messageEntries = await fsp.readdir(messagesDir);
        const messageFiles = messageEntries.filter((f) => f.endsWith('.json'));
        for (const file of messageFiles) {
          const filePath = path.join(messagesDir, file);
          let messageRequestId: string | undefined;
          let messageResultWritten = false;
          try {
            const raw = await fsp.readFile(filePath, 'utf-8');
            const data = JSON.parse(raw);
            messageRequestId =
              typeof data.requestId === 'string' ? data.requestId : undefined;
            if (
              data.type === 'message' &&
              (typeof data.chatJid !== 'string' ||
                !data.chatJid ||
                typeof data.text !== 'string' ||
                !data.text)
            ) {
              messageResultWritten = writeIpcMessageResult(
                messageResultsDir,
                messageRequestId,
                { success: false, error: 'Invalid message request.' },
              );
              await fsp.unlink(filePath);
              continue;
            }
            if (
              data.type === 'image' &&
              (typeof data.chatJid !== 'string' ||
                !data.chatJid ||
                typeof data.imageBase64 !== 'string' ||
                !data.imageBase64)
            ) {
              messageResultWritten = writeIpcMessageResult(
                messageResultsDir,
                messageRequestId,
                { success: false, error: 'Invalid image request.' },
              );
              if (
                !canDeleteAcknowledgedIpcSource(
                  messageRequestId,
                  messageResultWritten,
                )
              ) {
                throw new Error('Failed to acknowledge invalid image request');
              }
              await fsp.unlink(filePath);
              continue;
            }
            if (data.type === 'message' && data.chatJid && data.text) {
              const sendOutcome = await processIpcSendMessage({
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
                ...ipcMessageDeliveryDeps,
              });
              if (sendOutcome.skippedFile) continue;
              messageResultWritten = sendOutcome.messageResultWritten;
            } else if (
              data.type === 'image' &&
              data.chatJid &&
              data.imageBase64
            ) {
              const imageOutcome = await processIpcSendImage({
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
                ...ipcImageDeliveryDeps,
              });
              if (imageOutcome.skippedFile) continue;
              messageResultWritten = imageOutcome.messageResultWritten;
            }
            if (
              !canDeleteAcknowledgedIpcSource(
                messageRequestId,
                messageResultWritten,
              )
            ) {
              throw new Error('Failed to acknowledge IPC delivery result');
            }
            await fsp.unlink(filePath);
          } catch (err) {
            if (!messageResultWritten) {
              writeIpcMessageResult(messageResultsDir, messageRequestId, {
                success: false,
                error: 'Internal error while delivering message.',
              });
            }
            logger.error(
              { file, sourceGroup, err },
              'Error processing IPC message',
            );
            const errorDir = path.join(ipcBaseDir, 'errors');
            await fsp.mkdir(errorDir, { recursive: true });
            try {
              await fsp.rename(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            } catch (renameErr) {
              logger.error(
                { file, sourceGroup, renameErr },
                'Failed to move IPC message to error directory; retaining source for retry',
              );
            }
          }
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          logger.error(
            { err, sourceGroup },
            'Error reading IPC messages directory',
          );
        }
      }

      // Process tasks from this group's IPC directory
      try {
        const allEntries = await fsp.readdir(tasksDir, {
          withFileTypes: true,
        });

        // 清理孤儿结果文件（容器崩溃或超时后残留，超过 10 分钟自动删除）。
        // 名单必须覆盖 writeTaskResult 的全部写入 type（文件名 = `${type}_result_`
        // _${requestId}.json），漏一项就会让该类回执落进 !isResultFile 分支被当作
        // 任务请求处理、引发伪任务告警——由
        // tests/result-file-prefixes-consistency.test.ts 源码一致性测试锁定。
        const RESULT_FILE_PREFIXES = [
          'install_skill_result_',
          'uninstall_skill_result_',
          'list_tasks_result_',
          'schedule_task_result_',
          'cancel_task_result_',
          'pause_task_result_',
          'resume_task_result_',
          'update_task_result_',
          'run_task_now_result_',
          'stop_task_run_result_',
          'restore_task_result_',
          'list_task_runs_result_',
          'send_file_result_',
          'agent_profile_list_result_',
          'agent_profile_get_result_',
          'agent_profile_draft_get_result_',
          'agent_capability_catalog_result_',
          'agent_profile_prepare_result_',
          'agent_profile_publish_result_',
          'agent_profile_discard_result_',
          'workspace_memory_result_',
          'ckqclaw_owner_profile_result_',
          'feishu_capability_result_',
        ];
        const isResultFile = (name: string) =>
          RESULT_FILE_PREFIXES.some((p) => name.startsWith(p));

        for (const entry of allEntries) {
          if (
            entry.isFile() &&
            entry.name.endsWith('.json') &&
            isResultFile(entry.name)
          ) {
            try {
              const filePath = path.join(tasksDir, entry.name);
              const stat = await fsp.stat(filePath);
              if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
                await fsp.unlink(filePath);
                logger.debug(
                  { sourceGroup, file: entry.name },
                  'Cleaned up stale result file',
                );
              }
            } catch {
              /* ignore */
            }
          }
        }

        const taskFiles = allEntries
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.endsWith('.json') &&
              !isResultFile(entry.name),
          )
          .map((entry) => entry.name);
        for (const file of taskFiles) {
          const filePath = path.join(tasksDir, file);
          let parsedData: { type?: string; requestId?: string } | undefined;
          try {
            const raw = await fsp.readFile(filePath, 'utf-8');
            const data = JSON.parse(raw);
            parsedData = data;
            // Pass source group identity to processTaskIpc for authorization.
            // tasksDir 是请求文件被读出的那个 ipcRoot/tasks，回执必须写回同一目录。
            await processTaskIpc(
              data,
              sourceGroup,
              isHome,
              sourceGroupEntry,
              tasksDir,
              ipcAgentId,
              ipcTaskId,
            );
            await fsp.unlink(filePath);
          } catch (err) {
            logger.error(
              { file, sourceGroup, err },
              'Error processing IPC task',
            );
            // 兜底：带 requestId 的任务请求若在处理中抛异常（如 DB 锁/损坏），也写一条
            // 失败回执，避免容器侧 pollIpcResult 空等满 30s 超时。
            if (
              parsedData?.requestId &&
              typeof parsedData.type === 'string' &&
              parsedData.type.endsWith('_task')
            ) {
              writeTaskResult(tasksDir, parsedData.type, parsedData.requestId, {
                success: false,
                error: 'Internal error while processing task request.',
              });
            }
            const errorDir = path.join(ipcBaseDir, 'errors');
            await fsp.mkdir(errorDir, { recursive: true });
            try {
              await fsp.rename(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            } catch (renameErr) {
              logger.error(
                { file, sourceGroup, renameErr },
                'Failed to move IPC task to error directory, deleting',
              );
              try {
                await fsp.unlink(filePath);
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          logger.error(
            { err, sourceGroup },
            'Error reading IPC tasks directory',
          );
        }
      }

      // The scheduler only marks isolated IPC namespaces complete.  Output
      // files remain authoritative until this watcher has finished their side
      // effects and unlinked/archived them.  Cleaning here also recovers runs
      // left behind by a process crash: the startup full scan drains the files
      // first, then removes the completed namespace.
      if (ipcTaskId) {
        try {
          if (
            tryCleanupCompletedIsolatedTaskRunIpc(ipcRoot, (completion) => {
              if (
                completion.taskRunId !== ipcTaskId ||
                completion.workspaceFolder !== sourceGroup
              ) {
                throw new Error(
                  'Isolated task completion marker does not match its IPC namespace',
                );
              }
              const completedDurableRunId =
                completion.durableRunId ?? durableTaskRunId;
              if (completedDurableRunId) {
                finalizeTaskRunNotificationIfPending(completedDurableRunId);
              }
              deleteSession(sourceGroup, completion.sessionAgentId);
              deleteMessagesForChatJid(completion.virtualChatJid);
              fs.rmSync(
                path.join(
                  DATA_DIR,
                  'sessions',
                  sourceGroup,
                  'agents',
                  completion.sessionAgentId,
                ),
                { recursive: true, force: true },
              );
              cleanupContainerTaskRuntimeEnvDirs(sourceGroup, ipcTaskId);
            })
          ) {
            logger.debug(
              { sourceGroup, taskRunId: ipcTaskId },
              'Cleaned completed isolated task IPC namespace after drain',
            );
          }
        } catch (err) {
          logger.warn(
            { sourceGroup, taskRunId: ipcTaskId, err },
            'Failed to clean completed isolated task IPC namespace',
          );
        }
      }
    } // end for (const ipcRoot of ipcRoots)
  };

  const processIpcFilesFull = async () => {
    if (isShuttingDown()) return;
    let groupFolders: string[];
    try {
      const entries = await fsp.readdir(ipcBaseDir, { withFileTypes: true });
      groupFolders = entries
        .filter((e) => e.isDirectory() && e.name !== 'errors')
        .map((e) => e.name);
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      return;
    }

    for (const sourceGroup of groupFolders) {
      // Route through the concurrency guard to prevent racing with event-driven triggers
      ipcWatcherManager!.triggerProcess(sourceGroup);
    }
  };

  // Initialize the event-driven IPC watcher manager
  ipcWatcherManager = new IpcWatcherManager(isShuttingDown);
  ipcWatcherManager.bind(processGroupIpc, processIpcFilesFull);

  // Initial full scan
  processIpcFilesFull().catch((err) => {
    logger.error({ err }, 'Error in initial IPC scan');
  });

  // Start fallback polling (5s instead of 1s)
  ipcWatcherManager.startFallback();

  logger.info('IPC watcher started (event-driven + 5s fallback)');
}
