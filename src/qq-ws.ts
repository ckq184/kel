/**
 * QQ Bot WebSocket 会话与重连调度（原 src/qq.ts createQQConnection 工厂内
 * “WebSocket Connection”段 qq.ts:287-606，及模块级常数 qq.ts:43-65 与
 * QQWsPayload 接口 qq.ts:138-143，ISSUE-12 单元 2.14 原文整簇搬运）。
 *
 * 整簇内聚（plan §4.2：禁止只抽一半）：clearTimers / stopWatchdog /
 * startWatchdog / sendWs / startHeartbeat / connectWs / handleWsMessage /
 * scheduleReconnect 互递归成环——close/error 防双计数注释随体搬运；
 * scheduleReconnect 的 reconnectTimer 回调引用 connectWs，connectWs 的
 * close handler 引用 scheduleReconnect。
 *
 * 闭包状态盘点（feishu-ws-lifecycle 同款）：ws / heartbeatTimer /
 * reconnectTimer / watchdogTimer / reconnectAttempts / lastSequence /
 * sessionId / resumeGatewayUrl / quickDisconnectCount / lastConnectTime /
 * keepaliveMode / lastErrorIsTransient / stopping / readyFired 共 14 个
 * 可变 let 本体留守 src/qq.ts 状态装配区——connect() / disconnect() 门面
 * 的复位与清理行因此逐字节不变；本模块经 get/set 访问器对读写
 *（stopping 为门面独写，故本簇只读）。机械替换语法三类：读 → getX()
 * 内联（await 附近保持活读语义）；写 → setX(v)；构造赋值 → 局部 const
 * 捕获 + setX（定时器/ws 赋值缩进零漂移）。
 *
 * 依赖注入：getAccessToken / resetToken（2.11 qq-token）、getGatewayUrl
 *（2.12 qq-api）、isConnected 门面前向引用（闭包延迟求值，运行时序
 * 不变）、onC2CMessage / onGroupMessage（OP_DISPATCH 分发，2.15 handler
 * 本体留 src/qq.ts；opts 为完整 QQConnectOpts 的运行时透传值，经 any
 * 形参保持 qq.ts 侧 handler 的完整类型——函数逆变约束下的最小形态）。
 *
 * clearTimers 只清心跳与重连定时器（现状即如此）；media sender 的
 * persistent retry setTimeout（2.13）与本簇 stop 链无关，互不触碰。
 */
import WebSocket from 'ws';
import { logger } from './logger.js';
import {
  isTransientError,
  getReconnectDelay,
  classifyCloseCode,
} from './qq-reconnect.js';

const MAX_RECONNECT_ATTEMPTS = 100;
const RATE_LIMIT_DELAY_MS = 60_000;
const QUICK_DISCONNECT_THRESHOLD_MS = 5_000;
const MAX_QUICK_DISCONNECT_COUNT = 3;
// After exhausting MAX_RECONNECT_ATTEMPTS we don't give up; we fall back to a
// long-tail keepalive so a multi-hour outage eventually self-recovers.
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
// Safety net: if we ever end up disconnected with no reconnect pending,
// the watchdog kicks a fresh attempt instead of leaving the bot dead.
const WATCHDOG_INTERVAL_MS = 60_000;

// Intents: PUBLIC_MESSAGES (C2C + group @bot)
const INTENTS = 1 << 25;

// WebSocket opcodes
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

interface QQWsPayload {
  op: number;
  d?: any;
  s?: number;
  t?: string;
}

// src/qq.ts 的 QQConnectOpts（未导出）的结构子集——仅收 WS 簇直接消费的
// 可选 onReady 字段；完整 QQConnectOpts 经结构化类型自然满足（connect()
// 实参原样透传）。OP_DISPATCH 分发的 opts 传给注入的 onC2CMessage /
// onGroupMessage 时以 any 形参透传（见 QQWsSessionState 注释）。
interface QQWsConnectOpts {
  onReady?: () => void;
}

/**
 * WS 簇外置状态与依赖的访问器集（14 个 let 本体留 src/qq.ts 状态区，
 * feishu-ws-lifecycle 同款；门面复位行因此逐字节不变）。
 *
 * onC2CMessage / onGroupMessage：2.15 入站 handler（本体留 src/qq.ts）。
 * opts 形参为完整 QQConnectOpts 的运行时透传值——本簇仅直接消费 onReady，
 * any 形参使 qq.ts 侧 handler 保持完整类型（函数逆变约束：子集形参无法
 * 接住完整类型的 handler，any 为最小机械形态，运行时值即完整 opts）。
 */
export interface QQWsSessionState {
  getWs: () => WebSocket | null;
  setWs: (ws: WebSocket | null) => void;
  getHeartbeatTimer: () => NodeJS.Timeout | null;
  setHeartbeatTimer: (timer: NodeJS.Timeout | null) => void;
  getReconnectTimer: () => NodeJS.Timeout | null;
  setReconnectTimer: (timer: NodeJS.Timeout | null) => void;
  getWatchdogTimer: () => NodeJS.Timeout | null;
  setWatchdogTimer: (timer: NodeJS.Timeout | null) => void;
  getReconnectAttempts: () => number;
  setReconnectAttempts: (attempts: number) => void;
  getLastSequence: () => number | null;
  setLastSequence: (seq: number | null) => void;
  getSessionId: () => string | null;
  setSessionId: (id: string | null) => void;
  getResumeGatewayUrl: () => string | null;
  setResumeGatewayUrl: (url: string | null) => void;
  /** 门面独写（connect()/disconnect() 置 stopping），本簇只读。 */
  getStopping: () => boolean;
  getReadyFired: () => boolean;
  setReadyFired: (fired: boolean) => void;
  getQuickDisconnectCount: () => number;
  setQuickDisconnectCount: (count: number) => void;
  getLastConnectTime: () => number;
  setLastConnectTime: (at: number) => void;
  getKeepaliveMode: () => boolean;
  setKeepaliveMode: (mode: boolean) => void;
  getLastErrorIsTransient: () => boolean;
  setLastErrorIsTransient: (transient: boolean) => void;
  getAccessToken: () => Promise<string>;
  resetToken: () => void;
  getGatewayUrl: () => Promise<string>;
  /** 门面 isConnected 前向引用（闭包延迟求值，运行时序不变）。 */
  isConnected: () => boolean;
  onC2CMessage: (data: any, opts: any) => Promise<void>;
  onGroupMessage: (data: any, opts: any) => Promise<void>;
}

export function createQQWsSession(state: QQWsSessionState) {
  const {
    getWs,
    setWs,
    getHeartbeatTimer,
    setHeartbeatTimer,
    getReconnectTimer,
    setReconnectTimer,
    getWatchdogTimer,
    setWatchdogTimer,
    getReconnectAttempts,
    setReconnectAttempts,
    getLastSequence,
    setLastSequence,
    getSessionId,
    setSessionId,
    getResumeGatewayUrl,
    setResumeGatewayUrl,
    getStopping,
    getReadyFired,
    setReadyFired,
    getQuickDisconnectCount,
    setQuickDisconnectCount,
    getLastConnectTime,
    setLastConnectTime,
    getKeepaliveMode,
    setKeepaliveMode,
    getLastErrorIsTransient,
    setLastErrorIsTransient,
    getAccessToken,
    resetToken,
    getGatewayUrl,
    isConnected,
    onC2CMessage,
    onGroupMessage,
  } = state;

  function clearTimers(): void {
    const heartbeatTimer = getHeartbeatTimer();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      setHeartbeatTimer(null);
    }
    const reconnectTimer = getReconnectTimer();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      setReconnectTimer(null);
    }
  }

  function stopWatchdog(): void {
    const watchdogTimer = getWatchdogTimer();
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      setWatchdogTimer(null);
    }
  }

  function startWatchdog(opts: QQWsConnectOpts): void {
    stopWatchdog();
    const timer = setInterval(() => {
      if (getStopping()) return;
      if (isConnected()) return;
      // A reconnect is already in flight (including keepalive ticks).
      if (getReconnectTimer()) return;
      // Invariant violation: disconnected, not stopping, no retry pending.
      // Reset the budget and kick a fresh attempt — this is the safety net
      // that prevents the bot from staying permanently dead.
      logger.warn(
        {
          reconnectAttempts: getReconnectAttempts(),
          keepaliveMode: getKeepaliveMode(),
        },
        'QQ watchdog detected stale disconnected state, kicking fresh reconnect',
      );
      setReconnectAttempts(0);
      setKeepaliveMode(false);
      setLastErrorIsTransient(false);
      scheduleReconnect(opts);
    }, WATCHDOG_INTERVAL_MS);
    setWatchdogTimer(timer);
  }

  function sendWs(payload: QQWsPayload): void {
    const ws = getWs();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function startHeartbeat(intervalMs: number): void {
    const heartbeatTimer = getHeartbeatTimer();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const timer = setInterval(() => {
      sendWs({ op: OP_HEARTBEAT, d: getLastSequence() });
    }, intervalMs);
    setHeartbeatTimer(timer);
  }

  async function connectWs(
    opts: QQWsConnectOpts,
    gatewayUrl: string,
    isResume: boolean = false,
  ): Promise<void> {
    if (getStopping()) return;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // True only once READY/RESUMED dispatched. Distinguishes a real
      // mid-session disconnect from a connect-time error so the close handler
      // doesn't double-schedule a reconnect that the rejection's catch path
      // is already handling.
      let connectionEstablished = false;

      const ws = new WebSocket(gatewayUrl);
      setWs(ws);

      const onSessionReady = (): void => {
        connectionEstablished = true;
        setLastConnectTime(Date.now());
        setReconnectAttempts(0);
        setKeepaliveMode(false);
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      ws.on('open', () => {
        logger.info(
          { gatewayUrl: gatewayUrl.slice(0, 50) },
          'QQ WebSocket connected',
        );
        // Don't reset reconnectAttempts here — wait until READY/RESUMED
      });

      ws.on('message', async (data) => {
        try {
          const payload: QQWsPayload = JSON.parse(data.toString());
          await handleWsMessage(payload, opts, gatewayUrl, onSessionReady);
        } catch (err) {
          logger.error({ err }, 'Error parsing QQ WebSocket message');
        }
      });

      ws.on('close', (code, reason) => {
        logger.info({ code, reason: reason.toString() }, 'QQ WebSocket closed');
        clearTimers();

        if (!settled) {
          settled = true;
          reject(new Error(`QQ WebSocket closed before ready: ${code}`));
          return;
        }
        // settled but not established → ws.on('error') already rejected;
        // let the rejection's catch path handle the reconnect (avoids the
        // double-increment that drained the old budget in ~3 minutes).
        if (!connectionEstablished) return;
        if (getStopping()) return;

        // Quick-disconnect detection: server flapping us right after READY
        // usually signals a permission / auth issue. Back off harder.
        if (
          getLastConnectTime() > 0 &&
          Date.now() - getLastConnectTime() < QUICK_DISCONNECT_THRESHOLD_MS
        ) {
          setQuickDisconnectCount(getQuickDisconnectCount() + 1);
          if (getQuickDisconnectCount() >= MAX_QUICK_DISCONNECT_COUNT) {
            logger.error(
              { quickDisconnectCount: getQuickDisconnectCount(), code },
              'QQ too many quick disconnects, backing off (check appId/secret/permissions)',
            );
            setQuickDisconnectCount(0);
            scheduleReconnect(opts, RATE_LIMIT_DELAY_MS);
            return;
          }
        } else {
          setQuickDisconnectCount(0);
        }

        const action = classifyCloseCode(code);
        switch (action.kind) {
          case 'refresh-token':
            logger.info(
              { code },
              'QQ invalid token close, forcing token refresh',
            );
            resetToken();
            setSessionId(null);
            setLastSequence(null);
            scheduleReconnect(opts);
            break;
          case 'rate-limit':
            logger.warn({ code }, 'QQ rate limited, applying long delay');
            scheduleReconnect(opts, RATE_LIMIT_DELAY_MS);
            break;
          case 'reset-session':
            logger.info({ code }, 'QQ server internal error, dropping session');
            setSessionId(null);
            setLastSequence(null);
            scheduleReconnect(opts);
            break;
          default:
            scheduleReconnect(opts);
        }
      });

      ws.on('error', (err) => {
        logger.error({ err }, 'QQ WebSocket error');
        setLastErrorIsTransient(isTransientError(err));
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  async function handleWsMessage(
    payload: QQWsPayload,
    opts: QQWsConnectOpts,
    gatewayUrl: string,
    onSessionReady?: () => void,
  ): Promise<void> {
    switch (payload.op) {
      case OP_HELLO: {
        const heartbeatInterval = payload.d?.heartbeat_interval || 41250;
        startHeartbeat(heartbeatInterval);

        const token = await getAccessToken();
        if (getSessionId()) {
          // Resume existing session (after reconnect)
          sendWs({
            op: OP_RESUME,
            d: {
              token: `QQBot ${token}`,
              session_id: getSessionId(),
              seq: getLastSequence(),
            },
          });
        } else {
          // Fresh identify
          sendWs({
            op: OP_IDENTIFY,
            d: {
              token: `QQBot ${token}`,
              intents: INTENTS,
              shard: [0, 1],
            },
          });
        }
        break;
      }

      case OP_DISPATCH: {
        if (payload.s !== undefined) {
          setLastSequence(payload.s);
        }

        const eventType = payload.t;
        const eventData = payload.d;

        if (eventType === 'READY') {
          setSessionId(eventData.session_id);
          setResumeGatewayUrl(gatewayUrl);
          logger.info({ sessionId: getSessionId() }, 'QQ bot session ready');
          onSessionReady?.();
          if (!getReadyFired()) {
            setReadyFired(true);
            opts.onReady?.();
          }
        } else if (eventType === 'RESUMED') {
          logger.info('QQ bot session resumed');
          onSessionReady?.();
        } else if (eventType === 'C2C_MESSAGE_CREATE') {
          await onC2CMessage(eventData, opts);
        } else if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
          await onGroupMessage(eventData, opts);
        }
        break;
      }

      case OP_HEARTBEAT_ACK:
        // Heartbeat acknowledged, all good
        break;

      case OP_RECONNECT:
        logger.info('QQ server requested reconnect');
        getWs()?.close();
        break;

      case OP_INVALID_SESSION: {
        const canResume = payload.d === true;
        logger.warn({ canResume }, 'QQ invalid session');
        if (!canResume) {
          setSessionId(null);
          setLastSequence(null);
        }
        getWs()?.close();
        break;
      }

      default:
        logger.debug({ op: payload.op }, 'QQ unknown WebSocket opcode');
    }
  }

  function scheduleReconnect(
    opts: QQWsConnectOpts,
    customDelay?: number,
  ): void {
    if (getStopping()) return;
    // Idempotent: if a reconnect is already pending, don't double-schedule
    // (the close handler and the connect-failure catch can both fire for the
    // same disconnect event).
    if (getReconnectTimer()) return;

    // Transition to keepalive mode once we exhaust the regular budget.
    // We never hard-stop trying — a long network outage should self-recover.
    if (
      !getKeepaliveMode() &&
      !getLastErrorIsTransient() &&
      getReconnectAttempts() >= MAX_RECONNECT_ATTEMPTS
    ) {
      setKeepaliveMode(true);
      logger.error(
        { attempts: getReconnectAttempts() },
        'QQ max reconnect attempts reached, falling back to keepalive mode',
      );
    }

    let delay: number;
    if (customDelay !== undefined) {
      delay = customDelay;
    } else if (getKeepaliveMode()) {
      delay = KEEPALIVE_INTERVAL_MS;
    } else {
      delay = getReconnectDelay(getReconnectAttempts());
      // Transient errors (DNS hiccups, brief TCP resets) shouldn't burn our
      // attempt budget — otherwise a 3-minute network blip kills the bot.
      if (!getLastErrorIsTransient()) {
        setReconnectAttempts(getReconnectAttempts() + 1);
      }
    }
    const wasTransient = getLastErrorIsTransient();
    setLastErrorIsTransient(false);

    logger.info(
      {
        delay,
        attempt: getReconnectAttempts(),
        keepaliveMode: getKeepaliveMode(),
        wasTransient,
      },
      'QQ scheduling reconnect',
    );
    const timer = setTimeout(async () => {
      setReconnectTimer(null);
      if (getStopping()) return;

      try {
        if (getSessionId() && getResumeGatewayUrl()) {
          // Try to resume
          await connectWs(opts, getResumeGatewayUrl()!, true);
        } else {
          // Fresh connection
          const url = await getGatewayUrl();
          await connectWs(opts, url, false);
        }
      } catch (err) {
        logger.error({ err }, 'QQ reconnect failed');
        setLastErrorIsTransient(isTransientError(err));
        scheduleReconnect(opts);
      }
    }, delay);
    setReconnectTimer(timer);
  }

  return {
    startWatchdog,
    stopWatchdog,
    clearTimers,
    connectWs,
  };
}
