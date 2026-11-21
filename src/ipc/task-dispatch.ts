import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import { getRegisteredGroup, getUserById, getUserHomeGroup } from '../db.js';
import { extractDurableTaskRunIdFromNamespace } from '../isolated-task-ipc.js';
import { resolveBroadcastFolder } from '../task-routing.js';
import {
  canIpcActorAccessGroup,
  canIpcActorManageTask,
  type TaskAclDeps,
} from '../task-acl.js';
import { canAccessGroup } from '../web-context.js';
import type { AgentBuilderActor } from '../agent-builder.js';
import {
  processIpcMemoryOwnerOps,
  requireAgentBuilderActorImpl,
} from './memory-owner-ops.js';
import { processIpcBuilderOps } from './builder-ops.js';
import { processIpcTaskOps } from './task-ops.js';
import { processIpcSendFile } from './file-delivery.js';
import { processIpcFeishuCapability } from './feishu-capability-ops.js';
import {
  processIpcInstallSkill,
  processIpcRegisterGroup,
  processIpcUninstallSkill,
} from './skill-registry-ops.js';
import type { IpcSendFileInput } from './file-delivery.js';
import type { IpcSkillRegistryInput } from './skill-registry-ops.js';
import type { IpcFeishuCapabilityInput } from './feishu-capability-ops.js';

// ISSUE-12 波 4 单元 4.5（收官）：processTaskIpc 壳（签名 72 行协议类型 +
// ACL 谓词装配 + actor 适配闭包 + 分发 switch 骨架）自 src/index.ts 原文
// 搬运（原 index.ts 9082-9324，243 行）。分发 switch 为最保守形态：保留
// switch 原文与全部 case 标签（fall-through 组），每 case 体已是 4.6-4.11
// 各模块的单次调用（计划倾向的保守版）。搬运体逐字节一致，唯一文本改写
// = 两处 registeredGroups 读改 getRegisteredGroups() 活读（taskAclDeps.
// lookupGroup 一处 + 适配闭包实参一处，4.2 同款留痕）。三组 case 族依赖
// 对象（ipcFileDeliveryDeps/ipcSkillRegistryDeps/ipcFeishuCapabilityDeps，
// index.ts 模块级既有构造）经 input 整体注入，类型以各模块 Input 接口
// Omit 外围局部量精确收窄；ipcTaskOpsDeps 仍体内构造（引用 input 注入的
// 头局部 ACL 谓词）。index.ts 保留 processTaskIpc 同名签名壳委托，watcher
// 注入面与调用点不变。canAccessGroup/ACL 谓词/db 等 10 项自源模块直引
// （对 index.ts 零反向依赖已核）。

export type IpcTaskRequest = {
  type: string;
  taskId?: string;
  runId?: string;
  expectedRevision?: number;
  idempotencyKey?: string;
  isScheduledTask?: boolean;
  prompt?: string;
  schedule_type?: string;
  schedule_value?: string;
  context_mode?: string;
  execution_type?: string;
  execution_mode?: string;
  script_command?: string;
  groupFolder?: string;
  chatJid?: string;
  targetJid?: string;
  // For register_group
  jid?: string;
  name?: string;
  folder?: string;
  containerConfig?: RegisteredGroup['containerConfig'];
  executionMode?: string;
  // For install_skill / uninstall_skill
  package?: string;
  requestId?: string;
  skillId?: string;
  // For send_file
  filePath?: string;
  fileName?: string;
  // For list_tasks / list_task_runs / workspace_memory snapshots
  isAdminHome?: boolean;
  includeDeleted?: boolean;
  limit?: number;
  before?: string;
  // Host-side Feishu capability broker
  inputTurnId?: string;
  operation?: string;
  params?: Record<string, unknown>;
  // Workspace Memory v2. Workspace/actor/sourceType are never accepted from
  // IPC; processTaskIpc derives them from the verified namespace.
  query?: string;
  kind?: string;
  maxChars?: number;
  itemId?: string;
  title?: string;
  content?: string;
  canonicalKey?: string | null;
  importance?: number;
  confidence?: number;
  validFrom?: string | null;
  validUntil?: string | null;
  expiresAt?: string | null;
  patch?: Record<string, unknown>;
  sessionId?: string;
  timestamp?: string;
  runnerInstanceId?: string;
  mutationSignature?: string;
  // Dedicated built-in CKQClaw Owner Profile facade.
  preferredAddress?: string;
  expectedOnboardingRevision?: number;
  leaseToken?: number;
  // For the main CKQClaw's conversational Agent Builder
  profileId?: string;
  draftId?: string;
  expectedDraftRevision?: number;
  targetAgentProfileId?: string;
  expectedAgentVersion?: number;
  definition?: unknown;
  assumptions?: string[];
};

export type IpcFileDeliveryDeps = Omit<
  IpcSendFileInput,
  | 'data'
  | 'sourceGroup'
  | 'isAdminHome'
  | 'isHome'
  | 'sourceGroupEntry'
  | 'tasksDir'
  | 'ipcAgentId'
  | 'ipcTaskId'
  | 'durableTaskRunId'
  | 'broadcastFolder'
>;
export type IpcSkillRegistryDeps = Omit<
  IpcSkillRegistryInput,
  'data' | 'sourceGroup' | 'isAdminHome'
>;
export type IpcFeishuCapabilityDeps = Omit<
  IpcFeishuCapabilityInput,
  'data' | 'sourceGroup' | 'ipcAgentId' | 'tasksDir'
>;

export interface IpcTaskDispatchInput {
  data: IpcTaskRequest;
  sourceGroup: string;
  isAdminHome: boolean;
  isHome: boolean;
  sourceGroupEntry: RegisteredGroup | undefined;
  tasksDir: string;
  ipcAgentId: string | null;
  ipcTaskId: string | null;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  writeTaskResult: (
    tasksDir: string,
    type: string,
    requestId: string | undefined,
    payload: Record<string, unknown>,
  ) => void;
  SAFE_REQUEST_ID_RE: RegExp;
  isAdminHostOnlyOwner: (ownerId: string | null | undefined) => boolean;
  ipcFileDeliveryDeps: IpcFileDeliveryDeps;
  ipcSkillRegistryDeps: IpcSkillRegistryDeps;
  ipcFeishuCapabilityDeps: IpcFeishuCapabilityDeps;
}

export async function processTaskIpcImpl(
  input: IpcTaskDispatchInput,
): Promise<void> {
  const {
    data,
    sourceGroup,
    isAdminHome,
    isHome,
    sourceGroupEntry,
    tasksDir,
    ipcAgentId,
    ipcTaskId,
    getRegisteredGroups,
    writeTaskResult,
    SAFE_REQUEST_ID_RE,
    isAdminHostOnlyOwner,
    ipcFileDeliveryDeps,
    ipcSkillRegistryDeps,
    ipcFeishuCapabilityDeps,
  } = input;
  const durableTaskRunId = extractDurableTaskRunIdFromNamespace(ipcTaskId);
  const ownerHomeFolderCandidate = sourceGroupEntry?.created_by
    ? getUserHomeGroup(sourceGroupEntry.created_by)?.folder
    : null;
  const broadcastFolder = resolveBroadcastFolder(
    sourceGroup,
    ownerHomeFolderCandidate,
  );

  // Scheduled-task ACL for this IPC surface. The predicate itself lives in
  // src/task-acl.ts so it is unit-testable and cannot silently regress; see
  // that module for why `isAdminHome` is deliberately absent.
  const taskAclDeps: TaskAclDeps = {
    lookupGroup: (jid) => getRegisteredGroups()[jid] ?? getRegisteredGroup(jid),
    resolveActor: () => {
      const actorId = sourceGroupEntry?.created_by;
      if (!actorId) return undefined;
      const actor = getUserById(actorId);
      if (!actor) return undefined;
      return { id: actor.id, role: actor.role, status: actor.status };
    },
    canAccessGroup,
  };
  const ipcActorCanAccessGroupJid = (targetJid: string): boolean =>
    canIpcActorAccessGroup(sourceGroup, targetJid, taskAclDeps);
  const ipcActorCanManageTask = (task: {
    group_folder: string;
    chat_jid: string;
  }): boolean => canIpcActorManageTask(sourceGroup, task, taskAclDeps);

  // ISSUE-12 波 4 单元 4.8：两个 actor 构建器已迁 src/ipc/memory-owner-ops.ts
  // （原文搬运，闭包局部量转显式参数）。此处保留 requireAgentBuilderActor
  // 同名零参适配闭包供 builder-ops 注入（其 input 接口为 () => AgentBuilderActor
  // 不变）；requireOwnerProfileActor 壳层已无消费点，模块内自带镜像适配。
  const requireAgentBuilderActor = (): AgentBuilderActor =>
    requireAgentBuilderActorImpl({
      data,
      sourceGroup,
      sourceGroupEntry,
      ipcAgentId,
      ipcTaskId,
      getRegisteredGroups,
    });

  // ISSUE-12 波 4 单元 4.6：任务生命周期十 case 的依赖注入对象。置于
  // switch 前就地构造——ipcActorCanAccessGroupJid/ipcActorCanManageTask 是
  // 本函数头局部 ACL 谓词，无法上移模块级。
  const ipcTaskOpsDeps = {
    writeTaskResult,
    getRegisteredGroups,
    ipcActorCanAccessGroupJid,
    ipcActorCanManageTask,
    isAdminHostOnlyOwner,
    SAFE_REQUEST_ID_RE,
  };

  switch (data.type) {
    case 'ckqclaw_owner_profile':
    case 'workspace_memory':
      await processIpcMemoryOwnerOps({
        writeTaskResult,
        SAFE_REQUEST_ID_RE,
        data,
        sourceGroup,
        sourceGroupEntry,
        tasksDir,
        ipcAgentId,
        ipcTaskId,
        isHome,
        getRegisteredGroups,
      });
      break;

    case 'agent_profile_list':
    case 'agent_profile_get':
    case 'agent_profile_draft_get':
    case 'agent_capability_catalog':
    case 'agent_profile_prepare':
    case 'agent_profile_publish':
    case 'agent_profile_discard':
      await processIpcBuilderOps({
        writeTaskResult,
        requireAgentBuilderActor,
        data,
        tasksDir,
      });
      break;

    case 'schedule_task':
    case 'pause_task':
    case 'resume_task':
    case 'cancel_task':
    case 'update_task':
    case 'run_task_now':
    case 'stop_task_run':
    case 'restore_task':
    case 'list_task_runs':
    case 'list_tasks':
      await processIpcTaskOps({
        ...ipcTaskOpsDeps,
        data,
        sourceGroup,
        isAdminHome,
        sourceGroupEntry,
        tasksDir,
        ipcAgentId,
      });
      break;

    case 'feishu_capability': {
      await processIpcFeishuCapability({
        ...ipcFeishuCapabilityDeps,
        data,
        sourceGroup,
        ipcAgentId,
        tasksDir,
      });
      break;
    }

    case 'register_group':
      processIpcRegisterGroup({
        ...ipcSkillRegistryDeps,
        data,
        sourceGroup,
        isAdminHome,
      });
      break;

    case 'install_skill':
      await processIpcInstallSkill({
        ...ipcSkillRegistryDeps,
        data,
        sourceGroup,
      });
      break;

    case 'uninstall_skill':
      await processIpcUninstallSkill({
        ...ipcSkillRegistryDeps,
        data,
        sourceGroup,
      });
      break;

    case 'send_file':
      await processIpcSendFile({
        data,
        sourceGroup,
        isAdminHome,
        isHome,
        sourceGroupEntry,
        tasksDir,
        ipcAgentId,
        ipcTaskId,
        durableTaskRunId,
        broadcastFolder,
        ...ipcFileDeliveryDeps,
      });
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
