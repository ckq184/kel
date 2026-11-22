import fs from 'fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type * as lark from '@larksuiteoapi/node-sdk';
import { logger } from './logger.js';
import { parsePrebuiltInteractiveCardText } from './feishu-cards/builder.js';
import {
  processingIndicatorKey,
  type ExactAsyncIndicatorRegistry,
} from './processing-indicator.js';

// 飞书底层发送链（原 createFeishuConnection 工厂内闭包与 connection 门面方法体，
// ISSUE-12 单元 2.4 原文搬运）。F8 辅助群 getSenderName / addReaction /
// removeReactionStrict / clearAckForInput / p2pLastMessageId、F9
// replyToFeishuMessage / sendToFeishu 与门面 sendMessage / sendImage / sendFile
// 本体全部收进 createFeishuSender；sendTextToChat 的消费方为入站主管道
// （processClaimedIncomingMessage），本体留在 src/feishu.ts，经同名绑定调用
// 迁出后的 sendToFeishu。外层可变 client 为 let，经 getClient 访问器注入
// （搬运体内仅机械补一行 `const client = getClient();`）；senderNameCache /
// lastMessageIdByChat / chatTypeById / ackReactions 工厂闭包状态与 feishu.ts
// 模块级纯函数（parseFeishuRouteTarget / requireFeishuRouteTarget /
// assertFeishuApiSuccess / requireFeishuUploadKey / buildPostMdFallback 等）经
// deps 同名注入，搬运体内引用逐字节不变。sendMessage 图片附件失败必须原样
// 抛出（tests/im-send-strict-ack.test.ts 锚定，不得改成静默降级）。

// 本地结构副本：src/feishu.ts 的同名接口未导出（该文件导出面须保持不变），
// 字段与其逐字节一致，结构化类型保证两侧 requireFeishuRouteTarget 等可互赋
// （与 feishu-backfill.ts 的接口副本同款，遗留单元 2.7 一并消除）。
interface FeishuRouteTarget {
  raw: string;
  chatId: string;
  threadId?: string;
  rootMessageId?: string;
  replyInThread: boolean;
}

export interface FeishuSenderDeps {
  getClient: () => lark.Client | null;
  senderNameCache: Map<string, string>;
  lastMessageIdByChat: Map<string, string>;
  chatTypeById: Map<string, string>;
  ackReactions: ExactAsyncIndicatorRegistry<{
    messageId: string;
    reactionId: string;
  }>;
  parseFeishuRouteTarget: (raw: string) => FeishuRouteTarget;
  resolveFeishuMessageAnchor: (input: {
    target: FeishuRouteTarget;
    chatType?: string;
    lastMessageId?: string;
  }) => string | undefined;
  requireFeishuRouteTarget: (raw: string) => FeishuRouteTarget;
  assertFeishuApiSuccess: (operation: string, response: unknown) => void;
  feishuApiErrorCode: (error: unknown) => number | undefined;
  requireFeishuUploadKey: (
    operation: string,
    response: unknown,
    key: 'image_key' | 'file_key',
  ) => string;
  getFileType: (
    ext: string,
  ) => 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
  buildInteractiveCard: (text: string) => object;
  buildPostMdFallback: (text: string) => string;
  CARD_TABLE_LIMIT: number;
  FEISHU_THREAD_REPLY_UNSUPPORTED_CODES: Set<number>;
}

export function createFeishuSender(deps: FeishuSenderDeps) {
  const {
    getClient,
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
  } = deps;

  function getSenderName(openId: string): string {
    return senderNameCache.get(openId) || openId;
  }

  async function addReaction(
    messageId: string,
    emojiType: string,
  ): Promise<string | null> {
    const client = getClient();
    try {
      const res = (await client!.im.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: { emoji_type: emojiType },
        },
      })) as { data?: { reaction_id?: string } };
      return res.data?.reaction_id || null;
    } catch (err) {
      logger.debug({ err, messageId, emojiType }, 'Failed to add reaction');
      return null;
    }
  }

  async function removeReactionStrict(
    messageId: string,
    reactionId: string,
  ): Promise<void> {
    const client = getClient();
    await client!.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
  }

  function clearAckForInput(
    rawTarget: string,
    inputMessageId: string,
  ): Promise<void> {
    const target = parseFeishuRouteTarget(rawTarget);
    return ackReactions.clear(
      processingIndicatorKey(target.raw, inputMessageId),
    );
  }

  function p2pLastMessageId(target: FeishuRouteTarget): string | undefined {
    return resolveFeishuMessageAnchor({
      target,
      chatType: chatTypeById.get(target.chatId),
      lastMessageId: lastMessageIdByChat.get(target.chatId),
    });
  }

  async function replyToFeishuMessage(
    messageId: string,
    msgType: string,
    content: string,
    replyInThread: boolean,
  ): Promise<void> {
    const client = getClient();
    if (!client) throw new Error('Feishu client is not initialized');
    const reply = async (threaded: boolean) => {
      const response = await client!.im.message.reply({
        path: { message_id: messageId },
        data: {
          content,
          msg_type: msgType,
          ...(threaded ? { reply_in_thread: true } : {}),
        },
      });
      assertFeishuApiSuccess('Feishu message.reply', response);
    };
    try {
      await reply(replyInThread);
    } catch (error) {
      const code = feishuApiErrorCode(error);
      if (
        !replyInThread ||
        !code ||
        !FEISHU_THREAD_REPLY_UNSUPPORTED_CODES.has(code)
      ) {
        throw error;
      }
      logger.info(
        { messageId, msgType, code },
        'Feishu reply_in_thread unsupported; retrying this message as a plain reply',
      );
      // Retry exactly this physical send step. Uploads and any already-sent
      // sibling attachments remain untouched.
      await reply(false);
    }
  }

  /**
   * Low-level send: explicit roots use reply_in_thread; known P2P chats may
   * reply to their latest inbound message. A bare group target always creates
   * a top-level message and can never inherit the group's most recent topic.
   */
  async function sendToFeishu(
    chatId: string,
    msgType: string,
    content: string,
  ): Promise<void> {
    const client = getClient();
    if (!client) throw new Error('Feishu client is not initialized');
    const target = requireFeishuRouteTarget(chatId);
    const receiveIdType = target.chatId.startsWith('oc_')
      ? 'chat_id'
      : 'open_id';
    const replyMsgId = target.rootMessageId || p2pLastMessageId(target);
    if (replyMsgId) {
      await replyToFeishuMessage(
        replyMsgId,
        msgType,
        content,
        target.replyInThread,
      );
    } else {
      const response = await client.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: target.chatId,
          msg_type: msgType,
          content,
        },
      });
      assertFeishuApiSuccess('Feishu message.create', response);
    }
  }

  async function sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
    options?: { presentation?: 'default' | 'native' },
  ): Promise<void> {
    const client = getClient();
    if (!client) {
      throw new Error('Feishu client is not initialized');
    }

    requireFeishuRouteTarget(chatId);

    try {
      // Proactive-mode workspace Agents speak as ordinary native rich-text
      // messages. They never enter the interactive-card presentation lane.
      if (options?.presentation === 'native') {
        await sendToFeishu(chatId, 'post', buildPostMdFallback(text));
      } else {
        const bareCard = parsePrebuiltInteractiveCardText(text);
        if (bareCard) {
          // Pre-built Feishu interactive card JSON — send the bare card
          // object directly (the {type:'interactive'} wrapper is rejected
          // by message.create with Feishu 200621, see builder.ts).
          await sendToFeishu(chatId, 'interactive', JSON.stringify(bareCard));
          return;
        }

        // Count markdown tables to decide format upfront — Feishu cards have
        // a table limit. Each table has exactly one separator row.
        const tableCount = (text.match(/^\|[\s:-]+\|/gm) || []).length;
        const usePostMd = tableCount > CARD_TABLE_LIMIT;

        if (usePostMd) {
          await sendToFeishu(chatId, 'post', buildPostMdFallback(text));
        } else {
          const card = buildInteractiveCard(text);
          const content = JSON.stringify(card);
          try {
            await sendToFeishu(chatId, 'interactive', content);
          } catch (err) {
            logger.warn(
              { err, chatId },
              'Feishu interactive send failed, fallback to post+md',
            );
            await sendToFeishu(chatId, 'post', buildPostMdFallback(text));
          }
        }
      }
      logger.debug(
        { chatId, presentation: options?.presentation ?? 'default' },
        'Sent Feishu message',
      );

      for (const localImagePath of localImagePaths || []) {
        try {
          const uploadRes = (await client.im.v1.image.create({
            data: {
              image_type: 'message',
              image: fs.createReadStream(localImagePath),
            },
          })) as
            | { image_key?: string; data?: { image_key?: string } }
            | null
            | undefined;
          const imageKey = requireFeishuUploadKey(
            'Feishu image.create',
            uploadRes,
            'image_key',
          );
          await sendToFeishu(
            chatId,
            'image',
            JSON.stringify({ image_key: imageKey }),
          );
        } catch (imageErr) {
          logger.error(
            { chatId, localImagePath, err: imageErr },
            'Failed to send Feishu image attachment',
          );
          throw imageErr;
        }
      }
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send Feishu message');
      throw err;
    }
  }

  async function sendImage(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    _fileName?: string /* Feishu image API has no filename field, intentionally unused */,
  ): Promise<void> {
    const client = getClient();
    if (!client) {
      throw new Error('Feishu client is not initialized');
    }

    requireFeishuRouteTarget(chatId);

    try {
      // Step 1: Upload image to Feishu to get image_key
      const uploadResult = (await client.im.v1.image.create({
        data: {
          image_type: 'message',
          image: imageBuffer,
        },
      })) as
        | { image_key?: string; data?: { image_key?: string } }
        | null
        | undefined;

      const imageKey = requireFeishuUploadKey(
        'Feishu image.create',
        uploadResult,
        'image_key',
      );

      // Step 2: Send image message
      await sendToFeishu(
        chatId,
        'image',
        JSON.stringify({ image_key: imageKey }),
      );

      // Step 3: If caption provided, send it as a follow-up text message
      if (caption) {
        await sendToFeishu(chatId, 'text', JSON.stringify({ text: caption }));
      }
      logger.info(
        { chatId, imageKey, mimeType, size: imageBuffer.length },
        'Feishu image sent',
      );
    } catch (err) {
      logger.error({ err, chatId, mimeType }, 'Failed to send Feishu image');
      throw err;
    }
  }

  async function sendFile(
    chatId: string,
    filePath: string,
    fileName: string,
  ): Promise<void> {
    const client = getClient();
    if (!client) {
      throw new Error('Feishu client is not initialized');
    }

    requireFeishuRouteTarget(chatId);

    try {
      const buffer = await fsPromises.readFile(filePath);

      // Check file size limit (30MB)
      const MAX_FILE_SIZE = 30 * 1024 * 1024;
      if (buffer.length > MAX_FILE_SIZE) {
        throw new Error(
          `文件大小超过 30MB 限制 (${(buffer.length / 1024 / 1024).toFixed(2)}MB)`,
        );
      }

      const ext = path.extname(fileName);
      const fileType = getFileType(ext);

      // Upload file
      const uploadResult = (await client.im.v1.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
          file: buffer,
        },
      })) as
        | { file_key?: string; data?: { file_key?: string } }
        | null
        | undefined;

      const fileKey = requireFeishuUploadKey(
        'Feishu file.create',
        uploadResult,
        'file_key',
      );

      // Determine msg_type: Feishu requires upload file_type and send msg_type to match.
      // mp4 → media (video message), opus → audio (audio message), others → file.
      const msgType =
        fileType === 'mp4' ? 'media' : fileType === 'opus' ? 'audio' : 'file';

      // Send file message
      await sendToFeishu(
        chatId,
        msgType,
        JSON.stringify({ file_key: fileKey }),
      );
      logger.info(
        { chatId, fileName, fileSize: buffer.length },
        'File sent to Feishu',
      );
    } catch (err) {
      logger.error({ err, chatId, filePath }, 'Failed to send file to Feishu');
      throw err;
    }
  }

  return {
    sendMessage,
    sendImage,
    sendFile,
    sendToFeishu,
    getSenderName,
    addReaction,
    removeReactionStrict,
    clearAckForInput,
    p2pLastMessageId,
  };
}
