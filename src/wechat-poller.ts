/**
 * WeChat iLink 长轮询簇（原 src/wechat.ts createWeChatConnection 工厂内
 * “Long-Polling Loop”段 markConnectionHealthy / handlePollFailure / pollLoop
 * / sleep / closeDispatcher（原 wechat.ts:506-685），及仅簇内消费的模块级
 * 素材——weChatConnectionErrorMessage 助手、RECONNECT_MIN/MAX_DELAY_MS /
 * REPEATED_ERROR_LOG_INTERVAL_MS / ERRCODE_SESSION_EXPIRED 四常数、
 * random / now 解析行——ISSUE-12 单元 2.21 原文搬运，qq-ws 2.14 整簇
 * 纪律：pollLoop→handlePollFailure→sleep 互递归与轮询超时控制整簇内聚，
 * 禁止只抽一半。
 *
 * 状态归属（connect()/disconnect() 门面复位与清理行最小扰动准则，
 * 2.14 状态留守+访问器先例）：stopping / running / connected /
 * pollPromise / consecutiveFailures / consecutivePollTimeouts /
 * failureStartedAt / lastConnectedAt / cancelSleep / dispatcher /
 * longpollTimeoutMs / currentGetUpdatesBuf / activeOpts 均有门面或 2.17
 * 接线消费点，本体留守 src/wechat.ts 状态区——门面全部复位与清理行因此
 * 逐字节不变；running / pollPromise / activePollController 簇体不消费，
 * 零接线。lastLoggedErrorCode / lastRepeatedErrorLogAt 簇内独有（无门面
 * 消费点），随簇内化（2.16 lastIncomingMsgId 先例）。
 *
 * deps 链收尾（wechat-connection-lifecycle 头号风险注记）：deps 原样
 * 透传，random / now 的默认值解析行随簇迁入——注入链 test →
 * createWeChatConnection(deps) → createWeChatPoller → handlePollFailure /
 * markConnectionHealthy 全程穿透（2.17 已透传 fetch / createDispatcher，
 * 本单元补齐 random / now 侧）。
 *
 * 依赖注入（闭包依赖显式参数化，2.14/2.17 同款）：
 *   - publishState / getUpdates：2.17 createWeChatApiClient 返回面成员
 *     同名注入（getConnectionState 经核对仅 connect 门面消费、簇体零
 *     消费不入，2.18 api 子集同判）；
 *   - processMessage：2.20 createWeChatInboundProcessor 返回面成员，
 *     msg / opts 以 any 形参透传（运行时值即完整 WeixinMessage /
 *     WeChatConnectOpts，qq-ws QQWsSessionState 注释同款，函数逆变约束
 *     下的最小机械形态，wechat.ts 侧类型不降级）；
 *   - classifyWeChatConnectionError / jitteredWeChatRetryDelay /
 *     processWeChatUpdateBatch：src/wechat.ts 的既有导出（外层门面约束
 *     “既有导出不动”），留在原文件；本模块不回环 import 原文件
 *     （feishu/qq 系列零 child→parent 回环先例），故经同名参数注入
 *     （2.17 parseWeChatApiResponse 同款）；
 *   - logContext：门面共享的 per-connection 日志上下文引用注入；
 *   - 留守状态访问器：get/set 成对（读点活读语义保持；`+=` 与构造赋值
 *     用局部 const 捕获 + setX，qq-ws 三类机械替换语法同款）。
 *
 * 类型镜像：WeChatConnectionErrorCode / WeChatConnectionState 为
 * src/wechat.ts 同名定义的逐字节结构镜像（2.17 wechat-api 同款）；
 * WeChatPollerUpdates 为 getUpdates 返回面的最小结构声明（仅收 pollLoop
 * 实际消费的字段，msgs 元素经 any 透传）。
 */
import { type Dispatcher } from 'undici';
import { logger } from './logger.js';

// ─── Constants ──────────────────────────────────────────────────

// 原 wechat.ts:27-29 / 32（仅轮询簇消费，随段迁移）。
const RECONNECT_MIN_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS = 60000;
const REPEATED_ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

// errcode for session expired
const ERRCODE_SESSION_EXPIRED = -14;

// ─── Types ──────────────────────────────────────────────────────

// src/wechat.ts 的 WeChatConnectionErrorCode（未导出）的逐字节结构镜像。
type WeChatConnectionErrorCode =
  | 'connect_timeout'
  | 'request_timeout'
  | 'connection_reset'
  | 'tls_error'
  | 'api_error'
  | 'network_error'
  | 'unknown';

// src/wechat.ts 的 WeChatConnectionState（已导出，外层门面约束不动）的
// 逐字节结构镜像——publishState / getConnectionState 注入参数的类型载体。
interface WeChatConnectionState {
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

// getUpdates（2.17 返回面）返回值的最小结构声明——仅收 pollLoop 实际消费
// 的字段；msgs 元素经 any 透传给注入的 processMessage（运行时值即完整
// WeixinMessage），完整类型不降级。
interface WeChatPollerUpdates {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: any[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// src/wechat.ts 的 WeChatConnectOpts（已导出，外层门面约束不动）的结构
// 子集——仅收 pollLoop 实际消费的 onUpdatesBuf 字段；activeOpts 的完整
// WeChatConnectOpts 运行时值经结构化类型自然满足，透传给 processMessage
// 时以 any 形参保持完整类型。
interface WeChatPollerConnectOpts {
  /** Persist a fully processed getUpdates cursor before the next poll. */
  onUpdatesBuf?: (cursor: string) => void | Promise<void>;
}

// src/wechat.ts 的 WeChatConnectionDeps（未导出）的结构子集——仅收轮询簇
// 实际消费的 now / random；createWeChatConnection 收到的完整 deps 原样
// 透传，经结构化类型自然满足（wechat-connection-lifecycle 注入链）。
interface WeChatPollerDeps {
  random?: () => number;
  now?: () => number;
}

/**
 * 留守闭包状态与跨模块返回面的访问器集（本体留 src/wechat.ts 状态区，
 * 2.14 qq-ws 状态留守同款）。stopping / cancelSleep 的门面独写侧在
 * disconnect 清理行，本簇经访问器读写；running / pollPromise /
 * activePollController 簇体不消费，不经本接口。
 */
export interface WeChatPollerInput {
  deps: WeChatPollerDeps;
  logContext: { accountId?: string; userId?: string; botId: string };
  publishState: (state: WeChatConnectionState) => void;
  getUpdates: () => Promise<WeChatPollerUpdates>;
  /** 2.20 inbound 返回面；msg / opts 为完整运行时值的 any 透传。 */
  processMessage: (msg: any, opts: any) => Promise<void>;
  /** src/wechat.ts 既有导出，同名参数注入。 */
  classifyWeChatConnectionError: (error: unknown) => WeChatConnectionErrorCode;
  /** src/wechat.ts 既有导出，同名参数注入。 */
  jitteredWeChatRetryDelay: (
    baseDelayMs: number,
    random: () => number,
  ) => number;
  /** src/wechat.ts 既有导出（游标最后提交语义的载体），同名参数注入。 */
  processWeChatUpdateBatch: <T>(input: {
    messages?: T[];
    nextCursor?: string;
    currentCursor: string;
    processMessage: (message: T) => Promise<void>;
    persistCursor?: (cursor: string) => void | Promise<void>;
  }) => Promise<string>;
  getStopping: () => boolean;
  getConnected: () => boolean;
  setConnected: (value: boolean) => void;
  getConsecutiveFailures: () => number;
  setConsecutiveFailures: (value: number) => void;
  getConsecutivePollTimeouts: () => number;
  setConsecutivePollTimeouts: (value: number) => void;
  getFailureStartedAt: () => number;
  setFailureStartedAt: (value: number) => void;
  getLastConnectedAt: () => string | undefined;
  setLastConnectedAt: (value: string | undefined) => void;
  getActiveOpts: () => WeChatPollerConnectOpts | null;
  getCurrentGetUpdatesBuf: () => string;
  setCurrentGetUpdatesBuf: (value: string) => void;
  getLongpollTimeoutMs: () => number;
  setLongpollTimeoutMs: (value: number) => void;
  getCancelSleep: () => (() => void) | null;
  setCancelSleep: (value: (() => void) | null) => void;
  getDispatcher: () => Dispatcher | null;
  setDispatcher: (value: Dispatcher | null) => void;
}

// ─── Helpers ────────────────────────────────────────────────────

// 原 wechat.ts:283-301（仅 handlePollFailure 消费，随段迁移）。
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

// ─── Factory ─────────────────────────────────────────────────────

export function createWeChatPoller(input: WeChatPollerInput) {
  const {
    deps,
    logContext,
    publishState,
    getUpdates,
    processMessage,
    classifyWeChatConnectionError,
    jitteredWeChatRetryDelay,
    processWeChatUpdateBatch,
    getStopping,
    getConnected,
    setConnected,
    getConsecutiveFailures,
    setConsecutiveFailures,
    getConsecutivePollTimeouts,
    setConsecutivePollTimeouts,
    getFailureStartedAt,
    setFailureStartedAt,
    getLastConnectedAt,
    setLastConnectedAt,
    getActiveOpts,
    getCurrentGetUpdatesBuf,
    setCurrentGetUpdatesBuf,
    getLongpollTimeoutMs,
    setLongpollTimeoutMs,
    getCancelSleep,
    setCancelSleep,
    getDispatcher,
    setDispatcher,
  } = input;

  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;

  // Repeated-error throttling state — 簇内独有（原 wechat.ts 状态区
  // lastLoggedErrorCode / lastRepeatedErrorLogAt），随簇内化。
  let lastLoggedErrorCode: WeChatConnectionErrorCode | null = null;
  let lastRepeatedErrorLogAt = 0;

  // ─── Long-Polling Loop ────────────────────────────────────

  function markConnectionHealthy(): void {
    const recoveredFailures = getConsecutiveFailures();
    const downtimeMs = getFailureStartedAt()
      ? Math.max(0, now() - getFailureStartedAt())
      : 0;
    const wasConnected = getConnected();
    setConnected(true);
    setConsecutiveFailures(0);
    setConsecutivePollTimeouts(0);
    setFailureStartedAt(0);
    lastLoggedErrorCode = null;
    lastRepeatedErrorLogAt = 0;
    if (wasConnected) return;
    const lastConnectedAt = new Date(now()).toISOString();
    setLastConnectedAt(lastConnectedAt);
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
    setConnected(false);
    const consecutiveFailures = getConsecutiveFailures() + 1;
    setConsecutiveFailures(consecutiveFailures);
    if (!getFailureStartedAt()) setFailureStartedAt(now());
    const errorCode = classifyWeChatConnectionError(err);
    const nextRetryMs = jitteredWeChatRetryDelay(baseDelayMs, random);
    const userMessage = weChatConnectionErrorMessage(errorCode);
    publishState({
      status: 'reconnecting',
      error: userMessage,
      errorCode,
      consecutiveFailures,
      nextRetryMs,
      lastConnectedAt: getLastConnectedAt(),
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

    while (!getStopping()) {
      try {
        const response = await getUpdates();
        if (getStopping()) break;

        // Update longpoll timeout from server
        if (response.longpolling_timeout_ms) {
          setLongpollTimeoutMs(response.longpolling_timeout_ms);
        }

        const responseCode = response.ret ?? response.errcode;

        // Check for session expiry
        if (responseCode === ERRCODE_SESSION_EXPIRED) {
          const error = '微信授权已过期，请重新扫码连接';
          logger.warn(
            { ...logContext, errorCode: 'session_expired' },
            'WeChat session expired; polling stopped',
          );
          setConnected(false);
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

        const opts = getActiveOpts();
        if (!opts || getStopping()) break;

        // Cursor acknowledgement is deliberately last. A crash or processing
        // failure replays the whole batch from the previous durable cursor.
        setCurrentGetUpdatesBuf(
          await processWeChatUpdateBatch({
            messages: response.msgs,
            nextCursor: response.get_updates_buf,
            currentCursor: getCurrentGetUpdatesBuf(),
            processMessage: (msg) => processMessage(msg, opts),
            persistCursor: opts.onUpdatesBuf,
          }),
        );
      } catch (err) {
        if (getStopping()) break;

        // Once healthy, a client-side long-poll timeout only means the server
        // kept the request open longer than advertised. It is not an outage.
        const errorCode = classifyWeChatConnectionError(err);
        if (getConnected() && errorCode === 'request_timeout') {
          setConsecutivePollTimeouts(getConsecutivePollTimeouts() + 1);
        }
        if (
          getConnected() &&
          errorCode === 'request_timeout' &&
          getConsecutivePollTimeouts() === 1
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
        if (getCancelSleep() === cancel) setCancelSleep(null);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      const cancel = () => {
        clearTimeout(timer);
        finish();
      };
      setCancelSleep(cancel);
    });
  }

  async function closeDispatcher(): Promise<void> {
    const activeDispatcher = getDispatcher();
    setDispatcher(null);
    if (!activeDispatcher) return;
    await activeDispatcher.close().catch((err) => {
      logger.debug(
        { ...logContext, err },
        'Failed to close WeChat HTTP dispatcher cleanly',
      );
    });
  }

  return {
    pollLoop,
    closeDispatcher,
  };
}
