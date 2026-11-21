import type { IpcReplyTurnTracker } from './reply-delivery.js';
import { ActiveTurnOutputRegistry } from './turn-output-coordinator.js';
import { ActiveChannelOutboxScopeRegistry } from './channel-outbox-runtime-scope.js';
import { AgentBuilderTurnRegistry } from './agent-builder-turn-auth.js';
import {
  ActiveChannelTurnRegistry,
  channelTurnScope,
} from './channel-turn-registry.js';

// ISSUE-12 波 4 单元 4.1：host 侧 turn 级注册表自 src/index.ts 原文外迁
// （原 index.ts 1068-1116）。先决单元：后续 src/ipc/* 各模块要读写这些
// 单例，若留守 index.ts 会与其正向 import（index.ts → ipc/*）成环；
// 外迁后 index.ts 与 ipc/* 都从本模块同名 import，全部调用点零改动。
// 搬运体逐字节一致，唯一改写是六个声明前加 export 关键字
// （activeIpcReplyTurnTrackers / activeTurnOutputs / canDeliverTurnUtterance /
// activeAgentBuilderTurns / activeChannelTurns / activeChannelOutboxScopes；
// MAX_REPLIES_PER_TURN 仅为构造参数不导出）。注册表类自各源模块直引，
// 五源模块对 index.ts 零反向依赖（已核）。

// Exact active-turn trackers shared with the independent IPC watcher. Keeping
// only the currently running object avoids stale timestamps/message-id reuse
// across later turns and sibling JIDs that share one folder.
export const activeIpcReplyTurnTrackers = new Map<
  string,
  IpcReplyTurnTracker
>();

// Foreground send_message(progress/final) joins the one host-owned primary
// reply instead of creating an independent provider message. Bindings are
// exact to (workspace/agent scope, immutable input turn).
// Internal runaway-loop fuse, deliberately not configurable. It is a process
// safety invariant rather than a product policy or quota for the model to spend.
const MAX_REPLIES_PER_TURN = 20;
export const activeTurnOutputs = new ActiveTurnOutputRegistry(
  MAX_REPLIES_PER_TURN,
);

/**
 * Per-turn reply fuse shared by every user-visible IPC delivery path.
 *
 * `send_message`, `send_image`, `send_file` and `feishu_send_card` all spend
 * the same budget through `recordDeliveredUtterance`, so they must all consult
 * it before delivering. Gating only one of them lets the unchecked paths drain
 * the budget silently and then refuse the single path that does check.
 *
 * A delivery without an `inputTurnId` is never blocked: it is not recorded
 * against a turn either, so it spends nothing.
 */
export function canDeliverTurnUtterance(
  sourceGroup: string,
  ipcAgentId: string | null | undefined,
  inputTurnId: unknown,
): boolean {
  if (typeof inputTurnId !== 'string' || !inputTurnId) return true;
  return activeTurnOutputs.canDeliverUtterance({
    scopeKey: channelTurnScope(sourceGroup, ipcAgentId),
    inputTurnId,
  });
}

// Host-owned current-turn registry. Agent Builder authorization never trusts
// turn/chat/task claims from the runner's writable IPC JSON.
export const activeAgentBuilderTurns = new AgentBuilderTurnRegistry();

// Exact credential-free provider context for the user input currently being
// answered. Feishu broker IPC is authorized against this host-owned registry;
// runner-supplied chat/account claims are never trusted.
export const activeChannelTurns = new ActiveChannelTurnRegistry();

// Durable output identity for the currently executing channel turn. Runtime
// keys match the IPC routing keys; exact route matching inside the registry
// prevents one thread/account from borrowing another thread's outbox.
export const activeChannelOutboxScopes = new ActiveChannelOutboxScopeRegistry();
