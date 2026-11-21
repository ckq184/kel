/**
 * WeChat iLink 入站消息管线（原 src/wechat.ts createWeChatConnection 工厂内
 * “Message Processing”段 processMessage（原 wechat.ts:558-808，约 250 行：
 * bot 自身跳过 + dedup + 时效过滤、/pair 共享解析、未授权拒绝冷却 +
 * resolveAdmittedChannelRoute 准入、斜杠指令、媒体循环、store / broadcast /
 * notify / onAgentMessage），及仅该段消费的模块级素材——extractTextContent /
 * dedupKey 助手、WeixinMessage / MessageItem / CDNMedia 类型声明、db 三写
 * 函数 / notifyNewImMessage / broadcastNewMessage / markdownToPlainText /
 * channel-admission 两解析 / crypto 共六组 import——ISSUE-12 单元 2.20
 * 原文搬运）。
 *
 * 搬运体保真：processMessage 函数体零机械替换——全部闭包标识符经 deps
 * 同名解构绑定（dedup / knownJids / contextTokenCache / rejectTimestamps /
 * REJECT_COOLDOWN_MS / sendMessageApi / processImageItem / processFileItem）；
 * 唯一替换是 opts 形参类型收窄为 WeChatInboundConnectOpts 结构子集
 *（2.15 qq-inbound ④同款，完整 WeChatConnectOpts 经结构化类型自然满足）。
 *
 * 状态留守+引用注入（2.15 qq-inbound 同款）：四状态簇本体与
 * REJECT_COOLDOWN_MS 常数留守 src/wechat.ts 状态区——connect / disconnect
 * 的清理行因此逐字节不变；contextTokenCache 与 2.18 createWeChatSender 的
 * contextTokens 注入为同一 Map 实例，processMessage 的 set 写点即该缓存
 * 本体，写读语义不变。
 *
 * 依赖注入：sendMessageApi（2.18 createWeChatSender 返回面）、
 * processImageItem / processFileItem（2.19 createWeChatMedia 返回面）经
 * deps 同名透传；MESSAGE_TYPE_BOT / MESSAGE_ITEM_TYPE_TEXT / IMAGE / FILE
 * 常数自 wechat-outbound sibling import（2.18 已安家该处）。
 *
 * 锚点：channel-attachment-routing-order 的微信路由顺序契约
 *（isChatAuthorized → resolveAdmittedChannelRoute → storeChatMetadata /
 * processImageItem）与 channel-pairing-uniform 的 /pair 接线断言随本单元
 * 等强改锚本模块，断言文本逐字不变（2.15 体例）。
 */
import crypto from 'crypto';
import { storeChatMetadata, storeMessageDirect, updateChatName } from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import { markdownToPlainText } from './im-utils.js';
import {
  parseChannelPairingCode,
  resolveAdmittedChannelRoute,
} from './channel-admission.js';
import {
  MESSAGE_ITEM_TYPE_FILE,
  MESSAGE_ITEM_TYPE_IMAGE,
  MESSAGE_ITEM_TYPE_TEXT,
  MESSAGE_TYPE_BOT,
} from './wechat-outbound.js';

// ─── Types ──────────────────────────────────────────────────────

// 原 src/wechat.ts 的 WeixinMessage / MessageItem / CDNMedia（均未导出，
// 消费面全数随本段迁移）随段迁移为本模块原定义，字段逐字节一致；
// wechat-api / wechat-media 的既有结构镜像经结构化类型继续互通。
interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: CDNMedia; aeskey?: string; url?: string };
  voice_item?: { media?: CDNMedia; text?: string };
  file_item?: { media?: CDNMedia; file_name?: string };
  video_item?: { media?: CDNMedia };
  ref_msg?: { message_item?: MessageItem; title?: string };
}

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
}

// src/wechat.ts 的 WeChatConnectOpts（已导出，外层门面约束不动）的结构
// 子集——仅收 processMessage 实际消费的九个字段；activeOpts 的完整
// WeChatConnectOpts 运行时值经结构化类型自然满足。
interface WeChatInboundConnectOpts {
  ignoreMessagesBefore?: number;
  normalizeIncomingJid?: (jid: string) => string;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  isChatAuthorized?: (jid: string) => boolean;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onNewChat: (jid: string, name: string) => void;
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
  ) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
}

/**
 * 留守闭包状态与跨模块返回面的访问器集（本体留 src/wechat.ts 状态区，
 * 2.15 qq-inbound 同款）。contextTokenCache 与 2.18 createWeChatSender 的
 * contextTokens 注入为同一 Map 实例；dedup 仅声明 processMessage 消费的
 * isDuplicate / markSeen（完整 createDedupCache 返回面结构化满足）。
 */
export interface WeChatInboundDeps {
  sendMessageApi: (
    toUserId: string,
    contextToken: string,
    text: string,
  ) => Promise<void>;
  /** 2.19 media 的图片项处理入口；msgIdentifier / groupFolder 形参原样。 */
  processImageItem: (
    item: MessageItem,
    msgIdentifier: string,
    groupFolder: string | undefined,
  ) => Promise<{
    attachmentEntry?: { type: string; data: string; mimeType: string };
    textPrefix?: string;
  }>;
  /** 2.19 media 的文件项处理入口；groupFolder 形参原样。 */
  processFileItem: (
    item: MessageItem,
    groupFolder: string | undefined,
  ) => Promise<string | null>;
  dedup: {
    isDuplicate: (key: string) => boolean;
    markSeen: (key: string) => void;
  };
  knownJids: Set<string>;
  contextTokenCache: Map<string, string>;
  rejectTimestamps: Map<string, number>;
  REJECT_COOLDOWN_MS: number;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Extract text content from message item_list.
 * Includes voice-to-text transcription and fallback labels for non-text items.
 */
function extractTextContent(items: MessageItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === MESSAGE_ITEM_TYPE_TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === MESSAGE_ITEM_TYPE_IMAGE) {
      // Image placeholder — actual image is handled separately via CDN download
      // Only add placeholder if no CDN media to download
      if (!item.image_item?.media?.encrypt_query_param) {
        parts.push('(image)');
      }
    } else if (item.type === 3 /* VOICE */) {
      // Voice: prefer speech-to-text transcription
      if (item.voice_item?.text) {
        parts.push(item.voice_item.text);
      } else {
        parts.push('(voice)');
      }
    } else if (item.type === MESSAGE_ITEM_TYPE_FILE) {
      // Only add placeholder if no CDN media to download
      // (processFileItem will generate a [文件: ...] prefix for downloadable files)
      if (!item.file_item?.media?.encrypt_query_param) {
        parts.push(`(file: ${item.file_item?.file_name ?? 'unknown'})`);
      }
    } else if (item.type === 5 /* VIDEO */) {
      parts.push('(video)');
    }
  }
  return parts.join('\n').trim();
}

/**
 * Generate a unique dedup key from a WeixinMessage.
 */
function dedupKey(msg: WeixinMessage): string {
  if (msg.message_id !== undefined) return `mid:${msg.message_id}`;
  if (msg.seq !== undefined) return `seq:${msg.seq}`;
  // Fallback: combination of sender + timestamp + client_id
  return `fallback:${msg.from_user_id}:${msg.create_time_ms}:${msg.client_id}`;
}

// ─── Factory ─────────────────────────────────────────────────────

export function createWeChatInboundProcessor(deps: WeChatInboundDeps) {
  const {
    sendMessageApi,
    processImageItem,
    processFileItem,
    dedup,
    knownJids,
    contextTokenCache,
    rejectTimestamps,
    REJECT_COOLDOWN_MS,
  } = deps;

  // ─── Message Processing ───────────────────────────────────

  async function processMessage(
    msg: WeixinMessage,
    opts: WeChatInboundConnectOpts,
  ): Promise<void> {
    try {
      // Skip bot's own messages
      if (msg.message_type === MESSAGE_TYPE_BOT) return;

      const fromUserId = msg.from_user_id;
      if (!fromUserId) return;

      // Dedup
      const key = dedupKey(msg);
      if (dedup.isDuplicate(key)) return;
      dedup.markSeen(key);

      // Skip stale messages — if no timestamp available, skip as well (can't verify freshness)
      if (opts.ignoreMessagesBefore) {
        if (
          !msg.create_time_ms ||
          msg.create_time_ms < opts.ignoreMessagesBefore
        )
          return;
      }

      const jid =
        opts.normalizeIncomingJid?.(`wechat:${fromUserId}`) ??
        `wechat:${fromUserId}`;
      const senderName = fromUserId.split('@')[0] || 'WeChat用户';
      const chatName = senderName;

      // Extract text content
      let content = msg.item_list ? extractTextContent(msg.item_list) : '';

      // Pairing and admission must run before registration, workspace lookup,
      // file downloads, or message persistence. QR authorization authenticates
      // the bot account; it does not authorize every person who can message it.
      // 统一走共享解析（严格语义：拒绝 /pair abc extra 这类多余参数），与 QQ
      // 及 channel-admission 共享语义保持一致。
      const pairCode = parseChannelPairingCode(content);
      if (pairCode !== null && opts.onPairAttempt) {
        try {
          const success = await opts.onPairAttempt(jid, chatName, pairCode);
          if (msg.context_token) {
            await sendMessageApi(
              fromUserId,
              msg.context_token,
              success
                ? '配对成功，此微信会话已连接。'
                : '配对码无效或已过期，请在网页设置中重新生成。',
            );
          }
        } catch (err) {
          logger.error({ err, jid }, 'WeChat pair attempt failed');
          if (msg.context_token) {
            await sendMessageApi(
              fromUserId,
              msg.context_token,
              '配对失败，请稍后重试。',
            );
          }
        }
        return;
      }

      if (!(opts.isChatAuthorized?.(jid) ?? false)) {
        const now = Date.now();
        const lastReject = rejectTimestamps.get(jid) ?? 0;
        if (msg.context_token && now - lastReject >= REJECT_COOLDOWN_MS) {
          rejectTimestamps.set(jid, now);
          await sendMessageApi(
            fromUserId,
            msg.context_token,
            '此微信会话尚未配对。请在网页设置中生成配对码，然后发送 /pair <配对码>。',
          );
        }
        logger.debug({ jid }, 'Unauthorized WeChat chat, message ignored');
        return;
      }

      const resolvedRoute = resolveAdmittedChannelRoute(
        jid,
        opts.resolveEffectiveChatJid,
      );
      if (!resolvedRoute) {
        logger.warn(
          { jid },
          'WeChat message dropped: binding resolver rejected route',
        );
        return;
      }
      const { targetJid, routing: agentRouting } = resolvedRoute;

      // Cache a reply token only after authorization, preventing arbitrary
      // senders from growing the long-lived per-connection cache.
      if (msg.context_token) {
        contextTokenCache.set(fromUserId, msg.context_token);
      }

      // ── Register the authorized base chat ──
      const nowIso = new Date().toISOString();
      if (!knownJids.has(jid)) {
        knownJids.add(jid);
        storeChatMetadata(jid, nowIso);
        updateChatName(jid, chatName);
        opts.onNewChat(jid, chatName);
      }

      // Handle slash commands
      const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
      if (slashMatch && opts.onCommand) {
        const cmdBody = (
          slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
        ).trim();
        try {
          const reply = await opts.onCommand(jid, cmdBody, fromUserId);
          if (reply) {
            const ct = contextTokenCache.get(fromUserId);
            if (ct) {
              await sendMessageApi(fromUserId, ct, markdownToPlainText(reply));
            }
            return;
          }
        } catch (err) {
          logger.error({ jid, err }, 'WeChat slash command failed');
          const ct = contextTokenCache.get(fromUserId);
          if (ct) {
            await sendMessageApi(fromUserId, ct, '命令执行失败，请稍后重试');
          }
          return;
        }
      }

      // Handle image attachments
      let attachmentsJson: string | undefined;
      const groupFolder = opts.resolveGroupFolder?.(jid);
      if (msg.item_list) {
        const imageAttachments: {
          type: string;
          data: string;
          mimeType: string;
        }[] = [];
        const textPrefixes: string[] = [];

        // Note: textPrefixes order depends on CDN response time, not message item order
        // Download images and files in parallel (independent CDN requests)
        const msgId =
          msg.message_id !== undefined
            ? String(msg.message_id)
            : String(msg.seq ?? Date.now());

        const mediaPromises: Promise<void>[] = [];

        for (const item of msg.item_list) {
          if (item.type === MESSAGE_ITEM_TYPE_IMAGE) {
            mediaPromises.push(
              processImageItem(item, msgId.slice(-8), groupFolder).then((r) => {
                if (r.attachmentEntry) imageAttachments.push(r.attachmentEntry);
                if (r.textPrefix) textPrefixes.push(r.textPrefix);
              }),
            );
          } else if (item.type === MESSAGE_ITEM_TYPE_FILE) {
            mediaPromises.push(
              processFileItem(item, groupFolder).then((label) => {
                if (label) textPrefixes.push(label);
              }),
            );
          }
        }

        if (mediaPromises.length > 0) {
          await Promise.allSettled(mediaPromises);
        }

        // Merge file/media labels into content independently of images: a
        // file-only message (no imageAttachments) would otherwise drop its
        // textPrefixes and hit `if (!content) return` below → silently lost.
        if (textPrefixes.length > 0) {
          content = `${textPrefixes.join('\n')}\n${content}`.trim();
        }
        if (imageAttachments.length > 0) {
          attachmentsJson = JSON.stringify(imageAttachments);
        }

        if (!content && imageAttachments.length > 0) {
          content = '[图片]';
        }
      }

      if (!content) return; // No usable content

      // Route was resolved before registration and media download.
      const id = crypto.randomUUID();
      const timestamp = msg.create_time_ms
        ? new Date(msg.create_time_ms).toISOString()
        : nowIso;
      const senderId = `wechat:${fromUserId}`;

      if (targetJid !== jid) storeChatMetadata(targetJid, timestamp);
      storeMessageDirect(
        id,
        targetJid,
        senderId,
        senderName,
        content,
        timestamp,
        false,
        {
          attachments: attachmentsJson,
          sourceJid: jid,
        },
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
          'WeChat message routed to agent',
        );
      } else {
        logger.info(
          { jid, sender: senderName, msgId: msg.message_id ?? msg.seq },
          'WeChat message stored',
        );
      }
    } catch (err) {
      logger.error(
        { err, msgId: msg.message_id },
        'Error handling WeChat message',
      );
    }
  }

  return {
    processMessage,
  };
}
