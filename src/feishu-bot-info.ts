import type * as lark from '@larksuiteoapi/node-sdk';
import { logger } from './logger.js';

// 启动期 bot info 拉取的最大重试次数（指数退避 1s/2s/4s）
const BOT_INFO_FETCH_MAX_ATTEMPTS = 4;
// botOpenId 缺失时 lazy refetch 的最小间隔，避免对 OAPI 高频骚扰
const BOT_INFO_REFETCH_MIN_INTERVAL_MS = 60_000;

export interface FeishuBotPublicInfo {
  openId?: string;
  name?: string;
  avatarUrl?: string;
}

/**
 * bot open_id 拉取与自愈（原 createFeishuConnection 工厂内闭包，ISSUE-12 单元 2.1 原文搬运）。
 *
 * 职责：
 *   - 启动期带指数退避的 bot open_id 拉取（fetchBotOpenIdWithRetry）；
 *   - mention 门控发现 botOpenId 缺失时的 lazy refetch 自愈（ensureBotOpenIdFresh）；
 *   - 持有 botOpenId / botPublicInfo / lastBotInfoFetchAt / botInfoRefetchInFlight 闭包状态。
 *
 * 边界：外层 `client` 是可变 let，经 getClient 访问器注入；本模块不感知重连生命周期，
 * connect() 复位状态走 reset()。
 */
export function createFeishuBotInfoRefresher(
  getClient: () => lark.Client | null,
) {
  let botOpenId: string = '';
  let botPublicInfo: FeishuBotPublicInfo = {};
  // botOpenId 自愈状态：lastBotInfoFetchAt 防止 lazy refetch 高频骚扰 OAPI；
  // botInfoRefetchInFlight 防止并发拉取
  let lastBotInfoFetchAt = 0;
  let botInfoRefetchInFlight: Promise<void> | null = null;

  /**
   * 拉取可公开给 Agent 的 bot 信息（open_id、名称、头像）。
   * 失败时返回空对象，由调用方决定是否重试。
   */
  async function fetchBotOpenIdOnce(): Promise<FeishuBotPublicInfo> {
    const client = getClient();
    if (!client) return {};
    try {
      const botInfoRes = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info/',
      });
      const info = botInfoRes as {
        bot?: {
          open_id?: string;
          app_name?: string;
          avatar_url?: string;
        };
        data?: {
          bot?: {
            open_id?: string;
            app_name?: string;
            avatar_url?: string;
          };
        };
      };
      const bot = info?.bot ?? info?.data?.bot;
      return {
        ...(bot?.open_id ? { openId: bot.open_id } : {}),
        ...(bot?.app_name ? { name: bot.app_name } : {}),
        ...(bot?.avatar_url ? { avatarUrl: bot.avatar_url } : {}),
      };
    } catch (err) {
      logger.debug({ err }, 'fetchBotOpenIdOnce failed');
      return {};
    }
  }

  /**
   * 启动期带指数退避的 bot open_id 拉取。最多 4 次（间隔 0/1s/2s/4s）。
   * 即使全部失败也不阻塞 connect()，由 ensureBotOpenIdFresh() 后续兜底。
   */
  async function fetchBotOpenIdWithRetry(): Promise<void> {
    for (let attempt = 0; attempt < BOT_INFO_FETCH_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
      const info = await fetchBotOpenIdOnce();
      lastBotInfoFetchAt = Date.now();
      if (info.openId) {
        botPublicInfo = info;
        botOpenId = info.openId;
        logger.info(
          { botOpenId, attempt: attempt + 1 },
          'Fetched bot open_id for mention detection',
        );
        return;
      }
    }
    logger.warn(
      { attempts: BOT_INFO_FETCH_MAX_ATTEMPTS },
      'Could not fetch bot open_id after retries; mention gating will fail-closed until recovered',
    );
  }

  /**
   * 后台 lazy refetch：消息进入 mention 门控前若发现 botOpenId 仍空，触发一次。
   * 用 lastBotInfoFetchAt 节流，避免每条消息都打 OAPI；并发安全（in-flight Promise 复用）。
   */
  function ensureBotOpenIdFresh(reason: string): Promise<void> {
    if (botOpenId) return Promise.resolve();
    if (botInfoRefetchInFlight) return botInfoRefetchInFlight;
    const now = Date.now();
    if (now - lastBotInfoFetchAt < BOT_INFO_REFETCH_MIN_INTERVAL_MS) {
      return Promise.resolve();
    }
    botInfoRefetchInFlight = (async () => {
      const info = await fetchBotOpenIdOnce();
      lastBotInfoFetchAt = Date.now();
      if (info.openId) {
        botPublicInfo = info;
        botOpenId = info.openId;
        logger.info(
          { botOpenId, reason },
          'Recovered bot open_id (lazy refetch)',
        );
      } else {
        logger.debug({ reason }, 'Lazy refetch of bot open_id still failed');
      }
    })().finally(() => {
      botInfoRefetchInFlight = null;
    });
    return botInfoRefetchInFlight;
  }

  return {
    fetchBotOpenIdOnce,
    fetchBotOpenIdWithRetry,
    ensureBotOpenIdFresh,
    getOpenId: () => botOpenId,
    getPublicInfo: () => botPublicInfo,
    reset: () => {
      botOpenId = '';
      botPublicInfo = {};
      lastBotInfoFetchAt = 0;
    },
  };
}
