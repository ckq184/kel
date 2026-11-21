import { randomUUID } from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import {
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
  updateRegisteredGroupAvatar,
} from './db.js';
import { logger } from './logger.js';
import {
  saveDownloadedFile,
  sanitizeImFilename,
  buildInlinedFileContent,
} from './im-downloader.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastFollowUpUpdate, broadcastNewMessage } from './web.js';
import { resolveJidByMessageId } from './feishu-streaming-card.js';
import { optimizeMarkdownStyle } from './feishu-markdown-style.js';
import {
  createFeishuBotInfoRefresher,
  type FeishuBotPublicInfo,
} from './feishu-bot-info.js';
import {
  downloadFeishuFileToDisk,
  downloadFeishuImage,
  FEISHU_RESOURCE_REQUEST_TIMEOUT_MS,
  withFeishuHardTimeout,
} from './feishu-media.js';
import {
  createFeishuBackfill,
  FEISHU_CURSOR_SCOPE,
} from './feishu-backfill.js';
import { createFeishuSender } from './feishu-outbound.js';
import { buildFeishuEventHandlers } from './feishu-events.js';
import { createFeishuWsLifecycle } from './feishu-ws-lifecycle.js';
import {
  buildAgentReplyCard,
  buildQueuedFollowUpCard,
} from './feishu-cards/builder.js';
import {
  evaluateMentionGate,
  isBotMentioned,
  stripLeadingBotMention,
  type MentionGateMention,
} from './feishu-mention-gate.js';
import {
  ChannelRouteRejectedError,
  resolveAdmittedChannelRoute,
} from './channel-admission.js';
import {
  extractProviderTarget,
  parseChannelAddress,
  scopeChannelJid,
} from './channel-address.js';
import type { FeishuConversationPlan } from './feishu-conversation-policy.js';
import {
  executeFeishuCapability,
  type FeishuCapabilityRequest,
  type FeishuCapabilityResult,
} from './feishu-capability.js';
import { enrichFeishuInboundContent } from './feishu-rich-content.js';
import {
  advanceChannelCursor,
  claimChannelInboxById,
  claimNextChannelInbox,
  completeChannelInbox,
  failChannelInbox,
  ignoreChannelInbox,
  listChannelCursors,
  recordChannelInbox,
  renewChannelInboxClaim,
  updateClaimedChannelInbox,
  type ClaimedChannelInboxItem,
} from './channel-reliability-store.js';
import {
  ExactAsyncIndicatorRegistry,
  processingIndicatorKey,
} from './processing-indicator.js';
import type {
  ChannelReferencedMessage,
  ChannelTurnContext,
  FeishuMessageMeta,
  FollowUpAction,
  FollowUpActionResult,
  FollowUpDisposition,
  FollowUpMode,
} from './types.js';

// 飞书媒体下载纯函数（readFeishuResourceBuffer / withFeishuHardTimeout 等）已抽至
// ./feishu-media.ts（ISSUE-12 单元 2.2 原文搬运）；readFeishuResourceBuffer 保持自本文件
// re-export，既有导入路径（tests/feishu-resource-timeout.test.ts）不变。
export { readFeishuResourceBuffer } from './feishu-media.js';

// ─── FeishuConnection Interface ────────────────────────────────

export interface FeishuConnectionConfig {
  appId: string;
  appSecret: string;
  /** Optional CKQClaw account id. The scoped source JID remains authoritative. */
  channelAccountId?: string;
}

/** 飞书文件信息（用于下载到工作区） */
interface FeishuFileInfo {
  fileKey: string;
  filename: string;
}

interface ConnectOptions {
  onReady: () => void;
  /** 收到消息后调用，让调用方自动注册未知的飞书聊天 */
  onNewChat?: (chatJid: string, chatName: string) => void;
  /** 斜杠指令回调（如 /clear），返回回复文本或 null；mentions 仅飞书渠道传入，用于 /allow 等命令 */
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
    mentions?: FeishuMentionLike[],
  ) => Promise<string | null>;
  /** 根据 chatJid 解析群组 folder，用于下载文件/图片到工作区 */
  resolveGroupFolder?: (chatJid: string) => string | undefined;
  /** 将 IM chatJid 解析为绑定目标 JID（conversation agent 或工作区主对话） */
  resolveEffectiveChatJid?: (
    chatJid: string,
    messageMeta?: FeishuMessageMeta,
  ) => {
    effectiveJid: string;
    agentId: string | null;
    sourceJid?: string;
  } | null;
  /** 当 IM 消息被路由到 conversation agent 后调用 */
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** Decide whether an inbound message starts now, queues, or steers. */
  onFollowUpMessage?: (input: {
    targetJid: string;
    sourceJid: string;
    messageId: string;
    senderImId: string;
    requestedMode?: FollowUpMode;
    repliedToActiveCard: boolean;
  }) => FollowUpDisposition;
  /** Handle buttons on the compact queued-message card. */
  onFollowUpCardAction?: (input: {
    sourceJid: string;
    targetJid: string;
    messageId: string;
    action: FollowUpAction;
    expectedRunId: string;
    operatorImId: string;
  }) => Promise<FollowUpActionResult> | FollowUpActionResult;
  /** Bot 被添加到群聊时调用（自动注册群组） */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot 被移出群聊或群被解散时调用（自动解绑 IM 绑定） */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** 群聊消息过滤：bot 未被 @mention 时调用，返回 true 则处理，false 则丢弃 */
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** Resolve durable Feishu topic presence and the session-routing plan. */
  resolveFeishuConversationPlan?: (
    chatJid: string,
    messageMeta: FeishuMessageMeta,
  ) => FeishuConversationPlan;
  /** owner_mentioned 模式下检查发送者是否为 owner */
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** 发言者白名单：命令处理之后、mention 门控之前调用；返回 false 则丢弃 */
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  /** 飞书流式卡片按钮中断回调 */
  onCardInterrupt?: (
    chatJid: string,
    operatorImId: string,
  ) => FollowUpActionResult;
  /** P2P（私聊）消息到达时调用，用于自动检测 bot owner 的 open_id */
  onP2pSender?: (senderOpenId: string) => void;
  normalizeIncomingJid?: (jid: string) => string;
  /** Recovery gate: durable Inbox remains replayable instead of ignored. */
  shouldDeferInbound?: () => boolean;
}

interface FeishuChatInfo {
  avatar?: string;
  name?: string;
  user_count?: string;
  chat_type?: string;
  chat_mode?: string; // 'p2p' | 'group' | 'topic'
  group_message_type?: string; // 'chat' | 'thread'
}

export interface FeishuConnection {
  connect(opts: ConnectOptions): Promise<boolean>;
  stop(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
    options?: { presentation?: 'default' | 'native' },
  ): Promise<void>;
  sendImage(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void>;
  sendFile(chatId: string, filePath: string, fileName: string): Promise<void>;
  /** Clear the "OnIt" ack reaction owned by one exact inbound input. */
  clearAckReaction(chatId: string, inputMessageId: string): Promise<void>;
  isConnected(): boolean;
  syncGroups(): Promise<void>;
  getChatInfo(chatId: string): Promise<FeishuChatInfo | null>;
  executeCapability(
    context: ChannelTurnContext,
    request: FeishuCapabilityRequest,
  ): Promise<FeishuCapabilityResult>;
  /** Get the underlying Lark SDK client (for streaming cards) */
  getLarkClient(): lark.Client | null;
  /** Get the last received message ID for a chat (for reply threading) */
  getLastMessageId(chatId: string): string | undefined;
}

// ─── Shared Helpers (pure functions, no instance state) ────────

// Feishu card allows at most 5 markdown tables; beyond this, skip card and use post+md directly
const CARD_TABLE_LIMIT = 5;
const FEISHU_INBOX_LEASE_MS = 5 * 60 * 1000;
const FEISHU_INBOX_HEARTBEAT_MS = 60 * 1000;
const FEISHU_INBOX_RETRY_DELAY_MS = 5_000;
const FEISHU_INBOX_GATE_RETRY_DELAY_MS = 250;
const FEISHU_INBOX_RECOVERY_LIMIT = 500;
// "因 botOpenId 缺失而丢消息" 的 warn 节流间隔，避免日志刷屏
const BOT_INFO_MISSING_WARN_INTERVAL_MS = 5 * 60 * 1000;

interface FeishuMentionLike {
  key?: string;
  name?: string;
  id?: { open_id?: string; user_id?: string; union_id?: string };
}

class FeishuTextDeliveryError extends Error {
  readonly outcome: 'rejected' | 'uncertain';

  constructor(
    message: string,
    outcome: 'rejected' | 'uncertain',
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'FeishuTextDeliveryError';
    this.outcome = outcome;
  }
}

class FeishuApiRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuApiRejectedError';
  }
}

type FeishuSlashCommandCheckpoint =
  | {
      version: 1;
      kind: 'feishu_slash_command';
      state: 'executing';
      command: string;
      replyTarget: string;
    }
  | {
      version: 1;
      kind: 'feishu_slash_command';
      state: 'pending_reply' | 'sending_reply' | 'reply_acknowledged';
      command: string;
      replyTarget: string;
      replyText: string;
    };

function parseFeishuSlashCommandCheckpoint(
  value: unknown,
): FeishuSlashCommandCheckpoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const checkpoint = value as Record<string, unknown>;
  if (
    checkpoint.version !== 1 ||
    checkpoint.kind !== 'feishu_slash_command' ||
    typeof checkpoint.command !== 'string' ||
    !checkpoint.command ||
    typeof checkpoint.replyTarget !== 'string' ||
    !checkpoint.replyTarget ||
    (checkpoint.state !== 'executing' &&
      checkpoint.state !== 'pending_reply' &&
      checkpoint.state !== 'sending_reply' &&
      checkpoint.state !== 'reply_acknowledged')
  ) {
    return undefined;
  }
  if (checkpoint.state === 'executing') {
    return checkpoint as FeishuSlashCommandCheckpoint;
  }
  return typeof checkpoint.replyText === 'string'
    ? (checkpoint as FeishuSlashCommandCheckpoint)
    : undefined;
}

interface IncomingMessagePayload {
  chatId: string;
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  createTimeMs: number;
  messageType: string;
  content: string;
  chatType?: string;
  mentions?: FeishuMentionLike[];
  senderOpenId?: string;
  senderUserId?: string;
  senderUnionId?: string;
  senderName?: string;
  senderTenantKey?: string;
  senderType?: string;
}

interface CachedFeishuChatInfo {
  name?: string;
  chatType?: string;
  chatMode?: string;
  groupMessageType?: string;
}

const FEISHU_CHANNEL_CAPABILITIES = [
  'get_channel_context',
  'send_message',
  'send_image',
  'send_file',
  'feishu_get_chat',
  'feishu_list_members',
  'feishu_get_user',
  'feishu_get_history',
  'feishu_send_card',
  'feishu_add_reaction',
  'feishu_remove_reaction',
  'feishu_edit_message',
  'feishu_recall_message',
  'feishu_api_request',
] as const;

export function buildFeishuChannelTurnContext(input: {
  appId: string;
  configuredChannelAccountId?: string;
  bot?: FeishuBotPublicInfo;
  chat: {
    id: string;
    type?: string;
    name?: string;
    mode?: string;
    groupMessageType?: string;
  };
  message: {
    id: string;
    rootId?: string;
    parentId?: string;
    threadId?: string;
    type?: string;
    referencedMessages?: ChannelReferencedMessage[];
  };
  sender?: {
    openId?: string;
    userId?: string;
    unionId?: string;
    name?: string;
    tenantKey?: string;
    type?: string;
  };
  mentions?: FeishuMentionLike[];
  sourceJid: string;
  targetJid?: string;
  sessionAgentId?: string | null;
}): ChannelTurnContext {
  const parsedSource = parseChannelAddress(input.sourceJid);
  const chatType =
    input.chat.type === 'p2p' || input.chat.type === 'group'
      ? input.chat.type
      : undefined;
  const isTopicStyle =
    input.chat.mode === 'topic' || input.chat.groupMessageType === 'thread';
  return {
    schemaVersion: 1,
    provider: 'feishu',
    channelAccountId:
      parsedSource?.channelAccountId ??
      input.configuredChannelAccountId ??
      null,
    sourceJid: input.sourceJid,
    ...(input.targetJid ? { targetJid: input.targetJid } : {}),
    ...(input.sessionAgentId !== undefined
      ? { sessionAgentId: input.sessionAgentId }
      : {}),
    bot: {
      ...(input.appId ? { appId: input.appId } : {}),
      ...(input.bot?.openId ? { openId: input.bot.openId } : {}),
      ...(input.bot?.name ? { name: input.bot.name } : {}),
      ...(input.bot?.avatarUrl ? { avatarUrl: input.bot.avatarUrl } : {}),
    },
    chat: {
      id: input.chat.id,
      ...(chatType ? { type: chatType } : {}),
      ...(input.chat.name ? { name: input.chat.name } : {}),
      ...(input.chat.mode ? { mode: input.chat.mode } : {}),
      ...(input.chat.groupMessageType
        ? { groupMessageType: input.chat.groupMessageType }
        : {}),
      ...(input.chat.mode || input.chat.groupMessageType
        ? { isTopicStyle }
        : {}),
    },
    message: {
      id: input.message.id,
      ...(input.message.rootId ? { rootId: input.message.rootId } : {}),
      ...(input.message.parentId ? { parentId: input.message.parentId } : {}),
      ...(input.message.threadId ? { threadId: input.message.threadId } : {}),
      ...(input.message.type ? { type: input.message.type } : {}),
      ...(input.message.referencedMessages?.length
        ? { referencedMessages: input.message.referencedMessages }
        : {}),
    },
    sender: input.sender
      ? {
          ...(input.sender.openId ? { openId: input.sender.openId } : {}),
          ...(input.sender.userId ? { userId: input.sender.userId } : {}),
          ...(input.sender.unionId ? { unionId: input.sender.unionId } : {}),
          ...(input.sender.name ? { name: input.sender.name } : {}),
          ...(input.sender.tenantKey
            ? { tenantKey: input.sender.tenantKey }
            : {}),
          ...(input.sender.type ? { type: input.sender.type } : {}),
        }
      : undefined,
    mentions: input.mentions?.map((mention) => ({
      ...(mention.key ? { key: mention.key } : {}),
      ...(mention.name ? { name: mention.name } : {}),
      ...(mention.id?.open_id ? { openId: mention.id.open_id } : {}),
      ...(mention.id?.user_id ? { userId: mention.id.user_id } : {}),
      ...(mention.id?.union_id ? { unionId: mention.id.union_id } : {}),
    })),
    capabilities: [...FEISHU_CHANNEL_CAPABILITIES],
  };
}

function toEpochMs(value: string | number | undefined): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 1e12 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
}

interface FeishuRouteTarget {
  raw: string;
  chatId: string;
  threadId?: string;
  rootMessageId?: string;
  replyInThread: boolean;
}

export function parseFeishuRouteTarget(raw: string): FeishuRouteTarget {
  const [chatId, ...parts] = raw.split('#');
  let threadId: string | undefined;
  let rootMessageId: string | undefined;
  for (const part of parts) {
    if (part.startsWith('thread:')) {
      threadId = part.slice('thread:'.length);
    } else if (part.startsWith('root:')) {
      rootMessageId = part.slice('root:'.length);
    }
  }
  return {
    raw,
    chatId,
    threadId,
    rootMessageId,
    replyInThread: !!rootMessageId,
  };
}

export function resolveFeishuMessageAnchor(input: {
  target: FeishuRouteTarget;
  chatType?: string;
  lastMessageId?: string;
}): string | undefined {
  if (input.target.rootMessageId) return input.target.rootMessageId;
  // A group's latest inbound message may belong to any concurrently active
  // topic. Never infer an output or reaction target from that mutable value.
  return input.chatType === 'p2p' ? input.lastMessageId : undefined;
}

function requireFeishuRouteTarget(raw: string): FeishuRouteTarget {
  const target = parseFeishuRouteTarget(raw);
  const fragments = raw.split('#').slice(1);
  const seen = new Set<string>();
  const valid =
    target.chatId.length > 0 &&
    target.chatId.trim() === target.chatId &&
    !/\s/.test(target.chatId) &&
    fragments.every((fragment) => {
      const separator = fragment.indexOf(':');
      if (separator <= 0 || separator === fragment.length - 1) return false;
      const kind = fragment.slice(0, separator);
      const value = fragment.slice(separator + 1);
      if ((kind !== 'thread' && kind !== 'root') || seen.has(kind)) {
        return false;
      }
      seen.add(kind);
      return value.trim() === value && !/\s/.test(value);
    }) &&
    (!target.threadId || !!target.rootMessageId);
  if (!valid) {
    throw new Error(`Invalid Feishu route target: ${raw || '<empty>'}`);
  }
  return target;
}

function assertFeishuApiSuccess(operation: string, response: unknown): void {
  if (!response || typeof response !== 'object') {
    throw new Error(`${operation} returned no acknowledgement`);
  }
  const result = response as { code?: number; msg?: string };
  if (result.code !== 0) {
    throw new FeishuApiRejectedError(
      `${operation} failed (code=${result.code ?? 'unknown'}, msg=${result.msg || 'unknown'})`,
    );
  }
}

const FEISHU_THREAD_REPLY_UNSUPPORTED_CODES = new Set([230071, 230072]);

function feishuApiErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    const match = String(error).match(/code[=:]\s*(\d+)/i);
    return match ? Number(match[1]) : undefined;
  }
  const value = error as {
    code?: number;
    message?: string;
    response?: { code?: number; data?: { code?: number } };
  };
  if (typeof value.code === 'number') return value.code;
  if (typeof value.response?.data?.code === 'number') {
    return value.response.data.code;
  }
  if (typeof value.response?.code === 'number') return value.response.code;
  const match = value.message?.match(/code[=:]\s*(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

/**
 * Upload endpoints in the official Lark SDK unwrap successful responses to
 * `{ image_key }` / `{ file_key }` and therefore do not include `code: 0`.
 * Error-shaped responses can still carry `code`/`msg` (and mocked clients do
 * so in tests), so preserve those details while accepting the SDK's real
 * success contract.
 */
function requireFeishuUploadKey(
  operation: string,
  response: unknown,
  key: 'image_key' | 'file_key',
): string {
  if (!response || typeof response !== 'object') {
    throw new Error(`${operation} returned no acknowledgement`);
  }
  const result = response as {
    code?: number;
    msg?: string;
    image_key?: string;
    file_key?: string;
    data?: { image_key?: string; file_key?: string };
  };
  if (typeof result.code === 'number' && result.code !== 0) {
    throw new Error(
      `${operation} failed (code=${result.code}, msg=${result.msg || 'unknown'})`,
    );
  }
  const uploadKey = result[key] ?? result.data?.[key];
  if (!uploadKey) {
    throw new Error(`${operation} returned no ${key}`);
  }
  return uploadKey;
}

export function buildFeishuRouteTarget(
  chatId: string,
  threadId?: string,
  rootMessageId?: string,
): FeishuRouteTarget {
  const parts = [chatId];
  if (threadId) parts.push(`thread:${threadId}`);
  if (rootMessageId) parts.push(`root:${rootMessageId}`);
  return parseFeishuRouteTarget(parts.join('#'));
}

/**
 * Build a route JID for a thread/root target.
 *
 * `target.raw` is assembled from the raw provider `chat_id`, so it carries no
 * account scope. Emitting it directly produced a JID that `getRegisteredGroup`
 * could not match once inbound JIDs were account-scoped, which made the whole
 * turn fail closed: no outbound route, no warm-session admission, not even the
 * tail interruption notice. Re-apply the scope from the already-normalized base
 * JID — `scopeChannelJid` preserves provider-native thread/root fragments.
 *
 * The native-topic branch keeps its own builder (`buildNativeThreadRouteJid`),
 * which appends onto the normalized JID for the same reason.
 */
function feishuRouteToJid(
  target: FeishuRouteTarget,
  accountScopedBaseJid?: string,
): string {
  const jid = `feishu:${target.raw}`;
  const accountId = accountScopedBaseJid
    ? parseChannelAddress(accountScopedBaseJid)?.channelAccountId
    : undefined;
  return accountId ? scopeChannelJid(jid, accountId) : jid;
}

/**
 * Extract message content from Feishu message.
 * Returns text content, optional image keys, and optional file infos for download.
 */
function extractMessageContent(
  messageType: string,
  content: string,
): { text: string; imageKeys?: string[]; fileInfos?: FeishuFileInfo[] } {
  // merge_forward: WebSocket 推送的内容是纯字符串 "Merged and Forwarded Message"（非 JSON），
  // 必须在 JSON.parse 之前单独处理，否则 parse 失败导致消息被丢弃
  if (messageType === 'merge_forward') {
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { text: '[合并转发消息]' };
    }
    const items = parsed.message_list || parsed.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return { text: '[合并转发消息]' };
    }
    const lines: string[] = ['[合并转发消息]:'];
    for (const item of items.slice(0, 20)) {
      const sender = item.sender_name || item.sender || '未知';
      const body = item.body?.content || item.content || '';
      let text = '';
      try {
        const subType = item.msg_type || item.message_type || 'text';
        const sub = extractMessageContent(subType, body);
        text = sub.text || '';
      } catch {
        text = typeof body === 'string' ? body : '';
      }
      if (text) {
        lines.push(`> ${sender}: ${text.split('\n')[0].slice(0, 200)}`);
      }
    }
    if (items.length > 20) {
      lines.push(`> ... 共 ${items.length} 条消息`);
    }
    return { text: lines.join('\n') };
  }

  try {
    const parsed = JSON.parse(content);

    if (messageType === 'text') {
      return { text: parsed.text || '' };
    }

    if (messageType === 'post') {
      // Extract text and inline images from rich post content.
      const lines: string[] = [];
      const imageKeys: string[] = [];
      // 飞书 post 消息有三种已知格式：
      // 1. 带 post + 语言包裹：{"post": {"zh_cn": {"title": "...", "content": [[...]]}}}
      // 2. 仅语言包裹：{"zh_cn": {"title": "...", "content": [[...]]}}
      // 3. 无包裹（直接 title+content）：{"title": "...", "content": [[...]]}
      const post = parsed.post || parsed;
      if (!post || typeof post !== 'object') {
        logger.warn(
          { keys: Object.keys(parsed) },
          'Empty post object in post message',
        );
        return { text: '' };
      }

      // 判断 contentData：如果 post 本身就有 content 数组，直接用；否则查找语言层
      let contentData: any;
      if (Array.isArray(post.content)) {
        // 格式 3：无包裹，post 本身就是 {title, content}
        contentData = post;
        logger.debug('Post message using flat format (no locale wrapper)');
      } else {
        // 格式 1/2：有语言层包裹
        contentData = post.zh_cn || post.en_us || Object.values(post)[0];
      }
      if (!contentData || !Array.isArray(contentData.content)) {
        logger.warn(
          { keys: Object.keys(post) },
          'Missing content array in post message',
        );
        return { text: '' };
      }

      // Include post title if present
      if (contentData.title && typeof contentData.title === 'string') {
        lines.push(contentData.title);
      }

      for (const paragraph of contentData.content) {
        // Handle both array paragraphs and flat object segments
        const segments = Array.isArray(paragraph)
          ? paragraph
          : paragraph && typeof paragraph === 'object'
            ? [paragraph]
            : null;
        if (!segments) continue;
        const parts: string[] = [];
        for (const segment of segments) {
          if (!segment || typeof segment !== 'object') continue;
          if (segment.tag === 'text' && typeof segment.text === 'string') {
            parts.push(segment.text);
          } else if (segment.tag === 'a' && typeof segment.text === 'string') {
            parts.push(segment.text);
          } else if (segment.tag === 'at') {
            const mentionName =
              typeof segment.user_name === 'string'
                ? segment.user_name
                : typeof segment.text === 'string'
                  ? segment.text
                  : typeof segment.name === 'string'
                    ? segment.name
                    : '用户';
            parts.push(`@${mentionName}`);
          } else if (
            segment.tag === 'img' &&
            typeof segment.image_key === 'string'
          ) {
            imageKeys.push(segment.image_key);
            parts.push('[图片]');
          } else if (segment.tag === 'media') {
            parts.push('[视频]');
          } else if (
            segment.tag === 'emotion' &&
            typeof segment.emoji_type === 'string'
          ) {
            parts.push(`:${segment.emoji_type}:`);
          } else if (typeof segment.text === 'string') {
            parts.push(segment.text);
          }
        }
        if (parts.length > 0) lines.push(parts.join(''));
      }

      return {
        text: lines.join('\n'),
        imageKeys: imageKeys.length > 0 ? imageKeys : undefined,
      };
    }

    if (messageType === 'image') {
      const imageKey = parsed.image_key;
      if (imageKey) {
        return { text: '', imageKeys: [imageKey] };
      }
    }

    if (messageType === 'file') {
      const fileKey = parsed.file_key;
      const filename = parsed.file_name || '';
      if (fileKey) {
        // 使用清洗后的文件名构造占位符，下方 replace 也用同一份清洗结果，
        // 任何上下文（成功/失败/解析失败）都不会让原始 filename 进入 prompt。
        const safeFilename = sanitizeImFilename(filename || fileKey);
        return {
          text: `[文件: ${safeFilename}]`,
          fileInfos: [{ fileKey, filename }],
        };
      }
    }

    if (messageType === 'sticker') {
      const stickerDesc = parsed.description || parsed.sticker_id || '表情包';
      return { text: `[表情包: ${stickerDesc}]` };
    }

    if (messageType === 'audio') {
      const duration = parsed.duration
        ? `${Math.round(parsed.duration / 1000)}s`
        : '';
      return { text: `[语音消息${duration ? ': ' + duration : ''}]` };
    }

    if (messageType === 'share_chat') {
      const chatName = parsed.chat_name || parsed.chat_id || '未知群聊';
      return { text: `[分享群聊: ${chatName}]` };
    }

    if (messageType === 'share_user') {
      const userName = parsed.user_name || parsed.user_id || '未知用户';
      return { text: `[分享用户: ${userName}]` };
    }

    if (messageType === 'system') {
      const body = parsed.body || parsed.content || '';
      const systemText = typeof body === 'string' ? body : JSON.stringify(body);
      return { text: `[系统消息: ${systemText.slice(0, 200)}]` };
    }

    if (messageType === 'interactive') {
      // Extract title and text elements from interactive card messages
      const parts: string[] = [];
      if (parsed.title) {
        parts.push(parsed.title);
      }
      if (Array.isArray(parsed.elements)) {
        for (const row of parsed.elements) {
          if (!Array.isArray(row)) continue;
          for (const el of row) {
            if (!el || typeof el !== 'object') continue;
            if (el.tag === 'text' && typeof el.text === 'string') {
              parts.push(el.text);
            } else if (el.tag === 'a' && typeof el.text === 'string') {
              parts.push(`[${el.text}](${el.href || ''})`);
            } else if (el.tag === 'note' && Array.isArray(el.elements)) {
              const noteText = el.elements
                .filter(
                  (n: any) => n.tag === 'text' && typeof n.text === 'string',
                )
                .map((n: any) => n.text)
                .join('');
              if (noteText) parts.push(noteText);
            }
            // Skip buttons, hr, select_static, img — not useful as text
          }
        }
      }
      const cardText = parts.filter(Boolean).join('\n');
      return { text: cardText || '[飞书卡片消息]' };
    }

    if (messageType === 'media') {
      return { text: '[视频消息]' };
    }

    if (messageType === 'location') {
      return {
        text: `[位置: ${parsed.name || parsed.address || '未知位置'}]`,
      };
    }

    if (messageType === 'share_calendar_event') {
      return {
        text: `[日程分享: ${parsed.summary || parsed.event_id || ''}]`,
      };
    }

    if (messageType === 'video_chat') {
      return { text: `[视频会议: ${parsed.topic || ''}]` };
    }

    if (messageType === 'todo') {
      return {
        text: `[待办: ${parsed.task_id || parsed.summary || ''}]`,
      };
    }

    if (messageType === 'hongbao') {
      return { text: '[红包消息]' };
    }

    // 未知消息类型：返回类型占位符，避免静默丢弃
    return { text: `[${messageType}]` };
  } catch (err) {
    logger.warn(
      { err, messageType, content },
      'Failed to parse message content',
    );
    return { text: `[${messageType}]` };
  }
}

/**
 * Map file extension to Feishu file type.
 */
function getFileType(
  ext: string,
): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const map: Record<
    string,
    'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'
  > = {
    '.pdf': 'pdf',
    '.doc': 'doc',
    '.docx': 'doc',
    '.xls': 'xls',
    '.xlsx': 'xls',
    '.ppt': 'ppt',
    '.pptx': 'ppt',
    '.mp4': 'mp4',
    '.opus': 'opus',
  };
  return map[ext.toLowerCase()] || 'stream';
}

/**
 * Build a Feishu interactive card (Schema 2.0) from markdown text.
 * Applies optimizeMarkdownStyle() for proper rendering in Feishu cards:
 * - Heading demotion (H1→H4, H2~H6→H5)
 * - Code block / table spacing with <br>
 * - Invalid image cleanup
 */
// Feishu documents a generous total post limit, but large single `md` elements
// have produced provider-side 2200 errors in real threads. Keep one physical
// message/Outbox row while using smaller rich-text nodes inside that message.
export const FEISHU_POST_MD_NODE_MAX_BYTES = 2_400;

function takeUtf8Prefix(
  value: string,
  maxBytes: number,
): { prefix: string; rest: string } {
  let bytes = 0;
  let consumedCodeUnits = 0;
  for (const character of value) {
    const nextBytes = Buffer.byteLength(character);
    if (bytes + nextBytes > maxBytes) break;
    bytes += nextBytes;
    consumedCodeUnits += character.length;
  }
  return {
    prefix: value.slice(0, consumedCodeUnits),
    rest: value.slice(consumedCodeUnits),
  };
}

interface MarkdownFence {
  marker: string;
  opener: string;
}

function nextMarkdownFence(
  line: string,
  current: MarkdownFence | null,
): MarkdownFence | null {
  const trimmed = line.trim();
  if (!current) {
    const opener = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (!opener) return null;
    return {
      marker: opener[1],
      // Language identifiers are short in valid Markdown. Bounding an
      // adversarial opener keeps continuation overhead below the node budget.
      opener: Buffer.byteLength(trimmed) <= 128 ? trimmed : opener[1],
    };
  }
  const closingPattern = new RegExp(
    `^${current.marker[0]}{${current.marker.length},}\\s*$`,
  );
  return closingPattern.test(trimmed) ? null : current;
}

/**
 * Split optimized Markdown into several `md` elements without creating
 * additional provider messages. UTF-8 byte accounting avoids breaking CJK or
 * emoji, and long fenced blocks are closed/reopened at node boundaries so each
 * element renders independently.
 */
export function splitFeishuPostMarkdown(
  markdown: string,
  maxBytes = FEISHU_POST_MD_NODE_MAX_BYTES,
): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 256) {
    throw new Error(
      'Feishu post Markdown node budget must be at least 256 bytes',
    );
  }
  if (!markdown) return [''];

  const chunks: string[] = [];
  let current = '';
  let fence: MarkdownFence | null = null;
  const flush = (): void => {
    if (!current) return;
    const closing = fence ? `\n${fence.marker}` : '';
    chunks.push(`${current}${closing}`);
    current = fence ? `${fence.opener}\n` : '';
  };

  const lines = markdown.match(/[^\n]*\n|[^\n]+$/g) ?? [markdown];
  for (const line of lines) {
    let remaining = line;
    while (remaining) {
      const closingReserve = fence ? Buffer.byteLength(`\n${fence.marker}`) : 0;
      const available = maxBytes - Buffer.byteLength(current) - closingReserve;
      if (available <= 0) {
        flush();
        continue;
      }
      if (Buffer.byteLength(remaining) <= available) {
        current += remaining;
        remaining = '';
        fence = nextMarkdownFence(line, fence);
        continue;
      }
      const { prefix, rest } = takeUtf8Prefix(remaining, available);
      if (!prefix) {
        flush();
        continue;
      }
      current += prefix;
      remaining = rest;
      flush();
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [''];
}

/** Build a post+md fallback content string for when interactive card send fails. */
export function buildPostMdFallback(text: string): string {
  const optimized = optimizeMarkdownStyle(text, 1);
  return JSON.stringify({
    zh_cn: {
      content: splitFeishuPostMarkdown(optimized).map((chunk) => [
        { tag: 'md', text: chunk },
      ]),
    },
  });
}

function buildInteractiveCard(text: string): object {
  return buildAgentReplyCard({ status: 'done', text });
}

// ─── Factory Function ──────────────────────────────────────────

/**
 * Create an independent Feishu connection instance.
 * Each instance manages its own client, WebSocket, and state maps.
 */
export function createFeishuConnection(
  config: FeishuConnectionConfig,
): FeishuConnection {
  // Per-instance state
  const reliabilityAccountId =
    config.channelAccountId?.trim() || `app:${config.appId}`;
  const inboxOwner = `feishu:${reliabilityAccountId}:${randomUUID()}`;
  const senderNameCache = new Map<string, string>();
  const lastMessageIdByChat = new Map<string, string>();
  const ackReactions = new ExactAsyncIndicatorRegistry<{
    messageId: string;
    reactionId: string;
  }>();
  const inboxHeartbeatByClaim = new Map<string, NodeJS.Timeout>();
  const knownChatIds = new Set<string>();
  const chatTypeById = new Map<string, string>(); // chatId → 'group' | 'p2p'
  const chatInfoById = new Map<string, CachedFeishuChatInfo>();

  let client: lark.Client | null = null;
  let wsClient: lark.WSClient | null = null;
  let eventDispatcher: lark.EventDispatcher | null = null;
  let connectOptions: ConnectOptions | null = null;
  let reconnecting = false;
  let backfillRunning = false;
  let reconnectRequestedAt = 0;
  let lastWsStateConnected = false;
  let disconnectedChecks = 0;
  let healthTimer: NodeJS.Timeout | null = null;
  let inboxRecoveryTimer: NodeJS.Timeout | null = null;
  // mention gate fail-closed 的 warn 节流：避免 botOpenId 长时间缺失时日志洪水
  let lastBotInfoMissingWarnAt = 0;
  let botInfoMissingDroppedSinceLastWarn = 0;

  function rememberChatProgress(
    chatId: string,
    createTimeMs: number,
    chatType?: string,
  ): void {
    knownChatIds.add(chatId);
    if (chatType) chatTypeById.set(chatId, chatType);
    void createTimeMs;
  }

  function inboundPosition(
    payload: IncomingMessagePayload,
    claim?: Pick<ClaimedChannelInboxItem, 'createdAt'>,
  ): number {
    if (
      Number.isSafeInteger(payload.createTimeMs) &&
      payload.createTimeMs > 0
    ) {
      return payload.createTimeMs;
    }
    const recordedAt = claim ? Date.parse(claim.createdAt) : Number.NaN;
    return Number.isSafeInteger(recordedAt) && recordedAt > 0
      ? recordedAt
      : Date.now();
  }

  /**
   * A terminal Inbox row and its cursor intentionally form a recoverable pair:
   * if the process dies between the two writes, a duplicate WS/backfill event
   * sees the terminal row and calls this again, repairing the cursor without
   * re-running user code.
   */
  function rememberTerminalProgress(
    payload: IncomingMessagePayload,
    claim?: Pick<ClaimedChannelInboxItem, 'createdAt'>,
  ): void {
    const position = inboundPosition(payload, claim);
    try {
      advanceChannelCursor({
        provider: 'feishu',
        accountId: reliabilityAccountId,
        scope: FEISHU_CURSOR_SCOPE,
        chatId: payload.chatId,
        cursor: payload.messageId,
        position,
        tieBreaker: payload.messageId,
      });
      rememberChatProgress(payload.chatId, position, payload.chatType);
    } catch (err) {
      logger.error(
        { err, chatId: payload.chatId, messageId: payload.messageId },
        'Failed to advance durable Feishu cursor; a duplicate/backfill will repair it',
      );
    }
  }

  function completeClaimedInbound(
    claim: ClaimedChannelInboxItem,
    payload: IncomingMessagePayload,
  ): void {
    stopInboxHeartbeat(claim);
    if (!completeChannelInbox(claim)) {
      logger.warn(
        { inboxId: claim.id, messageId: payload.messageId },
        'Lost Feishu Inbox lease before completion',
      );
      return;
    }
    rememberTerminalProgress(payload, claim);
  }

  function ignoreClaimedInbound(
    claim: ClaimedChannelInboxItem,
    payload: IncomingMessagePayload,
    reason: string,
  ): void {
    stopInboxHeartbeat(claim);
    if (!ignoreChannelInbox(claim, reason)) {
      logger.warn(
        { inboxId: claim.id, messageId: payload.messageId, reason },
        'Lost Feishu Inbox lease before ignore transition',
      );
      return;
    }
    rememberTerminalProgress(payload, claim);
  }

  function failClaimedInbound(
    claim: ClaimedChannelInboxItem,
    payload: IncomingMessagePayload,
    error: unknown,
    retry: boolean,
    retryDelayMs = FEISHU_INBOX_RETRY_DELAY_MS,
  ): void {
    stopInboxHeartbeat(claim);
    const message = error instanceof Error ? error.message : String(error);
    const changed = failChannelInbox(claim, {
      error: message,
      ...(retry
        ? {
            retryAt: new Date(Date.now() + retryDelayMs).toISOString(),
          }
        : {}),
    });
    if (!changed) {
      logger.warn(
        { inboxId: claim.id, messageId: payload.messageId, retry },
        'Lost Feishu Inbox lease before failure transition',
      );
      return;
    }
    if (!retry) {
      rememberTerminalProgress(payload, claim);
    } else {
      scheduleInboxRecovery(retryDelayMs);
    }
  }

  function claimHeartbeatKey(
    claim: Pick<ClaimedChannelInboxItem, 'id' | 'leaseToken'>,
  ): string {
    return `${claim.id}:${claim.leaseToken}`;
  }

  function stopInboxHeartbeat(
    claim: Pick<ClaimedChannelInboxItem, 'id' | 'leaseToken'>,
  ): void {
    const key = claimHeartbeatKey(claim);
    const timer = inboxHeartbeatByClaim.get(key);
    if (!timer) return;
    clearInterval(timer);
    inboxHeartbeatByClaim.delete(key);
  }

  function startInboxHeartbeat(claim: ClaimedChannelInboxItem): void {
    const key = claimHeartbeatKey(claim);
    stopInboxHeartbeat(claim);
    const timer = setInterval(() => {
      try {
        if (!renewChannelInboxClaim(claim, FEISHU_INBOX_LEASE_MS)) {
          stopInboxHeartbeat(claim);
          logger.warn(
            { inboxId: claim.id, leaseToken: claim.leaseToken },
            'Lost Feishu Inbox lease during heartbeat renewal',
          );
        }
      } catch (err) {
        // A transient SQLite error must not permanently disable renewal. The
        // next tick retries while the current lease remains fenced.
        logger.warn(
          { err, inboxId: claim.id, leaseToken: claim.leaseToken },
          'Feishu Inbox heartbeat renewal failed',
        );
      }
    }, FEISHU_INBOX_HEARTBEAT_MS);
    timer.unref?.();
    inboxHeartbeatByClaim.set(key, timer);
  }

  function scheduleInboxRecovery(delayMs = FEISHU_INBOX_RETRY_DELAY_MS): void {
    if (!connectOptions) return;
    // A startup/shutdown gate requests a prompt drain. Replace a slower
    // generic retry timer instead of making the just-opened service wait 5s.
    if (inboxRecoveryTimer) clearTimeout(inboxRecoveryTimer);
    inboxRecoveryTimer = setTimeout(
      () => {
        inboxRecoveryTimer = null;
        void recoverQueuedInbox('retry-timer').catch((err) => {
          logger.error({ err }, 'Scheduled Feishu Inbox recovery failed');
        });
      },
      Math.max(25, delayMs) + 50,
    );
    inboxRecoveryTimer.unref?.();
  }

  function restoreDurableChatProgress(): void {
    try {
      for (const cursor of listChannelCursors({
        provider: 'feishu',
        accountId: reliabilityAccountId,
        limit: 10_000,
      })) {
        if (cursor.scope !== FEISHU_CURSOR_SCOPE || !cursor.chatId) continue;
        rememberChatProgress(cursor.chatId, cursor.position);
      }
    } catch (err) {
      // Some isolated transport tests intentionally instantiate Feishu without
      // initializing the application DB. Production startup always binds it.
      logger.warn(
        { err, accountId: reliabilityAccountId },
        'Unable to restore durable Feishu cursors',
      );
    }
  }

  // WS 状态探查（getWsConnectionState，lark SDK 私有属性访问，探查失败
  // 静默降级语义保留）与健康监控（startHealthMonitor / stopHealthMonitor）
  // 已抽至 ./feishu-ws-lifecycle.ts（ISSUE-12 单元 2.6 原文搬运；探查函数
  // 与重连逻辑同模块）；访问器注入与工厂接线见下方 createFeishuWsLifecycle。

  // bot open_id 拉取、指数退避与 lazy refetch 自愈已抽至 ./feishu-bot-info.ts
  // （ISSUE-12 单元 2.1 原文搬运）；外层 client 为可变 let，经访问器注入。
  const botInfoRefresher = createFeishuBotInfoRefresher(() => client);
  const { fetchBotOpenIdOnce, fetchBotOpenIdWithRetry, ensureBotOpenIdFresh } =
    botInfoRefresher;

  // 图片/文件下载（downloadFeishuImage / downloadFeishuFileToDisk）与头部媒体纯函数
  // （readFeishuResourceBuffer / withFeishuHardTimeout）已抽至 ./feishu-media.ts
  // （ISSUE-12 单元 2.2 原文搬运）；client 经 () => client 访问器注入。

  // 底层发送链（F8 辅助群 getSenderName/addReaction/removeReactionStrict/
  // clearAckForInput/p2pLastMessageId、F9 replyToFeishuMessage/sendToFeishu 与
  // connection 门面 sendMessage/sendImage/sendFile 本体）已抽至
  // ./feishu-outbound.ts（ISSUE-12 单元 2.4 原文搬运）。可变 client 经
  // getClient 访问器注入；senderNameCache/lastMessageIdByChat/chatTypeById/
  // ackReactions 工厂闭包状态与模块级纯函数经 deps 同名注入，搬运体内引用
  // 逐字节不变。sendTextToChat 的消费方为入站主管道
  // （processClaimedIncomingMessage），本体按单元规则留在本文件。
  const {
    sendMessage,
    sendImage,
    sendFile,
    sendToFeishu,
    getSenderName,
    addReaction,
    removeReactionStrict,
    clearAckForInput,
    p2pLastMessageId,
  } = createFeishuSender({
    getClient: () => client,
    senderNameCache,
    lastMessageIdByChat,
    chatTypeById,
    ackReactions,
    parseFeishuRouteTarget,
    resolveFeishuMessageAnchor,
    requireFeishuRouteTarget,
    assertFeishuApiSuccess,
    feishuApiErrorCode,
    requireFeishuUploadKey,
    getFileType,
    buildInteractiveCard,
    buildPostMdFallback,
    CARD_TABLE_LIMIT,
    FEISHU_THREAD_REPLY_UNSUPPORTED_CODES,
  });

  async function sendTextToChat(chatId: string, text: string): Promise<void> {
    if (!client) {
      throw new FeishuTextDeliveryError(
        'Feishu client is not initialized',
        'rejected',
      );
    }
    try {
      await withFeishuHardTimeout(
        sendToFeishu(chatId, 'text', JSON.stringify({ text })),
        FEISHU_RESOURCE_REQUEST_TIMEOUT_MS,
        'Feishu text reply',
      );
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to send Feishu text reply');
      throw new FeishuTextDeliveryError(
        `Feishu text reply was not acknowledged: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof FeishuApiRejectedError ? 'rejected' : 'uncertain',
        err,
      );
    }
  }

  async function handleIncomingMessage(
    payload: IncomingMessagePayload,
    source: 'ws' | 'backfill',
  ): Promise<void> {
    const { chatId, messageId } = payload;
    if (!chatId || !messageId) return;
    const rawChatJid = `feishu:${chatId}`;
    const sourceJid =
      connectOptions?.normalizeIncomingJid?.(rawChatJid) ?? rawChatJid;
    let recorded: ReturnType<typeof recordChannelInbox>;
    try {
      recorded = recordChannelInbox({
        provider: 'feishu',
        accountId: reliabilityAccountId,
        externalMessageId: messageId,
        sourceJid,
        chatId,
        rootId: payload.rootId,
        threadId: payload.threadId,
        rawPayload: { version: 1, source, payload },
        status: 'queued',
      });
    } catch (err) {
      // Never fall back to volatile execution: without the Inbox uniqueness
      // fence, two WS clients or a reconnect can launch the same Agent turn.
      logger.error(
        { err, messageId, chatId, source },
        'Failed to durably record Feishu message; refusing unfenced execution',
      );
      throw err;
    }

    if (
      recorded.item.status === 'processed' ||
      recorded.item.status === 'ignored' ||
      recorded.item.status === 'failed'
    ) {
      rememberTerminalProgress(payload);
      logger.debug(
        { messageId, inboxStatus: recorded.item.status, source },
        'Duplicate terminal Feishu message, skipping execution',
      );
      return;
    }

    const claim = claimChannelInboxById(
      recorded.item.id,
      inboxOwner,
      FEISHU_INBOX_LEASE_MS,
    );
    if (!claim) {
      logger.debug(
        { messageId, inboxStatus: recorded.item.status, source },
        'Feishu message already claimed or awaiting retry',
      );
      return;
    }
    await processClaimedIncomingMessage(payload, source, claim);
  }

  async function processClaimedIncomingMessage(
    payload: IncomingMessagePayload,
    source: 'ws' | 'backfill',
    claim: ClaimedChannelInboxItem,
  ): Promise<void> {
    startInboxHeartbeat(claim);
    if (connectOptions?.shouldDeferInbound?.()) {
      failClaimedInbound(
        claim,
        payload,
        new Error('Channel recovery is still reconciling previous turns'),
        true,
        FEISHU_INBOX_GATE_RETRY_DELAY_MS,
      );
      logger.debug(
        { inboxId: claim.id, messageId: payload.messageId },
        'Deferred durable Feishu Inbox until recovery gate opens',
      );
      return;
    }
    const {
      onNewChat,
      onCommand,
      resolveGroupFolder,
      resolveEffectiveChatJid,
      onAgentMessage,
      onFollowUpMessage,
      shouldProcessGroupMessage,
      resolveFeishuConversationPlan,
      isGroupOwnerMessage,
      isSenderAllowedInGroup,
      onP2pSender,
    } = connectOptions || {};
    const {
      chatId,
      messageId,
      rootId,
      parentId,
      threadId,
      createTimeMs,
      messageType,
      content: rawContent,
      mentions,
      chatType,
      senderOpenId = '',
      senderUserId,
      senderUnionId,
      senderName,
      senderTenantKey,
      senderType,
    } = payload;
    if (!chatId || !messageId) {
      failClaimedInbound(
        claim,
        payload,
        new Error('Claimed Feishu Inbox payload is missing chat/message id'),
        false,
      );
      return;
    }
    const normalizedChatType =
      chatType === 'p2p' || chatType === 'group' ? chatType : undefined;
    logger.info(
      { messageId, messageType, chatId, source, inboxId: claim.id },
      'Feishu message received',
    );

    try {
      let extracted = extractMessageContent(messageType, rawContent);
      let text = extracted.text;
      if (
        !text?.trim() &&
        !extracted.imageKeys &&
        !extracted.fileInfos?.length
      ) {
        logger.info(
          { messageId, messageType },
          'No text or image content, skipping',
        );
        ignoreClaimedInbound(claim, payload, 'empty_content');
        return;
      }

      if (mentions && Array.isArray(mentions)) {
        for (const mention of mentions) {
          if (mention.key) {
            text = text.replace(mention.key, `@${mention.name || ''}`);
          }
        }
      }

      const rawChatJid = `feishu:${chatId}`;
      const chatJid =
        connectOptions?.normalizeIncomingJid?.(rawChatJid) ?? rawChatJid;
      const mentionedBot = isBotMentioned(
        botInfoRefresher.getOpenId(),
        mentions as MentionGateMention[] | undefined,
      );
      const rawMessageMeta: FeishuMessageMeta = {
        provider: 'feishu',
        chatType: normalizedChatType,
        mentionedBot,
        threadId,
        rootId,
        parentId,
        messageId,
        text,
      };
      const conversationPlan = resolveFeishuConversationPlan?.(
        chatJid,
        rawMessageMeta,
      );
      const rootMessageId =
        conversationPlan?.rootMessageId || rootId || messageId;
      const deliveryRootMessageId = conversationPlan?.independentContext
        ? conversationPlan.rootMessageId
        : threadId
          ? rootMessageId
          : rootId;
      const messageRouteTarget = buildFeishuRouteTarget(
        chatId,
        threadId,
        deliveryRootMessageId,
      );
      const resolvedSenderName = senderName || getSenderName(senderOpenId);
      const cachedChatInfo = chatInfoById.get(chatId);
      const resolvedChatName =
        cachedChatInfo?.name || (chatType === 'p2p' ? '飞书私聊' : '飞书群聊');

      // Audience is an identity boundary, independent from @/topic activation,
      // and therefore runs before commands and before the mention gate. This
      // also applies to p2p chats and already-active topics.
      if (
        isSenderAllowedInGroup &&
        !isSenderAllowedInGroup(chatJid, senderOpenId)
      ) {
        if (chatType === 'group' && mentionedBot) {
          addReaction(messageId, 'SILENT').catch(() => {});
        }
        logger.debug(
          { chatJid, messageId, senderOpenId, chatType },
          'Dropped Feishu message: sender rejected by audience policy',
        );
        ignoreClaimedInbound(claim, payload, 'audience_rejected');
        return;
      }

      // ── 斜杠指令：拦截已知 /xxx 命令，不进入消息流 ──
      // 群聊中 @机器人 后跟斜杠命令，mention 替换后文本为 "@botname /cmd"，
      // 需要先 strip 掉开头的 @mention 前缀再匹配
      let textForSlash = text?.trim().replace(/^@\S+\s+/, '') ?? '';
      let requestedFollowUpMode: FollowUpMode | undefined;
      const followUpModeMatch = textForSlash.match(
        /^\/(queue|steer)(?:\s+([\s\S]+))?$/i,
      );
      if (followUpModeMatch) {
        const modeContent = followUpModeMatch[2]?.trim();
        if (!modeContent) {
          await sendTextToChat(
            messageRouteTarget.raw,
            `请在 /${followUpModeMatch[1].toLowerCase()} 后输入消息内容。`,
          );
          completeClaimedInbound(claim, payload);
          return;
        }
        requestedFollowUpMode =
          followUpModeMatch[1].toLowerCase() === 'steer' ? 'steer' : 'queue';
        text = modeContent;
        textForSlash = modeContent;
      }
      const slashMatch = textForSlash.match(/^\/(\S+)(.*)$/);
      if (slashMatch && onCommand && !requestedFollowUpMode) {
        const cmdBody = (slashMatch[1] + slashMatch[2]).trim();
        const persistedCommand = parseFeishuSlashCommandCheckpoint(
          claim.normalizedPayload,
        );
        logger.info(
          {
            chatJid,
            cmd: slashMatch[1],
            cmdBody,
            checkpointState: persistedCommand?.state,
          },
          'Feishu slash command detected',
        );
        if (persistedCommand && persistedCommand.command !== cmdBody) {
          failClaimedInbound(
            claim,
            payload,
            new Error(
              'Durable Feishu slash-command checkpoint does not match the recovered input',
            ),
            false,
          );
          return;
        }
        if (
          persistedCommand?.state === 'executing' ||
          persistedCommand?.state === 'sending_reply'
        ) {
          // The prior process may have executed arbitrary command side
          // effects or reached the provider before it died. Re-running either
          // step is unsafe, so stop for manual reconciliation instead.
          const interruptedWhileSending =
            persistedCommand.state === 'sending_reply';
          failClaimedInbound(
            claim,
            payload,
            new Error(
              interruptedWhileSending
                ? 'Feishu slash command reply delivery was interrupted after send began; manual reconciliation required'
                : 'Feishu slash command execution was interrupted before its result was persisted; manual reconciliation required',
            ),
            false,
          );
          try {
            await sendTextToChat(
              persistedCommand.replyTarget,
              interruptedWhileSending
                ? '⚠️ 上一次命令回复可能已经送达，但系统未能确认，请核对后再决定是否重试。'
                : '⚠️ 上一次命令执行在结果落盘前中断，为避免重复执行，系统已停止自动重试，请人工核对。',
            );
          } catch (sendErr) {
            logger.error(
              { chatJid, messageId, sendErr },
              'Failed to send interrupted slash-command reconciliation notice',
            );
          }
          return;
        }
        if (persistedCommand?.state === 'reply_acknowledged') {
          completeClaimedInbound(claim, payload);
          return;
        }
        let retryableReply: FeishuSlashCommandCheckpoint | undefined;
        try {
          let reply: string | null;
          let replyTarget: string;
          if (persistedCommand?.state === 'pending_reply') {
            reply = persistedCommand.replyText;
            replyTarget = persistedCommand.replyTarget;
            retryableReply = persistedCommand;
          } else {
            const executingCheckpoint: FeishuSlashCommandCheckpoint = {
              version: 1,
              kind: 'feishu_slash_command',
              state: 'executing',
              command: cmdBody,
              replyTarget: messageRouteTarget.raw,
            };
            if (
              !updateClaimedChannelInbox(claim, {
                normalizedPayload: executingCheckpoint,
              })
            ) {
              stopInboxHeartbeat(claim);
              logger.warn(
                { inboxId: claim.id, messageId, cmd: slashMatch[1] },
                'Lost Feishu Inbox lease before command execution checkpoint',
              );
              return;
            }
            reply = await onCommand(chatJid, cmdBody, senderOpenId, mentions);
            replyTarget = messageRouteTarget.raw;
            if (reply) {
              const pendingReply: FeishuSlashCommandCheckpoint = {
                ...executingCheckpoint,
                state: 'pending_reply',
                replyText: reply,
              };
              if (
                !updateClaimedChannelInbox(claim, {
                  normalizedPayload: pendingReply,
                })
              ) {
                stopInboxHeartbeat(claim);
                logger.error(
                  { inboxId: claim.id, messageId, cmd: slashMatch[1] },
                  'Lost Feishu Inbox lease before command result checkpoint; refusing reply delivery',
                );
                return;
              }
              retryableReply = pendingReply;
            } else if (
              !updateClaimedChannelInbox(claim, { normalizedPayload: null })
            ) {
              stopInboxHeartbeat(claim);
              logger.warn(
                { inboxId: claim.id, messageId, cmd: slashMatch[1] },
                'Lost Feishu Inbox lease while clearing an unknown command checkpoint',
              );
              return;
            }
          }
          logger.info(
            {
              chatJid,
              cmd: slashMatch[1],
              hasReply: !!reply,
              replyLen: reply?.length,
            },
            'Feishu slash command processed',
          );
          if (reply) {
            const sendingReply: FeishuSlashCommandCheckpoint = {
              version: 1,
              kind: 'feishu_slash_command',
              state: 'sending_reply',
              command: cmdBody,
              replyTarget,
              replyText: reply,
            };
            if (
              !updateClaimedChannelInbox(claim, {
                normalizedPayload: sendingReply,
              })
            ) {
              stopInboxHeartbeat(claim);
              logger.error(
                { inboxId: claim.id, messageId, cmd: slashMatch[1] },
                'Lost Feishu Inbox lease before command reply send checkpoint',
              );
              return;
            }
            await sendTextToChat(replyTarget, reply);
            const acknowledged: FeishuSlashCommandCheckpoint = {
              version: 1,
              kind: 'feishu_slash_command',
              state: 'reply_acknowledged',
              command: cmdBody,
              replyTarget,
              replyText: reply,
            };
            if (
              !updateClaimedChannelInbox(claim, {
                normalizedPayload: acknowledged,
              })
            ) {
              stopInboxHeartbeat(claim);
              logger.error(
                { inboxId: claim.id, messageId, cmd: slashMatch[1] },
                'Lost Feishu Inbox lease after command reply ACK; refusing an unfenced completion',
              );
              return;
            }
            completeClaimedInbound(claim, payload);
            return; // 已知命令，拦截
          }
          // reply 为 null 表示未知命令，继续作为普通消息处理
        } catch (err) {
          const deliveryFailure = err instanceof FeishuTextDeliveryError;
          const rejectedBeforeAcceptance =
            deliveryFailure && err.outcome === 'rejected';
          logger.error(
            {
              chatJid,
              cmd: slashMatch[1],
              err,
              deliveryFailure,
              rejectedBeforeAcceptance,
            },
            'Feishu slash command failed',
          );
          if (!deliveryFailure) {
            try {
              await sendTextToChat(
                messageRouteTarget.raw,
                '⚠️ 命令执行失败，请稍后重试',
              );
            } catch (sendErr) {
              logger.error(
                { chatJid, sendErr },
                'Failed to send slash command error feedback',
              );
            }
          }
          if (rejectedBeforeAcceptance && retryableReply) {
            const safelyRequeued = updateClaimedChannelInbox(claim, {
              normalizedPayload: retryableReply,
            });
            if (!safelyRequeued) {
              stopInboxHeartbeat(claim);
              logger.error(
                { inboxId: claim.id, messageId, cmd: slashMatch[1] },
                'Could not restore rejected slash-command reply checkpoint',
              );
              return;
            }
            failClaimedInbound(claim, payload, err, true);
          } else if (deliveryFailure) {
            failClaimedInbound(
              claim,
              payload,
              new Error(
                `${err.message}; delivery outcome is uncertain and requires manual reconciliation`,
              ),
              false,
            );
            try {
              await sendTextToChat(
                messageRouteTarget.raw,
                '⚠️ 命令回复的投递结果未知，为避免重复发送，系统已停止自动重试，请人工核对。',
              );
            } catch (sendErr) {
              logger.error(
                { chatJid, messageId, sendErr },
                'Failed to send uncertain slash-command delivery notice',
              );
            }
          } else {
            // Command execution failures stay terminal because replaying
            // arbitrary command side effects is not safe.
            failClaimedInbound(claim, payload, err, false);
          }
          return;
        }
      }

      // ── 群聊 Mention 过滤：require_mention / owner_mentioned 模式下过滤 ──
      // 决策由 evaluateMentionGate（src/feishu-mention-gate.ts）以纯函数形式给出，
      // 历史上这里曾因 botOpenId 缺失而 fail-open 静默失效；新版 fail-closed，
      // 并通过 ensureBotOpenIdFresh() 触发后台 lazy refetch 自愈。
      {
        const decision = evaluateMentionGate({
          chatType: normalizedChatType,
          botOpenId: botInfoRefresher.getOpenId(),
          mentions: mentions as MentionGateMention[] | undefined,
          chatJid,
          senderOpenId,
          shouldProcessGroupMessage,
          isGroupOwnerMessage,
          conversationPlan,
        });
        if (!decision.allow) {
          if (decision.reason === 'bot_open_id_missing') {
            // 触发后台 lazy refetch（节流由函数内部保证），不阻塞当前消息
            void ensureBotOpenIdFresh('mention-gate-fallback');
            // warn 日志按 5 分钟节流，避免 botOpenId 长时间缺失时刷屏
            const now = Date.now();
            botInfoMissingDroppedSinceLastWarn++;
            if (
              now - lastBotInfoMissingWarnAt >=
              BOT_INFO_MISSING_WARN_INTERVAL_MS
            ) {
              logger.warn(
                {
                  chatJid,
                  messageId,
                  droppedSinceLastWarn: botInfoMissingDroppedSinceLastWarn,
                },
                'Dropping group messages: bot open_id unknown (fail-closed). Triggered lazy refetch.',
              );
              lastBotInfoMissingWarnAt = now;
              botInfoMissingDroppedSinceLastWarn = 0;
            } else {
              logger.debug(
                { chatJid, messageId },
                'Dropped group message: bot open_id missing (warn throttled)',
              );
            }
          } else if (decision.reason === 'not_mentioned') {
            logger.debug(
              { chatJid, messageId },
              'Dropped group message: mention required but bot not mentioned',
            );
          } else if (decision.reason === 'not_owner') {
            logger.debug(
              { chatJid, messageId, senderOpenId },
              'Dropped group message: owner_mentioned mode, sender is not owner',
            );
          } else {
            logger.debug(
              { chatJid, messageId },
              'Dropped Feishu message: activation mode is disabled',
            );
          }
          ignoreClaimedInbound(
            claim,
            payload,
            `mention_gate:${decision.reason}`,
          );
          return;
        }
      }

      // Feishu requires @bot in mention-gated groups, but the durable human
      // text should contain the actual request. Strip only the leading bot
      // token proven by Feishu mention metadata; other @mentions remain.
      if (chatType === 'group') {
        text = stripLeadingBotMention(
          text,
          botInfoRefresher.getOpenId(),
          mentions as MentionGateMention[] | undefined,
        );
      }

      // Validate the binding before registration, owner learning, metadata or
      // attachment downloads. The title/context metadata available here is
      // sufficient for native-thread routing; downloaded paths are payload.
      //
      // Group chats get an external ownership signal before their first
      // message can ever arrive here (im.chat.member.bot.added_v1 →
      // onBotAddedToGroup, wired to the same onNewChat below), so the route
      // check below can safely fail-closed on an unregistered group chat —
      // it should never actually be unregistered by the time a message
      // shows up. P2P chats have no equivalent bootstrap event: the first
      // DM IS the "bot added" signal (mirrors the "/pair establishes
      // ownership before routing" contract other channels use — see
      // channel-admission.ts). Without this, resolveAdmittedChannelRoute
      // would fail-closed on every message from a brand-new P2P chat
      // forever, since registration (below) never gets a chance to run.
      // onNewChat/onP2pSender are idempotent no-ops once already
      // registered, so calling them again in their normal position below
      // is safe and keeps this bootstrap narrowly scoped to P2P.
      //
      // The resolver wired in by IMConnectionManager (scopeConnectOpts) does
      // not return null for an unresolved route: it throws
      // ChannelRouteRejectedError, which for this probe means exactly "not
      // registered yet". Treat only that error as the bootstrap signal; any
      // other failure must still surface. The strict route check below keeps
      // rejecting legitimately rejected routes.
      if (chatType === 'p2p' && resolveEffectiveChatJid) {
        let routeResolved = true;
        try {
          routeResolved = !!resolveEffectiveChatJid(chatJid);
        } catch (err) {
          if (!(err instanceof ChannelRouteRejectedError)) throw err;
          routeResolved = false;
        }
        if (!routeResolved) {
          onNewChat?.(chatJid, resolvedChatName);
          if (senderOpenId && onP2pSender) {
            onP2pSender(senderOpenId);
          }
        }
      }

      const admittedRoute = resolveAdmittedChannelRoute<FeishuMessageMeta>(
        chatJid,
        resolveEffectiveChatJid,
        {
          provider: 'feishu',
          chatType: normalizedChatType,
          mentionedBot,
          nativeContextType:
            conversationPlan?.independentContext ||
            (!conversationPlan && !!threadId)
              ? 'thread'
              : undefined,
          contextId: conversationPlan?.contextId || threadId,
          threadId,
          rootId: conversationPlan?.rootMessageId || rootId,
          parentId,
          messageId,
          text,
        },
      );
      if (!admittedRoute) {
        logger.warn(
          { chatJid, messageId, source },
          'Feishu binding resolver rejected route; dropping message',
        );
        ignoreClaimedInbound(claim, payload, 'binding_rejected');
        return;
      }
      const agentRouting = admittedRoute.routing;

      // Event payloads intentionally contain only a lossy placeholder for
      // cards and merged forwards. Resolve their complete user-facing content
      // and bounded quoted context only after audience, mention and binding
      // admission, so rejected messages cannot consume tenant API quota.
      const enriched = await enrichFeishuInboundContent({
        client: client as unknown as Parameters<
          typeof enrichFeishuInboundContent
        >[0]['client'],
        messageId,
        messageType,
        fallbackText: text,
        fallbackImageKeys: extracted.imageKeys,
        parentId,
        nativeRootId: rootId,
        threadId,
        // A native thread already has durable SDK history, so one explicit
        // parent is enough to preserve reply semantics. Ordinary reply chains
        // may start a new logical session and need bounded ancestor metadata.
        limits: threadId ? { maxReferenceDepth: 1 } : undefined,
        parseContent: (type, content) => extractMessageContent(type, content),
      });
      text = enriched.text;
      extracted = {
        ...extracted,
        text,
        imageKeys: enriched.imageKeys,
      };
      if (enriched.richMessageResolved || enriched.referencedMessages > 0) {
        logger.debug(
          {
            messageId,
            messageType,
            richMessageResolved: enriched.richMessageResolved,
            referencedMessages: enriched.referencedMessages,
          },
          'Enriched admitted Feishu message content',
        );
      }

      onNewChat?.(chatJid, resolvedChatName);
      if (chatType === 'p2p' && senderOpenId && onP2pSender) {
        onP2pSender(senderOpenId);
      }
      lastMessageIdByChat.set(chatId, messageId);
      const resolvedCreateTimeMs = createTimeMs > 0 ? createTimeMs : Date.now();
      const timestamp = new Date(resolvedCreateTimeMs).toISOString();

      let attachmentsJson: string | undefined;

      // ── 附件下载（已通过白名单 + mention 门控后才执行）──
      // 安全：未授权发送者 / 未 @bot 的群消息已在上面 return，绝不会触发图片/
      // 文件下载落盘或对飞书 API 的拉取（防止未授权资源消耗 / SSRF 式拉取）。
      const currentImageKeys = extracted.imageKeys ?? [];
      const currentImageRefs =
        enriched.currentImageRefs ??
        currentImageKeys.map((imageKey) => ({ messageId, imageKey }));
      const referencedImageRefs = enriched.referencedImageRefs ?? [];
      const referencedMessages: ChannelReferencedMessage[] = (
        enriched.references ?? []
      ).map((reference) => ({ ...reference }));
      const replaceReferenceMarker = (
        referenceMessageId: string,
        marker: string,
        replacement: string,
        attachmentIndex?: number,
      ): void => {
        const reference = referencedMessages.find(
          (item) =>
            item.id === referenceMessageId && item.text.includes(marker),
        );
        if (!reference) return;
        reference.text = reference.text.replace(marker, replacement);
        reference.attachmentHints = [
          ...(reference.attachmentHints ?? []),
          replacement,
        ];
        if (attachmentIndex !== undefined) {
          reference.attachmentIndexes = [
            ...(reference.attachmentIndexes ?? []),
            attachmentIndex,
          ];
        }
      };
      if (currentImageRefs.length > 0 || referencedImageRefs.length > 0) {
        // 图片消息：下载后双轨处理
        // 1. Vision 通道：base64 附件供模型看图
        // 2. 存盘通道：写入工作区文件，agent 可直接操作（压缩、发送等）
        const attachments = [];
        const groupFolder = resolveGroupFolder?.(chatJid);
        const savedPaths: string[] = [];
        let downloadedCurrentImages = 0;

        for (const imageRef of currentImageRefs) {
          const { imageKey } = imageRef;
          const imageData = await downloadFeishuImage(
            () => client,
            imageRef.messageId,
            imageKey,
          );
          if (!imageData) continue;
          downloadedCurrentImages++;

          // Vision 附件
          attachments.push({
            type: 'image',
            data: imageData.base64,
            mimeType: imageData.mimeType,
          });

          // 存盘：扩展名从 mimeType 推断，对齐文件消息处理逻辑
          if (groupFolder) {
            const extMap: Record<string, string> = {
              'image/jpeg': '.jpg',
              'image/png': '.png',
              'image/gif': '.gif',
              'image/webp': '.webp',
              'image/bmp': '.bmp',
              'image/tiff': '.tiff',
            };
            const ext = extMap[imageData.mimeType] ?? '.jpg';
            const fileName = `feishu_img_${imageKey.slice(-8)}${ext}`;
            try {
              const relPath = await saveDownloadedFile(
                groupFolder,
                'feishu',
                fileName,
                Buffer.from(imageData.base64, 'base64'),
              );
              if (relPath) savedPaths.push(relPath);
            } catch (err) {
              logger.warn(
                { err, imageKey },
                'Failed to save Feishu image to disk',
              );
            }
          }
        }

        // Referenced images must be downloaded against the message that owns
        // the image key, not the current event. The normalized text carries a
        // stable marker so the saved path stays associated with the correct
        // quoted message while the same bytes are also supplied to vision.
        for (const ref of referencedImageRefs) {
          const imageData = await downloadFeishuImage(
            () => client,
            ref.messageId,
            ref.imageKey,
          );
          if (!imageData) {
            replaceReferenceMarker(
              ref.referenceMessageId,
              ref.marker,
              '[引用图片下载失败]',
            );
            continue;
          }
          const attachmentIndex = attachments.length;
          attachments.push({
            type: 'image',
            data: imageData.base64,
            mimeType: imageData.mimeType,
          });
          let replacement = '[引用图片]';
          if (groupFolder) {
            const extMap: Record<string, string> = {
              'image/jpeg': '.jpg',
              'image/png': '.png',
              'image/gif': '.gif',
              'image/webp': '.webp',
              'image/bmp': '.bmp',
              'image/tiff': '.tiff',
            };
            const ext = extMap[imageData.mimeType] ?? '.jpg';
            const fileName = `feishu_ref_${ref.imageKey.slice(-8)}${ext}`;
            try {
              const relPath = await saveDownloadedFile(
                groupFolder,
                'feishu',
                fileName,
                Buffer.from(imageData.base64, 'base64'),
              );
              if (relPath) replacement = `[引用图片: ${relPath}]`;
            } catch (err) {
              logger.warn(
                { err, messageId: ref.messageId, imageKey: ref.imageKey },
                'Failed to save referenced Feishu image to disk',
              );
            }
          }
          replaceReferenceMarker(
            ref.referenceMessageId,
            ref.marker,
            replacement,
            attachmentIndex,
          );
        }

        // 拼接图片标记：成功下载的用路径，失败的用占位符，确保 text 不为空。
        // 否则长图/超大图片下载失败时会落入 agent 的空消息分支，回复"消息是空的"。
        const failedCount = currentImageRefs.length - downloadedCurrentImages;
        const markers: string[] = [];
        if (attachments.length > 0) {
          attachmentsJson = JSON.stringify(attachments);
        }
        if (downloadedCurrentImages > 0) {
          if (savedPaths.length > 0) {
            markers.push(...savedPaths.map((p) => `[图片: ${p}]`));
          } else {
            markers.push('[图片]');
          }
        }
        if (failedCount > 0) {
          markers.push(
            `[图片下载失败: ${failedCount} 张，可能超过飞书接口限制或网络异常]`,
          );
          logger.warn(
            {
              chatJid,
              messageId,
              failedCount,
              totalKeys: currentImageRefs.length,
            },
            'Feishu image download failed for some or all images',
          );
        }
        const imgMarker = markers.join('\n');
        if (imgMarker) {
          text = text ? `${imgMarker}\n${text}` : imgMarker;
        }
      }
      if (extracted.fileInfos && extracted.fileInfos.length > 0) {
        // 文件消息：下载到磁盘，路径内联替换
        logger.info(
          {
            chatJid,
            messageId,
            messageType,
            fileCount: extracted.fileInfos.length,
          },
          'Processing Feishu file download',
        );
        const groupFolder = resolveGroupFolder?.(chatJid);
        if (!groupFolder) {
          logger.warn(
            { chatJid },
            'Cannot resolve group folder for file download',
          );
          for (const fi of extracted.fileInfos) {
            const safeFilename = sanitizeImFilename(fi.filename || fi.fileKey);
            const placeholder = `[文件: ${safeFilename}]`;
            text = text.replace(placeholder, `[文件下载失败: ${safeFilename}]`);
          }
        } else {
          for (const fi of extracted.fileInfos) {
            const safeFilename = sanitizeImFilename(fi.filename || fi.fileKey);
            const relPath = await downloadFeishuFileToDisk(
              () => client,
              messageId,
              fi.fileKey,
              fi.filename,
              groupFolder,
            );
            const placeholder = `[文件: ${safeFilename}]`;
            // 弱模型兜底：抽取成功则内联文件文本，失败回退仅路径标记。
            const replacement = !relPath
              ? `[文件下载失败: ${safeFilename}]`
              : ((await buildInlinedFileContent(groupFolder, relPath)) ??
                `[文件: ${relPath}]`);
            // replacer 用函数形式：replacement 含文件抽取文本，其中的
            // $& / $' 等特殊序列不能被 String.replace 展开。
            text = text.replace(placeholder, () => replacement);
          }
        }
      }

      const routeSourceJid =
        agentRouting?.sourceJid ??
        (messageRouteTarget.threadId || messageRouteTarget.rootMessageId
          ? feishuRouteToJid(messageRouteTarget, chatJid)
          : chatJid);

      // ── Ack Reaction：确认已收到消息（在 mention 过滤之后，避免对未处理的消息加表情） ──
      if (source === 'ws') {
        // The registry is owned by one channel-account instance. Keep its key
        // provider-native on both attach and clear; account scoping belongs to
        // ImManager's instance lookup, not to the provider target.
        const ackTarget = parseFeishuRouteTarget(
          extractProviderTarget(routeSourceJid),
        );
        ackReactions
          .attach(
            processingIndicatorKey(ackTarget.raw, messageId),
            async () => {
              const reactionId = await addReaction(messageId, 'OnIt');
              return reactionId ? { messageId, reactionId } : null;
            },
            ({ messageId: ackMessageId, reactionId }) =>
              removeReactionStrict(ackMessageId, reactionId),
          )
          .catch(() => {});
      }

      // Store message and broadcast to WebSocket clients
      const targetJid = admittedRoute.targetJid;

      const targetAgentId = agentRouting?.agentId;
      const channelContext = buildFeishuChannelTurnContext({
        appId: config.appId,
        configuredChannelAccountId: config.channelAccountId,
        bot: botInfoRefresher.getPublicInfo(),
        chat: {
          id: chatId,
          type: chatType,
          name: cachedChatInfo?.name || resolvedChatName,
          mode: cachedChatInfo?.chatMode,
          groupMessageType: cachedChatInfo?.groupMessageType,
        },
        message: {
          id: messageId,
          rootId: deliveryRootMessageId,
          parentId,
          threadId,
          type: messageType,
          referencedMessages,
        },
        sender: {
          openId: senderOpenId,
          userId: senderUserId,
          unionId: senderUnionId,
          name: resolvedSenderName,
          tenantKey: senderTenantKey,
          type: senderType,
        },
        mentions,
        sourceJid: routeSourceJid,
        targetJid,
        sessionAgentId: targetAgentId,
      });
      updateClaimedChannelInbox(claim, {
        normalizedPayload: {
          version: 1,
          source,
          payload: { ...payload, content: text },
          route: { sourceJid: routeSourceJid, targetJid },
          channelContext,
        },
      });

      storeChatMetadata(targetJid, timestamp);
      storeMessageDirect(
        messageId,
        targetJid,
        senderOpenId,
        resolvedSenderName,
        text,
        timestamp,
        false,
        {
          attachments: attachmentsJson,
          sourceJid: routeSourceJid,
          channelContext,
        },
      );
      const followUp = onFollowUpMessage?.({
        targetJid,
        sourceJid: routeSourceJid,
        messageId,
        senderImId: senderOpenId,
        requestedMode: requestedFollowUpMode,
        repliedToActiveCard: !!parentId && !!resolveJidByMessageId(parentId),
      }) ?? { disposition: 'started' as const };
      const deliveryFields =
        followUp.disposition === 'queued'
          ? {
              delivery_mode: 'queue' as const,
              delivery_status: 'queued' as const,
              delivery_run_id: followUp.runId ?? null,
              delivery_updated_at: timestamp,
            }
          : followUp.disposition === 'steered'
            ? {
                delivery_mode: 'steer' as const,
                // Steering is a durable hand-off: the row stays queued until
                // the interrupted SDK query reports idle, then starts as the
                // next turn in the same session.
                delivery_status: 'queued' as const,
                delivery_run_id: followUp.runId ?? null,
                delivery_updated_at: timestamp,
              }
            : {};
      broadcastNewMessage(
        targetJid,
        {
          id: messageId,
          chat_jid: targetJid,
          source_jid: routeSourceJid,
          sender: senderOpenId,
          sender_name: resolvedSenderName,
          content: text,
          timestamp,
          attachments: attachmentsJson,
          channel_context: channelContext,
          ...deliveryFields,
        },
        targetAgentId ?? undefined,
      );
      if (followUp.disposition === 'queued') {
        broadcastFollowUpUpdate(targetJid);
        const position = followUp.position ?? 1;
        if (followUp.runId) {
          // Strip the prefix through the shared helper, which also drops the
          // account fragment. Slicing by hand left `#account:` in place, and
          // requireFeishuRouteTarget only accepts thread/root fragments — so
          // every account-scoped route threw here instead of sending the card.
          const queuedReplyTarget = routeSourceJid
            ? extractProviderTarget(routeSourceJid)
            : messageRouteTarget.raw;
          await sendToFeishu(
            queuedReplyTarget,
            'interactive',
            JSON.stringify(
              buildQueuedFollowUpCard({
                content: text,
                position,
                sourceJid: chatJid,
                targetJid,
                messageId,
                expectedRunId: followUp.runId,
              }),
            ),
          );
        }
        logger.info(
          { chatJid, targetJid, messageId, position },
          'Feishu message queued behind active query',
        );
        completeClaimedInbound(claim, payload);
        return;
      }
      notifyNewImMessage();

      if (agentRouting && agentRouting.agentId) {
        onAgentMessage?.(chatJid, agentRouting.agentId);
        logger.info(
          {
            chatJid,
            effectiveJid: targetJid,
            agentId: targetAgentId,
            sender: resolvedSenderName,
            messageId,
            source,
          },
          'Feishu message routed to conversation agent',
        );
      } else if (agentRouting) {
        // Routed to workspace main conversation (no agentId)
        logger.info(
          {
            chatJid,
            effectiveJid: targetJid,
            sender: resolvedSenderName,
            messageId,
            source,
          },
          'Feishu message routed to workspace main conversation',
        );
      } else {
        logger.info(
          { chatJid, sender: resolvedSenderName, messageId, source },
          'Feishu message stored',
        );
      }
      completeClaimedInbound(claim, payload);
    } catch (err) {
      logger.error(
        { err, messageId, chatId, source, inboxId: claim.id },
        'Feishu message intake failed; durable Inbox scheduled a retry',
      );
      failClaimedInbound(claim, payload, err, true);
      // 仅实时消息的首次失败提示自动重试：恢复路径沿用持久化信封里的 'ws'，
      // 不限制 attempt 会让持续性失败每个重试周期都重发一遍提示。
      // backfill 回填的旧消息失败不打扰用户。
      if (source === 'ws' && claim.attempt <= 1) {
        try {
          await sendTextToChat(chatId, '⚠️ 消息处理暂时失败，系统将自动重试');
        } catch (sendErr) {
          logger.error(
            { chatId, messageId, sendErr },
            'Failed to send Feishu durable Inbox retry feedback',
          );
        }
      }
    }
  }

  // ISSUE-12 单元 2.3：backfillChatMessages / runBackfill 原文搬运至
  // ./feishu-backfill.ts；client 经 getClient 访问器注入，knownChatIds /
  // chatTypeById / reliabilityAccountId / toEpochMs / handleIncomingMessage
  // 为工厂闭包绑定、同名注入，搬运体内引用逐字节不变。防重入标志
  // backfillRunning 仍留在本文件（上方 let 声明），connect() 的复位行与
  // 三处 runBackfill 调用点均不变。
  const { runBackfill } = createFeishuBackfill({
    getClient: () => client,
    reliabilityAccountId,
    knownChatIds,
    chatTypeById,
    toEpochMs,
    handleIncomingMessage,
    isBackfillRunning: () => backfillRunning,
    setBackfillRunning: (running) => {
      backfillRunning = running;
    },
  });

  function parseRecoveredInbox(
    claim: ClaimedChannelInboxItem,
  ):
    | { source: 'ws' | 'backfill'; payload: IncomingMessagePayload }
    | undefined {
    const raw = claim.rawPayload;
    if (!raw || typeof raw !== 'object') return undefined;
    const envelope = raw as {
      source?: unknown;
      payload?: Partial<IncomingMessagePayload>;
    };
    if (
      (envelope.source !== 'ws' && envelope.source !== 'backfill') ||
      !envelope.payload ||
      typeof envelope.payload.chatId !== 'string' ||
      !envelope.payload.chatId.trim() ||
      typeof envelope.payload.messageId !== 'string' ||
      !envelope.payload.messageId.trim() ||
      typeof envelope.payload.createTimeMs !== 'number' ||
      typeof envelope.payload.messageType !== 'string' ||
      !envelope.payload.messageType.trim() ||
      typeof envelope.payload.content !== 'string'
    ) {
      return undefined;
    }
    return {
      source: envelope.source,
      payload: envelope.payload as IncomingMessagePayload,
    };
  }

  async function recoverQueuedInbox(reason: string): Promise<void> {
    let recovered = 0;
    while (recovered < FEISHU_INBOX_RECOVERY_LIMIT) {
      let claim: ClaimedChannelInboxItem | undefined;
      try {
        claim = claimNextChannelInbox(inboxOwner, FEISHU_INBOX_LEASE_MS, {
          provider: 'feishu',
          accountId: reliabilityAccountId,
        });
      } catch (err) {
        logger.warn(
          { err, reason, accountId: reliabilityAccountId },
          'Unable to recover durable Feishu Inbox',
        );
        return;
      }
      if (!claim) break;
      const envelope = parseRecoveredInbox(claim);
      if (!envelope) {
        failClaimedInbound(
          claim,
          {
            chatId: claim.chatId || '',
            messageId: claim.externalMessageId,
            createTimeMs: Date.parse(claim.createdAt),
            messageType: '',
            content: '',
          },
          new Error('Invalid durable Feishu Inbox payload'),
          false,
        );
        continue;
      }
      await processClaimedIncomingMessage(
        envelope.payload,
        envelope.source,
        claim,
      );
      recovered++;
    }
    if (recovered > 0) {
      logger.info(
        { reason, recovered, accountId: reliabilityAccountId },
        'Recovered queued Feishu Inbox messages',
      );
    }
  }

  // ISSUE-12 单元 2.6：getWsConnectionState / startHealthMonitor /
  // stopHealthMonitor / reconnectWebSocket / checkConnectionHealth 原文搬运
  // 至 ./feishu-ws-lifecycle.ts。wsClient / eventDispatcher / connectOptions /
  // reconnecting / reconnectRequestedAt / disconnectedChecks /
  // lastWsStateConnected / healthTimer 均为本文件可变 let（上方状态装配区，
  // connect()/stop() 的复位与清理行不变），经访问器注入；2.1
  // botInfoRefresher（getOpenId 探测）与 ensureBotOpenIdFresh、durable Inbox
  // 恢复 recoverQueuedInbox、2.3 runBackfill 经 deps 同名注入，搬运体内
  // 调用点逐字节不变。getWsConnectionState 的唯一调用方
  // checkConnectionHealth 已随迁，不进本文件绑定，经工厂返回面保留。
  const {
    startHealthMonitor,
    stopHealthMonitor,
    checkConnectionHealth,
    reconnectWebSocket,
  } = createFeishuWsLifecycle({
    config,
    getWsClient: () => wsClient,
    setWsClient: (ws) => {
      wsClient = ws;
    },
    getDispatcher: () => eventDispatcher,
    getConnectOptions: () => connectOptions,
    getReconnecting: () => reconnecting,
    setReconnecting: (value) => {
      reconnecting = value;
    },
    getReconnectRequestedAt: () => reconnectRequestedAt,
    setReconnectRequestedAt: (at) => {
      reconnectRequestedAt = at;
    },
    getDisconnectedChecks: () => disconnectedChecks,
    setDisconnectedChecks: (checks) => {
      disconnectedChecks = checks;
    },
    getLastWsStateConnected: () => lastWsStateConnected,
    setLastWsStateConnected: (connected) => {
      lastWsStateConnected = connected;
    },
    getHealthTimer: () => healthTimer,
    setHealthTimer: (timer) => {
      healthTimer = timer;
    },
    botInfoRefresher,
    ensureBotOpenIdFresh,
    recoverQueuedInbox,
    runBackfill,
  });

  const connection: FeishuConnection = {
    async connect(opts: ConnectOptions): Promise<boolean> {
      const { onReady } = opts;

      if (!config.appId || !config.appSecret) {
        logger.warn('Feishu config is empty, running in Web-only mode');
        return false;
      }
      connectOptions = opts;
      disconnectedChecks = 0;
      reconnectRequestedAt = Date.now();
      reconnecting = false;
      backfillRunning = false;
      restoreDurableChatProgress();

      // Initialize client
      client = new lark.Client({
        appId: config.appId,
        appSecret: config.appSecret,
        appType: lark.AppType.SelfBuild,
      });

      // Fetch bot open_id for mention detection — 带 retry 的 best-effort 拉取。
      // 启动期失败后，健康检查 + 进入 mention 门控前的 lazy refetch 会兜底自愈，
      // 期间 mention 守卫维持 fail-closed（拒绝群消息），不会回退到默认放行。
      botInfoRefresher.reset();
      await fetchBotOpenIdWithRetry();

      // Register the bot's current chat inventory before opening the WS. This
      // prevents the first event after restart from racing a missing binding,
      // while restored P2P cursors cover chats absent from chat.list.
      try {
        await connection.syncGroups();
      } catch (err) {
        logger.warn(
          { err, accountId: reliabilityAccountId },
          'Feishu startup chat inventory sync failed; cursor recovery will continue',
        );
      }

      // Create event dispatcher
      eventDispatcher = buildFeishuEventHandlers({
        handleIncomingMessage,
        toEpochMs,
        getConnectOptions: () => connectOptions,
        getClient: () => client,
      });

      // Initialize WebSocket client
      wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        loggerLevel: lark.LoggerLevel.info,
      });

      try {
        await wsClient.start({ eventDispatcher });
        logger.info('Feishu WebSocket client started');
        lastWsStateConnected = true;
        startHealthMonitor();
        await recoverQueuedInbox('startup');
        await runBackfill('startup');
        onReady();
        return true;
      } catch (err) {
        logger.error(
          { err },
          'Failed to start Feishu client, running in Web-only mode',
        );
        // Clean up partially initialized state
        stopHealthMonitor();
        connectOptions = null;
        eventDispatcher = null;
        client = null;
        wsClient = null;
        return false;
      }
    },

    async stop(): Promise<void> {
      stopHealthMonitor();
      if (inboxRecoveryTimer) {
        clearTimeout(inboxRecoveryTimer);
        inboxRecoveryTimer = null;
      }
      for (const timer of inboxHeartbeatByClaim.values()) {
        clearInterval(timer);
      }
      inboxHeartbeatByClaim.clear();
      connectOptions = null;
      eventDispatcher = null;
      reconnecting = false;
      disconnectedChecks = 0;
      await ackReactions.clearAll();
      if (wsClient) {
        logger.info('Stopping Feishu client');
        try {
          await wsClient.close();
          logger.info('Feishu client stopped successfully');
        } catch (err) {
          logger.warn({ err }, 'Error stopping Feishu client');
        }
        wsClient = null;
      }
      client = null;
      lastWsStateConnected = false;
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
      options?: { presentation?: 'default' | 'native' },
    ): Promise<void> {
      return sendMessage(chatId, text, localImagePaths, options);
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      _fileName?: string /* Feishu image API has no filename field, intentionally unused */,
    ): Promise<void> {
      return sendImage(chatId, imageBuffer, mimeType, caption, _fileName);
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      return sendFile(chatId, filePath, fileName);
    },

    clearAckReaction(chatId: string, inputMessageId: string): Promise<void> {
      return clearAckForInput(chatId, inputMessageId);
    },

    isConnected(): boolean {
      return wsClient != null;
    },

    async getChatInfo(chatId: string): Promise<FeishuChatInfo | null> {
      if (!client) return null;
      try {
        const target = parseFeishuRouteTarget(chatId);
        const res = await client.im.v1.chat.get({
          path: { chat_id: target.chatId },
        });
        if (!res.data) return null;
        const info = {
          avatar: res.data.avatar,
          name: res.data.name,
          user_count: res.data.user_count,
          chat_type: res.data.chat_type,
          chat_mode: res.data.chat_mode,
          group_message_type: (res.data as { group_message_type?: string })
            .group_message_type,
        };
        chatInfoById.set(target.chatId, {
          name: info.name,
          chatType: info.chat_type,
          chatMode: info.chat_mode,
          groupMessageType: info.group_message_type,
        });
        return info;
      } catch (err) {
        logger.warn({ err, chatId }, 'Failed to get Feishu chat info');
        return null;
      }
    },

    async executeCapability(context, request) {
      if (!client) throw new Error('Feishu client is not connected');
      return executeFeishuCapability(client, context, request);
    },

    async syncGroups(): Promise<void> {
      if (!client) {
        logger.debug('Feishu client not initialized, skip group sync');
        return;
      }
      try {
        let pageToken: string | undefined;
        let hasMore = true;

        while (hasMore) {
          const res = await client.im.v1.chat.list({
            params: {
              page_size: 100,
              page_token: pageToken,
            },
          });

          const items = res.data?.items || [];
          for (const chat of items) {
            if (!chat.chat_id) continue;

            const rawJid = `feishu:${chat.chat_id}`;
            const scopedJid =
              connectOptions?.normalizeIncomingJid?.(rawJid) ?? rawJid;
            const chatName = chat.name?.trim() || '飞书聊天';
            const extendedChat = chat as typeof chat & {
              chat_type?: string;
              chat_mode?: string;
              group_message_type?: string;
            };
            chatInfoById.set(chat.chat_id, {
              name: chatName,
              chatType: extendedChat.chat_type,
              chatMode: extendedChat.chat_mode,
              groupMessageType: extendedChat.group_message_type,
            });

            // chat.list is the authoritative membership inventory for the bot.
            // Register every visible chat, even when the membership event was
            // missed or the chat has never sent a message to CKQClaw. The
            // account-scoping wrapper makes the JID unique for multi-bot users.
            connectOptions?.onNewChat?.(rawJid, chatName);
            if (chat.avatar) {
              updateRegisteredGroupAvatar(scopedJid, chat.avatar);
            }
            updateChatName(scopedJid, chatName);
            rememberChatProgress(chat.chat_id, 0, extendedChat.chat_type);
          }

          hasMore = res.data?.has_more || false;
          pageToken = res.data?.page_token;
        }

        logger.info('Feishu group sync completed');
      } catch (err) {
        logger.error({ err }, 'Failed to sync Feishu groups');
        throw err;
      }
    },

    getLarkClient(): lark.Client | null {
      return client;
    },

    getLastMessageId(chatId: string): string | undefined {
      const target = requireFeishuRouteTarget(chatId);
      return target.rootMessageId || p2pLastMessageId(target);
    },
  };

  return connection;
}
