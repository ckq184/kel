/**
 * 工作区治理 REST API（挂载于 /api/workspaces，见 src/web.ts）。
 *
 * 路由一览：
 * - GET  /                        可见工作区摘要列表
 * - GET  /mounts                  可见工作区的渠道挂载聚合
 * - GET  /:jid                    单工作区详情（含运行时会话/挂载明细）
 * - GET  /:jid/runtime-sessions   运行时会话清单（需工作区访问权）
 * - GET  /:jid/channel-mounts     渠道挂载清单（需工作区访问权）
 * - GET/PATCH /:jid/owner-profile 主 CKQClaw 的 Owner Profile 读写
 *   （仅 home 工作区创建者；revision 乐观锁 → 409）
 *
 * 权限模型：resolveWorkspaceAccess 统一收敛——canAccessGroup；不可见一律
 * 404 不暴露存在性。细分治理字段随工作区详情返回。
 */
import { Hono, type Context } from 'hono';
import { zodBadRequest } from '../validation-response.js';
import type { Variables } from '../web-context.js';
import { canAccessGroup, canModifyGroup } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser, RegisteredGroup } from '../types.js';
import {
  getAgentProfile,
  getRegisteredGroup,
  getWorkspaceAgentProfileId,
  getWorkspaceInteractionMode,
  listAgentChannelMountsByWorkspace,
  listWorkspaceRecords,
  listWorkspaceRuntimeSessionsByWorkspace,
  type AgentChannelMountRecord,
  type WorkspaceRecord,
} from '../db.js';
import { CkqclawOwnerProfileMutationSchema } from '../schemas.js';
import {
  clearCkqclawOwnerPreferredAddress,
  getCkqclawOwnerProfileProjection,
  OwnerProfileStoreError,
  setCkqclawOwnerPreferredAddress,
  skipCkqclawOwnerIntroduction,
} from '../owner-profile-store.js';

const workspaceRoutes = new Hono<{ Variables: Variables }>();

type ResolvedWorkspaceAccess = {
  workspace: WorkspaceRecord;
  group: RegisteredGroup & { jid: string };
};

function resolveWorkspaceAccess(
  user: AuthUser,
  workspace: WorkspaceRecord,
): ResolvedWorkspaceAccess | null {
  const group = getRegisteredGroup(workspace.jid);
  if (!group || !workspace.jid.startsWith('web:')) return null;

  const groupWithJid = { ...group, jid: workspace.jid };
  if (!canAccessGroup(user, groupWithJid)) return null;
  return { workspace, group: groupWithJid };
}

function getAgentProfileSnapshot(workspace: WorkspaceRecord) {
  const profileId = getWorkspaceAgentProfileId(workspace.folder);
  if (!profileId) return null;
  const profile = getAgentProfile(profileId);
  if (!profile || profile.status !== 'active') return null;
  return {
    id: profile.id,
    name: profile.name,
    version: profile.version,
    identity_hash: profile.identity_hash,
    runtime_policy: profile.runtime_policy,
    is_default: profile.is_default,
  };
}

function serializeMount(mount: AgentChannelMountRecord) {
  return {
    channel_jid: mount.channel_jid,
    channel_type: mount.channel_type,
    workspace_jid: mount.workspace_jid,
    workspace_folder: mount.workspace_folder,
    session_id: mount.session_id ?? null,
    routing_mode: mount.routing_mode,
    reply_policy: mount.reply_policy,
    activation_mode: mount.activation_mode,
    audience_mode: mount.audience_mode,
    owner_im_id: mount.owner_im_id ?? null,
    owner_user_id: mount.owner_user_id,
    agent_profile_id: mount.agent_profile_id,
    created_at: mount.created_at,
    updated_at: mount.updated_at,
  };
}

function serializeWorkspaceSummary(
  user: AuthUser,
  access: ResolvedWorkspaceAccess,
) {
  const { workspace, group } = access;
  const runtimeSessions = listWorkspaceRuntimeSessionsByWorkspace(
    workspace.jid,
  );
  const channelMounts = listAgentChannelMountsByWorkspace(workspace.jid);
  return {
    jid: workspace.jid,
    folder: workspace.folder,
    owner_user_id: workspace.owner_user_id,
    name: workspace.name,
    status: workspace.status,
    is_home: workspace.is_home,
    execution_mode: group.executionMode ?? 'container',
    interaction_mode: getWorkspaceInteractionMode(workspace.folder),
    custom_cwd: group.customCwd ?? null,
    agent_profile: getAgentProfileSnapshot(workspace),
    runtime_session_count: runtimeSessions.length,
    channel_mount_count: channelMounts.length,
    can_modify: canModifyGroup(user, group),
    created_at: workspace.created_at,
    updated_at: workspace.updated_at,
  };
}

function listVisibleWorkspaces(user: AuthUser): ResolvedWorkspaceAccess[] {
  return listWorkspaceRecords()
    .map((workspace) => resolveWorkspaceAccess(user, workspace))
    .filter((access): access is ResolvedWorkspaceAccess => access !== null);
}

function resolveOwnerProfileAccess(
  user: AuthUser,
  jid: string,
): ResolvedWorkspaceAccess | null {
  const workspace = listWorkspaceRecords().find((record) => record.jid === jid);
  if (!workspace || !workspace.is_home || workspace.owner_user_id !== user.id) {
    return null;
  }
  const access = resolveWorkspaceAccess(user, workspace);
  if (!access || access.group.created_by !== user.id) return null;
  const profile = getAgentProfileSnapshot(workspace);
  return profile?.is_default === true ? access : null;
}

function ownerProfileError(c: Context, error: unknown): Response {
  if (error instanceof OwnerProfileStoreError) {
    if (error.code === 'revision_conflict') {
      return c.json(
        {
          error: error.code,
          message: error.message,
          currentRevision: error.details?.currentRevision,
          storeRevision: error.details?.storeRevision,
        },
        409,
      );
    }
    if (error.code === 'idempotency_conflict') {
      return c.json({ error: error.code, message: error.message }, 409);
    }
    if (error.code === 'not_home_workspace') {
      return c.json({ error: 'Owner Profile not found' }, 404);
    }
    return c.json({ error: error.code, message: error.message }, 400);
  }
  return c.json({ error: 'Owner Profile request failed' }, 500);
}

workspaceRoutes.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const workspaces = listVisibleWorkspaces(user).map((access) =>
    serializeWorkspaceSummary(user, access),
  );
  return c.json({ workspaces });
});

workspaceRoutes.get('/mounts', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const channelMounts = listVisibleWorkspaces(user).flatMap((access) =>
    listAgentChannelMountsByWorkspace(access.workspace.jid).map(serializeMount),
  );
  return c.json({ channel_mounts: channelMounts });
});

workspaceRoutes.get('/:jid/owner-profile', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const access = resolveOwnerProfileAccess(user, c.req.param('jid'));
  if (!access) return c.json({ error: 'Owner Profile not found' }, 404);
  try {
    return c.json({
      profile: getCkqclawOwnerProfileProjection(access.workspace.jid),
    });
  } catch (error) {
    return ownerProfileError(c, error);
  }
});

workspaceRoutes.patch('/:jid/owner-profile', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const access = resolveOwnerProfileAccess(user, c.req.param('jid'));
  if (!access) return c.json({ error: 'Owner Profile not found' }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = CkqclawOwnerProfileMutationSchema.safeParse(body);
  if (!parsed.success) {
    return zodBadRequest(c, parsed.error, 'request-format');
  }
  const context = {
    actorId: user.id,
    sourceType: 'web_user' as const,
    sourceId: `api:${access.workspace.jid}:owner-profile`,
    observedAt: new Date().toISOString(),
  };
  try {
    switch (parsed.data.action) {
      case 'set':
        return c.json(
          setCkqclawOwnerPreferredAddress({
            workspaceJid: access.workspace.jid,
            preferredAddress: parsed.data.preferredAddress,
            expectedRevision: parsed.data.expectedRevision,
            idempotencyKey: parsed.data.idempotencyKey,
            context,
          }),
        );
      case 'clear':
        return c.json(
          clearCkqclawOwnerPreferredAddress({
            workspaceJid: access.workspace.jid,
            expectedRevision: parsed.data.expectedRevision,
            idempotencyKey: parsed.data.idempotencyKey,
            context,
          }),
        );
      case 'skip':
        return c.json(
          skipCkqclawOwnerIntroduction({
            workspaceJid: access.workspace.jid,
            expectedOnboardingRevision: parsed.data.expectedOnboardingRevision,
            context,
          }),
        );
    }
  } catch (error) {
    return ownerProfileError(c, error);
  }
});

workspaceRoutes.get('/:jid', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const workspace = listWorkspaceRecords().find((record) => record.jid === jid);
  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
  const access = resolveWorkspaceAccess(user, workspace);
  if (!access) return c.json({ error: 'Workspace not found' }, 404);

  const runtimeSessions = listWorkspaceRuntimeSessionsByWorkspace(
    workspace.jid,
  ).map((session) => ({
    group_folder: session.group_folder,
    runtime_agent_id: session.runtime_agent_id,
    workspace_jid: session.workspace_jid,
    sdk_session_id: session.sdk_session_id,
    provider_id: session.provider_id,
    agent_profile_id: session.agent_profile_id,
    agent_profile_version: session.agent_profile_version,
    identity_hash: session.identity_hash,
    created_at: session.created_at,
    updated_at: session.updated_at,
  }));
  const channelMounts = listAgentChannelMountsByWorkspace(workspace.jid).map(
    serializeMount,
  );

  return c.json({
    workspace: serializeWorkspaceSummary(user, access),
    runtime_sessions: runtimeSessions,
    channel_mounts: channelMounts,
  });
});

workspaceRoutes.get('/:jid/runtime-sessions', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const workspace = listWorkspaceRecords().find((record) => record.jid === jid);
  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
  const access = resolveWorkspaceAccess(user, workspace);
  if (!access) {
    return c.json({ error: 'Workspace not found' }, 404);
  }
  return c.json({
    runtime_sessions: listWorkspaceRuntimeSessionsByWorkspace(jid),
  });
});

workspaceRoutes.get('/:jid/channel-mounts', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const workspace = listWorkspaceRecords().find((record) => record.jid === jid);
  if (!workspace) return c.json({ error: 'Workspace not found' }, 404);
  const access = resolveWorkspaceAccess(user, workspace);
  if (!access) {
    return c.json({ error: 'Workspace not found' }, 404);
  }
  const channelMounts =
    listAgentChannelMountsByWorkspace(jid).map(serializeMount);
  return c.json({ channel_mounts: channelMounts });
});

export default workspaceRoutes;
