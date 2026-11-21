/**
 * WeChat iLink Bot API Connection Factory
 *
 * Implements WeChat Bot connection using iLink Bot API protocol:
 * - Long-polling message reception (getupdates)
 * - Message sending with context_token (sendmessage)
 * - Typing indicator (getconfig + sendtyping)
 * - CDN image download + AES decryption
 * - Message deduplication (LRU 1000 / 30min TTL)
 *
 * Base URL: https://ilinkai.weixin.qq.com
 * CDN URL:  https://novac2c.cdn.weixin.qq.com/c2c
 */
import crypto from 'crypto';
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import { storeChatMetadata, storeMessageDirect, updateChatName } from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import {
  saveDownloadedFile,
  buildInlinedFileContent,
  MAX_FILE_SIZE,
} from './im-downloader.js';
import { detectImageMimeType } from './image-detector.js';
import { downloadAndDecryptMedia } from './wechat-crypto.js';
import { markdownToPlainText, createDedupCache } from './im-utils.js';
import { weChatIlinkHeaders } from './wechat-onboarding.js';
import {
  parseChannelPairingCode,
  resolveAdmittedChannelRoute,
} from './channel-admission.js';
import { createWeChatApiClient, DEFAULT_BASE_URL } from './wechat-api.js';
import {
  createWeChatSender,
  DEFAULT_CDN_BASE_URL,
  MESSAGE_ITEM_TYPE_FILE,
  MESSAGE_ITEM_TYPE_IMAGE,
  MESSAGE_ITEM_TYPE_TEXT,
  MESSAGE_TYPE_BOT,
} from './wechat-outbound.js';

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_LONGPOLL_TIMEOUT_MS = 35000;

const RECONNECT_MIN_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS = 60000;
const REPEATED_ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

const IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5 MB for inline base64

// errcode for session expired
const ERRCODE_SESSION_EXPIRED = -14;

// ─── Types ──────────────────────────────────────────────────────

export interface WeChatConnectionConfig {
  botToken: string;
  ilinkBotId: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  getUpdatesBuf?: string;
  /** Bypass CKQClaw's HTTP(S) proxy. System TUN/VPN routing still applies. */
  bypassProxy?: boolean;
  logContext?: {
    accountId?: string;
    userId?: string;
  };
}

type WeChatConnectionErrorCode =
  | 'connect_timeout'
  | 'request_timeout'
  | 'connection_reset'
  | 'tls_error'
  | 'api_error'
  | 'network_error'
  | 'unknown';

export interface WeChatConnectionState {
  status:
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'expired'
    | 'disconnected';
  error?: string;
  errorCode?: WeChatConnectionErrorCode;
  consecutiveFailures?: number;
  nextRetryMs?: number;
  lastConnectedAt?: string;
}

export interface WeChatConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  ignoreMessagesBefore?: number;
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
  /** No inbound message may register or download media before this passes. */
  isChatAuthorized?: (jid: string) => boolean;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  /** Publish authorization/transport loss (notably iLink errcode -14). */
  onConnectionStateChange?: (state: WeChatConnectionState) => void;
  /** Persist a fully processed getUpdates cursor before the next poll. */
  onUpdatesBuf?: (cursor: string) => void | Promise<void>;
}

export interface WeChatConnection {
  connect(opts: WeChatConnectOpts): Promise<void>;
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
  sendTyping(chatId: string, isTyping: boolean): Promise<void>;
  /** The polling worker exists, even if the upstream transport is reconnecting. */
  isRunning(): boolean;
  /** The last getUpdates call completed successfully. */
  isConnected(): boolean;
  getUpdatesBuf(): string;
}

interface WeChatConnectionDeps {
  fetch?: typeof undiciFetch;
  createDispatcher?: (bypassProxy: boolean) => Dispatcher;
  random?: () => number;
  now?: () => number;
}

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

function nonZeroApiCode(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}

/** Reject transport-success responses that encode a WeChat API failure. */
export function assertWeChatApiSuccess(
  response: WeChatApiEnvelope,
  operation: string,
): void {
  const codes: Array<[string, unknown]> = [
    ['ret', response.ret],
    ['errcode', response.errcode],
    ['error_code', response.error_code],
    ['errno', response.errno],
    ['code', response.code],
    ['base_resp.ret', response.base_resp?.ret],
    ['base_resp.errcode', response.base_resp?.errcode],
  ];
  const failure = codes.find(([, value]) => nonZeroApiCode(value));
  if (!failure) return;
  const message =
    response.errmsg ??
    response.error_msg ??
    response.message ??
    response.base_resp?.errmsg ??
    '';
  throw new Error(
    `${operation} failed: ${failure[0]}=${String(failure[1])}${message ? ` message=${String(message)}` : ''}`,
  );
}

export async function parseWeChatApiResponse<T>(
  response: Response,
  endpoint: string,
): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `WeChat API ${endpoint} HTTP ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `WeChat API ${endpoint} invalid JSON: ${text.slice(0, 200)}`,
    );
  }
}

/**
 * Process one long-poll batch before acknowledging its cursor. If processing
 * or persistence fails, the caller keeps the previous cursor so the batch is
 * replayed after retry/restart instead of being acknowledged early.
 */
export async function processWeChatUpdateBatch<T>(input: {
  messages?: T[];
  nextCursor?: string;
  currentCursor: string;
  processMessage: (message: T) => Promise<void>;
  persistCursor?: (cursor: string) => void | Promise<void>;
}): Promise<string> {
  for (const message of input.messages ?? []) {
    await input.processMessage(message);
  }
  if (!input.nextCursor || input.nextCursor === input.currentCursor) {
    return input.currentCursor;
  }
  await input.persistCursor?.(input.nextCursor);
  return input.nextCursor;
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

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

export function classifyWeChatConnectionError(
  error: unknown,
): WeChatConnectionErrorCode {
  const chain = errorChain(error);
  const codes = chain.map((item) => String(item.code ?? '')).filter(Boolean);
  const message = chain
    .map((item) => String(item.message ?? ''))
    .join(' ')
    .toLowerCase();

  if (
    codes.includes('UND_ERR_CONNECT_TIMEOUT') ||
    codes.includes('ETIMEDOUT') ||
    message.includes('connect timeout')
  ) {
    return 'connect_timeout';
  }
  if (
    codes.includes('WECHAT_REQUEST_TIMEOUT') ||
    (message.includes('wechat api') && message.includes('timed out'))
  ) {
    return 'request_timeout';
  }
  if (
    codes.some((code) =>
      ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code),
    ) ||
    message.includes('socket disconnected') ||
    message.includes('connection reset')
  ) {
    return 'connection_reset';
  }
  if (
    codes.some((code) => code.startsWith('ERR_TLS')) ||
    message.includes('tls') ||
    message.includes('certificate')
  ) {
    return 'tls_error';
  }
  if (
    codes.includes('WECHAT_API_ERROR') ||
    message.includes('wechat getupdates error')
  ) {
    return 'api_error';
  }
  if (error instanceof TypeError && message.includes('fetch failed')) {
    return 'network_error';
  }
  return 'unknown';
}

function weChatConnectionErrorMessage(code: WeChatConnectionErrorCode): string {
  switch (code) {
    case 'connect_timeout':
      return '连接微信服务超时，CKQClaw 正在自动重试';
    case 'request_timeout':
      return '微信长轮询暂时无响应，CKQClaw 正在自动重试';
    case 'connection_reset':
      return '微信连接在 TLS 建立前被中断，CKQClaw 正在自动重试';
    case 'tls_error':
      return '微信服务 TLS 连接失败，CKQClaw 正在自动重试';
    case 'api_error':
      return '微信服务返回异常，CKQClaw 正在自动重试';
    case 'network_error':
      return '暂时无法访问微信服务，CKQClaw 正在自动重试';
    default:
      return '微信连接暂时异常，CKQClaw 正在自动重试';
  }
}

export function jitteredWeChatRetryDelay(
  baseDelayMs: number,
  random: () => number = Math.random,
): number {
  // Full synchronization between multiple accounts makes outages noisier.
  // Keep the configured exponential curve while spreading retries by ±20%.
  const factor = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.max(1, Math.round(baseDelayMs * factor));
}

function maskedBotId(ilinkBotId: string): string {
  if (ilinkBotId.length <= 8) return '***';
  return `${ilinkBotId.slice(0, 4)}…${ilinkBotId.slice(-7)}`;
}

// ─── Factory Function ───────────────────────────────────────────

export function createWeChatConnection(
  config: WeChatConnectionConfig,
  deps: WeChatConnectionDeps = {},
): WeChatConnection {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const cdnBaseUrl = config.cdnBaseUrl || DEFAULT_CDN_BASE_URL;
  const bypassProxy = config.bypassProxy !== false;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const logContext = {
    accountId: config.logContext?.accountId,
    userId: config.logContext?.userId,
    botId: maskedBotId(config.ilinkBotId),
  };

  // Polling state
  let currentGetUpdatesBuf = config.getUpdatesBuf || '';
  let longpollTimeoutMs = DEFAULT_LONGPOLL_TIMEOUT_MS;
  let stopping = false;
  let running = false;
  let connected = false;
  let dispatcher: Dispatcher | null = null;
  let pollPromise: Promise<void> | null = null;
  let activePollController: AbortController | null = null;
  let cancelSleep: (() => void) | null = null;
  let activeOpts: WeChatConnectOpts | null = null;
  let consecutiveFailures = 0;
  let consecutivePollTimeouts = 0;
  let failureStartedAt = 0;
  let lastConnectedAt: string | undefined;
  let lastLoggedErrorCode: WeChatConnectionErrorCode | null = null;
  let lastRepeatedErrorLogAt = 0;

  // context_token cache: from_user_id -> latest context_token
  const contextTokenCache = new Map<string, string>();

  // Known JIDs — skip redundant storeChatMetadata/onNewChat for repeat messages
  const knownJids = new Set<string>();

  // Avoid turning an unauthorized sender into a reply-amplification source.
  const rejectTimestamps = new Map<string, number>();
  const REJECT_COOLDOWN_MS = 5 * 60 * 1000;

  // Message deduplication: key -> timestamp
  // LRU deduplication cache（共享 helper）
  const dedup = createDedupCache({ ttlMs: 30 * 60 * 1000, max: 1000 });

  // ─── Deduplication ────────────────────────────────────────

  // ─── HTTP/API Client ────────────────────────────────────────
  // HTTP 客户端与长轮询请求段（ensureDispatcher / publishState / buildHeaders
  // / baseInfo / apiPost / getUpdates，原 509-599）已抽至 ./wechat-api.ts
  // （ISSUE-12 单元 2.17 原文搬运）。publishState 为该段自产，经工厂返回面
  // 同名解构回接；其唯一写点 connectionState 随段内化于 wechat-api，本文件
  // 留守读点（connect 状态重放 / pollLoop 意外退出的 expired 判定）经返回
  // 面 getConnectionState() 活读。dispatcher / activePollController /
  // longpollTimeoutMs / currentGetUpdatesBuf / activeOpts 均有段外消费者
  // （closeDispatcher / disconnect 复位清理行 / pollLoop 游标与超时回写 /
  // connect 门面），本体留守本文件状态区，wechat-api 经 get/set 访问器对
  // 读写（2.14 qq-ws 状态留守同款，复位与清理行因此逐字节不变）。deps
  // 第二参原样透传——wechat-connection-lifecycle 的 fetch/createDispatcher
  // 注入链穿透至 apiPost/ensureDispatcher；random/now 的解析与消费留守
  // W6/W7。仅该段消费的 randomWechatUin 与 wechatUin 生成行、
  // LONGPOLL_EXTRA_TIMEOUT_MS / CHANNEL_VERSION 常数、GetUpdatesResponse
  // 接口随段迁移；DEFAULT_BASE_URL 随段安家 wechat-api 并导出，本文件顶部
  // 回接 import（2.12 QQ_MAX_JSON_RESPONSE_BYTES 同款）。
  // parseWeChatApiResponse 为本文件既有导出（外层门面约束），经同名参数
  // 注入，apiPost 体内调用点逐字节不变（2.12 validateQQGatewayUrl 同款）。
  // 同名解构使 connect / disconnect / pollLoop / markConnectionHealthy /
  // handlePollFailure / downloadCdnMediaItem 调用点零改动（2.18 起
  // sendMessageApi 的 processMessage 消费面与门面 sendImage / sendFile /
  // sendTyping 委托体改经 wechat-outbound 接线，getTypingTicket /
  // sendTypingApi 随段内化，见下方 Outbound Sender 接线）。
  const {
    ensureDispatcher,
    publishState,
    baseInfo,
    apiPost,
    getUpdates,
    getConnectionState,
  } = createWeChatApiClient(config, deps, {
    parseWeChatApiResponse,
    getActiveOpts: () => activeOpts,
    getDispatcher: () => dispatcher,
    setDispatcher: (value) => {
      dispatcher = value;
    },
    getActivePollController: () => activePollController,
    setActivePollController: (value) => {
      activePollController = value;
    },
    getLongpollTimeoutMs: () => longpollTimeoutMs,
    getCurrentGetUpdatesBuf: () => currentGetUpdatesBuf,
  });

  // ─── Outbound Sender ───────────────────────────────────────
  // 发送 API 段（sendMessageApi / getTypingTicket / sendTypingApi，原
  // 527-593）与门面 sendMessage / sendImage / sendFile / sendTyping 方法本体
  // （原 1254-1472）已抽至 ./wechat-outbound.ts（ISSUE-12 单元 2.18 原文
  // 搬运）：方法壳与签名留本文件、体一行委托（2.16 qq-stream
  // sendStreamMessage 同款）；getTypingTicket / sendTypingApi 仅 sendTyping
  // 本体消费，随段内化不进返回面。contextTokenCache 经 contextTokens 参数
  // 同 Map 实例引用注入——processMessage 的 set 写点与 connect/disconnect
  // 的 clear 清理行留守本文件，同一实例读写语义不变（搬运体内
  // contextTokenCache.get 机械更名 contextTokens.get 共 4 处，其余逐字节）。
  // api 为 2.17 createWeChatApiClient 返回面的结构子集，按实际消费列
  // apiPost / baseInfo / ensureDispatcher（getConnectionState 发送链不
  // 消费）；config 为 WeChatConnectionConfig 结构子集，baseUrl / cdnBaseUrl
  // 派生表达式随迁方内逐字节一致。assertWeChatApiSuccess 为本文件既有导出
  //（外层门面约束），经同名参数注入（2.17 parseWeChatApiResponse 同款）。
  // uploadMediaBuffer 直属既有模块 wechat-crypto（W4 消费同模块的
  // downloadAndDecryptMedia，非 W4 素材），wechat-outbound 直接 import；
  // MAX_FILE_SIZE（W4 download 亦消费）与 markdownToPlainText
  //（processMessage 亦消费）仍各自直引共享模块。常数归属：
  // MSG_SPLIT_LIMIT / MESSAGE_STATE_FINISH 仅发送链消费随段迁移；
  // MESSAGE_TYPE_BOT / MESSAGE_ITEM_TYPE_TEXT / IMAGE / FILE 为 W5
  // extractTextContent / processMessage 共享，随段安家 wechat-outbound 并
  // 导出、本文件顶部回接 import；DEFAULT_CDN_BASE_URL 同款回接（2.17
  // DEFAULT_BASE_URL 先例）。同名解构使 processMessage 五处 sendMessageApi
  // 调用点与门面四委托行零改动。
  const { sendMessageApi, sendMessage, sendImage, sendFile, sendTyping } =
    createWeChatSender(
      { apiPost, baseInfo, ensureDispatcher },
      contextTokenCache,
      config,
      assertWeChatApiSuccess,
    );

  // ─── CDN Media Download ────────────────────────────────────

  /**
   * Download, decrypt, and save a CDN media item (image, file, etc.).
   * `resolveFileName` receives the decrypted buffer so callers can inspect
   * content (e.g. MIME-detect for images) before choosing a name.
   */
  async function downloadCdnMediaItem(
    media: CDNMedia | undefined,
    groupFolder: string | undefined,
    label: string,
    resolveFileName: (buffer: Buffer) => string,
  ): Promise<{ buffer: Buffer; savedPath?: string } | null> {
    if (!media?.encrypt_query_param || !media?.aes_key) {
      logger.debug(`WeChat ${label} missing media or aes_key, skipping`);
      return null;
    }

    const buffer = await downloadAndDecryptMedia(
      media.encrypt_query_param,
      media.aes_key,
      cdnBaseUrl,
      ensureDispatcher(),
    );

    if (!buffer || buffer.length === 0) {
      logger.warn(`WeChat ${label} download returned empty buffer`);
      return null;
    }

    if (buffer.length > MAX_FILE_SIZE) {
      logger.warn(
        { size: buffer.length },
        `WeChat ${label} exceeds max file size, skipping`,
      );
      return null;
    }

    let savedPath: string | undefined;
    if (groupFolder) {
      try {
        const fileName = resolveFileName(buffer);
        savedPath =
          (await saveDownloadedFile(groupFolder, 'wechat', fileName, buffer)) ??
          undefined;
      } catch (err) {
        logger.warn({ err }, `Failed to save WeChat ${label} to disk`);
      }
    }

    return { buffer, savedPath };
  }

  async function processImageItem(
    item: MessageItem,
    msgIdentifier: string,
    groupFolder: string | undefined,
  ): Promise<{
    attachmentEntry?: { type: string; data: string; mimeType: string };
    textPrefix?: string;
  }> {
    try {
      const result = await downloadCdnMediaItem(
        item.image_item?.media,
        groupFolder,
        'image',
        (buffer) => {
          const mimeType = detectImageMimeType(buffer);
          const extMap: Record<string, string> = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp',
          };
          return `wechat_img_${msgIdentifier}${extMap[mimeType] ?? '.jpg'}`;
        },
      );
      if (!result) return {};

      const textPrefix = result.savedPath
        ? `[图片: ${result.savedPath}]`
        : undefined;

      let attachmentEntry:
        | { type: string; data: string; mimeType: string }
        | undefined;
      if (result.buffer.length <= IMAGE_MAX_BASE64_SIZE) {
        const mimeType = detectImageMimeType(result.buffer);
        attachmentEntry = {
          type: 'image',
          data: result.buffer.toString('base64'),
          mimeType,
        };
      }

      return { attachmentEntry, textPrefix };
    } catch (err) {
      logger.warn({ err }, 'WeChat image download/decrypt failed, skipping');
      return {};
    }
  }

  async function processFileItem(
    item: MessageItem,
    groupFolder: string | undefined,
  ): Promise<string | null> {
    const fileName = item.file_item?.file_name || 'unknown_file';
    try {
      const result = await downloadCdnMediaItem(
        item.file_item?.media,
        groupFolder,
        'file',
        () => fileName,
      );
      if (result?.savedPath) {
        // 弱模型兜底：抽取成功则内联文件文本，失败回退仅路径标记。
        const inlined = groupFolder
          ? await buildInlinedFileContent(groupFolder, result.savedPath)
          : null;
        return inlined ?? `[文件: ${result.savedPath}]`;
      }
      // CDN media unavailable, fall back to name-only label
      return `[文件: ${fileName}]`;
    } catch (err) {
      logger.warn({ err, fileName }, 'WeChat file download/decrypt failed');
      return `[文件: ${fileName}]`;
    }
  }

  // ─── Message Processing ───────────────────────────────────

  async function processMessage(
    msg: WeixinMessage,
    opts: WeChatConnectOpts,
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

  // ─── Long-Polling Loop ────────────────────────────────────

  function markConnectionHealthy(): void {
    const recoveredFailures = consecutiveFailures;
    const downtimeMs = failureStartedAt
      ? Math.max(0, now() - failureStartedAt)
      : 0;
    const wasConnected = connected;
    connected = true;
    consecutiveFailures = 0;
    consecutivePollTimeouts = 0;
    failureStartedAt = 0;
    lastLoggedErrorCode = null;
    lastRepeatedErrorLogAt = 0;
    if (wasConnected) return;
    lastConnectedAt = new Date(now()).toISOString();
    publishState({ status: 'connected', lastConnectedAt });
    if (!wasConnected && recoveredFailures === 0) {
      logger.info(logContext, 'WeChat poll connection established');
    } else if (!wasConnected && recoveredFailures > 0) {
      logger.info(
        { ...logContext, recoveredFailures, downtimeMs },
        'WeChat poll connection recovered',
      );
    }
  }

  async function handlePollFailure(
    err: unknown,
    baseDelayMs: number,
  ): Promise<void> {
    connected = false;
    consecutiveFailures += 1;
    if (!failureStartedAt) failureStartedAt = now();
    const errorCode = classifyWeChatConnectionError(err);
    const nextRetryMs = jitteredWeChatRetryDelay(baseDelayMs, random);
    const userMessage = weChatConnectionErrorMessage(errorCode);
    publishState({
      status: 'reconnecting',
      error: userMessage,
      errorCode,
      consecutiveFailures,
      nextRetryMs,
      lastConnectedAt,
    });

    const currentTime = now();
    const shouldLogDetails =
      consecutiveFailures === 1 ||
      errorCode !== lastLoggedErrorCode ||
      currentTime - lastRepeatedErrorLogAt >= REPEATED_ERROR_LOG_INTERVAL_MS;
    if (shouldLogDetails) {
      logger.warn(
        {
          ...logContext,
          err,
          errorCode,
          consecutiveFailures,
          nextRetryMs,
        },
        'WeChat poll connection unavailable; retry scheduled',
      );
      lastLoggedErrorCode = errorCode;
      lastRepeatedErrorLogAt = currentTime;
    } else {
      logger.debug(
        { ...logContext, errorCode, consecutiveFailures, nextRetryMs },
        'WeChat poll retry scheduled',
      );
    }
    await sleep(nextRetryMs);
  }

  async function pollLoop(): Promise<void> {
    let reconnectDelay = RECONNECT_MIN_DELAY_MS;

    while (!stopping) {
      try {
        const response = await getUpdates();
        if (stopping) break;

        // Update longpoll timeout from server
        if (response.longpolling_timeout_ms) {
          longpollTimeoutMs = response.longpolling_timeout_ms;
        }

        const responseCode = response.ret ?? response.errcode;

        // Check for session expiry
        if (responseCode === ERRCODE_SESSION_EXPIRED) {
          const error = '微信授权已过期，请重新扫码连接';
          logger.warn(
            { ...logContext, errorCode: 'session_expired' },
            'WeChat session expired; polling stopped',
          );
          connected = false;
          publishState({ status: 'expired', error });
          break;
        }

        // ret/errcode are absent when the request succeeds — treat as 0.
        if (responseCode !== undefined && responseCode !== 0) {
          throw Object.assign(
            new Error(
              `WeChat getUpdates error: code=${responseCode}, message=${response.errmsg ?? ''}`,
            ),
            { code: 'WECHAT_API_ERROR' },
          );
        }

        // Reset backoff on success
        markConnectionHealthy();
        reconnectDelay = RECONNECT_MIN_DELAY_MS;

        const opts = activeOpts;
        if (!opts || stopping) break;

        // Cursor acknowledgement is deliberately last. A crash or processing
        // failure replays the whole batch from the previous durable cursor.
        currentGetUpdatesBuf = await processWeChatUpdateBatch({
          messages: response.msgs,
          nextCursor: response.get_updates_buf,
          currentCursor: currentGetUpdatesBuf,
          processMessage: (msg) => processMessage(msg, opts),
          persistCursor: opts.onUpdatesBuf,
        });
      } catch (err) {
        if (stopping) break;

        // Once healthy, a client-side long-poll timeout only means the server
        // kept the request open longer than advertised. It is not an outage.
        const errorCode = classifyWeChatConnectionError(err);
        if (connected && errorCode === 'request_timeout') {
          consecutivePollTimeouts += 1;
        }
        if (
          connected &&
          errorCode === 'request_timeout' &&
          consecutivePollTimeouts === 1
        ) {
          logger.debug(
            { ...logContext, errorCode },
            'WeChat long poll reached client timeout; retrying',
          );
          continue;
        }

        await handlePollFailure(err, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
      }
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        if (cancelSleep === cancel) cancelSleep = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      const cancel = () => {
        clearTimeout(timer);
        finish();
      };
      cancelSleep = cancel;
    });
  }

  async function closeDispatcher(): Promise<void> {
    const activeDispatcher = dispatcher;
    dispatcher = null;
    if (!activeDispatcher) return;
    await activeDispatcher.close().catch((err) => {
      logger.debug(
        { ...logContext, err },
        'Failed to close WeChat HTTP dispatcher cleanly',
      );
    });
  }

  // ─── Connection Interface ─────────────────────────────────

  const connection: WeChatConnection = {
    async connect(opts: WeChatConnectOpts): Promise<void> {
      if (!config.botToken || !config.ilinkBotId) {
        logger.info(
          logContext,
          'WeChat botToken/ilinkBotId not configured, skipping',
        );
        return;
      }

      if (running && pollPromise) {
        logger.debug(
          logContext,
          'WeChat connect ignored: poller already running',
        );
        opts.onReady?.();
        opts.onConnectionStateChange?.(getConnectionState());
        return;
      }

      activeOpts = opts;

      try {
        ensureDispatcher();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        publishState({ status: 'disconnected', error });
        activeOpts = null;
        throw err;
      }

      stopping = false;
      running = true;
      connected = false;
      consecutiveFailures = 0;
      consecutivePollTimeouts = 0;
      failureStartedAt = 0;
      dedup.clear();
      contextTokenCache.clear();
      knownJids.clear();

      logger.info(
        { ...logContext, baseUrl, bypassProxy },
        'WeChat iLink poller starting',
      );

      publishState({ status: 'connecting' });
      // onReady means the local poller is running. Upstream health is
      // published separately after the first successful getUpdates response.
      opts.onReady?.();

      // Start poll loop in background (non-blocking)
      pollPromise = pollLoop()
        .catch((err) => {
          connected = false;
          if (!stopping && getConnectionState().status !== 'expired') {
            const error = '微信轮询意外退出，请重新连接';
            publishState({ status: 'disconnected', error, lastConnectedAt });
            logger.error(
              { ...logContext, err },
              'WeChat poll loop exited unexpectedly',
            );
          }
        })
        .finally(async () => {
          running = false;
          if (!stopping) await closeDispatcher();
          pollPromise = null;
        });
    },

    async disconnect(): Promise<void> {
      stopping = true;
      connected = false;
      activePollController?.abort();
      activePollController = null;

      // Abort any pending sleep
      cancelSleep?.();
      cancelSleep = null;

      const pendingPoll = pollPromise;
      if (pendingPoll) await pendingPoll;
      running = false;
      publishState({ status: 'disconnected', lastConnectedAt });
      activeOpts = null;

      await closeDispatcher();

      dedup.clear();
      contextTokenCache.clear();
      knownJids.clear();
      rejectTimestamps.clear();
      logger.info(logContext, 'WeChat iLink poller disconnected');
    },

    async sendMessage(
      chatId: string,
      text: string,
      _localImagePaths?: string[],
    ): Promise<void> {
      return sendMessage(chatId, text);
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      return sendImage(chatId, imageBuffer, mimeType, caption, fileName);
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      return sendFile(chatId, filePath, fileName);
    },

    async sendTyping(chatId: string, isTyping: boolean): Promise<void> {
      return sendTyping(chatId, isTyping);
    },

    isRunning(): boolean {
      return running && !stopping;
    },

    isConnected(): boolean {
      return running && connected && !stopping;
    },

    getUpdatesBuf(): string {
      return currentGetUpdatesBuf;
    },
  };

  return connection;
}
