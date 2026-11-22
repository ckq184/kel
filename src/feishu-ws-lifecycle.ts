import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from './logger.js';

// 飞书 WS 状态探查、健康监控与重连（原 createFeishuConnection 工厂内闭包
// feishu.ts:1279-1327 与 feishu.ts:2621-2706，ISSUE-12 单元 2.6 原文搬运）。
// 探查函数 getWsConnectionState 与重连逻辑（reconnectWebSocket /
// checkConnectionHealth）同模块内聚：探查读取的是 lark SDK 未公开的
// wsConfig / isConnecting 私有属性，与重连判定强相关，禁止只抽一半；
// 探查失败静默降级语义（捕获异常返回 null，健康检查跳过状态判断，
// 不触发误重连）逐字保留，见 getWsConnectionState 处原注释。
//
// 闭包状态盘点（变量本体仍为 src/feishu.ts 的可变 let，留在原文件状态
// 装配区——connect()/stop() 的复位与清理行因此逐字节不变；本模块经
// 访问器对读写）：
//   - wsClient（getWsClient / setWsClient）
//   - eventDispatcher（getDispatcher，只读——reconnect 用它重启 WS）
//   - connectOptions（getConnectOptions，只读——重连锁存与 onReady 回调）
//   - reconnecting / reconnectRequestedAt / disconnectedChecks /
//     lastWsStateConnected（get/set 成对）
//   - healthTimer（get/set 成对）
// client 为本簇搬运体不涉及的闭包变量（原 reconnect / 健康检查 /
// 状态探查均不读它），故不经 deps 注入。
//
// 跨模块 deps 同名注入（搬运体内调用点逐字节不变）：
//   - 2.1 botInfoRefresher.getOpenId 探测 + ensureBotOpenIdFresh lazy refetch
//   - durable Inbox 恢复 recoverQueuedInbox（单元 2.7 前仍在 feishu.ts）
//   - 2.3 runBackfill 翻页回填
// WS 常量与 WsConnectionState 接口仅本簇使用，随块迁移
// （原 feishu.ts:222-225 / feishu.ts:450-454）。

// 原文件级常量随块迁移（仅本簇使用）：
const FEISHU_WS_READY_STATE_OPEN = 1;
const WS_HEALTH_CHECK_INTERVAL_MS = 15_000;
const WS_RECONNECT_CHECK_THRESHOLD = 4;
const WS_RECONNECT_MIN_INTERVAL_MS = 30_000;

// 原 feishu.ts 的 WsConnectionState 接口（未导出）随块迁移，字段逐字节
// 一致；仅 getWsConnectionState 使用。
interface WsConnectionState {
  connected: boolean;
  isConnecting: boolean;
  nextConnectTime: number;
}

// src/feishu.ts 的 ConnectOptions（未导出）的结构子集——仅收重连实际
// 消费的必选 onReady 字段，声明与其逐字节一致；完整 ConnectOptions 经
// 结构化类型自然满足本接口。
interface FeishuWsConnectOptions {
  onReady: () => void;
}

// src/feishu.ts 的 FeishuConnectionConfig 的结构子集——仅收重连建链所需
// 的 appId / appSecret；完整配置经结构化类型自然满足。
interface FeishuWsLifecycleConfig {
  appId: string;
  appSecret: string;
}

export interface FeishuWsLifecycleState {
  config: FeishuWsLifecycleConfig;
  getWsClient: () => lark.WSClient | null;
  setWsClient: (ws: lark.WSClient | null) => void;
  getDispatcher: () => lark.EventDispatcher | null;
  getConnectOptions: () => FeishuWsConnectOptions | null;
  getReconnecting: () => boolean;
  setReconnecting: (value: boolean) => void;
  getReconnectRequestedAt: () => number;
  setReconnectRequestedAt: (at: number) => void;
  getDisconnectedChecks: () => number;
  setDisconnectedChecks: (checks: number) => void;
  getLastWsStateConnected: () => boolean;
  setLastWsStateConnected: (connected: boolean) => void;
  getHealthTimer: () => NodeJS.Timeout | null;
  setHealthTimer: (timer: NodeJS.Timeout | null) => void;
  /** 2.1 botInfoRefresher 的结构子集（getOpenId 探测用）；完整对象经结构化类型满足。 */
  botInfoRefresher: { getOpenId: () => string };
  ensureBotOpenIdFresh: (reason: string) => Promise<void>;
  recoverQueuedInbox: (reason: string) => Promise<void>;
  runBackfill: (reason: string) => Promise<void>;
}

export function createFeishuWsLifecycle(state: FeishuWsLifecycleState) {
  const {
    config,
    getWsClient,
    setWsClient,
    getDispatcher,
    getConnectOptions,
    getReconnecting,
    setReconnecting,
    getReconnectRequestedAt,
    setReconnectRequestedAt,
    getDisconnectedChecks,
    setDisconnectedChecks,
    getLastWsStateConnected,
    setLastWsStateConnected,
    getHealthTimer,
    setHealthTimer,
    botInfoRefresher,
    ensureBotOpenIdFresh,
    recoverQueuedInbox,
    runBackfill,
  } = state;

  /**
   * 通过访问飞书 SDK 的私有属性（wsConfig、isConnecting）获取 WebSocket 连接状态。
   *
   * 注意事项：
   * 1. 该函数依赖 @larksuiteoapi/node-sdk 内部未公开的属性结构，SDK 版本升级可能导致失效
   * 2. 失效时函数会静默降级（捕获异常后返回 null），健康检查将跳过状态判断，不会触发误重连
   * 3. 后续可考虑使用 SDK 公开 API getReconnectInfo() 替代私有属性访问
   */
  function getWsConnectionState(): WsConnectionState | null {
    const rawClient = getWsClient() as unknown as {
      wsConfig?: {
        getWSInstance?: () => { readyState?: number } | undefined;
      };
      getReconnectInfo?: () => { nextConnectTime?: number };
      isConnecting?: boolean;
    };
    try {
      const wsInstance = rawClient.wsConfig?.getWSInstance?.();
      const reconnectInfo = rawClient.getReconnectInfo?.() || {};
      return {
        connected: wsInstance?.readyState === FEISHU_WS_READY_STATE_OPEN,
        isConnecting: rawClient.isConnecting === true,
        nextConnectTime: Number(reconnectInfo.nextConnectTime || 0),
      };
    } catch (err) {
      logger.debug({ err }, 'Failed to inspect Feishu WebSocket state');
      return null;
    }
  }

  function stopHealthMonitor(): void {
    const healthTimer = getHealthTimer();
    if (healthTimer) {
      clearInterval(healthTimer);
      setHealthTimer(null);
    }
  }

  function startHealthMonitor(): void {
    stopHealthMonitor();
    const healthTimer = setInterval(() => {
      void checkConnectionHealth();
      // 兜底：botOpenId 缺失时让健康检查顺手 lazy refetch；
      // 启动期 retry 失败 / 飞书短暂抖动后能在几分钟内自动恢复 mention 守卫。
      if (!botInfoRefresher.getOpenId()) {
        void ensureBotOpenIdFresh('health-check');
      }
    }, WS_HEALTH_CHECK_INTERVAL_MS);
    setHealthTimer(healthTimer);
    healthTimer.unref?.();
  }

  async function reconnectWebSocket(reason: string): Promise<void> {
    if (getReconnecting() || !getConnectOptions()) return;
    setReconnecting(true);
    setReconnectRequestedAt(Date.now());
    setDisconnectedChecks(0);

    try {
      if (!getDispatcher()) {
        logger.warn(
          { reason },
          'Skip Feishu reconnect: event dispatcher is missing',
        );
        return;
      }
      const wsClient = getWsClient();
      if (wsClient) {
        try {
          await wsClient.close();
        } catch (err) {
          logger.debug(
            { err },
            'Error closing stale Feishu WS client before reconnect',
          );
        }
      }

      setWsClient(
        new lark.WSClient({
          appId: config.appId,
          appSecret: config.appSecret,
          loggerLevel: lark.LoggerLevel.info,
        }),
      );
      await getWsClient()!.start({ eventDispatcher: getDispatcher()! });

      setLastWsStateConnected(true);
      logger.info({ reason }, 'Feishu WebSocket reconnected');
      await recoverQueuedInbox('reconnect');
      await runBackfill('reconnect');
      getConnectOptions()!.onReady();
    } catch (err) {
      logger.error({ err, reason }, 'Feishu WebSocket reconnect failed');
    } finally {
      setReconnecting(false);
    }
  }

  async function checkConnectionHealth(): Promise<void> {
    if (!getWsClient() || getReconnecting()) return;

    // Inbox retry is independent from WS state. A provider connection can be
    // healthy while one local admission/download attempt needs replay.
    await recoverQueuedInbox('health-check');

    const state = getWsConnectionState();
    if (!state) return;

    if (state.connected) {
      setDisconnectedChecks(0);
      if (!getLastWsStateConnected()) {
        logger.info('Feishu WebSocket is back online');
        await recoverQueuedInbox('recovered');
        await runBackfill('recovered');
      }
      setLastWsStateConnected(true);
      return;
    }

    if (getLastWsStateConnected()) {
      logger.warn(
        { isConnecting: state.isConnecting },
        'Feishu WebSocket appears offline',
      );
    }
    setLastWsStateConnected(false);

    const now = Date.now();
    const reconnectWindowReady =
      state.nextConnectTime <= 0 || state.nextConnectTime <= now;
    if (!reconnectWindowReady) return;

    setDisconnectedChecks(getDisconnectedChecks() + 1);
    if (
      getDisconnectedChecks() >= WS_RECONNECT_CHECK_THRESHOLD &&
      now - getReconnectRequestedAt() >= WS_RECONNECT_MIN_INTERVAL_MS
    ) {
      await reconnectWebSocket('health-check');
    }
  }

  return {
    getWsConnectionState,
    startHealthMonitor,
    stopHealthMonitor,
    checkConnectionHealth,
    reconnectWebSocket,
  };
}
