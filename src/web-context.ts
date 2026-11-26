// Shared state and utilities for web server

import type { Context } from 'hono';
import { WebSocket } from 'ws';
import { FollowUpActionResult, RegisteredGroup } from './types.js';
import {
  GroupQueue,
  type IpcDeliveryReceipt,
  type IpcPrePublishAdmission,
} from './group-queue.js';
import type {
  AuthUser,
  NewMessage,
  MessageCursor,
  UserSessionWithUser,
} from './types.js';
import {
  getJidsByFolder,
  getRegisteredGroup,
  getSessionWithUser,
} from './db.js';
import type { ChannelAccount } from './types.js';
import type { ChannelAccountSecret } from './channel-account-secrets.js';

interface WsClientInfo {
  sessionId: string;
  userId: string;
}

export interface WebDeps {
  queue: GroupQueue;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  sessions: Record<string, string>;
  getSessions: () => Record<string, string>;
  processGroupMessages: (chatJid: string) => Promise<boolean>;
  ensureTerminalContainerStarted: (chatJid: string) => boolean;
  formatMessages: (messages: NewMessage[]) => string;
  getLastAgentTimestamp: () => Record<string, MessageCursor>;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
  /**
   * Lex-max-merge advance for BOTH cursors (lastAgentTimestamp +
   * lastCommittedCursor). Comparison uses lexicographic (timestamp, id) so a
   * later candidate never regresses the cursor below the current value —
   * direct overwrite (`setLastAgentTimestamp`) on same-millisecond batches
   * with a smaller-UUID candidate would regress the cursor (#27 round-17
   * P2-2).
   */
  advanceCursors: (jid: string, cursor: MessageCursor) => void;
  /**
   * Advance only the next-pull cursor (lastAgentTimestamp). lastCommittedCursor
   * stays put so a crash before earlier same-batch messages reach the agent
   * still surfaces them on recovery.
   */
  advanceNextPullCursorOnly: (jid: string, cursor: MessageCursor) => void;
  /** Production single chokepoint for direct replies/drops. It advances only
   * next-pull when an earlier unreceipted message exists. Optional solely for
   * compatibility with focused route-test fixtures. */
  completeOutOfBandMessage?: (jid: string, cursor: MessageCursor) => void;
  advanceGlobalCursor: (cursor: MessageCursor) => void;
  reloadChannelAccount?: (accountId: string) => Promise<boolean>;
  disconnectChannelAccount?: (accountId: string) => Promise<void>;
  testChannelAccount?: (
    account: ChannelAccount,
    secret: ChannelAccountSecret,
  ) => Promise<{ success: boolean; unsupported?: boolean; error?: string }>;
  isChannelAccountConnected?: (accountId: string) => boolean;
  processAgentConversation?: (
    chatJid: string,
    agentId: string,
  ) => Promise<void | boolean>;
  getFeishuChatInfo?: (
    userId: string,
    chatId: string,
  ) => Promise<{
    avatar?: string;
    name?: string;
    user_count?: string;
    chat_type?: string;
    chat_mode?: string;
    group_message_type?: string;
  } | null>;
  getChannelChatInfo?: (jid: string) => Promise<
    | {
        avatar?: string;
        name?: string;
        user_count?: string;
        chat_type?: string;
        chat_mode?: string;
        group_message_type?: string;
      }
    | null
    | undefined
  >;
  /** Refresh the current user's discoverable IM chats from connected bots. */
  syncUserImGroups?: (userId: string) => Promise<{ feishuAccounts: number }>;
  clearImFailCounts?: (jid: string) => void;
  /**
   * Fully remove an IM group's registered_groups entry (plus jid-scoped data
   * and fail counters). Used by DELETE /api/groups/:jid for IM-prefixed JIDs
   * — shared with the auto-cleanup paths (bot removed / health check / send
   * fail) so the manual delete path also resets imSendFailCounts /
   * imHealthCheckFailCounts.
   */
  removeImGroupRecord?: (jid: string, reason: string) => void;
  updateReplyRoute?: (
    folder: string,
    sourceJid: string | null,
    inputTurnId?: string,
    inputCursor?: { timestamp: string; id: string },
    inputChatJid?: string,
    inputTaskId?: string,
    runtimeAgentId?: string,
  ) => void;
  /** Acquire the immutable Turn/Card/Outbox fence before an IPC file becomes
   * visible to the SDK runner. Returning false rejects the warm injection. */
  preAdmitReplyRoute?: (
    folder: string,
    sourceJid: string | null,
    receipt: IpcDeliveryReceipt | undefined,
    runtimeAgentId?: string,
  ) => IpcPrePublishAdmission | false;
  /** 用户消息注入运行中 Sub-Agent 时，先把该 agent 挂起中的流式卡片定稿轮换。
   * key 为 virtualChatJid（`web:{folder}#agent:{id}`）。主会话路径无需调用
   * ——updateReplyRoute 触发的 route updater 已内置同样的收口。 */
  finalizeHeldCard?: (key: string) => void;
  triggerTaskRun?: (
    taskId: string,
    idempotencyKey?: string,
  ) => { success: boolean; error?: string; runId?: string };
  /** Stop one occurrence only; future schedule remains unchanged. */
  cancelTaskRun?: (runId: string) => { success: boolean; error?: string };
  /** Wait for cancelled task processes to leave the workspace filesystem. */
  waitForTaskRunsToStop?: (
    runIds: string[],
    timeoutMs?: number,
  ) => Promise<boolean>;
  applyAutoIsolateContext?: (userId: string, enable: boolean) => number;
  /**
   * Resolve a registered group to its effective sibling-aware form. For non-home
   * groups bound (or auto-mapped) to a home sibling, returns the merged group
   * with executionMode/customCwd/created_by inherited from the home — without
   * this, web.ts message handling on sibling JIDs (e.g. an IM group bound to a
   * home workspace) would resolve incomplete runtime fields (#21 round-13
   * P2-3).
   */
  resolveEffectiveGroup?: (group: RegisteredGroup) => {
    effectiveGroup: RegisteredGroup;
    isHome: boolean;
  };
  promoteFollowUp?: (
    chatJid: string,
    messageId: string,
    expectedRunId: string,
  ) => Promise<FollowUpActionResult> | FollowUpActionResult;
  cancelFollowUp?: (chatJid: string, messageId: string) => FollowUpActionResult;
  editFollowUp?: (
    chatJid: string,
    messageId: string,
    content: string,
  ) => FollowUpActionResult;
  reorderFollowUp?: (
    chatJid: string,
    messageId: string,
    direction: 'up' | 'down',
  ) => FollowUpActionResult;
  interruptAndRunFollowUp?: (
    chatJid: string,
    messageId: string,
    expectedRunId: string,
  ) => FollowUpActionResult;
}

export type Variables = {
  user: AuthUser;
  sessionId: string;
};

let deps: WebDeps | null = null;
export const wsClients = new Map<WebSocket, WsClientInfo>();
export const MAX_GROUP_NAME_LEN = 40;

export function setWebDeps(d: WebDeps): void {
  deps = d;
}
export function getWebDeps(): WebDeps | null {
  return deps;
}

// lastActiveCache - 5 min debounce for session activity tracking
export const lastActiveCache = new Map<string, number>();
export const LAST_ACTIVE_DEBOUNCE_MS = 5 * 60 * 1000;
const LAST_ACTIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const lastActiveCleanupTimer = setInterval(
  () => {
    const cutoff = Date.now() - LAST_ACTIVE_CACHE_TTL_MS;
    for (const [sessionId, touchedAt] of lastActiveCache.entries()) {
      if (touchedAt < cutoff) lastActiveCache.delete(sessionId);
    }
  },
  60 * 60 * 1000,
);
lastActiveCleanupTimer.unref?.();

// Session data cache — 30s TTL, avoids DB query on every request
const SESSION_CACHE_TTL_MS = 30 * 1000;
const sessionCache = new Map<
  string,
  { data: UserSessionWithUser; expiry: number }
>();

export function getCachedSessionWithUser(
  sessionId: string,
): UserSessionWithUser | undefined {
  const cached = sessionCache.get(sessionId);
  if (cached && cached.expiry > Date.now()) {
    return cached.data;
  }
  sessionCache.delete(sessionId);
  const data = getSessionWithUser(sessionId);
  if (data) {
    sessionCache.set(sessionId, {
      data,
      expiry: Date.now() + SESSION_CACHE_TTL_MS,
    });
  }
  return data;
}

export function invalidateSessionCache(sessionId: string): void {
  sessionCache.delete(sessionId);
  lastActiveCache.delete(sessionId);
}

export function invalidateUserSessions(userId: string): void {
  for (const [sid, entry] of sessionCache.entries()) {
    if (entry.data.user_id === userId) {
      sessionCache.delete(sid);
      lastActiveCache.delete(sid);
    }
  }
}

const sessionCacheCleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [sid, entry] of sessionCache.entries()) {
      if (entry.expiry < now) sessionCache.delete(sid);
    }
  },
  5 * 60 * 1000,
);
sessionCacheCleanupTimer.unref?.();

// Cookie parser - used by middleware and WebSocket
export function parseCookie(
  cookieHeader: string | undefined,
): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const cookie of cookieHeader.split(';')) {
    const pair = cookie.trim();
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

// Group execution helpers
export function isHostExecutionGroup(group: RegisteredGroup): boolean {
  return (group.executionMode || 'container') === 'host';
}

/**
 * Check if a user can access (view messages, send messages to) a group.
 * All users follow the same visibility rules:
 * - is_home groups → only the owner (created_by) can access
 * - IM groups → only the owner
 * - Web groups → only the creator
 */
export function canAccessGroup(
  user: { id: string },
  group: RegisteredGroup & { jid: string },
): boolean {
  if (group.is_home) return group.created_by === user.id;
  // IM groups: check ownership if created_by is set.
  // For legacy rows without created_by, resolve owner from sibling home group.
  if (!group.jid.startsWith('web:')) {
    if (group.created_by === user.id) return true;
    if (group.created_by) return false;
    const siblingJids = getJidsByFolder(group.folder);
    for (const jid of siblingJids) {
      if (jid === group.jid) continue;
      const sibling = getRegisteredGroup(jid);
      if (sibling?.is_home && sibling.created_by) {
        return sibling.created_by === user.id;
      }
    }
    // Ownership cannot be resolved for this IM group → deny by default.
    return false;
  }
  return group.created_by === user.id;
}

/**
 * ISSUE-12 波 7 单元 7.1：canAccessGroup 404 拒绝响应样板收敛（全仓单点）。
 * 守卫行（if (!canAccessGroup(...))）在各路由原文保留——ACL 判定可见性与
 * 注入式测试锚面不变；此处仅收敛 404 响应形状。403（Forbidden/Access
 * denied）与非 return 形状按立项拍板保持原样：403/404 并存是刻意语义
 * （资源隐藏 vs 权限拒绝）。
 */
export function groupAccessDeniedResponse(
  c: Context,
  message: string,
): Response {
  return c.json({ error: message }, 404);
}

/**
 * Check if a user can modify (rename, reset) a group.
 * - Users can modify their own home group.
 * - Users can modify web groups they created.
 * - IM groups can be modified by their owner (created_by).
 */
export function canModifyGroup(
  user: { id: string },
  group: RegisteredGroup & { jid: string },
): boolean {
  if (group.is_home) return group.created_by === user.id;
  if (!group.jid.startsWith('web:')) {
    if (group.created_by) return group.created_by === user.id;
    // Sibling home group fallback for legacy IM groups auto-bound to a home folder.
    const siblingJids = getJidsByFolder(group.folder);
    for (const jid of siblingJids) {
      if (jid === group.jid) continue;
      const sibling = getRegisteredGroup(jid);
      if (sibling?.is_home && sibling.created_by) {
        return sibling.created_by === user.id;
      }
    }
    return false;
  }
  return group.created_by === user.id;
}

/**
 * Check if a user can delete a group.
 * - is_home groups cannot be deleted by anyone.
 */
export function canDeleteGroup(
  user: { id: string },
  group: RegisteredGroup & { jid: string },
): boolean {
  if (group.is_home) return false;
  return canModifyGroup(user, group);
}
