/**
 * QQ Bot API v2 Connection Factory
 *
 * Implements QQ Bot connection using official API v2 protocol:
 * - OAuth Token management with auto-refresh
 * - WebSocket connection for receiving events
 * - REST API for sending messages
 * - Message deduplication (LRU 1000 / 30min TTL)
 *
 * Reference: https://github.com/sliverp/qqbot (QQ Bot API v2)
 */
import crypto from 'crypto';
import fs from 'node:fs';
import WebSocket from 'ws';
import {
  getRegisteredGroup,
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
} from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { parseChannelPairingCode } from './channel-admission.js';
import { logger } from './logger.js';
import {
  markdownToPlainText,
  splitTextChunks,
  createDedupCache,
} from './im-utils.js';
import { ProcessingLock, isStale } from './im-safety/index.js';
import { isTransientError } from './qq-reconnect.js';
import { resolveAdmittedChannelRoute } from './channel-admission.js';
import { createQQTokenManager } from './qq-token.js';
import { createQQApi } from './qq-api.js';
import { createQQMediaSender } from './qq-media.js';
import { createQQWsSession } from './qq-ws.js';
// ─── Constants ──────────────────────────────────────────────────

const MSG_SPLIT_LIMIT = 5000;

// ─── Types ──────────────────────────────────────────────────────

export interface QQConnectionConfig {
  appId: string;
  appSecret: string;
}

interface QQConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  isChatAuthorized: (jid: string) => boolean;
  ignoreMessagesBefore?: number;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  /** 斜杠指令回调。senderImId 是发送者的裸 QQ open_id（不含 `qq:` 前缀），
   *  与飞书 onCommand 传裸 ID 的格式一致，用于主进程 owner-only 检查。 */
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
  ) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  normalizeIncomingJid?: (jid: string) => string;
}

export interface QQConnection {
  connect(opts: QQConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  sendImage(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void>;
  sendFile(chatId: string, filePath: string, fileName: string): Promise<void>;
  sendChatAction(chatId: string, action: 'typing'): Promise<void>;
  isConnected(): boolean;
  /** Send a C2C stream message chunk. Returns { id } on first chunk. */
  sendStreamMessage(
    openid: string,
    params: {
      input_mode: string;
      input_state: number;
      content_type: string;
      content_raw: string;
      msg_seq: number;
      index: number;
      stream_msg_id?: string;
      msg_id?: string;
      event_id?: string;
    },
  ): Promise<{ id?: string }>;
  /** Get next msg_seq for a chat (for stream session). */
  getNextMsgSeq(chatId: string): number;
  /** Latest msg_id received from a C2C openid, for passive reply. */
  getLastIncomingMsgId(openid: string): string | undefined;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Parse JID to determine chat type and extract openid.
 * qq:c2c:{user_openid} → { type: 'c2c', openid }
 * qq:group:{group_openid} → { type: 'group', openid }
 */
function parseQQChatId(
  chatId: string,
): { type: 'c2c' | 'group'; openid: string } | null {
  if (chatId.startsWith('c2c:')) {
    return { type: 'c2c', openid: chatId.slice(4) };
  }
  if (chatId.startsWith('group:')) {
    return { type: 'group', openid: chatId.slice(6) };
  }
  return null;
}

export function validateQQGatewayUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'wss:' ||
    url.username ||
    url.password ||
    (hostname !== 'qq.com' && !hostname.endsWith('.qq.com'))
  ) {
    throw new Error('QQ gateway returned an untrusted WebSocket URL');
  }
  return url.toString();
}

// ─── Factory Function ───────────────────────────────────────────

export function createQQConnection(config: QQConnectionConfig): QQConnection {
  // WebSocket state
  let ws: WebSocket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let watchdogTimer: NodeJS.Timeout | null = null;
  let reconnectAttempts = 0;
  let lastSequence: number | null = null;
  let sessionId: string | null = null;
  let resumeGatewayUrl: string | null = null;
  let stopping = false;
  let readyFired = false;

  // Reconnect control state. Mutated by ws lifecycle handlers and the
  // reconnect timer; read by scheduleReconnect to pick the next strategy.
  let quickDisconnectCount = 0;
  let lastConnectTime = 0;
  let keepaliveMode = false;
  let lastErrorIsTransient = false;

  // Message deduplication
  // LRU deduplication cache（共享 helper）
  const dedup = createDedupCache({ ttlMs: 30 * 60 * 1000, max: 1000 });
  const processingLock = new ProcessingLock();

  // Per-chat msg_seq counter for active messages
  const msgSeqCounters = new Map<string, number>();

  // Latest incoming msg_id per C2C openid, used as passive-reply reference
  // for stream_messages (QQ API rejects the endpoint without msg_id).
  const lastIncomingMsgId = new Map<string, string>();

  // Rate-limit rejection messages
  const rejectTimestamps = new Map<string, number>();
  const REJECT_COOLDOWN_MS = 5 * 60 * 1000;

  function getNextMsgSeq(chatId: string): number {
    const current = msgSeqCounters.get(chatId) ?? 0;
    const next = current + 1;
    msgSeqCounters.set(chatId, next);
    return next;
  }

  // ─── Token Management ──────────────────────────────────────
  // getAccessToken / refreshToken 及其专属状态（tokenInfo /
  // tokenRefreshPromise，原 389-391）已整体抽至 ./qq-token.ts（ISSUE-12
  // 单元 2.11 原文搬运）。同名解构使 apiRequest / handleWsMessage / connect
  // 三处调用点零改动；refreshToken 仅被 getAccessToken 内部消费，不进工厂
  // 返回面；WS close 'refresh-token' 分支与 disconnect 的 token 复位经
  // resetToken() 等价承接。
  const { getAccessToken, resetToken } = createQQTokenManager(config);

  // ─── REST API ──────────────────────────────────────────────
  // apiRequest / getGatewayUrl 已抽至 ./qq-api.ts（ISSUE-12 单元 2.12 原文
  // 搬运）。tokens 仅 { getAccessToken } 结构子集（2.11 tokenManager 同名
  // 解构绑定直传）；getGatewayUrl 的 validateQQGatewayUrl 依赖（qq.ts 既有
  // 导出，不动）经同名参数注入，搬运体内调用逐字节保留。同名解构使
  // sendQQMessage / upload 链 / sendStreamMessage / connectWs /
  // scheduleReconnect 调用点零改动。QQApiError 随 apiRequest（唯一
  // throw 侧）迁至 qq-api.ts 并导出，qqUploadPartFinish /
  // qqPartFinishPersistentRetry 的 instanceof 判定经顶部 import 引用同一
  // 类身份（2.13 随段搬至 qq-media 后该 import 消失）。
  const { apiRequest, getGatewayUrl } = createQQApi(
    { getAccessToken },
    validateQQGatewayUrl,
  );

  // ─── Message Sending ──────────────────────────────────────

  async function sendQQMessage(
    chatType: 'c2c' | 'group',
    openid: string,
    content: string,
  ): Promise<void> {
    const chatKey = `${chatType}:${openid}`;
    const msgSeq = getNextMsgSeq(chatKey);

    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/messages`
        : `/v2/groups/${openid}/messages`;

    await apiRequest('POST', endpoint, {
      markdown: { content },
      msg_type: 2, // markdown
      msg_seq: msgSeq,
    });
  }

  // ─── Media Sending ───────────────────────────────────────
  // 原三段（Image Sending / Chunked File Upload / File Download，
  // 528-1023）与状态区 uploadCache 簇（405-473）已整体抽至 ./qq-media.ts
  // （ISSUE-12 单元 2.13 原文搬运）。api 仅 { apiRequest } 结构子集
  // （2.12 同名解构绑定字面量直传）；getNextMsgSeq 为 2.16 门面转发状态
  // （msgSeqCounters 本体留本文件），同名参数注入，搬运体内 msg_seq 计数
  // 调用逐字节保留；processQQAttachment 的 opts 收窄为 QQMediaConnectOpts
  // 结构子集（仅 resolveGroupFolder 实际消费）。QQApiError 改自
  // './qq-api.js' import，qq.ts 顶部该名随段删除（2.12 遗留提示落实）；
  // qqPartFinishPersistentRetry 的 setTimeout 生命周期归 media sender 所有，
  // 不绑 WS stop 链（现状即如此，保持）。同名解构使 facade sendMessage /
  // sendImage / sendFile 与 handleC2CMessage / handleGroupMessage 调用点
  // 零改动。
  const { sendQQImageMessage, sendQQFileMessage, processQQAttachment } =
    createQQMediaSender({ apiRequest }, getNextMsgSeq);

  // ─── WebSocket Connection ─────────────────────────────────

  // ─── WebSocket Connection ─────────────────────────────────
  // WS 重连互递归簇（clearTimers / stopWatchdog / startWatchdog / sendWs /
  // startHeartbeat / connectWs / handleWsMessage / scheduleReconnect，原
  // 287-606）已整簇抽至 ./qq-ws.ts（ISSUE-12 单元 2.14 原文搬运，整簇
  // 内聚禁止只抽一半；close/error 防双计数注释随段走）。WS 簇 14 个 let
  // 留守本文件状态区（feishu-ws-lifecycle 同款）——connect() /
  // disconnect() 门面的复位与清理行因此逐字节不变，qq-ws 经 get/set
  // 访问器对读写（stopping 门面独写故只读）。依赖注入：getAccessToken /
  // resetToken（2.11）、getGatewayUrl（2.12）、isConnected 门面前向引用
  //（闭包延迟求值，运行时序不变）、onC2CMessage / onGroupMessage
  // （OP_DISPATCH 分发，2.15 handler 本体留本文件，函数声明提升可用）。
  // 同名解构使 connect() 的 startWatchdog / connectWs 与 disconnect() 的
  // stopWatchdog / clearTimers 调用点零改动。
  const { startWatchdog, stopWatchdog, clearTimers, connectWs } =
    createQQWsSession({
      getWs: () => ws,
      setWs: (value) => {
        ws = value;
      },
      getHeartbeatTimer: () => heartbeatTimer,
      setHeartbeatTimer: (value) => {
        heartbeatTimer = value;
      },
      getReconnectTimer: () => reconnectTimer,
      setReconnectTimer: (value) => {
        reconnectTimer = value;
      },
      getWatchdogTimer: () => watchdogTimer,
      setWatchdogTimer: (value) => {
        watchdogTimer = value;
      },
      getReconnectAttempts: () => reconnectAttempts,
      setReconnectAttempts: (value) => {
        reconnectAttempts = value;
      },
      getLastSequence: () => lastSequence,
      setLastSequence: (value) => {
        lastSequence = value;
      },
      getSessionId: () => sessionId,
      setSessionId: (value) => {
        sessionId = value;
      },
      getResumeGatewayUrl: () => resumeGatewayUrl,
      setResumeGatewayUrl: (value) => {
        resumeGatewayUrl = value;
      },
      getStopping: () => stopping,
      getReadyFired: () => readyFired,
      setReadyFired: (value) => {
        readyFired = value;
      },
      getQuickDisconnectCount: () => quickDisconnectCount,
      setQuickDisconnectCount: (value) => {
        quickDisconnectCount = value;
      },
      getLastConnectTime: () => lastConnectTime,
      setLastConnectTime: (value) => {
        lastConnectTime = value;
      },
      getKeepaliveMode: () => keepaliveMode,
      setKeepaliveMode: (value) => {
        keepaliveMode = value;
      },
      getLastErrorIsTransient: () => lastErrorIsTransient,
      setLastErrorIsTransient: (value) => {
        lastErrorIsTransient = value;
      },
      getAccessToken,
      resetToken,
      getGatewayUrl,
      isConnected: () => connection.isConnected(),
      onC2CMessage: handleC2CMessage,
      onGroupMessage: handleGroupMessage,
    });

  // ─── Event Handlers ───────────────────────────────────────

  async function handleC2CMessage(
    data: any,
    opts: QQConnectOpts,
  ): Promise<void> {
    try {
      const msgId = data.id;
      if (!msgId) return;
      const msgTimeMs = data.timestamp ? new Date(data.timestamp).getTime() : 0;
      if (isStale(msgTimeMs)) {
        logger.debug(
          { msgId, msgTimeMs },
          'Stale QQ C2C message (>30min), dropping',
        );
        return;
      }
      if (dedup.isDuplicate(msgId)) return;
      if (!processingLock.acquire(msgId)) {
        logger.debug({ msgId }, 'QQ C2C message already in-flight, skipping');
        return;
      }
      dedup.markSeen(msgId);
      try {
        // Skip stale messages from before connection (hot-reload scenario)
        if (opts.ignoreMessagesBefore && data.timestamp) {
          const msgTime = new Date(data.timestamp).getTime();
          if (!isNaN(msgTime) && msgTime < opts.ignoreMessagesBefore) return;
        }

        const userOpenId = data.author?.id || data.author?.user_openid;
        if (!userOpenId) return;

        const jid =
          opts.normalizeIncomingJid?.(`qq:c2c:${userOpenId}`) ??
          `qq:c2c:${userOpenId}`;
        const realName = (data.author?.username || '').trim();
        const senderName = realName || `QQ用户`;
        const chatName = senderName;

        // Strip bot mention from content
        let content = (data.content || '').trim();

        // ── /pair <code> command ──
        // 统一走共享解析（严格语义：拒绝 /pair abc extra 这类多余参数），
        // 与微信及 channel-admission 共享语义保持一致。
        const pairCode = parseChannelPairingCode(content);
        if (pairCode !== null && opts.onPairAttempt) {
          try {
            const success = await opts.onPairAttempt(jid, chatName, pairCode);
            const reply = success
              ? '配对成功！此聊天已连接到你的账号。'
              : '配对码无效或已过期，请在 Web 设置页重新生成。';
            await sendQQMessage('c2c', userOpenId, reply);
          } catch (err) {
            logger.error({ err, jid }, 'QQ pair attempt error');
            await sendQQMessage('c2c', userOpenId, '配对失败，请稍后重试。');
          }
          return;
        }

        // ── Authorization check ──
        if (!opts.isChatAuthorized(jid)) {
          const now = Date.now();
          const lastReject = rejectTimestamps.get(jid) ?? 0;
          if (now - lastReject >= REJECT_COOLDOWN_MS) {
            rejectTimestamps.set(jid, now);
            await sendQQMessage(
              'c2c',
              userOpenId,
              '此聊天尚未配对。请发送 /pair <code> 进行配对。\n' +
                '你可以在 Web 设置页生成配对码。',
            );
          }
          return;
        }

        const resolvedRoute = resolveAdmittedChannelRoute(
          jid,
          opts.resolveEffectiveChatJid,
        );
        if (!resolvedRoute) {
          logger.warn(
            { jid },
            'QQ message dropped: binding resolver rejected route',
          );
          return;
        }
        const { targetJid, routing: agentRouting } = resolvedRoute;

        // Only a routable message may update reply context caches.
        lastIncomingMsgId.set(userOpenId, msgId);

        // ── Authorized: process message ──
        storeChatMetadata(jid, new Date().toISOString());

        // QQ C2C payloads usually omit author.username, so naively writing
        // chatName here would clobber user-set names (the rename API writes
        // to both chats.name and registered_groups.name).  Only persist when
        // the platform gave us a real username; otherwise pass the existing
        // registered name through so buildOnNewChat's diff guard leaves it
        // untouched, and fall back to the placeholder only for first-time
        // registration.
        if (realName) {
          updateChatName(jid, realName);
          opts.onNewChat(jid, realName);
        } else {
          const existing = getRegisteredGroup(jid);
          opts.onNewChat(jid, existing?.name ?? chatName);
        }

        // Handle slash commands
        const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
        if (slashMatch && opts.onCommand) {
          const cmdBody = (
            slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
          ).trim();
          try {
            // Namespace senderImId with `c2c:` prefix so owner_im_id 比对在
            // DM 与群聊上下文中独立——QQ Bot API v2 的 author.user_openid (C2C) 与
            // author.member_openid (Group) 是两个不同的 ID namespace，protocol
            // 层面不互通；前缀化让 DM 认领的 owner 与群里认领的 owner 各自落入
            // 独立记录，互不干扰。
            const reply = await opts.onCommand(
              jid,
              cmdBody,
              `c2c:${userOpenId}`,
            );
            if (reply) {
              await sendQQMessage(
                'c2c',
                userOpenId,
                markdownToPlainText(reply),
              );
              return;
            }
          } catch (err) {
            logger.error({ jid, err }, 'QQ slash command failed');
            await sendQQMessage('c2c', userOpenId, '命令执行失败，请稍后重试');
            return;
          }
        }

        // Handle attachments (images / files)
        let attachmentsJson: string | undefined;
        if (data.attachments?.length) {
          const result = await processQQAttachment(
            data.attachments[0],
            msgId,
            jid,
            content,
            opts,
            'c2c',
          );
          content = result.content;
          attachmentsJson = result.attachmentsJson;
        }

        // Store the already-resolved route. A configured resolver is
        // authoritative and was evaluated before registration/downloads.
        const id = crypto.randomUUID();
        let timestamp: string;
        try {
          timestamp = data.timestamp
            ? new Date(data.timestamp).toISOString()
            : new Date().toISOString();
        } catch {
          timestamp = new Date().toISOString();
        }
        const senderId = `qq:${userOpenId}`;
        storeChatMetadata(targetJid, timestamp);
        storeMessageDirect(
          id,
          targetJid,
          senderId,
          senderName,
          content,
          timestamp,
          false,
          { attachments: attachmentsJson, sourceJid: jid },
        );

        broadcastNewMessage(
          targetJid,
          {
            id,
            chat_jid: targetJid,
            source_jid: jid,
            sender: senderId,
            sender_name: senderName,
            content,
            timestamp,
            attachments: attachmentsJson,
            is_from_me: false,
          },
          agentRouting?.agentId ?? undefined,
        );
        notifyNewImMessage();

        if (agentRouting?.agentId) {
          opts.onAgentMessage?.(jid, agentRouting.agentId);
          logger.info(
            { jid, effectiveJid: targetJid, agentId: agentRouting.agentId },
            'QQ C2C message routed to agent',
          );
        } else {
          logger.info(
            { jid, sender: senderName, msgId },
            'QQ C2C message stored',
          );
        }
      } finally {
        processingLock.release(msgId);
      }
    } catch (err) {
      logger.error({ err }, 'Error handling QQ C2C message');
    }
  }

  async function handleGroupMessage(
    data: any,
    opts: QQConnectOpts,
  ): Promise<void> {
    try {
      const msgId = data.id;
      if (!msgId) return;
      const msgTimeMs = data.timestamp ? new Date(data.timestamp).getTime() : 0;
      if (isStale(msgTimeMs)) {
        logger.debug(
          { msgId, msgTimeMs },
          'Stale QQ group message (>30min), dropping',
        );
        return;
      }
      if (dedup.isDuplicate(msgId)) return;
      if (!processingLock.acquire(msgId)) {
        logger.debug({ msgId }, 'QQ group message already in-flight, skipping');
        return;
      }
      dedup.markSeen(msgId);
      try {
        // Skip stale messages from before connection (hot-reload scenario)
        if (opts.ignoreMessagesBefore && data.timestamp) {
          const msgTime = new Date(data.timestamp).getTime();
          if (!isNaN(msgTime) && msgTime < opts.ignoreMessagesBefore) return;
        }

        const groupOpenId = data.group_openid;
        if (!groupOpenId) return;

        const jid =
          opts.normalizeIncomingJid?.(`qq:group:${groupOpenId}`) ??
          `qq:group:${groupOpenId}`;
        const memberOpenId = data.author?.member_openid;
        const senderName = data.author?.username || `QQ群成员`;
        const chatName = `QQ群 ${groupOpenId.slice(0, 8)}`;

        // Strip bot mention text (e.g. <@!bot_id>)
        let content = (data.content || '').replace(/<@!\w+>/g, '').trim();

        // ── /pair <code> command ──
        // 同 c2c 分支：共享解析的严格语义（拒绝多余参数）。
        const pairCode = parseChannelPairingCode(content);
        if (pairCode !== null && opts.onPairAttempt) {
          try {
            const success = await opts.onPairAttempt(jid, chatName, pairCode);
            const reply = success
              ? '配对成功！此群聊已连接。'
              : '配对码无效或已过期，请在 Web 设置页重新生成。';
            await sendQQMessage('group', groupOpenId, reply);
          } catch (err) {
            logger.error({ err, jid }, 'QQ group pair attempt error');
            await sendQQMessage('group', groupOpenId, '配对失败，请稍后重试。');
          }
          return;
        }

        // ── Authorization check ──
        if (!opts.isChatAuthorized(jid)) {
          const now = Date.now();
          const lastReject = rejectTimestamps.get(jid) ?? 0;
          if (now - lastReject >= REJECT_COOLDOWN_MS) {
            rejectTimestamps.set(jid, now);
            await sendQQMessage(
              'group',
              groupOpenId,
              '此群聊尚未配对。请发送 /pair <code> 进行配对。',
            );
          }
          return;
        }

        const resolvedRoute = resolveAdmittedChannelRoute(
          jid,
          opts.resolveEffectiveChatJid,
        );
        if (!resolvedRoute) {
          logger.warn(
            { jid },
            'QQ group message dropped: binding resolver rejected route',
          );
          return;
        }
        const { targetJid, routing: agentRouting } = resolvedRoute;

        // ── Authorized: process message ──
        storeChatMetadata(jid, new Date().toISOString());

        // QQ group payloads don't carry a group name; chatName is always a
        // placeholder derived from groupOpenId.  Only write it on first-time
        // registration — otherwise we'd clobber user-set names (rename API).
        const existing = getRegisteredGroup(jid);
        if (!existing) {
          updateChatName(jid, chatName);
          opts.onNewChat(jid, chatName);
        } else {
          opts.onNewChat(jid, existing.name ?? chatName);
        }

        // Handle slash commands
        const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
        if (slashMatch && opts.onCommand) {
          const cmdBody = (
            slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
          ).trim();
          try {
            // Namespace senderImId with `group:` prefix——见 C2C 分支的注释。
            // member_openid 仅在群聊上下文有意义，与 C2C 的 user_openid 不互通。
            const reply = await opts.onCommand(
              jid,
              cmdBody,
              memberOpenId ? `group:${memberOpenId}` : undefined,
            );
            if (reply) {
              await sendQQMessage(
                'group',
                groupOpenId,
                markdownToPlainText(reply),
              );
              return;
            }
          } catch (err) {
            logger.error({ jid, err }, 'QQ group slash command failed');
            await sendQQMessage(
              'group',
              groupOpenId,
              '命令执行失败，请稍后重试',
            );
            return;
          }
        }

        // Handle attachments (images / files)
        let attachmentsJson: string | undefined;
        if (data.attachments?.length) {
          const result = await processQQAttachment(
            data.attachments[0],
            msgId,
            jid,
            content,
            opts,
            'group',
          );
          content = result.content;
          attachmentsJson = result.attachmentsJson;
        }

        // Store the already-resolved route.
        const id = crypto.randomUUID();
        let timestamp: string;
        try {
          timestamp = data.timestamp
            ? new Date(data.timestamp).toISOString()
            : new Date().toISOString();
        } catch {
          timestamp = new Date().toISOString();
        }
        const senderId = memberOpenId ? `qq:${memberOpenId}` : 'qq:unknown';
        storeChatMetadata(targetJid, timestamp);
        storeMessageDirect(
          id,
          targetJid,
          senderId,
          senderName,
          content,
          timestamp,
          false,
          { attachments: attachmentsJson, sourceJid: jid },
        );

        broadcastNewMessage(
          targetJid,
          {
            id,
            chat_jid: targetJid,
            source_jid: jid,
            sender: senderId,
            sender_name: senderName,
            content,
            timestamp,
            attachments: attachmentsJson,
            is_from_me: false,
          },
          agentRouting?.agentId ?? undefined,
        );
        notifyNewImMessage();

        if (agentRouting?.agentId) {
          opts.onAgentMessage?.(jid, agentRouting.agentId);
        }

        logger.info(
          { jid, sender: senderName, msgId },
          'QQ group message stored',
        );
      } finally {
        processingLock.release(msgId);
      }
    } catch (err) {
      logger.error({ err }, 'Error handling QQ group message');
    }
  }

  // ─── Connection Interface ─────────────────────────────────

  const connection: QQConnection = {
    async connect(opts: QQConnectOpts): Promise<void> {
      if (!config.appId || !config.appSecret) {
        logger.info('QQ appId/appSecret not configured, skipping');
        return;
      }

      stopping = false;
      readyFired = false;
      reconnectAttempts = 0;
      sessionId = null;
      lastSequence = null;
      quickDisconnectCount = 0;
      lastConnectTime = 0;
      keepaliveMode = false;
      lastErrorIsTransient = false;

      startWatchdog(opts);

      try {
        // Validate token first
        await getAccessToken();

        // Get gateway and connect WebSocket
        const gatewayUrl = await getGatewayUrl();
        await connectWs(opts, gatewayUrl, false);
      } catch (err) {
        logger.error({ err }, 'QQ initial connection failed');
        lastErrorIsTransient = isTransientError(err);
        // The manager has not accepted/tracked this connector yet. Starting a
        // watchdog reconnect here would create a background "ghost" Bot after
        // the adapter returns false and its credential claim is released.
        // The outer adapter immediately calls disconnect() for deterministic
        // timer/socket cleanup; a later explicit reload performs the retry.
      }
    },

    async disconnect(): Promise<void> {
      stopping = true;
      stopWatchdog();
      clearTimers();

      if (ws) {
        try {
          ws.close(1000, 'Disconnecting');
        } catch (err) {
          logger.debug({ err }, 'Error closing QQ WebSocket');
        }
        ws = null;
      }

      resetToken();
      sessionId = null;
      lastSequence = null;
      resumeGatewayUrl = null;
      reconnectAttempts = 0;
      quickDisconnectCount = 0;
      lastConnectTime = 0;
      keepaliveMode = false;
      lastErrorIsTransient = false;
      dedup.clear();
      msgSeqCounters.clear();
      rejectTimestamps.clear();
      processingLock.dispose();
      logger.info('QQ bot disconnected');
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      const parsed = parseQQChatId(chatId);
      if (!parsed) {
        logger.error({ chatId }, 'Invalid QQ chat ID format');
        throw new Error(`Invalid QQ chat ID format: ${chatId}`);
      }

      try {
        const chunks = splitTextChunks(text, MSG_SPLIT_LIMIT);

        for (const chunk of chunks) {
          await sendQQMessage(parsed.type, parsed.openid, chunk);
        }

        // Send local images after text (same pattern as Feishu)
        for (const imgPath of localImagePaths || []) {
          try {
            const buf = fs.readFileSync(imgPath);
            await sendQQImageMessage(parsed.type, parsed.openid, buf);
            logger.info({ chatId, imgPath }, 'QQ local image sent');
          } catch (imgErr) {
            logger.error(
              { err: imgErr, chatId, imgPath },
              'Failed to send local image via QQ',
            );
            throw imgErr;
          }
        }

        logger.info({ chatId }, 'QQ message sent');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send QQ message');
        throw err;
      }
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      _mimeType: string,
      caption?: string,
      _fileName?: string,
    ): Promise<void> {
      const parsed = parseQQChatId(chatId);
      if (!parsed) {
        logger.error({ chatId }, 'Invalid QQ chat ID format for image');
        throw new Error(`Invalid QQ chat ID format for image: ${chatId}`);
      }

      try {
        await sendQQImageMessage(
          parsed.type,
          parsed.openid,
          imageBuffer,
          caption,
        );
        logger.info({ chatId }, 'QQ image sent');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send QQ image');
        throw err;
      }
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      const parsed = parseQQChatId(chatId);
      if (!parsed) {
        logger.error({ chatId }, 'Invalid QQ chat ID format for file');
        throw new Error(`Invalid QQ chat ID format for file: ${chatId}`);
      }

      try {
        await sendQQFileMessage(parsed.type, parsed.openid, filePath, fileName);
        logger.info({ chatId, fileName }, 'QQ file sent');
      } catch (err) {
        logger.error({ err, chatId, fileName }, 'Failed to send QQ file');
        throw err;
      }
    },

    async sendChatAction(_chatId: string, _action: 'typing'): Promise<void> {
      // QQ Bot API v2 does not support typing indicators
    },

    isConnected(): boolean {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },

    async sendStreamMessage(
      openid: string,
      params: {
        input_mode: string;
        input_state: number;
        content_type: string;
        content_raw: string;
        msg_seq: number;
        index: number;
        stream_msg_id?: string;
        msg_id?: string;
        event_id?: string;
      },
    ): Promise<{ id?: string }> {
      const endpoint = `/v2/users/${openid}/stream_messages`;
      const body: Record<string, unknown> = {
        input_mode: params.input_mode,
        input_state: params.input_state,
        content_type: params.content_type,
        content_raw: params.content_raw,
        msg_seq: params.msg_seq,
        index: params.index,
      };
      if (params.stream_msg_id) {
        body.stream_msg_id = params.stream_msg_id;
      }
      if (params.msg_id) {
        body.msg_id = params.msg_id;
      }
      if (params.event_id) {
        body.event_id = params.event_id;
      }
      return apiRequest<{ id?: string }>('POST', endpoint, body);
    },

    getNextMsgSeq(chatId: string): number {
      return getNextMsgSeq(chatId);
    },

    getLastIncomingMsgId(openid: string): string | undefined {
      return lastIncomingMsgId.get(openid);
    },
  };

  return connection;
}
