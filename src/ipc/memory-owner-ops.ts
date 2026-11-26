import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import {
  getAgent,
  getAgentBuilderInputMessage,
  getAgentProfileForWorkspace,
  getJidsByFolder,
  getRegisteredGroup,
  getSession,
  getUserById,
} from '../db.js';
import {
  OwnerProfileStoreError,
  acknowledgeCkqclawOwnerIntroduction,
  claimCkqclawOwnerIntroduction,
  clearCkqclawOwnerPreferredAddress,
  setCkqclawOwnerPreferredAddress,
  skipCkqclawOwnerIntroduction,
} from '../owner-profile-store.js';
import {
  WorkspaceMemoryServiceError,
  createWorkspaceMemory,
  forgetWorkspaceMemory,
  getWorkspaceMemory,
  getWorkspaceMemorySnapshot,
  searchWorkspaceMemory,
  updateWorkspaceMemory,
} from '../memory-service.js';
import {
  buildWorkspaceMemoryUpdateInput,
  workspaceMemoryWriteRejection,
} from '../workspace-memory-ipc.js';
import {
  verifyAndConsumeWorkspaceMemoryMutation,
  verifyWorkspaceMemoryCapability,
} from '../workspace-memory-capability.js';
import type { WorkspaceMemoryMutationContext } from '../memory-store.js';
import {
  agentBuilderTurnScope,
  getAgentBuilderRuntimeRejection,
  isAgentBuilderOwnerInput,
  isOwnerProfileOwnerInput,
  OWNER_PROFILE_TRUSTED_CLAIM_SOURCES,
} from '../agent-builder-turn-auth.js';
import type { AgentBuilderActor } from '../agent-builder.js';
import { activeAgentBuilderTurns } from '../host-state.js';
import { getChannelType } from '../im-channel.js';

// ISSUE-12 波 4 单元 4.8：ckqclaw_owner_profile / workspace_memory 两 case
// 体与 processTaskIpc 头部两个 actor 构建器自 src/index.ts 原文搬运（原
// index.ts 9350-9686 双 case 含标签 337 行 + 9186-9333 构建器双定义 148
// 行）。**零控制流改写**：双 case 标签随体迁入 processIpcMemoryOwnerOps
// 自建 switch，嵌套 operation 子 switch 的 break 全部原义保留；构建器
// 由头局部闭包转显式参数 requireAgentBuilderActorImpl /
// requireOwnerProfileActorImpl（闭包局部量同名解构，体内逐字节不变），
// 壳层保留同名零参适配闭包供 builder-ops 注入（requireAgentBuilderActor），
// memory 双 case 体内 requireOwnerProfileActor() 调用经函数内同名适配
// 保持零改动。唯一文本改写：构建器与壳层共三处 registeredGroups 读改
// getRegisteredGroups() 活读（整体重赋值，4.2 同款留痕）。可直引依赖
// db/owner-profile-store/memory-service/workspace-memory-ipc/
// workspace-memory-capability/agent-builder-turn-auth/host-state/im-channel
// 自源模块 import（对 index.ts 零反向依赖已核）。

export interface IpcActorContextInput {
  /** processTaskIpc 解析出的 IPC 请求 JSON（结构类型同壳层，any 语义保留）。 */
  data: any;
  sourceGroup: string;
  sourceGroupEntry: RegisteredGroup | undefined;
  ipcAgentId: string | null;
  ipcTaskId: string | null;
  isHome?: boolean;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
}

export function requireAgentBuilderActorImpl(
  input: IpcActorContextInput,
): AgentBuilderActor {
  const {
    data,
    sourceGroup,
    sourceGroupEntry,
    ipcAgentId,
    ipcTaskId,
    getRegisteredGroups,
  } = input;
  const ownerId = sourceGroupEntry?.created_by;
  const user = ownerId ? getUserById(ownerId) : undefined;
  if (!user || user.status !== 'active') {
    throw new Error('No active user owns this workspace');
  }
  const sourceProfile = getAgentProfileForWorkspace(sourceGroup, user.id);
  const runtimeAgent = ipcAgentId ? getAgent(ipcAgentId) : undefined;
  const runtimeRejection = getAgentBuilderRuntimeRejection({
    isScheduledTask: data.isScheduledTask === true,
    isolatedTaskId: ipcTaskId,
    runtimeAgentId: ipcAgentId,
    runtimeAgentKind: runtimeAgent?.kind ?? null,
    runtimeAgentFolder: runtimeAgent?.group_folder ?? null,
    sourceFolder: sourceGroup,
    sourceProfileIsDefault: sourceProfile?.is_default === true,
  });
  if (runtimeRejection) throw new Error(runtimeRejection);

  const activeTurn = activeAgentBuilderTurns.requireOwnerHumanTurn(
    agentBuilderTurnScope(sourceGroup, ipcAgentId),
    getAgentBuilderInputMessage,
    (input) =>
      isAgentBuilderOwnerInput(
        input,
        user.id,
        (jid) => getRegisteredGroups()[jid] ?? getRegisteredGroup(jid),
      ),
  );
  return {
    user,
    sourceGroup,
    sourceChatJid: activeTurn.chatJid,
    sourceTurnId: activeTurn.messageId,
    sourceMessageContent: activeTurn.content,
  };
}

export function requireOwnerProfileActorImpl(input: IpcActorContextInput) {
  const {
    data,
    sourceGroup,
    sourceGroupEntry,
    ipcAgentId,
    ipcTaskId,
    isHome,
    getRegisteredGroups,
  } = input;
  const ownerId = sourceGroupEntry?.created_by;
  const user = ownerId ? getUserById(ownerId) : undefined;
  const runtimeAgent = ipcAgentId ? getAgent(ipcAgentId) : undefined;
  const sourceProfile = ownerId
    ? getAgentProfileForWorkspace(sourceGroup, ownerId)
    : undefined;
  if (
    isHome !== true ||
    !sourceGroupEntry?.is_home ||
    !user ||
    user.status !== 'active' ||
    sourceProfile?.is_default !== true ||
    ipcTaskId ||
    (ipcAgentId &&
      (runtimeAgent?.kind !== 'conversation' ||
        runtimeAgent.group_folder !== sourceGroup))
  ) {
    throw new OwnerProfileStoreError(
      'not_home_workspace',
      'Owner Profile is unavailable in this runtime',
    );
  }
  const resolveOwnerTurn =
    data.operation === 'get'
      ? activeAgentBuilderTurns.requireExactOwnerHumanTurn.bind(
          activeAgentBuilderTurns,
        )
      : activeAgentBuilderTurns.requireExactActiveOwnerHumanTurn.bind(
          activeAgentBuilderTurns,
        );
  // The owner's IM identity is anchored across Home registrations, not the
  // single source row: Home chats registered before owner capture (legacy
  // topic groups with a NULL owner_im_id) must still authorize the owner.
  const resolveHomeOwnerImIds = (provider: string): string[] => {
    const ids = new Set<string>();
    for (const jid of getJidsByFolder(sourceGroup)) {
      if (getChannelType(jid) !== provider) continue;
      const row = getRegisteredGroups()[jid] ?? getRegisteredGroup(jid);
      if (
        row?.created_by === user.id &&
        row.owner_im_id &&
        row.owner_claim_source &&
        OWNER_PROFILE_TRUSTED_CLAIM_SOURCES.includes(row.owner_claim_source)
      ) {
        ids.add(row.owner_im_id);
      }
    }
    return [...ids];
  };
  let activeTurn: ReturnType<typeof resolveOwnerTurn>;
  try {
    activeTurn = resolveOwnerTurn(
      agentBuilderTurnScope(sourceGroup, ipcAgentId),
      data.inputTurnId,
      getAgentBuilderInputMessage,
      (persistedInput) =>
        isOwnerProfileOwnerInput(
          persistedInput,
          user.id,
          (jid) => getRegisteredGroups()[jid] ?? getRegisteredGroup(jid),
          resolveHomeOwnerImIds,
        ),
    );
  } catch (error) {
    // Turn-authorization misses are expected policy outcomes (queued
    // non-owner turns, stale turn ids), not host faults.
    throw new OwnerProfileStoreError(
      'not_owner_turn',
      error instanceof Error
        ? error.message
        : 'Owner Profile requires an owner conversation turn',
    );
  }
  const workspaceJid = getJidsByFolder(sourceGroup).find((jid) =>
    jid.startsWith('web:'),
  );
  if (!workspaceJid) {
    throw new OwnerProfileStoreError(
      'not_home_workspace',
      'Owner Home Workspace is unavailable',
    );
  }
  const scope = {
    groupFolder: sourceGroup,
    agentId: ipcAgentId,
    taskRunId: ipcTaskId,
  };
  const isMutation = data.operation !== 'get';
  if (
    !verifyWorkspaceMemoryCapability(
      scope,
      data as Record<string, unknown>,
      data.mutationSignature,
      isMutation,
    )
  ) {
    throw new OwnerProfileStoreError(
      'lease_conflict',
      'Owner Profile runner capability is missing or invalid',
    );
  }
  const context: WorkspaceMemoryMutationContext = {
    actorId: user.id,
    sourceType: 'agent_runtime',
    sourceId: activeTurn.messageId,
    sessionId: getSession(sourceGroup, ipcAgentId ?? undefined) ?? null,
    observedAt: new Date().toISOString(),
  };
  return { user, workspaceJid, activeTurn, context };
}

export interface IpcMemoryOwnerOpsInput {
  /** processTaskIpc 解析出的 IPC 请求 JSON（结构类型同壳层，any 语义保留）。 */
  data: any;
  sourceGroup: string;
  sourceGroupEntry: RegisteredGroup | undefined;
  tasksDir: string;
  ipcAgentId: string | null;
  ipcTaskId: string | null;
  isHome: boolean;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  writeTaskResult: (
    tasksDir: string,
    type: string,
    requestId: string | undefined,
    payload: Record<string, unknown>,
  ) => void;
  SAFE_REQUEST_ID_RE: RegExp;
}

export async function processIpcMemoryOwnerOps(
  input: IpcMemoryOwnerOpsInput,
): Promise<void> {
  const {
    data,
    sourceGroup,
    sourceGroupEntry,
    tasksDir,
    ipcAgentId,
    ipcTaskId,
    isHome,
    getRegisteredGroups,
    writeTaskResult,
    SAFE_REQUEST_ID_RE,
  } = input;
  // 壳层适配闭包的模块内镜像：case 体内 requireOwnerProfileActor() 调用
  // 逐字节不变，构建器本体带显式参数。
  const requireOwnerProfileActor = () =>
    requireOwnerProfileActorImpl({
      data,
      sourceGroup,
      sourceGroupEntry,
      ipcAgentId,
      ipcTaskId,
      isHome,
      getRegisteredGroups,
    });
  switch (data.type) {
    case 'ckqclaw_owner_profile': {
      const finish = (payload: Record<string, unknown>): void =>
        writeTaskResult(
          tasksDir,
          'ckqclaw_owner_profile',
          data.requestId,
          payload,
        );
      try {
        if (!data.requestId || !SAFE_REQUEST_ID_RE.test(data.requestId)) {
          throw new Error('Invalid Owner Profile request ID');
        }
        const principal = requireOwnerProfileActor();
        if (
          (data.operation === 'get' || data.operation === 'skip') &&
          data.idempotencyKey !== undefined
        ) {
          throw new OwnerProfileStoreError(
            'idempotency_conflict',
            'Owner Profile get and skip do not accept idempotency keys',
          );
        }
        let result: Record<string, unknown>;
        switch (data.operation) {
          case 'get': {
            if (!data.runnerInstanceId) {
              throw new OwnerProfileStoreError(
                'lease_conflict',
                'Owner Profile runner identity is required',
              );
            }
            const claim = claimCkqclawOwnerIntroduction({
              workspaceJid: principal.workspaceJid,
              leaseOwner: data.runnerInstanceId,
            });
            const projection = claim.projection;
            const onboardingStatus = projection.preferredAddress
              ? 'known'
              : projection.onboarding.state === 'skipped'
                ? 'skipped'
                : projection.onboarding.state === 'completed'
                  ? 'cleared'
                  : claim.claimed
                    ? 'awaiting'
                    : 'unavailable';
            result = {
              projection,
              onboardingStatus,
              firstWake: claim.firstWake,
              leaseAcquired: claim.leaseAcquired,
            };
            break;
          }
          case 'ack_first_wake': {
            if (!data.runnerInstanceId) {
              throw new OwnerProfileStoreError(
                'lease_conflict',
                'Owner Profile runner identity is required',
              );
            }
            if (!Number.isInteger(data.leaseToken) || data.leaseToken! < 1) {
              throw new OwnerProfileStoreError(
                'lease_conflict',
                'Owner Profile lease token is required',
              );
            }
            result = acknowledgeCkqclawOwnerIntroduction({
              workspaceJid: principal.workspaceJid,
              leaseOwner: data.runnerInstanceId,
              leaseToken: data.leaseToken!,
            });
            break;
          }
          case 'set':
            result = setCkqclawOwnerPreferredAddress({
              workspaceJid: principal.workspaceJid,
              preferredAddress: data.preferredAddress ?? '',
              expectedRevision: data.expectedRevision,
              idempotencyKey: data.idempotencyKey,
              context: principal.context,
            });
            break;
          case 'clear':
            if (!Number.isInteger(data.expectedRevision)) {
              throw new OwnerProfileStoreError(
                'revision_conflict',
                'expectedRevision is required to clear the Owner Profile',
              );
            }
            result = clearCkqclawOwnerPreferredAddress({
              workspaceJid: principal.workspaceJid,
              expectedRevision: data.expectedRevision!,
              idempotencyKey: data.idempotencyKey,
              context: principal.context,
            });
            break;
          case 'skip':
            result = skipCkqclawOwnerIntroduction({
              workspaceJid: principal.workspaceJid,
              expectedOnboardingRevision: data.expectedOnboardingRevision,
              context: principal.context,
            });
            break;
          default:
            throw new Error('Unknown Owner Profile operation');
        }
        finish({ success: true, ...result });
      } catch (error) {
        const code =
          error instanceof OwnerProfileStoreError
            ? error.code
            : 'internal_error';
        finish({
          success: false,
          code,
          error:
            error instanceof OwnerProfileStoreError
              ? error.message
              : 'Internal error while processing Owner Profile request.',
          ...(error instanceof OwnerProfileStoreError && error.details
            ? { details: error.details }
            : {}),
        });
        logger.warn(
          {
            sourceGroup,
            operation: data.operation,
            code,
            error: error instanceof Error ? error.message : String(error),
          },
          'CKQClaw Owner Profile IPC request failed',
        );
      }
      break;
    }

    case 'workspace_memory': {
      const finish = (payload: Record<string, unknown>): void =>
        writeTaskResult(tasksDir, 'workspace_memory', data.requestId, payload);
      try {
        if (!data.requestId || !SAFE_REQUEST_ID_RE.test(data.requestId)) {
          throw new Error('Invalid Workspace Memory request ID');
        }
        const ownerId = sourceGroupEntry?.created_by;
        const actor = ownerId ? getUserById(ownerId) : undefined;
        if (!actor || actor.status !== 'active') {
          throw new WorkspaceMemoryServiceError(
            'not_found',
            'Workspace memory not found',
          );
        }
        // Folder IPC is shared by Web and bound IM sessions. Resolve the
        // canonical registered Web workspace; never trust a model-supplied JID.
        const siblingJids = getJidsByFolder(sourceGroup);
        const workspaceJid =
          siblingJids.find((jid) => jid.startsWith('web:')) ?? siblingJids[0];
        if (!workspaceJid) {
          throw new WorkspaceMemoryServiceError(
            'not_found',
            'Workspace memory not found',
          );
        }
        const base = {
          actor: { id: actor.id },
          workspaceJid,
        };
        const hostTurnKind = ipcTaskId
          ? ('scheduled' as const)
          : activeAgentBuilderTurns.classifyActiveTurn(
              agentBuilderTurnScope(sourceGroup, ipcAgentId),
              data.inputTurnId,
              getAgentBuilderInputMessage,
            );
        const runtimeAgentKind = ipcAgentId
          ? (getAgent(ipcAgentId)?.kind ?? null)
          : null;
        const sourceType =
          hostTurnKind === 'scheduled'
            ? ('scheduled_task' as const)
            : ('agent_runtime' as const);
        const mutation = {
          sourceType,
          provenance: {
            // Correlation fields are non-authoritative provenance only. Actor,
            // workspace, and source type are host-derived above.
            sourceId: data.inputTurnId ?? null,
            sessionId: data.sessionId ?? null,
            observedAt: new Date().toISOString(),
          },
        };
        const mutationOperation =
          data.operation === 'create' ||
          data.operation === 'update' ||
          data.operation === 'delete';
        const capabilityValid =
          mutationOperation &&
          (!ipcAgentId || runtimeAgentKind === 'conversation') &&
          hostTurnKind === 'interactive' &&
          verifyAndConsumeWorkspaceMemoryMutation(
            {
              groupFolder: sourceGroup,
              agentId: ipcAgentId,
              taskRunId: ipcTaskId,
            },
            data as Record<string, unknown>,
            data.mutationSignature,
          );
        const writeRejection = workspaceMemoryWriteRejection({
          operation: data.operation,
          hostTurnKind,
          runtimeAgentId: ipcAgentId,
          runtimeAgentKind,
          capabilityValid,
        });
        if (writeRejection) {
          finish({
            success: false,
            ...writeRejection,
          });
          break;
        }

        let result: Record<string, unknown>;
        switch (data.operation) {
          case 'snapshot': {
            const snapshot = getWorkspaceMemorySnapshot({
              ...base,
              query: data.query,
              kind: data.kind as
                | 'fact'
                | 'decision'
                | 'lesson'
                | 'open_loop'
                | undefined,
              limit: data.limit,
              maxChars: data.maxChars,
            });
            result = { snapshot };
            logger.info(
              {
                sourceGroup,
                workspaceJid,
                storeRevision: snapshot.storeRevision,
                retrievalTrace: snapshot.retrievalTrace,
              },
              'Workspace Memory snapshot retrieved for runtime turn',
            );
            break;
          }
          case 'search':
            result = searchWorkspaceMemory({
              ...base,
              query: data.query ?? '',
              kind: data.kind as
                | 'fact'
                | 'decision'
                | 'lesson'
                | 'open_loop'
                | undefined,
              limit: data.limit,
            });
            break;
          case 'get':
            result = getWorkspaceMemory({
              ...base,
              itemId: data.itemId ?? '',
            });
            break;
          case 'create':
            result = createWorkspaceMemory({
              ...base,
              ...mutation,
              kind: data.kind as 'fact' | 'decision' | 'lesson' | 'open_loop',
              title: data.title,
              content: data.content ?? '',
              canonicalKey: data.canonicalKey,
              importance: data.importance,
              confidence: data.confidence,
              validFrom: data.validFrom,
              validUntil: data.validUntil,
              expiresAt: data.expiresAt,
              idempotencyKey: data.idempotencyKey,
            });
            break;
          case 'update': {
            result = updateWorkspaceMemory(
              buildWorkspaceMemoryUpdateInput(data, {
                ...base,
                ...mutation,
              }) as unknown as Parameters<typeof updateWorkspaceMemory>[0],
            );
            break;
          }
          case 'delete':
            result = forgetWorkspaceMemory({
              ...base,
              ...mutation,
              itemId: data.itemId ?? '',
              expectedRevision: data.expectedRevision ?? 0,
              idempotencyKey: data.idempotencyKey,
            });
            break;
          default:
            throw new WorkspaceMemoryServiceError(
              'invalid_request',
              'Unknown Workspace Memory operation',
            );
        }
        finish({ success: true, ...result });
      } catch (error) {
        const code =
          error instanceof WorkspaceMemoryServiceError
            ? error.code
            : 'internal_error';
        finish({
          success: false,
          code,
          error:
            error instanceof WorkspaceMemoryServiceError
              ? error.message
              : 'Internal error while processing Workspace Memory request.',
          ...(error instanceof WorkspaceMemoryServiceError && error.details
            ? { details: error.details }
            : {}),
        });
        logger.warn(
          {
            sourceGroup,
            operation: data.operation,
            code,
            error: error instanceof Error ? error.message : String(error),
          },
          'Workspace Memory IPC request failed',
        );
      }
      break;
    }
  }
}
