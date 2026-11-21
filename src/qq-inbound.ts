/**
 * QQ 入站消息处理（原 src/qq.ts createQQConnection 工厂内 C2C/群两
 * handler qq.ts:332-751，ISSUE-12 单元 2.15 原文搬运 + 镜像合一）。
 *
 * 镜像合一形态：processQQInboundMessage(kind, data, opts) 单函数承载两
 * 侧全部语句；23 处差异点以 kind 双态表达——单行文案差异用双字面量
 * 三元（两臂均为原文），结构差异（身份/onNewChat/lastIncomingMsgId/
 * agent 路由日志）用 kind 分支保留两侧原文与控制流，不合并选边。
 * 合一的机械替换仅四类：①差异点 kind 分支/双字面量三元；②sendQQMessage
 * 与 processQQAttachment 的 kind 实参与发送目标以 kind/peerOpenId
 * 参数化（原字面量保留在 kind 类型值中）；③分支间共享局部声明上提为
 * let（jid/content/senderName/chatName/peerOpenId；userOpenId/realName/
 * memberOpenId 为 kind 侧独有下游引用，初始化哨值不参与行为）；
 * ④opts 形参收窄为 QQInboundConnectOpts 结构子集。
 *
 * 状态注入（2.14 状态留守同款）：dedup / processingLock /
 * rejectTimestamps / REJECT_COOLDOWN_MS / lastIncomingMsgId 本体留守
 * src/qq.ts（disconnect 清理行与门面 getLastIncomingMsgId 读点逐字节
 * 不变）；lastIncomingMsgId 写入点（原 qq.ts:421）随 c2c 分支迁入，经
 * 注入的同一 Map 实例回接。
 *
 * 入口：handleC2CMessage / handleGroupMessage 原名沿用（2.14 qq-ws 的
 * onC2CMessage / onGroupMessage 接线行零改动），内部转发 kind。
 */
import crypto from 'crypto';
import {
  getRegisteredGroup,
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
} from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import {
  parseChannelPairingCode,
  resolveAdmittedChannelRoute,
} from './channel-admission.js';
import { logger } from './logger.js';
import { markdownToPlainText } from './im-utils.js';
import { isStale } from './im-safety/index.js';

// src/qq.ts 的 QQConnectOpts（未导出）的结构子集——仅收入站处理实际消费
// 的字段（含透传给 processQQAttachment 所需的 resolveGroupFolder）；完整
// QQConnectOpts 经结构化类型自然满足（2.14 qq-ws 以 any 形参注入本函数
// 族，qq.ts 侧类型不降级）。
interface QQInboundConnectOpts {
  ignoreMessagesBefore?: number;
  normalizeIncomingJid?: (jid: string) => string;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  isChatAuthorized: (jid: string) => boolean;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onNewChat: (jid: string, name: string) => void;
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
  ) => Promise<string | null>;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  resolveGroupFolder?: (jid: string) => string | undefined;
}

/** 入站处理的外置状态与协作依赖（状态本体留守 src/qq.ts，2.14 同款）。 */
export interface QQInboundDeps {
  sendQQMessage: (
    chatType: 'c2c' | 'group',
    openid: string,
    content: string,
  ) => Promise<void>;
  /** 2.13 media sender 的附件处理入口；opts 形参以结构子集
   * （resolveGroupFolder）声明，QQInboundConnectOpts 结构化满足。 */
  processQQAttachment: (
    attachment: { url?: string; filename?: string },
    msgId: string,
    jid: string,
    content: string,
    opts: { resolveGroupFolder?: (jid: string) => string | undefined },
    logContext: string,
  ) => Promise<{ content: string; attachmentsJson?: string }>;
  dedup: {
    isDuplicate: (id: string) => boolean;
    markSeen: (id: string) => void;
  };
  processingLock: {
    acquire: (id: string) => boolean;
    release: (id: string) => void;
  };
  rejectTimestamps: Map<string, number>;
  REJECT_COOLDOWN_MS: number;
  lastIncomingMsgId: Map<string, string>;
}

export function createQQInboundProcessor(deps: QQInboundDeps) {
  const {
    sendQQMessage,
    processQQAttachment,
    dedup,
    processingLock,
    rejectTimestamps,
    REJECT_COOLDOWN_MS,
    lastIncomingMsgId,
  } = deps;

  async function processQQInboundMessage(
    kind: 'c2c' | 'group',
    data: any,
    opts: QQInboundConnectOpts,
  ): Promise<void> {
    try {
      const msgId = data.id;
      if (!msgId) return;
      const msgTimeMs = data.timestamp ? new Date(data.timestamp).getTime() : 0;
      if (isStale(msgTimeMs)) {
        logger.debug(
          { msgId, msgTimeMs },
          kind === 'c2c'
            ? 'Stale QQ C2C message (>30min), dropping'
            : 'Stale QQ group message (>30min), dropping',
        );
        return;
      }
      if (dedup.isDuplicate(msgId)) return;
      if (!processingLock.acquire(msgId)) {
        logger.debug(
          { msgId },
          kind === 'c2c'
            ? 'QQ C2C message already in-flight, skipping'
            : 'QQ group message already in-flight, skipping',
        );
        return;
      }
      dedup.markSeen(msgId);
      try {
        // Skip stale messages from before connection (hot-reload scenario)
        if (opts.ignoreMessagesBefore && data.timestamp) {
          const msgTime = new Date(data.timestamp).getTime();
          if (!isNaN(msgTime) && msgTime < opts.ignoreMessagesBefore) return;
        }

        // ── 差异点（kind 双态保留）：chat id 来源、发送者身份、jid 前缀
        // 与 mention 剥离。两分支语句表达式逐字节；合一的机械替换仅
        // const 声明上提为 let（下游共享 jid/content/senderName/chatName/
        // peerOpenId；userOpenId/realName/memberOpenId 为单侧独有下游
        // 引用，哨值初始化不参与行为）。peerOpenId 为发送目标胶水变量。
        let peerOpenId: string;
        let userOpenId = ''; // c2c 独有下游引用
        let realName = ''; // c2c 独有下游引用
        let memberOpenId: string | undefined = undefined; // group 独有下游引用
        let senderName: string;
        let chatName: string;
        let jid: string;
        let content: string;
        if (kind === 'c2c') {
          userOpenId = data.author?.id || data.author?.user_openid;
          if (!userOpenId) return;
          peerOpenId = userOpenId;
          jid =
            opts.normalizeIncomingJid?.(`qq:c2c:${userOpenId}`) ??
            `qq:c2c:${userOpenId}`;
          realName = (data.author?.username || '').trim();
          senderName = realName || `QQ用户`;
          chatName = senderName;

          // Strip bot mention from content
          content = (data.content || '').trim();
        } else {
          const groupOpenId = data.group_openid;
          if (!groupOpenId) return;
          peerOpenId = groupOpenId;
          jid =
            opts.normalizeIncomingJid?.(`qq:group:${groupOpenId}`) ??
            `qq:group:${groupOpenId}`;
          memberOpenId = data.author?.member_openid;
          senderName = data.author?.username || `QQ群成员`;
          chatName = `QQ群 ${groupOpenId.slice(0, 8)}`;

          // Strip bot mention text (e.g. <@!bot_id>)
          content = (data.content || '').replace(/<@!\w+>/g, '').trim();
        }

        // ── /pair <code> command ──
        // 统一走共享解析（严格语义：拒绝 /pair abc extra 这类多余参数），
        // 与微信及 channel-admission 共享语义保持一致。
        // 同 c2c 分支：共享解析的严格语义（拒绝多余参数）。
        const pairCode = parseChannelPairingCode(content);
        if (pairCode !== null && opts.onPairAttempt) {
          try {
            const success = await opts.onPairAttempt(jid, chatName, pairCode);
            const reply = success
              ? kind === 'c2c'
                ? '配对成功！此聊天已连接到你的账号。'
                : '配对成功！此群聊已连接。'
              : '配对码无效或已过期，请在 Web 设置页重新生成。';
            await sendQQMessage(kind, peerOpenId, reply);
          } catch (err) {
            logger.error(
              { err, jid },
              kind === 'c2c'
                ? 'QQ pair attempt error'
                : 'QQ group pair attempt error',
            );
            await sendQQMessage(kind, peerOpenId, '配对失败，请稍后重试。');
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
              kind,
              peerOpenId,
              kind === 'c2c'
                ? '此聊天尚未配对。请发送 /pair <code> 进行配对。\n' +
                    '你可以在 Web 设置页生成配对码。'
                : '此群聊尚未配对。请发送 /pair <code> 进行配对。',
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
            kind === 'c2c'
              ? 'QQ message dropped: binding resolver rejected route'
              : 'QQ group message dropped: binding resolver rejected route',
          );
          return;
        }
        const { targetJid, routing: agentRouting } = resolvedRoute;

        // Only a routable message may update reply context caches.
        if (kind === 'c2c') {
          lastIncomingMsgId.set(userOpenId, msgId);
        }

        // ── Authorized: process message ──
        storeChatMetadata(jid, new Date().toISOString());

        // ── 差异点（kind 双态保留）：onNewChat 触发条件 ──
        if (kind === 'c2c') {
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
        } else {
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
            // Namespace senderImId with `group:` prefix——见 C2C 分支的注释。
            // member_openid 仅在群聊上下文有意义，与 C2C 的 user_openid 不互通。
            const reply = await opts.onCommand(
              jid,
              cmdBody,
              kind === 'c2c'
                ? `c2c:${userOpenId}`
                : memberOpenId
                  ? `group:${memberOpenId}`
                  : undefined,
            );
            if (reply) {
              await sendQQMessage(kind, peerOpenId, markdownToPlainText(reply));
              return;
            }
          } catch (err) {
            logger.error(
              { jid, err },
              kind === 'c2c'
                ? 'QQ slash command failed'
                : 'QQ group slash command failed',
            );
            await sendQQMessage(kind, peerOpenId, '命令执行失败，请稍后重试');
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
            kind,
          );
          content = result.content;
          attachmentsJson = result.attachmentsJson;
        }

        // Store the already-resolved route. A configured resolver is
        // authoritative and was evaluated before registration/downloads.
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
        // ── 差异点（kind 双态保留）：senderId namespace ──
        const senderId =
          kind === 'c2c'
            ? `qq:${userOpenId}`
            : memberOpenId
              ? `qq:${memberOpenId}`
              : 'qq:unknown';
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

        // ── 差异点（kind 双态保留）：agent 路由日志（c2c 为 if/else 双
        // 日志，群为 if 后无条件 stored 日志——两侧结构逐态保留）──
        if (agentRouting?.agentId) {
          opts.onAgentMessage?.(jid, agentRouting.agentId);
          if (kind === 'c2c') {
            logger.info(
              { jid, effectiveJid: targetJid, agentId: agentRouting.agentId },
              'QQ C2C message routed to agent',
            );
          }
        } else if (kind === 'c2c') {
          logger.info(
            { jid, sender: senderName, msgId },
            'QQ C2C message stored',
          );
        }

        if (kind === 'group') {
          logger.info(
            { jid, sender: senderName, msgId },
            'QQ group message stored',
          );
        }
      } finally {
        processingLock.release(msgId);
      }
    } catch (err) {
      logger.error(
        { err },
        kind === 'c2c'
          ? 'Error handling QQ C2C message'
          : 'Error handling QQ group message',
      );
    }
  }

  /** 2.14 qq-ws 的 onC2CMessage 入口（原名沿用，qq.ts 接线行零改动）。 */
  async function handleC2CMessage(
    data: any,
    opts: QQInboundConnectOpts,
  ): Promise<void> {
    await processQQInboundMessage('c2c', data, opts);
  }

  /** 2.14 qq-ws 的 onGroupMessage 入口（原名沿用，qq.ts 接线行零改动）。 */
  async function handleGroupMessage(
    data: any,
    opts: QQInboundConnectOpts,
  ): Promise<void> {
    await processQQInboundMessage('group', data, opts);
  }

  return {
    handleC2CMessage,
    handleGroupMessage,
  };
}
