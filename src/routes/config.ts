// Configuration management routes

import { zodBadRequest } from '../validation-response.js';
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { avatarUploadBodyLimit } from '../http-upload-policy.js';
import { reapAvatarFiles, storeAvatarUpload } from '../avatar-upload.js';
import type { Variables } from '../web-context.js';
import {
  canAccessGroup,
  canModifyGroup,
  groupAccessDeniedResponse,
} from '../web-context.js';
import { getChannelType } from '../im-channel.js';
import {
  getRegisteredGroup,
  getAllRegisteredGroups,
  forceActiveAdminRuntimesToHost,
  getAgent,
  getAgentProfileForWorkspace,
  getUserById,
  deleteWorkspaceSessions,
  deleteSessionsByProviderIdAroundCommit,
  getSession,
  getRouterState,
  getRouterStateByPrefix,
  setRouterState,
  deleteRouterState,
  isDatabaseInitialized,
  VALID_ACTIVATION_MODES,
  countAgentProfilesByModelConfigId,
} from '../db.js';
import { isMentionActivationMode } from '../feishu-conversation-policy.js';
import { normalizeLegacyOwnerMention } from '../im-audience-policy.js';
import { conversationBindingPolicyError } from '../channel-conversation-kind.js';
import { adminRoleMiddleware, authMiddleware } from '../middleware/auth.js';
import {
  AppearanceConfigSchema,
  HostIntegrationSettingsSchema,
  SystemSettingsSchema,
  UnifiedProviderCreateSchema,
  UnifiedProviderPatchSchema,
  UnifiedProviderSecretsSchema,
  BalancingConfigSchema,
} from '../schemas.js';
import {
  appendClaudeConfigAudit,
  getProviders,
  getEnabledProviders,
  getDefaultProviderId,
  setDefaultProvider,
  getBalancingConfig,
  saveBalancingConfig,
  createProvider,
  updateProvider,
  updateProviderSecrets,
  setProviderEnabled,
  deleteProvider,
  toPublicProvider,
  getAppearanceConfig,
  saveAppearanceConfig,
  getSystemSettings,
  getEffectiveExternalDir,
  getContainerEnvConfig,
  saveSystemSettings,
} from '../runtime-config.js';
import type { AudienceMode, AuthUser, RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import {
  buildSessionMountUpdate,
  buildWorkspaceMountUpdate,
  commitChannelMountUpdate,
  detachThreadMapWorkspaceIfLast,
  fetchLiveChatInfo,
  getConversationKind,
  hasConsistentChannelAccount,
  hasSessionMountConflict,
  hasWorkspaceMountConflict,
  isNativeContextContainer,
  markNativeContextWorkspace,
  refreshAgentLastImJid,
  restoreDefaultChannelMount,
  type ChannelChatInfo,
} from '../channel-mount-service.js';
import { providerPool } from '../provider-pool.js';
import {
  getWorkspaceRuntimeJids,
  quiesceWorkspaceRunnersAroundCommit,
  resolveEffectiveAgentProfile,
  withAgentProfileLocks,
  WorkspaceRuntimeQuiesceError,
} from '../agent-profile-runtime.js';
import { notifyTaskSchedulerChanged } from '../task-scheduler.js';
import {
  SYSTEM_CAPABILITY_LOCK_KEY,
  withCapabilityScopeLocks,
} from '../capability-lock.js';
import {
  ADMIN_HOST_ONLY_RUNTIME_SAFETY_SOURCE,
  clearAdminHostOnlyCleanupPending,
  getPendingAdminHostOnlyCleanupFolders,
  markAdminHostOnlyCleanupPending,
  restorePendingAdminHostOnlyRuntimeSafetyBlocks,
} from '../admin-host-only-runtime.js';
const configRoutes = new Hono<{ Variables: Variables }>();

// Inject deps at runtime
let deps: any = null;
export function injectConfigDeps(d: any) {
  deps = d;
  restorePendingProviderRuntimeSafetyBlocks();
  restorePendingAdminHostOnlyRuntimeSafetyBlocks(d);
}

interface ClaudeApplyResultPayload {
  success: boolean;
  stoppedCount: number;
  failedCount: number;
  clearedSessionsCount?: number;
  /** Whether the config mutation itself was durably written. */
  persisted?: boolean;
  phase?: 'pre_commit' | 'post_commit';
  error?: string;
}

interface ApplyOptions {
  /**
   * If set, drop only sticky session bindings that point to this provider —
   * preserves bindings to unrelated providers. Used when a provider's
   * protocol-level fields (anthropicBaseUrl / anthropicModel) change.
   */
  clearSessionsForProviderId?: string;
  sessionInvalidation?: {
    modelChanged: boolean;
    baseUrlChanged: boolean;
  };
}

interface PendingProviderSessionInvalidation {
  providerId: string;
  modelChanged: boolean;
  baseUrlChanged: boolean;
}

const PROVIDER_INVALIDATION_STATE_PREFIX =
  'provider_session_invalidation_pending:';
const PROVIDER_RUNTIME_SAFETY_SOURCE = 'provider-config-mutation';
const volatilePendingProviderSessionInvalidations = new Map<
  string,
  PendingProviderSessionInvalidation
>();

function providerInvalidationStateKey(providerId: string): string {
  return `${PROVIDER_INVALIDATION_STATE_PREFIX}${providerId}`;
}

function getPendingProviderSessionInvalidation(
  providerId: string,
): PendingProviderSessionInvalidation | undefined {
  const raw = getRouterState(providerInvalidationStateKey(providerId));
  const volatile = volatilePendingProviderSessionInvalidations.get(providerId);
  let durable: PendingProviderSessionInvalidation | undefined;
  if (raw) {
    try {
      const parsed = JSON.parse(
        raw,
      ) as Partial<PendingProviderSessionInvalidation>;
      if (parsed.providerId === providerId) {
        durable = {
          providerId,
          modelChanged: parsed.modelChanged === true,
          baseUrlChanged: parsed.baseUrlChanged === true,
        };
      } else {
        durable = {
          providerId,
          modelChanged: true,
          baseUrlChanged: true,
        };
      }
    } catch {
      // A corrupt marker must remain repairable rather than becoming a
      // permanent global gate. Conservatively replay both invalidations when
      // this provider is next PATCHed.
      durable = {
        providerId,
        modelChanged: true,
        baseUrlChanged: true,
      };
    }
  }
  if (!durable) return volatile;
  if (!volatile) return durable;
  return {
    providerId,
    modelChanged: durable.modelChanged || volatile.modelChanged,
    baseUrlChanged: durable.baseUrlChanged || volatile.baseUrlChanged,
  };
}

function setPendingProviderSessionInvalidation(
  pending: PendingProviderSessionInvalidation,
): void {
  const previous = getPendingProviderSessionInvalidation(pending.providerId);
  const merged = {
    providerId: pending.providerId,
    modelChanged: pending.modelChanged || previous?.modelChanged === true,
    baseUrlChanged: pending.baseUrlChanged || previous?.baseUrlChanged === true,
  };
  // Keep an in-process repair path even if durable state persistence fails.
  volatilePendingProviderSessionInvalidations.set(pending.providerId, merged);
  setRouterState(
    providerInvalidationStateKey(pending.providerId),
    JSON.stringify(merged),
  );
}

function clearPendingProviderSessionInvalidation(providerId: string): void {
  deleteRouterState(providerInvalidationStateKey(providerId));
  volatilePendingProviderSessionInvalidations.delete(providerId);
}

function hasPendingProviderSessionInvalidations(): boolean {
  return (
    volatilePendingProviderSessionInvalidations.size > 0 ||
    getRouterStateByPrefix(PROVIDER_INVALIDATION_STATE_PREFIX).length > 0
  );
}

/**
 * Runtime-safety blocks live in memory, while incomplete provider session
 * invalidations are durable. Rebuild the gate when web dependencies are
 * injected after a process restart so no stale session can resume before an
 * exact provider PATCH repairs the pending cleanup.
 */
function restorePendingProviderRuntimeSafetyBlocks(): void {
  if (!deps || !isDatabaseInitialized()) return;
  const durableRows = getRouterStateByPrefix(
    PROVIDER_INVALIDATION_STATE_PREFIX,
  );
  const configuredProviderIds = new Set(
    getProviders().map((provider) => provider.id),
  );
  const pendingProviderIds = new Set([
    ...durableRows.map((row) =>
      row.key.slice(PROVIDER_INVALIDATION_STATE_PREFIX.length),
    ),
    ...volatilePendingProviderSessionInvalidations.keys(),
  ]);
  for (const providerId of pendingProviderIds) {
    if (providerId && configuredProviderIds.has(providerId)) continue;
    if (providerId) {
      const cleanup = deleteSessionsByProviderIdAroundCommit(
        providerId,
        undefined,
        () => undefined,
      );
      syncProviderSessionCaches(cleanup.affectedFolders);
    }
    deleteRouterState(providerInvalidationStateKey(providerId));
    volatilePendingProviderSessionInvalidations.delete(providerId);
    pendingProviderIds.delete(providerId);
    logger.warn(
      { providerId },
      'Removed orphaned provider session invalidation marker during startup',
    );
  }
  if (pendingProviderIds.size === 0) return;
  const runtimeJids = Array.from(
    new Set(
      getClaudeRuntimeTargets().flatMap((target) =>
        getWorkspaceRuntimeJids(deps, target.folder, target.primaryJid),
      ),
    ),
  );
  deps.queue.blockGroupsForRuntimeSafety(
    runtimeJids,
    `provider session invalidation pending after restart: ${pendingProviderIds.size}`,
    PROVIDER_RUNTIME_SAFETY_SOURCE,
  );
}

interface ClaudeMutationResult<T> {
  value?: T;
  applied: ClaudeApplyResultPayload;
}

function appendClaudeConfigAuditBestEffort(
  actor: string,
  action: string,
  changedFields: string[],
  metadata?: Record<string, unknown>,
): void {
  try {
    appendClaudeConfigAudit(actor, action, changedFields, metadata);
  } catch (error) {
    logger.error(
      { error, actor, action },
      'Provider configuration audit append failed after persistence',
    );
  }
}

let claudeConfigMutationTail: Promise<void> = Promise.resolve();

async function withClaudeConfigMutationLock<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const previous = claudeConfigMutationTail;
  let release!: () => void;
  claudeConfigMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function hasWorkspaceProviderOverride(
  folder: string,
  invalidation?: ApplyOptions['sessionInvalidation'],
): boolean {
  if (!invalidation) return false;
  const override = getContainerEnvConfig(folder);
  // Shadowing is field-specific. Credentials do not protect a workspace from
  // inheriting a changed global model or Base URL, and when both fields change
  // the workspace must override both before its legacy NULL-bound session is
  // safe to preserve.
  const modelChangeIsShadowed =
    !invalidation.modelChanged || !!override.anthropicModel;
  const baseUrlChangeIsShadowed =
    !invalidation.baseUrlChanged || !!override.anthropicBaseUrl;
  return modelChangeIsShadowed && baseUrlChangeIsShadowed;
}

function getSafeLegacyUnboundFolders(
  providerId: string,
  invalidation?: ApplyOptions['sessionInvalidation'],
): string[] {
  if (!deps) return [];
  const configuredProviders = getProviders();
  if (
    configuredProviders.length !== 1 ||
    configuredProviders[0]?.id !== providerId
  ) {
    return [];
  }
  return Array.from(
    new Set(
      Object.values(
        deps.getRegisteredGroups() as Record<string, RegisteredGroup>,
      )
        .map((group) => group.folder)
        .filter(
          (folder) => !hasWorkspaceProviderOverride(folder, invalidation),
        ),
    ),
  );
}

function getProviderSessionCleanupOptions(
  providerId: string,
  invalidation?: ApplyOptions['sessionInvalidation'],
): { includeUnboundFolders: string[] } {
  return {
    includeUnboundFolders: getSafeLegacyUnboundFolders(
      providerId,
      invalidation,
    ),
  };
}

function syncProviderSessionCaches(affectedFolders: string[]): void {
  if (!deps) return;
  for (const folder of affectedFolders) {
    const remainingMainSession = getSession(folder);
    if (remainingMainSession !== undefined) {
      deps.sessions[folder] = remainingMainSession;
    } else {
      delete deps.sessions[folder];
    }
  }
}

function commitProviderConfigWithSessionInvalidation<T>(
  providerId: string,
  invalidation: ApplyOptions['sessionInvalidation'],
  commit: () => T,
): { value: T; clearedSessionsCount: number } {
  const result = deleteSessionsByProviderIdAroundCommit(
    providerId,
    getProviderSessionCleanupOptions(providerId, invalidation),
    commit,
  );
  syncProviderSessionCaches(result.affectedFolders);
  return { value: result.value, clearedSessionsCount: result.deletedCount };
}

function getClaudeRuntimeTargets(): Array<{
  folder: string;
  primaryJid: string;
}> {
  if (!deps) return [];
  const targets = new Map<string, { folder: string; primaryJid: string }>();
  for (const [jid, group] of Object.entries(
    deps.getRegisteredGroups() as Record<string, RegisteredGroup>,
  )) {
    if (!targets.has(group.folder)) {
      targets.set(group.folder, { folder: group.folder, primaryJid: jid });
    }
  }
  return [...targets.values()];
}

function getKnownClaudeRuntimeJids(): string[] {
  if (!deps) return [];
  return Array.from(
    new Set(
      getClaudeRuntimeTargets().flatMap((target) =>
        getWorkspaceRuntimeJids(deps, target.folder, target.primaryJid),
      ),
    ),
  );
}

async function mutateClaudeConfigForAllGroups<T>(
  actor: string,
  metadata: Record<string, unknown> | undefined,
  commit: () => T,
  options?: ApplyOptions,
): Promise<ClaudeMutationResult<T>> {
  if (!deps) throw new Error('Server not initialized');

  const targets = getClaudeRuntimeTargets();
  const reason = String(metadata?.trigger ?? 'claude_config_apply');
  try {
    const result = await quiesceWorkspaceRunnersAroundCommit(
      deps,
      targets,
      {
        reason,
        onPostCommitFailure: (runtimeJids) => {
          // Establish the in-memory fail-closed gate before any durable marker
          // I/O. Focused test fixtures may omit the optional method, while the
          // production WebDeps queue is a concrete GroupQueue that implements
          // it and startup restoration below requires it when pending exists.
          deps.queue.blockGroupsForRuntimeSafety?.(
            runtimeJids,
            `${reason}: post-commit provider runtime cleanup failed`,
            PROVIDER_RUNTIME_SAFETY_SOURCE,
          );
          if (
            options?.clearSessionsForProviderId &&
            options.sessionInvalidation
          ) {
            try {
              setPendingProviderSessionInvalidation({
                providerId: options.clearSessionsForProviderId,
                ...options.sessionInvalidation,
              });
            } catch (error) {
              // The volatile marker was set before SQLite persistence, so an
              // exact retry in this process can still repair and unblock.
              logger.error(
                { error, providerId: options.clearSessionsForProviderId },
                'Failed to persist pending provider session invalidation',
              );
            }
          }
        },
      },
      async () => {
        let value: T;
        let clearedSessionsCount: number | undefined;
        if (options?.clearSessionsForProviderId) {
          const committed = commitProviderConfigWithSessionInvalidation(
            options.clearSessionsForProviderId,
            options.sessionInvalidation,
            commit,
          );
          value = committed.value;
          clearedSessionsCount = committed.clearedSessionsCount;
        } else {
          value = commit();
        }
        return { value, clearedSessionsCount };
      },
    );
    // A successful retry proves every runtime now observes the persisted
    // provider config, so it may repair a fail-closed gate left by an earlier
    // post-commit teardown failure.
    if (options?.clearSessionsForProviderId) {
      clearPendingProviderSessionInvalidation(
        options.clearSessionsForProviderId,
      );
    }
    if (!hasPendingProviderSessionInvalidations()) {
      deps.queue.unblockGroupsForRuntimeSafety?.(
        result.runtimeJids,
        PROVIDER_RUNTIME_SAFETY_SOURCE,
      );
    }
    const applied: ClaudeApplyResultPayload = {
      success: true,
      stoppedCount: result.runtimeJids.length,
      failedCount: 0,
      persisted: true,
      ...(result.value.clearedSessionsCount !== undefined
        ? { clearedSessionsCount: result.value.clearedSessionsCount }
        : {}),
    };
    appendClaudeConfigAuditBestEffort(
      actor,
      'apply_to_all_flows',
      ['queue.stopGroup'],
      {
        ...applied,
        ...(metadata || {}),
      },
    );
    return { value: result.value.value, applied };
  } catch (err) {
    if (!(err instanceof WorkspaceRuntimeQuiesceError)) throw err;
    const committed = err.committedValue as
      | { value: T; clearedSessionsCount?: number }
      | undefined;
    const persisted = err.persisted;
    const applied: ClaudeApplyResultPayload = {
      success: false,
      stoppedCount: 0,
      failedCount: err.failures.length,
      persisted,
      phase: err.phase,
      ...(committed?.clearedSessionsCount !== undefined
        ? { clearedSessionsCount: committed.clearedSessionsCount }
        : {}),
      error: persisted
        ? 'Configuration was saved, but one or more runtimes failed to restart safely'
        : 'Configuration was not updated because one or more runtimes failed to stop safely',
    };
    appendClaudeConfigAuditBestEffort(
      actor,
      'apply_to_all_flows',
      ['queue.stopGroup'],
      { ...applied, ...(metadata || {}) },
    );
    return { value: committed?.value, applied };
  }
}

async function applyClaudeConfigToAllGroups(
  actor: string,
  metadata?: Record<string, unknown>,
  options?: ApplyOptions,
): Promise<ClaudeApplyResultPayload> {
  const result = await mutateClaudeConfigForAllGroups(
    actor,
    metadata,
    () => undefined,
    options,
  );
  return result.applied;
}

// --- Routes ---

// ─── GET /claude/providers — 列出所有供应商 + 健康 + 负载均衡配置 ─────
configRoutes.get(
  '/claude/providers',
  authMiddleware,
  adminRoleMiddleware,
  (c) => {
    try {
      const providers = getProviders();
      const balancing = getBalancingConfig();
      const enabledProviders = getEnabledProviders();

      // Refresh pool state for health info
      providerPool.refreshFromConfig(enabledProviders, balancing);
      const healthStatuses = providerPool.getHealthStatuses();

      return c.json({
        providers: providers.map((p) => ({
          ...toPublicProvider(p),
          health: healthStatuses.find((h) => h.profileId === p.id) || null,
        })),
        balancing,
        enabledCount: enabledProviders.length,
        defaultProviderId: getDefaultProviderId(),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to list providers');
      return c.json({ error: 'Failed to list providers' }, 500);
    }
  },
);

// ─── PUT /claude/default — 设置所有继承型 Agent 使用的默认模型配置 ─────
configRoutes.put(
  '/claude/default',
  authMiddleware,
  adminRoleMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const providerId =
      typeof body.providerId === 'string' ? body.providerId.trim() : '';
    if (!providerId) {
      return c.json({ error: 'providerId (string) is required' }, 400);
    }
    const actor = (c.get('user') as AuthUser).username;

    try {
      return await withClaudeConfigMutationLock(async () => {
        const previousProviderId = getDefaultProviderId();
        if (previousProviderId === providerId) {
          const provider = getProviders().find(
            (item) => item.id === providerId,
          );
          if (!provider) throw new Error('未找到指定模型配置');
          return c.json({
            provider: toPublicProvider(provider),
            defaultProviderId: provider.id,
            applied: {
              success: true,
              stoppedCount: 0,
              failedCount: 0,
              persisted: true,
            },
          });
        }
        const mutation = await mutateClaudeConfigForAllGroups(
          actor,
          {
            trigger: 'default_model_update',
            previousProviderId,
            providerId,
          },
          () => {
            const provider = setDefaultProvider(providerId);
            appendClaudeConfigAuditBestEffort(actor, 'set_default_model', [
              `id:${provider.id}`,
            ]);
            return provider;
          },
        );
        if (!mutation.applied.success) {
          return c.json(
            {
              error: mutation.applied.error,
              applied: mutation.applied,
              ...(mutation.value
                ? { provider: toPublicProvider(mutation.value) }
                : {}),
            },
            503,
          );
        }
        return c.json({
          provider: toPublicProvider(mutation.value!),
          defaultProviderId: mutation.value!.id,
          applied: mutation.applied,
        });
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to set default model';
      logger.warn({ err, providerId }, 'Failed to set default model');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── POST /claude/providers — 创建供应商 ─────
configRoutes.post(
  '/claude/providers',
  authMiddleware,
  adminRoleMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = UnifiedProviderCreateSchema.safeParse(body);
    if (!validation.success) {
      return zodBadRequest(c, validation.error, 'body-format');
    }

    const actor = (c.get('user') as AuthUser).username;

    try {
      const provider = createProvider(validation.data);
      appendClaudeConfigAudit(actor, 'create_provider', [
        `id:${provider.id}`,
        `type:${provider.type}`,
        `name:${provider.name}`,
      ]);
      return c.json(toPublicProvider(provider), 201);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to create provider';
      logger.warn({ err }, 'Failed to create provider');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── PATCH /claude/providers/:id — 更新供应商非密钥字段 ─────
configRoutes.patch(
  '/claude/providers/:id',
  authMiddleware,
  adminRoleMiddleware,
  async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const validation = UnifiedProviderPatchSchema.safeParse(body);
    if (!validation.success) {
      return zodBadRequest(c, validation.error, 'body-format');
    }

    const actor = (c.get('user') as AuthUser).username;

    try {
      return await withClaudeConfigMutationLock(async () => {
        const previous = getProviders().find((p) => p.id === id);
        if (!previous) throw new Error('未找到指定供应商');
        // THESIS-02：接口只剩第三方路径，合并态校验对所有供应商无条件生效
        // （不再按 previous.type 放行官方 Bearer 场景）。create 口由
        // UnifiedProviderCreateSchema.superRefine 拦截；PATCH 是部分更新，
        // 必须按合并后的最终状态校验——UnifiedProviderPatchSchema 不携带
        // type 与密钥字段，故 authToken 只能来自现有 provider，而 baseUrl
        // 可能被 payload 显式置空或改写（ProviderBaseUrlSchema 允许空串）。
        const mergedBaseUrl =
          validation.data.anthropicBaseUrl !== undefined
            ? validation.data.anthropicBaseUrl.trim()
            : previous.anthropicBaseUrl;
        if (!!previous.anthropicAuthToken.trim() && !mergedBaseUrl.trim()) {
          throw new Error('第三方供应商使用 Auth Token 时必须配置 Base URL');
        }
        // ISSUE-16 C1（用户拍板补校验）：无 token 的供应商不得被 PATCH
        // 清空 Base URL 而进入「Base URL 与 Auth Token 双空」——create 口的
        // 「至少填一项」规则。只拦进入双空的写入；存量双空脏数据编辑其他
        // 字段不受影响。
        if (
          !previous.anthropicAuthToken.trim() &&
          !!previous.anthropicBaseUrl.trim() &&
          !mergedBaseUrl.trim()
        ) {
          throw new Error('第三方供应商需要提供 Base URL 或 Auth Token');
        }
        const changedFields = Object.keys(validation.data).map(
          (k) => `${k}:updated`,
        );
        const baseUrlChanged = !!(
          validation.data.anthropicBaseUrl !== undefined &&
          validation.data.anthropicBaseUrl !== previous.anthropicBaseUrl
        );
        const modelChanged = !!(
          validation.data.anthropicModel !== undefined &&
          validation.data.anthropicModel !== previous.anthropicModel
        );
        const customEnvChanged = !!(
          validation.data.customEnv !== undefined &&
          JSON.stringify(validation.data.customEnv) !==
            JSON.stringify(previous.customEnv)
        );
        const protocolFieldChanged =
          baseUrlChanged || modelChanged || customEnvChanged;
        const pendingInvalidation = getPendingProviderSessionInvalidation(id);
        const sessionInvalidation = {
          modelChanged:
            modelChanged || pendingInvalidation?.modelChanged === true,
          baseUrlChanged:
            baseUrlChanged || pendingInvalidation?.baseUrlChanged === true,
        };
        const shouldClearSessions =
          !!pendingInvalidation || protocolFieldChanged;
        const metadata = {
          trigger: 'provider_update',
          providerId: id,
          protocolFieldChanged,
          baseUrlChanged,
          modelChanged,
          customEnvChanged,
        };
        const commit = () => {
          const updated = updateProvider(id, validation.data);
          appendClaudeConfigAuditBestEffort(actor, 'update_provider', [
            `id:${id}`,
            ...changedFields,
            ...(protocolFieldChanged ? ['protocolFieldChanged'] : []),
          ]);
          return updated;
        };

        let mutation: ClaudeMutationResult<ReturnType<typeof updateProvider>>;
        if (previous.enabled) {
          mutation = await mutateClaudeConfigForAllGroups(
            actor,
            metadata,
            commit,
            shouldClearSessions
              ? {
                  clearSessionsForProviderId: id,
                  sessionInvalidation,
                }
              : undefined,
          );
        } else {
          const committed = shouldClearSessions
            ? commitProviderConfigWithSessionInvalidation(
                id,
                sessionInvalidation,
                commit,
              )
            : { value: commit(), clearedSessionsCount: undefined };
          const updated = committed.value;
          const clearedSessionsCount = committed.clearedSessionsCount;
          if (shouldClearSessions) {
            clearPendingProviderSessionInvalidation(id);
            if (!hasPendingProviderSessionInvalidations()) {
              deps?.queue?.unblockGroupsForRuntimeSafety?.(
                getKnownClaudeRuntimeJids(),
                PROVIDER_RUNTIME_SAFETY_SOURCE,
              );
            }
          }
          mutation = {
            value: updated,
            applied: {
              success: true,
              stoppedCount: 0,
              failedCount: 0,
              persisted: true,
              ...(clearedSessionsCount !== undefined
                ? { clearedSessionsCount }
                : {}),
            },
          };
        }

        if (!mutation.applied.success) {
          return c.json(
            {
              error: mutation.applied.error,
              applied: mutation.applied,
              ...(mutation.value
                ? { provider: toPublicProvider(mutation.value) }
                : {}),
            },
            503,
          );
        }
        return c.json({
          provider: toPublicProvider(mutation.value!),
          applied: mutation.applied,
        });
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to update provider';
      logger.warn({ err }, 'Failed to update provider');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── PUT /claude/providers/:id/secrets — 更新密钥 ─────
configRoutes.put(
  '/claude/providers/:id/secrets',
  authMiddleware,
  adminRoleMiddleware,
  async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const validation = UnifiedProviderSecretsSchema.safeParse(body);
    if (!validation.success) {
      return zodBadRequest(c, validation.error, 'body-format');
    }

    const actor = (c.get('user') as AuthUser).username;

    try {
      return await withClaudeConfigMutationLock(async () => {
        const previous = getProviders().find((provider) => provider.id === id);
        if (!previous) throw new Error('未找到指定供应商');
        // THESIS-02：secrets 口同样对所有供应商无条件校验合并态，不再
        // 为官方 Bearer 场景放行。secrets 口只改密钥，按现有 provider
        // 状态 + 新 token 判断。
        const incomingAuthToken =
          typeof validation.data.anthropicAuthToken === 'string'
            ? validation.data.anthropicAuthToken.trim()
            : '';
        if (!!incomingAuthToken && !previous.anthropicBaseUrl.trim()) {
          throw new Error('第三方供应商使用 Auth Token 时必须配置 Base URL');
        }
        // ISSUE-16 C1（用户拍板补校验）：secrets 口清空 token 不得让无 Base
        // URL 的供应商进入「双空」（create 口「至少填一项」规则）；
        // 只拦进入双空的写入，存量双空数据不受影响。
        const mergedAuthToken =
          validation.data.anthropicAuthToken !== undefined
            ? incomingAuthToken
            : validation.data.clearAnthropicAuthToken
              ? ''
              : previous.anthropicAuthToken.trim();
        if (
          !previous.anthropicBaseUrl.trim() &&
          !!previous.anthropicAuthToken.trim() &&
          !mergedAuthToken
        ) {
          throw new Error('第三方供应商需要提供 Base URL 或 Auth Token');
        }
        const changedFields: string[] = [];
        if (validation.data.anthropicAuthToken !== undefined)
          changedFields.push('anthropicAuthToken:set');
        if (validation.data.clearAnthropicAuthToken)
          changedFields.push('anthropicAuthToken:clear');
        if (validation.data.anthropicApiKey !== undefined)
          changedFields.push('anthropicApiKey:set');
        if (validation.data.clearAnthropicApiKey)
          changedFields.push('anthropicApiKey:clear');

        const commit = () => {
          const updated = updateProviderSecrets(id, validation.data);
          appendClaudeConfigAuditBestEffort(actor, 'update_provider_secrets', [
            `id:${id}`,
            ...changedFields,
          ]);
          return updated;
        };

        const mutation = previous.enabled
          ? await mutateClaudeConfigForAllGroups(
              actor,
              {
                trigger: 'provider_secrets_update',
                providerId: id,
              },
              commit,
              {
                clearSessionsForProviderId: id,
                sessionInvalidation: {
                  modelChanged: true,
                  baseUrlChanged: true,
                },
              },
            )
          : {
              value: commit(),
              applied: {
                success: true,
                stoppedCount: 0,
                failedCount: 0,
                persisted: true,
              } satisfies ClaudeApplyResultPayload,
            };

        if (!mutation.applied.success) {
          return c.json(
            {
              error: mutation.applied.error,
              applied: mutation.applied,
              ...(mutation.value
                ? { provider: toPublicProvider(mutation.value) }
                : {}),
            },
            503,
          );
        }
        return c.json({
          provider: toPublicProvider(mutation.value!),
          applied: mutation.applied,
        });
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to update secrets';
      logger.warn({ err }, 'Failed to update provider secrets');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── DELETE /claude/providers/:id — 删除供应商 ─────
configRoutes.delete(
  '/claude/providers/:id',
  authMiddleware,
  adminRoleMiddleware,
  async (c) => {
    const { id } = c.req.param();
    const actor = (c.get('user') as AuthUser).username;

    try {
      return await withClaudeConfigMutationLock(async () => {
        const previous = getProviders().find((provider) => provider.id === id);
        const pendingInvalidation = getPendingProviderSessionInvalidation(id);
        if (!previous && !pendingInvalidation) {
          throw new Error('未找到指定供应商');
        }
        const referencedAgentCount = countAgentProfilesByModelConfigId(id);
        if (referencedAgentCount > 0) {
          throw new Error(
            `该模型配置仍被 ${referencedAgentCount} 个智能体使用，请先重新分配`,
          );
        }
        const sessionInvalidation = pendingInvalidation ?? {
          modelChanged: true,
          baseUrlChanged: true,
        };
        const mutation = await mutateClaudeConfigForAllGroups(
          actor,
          { trigger: 'provider_delete', providerId: id },
          () => {
            if (previous) {
              deleteProvider(id);
              appendClaudeConfigAuditBestEffort(actor, 'delete_provider', [
                `id:${id}`,
              ]);
            }
            return { id };
          },
          {
            clearSessionsForProviderId: id,
            sessionInvalidation,
          },
        );
        if (!mutation.applied.success) {
          return c.json(
            {
              error: mutation.applied.error,
              applied: mutation.applied,
            },
            503,
          );
        }
        return c.json({ ok: true, applied: mutation.applied });
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to delete provider';
      logger.warn({ err }, 'Failed to delete provider');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── POST /claude/providers/:id/toggle — 切换 enabled ─────
configRoutes.post(
  '/claude/providers/:id/toggle',
  authMiddleware,
  adminRoleMiddleware,
  async (c) => {
    const { id } = c.req.param();
    const actor = (c.get('user') as AuthUser).username;
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }

    try {
      return await withClaudeConfigMutationLock(async () => {
        const mutation = await mutateClaudeConfigForAllGroups(
          actor,
          { trigger: 'provider_toggle', providerId: id },
          () => {
            const updated = setProviderEnabled(id, body.enabled);
            appendClaudeConfigAuditBestEffort(actor, 'toggle_provider', [
              `id:${id}`,
              `enabled:${updated.enabled}`,
            ]);
            return updated;
          },
        );
        if (!mutation.applied.success) {
          return c.json(
            {
              error: mutation.applied.error,
              applied: mutation.applied,
              ...(mutation.value
                ? { provider: toPublicProvider(mutation.value) }
                : {}),
            },
            503,
          );
        }
        return c.json({
          provider: toPublicProvider(mutation.value!),
          applied: mutation.applied,
        });
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to toggle provider';
      logger.warn({ err }, 'Failed to toggle provider');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── POST /claude/providers/:id/reset-health — 重置健康状态 ─────
configRoutes.post(
  '/claude/providers/:id/reset-health',
  authMiddleware,
  adminRoleMiddleware,
  (c) => {
    const { id } = c.req.param();
    providerPool.resetHealth(id);
    return c.json({ ok: true });
  },
);

// ─── GET /claude/providers/health — 健康状态轮询 ─────
configRoutes.get(
  '/claude/providers/health',
  authMiddleware,
  adminRoleMiddleware,
  (c) => {
    // Refresh pool state
    const enabledProviders = getEnabledProviders();
    const balancing = getBalancingConfig();
    providerPool.refreshFromConfig(enabledProviders, balancing);
    return c.json({ statuses: providerPool.getHealthStatuses() });
  },
);

// ─── PUT /claude/balancing — 更新负载均衡参数 ─────
configRoutes.put(
  '/claude/balancing',
  authMiddleware,
  adminRoleMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = BalancingConfigSchema.safeParse(body);
    if (!validation.success) {
      return zodBadRequest(c, validation.error, 'body-format');
    }

    const actor = (c.get('user') as AuthUser).username;

    try {
      const saved = saveBalancingConfig(validation.data);
      appendClaudeConfigAudit(actor, 'update_balancing', [
        ...Object.keys(validation.data),
      ]);
      return c.json(saved);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to update balancing';
      return c.json({ error: message }, 400);
    }
  },
);

// ─── POST /claude/apply — 应用配置到所有容器 ─────
configRoutes.post(
  '/claude/apply',
  authMiddleware,
  adminRoleMiddleware,
  async (c) => {
    const actor = (c.get('user') as AuthUser).username;
    try {
      return await withClaudeConfigMutationLock(async () => {
        const result = await applyClaudeConfigToAllGroups(actor, {
          trigger: 'manual_provider_apply',
        });
        if (!result.success) {
          return c.json(result, 503);
        }
        return c.json(result);
      });
    } catch (err) {
      logger.error({ err }, 'Failed to apply Claude config to all groups');
      return c.json({ error: 'Server not initialized' }, 500);
    }
  },
);

// ─── Helpers ────────────────────────────────────────────────────

/** Persist a RegisteredGroup update and sync to the in-memory cache. */
function applyBindingUpdate(imJid: string, updated: RegisteredGroup): void {
  commitChannelMountUpdate(imJid, updated);
}

// Group-binding helpers (applyRegisteredGroupUpdate /
// resolveWorkspaceForBinding / markNativeContextWorkspace /
// detachThreadMapWorkspaceIfLast / hasConsistentChannelAccount /
// refreshAgentLastImJid / getConversationKind / fetchLiveChatInfo) are
// shared with routes/agents.ts via ../channel-mount-service.js
// (ISSUE-11 B1) — no local copies remain in this file.

function restoreDefaultChannelError(restored: { reason: string }): string {
  if (restored.reason === 'account_mismatch') {
    return 'Channel account does not match this chat or owner';
  }
  return 'Channel account has no default or owner home workspace';
}

// ─── Appearance config ────────────────────────────────────────────

const SYSTEM_AGENT_AVATAR_PREFIX = 'system-agent-';

configRoutes.get('/appearance', authMiddleware, adminRoleMiddleware, (c) => {
  try {
    return c.json(getAppearanceConfig());
  } catch (err) {
    logger.error({ err }, 'Failed to load appearance config');
    return c.json({ error: 'Failed to load appearance config' }, 500);
  }
});

configRoutes.put(
  '/appearance',
  authMiddleware,
  adminRoleMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = AppearanceConfigSchema.safeParse(body);
    if (!validation.success) {
      return zodBadRequest(c, validation.error, 'body-format');
    }

    try {
      const saved = saveAppearanceConfig(validation.data);
      return c.json(saved);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Invalid appearance config payload';
      logger.warn({ err }, 'Invalid appearance config payload');
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.post(
  '/appearance/avatar',
  authMiddleware,
  adminRoleMiddleware,
  avatarUploadBodyLimit,
  async (c) => {
    // Shared validation + write pipeline (ISSUE-11 B9); this route keeps the
    // admin auth, appearance persistence and system-agent reap policy.
    const stored = await storeAvatarUpload(c.req, SYSTEM_AGENT_AVATAR_PREFIX);
    if (!stored.ok) {
      return c.json({ error: stored.error }, stored.status);
    }
    const aiAvatarUrl = stored.avatarUrl;
    const appearance = saveAppearanceConfig({ aiAvatarUrl });
    reapAvatarFiles({
      prefix: SYSTEM_AGENT_AVATAR_PREFIX,
      keep: [stored.filename],
    });
    return c.json({ appearance, avatarUrl: aiAvatarUrl });
  },
);

configRoutes.delete(
  '/appearance/avatar',
  authMiddleware,
  adminRoleMiddleware,
  (c) => {
    const appearance = saveAppearanceConfig({
      aiAvatarUrl: null,
      aiAvatarMode: 'emoji',
    });
    reapAvatarFiles({ prefix: SYSTEM_AGENT_AVATAR_PREFIX });
    return c.json({ appearance });
  },
);

// Public endpoint — no auth required (like /api/auth/status)
configRoutes.get('/appearance/public', (c) => {
  try {
    const config = getAppearanceConfig();
    return c.json({
      appName: config.appName,
      aiName: config.aiName,
      aiAvatarEmoji: config.aiAvatarEmoji,
      aiAvatarColor: config.aiAvatarColor,
      aiAvatarUrl: config.aiAvatarUrl,
      aiAvatarMode: config.aiAvatarMode,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load public appearance config');
    return c.json({ error: 'Failed to load appearance config' }, 500);
  }
});

// ─── System settings ───────────────────────────────────────────────

function toSystemSettingsResponse(
  settings: ReturnType<typeof getSystemSettings>,
) {
  return {
    containerTimeout: settings.containerTimeout,
    idleTimeout: settings.idleTimeout,
    containerMaxOutputSize: settings.containerMaxOutputSize,
    maxConcurrentContainers: settings.maxConcurrentContainers,
    maxLoginAttempts: settings.maxLoginAttempts,
    loginLockoutMinutes: settings.loginLockoutMinutes,
    fallbackModel: settings.fallbackModel,
    providerSetupSkipped: settings.providerSetupSkipped,
  };
}

configRoutes.get('/system', authMiddleware, adminRoleMiddleware, (c) => {
  try {
    return c.json(toSystemSettingsResponse(getSystemSettings()));
  } catch (err) {
    logger.error({ err }, 'Failed to load system settings');
    return c.json({ error: 'Failed to load system settings' }, 500);
  }
});

configRoutes.put('/system', authMiddleware, adminRoleMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = SystemSettingsSchema.safeParse(body);
  if (!validation.success) {
    return zodBadRequest(c, validation.error, 'body-format');
  }

  try {
    // Deprecated compatibility inputs. Accept them so stale Web clients do
    // not fail the whole request, but never persist or apply them.
    const effectiveSettings = { ...validation.data };
    for (const key of [
      'maxConcurrentHostProcesses',
      'maxConcurrentScripts',
      'scriptTimeout',
      'taskBackfillGraceMs',
      'maxRepliesPerTurn',
      'maxTasksPerUser',
    ] as const) {
      delete effectiveSettings[key];
    }
    const saved = saveSystemSettings(effectiveSettings);
    const response = toSystemSettingsResponse(saved);
    return c.json(response);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid system settings payload';
    logger.warn({ err }, 'Invalid system settings payload');
    return c.json({ error: message }, 400);
  }
});

// ─── Host integration settings (admin role only) ───────────────────

function toHostIntegrationResponse(
  settings: ReturnType<typeof getSystemSettings>,
) {
  return {
    externalClaudeDir: settings.externalClaudeDir,
    adminHostOnlyMode: settings.adminHostOnlyMode,
    mainAgentContextSource: settings.mainAgentContextSource,
    mainAgentAutoCompactWindow: settings.mainAgentAutoCompactWindow,
    mainAgentAutoCompactPercentage: settings.mainAgentAutoCompactPercentage,
  };
}

configRoutes.get(
  '/host-integration',
  authMiddleware,
  adminRoleMiddleware,
  (c) => c.json(toHostIntegrationResponse(getSystemSettings())),
);

configRoutes.put(
  '/host-integration',
  authMiddleware,
  adminRoleMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = HostIntegrationSettingsSchema.safeParse(body);
    if (!validation.success) {
      return zodBadRequest(c, validation.error, 'body-format');
    }
    const requestedDir = validation.data.externalClaudeDir?.trim();
    if (requestedDir) {
      try {
        const resolved = fs.realpathSync(requestedDir);
        if (
          !path.isAbsolute(requestedDir) ||
          !fs.statSync(resolved).isDirectory()
        ) {
          throw new Error('not an absolute directory');
        }
      } catch {
        return c.json(
          { error: 'externalClaudeDir must be an existing absolute directory' },
          400,
        );
      }
    }

    return withCapabilityScopeLocks([SYSTEM_CAPABILITY_LOCK_KEY], async () => {
      const before = toHostIntegrationResponse(getSystemSettings());
      const mainContextSourceChanged =
        validation.data.mainAgentContextSource !== undefined &&
        validation.data.mainAgentContextSource !==
          before.mainAgentContextSource;
      const externalClaudeDirChanged =
        validation.data.externalClaudeDir !== undefined &&
        validation.data.externalClaudeDir !== before.externalClaudeDir;
      const hostContextChanged =
        mainContextSourceChanged || externalClaudeDirChanged;
      const adminHostOnlyModeChanged =
        validation.data.adminHostOnlyMode !== undefined &&
        validation.data.adminHostOnlyMode !== before.adminHostOnlyMode;
      const enablingAdminHostOnlyMode =
        adminHostOnlyModeChanged && validation.data.adminHostOnlyMode === true;
      const pendingRuntimeCleanupFolders =
        getPendingAdminHostOnlyCleanupFolders();
      const repairingRuntimeCleanup = pendingRuntimeCleanupFolders.length > 0;
      const enforcingAdminHostOnlyMode =
        enablingAdminHostOnlyMode ||
        (repairingRuntimeCleanup &&
          before.adminHostOnlyMode &&
          validation.data.adminHostOnlyMode !== false);
      const defaultCompactChanged =
        (validation.data.mainAgentAutoCompactWindow !== undefined &&
          validation.data.mainAgentAutoCompactWindow !==
            before.mainAgentAutoCompactWindow) ||
        (validation.data.mainAgentAutoCompactPercentage !== undefined &&
          validation.data.mainAgentAutoCompactPercentage !==
            before.mainAgentAutoCompactPercentage);
      const contextMutationRequested =
        hostContextChanged ||
        defaultCompactChanged ||
        enablingAdminHostOnlyMode ||
        repairingRuntimeCleanup;
      const contextWorkspaces =
        hostContextChanged || defaultCompactChanged
          ? Object.entries(getAllRegisteredGroups())
              .map(([jid, group]) => ({
                jid,
                group,
                profile: group.created_by
                  ? getAgentProfileForWorkspace(group.folder, group.created_by)
                  : undefined,
              }))
              .filter(({ group, profile }) => {
                if (!group.created_by || !profile) return false;
                const isActiveAdmin =
                  getUserById(group.created_by)?.role === 'admin';
                const currentContextSource =
                  resolveEffectiveAgentProfile(profile)?.runtime_policy.context
                    .source ?? 'managed';
                const nextContextSource = profile.is_default
                  ? (validation.data.mainAgentContextSource ??
                    before.mainAgentContextSource)
                  : profile.runtime_policy.context.source;
                return (
                  (defaultCompactChanged && profile.is_default) ||
                  (mainContextSourceChanged &&
                    profile.is_default &&
                    isActiveAdmin) ||
                  (externalClaudeDirChanged &&
                    isActiveAdmin &&
                    (currentContextSource === 'host_claude' ||
                      nextContextSource === 'host_claude'))
                );
              })
          : [];
      const allGroups =
        enablingAdminHostOnlyMode || repairingRuntimeCleanup
          ? getAllRegisteredGroups()
          : {};
      const activeAdminFolders = enablingAdminHostOnlyMode
        ? new Set(
            Object.values(allGroups)
              .filter((group) => {
                const owner = group.created_by
                  ? getUserById(group.created_by)
                  : undefined;
                return owner?.role === 'admin' && owner.status === 'active';
              })
              .map((group) => group.folder),
          )
        : new Set<string>();
      for (const folder of pendingRuntimeCleanupFolders) {
        activeAdminFolders.add(folder);
      }
      const policyWorkspaces = Array.from(activeAdminFolders)
        .map((folder) => {
          const entries = Object.entries(allGroups).filter(
            ([, group]) => group.folder === folder,
          );
          const preferred =
            entries.find(([jid]) => jid.startsWith('web:')) ?? entries[0];
          if (!preferred) return null;
          const [jid, group] = preferred;
          return {
            jid,
            group,
            profile: group.created_by
              ? getAgentProfileForWorkspace(group.folder, group.created_by)
              : undefined,
          };
        })
        .filter(
          (workspace): workspace is NonNullable<typeof workspace> =>
            workspace !== null,
        );
      const workspaceByFolder = new Map<
        string,
        (typeof contextWorkspaces)[number] | (typeof policyWorkspaces)[number]
      >();
      for (const workspace of [...contextWorkspaces, ...policyWorkspaces]) {
        workspaceByFolder.set(workspace.group.folder, workspace);
      }
      const workspaces = Array.from(workspaceByFolder.values());
      const sessionResetFolders = Array.from(
        new Set([
          ...workspaces.map(({ group }) => group.folder),
          ...pendingRuntimeCleanupFolders,
        ]),
      );
      let hostOnlyMigration:
        | ReturnType<typeof forceActiveAdminRuntimesToHost>
        | undefined;
      const commit = () => {
        if (enforcingAdminHostOnlyMode) {
          hostOnlyMigration = forceActiveAdminRuntimesToHost();
          if (deps) {
            const liveGroups = deps.getRegisteredGroups();
            for (const { jid } of hostOnlyMigration.affectedGroups) {
              const fresh = getRegisteredGroup(jid);
              if (fresh) liveGroups[jid] = fresh;
            }
          }
        }
        for (const folder of sessionResetFolders)
          deleteWorkspaceSessions(folder);
        if (deps?.sessions) {
          for (const folder of sessionResetFolders)
            delete deps.sessions[folder];
        }
        const value = saveSystemSettings(validation.data);
        if (hostOnlyMigration?.migratedTaskIds.length) {
          notifyTaskSchedulerChanged();
        }
        return value;
      };
      let saved: ReturnType<typeof saveSystemSettings>;
      if (contextMutationRequested && deps) {
        const profileIds = Array.from(
          new Set(
            workspaces
              .map(({ profile }) => profile)
              .filter((profile) => !!profile)
              .map((profile) => profile.id),
          ),
        );
        try {
          const targets = workspaces.map(({ jid, group }) => ({
            folder: group.folder,
            primaryJid: jid,
          }));
          const result = await withAgentProfileLocks(profileIds, () =>
            quiesceWorkspaceRunnersAroundCommit(
              deps,
              targets,
              {
                reason: 'Host integration context updated',
                onPostCommitFailure: (runtimeJids) => {
                  markAdminHostOnlyCleanupPending(sessionResetFolders);
                  deps.queue.blockGroupsForRuntimeSafety?.(
                    runtimeJids,
                    'Host integration runtime cleanup failed after settings commit',
                    ADMIN_HOST_ONLY_RUNTIME_SAFETY_SOURCE,
                  );
                },
              },
              commit,
            ),
          );
          saved = result.value;
          clearAdminHostOnlyCleanupPending(sessionResetFolders);
          deps.queue.unblockGroupsForRuntimeSafety?.(
            result.runtimeJids,
            ADMIN_HOST_ONLY_RUNTIME_SAFETY_SOURCE,
          );
        } catch (err) {
          if (!(err instanceof WorkspaceRuntimeQuiesceError)) throw err;
          return c.json(
            {
              error: err.persisted
                ? 'Host integration was updated, but runtime cleanup failed; retry the same request'
                : 'Failed to quiesce active workspaces; host integration was not updated',
              persisted: err.persisted,
              retryable: true,
            },
            503,
          );
        }
      } else {
        saved = commit();
      }
      const response = toHostIntegrationResponse(saved);

      return c.json(response);
    });
  },
);

// ─── External Claude resources (admin only) ─────────────────────────

configRoutes.get(
  '/external-resources',
  authMiddleware,
  adminRoleMiddleware,
  (c) => {
    const effectiveDir = getEffectiveExternalDir();

    const result: {
      dir: string;
      rules: Array<{ name: string; size: number }>;
      claudeMd: string | null;
    } = { dir: effectiveDir, rules: [], claudeMd: null };

    // Rules
    const rulesDir = path.join(effectiveDir, 'rules');
    try {
      if (fs.existsSync(rulesDir)) {
        for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
          if (!entry.isFile() && !entry.isSymbolicLink()) continue;
          try {
            const st = fs.statSync(path.join(rulesDir, entry.name));
            result.rules.push({ name: entry.name, size: st.size });
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* ignore */
    }

    // CLAUDE.md
    const claudeMdPath = path.join(effectiveDir, 'CLAUDE.md');
    try {
      if (fs.existsSync(claudeMdPath)) {
        const content = fs.readFileSync(claudeMdPath, 'utf-8');
        result.claudeMd =
          content.length > 10000
            ? content.slice(0, 10000) + '\n...(截断)'
            : content;
      }
    } catch {
      /* ignore */
    }

    return c.json(result);
  },
);

// Read a single rule file content (admin only)
configRoutes.get(
  '/external-resources/rule',
  authMiddleware,
  adminRoleMiddleware,
  (c) => {
    const user = c.get('user') as AuthUser;
    if (user.role !== 'admin') {
      return c.text('Forbidden', 403);
    }
    const name = c.req.query('name');
    if (!name || name.includes('/') || name.includes('..')) {
      return c.text('Invalid name', 400);
    }
    const effectiveDir = getEffectiveExternalDir();
    const filePath = path.join(effectiveDir, 'rules', name);
    try {
      const resolved = fs.realpathSync(filePath);
      // 确保解析后的路径仍在 rules 目录内
      if (
        !resolved.startsWith(fs.realpathSync(path.join(effectiveDir, 'rules')))
      ) {
        return c.text('Forbidden', 403);
      }
      const content = fs.readFileSync(resolved, 'utf-8');
      return c.text(content);
    } catch {
      return c.text('Not found', 404);
    }
  },
);

// ─── IM Binding management (bindings panoramic page) ────────────

configRoutes.put('/user-im/bindings/:imJid', authMiddleware, async (c) => {
  const imJid = decodeURIComponent(c.req.param('imJid'));
  const user = c.get('user') as AuthUser;

  // Validate IM JID
  const channelType = getChannelType(imJid);
  if (!channelType) {
    return c.json({ error: 'Invalid IM JID' }, 400);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  // IM-binding 改的是 imGroup 行（target_agent_id / target_main_jid /
  // activation_mode 等），与 agents.ts 的 4 个 IM-binding 路由对齐：
  // 非成员用 access 检查隐藏存在性（404），成员但非 owner 拒绝写（403）。
  // IM 路由变更必须由对应工作区所有者执行。
  if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
    return groupAccessDeniedResponse(c, 'IM group not found');
  }
  if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!hasConsistentChannelAccount(user.id, imJid, imGroup)) {
    return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));

  // Unbind mode
  if (body.unbind === true) {
    const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
    // Re-read + re-authorize after the await — fetchLiveChatInfo
    // yields the event loop on a live network call, during which ownership
    // or binding state may have changed. restoreDefaultChannelMount commits
    // whatever `group` it's given, so building it from the stale pre-await
    // snapshot would silently clobber a concurrent write and could cross
    // the original authorization boundary.
    const freshImGroup = getRegisteredGroup(imJid);
    if (!freshImGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...freshImGroup, jid: imJid })) {
      return groupAccessDeniedResponse(c, 'IM group not found');
    }
    if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!hasConsistentChannelAccount(user.id, imJid, freshImGroup)) {
      return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
    }
    const previousTargetAgentId = freshImGroup.target_agent_id;
    const wasThreadMap = freshImGroup.binding_mode === 'thread_map';
    const restored = restoreDefaultChannelMount(
      imJid,
      freshImGroup,
      user.id,
      chatInfo ?? {},
    );
    if (restored.status !== 'resolved') {
      return c.json({ error: restoreDefaultChannelError(restored) }, 409);
    }
    if (wasThreadMap) {
      detachThreadMapWorkspaceIfLast(
        freshImGroup,
        imJid,
        restored.workspaceJid,
        restored.routingMode,
      );
    }
    if (restored.routingMode === 'thread_map') {
      markNativeContextWorkspace(restored.workspaceJid);
    }
    if (previousTargetAgentId) {
      refreshAgentLastImJid(previousTargetAgentId);
    }
    logger.info(
      {
        imJid,
        defaultWorkspaceJid: restored.workspaceJid,
        userId: user.id,
      },
      'IM group restored to channel account default workspace (bindings page)',
    );
    return c.json({ success: true, target_main_jid: restored.workspaceJid });
  }

  const targetSessionId =
    typeof body.target_session_id === 'string' && body.target_session_id.trim()
      ? body.target_session_id.trim()
      : typeof body.target_agent_id === 'string' && body.target_agent_id.trim()
        ? body.target_agent_id.trim()
        : '';

  // Bind to workspace session. Stored in target_agent_id for backward compatibility.
  if (targetSessionId) {
    const sessionId = targetSessionId;
    const agent = getAgent(sessionId);
    if (!agent) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (agent.kind !== 'conversation') {
      return c.json(
        { error: 'Only workspace sessions can bind IM groups' },
        400,
      );
    }
    if (!agent.chat_jid.startsWith('web:')) {
      return c.json(
        { error: 'Session target must belong to a workspace' },
        400,
      );
    }
    // Check user can access the workspace that owns this session.
    const ownerGroup = getRegisteredGroup(agent.chat_jid);
    if (
      !ownerGroup ||
      !canModifyGroup(user, { ...ownerGroup, jid: agent.chat_jid })
    ) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
    // Re-read after the await: fetchLiveChatInfo makes a live network call
    // that yields the event loop, during which a concurrent bind request or
    // the message router's owner-learning path can commit a new mount for
    // this exact imJid, or upgrade native_context_type from 'none' to
    // 'thread'. Building the update, or computing threadCapable, from the
    // pre-await snapshot would silently clobber that write or bind a
    // now-thread-capable container as a fixed single session.
    const freshImGroup = getRegisteredGroup(imJid);
    if (!freshImGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    // Re-run authorization against the fresh row — the handler's top-level
    // checks only proved it against the stale imGroup read before the await.
    if (!canAccessGroup(user, { ...freshImGroup, jid: imJid })) {
      return groupAccessDeniedResponse(c, 'IM group not found');
    }
    if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!hasConsistentChannelAccount(user.id, imJid, freshImGroup)) {
      return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
    }
    const freshAgent = getAgent(sessionId);
    if (
      !freshAgent ||
      freshAgent.kind !== 'conversation' ||
      !freshAgent.chat_jid.startsWith('web:')
    ) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const freshOwnerGroup = getRegisteredGroup(freshAgent.chat_jid);
    if (
      !freshOwnerGroup ||
      !canModifyGroup(user, {
        ...freshOwnerGroup,
        jid: freshAgent.chat_jid,
      })
    ) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    // Compute against freshImGroup, not the pre-await snapshot — see
    // fetchLiveChatInfo's doc comment.
    if (isNativeContextContainer(imJid, freshImGroup, chatInfo ?? {})) {
      return c.json(
        {
          error:
            'Native thread containers can only bind to a workspace, not a single session',
        },
        400,
      );
    }
    const bindingPolicyError = conversationBindingPolicyError(
      getConversationKind(imJid, freshImGroup, chatInfo),
      'session',
    );
    if (bindingPolicyError) {
      return c.json({ error: bindingPolicyError }, 400);
    }

    const force = body.force === true;
    const replyPolicy =
      body.reply_policy === 'mirror' ? 'mirror' : 'source_only';
    const hasConflict = hasSessionMountConflict(freshImGroup, sessionId);
    if (hasConflict && !force) {
      return c.json({ error: 'IM group is already bound elsewhere' }, 409);
    }

    const updated: RegisteredGroup = buildSessionMountUpdate(
      freshImGroup,
      sessionId,
      {
        replyPolicy,
      },
    );
    applyBindingUpdate(imJid, updated);
    if (freshImGroup.binding_mode === 'thread_map') {
      detachThreadMapWorkspaceIfLast(freshImGroup, imJid);
    }
    logger.info(
      { imJid, sessionId, userId: user.id },
      'IM group bound to workspace session (bindings page)',
    );
    return c.json({ success: true });
  }

  // Parse activation_mode for activation-only update
  const rawActivationMode = body.activation_mode;
  let activationMode =
    typeof rawActivationMode === 'string' &&
    VALID_ACTIVATION_MODES.has(rawActivationMode)
      ? (rawActivationMode as
          | (typeof rawActivationMode & 'auto')
          | 'always'
          | 'when_mentioned'
          | 'owner_mentioned'
          | 'disabled')
      : undefined;
  let audienceMode: AudienceMode | undefined =
    body.audience_mode === 'everyone' || body.audience_mode === 'owner_only'
      ? body.audience_mode
      : undefined;
  if (channelType === 'feishu') {
    const normalized = normalizeLegacyOwnerMention({
      activationMode,
      audienceMode,
    });
    activationMode = normalized.activationMode;
    audienceMode = normalized.audienceMode;
  }

  // Parse owner_im_id for owner_mentioned mode
  const ownerImId =
    typeof body.owner_im_id === 'string' && body.owner_im_id.trim()
      ? body.owner_im_id.trim()
      : undefined;

  // Bind to workspace main conversation
  if (typeof body.target_main_jid === 'string' && body.target_main_jid.trim()) {
    const targetMainJid = body.target_main_jid.trim();
    if (!targetMainJid.startsWith('web:')) {
      return c.json({ error: 'Target must be a workspace' }, 400);
    }
    const targetGroup = getRegisteredGroup(targetMainJid);
    if (!targetGroup) {
      return c.json({ error: 'Target workspace not found' }, 404);
    }
    if (!canModifyGroup(user, { ...targetGroup, jid: targetMainJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
    // Re-read + re-authorize after the await — see the analogous comment
    // in the session-bind branch above.
    const freshImGroup = getRegisteredGroup(imJid);
    if (!freshImGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...freshImGroup, jid: imJid })) {
      return groupAccessDeniedResponse(c, 'IM group not found');
    }
    if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!hasConsistentChannelAccount(user.id, imJid, freshImGroup)) {
      return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
    }
    const freshTargetGroup = getRegisteredGroup(targetMainJid);
    if (!freshTargetGroup) {
      return c.json({ error: 'Target workspace not found' }, 404);
    }
    if (!canModifyGroup(user, { ...freshTargetGroup, jid: targetMainJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const bindingPolicyError = conversationBindingPolicyError(
      getConversationKind(imJid, freshImGroup, chatInfo),
      'workspace',
    );
    if (bindingPolicyError) {
      return c.json({ error: bindingPolicyError }, 400);
    }
    if (
      getChannelType(imJid) === 'feishu' &&
      (chatInfo?.chat_mode ?? freshImGroup.feishu_chat_mode) === 'p2p' &&
      isMentionActivationMode(activationMode)
    ) {
      return c.json(
        { error: 'Feishu private chats do not support mention activation' },
        400,
      );
    }
    // Compute against freshImGroup, not the pre-await snapshot — see
    // fetchLiveChatInfo's doc comment.
    const threadCapable = isNativeContextContainer(imJid, freshImGroup, {
      ...(chatInfo ?? {}),
      activation_mode: activationMode ?? freshImGroup.activation_mode,
    });
    const force = body.force === true;
    const replyPolicy =
      body.reply_policy === 'mirror' ? 'mirror' : 'source_only';
    const legacyMainJid = `web:${freshTargetGroup.folder}`;
    const hasConflict = hasWorkspaceMountConflict(
      freshImGroup,
      targetMainJid,
      legacyMainJid,
    );
    if (hasConflict && !force) {
      return c.json({ error: 'IM group is already bound elsewhere' }, 409);
    }
    const updated: RegisteredGroup = {
      ...buildWorkspaceMountUpdate(
        freshImGroup,
        targetMainJid,
        threadCapable ? 'thread_map' : 'single_session',
        {
          replyPolicy,
          ...(activationMode !== undefined ? { activationMode } : {}),
          ...(audienceMode !== undefined ? { audienceMode } : {}),
          ...(ownerImId !== undefined ? { ownerImId } : {}),
        },
      ),
      feishu_chat_mode: chatInfo?.chat_mode ?? freshImGroup.feishu_chat_mode,
      feishu_group_message_type:
        chatInfo?.group_message_type ?? freshImGroup.feishu_group_message_type,
      ...(ownerImId !== undefined
        ? { owner_claim_source: 'configured' as const }
        : {}),
    };
    applyBindingUpdate(imJid, updated);
    if (freshImGroup.binding_mode === 'thread_map') {
      detachThreadMapWorkspaceIfLast(
        freshImGroup,
        imJid,
        targetMainJid,
        threadCapable ? 'thread_map' : 'single_session',
      );
    }
    if (threadCapable) markNativeContextWorkspace(targetMainJid);
    logger.info(
      { imJid, targetMainJid, threadCapable, userId: user.id },
      'IM group bound to workspace (bindings page)',
    );
    return c.json({ success: true });
  }

  // Activation-only update (no target, just update activation_mode and/or owner_im_id)
  if (
    activationMode !== undefined ||
    audienceMode !== undefined ||
    ownerImId !== undefined
  ) {
    if (
      getChannelType(imJid) === 'feishu' &&
      imGroup.feishu_chat_mode === 'p2p' &&
      isMentionActivationMode(activationMode)
    ) {
      return c.json(
        { error: 'Feishu private chats do not support mention activation' },
        400,
      );
    }
    const candidate: RegisteredGroup = {
      ...imGroup,
      ...(activationMode !== undefined
        ? { activation_mode: activationMode }
        : {}),
      ...(audienceMode !== undefined ? { audience_mode: audienceMode } : {}),
      ...(ownerImId !== undefined ? { owner_im_id: ownerImId } : {}),
      ...(ownerImId !== undefined
        ? { owner_claim_source: 'configured' as const }
        : {}),
    };
    const threadCapable = isNativeContextContainer(imJid, candidate, {
      activation_mode: candidate.activation_mode,
    });
    if (threadCapable && candidate.target_agent_id) {
      return c.json(
        {
          error:
            'Mention-activated and native-topic Feishu chats must bind to a workspace, not a fixed session',
        },
        400,
      );
    }
    const updated = candidate.target_main_jid
      ? buildWorkspaceMountUpdate(
          candidate,
          candidate.target_main_jid,
          threadCapable ? 'thread_map' : 'single_session',
          {
            activationMode: candidate.activation_mode,
            audienceMode: candidate.audience_mode,
            ownerImId: candidate.owner_im_id ?? null,
          },
        )
      : candidate;
    applyBindingUpdate(imJid, updated);
    if (imGroup.binding_mode === 'thread_map' && !threadCapable) {
      detachThreadMapWorkspaceIfLast(imGroup, imJid);
    }
    if (threadCapable && updated.target_main_jid) {
      markNativeContextWorkspace(updated.target_main_jid);
    }
    logger.info(
      { imJid, activationMode, audienceMode, ownerImId, userId: user.id },
      'IM group response policies updated (bindings page)',
    );
    return c.json({ success: true });
  }

  return c.json(
    {
      error:
        'Must provide target_main_jid, target_session_id, target_agent_id, activation_mode, audience_mode, or unbind',
    },
    400,
  );
});

// Escape hatch for the pre-owner Feishu lock. Reset both the legacy allowlist
// and the v58 audience policy so the visible "解除限制" action truly allows
// everyone to trigger the bot.
configRoutes.post(
  '/user-im/bindings/:imJid/reset-allowlist',
  authMiddleware,
  (c) => {
    const imJid = decodeURIComponent(c.req.param('imJid'));
    const user = c.get('user') as AuthUser;

    const channelType = getChannelType(imJid);
    if (!channelType) {
      return c.json({ error: 'Invalid IM JID' }, 400);
    }
    if (channelType !== 'feishu') {
      return c.json({ error: 'Only Feishu groups are supported' }, 400);
    }

    const imGroup = getRegisteredGroup(imJid);
    if (!imGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (imGroup.created_by !== user.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (
      !Array.isArray(imGroup.sender_allowlist) ||
      imGroup.sender_allowlist.length !== 0
    ) {
      return c.json({ error: 'Group is not in locked allowlist state' }, 400);
    }

    const updated: RegisteredGroup = {
      ...imGroup,
      sender_allowlist: undefined,
      audience_mode: 'everyone',
    };
    applyBindingUpdate(imJid, updated);

    logger.info(
      { imJid, userId: user.id },
      'Feishu response audience reset to everyone (bindings page)',
    );
    return c.json({ success: true });
  },
);

export default configRoutes;
