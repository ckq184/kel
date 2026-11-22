import type * as lark from '@larksuiteoapi/node-sdk';
import { getChannelCursor } from './channel-reliability-store.js';
import { logger } from './logger.js';
import type {
  FeishuMentionLike,
  IncomingMessagePayload,
} from './feishu-inbox.js';

// 飞书 im.v1.message.list 翻页回填（原 createFeishuConnection 工厂内闭包，
// ISSUE-12 单元 2.3 原文搬运）。外层 client 为可变 let，经 getClient 访问器
// 注入；knownChatIds / chatTypeById / reliabilityAccountId / toEpochMs /
// handleIncomingMessage 为工厂闭包绑定，经 deps 同名注入（搬运体内引用逐字节
// 不变）。防重入标志 backfillRunning 仍留在 src/feishu.ts（connect() 复位语义
// 不变），经 isBackfillRunning / setBackfillRunning 访问器对读写。

const BACKFILL_LOOKBACK_MS = 5 * 60 * 1000;
const BACKFILL_PAGE_SIZE = 50;
const BACKFILL_MAX_PAGES_PER_CHAT = 5;
// durable 游标的 scope 键（持久键，值不得变更；feishu.ts 的 inbox 进度块共用，
// 故导出回接）。原 feishu.ts:235 随块迁移。
export const FEISHU_CURSOR_SCOPE = 'chat_messages';

// FeishuMentionLike / IncomingMessagePayload 的本地结构副本已随 ISSUE-12
// 单元 2.7 收编：两接口现由 ./feishu-inbox.ts 导出（type-only import，无
// 运行时环；feishu-inbox 对本文件的 FEISHU_CURSOR_SCOPE 运行时依赖不回环）。

export interface FeishuBackfillDeps {
  getClient: () => lark.Client | null;
  reliabilityAccountId: string;
  knownChatIds: Set<string>;
  chatTypeById: Map<string, string>;
  toEpochMs: (value: string | number | undefined) => number;
  handleIncomingMessage: (
    payload: IncomingMessagePayload,
    source: 'ws' | 'backfill',
  ) => Promise<void>;
  isBackfillRunning: () => boolean;
  setBackfillRunning: (running: boolean) => void;
}

export function createFeishuBackfill(deps: FeishuBackfillDeps) {
  const {
    getClient,
    reliabilityAccountId,
    knownChatIds,
    chatTypeById,
    toEpochMs,
    handleIncomingMessage,
    isBackfillRunning,
    setBackfillRunning,
  } = deps;

  async function backfillChatMessages(
    chatId: string,
    sinceMs: number,
  ): Promise<void> {
    const client = getClient();
    if (!client) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = Math.max(0, Math.floor(sinceMs / 1000));
    const params: {
      container_id_type: 'chat';
      container_id: string;
      sort_type: 'ByCreateTimeDesc';
      start_time: string;
      end_time: string;
      page_size: number;
      page_token?: string;
    } = {
      container_id_type: 'chat',
      container_id: chatId,
      sort_type: 'ByCreateTimeDesc',
      start_time: String(startSec),
      end_time: String(nowSec),
      page_size: BACKFILL_PAGE_SIZE,
    };

    const pendingMessages: IncomingMessagePayload[] = [];
    let pages = 0;
    while (pages < BACKFILL_MAX_PAGES_PER_CHAT) {
      const response = (await client.im.v1.message.list({ params })) as {
        data?: {
          items?: Array<{
            message_id?: string;
            create_time?: string | number;
            msg_type?: string;
            message_type?: string;
            body?: { content?: string };
            content?: string;
            chat_type?: string;
            mentions?: FeishuMentionLike[];
            deleted?: boolean;
            root_id?: string;
            parent_id?: string;
            thread_id?: string;
            sender?: {
              id?: string;
              sender_type?: string;
              tenant_key?: string;
              name?: string;
              sender_id?: {
                open_id?: string;
                user_id?: string;
                union_id?: string;
              };
            };
          }>;
          has_more?: boolean;
          page_token?: string;
        };
      };

      const list = response.data?.items || [];
      const messages = list
        .filter((item) => {
          if (item.deleted === true || !item.message_id) return false;
          // 过滤 Bot 自身发送的消息，避免 backfill 将回复当作新消息处理
          const senderType = item.sender?.sender_type;
          if (senderType === 'app') return false;
          return true;
        })
        .map((item) => {
          const senderOpenId =
            item.sender?.sender_id?.open_id || item.sender?.id || '';
          return {
            chatId,
            messageId: item.message_id as string,
            rootId: item.root_id || undefined,
            parentId: item.parent_id || undefined,
            threadId: item.thread_id || undefined,
            createTimeMs: toEpochMs(item.create_time),
            messageType: item.msg_type || item.message_type || '',
            content: item.body?.content || item.content || '',
            chatType: item.chat_type || chatTypeById.get(chatId) || 'group',
            mentions: item.mentions,
            senderOpenId,
            senderUserId: item.sender?.sender_id?.user_id,
            senderUnionId: item.sender?.sender_id?.union_id,
            senderName: item.sender?.name,
            senderTenantKey: item.sender?.tenant_key,
            senderType: item.sender?.sender_type,
          };
        })
        .sort((a, b) => a.createTimeMs - b.createTimeMs);

      pendingMessages.push(...messages);

      pages++;
      if (!response.data?.has_more || !response.data.page_token) {
        break;
      }
      params.page_token = response.data.page_token;
    }

    // The provider paginates newest-first. Sorting only inside each page would
    // execute page 1 before the older page 2 and violate per-chat ordering.
    pendingMessages.sort((a, b) => {
      const byTime = a.createTimeMs - b.createTimeMs;
      return byTime || a.messageId.localeCompare(b.messageId);
    });
    for (const message of pendingMessages) {
      await handleIncomingMessage(message, 'backfill');
    }
  }

  async function runBackfill(reason: string): Promise<void> {
    if (!getClient() || isBackfillRunning()) return;
    const chatIds = Array.from(knownChatIds);
    if (chatIds.length === 0) return;

    setBackfillRunning(true);
    try {
      for (const chatId of chatIds) {
        try {
          const cursor = getChannelCursor({
            provider: 'feishu',
            accountId: reliabilityAccountId,
            scope: FEISHU_CURSOR_SCOPE,
            chatId,
          });
          const sinceMs = cursor
            ? Math.max(0, cursor.position - BACKFILL_LOOKBACK_MS)
            : Math.max(0, Date.now() - BACKFILL_LOOKBACK_MS);
          await backfillChatMessages(chatId, sinceMs);
        } catch (err) {
          logger.warn({ err, chatId, reason }, 'Feishu chat backfill failed');
        }
      }
      logger.info(
        { reason, chatCount: chatIds.length },
        'Feishu backfill finished',
      );
    } finally {
      setBackfillRunning(false);
    }
  }

  return { backfillChatMessages, runBackfill };
}
