import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import {
  createTask,
  getAllTasks,
  getDeletedTasks,
  getRegisteredGroup,
  getTaskById,
  getTaskRunById,
  getSessionChannelOwner,
  getActiveTaskRunForTask,
  restoreTaskWithRevision,
  softDeleteTaskWithRevision,
  updateTask,
  updateTaskWithRevision,
} from '../db.js';
import {
  computeNextRunForSchedule,
  computeNextRunForTaskResume,
  getRunningTaskIds,
  notifyTaskSchedulerChanged,
} from '../task-scheduler.js';
import { resolveTaskOwner } from '../task-utils.js';
import { findDuplicateActiveAgentTask } from '../task-definition-fingerprint.js';
import {
  getScriptTaskHostExecutionError,
  resolveTaskExecutionModeForTarget,
  SCRIPT_TASK_HOST_REQUIRED_ERROR,
} from '../script-task-policy.js';
import { getMergedTaskRunHistory } from '../task-run-history.js';
import {
  MAX_TASK_PROMPT_LENGTH,
  MAX_TASK_SCRIPT_COMMAND_LENGTH,
} from '../schemas.js';
import { getWebDeps } from '../web-context.js';

// ISSUE-12 波 4 单元 4.6：任务生命周期十 case（schedule/pause/resume/
// cancel/update/run_task_now/stop_task_run/restore/list_task_runs/list_tasks）
// 自 src/index.ts processTaskIpc 的 switch 原文搬运（原 index.ts 9811-10717
// 含 case 标签共 907 行）。**零控制流改写**：十 case 标签随体迁入，本函数
// 自建 switch (data.type)，全部 break 为内层 switch 级原义保留（switch 为
// 函数末语句）；壳层留十个 fall-through 标签 + 单次调用，外层 switch 标签
// 面不变（ipc-type-bidirectional-contract 的 case 扫描与 result-file-
// prefixes 的动态调用关联均不破）。6 外围局部量 + 6 项 index.ts 本地依赖
// （writeTaskResult/getter/ipcActorCanAccessGroupJid/ipcActorCanManageTask
// 双 ACL 头局部谓词/isAdminHostOnlyOwner/SAFE_REQUEST_ID_RE）经 input 同名
// 解构注入防环；db/task-scheduler/task-utils/task-definition-fingerprint/
// script-task-policy/task-run-history/schemas/web-context 等 20 项自源模块
// 直引（对 index.ts 零反向依赖已核）。唯一文本改写：六处 registeredGroups
// 读改 getRegisteredGroups() 活读（index.ts 有整体重赋值，4.2 同款留痕）。

export interface IpcTaskOpsInput {
  /** processTaskIpc 解析出的 IPC 请求 JSON（结构类型同壳层，any 语义保留）。 */
  data: any;
  sourceGroup: string;
  isHome: boolean;
  sourceGroupEntry: RegisteredGroup | undefined;
  tasksDir: string;
  ipcAgentId: string | null;
  writeTaskResult: (
    tasksDir: string,
    type: string,
    requestId: string | undefined,
    payload: Record<string, unknown>,
  ) => void;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  ipcActorCanAccessGroupJid: (targetJid: string) => boolean;
  ipcActorCanManageTask: (task: {
    group_folder: string;
    chat_jid: string;
  }) => boolean;
  isAdminHostOnlyOwner: (ownerId: string | null | undefined) => boolean;
  SAFE_REQUEST_ID_RE: RegExp;
}

export async function processIpcTaskOps(input: IpcTaskOpsInput): Promise<void> {
  const {
    data,
    sourceGroup,
    isHome,
    sourceGroupEntry,
    tasksDir,
    ipcAgentId,
    writeTaskResult,
    getRegisteredGroups,
    ipcActorCanAccessGroupJid,
    ipcActorCanManageTask,
    isAdminHostOnlyOwner,
    SAFE_REQUEST_ID_RE,
  } = input;
  switch (data.type) {
    case 'schedule_task': {
      const failSchedule = (error: string): void => {
        logger.warn({ sourceGroup, error }, 'schedule_task rejected');
        writeTaskResult(tasksDir, 'schedule_task', data.requestId, {
          success: false,
          error,
        });
      };
      if (data.schedule_type && data.schedule_value && data.targetJid) {
        const execType =
          data.execution_type === 'script'
            ? ('script' as const)
            : ('agent' as const);

        // Script tasks require prompt OR script_command; agent tasks require prompt
        if (execType === 'agent' && !data.prompt) {
          failSchedule('Agent mode requires a prompt.');
          break;
        }
        if (execType === 'script' && !data.script_command) {
          failSchedule('Script mode requires script_command.');
          break;
        }

        // Same bound the REST surface enforces. This is the path the cap was
        // written for: an Agent exposed to untrusted content can otherwise
        // write an unbounded prompt into scheduled_tasks, where it is stored
        // and replayed on every tick.
        if (
          typeof data.prompt === 'string' &&
          data.prompt.length > MAX_TASK_PROMPT_LENGTH
        ) {
          failSchedule(
            `prompt exceeds the maximum length of ${MAX_TASK_PROMPT_LENGTH} characters.`,
          );
          break;
        }
        if (
          typeof data.script_command === 'string' &&
          data.script_command.length > MAX_TASK_SCRIPT_COMMAND_LENGTH
        ) {
          failSchedule(
            `script_command exceeds the maximum length of ${MAX_TASK_SCRIPT_COMMAND_LENGTH} characters.`,
          );
          break;
        }

        // Only the Home workspace can create script tasks
        if (execType === 'script' && !isHome) {
          failSchedule(
            'Only the Home workspace Agent can create script tasks.',
          );
          break;
        }

        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = getRegisteredGroups()[targetJid];

        if (!targetGroupEntry) {
          failSchedule(`Target group is not registered: ${targetJid}`);
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: own workspace, or a group this workspace's owner also
        // owns. Admin home gets no global bypass here — see
        // ipcActorCanAccessGroupJid.
        if (!ipcActorCanAccessGroupJid(targetJid)) {
          failSchedule('Not authorized to schedule tasks for another group.');
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string;
        try {
          nextRun = computeNextRunForSchedule(
            scheduleType,
            data.schedule_value,
          );
        } catch (err) {
          failSchedule(err instanceof Error ? err.message : 'Invalid schedule');
          break;
        }

        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';

        // Resolve the effective execution mode before compatibility deduplication.
        // The requested mode is part of task identity: otherwise an identical
        // prompt could silently reuse a task running across a different security
        // boundary (host vs container).
        const taskCreatedBy = resolveTaskOwner(
          {},
          sourceGroupEntry,
          targetGroupEntry,
        );
        const forceHostOnly = isAdminHostOnlyOwner(taskCreatedBy);
        if (forceHostOnly && data.execution_mode === 'container') {
          failSchedule(
            'Administrator host-only mode is enabled; container task execution is unavailable.',
          );
          break;
        }
        let executionMode: 'host' | 'container';
        try {
          executionMode = forceHostOnly
            ? 'host'
            : resolveTaskExecutionModeForTarget(
                targetGroupEntry.executionMode,
                data.execution_mode === 'host' ||
                  data.execution_mode === 'container'
                  ? data.execution_mode
                  : undefined,
              );
        } catch (err) {
          failSchedule(err instanceof Error ? err.message : String(err));
          break;
        }
        if (execType === 'script' && executionMode !== 'host') {
          failSchedule(SCRIPT_TASK_HOST_REQUIRED_ERROR);
          break;
        }
        // 幂等去重：仅对 agent 任务生效。#564 的递归增殖只发生在 agent 触发回放路径；
        // 而 script 任务真正承载工作的是 script_command（prompt 常为空），prompt/schedule
        // 相同但命令不同的多个 script 任务是合法的，按 prompt 去重会静默丢任务。agent
        // 任务则比较全部执行定义；目标会话、最终执行环境或路由配置不同都不是重复任务。
        const dupExisting = findDuplicateActiveAgentTask(getAllTasks(), {
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt || '',
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          execution_type: execType,
          execution_mode: executionMode,
          script_command: data.script_command ?? null,
          created_by: taskCreatedBy,
          notify_channels: null,
        });
        if (dupExisting) {
          logger.info(
            { sourceGroup, taskId: dupExisting.id },
            'schedule_task: identical active agent task already exists, returning existing',
          );
          writeTaskResult(tasksDir, 'schedule_task', data.requestId, {
            success: true,
            taskId: dupExisting.id,
            nextRun: dupExisting.next_run,
            duplicate: true,
          });
          break;
        }

        const taskId = crypto.randomUUID();

        // Capture the concrete route this task was scheduled from, so a task
        // created inside a Feishu topic delivers back into that topic. The
        // session owner JID carries the thread/root and account fragments;
        // `targetJid` is only conversation-level. Cross-workspace scheduling has
        // no such context, so it binds to the target conversation itself.
        const scheduleDeliveryRouteJid =
          targetFolder === sourceGroup
            ? (getSessionChannelOwner(sourceGroup, ipcAgentId ?? null) ??
              targetJid)
            : targetJid;

        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          delivery_route_jid: scheduleDeliveryRouteJid,
          prompt: data.prompt || '',
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          execution_type: execType,
          execution_mode: executionMode,
          script_command: data.script_command ?? null,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
          created_by: taskCreatedBy,
          notify_channels: null,
        });
        notifyTaskSchedulerChanged();
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode, execType },
          'Task created via IPC',
        );
        writeTaskResult(tasksDir, 'schedule_task', data.requestId, {
          success: true,
          taskId,
          nextRun,
        });
      } else {
        failSchedule('Missing schedule_type, schedule_value, or target group.');
      }
      break;
    }

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && ipcActorCanManageTask(task)) {
          if (!Number.isInteger(data.expectedRevision)) {
            writeTaskResult(tasksDir, 'pause_task', data.requestId, {
              success: false,
              error: 'expected_revision is required. Call list_tasks first.',
            });
            break;
          }
          const mutation = updateTaskWithRevision(
            data.taskId,
            data.expectedRevision!,
            { status: 'paused' },
          );
          if (mutation.status === 'conflict') {
            writeTaskResult(tasksDir, 'pause_task', data.requestId, {
              success: false,
              code: 'TASK_REVISION_CONFLICT',
              error: `Task changed; current revision is ${mutation.task.revision}. Call list_tasks and retry.`,
              task: mutation.task,
            });
            break;
          }
          if (mutation.status === 'not_found') {
            writeTaskResult(tasksDir, 'pause_task', data.requestId, {
              success: false,
              error: 'Task not found.',
            });
            break;
          }
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          notifyTaskSchedulerChanged();
          writeTaskResult(tasksDir, 'pause_task', data.requestId, {
            success: true,
            taskId: data.taskId,
            revision: mutation.task.revision,
          });
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
          writeTaskResult(tasksDir, 'pause_task', data.requestId, {
            success: false,
            error: task
              ? 'Not authorized to pause this task.'
              : 'Task not found.',
          });
        }
      } else {
        writeTaskResult(tasksDir, 'pause_task', data.requestId, {
          success: false,
          error: 'Missing task_id.',
        });
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && ipcActorCanManageTask(task)) {
          if (task.status === 'parsing') {
            writeTaskResult(tasksDir, 'resume_task', data.requestId, {
              success: false,
              error: 'Task is still being parsed.',
            });
            break;
          }
          if (task.execution_type === 'script') {
            if (!isHome) {
              writeTaskResult(tasksDir, 'resume_task', data.requestId, {
                success: false,
                error: 'Only the Home workspace can resume script tasks.',
              });
              break;
            }
            const policyError = getScriptTaskHostExecutionError(
              task,
              getRegisteredGroups(),
            );
            if (policyError) {
              writeTaskResult(tasksDir, 'resume_task', data.requestId, {
                success: false,
                error: policyError,
              });
              break;
            }
          }
          if (task.status === 'completed' && task.schedule_type === 'once') {
            writeTaskResult(tasksDir, 'resume_task', data.requestId, {
              success: false,
              error:
                'Completed one-shot tasks cannot be resumed. Create a new task or update its schedule.',
            });
            break;
          }
          const patch: Parameters<typeof updateTask>[1] = { status: 'active' };
          if (task.schedule_type === 'once' || task.next_run == null) {
            try {
              patch.next_run = computeNextRunForTaskResume(
                task.schedule_type,
                task.schedule_value,
              );
            } catch (err) {
              writeTaskResult(tasksDir, 'resume_task', data.requestId, {
                success: false,
                error: `Invalid schedule: ${err instanceof Error ? err.message : String(err)}`,
              });
              break;
            }
          }
          if (!Number.isInteger(data.expectedRevision)) {
            writeTaskResult(tasksDir, 'resume_task', data.requestId, {
              success: false,
              error: 'expected_revision is required. Call list_tasks first.',
            });
            break;
          }
          const mutation = updateTaskWithRevision(
            data.taskId,
            data.expectedRevision!,
            patch,
          );
          if (mutation.status === 'conflict') {
            writeTaskResult(tasksDir, 'resume_task', data.requestId, {
              success: false,
              code: 'TASK_REVISION_CONFLICT',
              error: `Task changed; current revision is ${mutation.task.revision}. Call list_tasks and retry.`,
              task: mutation.task,
            });
            break;
          }
          if (mutation.status === 'not_found') {
            writeTaskResult(tasksDir, 'resume_task', data.requestId, {
              success: false,
              error: 'Task not found.',
            });
            break;
          }
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          notifyTaskSchedulerChanged();
          writeTaskResult(tasksDir, 'resume_task', data.requestId, {
            success: true,
            taskId: data.taskId,
            revision: mutation.task.revision,
          });
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
          writeTaskResult(tasksDir, 'resume_task', data.requestId, {
            success: false,
            error: task
              ? 'Not authorized to resume this task.'
              : 'Task not found.',
          });
        }
      } else {
        writeTaskResult(tasksDir, 'resume_task', data.requestId, {
          success: false,
          error: 'Missing task_id.',
        });
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && ipcActorCanManageTask(task)) {
          if (task.execution_type === 'script' && !isHome) {
            writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
              success: false,
              error: 'Only the Home workspace can delete script tasks.',
            });
            break;
          }
          if (
            !getActiveTaskRunForTask(data.taskId) &&
            getRunningTaskIds().includes(data.taskId)
          ) {
            writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
              success: false,
              error:
                'Task is running. Wait for it to finish before cancelling.',
            });
            break;
          }
          if (!Number.isInteger(data.expectedRevision)) {
            writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
              success: false,
              error: 'expected_revision is required. Call list_tasks first.',
            });
            break;
          }
          const mutation = softDeleteTaskWithRevision(
            data.taskId,
            data.expectedRevision!,
          );
          if (mutation.status === 'conflict') {
            writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
              success: false,
              code: 'TASK_REVISION_CONFLICT',
              error: `Task changed; current revision is ${mutation.task.revision}. Call list_tasks and retry.`,
              task: mutation.task,
            });
            break;
          }
          if (mutation.status === 'active_run') {
            writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
              success: false,
              code: 'TASK_HAS_ACTIVE_RUN',
              error: 'Task is running. Stop the current run before deleting.',
              runId: mutation.run.id,
            });
            break;
          }
          if (mutation.status === 'not_found') {
            writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
              success: false,
              error: 'Task not found.',
            });
            break;
          }
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          notifyTaskSchedulerChanged();
          writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
            success: true,
            taskId: data.taskId,
            revision: mutation.task.revision,
          });
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
          writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
            success: false,
            error: task
              ? 'Not authorized to cancel this task.'
              : 'Task not found.',
          });
        }
      } else {
        writeTaskResult(tasksDir, 'cancel_task', data.requestId, {
          success: false,
          error: 'Missing task_id.',
        });
      }
      break;

    case 'update_task': {
      const failUpdate = (error: string): void => {
        logger.warn(
          { sourceGroup, taskId: data.taskId, error },
          'update_task rejected',
        );
        writeTaskResult(tasksDir, 'update_task', data.requestId, {
          success: false,
          error,
        });
      };
      if (!data.taskId) {
        failUpdate('Missing task_id.');
        break;
      }
      if (!Number.isInteger(data.expectedRevision)) {
        failUpdate('expected_revision is required. Call list_tasks first.');
        break;
      }
      const task = getTaskById(data.taskId);
      if (!task) {
        failUpdate('Task not found.');
        break;
      }
      // 授权：本组，或本工作区属主同样拥有的组。与 pause/cancel 同款，
      // 走 REST 面同一套 canAccessGroup，Home 不再是全局旁路。
      if (!ipcActorCanManageTask(task)) {
        failUpdate('Not authorized to update this task.');
        break;
      }
      const targetGroup =
        getRegisteredGroups()[task.chat_jid] ??
        getRegisteredGroup(task.chat_jid);
      const targetOwnerId =
        targetGroup?.created_by ??
        Object.values(getRegisteredGroups()).find(
          (group) => group.folder === task.group_folder && !!group.created_by,
        )?.created_by;
      const forceHostOnly = isAdminHostOnlyOwner(targetOwnerId);
      const patch: Parameters<typeof updateTask>[1] = {};
      if (data.execution_type !== undefined) {
        if (data.execution_type === 'script' && !isHome) {
          failUpdate('Only the Home workspace can set script execution.');
          break;
        }
        patch.execution_type =
          data.execution_type === 'script' ? 'script' : 'agent';
      }
      if (data.execution_mode !== undefined) {
        if (forceHostOnly && data.execution_mode === 'container') {
          failUpdate(
            'Administrator host-only mode is enabled; container task execution is unavailable.',
          );
          break;
        }
        if (data.execution_mode === 'host' && !isHome) {
          failUpdate('Only the Home workspace can set host execution mode.');
          break;
        }
        patch.execution_mode =
          data.execution_mode === 'host' ? 'host' : 'container';
      } else if (forceHostOnly && task.execution_mode !== 'host') {
        patch.execution_mode = 'host';
      }
      // An update must not be a way around the create-time bound.
      if (
        typeof data.prompt === 'string' &&
        data.prompt.length > MAX_TASK_PROMPT_LENGTH
      ) {
        failUpdate(
          `prompt exceeds the maximum length of ${MAX_TASK_PROMPT_LENGTH} characters.`,
        );
        break;
      }
      if (
        typeof data.script_command === 'string' &&
        data.script_command.length > MAX_TASK_SCRIPT_COMMAND_LENGTH
      ) {
        failUpdate(
          `script_command exceeds the maximum length of ${MAX_TASK_SCRIPT_COMMAND_LENGTH} characters.`,
        );
        break;
      }
      if (data.prompt !== undefined) patch.prompt = data.prompt;
      if (data.script_command !== undefined)
        patch.script_command = data.script_command;
      if (data.context_mode !== undefined) {
        patch.context_mode =
          data.context_mode === 'group' ? 'group' : 'isolated';
      }
      // schedule 变更 → 用 now 锚点重算 next_run
      let updatedNextRun = task.next_run;
      if (
        data.schedule_type !== undefined ||
        data.schedule_value !== undefined
      ) {
        const newType = (data.schedule_type ?? task.schedule_type) as
          | 'cron'
          | 'interval'
          | 'once';
        const newValue = data.schedule_value ?? task.schedule_value;
        try {
          updatedNextRun = computeNextRunForSchedule(newType, newValue);
        } catch (err) {
          failUpdate(
            `Invalid schedule: ${err instanceof Error ? err.message : String(err)}`,
          );
          break;
        }
        patch.schedule_type = newType;
        patch.schedule_value = newValue;
        patch.next_run = updatedNextRun;
        // 改了 schedule 的已完成 once 任务，复活为 active
        if (task.status === 'completed') patch.status = 'active';
      }
      // 与 schedule_task 一致：最终为 script 执行的任务必须有 script_command，
      // 否则每次触发都会在 script 空命令分支静默失败，而 agent 收到的却是 success。
      const finalExecType = patch.execution_type ?? task.execution_type;
      const finalExecutionMode = patch.execution_mode ?? task.execution_mode;
      if (finalExecType === 'script') {
        const finalScript = patch.script_command ?? task.script_command;
        if (!finalScript || !finalScript.trim()) {
          failUpdate('Script execution requires a non-empty script_command.');
          break;
        }
        if (finalExecutionMode !== 'host') {
          failUpdate(SCRIPT_TASK_HOST_REQUIRED_ERROR);
          break;
        }
      } else {
        const finalPrompt = patch.prompt ?? task.prompt;
        if (!finalPrompt.trim()) {
          failUpdate('Agent execution requires a non-empty prompt.');
          break;
        }
      }
      if (finalExecutionMode === 'host') {
        if (!targetGroup || targetGroup.executionMode !== 'host') {
          failUpdate(
            'Target workspace runs in container mode; host execution is not allowed.',
          );
          break;
        }
      }
      const mutation = updateTaskWithRevision(
        data.taskId,
        data.expectedRevision!,
        patch,
      );
      if (mutation.status === 'conflict') {
        writeTaskResult(tasksDir, 'update_task', data.requestId, {
          success: false,
          code: 'TASK_REVISION_CONFLICT',
          error: `Task changed; current revision is ${mutation.task.revision}. Call list_tasks and retry.`,
          task: mutation.task,
        });
        break;
      }
      if (mutation.status === 'not_found') {
        failUpdate('Task not found.');
        break;
      }
      logger.info({ taskId: data.taskId, sourceGroup }, 'Task updated via IPC');
      notifyTaskSchedulerChanged();
      writeTaskResult(tasksDir, 'update_task', data.requestId, {
        success: true,
        taskId: data.taskId,
        nextRun: updatedNextRun,
        revision: mutation.task.revision,
      });
      break;
    }

    case 'run_task_now': {
      if (!data.taskId) {
        writeTaskResult(tasksDir, 'run_task_now', data.requestId, {
          success: false,
          error: 'Missing task_id.',
        });
        break;
      }
      const task = getTaskById(data.taskId);
      if (!task || task.deleted_at) {
        writeTaskResult(tasksDir, 'run_task_now', data.requestId, {
          success: false,
          error: 'Task not found.',
        });
        break;
      }
      if (!ipcActorCanManageTask(task)) {
        writeTaskResult(tasksDir, 'run_task_now', data.requestId, {
          success: false,
          error: 'Not authorized to run this task.',
        });
        break;
      }
      if (task.execution_type === 'script' && !isHome) {
        writeTaskResult(tasksDir, 'run_task_now', data.requestId, {
          success: false,
          error: 'Only the Home workspace can run script tasks.',
        });
        break;
      }
      const runPolicyError = getScriptTaskHostExecutionError(
        task,
        getRegisteredGroups(),
      );
      if (runPolicyError) {
        updateTaskWithRevision(task.id, task.revision, {
          status: 'paused',
          next_run: null,
        });
        notifyTaskSchedulerChanged();
        writeTaskResult(tasksDir, 'run_task_now', data.requestId, {
          success: false,
          error: runPolicyError,
        });
        break;
      }
      const trigger = getWebDeps()?.triggerTaskRun;
      if (!trigger) {
        writeTaskResult(tasksDir, 'run_task_now', data.requestId, {
          success: false,
          error: 'Scheduler not available.',
        });
        break;
      }
      const result = trigger(
        data.taskId,
        data.idempotencyKey ?? data.requestId,
      );
      writeTaskResult(tasksDir, 'run_task_now', data.requestId, result);
      break;
    }

    case 'stop_task_run': {
      if (!data.runId) {
        writeTaskResult(tasksDir, 'stop_task_run', data.requestId, {
          success: false,
          error: 'Missing run_id.',
        });
        break;
      }
      const run = getTaskRunById(data.runId);
      const task = run ? getTaskById(run.task_id) : undefined;
      if (!run || !task) {
        writeTaskResult(tasksDir, 'stop_task_run', data.requestId, {
          success: false,
          error: 'Task run not found.',
        });
        break;
      }
      if (!ipcActorCanManageTask(task)) {
        writeTaskResult(tasksDir, 'stop_task_run', data.requestId, {
          success: false,
          error: 'Not authorized to stop this run.',
        });
        break;
      }
      if (task.execution_type === 'script' && !isHome) {
        writeTaskResult(tasksDir, 'stop_task_run', data.requestId, {
          success: false,
          error: 'Only the Home workspace can stop script task runs.',
        });
        break;
      }
      const cancel = getWebDeps()?.cancelTaskRun;
      if (!cancel) {
        writeTaskResult(tasksDir, 'stop_task_run', data.requestId, {
          success: false,
          error: 'Run cancellation is not available.',
        });
        break;
      }
      writeTaskResult(
        tasksDir,
        'stop_task_run',
        data.requestId,
        cancel(data.runId),
      );
      break;
    }

    case 'restore_task': {
      if (!data.taskId || !Number.isInteger(data.expectedRevision)) {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          error: 'task_id and expected_revision are required.',
        });
        break;
      }
      const task = getTaskById(data.taskId);
      if (!task || !task.deleted_at) {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          error: 'Deleted task not found.',
        });
        break;
      }
      if (!ipcActorCanManageTask(task)) {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          error: 'Not authorized to restore this task.',
        });
        break;
      }
      if (task.execution_type === 'script' && !isHome) {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          error: 'Only the Home workspace can restore script tasks.',
        });
        break;
      }
      const restorePolicyError = getScriptTaskHostExecutionError(
        task,
        getRegisteredGroups(),
      );
      if (restorePolicyError) {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          error: restorePolicyError,
        });
        break;
      }
      const mutation = restoreTaskWithRevision(task.id, data.expectedRevision!);
      if (mutation.status === 'conflict') {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          code: 'TASK_REVISION_CONFLICT',
          error: `Task changed; current revision is ${mutation.task.revision}.`,
          task: mutation.task,
        });
      } else if (mutation.status === 'updated') {
        notifyTaskSchedulerChanged();
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: true,
          taskId: task.id,
          revision: mutation.task.revision,
        });
      } else {
        writeTaskResult(tasksDir, 'restore_task', data.requestId, {
          success: false,
          error: 'Deleted task not found.',
        });
      }
      break;
    }

    case 'list_task_runs': {
      if (!data.taskId) {
        writeTaskResult(tasksDir, 'list_task_runs', data.requestId, {
          success: false,
          error: 'Missing task_id.',
        });
        break;
      }
      const task = getTaskById(data.taskId);
      if (!task || !ipcActorCanManageTask(task)) {
        writeTaskResult(tasksDir, 'list_task_runs', data.requestId, {
          success: false,
          error: 'Task not found or not authorized.',
        });
        break;
      }
      const limit = Math.min(Math.max(data.limit ?? 20, 1), 50);
      writeTaskResult(tasksDir, 'list_task_runs', data.requestId, {
        success: true,
        runs: getMergedTaskRunHistory(task.id, limit),
      });
      break;
    }

    case 'list_tasks':
      if (data.requestId) {
        const requestId = data.requestId;
        if (!SAFE_REQUEST_ID_RE.test(requestId)) {
          logger.warn(
            { sourceGroup, requestId },
            'Rejected list_tasks request with invalid requestId',
          );
          break;
        }
        // 用请求所在的 tasksDir（可能是会话子 agent / isolated 任务的嵌套 root），
        // 而非按 sourceGroup 重算主 root，否则嵌套场景回执读不到。
        const listTasksDir = tasksDir;
        const listTasksDirResolved = path.resolve(listTasksDir);
        const resultFileName = `list_tasks_result_${requestId}.json`;
        const resultFilePath = path.resolve(listTasksDir, resultFileName);
        if (!resultFilePath.startsWith(`${listTasksDirResolved}${path.sep}`)) {
          logger.warn(
            { sourceGroup, requestId, resultFilePath },
            'Rejected list_tasks request with unsafe result file path',
          );
          break;
        }

        fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
        try {
          const allTasks = data.includeDeleted
            ? [...getAllTasks(), ...getDeletedTasks()]
            : getAllTasks();
          // Visibility follows the same ACL as mutation: own workspace plus
          // groups this workspace's owner also owns. A task's `prompt` is user
          // content, so Home must not enumerate other tenants' rows.
          const filteredTasks = allTasks.filter((t) =>
            ipcActorCanManageTask(t),
          );
          const taskList = filteredTasks.map((t) => ({
            id: t.id,
            groupFolder: t.group_folder,
            prompt: t.prompt,
            schedule_type: t.schedule_type,
            schedule_value: t.schedule_value,
            status: t.status,
            next_run: t.next_run,
            revision: t.revision,
            deleted_at: t.deleted_at,
            current_run: getActiveTaskRunForTask(t.id) ?? null,
          }));
          const resultData = JSON.stringify({ success: true, tasks: taskList });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.writeFileSync(tmpPath, resultData);
          fs.renameSync(tmpPath, resultFilePath);
          logger.debug(
            { sourceGroup, taskCount: taskList.length },
            'Task list sent via IPC',
          );
        } catch (err) {
          const errorResult = JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.writeFileSync(tmpPath, errorResult);
          fs.renameSync(tmpPath, resultFilePath);
          logger.error({ sourceGroup, err }, 'Failed to list tasks via IPC');
        }
      }
      break;
  }
}
