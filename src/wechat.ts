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
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import { logger } from './logger.js';
import { createDedupCache } from './im-utils.js';
import { weChatIlinkHeaders } from './wechat-onboarding.js';
import { createWeChatApiClient, DEFAULT_BASE_URL } from './wechat-api.js';
import { createWeChatSender } from './wechat-outbound.js';
import { createWeChatMedia } from './wechat-media.js';
import { createWeChatInboundProcessor } from './wechat-inbound.js';
import { createWeChatPoller } from './wechat-poller.js';

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_LONGPOLL_TIMEOUT_MS = 35000;

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
  const bypassProxy = config.bypassProxy !== false;
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
  // 注入链穿透至 apiPost/ensureDispatcher；random/now 的解析与消费 2.21
  // 起随轮询簇迁往 wechat-poller（经下方 Long-Polling Poller 接线透传，
  // 注入链收尾）。仅该段消费的 randomWechatUin 与 wechatUin 生成行、
  // LONGPOLL_EXTRA_TIMEOUT_MS / CHANNEL_VERSION 常数、GetUpdatesResponse
  // 接口随段迁移；DEFAULT_BASE_URL 随段安家 wechat-api 并导出，本文件顶部
  // 回接 import（2.12 QQ_MAX_JSON_RESPONSE_BYTES 同款）。
  // parseWeChatApiResponse 为本文件既有导出（外层门面约束），经同名参数
  // 注入，apiPost 体内调用点逐字节不变（2.12 validateQQGatewayUrl 同款）。
  // 同名解构使 connect / disconnect 调用点零改动（pollLoop /
  // markConnectionHealthy / handlePollFailure 2.21 起随轮询簇迁往
  // wechat-poller，publishState / getUpdates 经下方 Long-Polling Poller
  // 接线透传；downloadCdnMediaItem 链 2.19 起随媒体段迁往 wechat-media，
  // ensureDispatcher 经下方 CDN Media 接线透传；2.18 起 sendMessageApi 的
  // processMessage 消费面与门面 sendImage / sendFile / sendTyping 委托体
  // 改经 wechat-outbound 接线，getTypingTicket / sendTypingApi 随段内化，
  // 见下方 Outbound Sender 接线）。
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
  // markdownToPlainText（processMessage 亦消费）仍直引共享模块；曾因
  // W4 亦消费而留守的 im-downloader 三名 import 已于 2.19 随媒体段迁往
  // ./wechat-media.ts（见下方 CDN Media 接线）。常数归属：
  // MSG_SPLIT_LIMIT / MESSAGE_STATE_FINISH 仅发送链消费随段迁移；
  // MESSAGE_TYPE_BOT / MESSAGE_ITEM_TYPE_TEXT / IMAGE / FILE 为 W5
  // extractTextContent / processMessage 共享，随段安家 wechat-outbound 并
  // 导出、本文件顶部回接 import；DEFAULT_CDN_BASE_URL 同款回接（2.17
  // DEFAULT_BASE_URL 先例）。同名解构使门面四委托行零改动（processMessage
  // 五处 sendMessageApi 调用点 2.20 起随入站段迁往 wechat-inbound、经
  // 下方 Inbound 接线同名透传）。
  const { sendMessageApi, sendMessage, sendImage, sendFile, sendTyping } =
    createWeChatSender(
      { apiPost, baseInfo, ensureDispatcher },
      contextTokenCache,
      config,
      assertWeChatApiSuccess,
    );

  // ─── CDN Media ─────────────────────────────────────────────
  // CDN 媒体段（downloadCdnMediaItem / processImageItem / processFileItem，
  // 原 543-670）已抽至 ./wechat-media.ts（ISSUE-12 单元 2.19 原文搬运，三
  // 函数体逐字节零替换——原段与迁入方同为工厂体内 2 空格基位，连 dedent
  // 都不需要）。downloadCdnMediaItem 仅两 process*Item 消费，随段内化不进
  // 返回面；processImageItem / processFileItem 同名解构回接（W5
  // processMessage 两调用点 2.20 起随入站段迁往 wechat-inbound、经下方
  // Inbound 接线同名透传）。api 为 2.17 createWeChatApiClient 返回
  // 面结构子集，按实际消费列 ensureDispatcher（qq-stream { apiRequest }
  // 单员子集同款）；config 为 WeChatConnectionConfig 结构子集，cdnBaseUrl
  // 派生行随段迁往 wechat-media（DEFAULT_CDN_BASE_URL 改经 sibling import
  // 引自 wechat-outbound，本文件该派生行与该名 import 随本单元删除）。
  // IMAGE_MAX_BASE64_SIZE 与 im-downloader 三名 / detectImageMimeType /
  // downloadAndDecryptMedia 五个 import 仅本段消费，整体随迁；
  // wechat-crypto 的 buildCdnDownloadUrl 为其模块内私有，W4 无本地包装，
  // URL 构建在 downloadAndDecryptMedia 体内，如实直引。MessageItem /
  // CDNMedia 为 W5 共享类型，wechat-media 侧逐字节结构镜像（2.17
  // wechat-api 同款）。im-inbound-file-inline 的微信条目等强改锚
  // src/wechat-media.ts（断言文本逐字不变，2.9/2.13 体例）。
  const { processImageItem, processFileItem } = createWeChatMedia(
    { ensureDispatcher },
    config,
  );

  // ─── Inbound Processor ─────────────────────────────────────
  // 入站管线 processMessage（原 558-808，约 250 行：bot 自身跳过 + dedup +
  // 时效过滤、/pair 共享解析、未授权拒绝冷却 + resolveAdmittedChannelRoute
  // 准入、斜杠指令、媒体循环、store / broadcast / notify / onAgentMessage）
  // 及其专属模块级素材——extractTextContent / dedupKey 助手、WeixinMessage
  // / MessageItem / CDNMedia 类型声明（消费面全数随迁，wechat-api /
  // wechat-media 的既有结构镜像继续互通）、db 三写函数 /
  // notifyNewImMessage / broadcastNewMessage / markdownToPlainText /
  // channel-admission 两解析 / crypto(randomUUID) 六组 import——已抽至
  // ./wechat-inbound.ts（ISSUE-12 单元 2.20 原文搬运；processMessage 体零
  // 机械替换，仅 opts 形参类型收窄为 WeChatInboundConnectOpts 结构子集，
  // 2.15 qq-inbound ④同款）。状态留守+引用注入（disconnect / connect 清理
  // 行逐字节不变，2.15 同款）：dedup / knownJids / contextTokenCache /
  // rejectTimestamps / REJECT_COOLDOWN_MS——contextTokenCache 与 2.18
  // contextTokens 注入为同一 Map 实例，写读语义不变。
  // sendMessageApi（2.18 返回面）/ processImageItem / processFileItem
  //（2.19 返回面）同名透传；MESSAGE_TYPE_BOT / MESSAGE_ITEM_TYPE_TEXT /
  // IMAGE / FILE 常数改经 wechat-inbound sibling 引自 wechat-outbound
  //（本文件回接名随本单元删除）。channel-attachment-routing-order 的微信
  // 路由顺序契约与 channel-pairing-uniform 的 /pair 接线断言等强改锚
  // src/wechat-inbound.ts（断言文本逐字不变，2.15 体例）。pollLoop 的
  // processMessage 调用点 2.21 起随轮询簇迁往 wechat-poller、经下方
  // Long-Polling Poller 接线同名透传。
  const { processMessage } = createWeChatInboundProcessor({
    sendMessageApi,
    processImageItem,
    processFileItem,
    dedup,
    knownJids,
    contextTokenCache,
    rejectTimestamps,
    REJECT_COOLDOWN_MS,
  });

  // ─── Long-Polling Poller ──────────────────────────────────
  // 轮询簇整簇（markConnectionHealthy / handlePollFailure / pollLoop /
  // sleep / closeDispatcher，原 506-685）及仅簇内消费的模块级素材——
  // weChatConnectionErrorMessage 助手、RECONNECT_MIN/MAX_DELAY_MS /
  // REPEATED_ERROR_LOG_INTERVAL_MS / ERRCODE_SESSION_EXPIRED 四常数、
  // random / now 解析行——已抽至 ./wechat-poller.ts（ISSUE-12 单元 2.21
  // 原文搬运，qq-ws 2.14 整簇纪律：互递归与轮询超时控制整簇内聚禁半抽；
  // 搬运体仅访问器机械替换，`+=` 与构造赋值用局部 const 捕获 + setX 保持
  // 下游引用逐字节）。状态归属以 connect() / disconnect() 门面复位与清理
  // 行最小扰动为准则（2.14 状态留守+访问器先例）：stopping / running /
  // connected / pollPromise / consecutiveFailures / consecutivePollTimeouts
  // / failureStartedAt / lastConnectedAt / cancelSleep / dispatcher /
  // longpollTimeoutMs / currentGetUpdatesBuf / activeOpts 均有门面或 2.17
  // 接线消费点，本体留守本文件状态区——门面全部复位与清理行因此逐字节
  // 不变（running / pollPromise / activePollController 簇体不消费，零
  // 接线）；lastLoggedErrorCode / lastRepeatedErrorLogAt 簇内独有，随簇
  // 内化（2.16 lastIncomingMsgId 先例）。deps 原样透传——
  // wechat-connection-lifecycle 的 random / now 注入链穿透至
  // handlePollFailure / markConnectionHealthy（2.17 已透传 fetch /
  // createDispatcher，头号风险注记本单元收尾）。publishState / getUpdates
  //（2.17 返回面）/ processMessage（2.20 返回面）/ logContext 同名注入；
  // classifyWeChatConnectionError / jitteredWeChatRetryDelay /
  // processWeChatUpdateBatch 为本文件既有导出（外层门面约束），经同名
  // 参数注入（2.17 parseWeChatApiResponse 同款）；getConnectionState 经
  // 核对仅 connect 门面消费、簇体零消费不入（2.18 api 子集同判）。同名
  // 解构使 connect 的 pollPromise = pollLoop() 接线与 disconnect 的
  // closeDispatcher 调用点零改动。
  const { pollLoop, closeDispatcher } = createWeChatPoller({
    deps,
    logContext,
    publishState,
    getUpdates,
    processMessage,
    classifyWeChatConnectionError,
    jitteredWeChatRetryDelay,
    processWeChatUpdateBatch,
    getStopping: () => stopping,
    getConnected: () => connected,
    setConnected: (value) => {
      connected = value;
    },
    getConsecutiveFailures: () => consecutiveFailures,
    setConsecutiveFailures: (value) => {
      consecutiveFailures = value;
    },
    getConsecutivePollTimeouts: () => consecutivePollTimeouts,
    setConsecutivePollTimeouts: (value) => {
      consecutivePollTimeouts = value;
    },
    getFailureStartedAt: () => failureStartedAt,
    setFailureStartedAt: (value) => {
      failureStartedAt = value;
    },
    getLastConnectedAt: () => lastConnectedAt,
    setLastConnectedAt: (value) => {
      lastConnectedAt = value;
    },
    getActiveOpts: () => activeOpts,
    getCurrentGetUpdatesBuf: () => currentGetUpdatesBuf,
    setCurrentGetUpdatesBuf: (value) => {
      currentGetUpdatesBuf = value;
    },
    getLongpollTimeoutMs: () => longpollTimeoutMs,
    setLongpollTimeoutMs: (value) => {
      longpollTimeoutMs = value;
    },
    getCancelSleep: () => cancelSleep,
    setCancelSleep: (value) => {
      cancelSleep = value;
    },
    getDispatcher: () => dispatcher,
    setDispatcher: (value) => {
      dispatcher = value;
    },
  });

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
