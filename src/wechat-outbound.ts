/**
 * WeChat iLink 出站发送链（原 src/wechat.ts createWeChatConnection 工厂内
 * “API Methods”段 sendMessageApi / getTypingTicket / sendTypingApi（原
 * 527-593）与 Connection 门面 sendMessage / sendImage / sendFile /
 * sendTyping 方法本体（原 1254-1472），ISSUE-12 单元 2.18 原文搬运）。门面
 * 方法壳与签名留 src/wechat.ts，体一行委托（2.16 qq-stream sendStreamMessage
 * 同款）；getTypingTicket / sendTypingApi 仅 sendTyping 本体消费，随段内化
 * 不进返回面。
 *
 * 职责：
 *   - sendMessageApi：文本 sendmessage（client_id 随机 + strict ack）；
 *   - getTypingTicket / sendTypingApi：getconfig + sendtyping（失败仅
 *     debug 日志静默降级，语义逐字保留）；
 *   - sendMessage / sendImage / sendFile / sendTyping：门面方法本体
 *     （context_token 查缓存、caption 先行分片、uploadMediaBuffer CDN 上传、
 *     MAX_FILE_SIZE 上限、失败原样上抛——strict ack 语义不得改成静默降级）。
 *
 * 常数归属（按消费归属随迁 / 共享回接）：
 *   - 仅发送链消费随段迁移：MSG_SPLIT_LIMIT / MESSAGE_STATE_FINISH，及
 *     注释态协议备选值（USER / VOICE / VIDEO / NEW / GENERATING）随簇迁移；
 *   - W5 共享（extractTextContent / processMessage 继续消费）随段安家本模块
 *     并导出、wechat.ts 回接 import：MESSAGE_TYPE_BOT / MESSAGE_ITEM_TYPE_
 *     TEXT / IMAGE / FILE；DEFAULT_CDN_BASE_URL 为 cdnBaseUrl 派生共享，同款
 *     回接（2.17 DEFAULT_BASE_URL 先例）。
 *
 * 依赖注入（闭包依赖显式参数化，feishu-outbound / 2.17 同款）：
 *   - api：2.17 createWeChatApiClient 返回面的结构子集——仅收发送链实际消费
 *     的 apiPost / baseInfo / ensureDispatcher（getConnectionState 等其余
 *     成员发送链不消费，按实际消费列），完整返回面经结构化类型自然满足；
 *   - contextTokens：contextTokenCache 的同 Map 实例引用注入（set 写点在
 *     wechat.ts processMessage、clear 清理行在 connect / disconnect，同一
 *     实例读写语义不变；搬运体内 contextTokenCache.get 机械更名
 *     contextTokens.get 共 4 处，其余逐字节）；
 *   - config：WeChatConnectionConfig 的结构子集（botToken / baseUrl? /
 *     cdnBaseUrl?），baseUrl / cdnBaseUrl 派生表达式与 wechat.ts 原行逐字节
 *     一致；
 *   - assertWeChatApiSuccess：src/wechat.ts 的既有导出（外层门面约束
 *     “既有导出不动”），留在原文件；本模块不回环 import 原文件（feishu/qq
 *     系列零 child→parent 回环先例），故经同名参数注入（2.17
 *     parseWeChatApiResponse 同款），搬运体内调用点逐字节不变；
 *     WeChatApiEnvelope 为其参数类型的逐字节结构镜像。
 *
 * uploadMediaBuffer 直属于既有模块 src/wechat-crypto.ts（非 wechat.ts W4
 * 素材——W4 消费同模块的 downloadAndDecryptMedia），本模块直接 import，不经
 * 注入、不等 2.19；MAX_FILE_SIZE（W4 downloadAndDecryptMedia 亦消费）与
 * markdownToPlainText / splitTextChunks（im-utils，markdownToPlainText 为
 * processMessage 亦消费）各自直引共享模块。
 */
import crypto from 'crypto';
import fs from 'fs';
import { type Dispatcher } from 'undici';
import { ChannelPreSendRejection } from './channel-errors.js';
import { logger } from './logger.js';
import { MAX_FILE_SIZE } from './im-downloader.js';
import { uploadMediaBuffer } from './wechat-crypto.js';
import { markdownToPlainText, splitTextChunks } from './im-utils.js';
import { DEFAULT_BASE_URL } from './wechat-api.js';

// ─── Constants ──────────────────────────────────────────────────

// 原 wechat.ts:42（cdnBaseUrl 派生共享：本模块 uploadMediaBuffer 与留守的
// W4 downloadAndDecryptMedia 都消费，单一定义随发送链安家并导出回接）。
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

// 原 wechat.ts:44（仅发送链消费，随段迁移）。
const MSG_SPLIT_LIMIT = 2000; // WeChat has stricter text limits than other channels

// 以下三簇为原 wechat.ts:54-70 的 iLink 协议常数，随段迁移；注释态备选值
// 随簇保留，活跃常数中 W5 共享的四名导出供 wechat.ts 回接。
// iLink message types
// const MESSAGE_TYPE_USER = 1;
export const MESSAGE_TYPE_BOT = 2;

// iLink message item types
export const MESSAGE_ITEM_TYPE_TEXT = 1;
export const MESSAGE_ITEM_TYPE_IMAGE = 2;
// const MESSAGE_ITEM_TYPE_VOICE = 3;
export const MESSAGE_ITEM_TYPE_FILE = 4;
// const MESSAGE_ITEM_TYPE_VIDEO = 5;

// iLink message state
// const MESSAGE_STATE_NEW = 0;
// const MESSAGE_STATE_GENERATING = 1;
const MESSAGE_STATE_FINISH = 2;

// ─── Types ──────────────────────────────────────────────────────

// src/wechat.ts 的 WeChatApiEnvelope（未导出）的逐字节结构镜像——
// assertWeChatApiSuccess 注入参数的类型载体，两侧经结构化类型双向互通。
type WeChatApiEnvelope = {
  ret?: unknown;
  errcode?: unknown;
  error_code?: unknown;
  errno?: unknown;
  code?: unknown;
  errmsg?: unknown;
  error_msg?: unknown;
  message?: unknown;
  base_resp?: { ret?: unknown; errcode?: unknown; errmsg?: unknown };
};

// 2.17 src/wechat-api.ts 的 createWeChatApiClient 返回面的结构子集——仅收
// 发送链实际消费的 apiPost / baseInfo / ensureDispatcher；完整返回面经结构化
// 类型自然满足。
export interface WeChatSenderApi {
  apiPost: <T = any>(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
    trackAsPollRequest?: boolean,
  ) => Promise<T>;
  baseInfo: () => Record<string, string>;
  ensureDispatcher: () => Dispatcher;
}

// src/wechat.ts 的 WeChatConnectionConfig 的结构子集——仅收发送链实际消费
// 的 botToken / baseUrl? / cdnBaseUrl?；完整配置经结构化类型自然满足。
interface WeChatSenderConfig {
  botToken: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
}

// ─── Factory ─────────────────────────────────────────────────────

export function createWeChatSender(
  api: WeChatSenderApi,
  contextTokens: Map<string, string>,
  config: WeChatSenderConfig,
  assertWeChatApiSuccess: (
    response: WeChatApiEnvelope,
    operation: string,
  ) => void,
) {
  const { apiPost, baseInfo, ensureDispatcher } = api;

  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const cdnBaseUrl = config.cdnBaseUrl || DEFAULT_CDN_BASE_URL;

  // ─── API Methods ──────────────────────────────────────────

  async function sendMessageApi(
    toUserId: string,
    contextToken: string,
    text: string,
  ): Promise<void> {
    const clientId = String(crypto.randomBytes(4).readUInt32BE(0));

    const resp = await apiPost<{
      ret?: number;
      errcode?: number;
      errmsg?: string;
    }>('ilink/bot/sendmessage', {
      msg: {
        to_user_id: toUserId,
        context_token: contextToken,
        item_list: [
          {
            type: MESSAGE_ITEM_TYPE_TEXT,
            text_item: { text },
          },
        ],
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        client_id: clientId,
      },
      base_info: baseInfo(),
    });

    assertWeChatApiSuccess(resp, 'sendMessage');
  }

  async function getTypingTicket(
    ilinkUserId: string,
    contextToken: string,
  ): Promise<string | null> {
    try {
      const res = await apiPost<{ typing_ticket?: string }>(
        'ilink/bot/getconfig',
        {
          ilink_user_id: ilinkUserId,
          context_token: contextToken,
          base_info: baseInfo(),
        },
      );
      return res.typing_ticket || null;
    } catch (err) {
      logger.debug({ err }, 'WeChat getconfig failed');
      return null;
    }
  }

  async function sendTypingApi(
    ilinkUserId: string,
    typingTicket: string,
    status: 1 | 2,
  ): Promise<void> {
    try {
      await apiPost('ilink/bot/sendtyping', {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
        base_info: baseInfo(),
      });
    } catch (err) {
      logger.debug({ err, status }, 'WeChat sendtyping failed');
    }
  }

  // ─── Sender Methods ───────────────────────────────────────

  async function sendMessage(chatId: string, text: string): Promise<void> {
    // chatId is the raw WeChat user ID (prefix already stripped by IM manager)
    const userId = chatId;

    const contextToken = contextTokens.get(userId);
    if (!contextToken) {
      logger.warn(
        { chatId },
        'No context_token available for WeChat user, cannot send message',
      );
      throw new ChannelPreSendRejection(
        `No context_token available for WeChat chat ${chatId}`,
      );
    }

    try {
      const plainText = markdownToPlainText(text);
      const chunks = splitTextChunks(plainText, MSG_SPLIT_LIMIT);

      for (const chunk of chunks) {
        await sendMessageApi(userId, contextToken, chunk);
      }

      logger.info({ chatId }, 'WeChat message sent');
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send WeChat message');
      throw err;
    }
  }

  async function sendImage(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void> {
    const userId = chatId;

    const contextToken = contextTokens.get(userId);
    if (!contextToken) {
      logger.warn(
        { chatId },
        'No context_token for WeChat user, cannot send image',
      );
      throw new ChannelPreSendRejection(
        `No context_token available for WeChat chat ${chatId}`,
      );
    }

    if (imageBuffer.length > MAX_FILE_SIZE) {
      throw new ChannelPreSendRejection(
        `WeChat image size ${imageBuffer.length} exceeds max ${MAX_FILE_SIZE}`,
      );
    }

    const extMap: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
    };
    const ext = extMap[mimeType] ?? '.jpg';
    const resolvedFileName = fileName ?? `image_${Date.now()}${ext}`;

    try {
      // Optional caption is sent first as a separate text message — WeChat's
      // sendmessage API does not accept mixed text+image item_list payloads.
      if (caption) {
        const plain = markdownToPlainText(caption);
        for (const chunk of splitTextChunks(plain, MSG_SPLIT_LIMIT)) {
          await sendMessageApi(userId, contextToken, chunk);
        }
      }

      // Upload to WeChat CDN (getuploadurl → AES-128-ECB encrypt → PUT ciphertext).
      const upload = await uploadMediaBuffer({
        buf: imageBuffer,
        fileName: resolvedFileName,
        toUserId: userId,
        baseUrl,
        token: config.botToken,
        cdnBaseUrl,
        mediaType: 1, // MEDIA_IMAGE
        dispatcher: ensureDispatcher(),
      });

      const clientId = String(crypto.randomBytes(4).readUInt32BE(0));
      const resp = await apiPost<{
        ret?: number;
        errcode?: number;
        errmsg?: string;
      }>('ilink/bot/sendmessage', {
        msg: {
          to_user_id: userId,
          context_token: contextToken,
          item_list: [
            {
              type: MESSAGE_ITEM_TYPE_IMAGE,
              image_item: {
                media: {
                  encrypt_query_param: upload.downloadEncryptedQueryParam,
                  aes_key: upload.aeskey,
                  encrypt_type: 1,
                },
                mid_size: upload.fileSizeCiphertext,
              },
            },
          ],
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          client_id: clientId,
        },
        base_info: baseInfo(),
      });

      assertWeChatApiSuccess(resp, 'sendImage');

      logger.info(
        { chatId, size: imageBuffer.length, fileName: resolvedFileName },
        'WeChat image sent',
      );
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send WeChat image');
      throw err;
    }
  }

  async function sendFile(
    chatId: string,
    filePath: string,
    fileName: string,
  ): Promise<void> {
    const userId = chatId;

    const contextToken = contextTokens.get(userId);
    if (!contextToken) {
      logger.warn(
        { chatId },
        'No context_token for WeChat user, cannot send file',
      );
      throw new ChannelPreSendRejection(
        `No context_token available for WeChat chat ${chatId}`,
      );
    }

    // Single readFile + size check, then pass buffer to uploadMediaBuffer —
    // avoids stat + readFile double-I/O that uploadMediaFile would incur.
    const buf = await fs.promises.readFile(filePath);
    if (buf.length > MAX_FILE_SIZE) {
      throw new ChannelPreSendRejection(
        `WeChat file size ${buf.length} exceeds max ${MAX_FILE_SIZE}`,
      );
    }

    try {
      // Upload raw bytes to WeChat CDN as FILE attachment (mediaType=3).
      const upload = await uploadMediaBuffer({
        buf,
        fileName,
        toUserId: userId,
        baseUrl,
        token: config.botToken,
        cdnBaseUrl,
        mediaType: 3, // MEDIA_FILE
        dispatcher: ensureDispatcher(),
      });

      const clientId = String(crypto.randomBytes(4).readUInt32BE(0));
      const resp = await apiPost<{
        ret?: number;
        errcode?: number;
        errmsg?: string;
      }>('ilink/bot/sendmessage', {
        msg: {
          to_user_id: userId,
          context_token: contextToken,
          item_list: [
            {
              type: MESSAGE_ITEM_TYPE_FILE,
              file_item: {
                media: {
                  encrypt_query_param: upload.downloadEncryptedQueryParam,
                  aes_key: upload.aeskey,
                  encrypt_type: 1,
                },
                file_name: fileName,
                // 'len' is the raw (plaintext) file size as a string — per
                // nightsailer/wechat-clawbot reference.
                len: String(upload.fileSize),
              },
            },
          ],
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          client_id: clientId,
        },
        base_info: baseInfo(),
      });

      assertWeChatApiSuccess(resp, 'sendFile');

      logger.info({ chatId, size: buf.length, fileName }, 'WeChat file sent');
    } catch (err) {
      logger.error({ err, chatId, fileName }, 'Failed to send WeChat file');
      throw err;
    }
  }

  async function sendTyping(chatId: string, isTyping: boolean): Promise<void> {
    // chatId is the raw WeChat user ID (prefix already stripped by IM manager)
    const userId = chatId;

    const contextToken = contextTokens.get(userId);
    if (!contextToken) return;

    const ticket = await getTypingTicket(userId, contextToken);
    if (!ticket) return;

    await sendTypingApi(userId, ticket, isTyping ? 1 : 2);
  }

  return {
    sendMessageApi,
    sendMessage,
    sendImage,
    sendFile,
    sendTyping,
  };
}
