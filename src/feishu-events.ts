import * as lark from '@larksuiteoapi/node-sdk';
import { logger } from './logger.js';
import { resolveJidByMessageId } from './feishu-streaming-card.js';
import {
  buildFollowUpActionResultCard,
  parseCardCallbackEnvelope,
} from './feishu-cards/builder.js';
import type { FollowUpAction, FollowUpActionResult } from './types.js';

// 飞书 WS 事件注册（原 createFeishuConnection 工厂 connect() 内注册段
// feishu.ts:2749-2918，ISSUE-12 单元 2.5 原文搬运）。EventDispatcher 的创建
// 与 5 键注册在本模块就地完成，connect() 恰好 new 一个、注册同样 5 键
// （tests/feishu-durable-inbox.test.ts 经 mock 的 EventDispatcher 构造器收集
// controls.dispatchers 并直调 'im.message.receive_v1'，断言面不变）。
//
// connectOptions / client 是外层可变 let，事件到达时点才读取，故经
// getConnectOptions / getClient 访问器注入（保留 stop()/connect() 置空后的
// late-binding 语义）；handleIncomingMessage / toEpochMs 为工厂闭包绑定，
// 经 deps 同名注入。搬运体内 connectOptions 引用为逐字机械替换
// （connectOptions → getConnectOptions()，共 8 处）；card.action.trigger 的
// client 读取以一行 const client = getClient() 局部捕获后原文复用（守卫与
// patch 调用之间无 await，与原闭包变量两次读取行为等价）。

// 本地结构副本：src/feishu.ts 的同名接口未导出（该文件导出面须保持不变），
// 字段与其逐字节一致，结构化类型保证两侧 handleIncomingMessage 可互赋。
interface FeishuMentionLike {
  key?: string;
  name?: string;
  id?: { open_id?: string; user_id?: string; union_id?: string };
}

interface IncomingMessagePayload {
  chatId: string;
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  createTimeMs: number;
  messageType: string;
  content: string;
  chatType?: string;
  mentions?: FeishuMentionLike[];
  senderOpenId?: string;
  senderUserId?: string;
  senderUnionId?: string;
  senderName?: string;
  senderTenantKey?: string;
  senderType?: string;
}

// src/feishu.ts ConnectOptions（feishu.ts:109-176，未导出）的结构子集——
// 仅收 5 个事件 handler 实际消费的 5 个回调字段，声明与其逐字节一致；
// 完整 ConnectOptions 经结构化类型自然满足本接口。
interface FeishuEventConnectOptions {
  /** Bot 被添加到群聊时调用（自动注册群组） */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot 被移出群聊或群被解散时调用（自动解绑 IM 绑定） */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** 飞书流式卡片按钮中断回调 */
  onCardInterrupt?: (
    chatJid: string,
    operatorImId: string,
  ) => FollowUpActionResult;
  /** Handle buttons on the compact queued-message card. */
  onFollowUpCardAction?: (input: {
    sourceJid: string;
    targetJid: string;
    messageId: string;
    action: FollowUpAction;
    expectedRunId: string;
    operatorImId: string;
  }) => Promise<FollowUpActionResult> | FollowUpActionResult;
  normalizeIncomingJid?: (jid: string) => string;
}

export interface FeishuEventsDeps {
  handleIncomingMessage: (
    payload: IncomingMessagePayload,
    source: 'ws' | 'backfill',
  ) => Promise<void>;
  toEpochMs: (value: string | number | undefined) => number;
  getConnectOptions: () => FeishuEventConnectOptions | null;
  getClient: () => lark.Client | null;
}

export function buildFeishuEventHandlers(
  deps: FeishuEventsDeps,
): lark.EventDispatcher {
  const { handleIncomingMessage, toEpochMs, getConnectOptions, getClient } =
    deps;

  return new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        const message = data.message;
        const sender = data.sender as typeof data.sender & {
          sender_type?: string;
          tenant_key?: string;
          sender_name?: string;
          sender_id?: {
            open_id?: string;
            user_id?: string;
            union_id?: string;
          };
        };
        await handleIncomingMessage(
          {
            chatId: message.chat_id,
            messageId: message.message_id,
            rootId: message.root_id,
            parentId: message.parent_id,
            threadId: message.thread_id,
            createTimeMs: toEpochMs(message.create_time),
            messageType: message.message_type,
            content: message.content,
            chatType: message.chat_type,
            mentions: message.mentions as FeishuMentionLike[] | undefined,
            senderOpenId: sender.sender_id?.open_id || '',
            senderUserId: sender.sender_id?.user_id,
            senderUnionId: sender.sender_id?.union_id,
            senderName: sender.sender_name,
            senderTenantKey: sender.tenant_key,
            senderType: sender.sender_type,
          },
          'ws',
        );
      } catch (err) {
        logger.error({ err }, 'Error handling Feishu message');
      }
    },
    'im.chat.member.bot.added_v1': async (data) => {
      try {
        const chatId = data.chat_id;
        if (!chatId) return;
        const rawJid = `feishu:${chatId}`;
        const chatJid =
          getConnectOptions()?.normalizeIncomingJid?.(rawJid) ?? rawJid;
        const chatName = data.name || '飞书群聊';
        logger.info({ chatJid, chatName }, 'Bot added to Feishu group');
        getConnectOptions()?.onBotAddedToGroup?.(chatJid, chatName);
      } catch (err) {
        logger.error({ err }, 'Error handling bot added to group event');
      }
    },
    'im.chat.member.bot.deleted_v1': async (data) => {
      try {
        const chatId = data.chat_id;
        if (!chatId) return;
        const rawJid = `feishu:${chatId}`;
        const chatJid =
          getConnectOptions()?.normalizeIncomingJid?.(rawJid) ?? rawJid;
        logger.info({ chatJid }, 'Bot removed from Feishu group');
        getConnectOptions()?.onBotRemovedFromGroup?.(chatJid);
      } catch (err) {
        logger.error({ err }, 'Error handling bot removed from group event');
      }
    },
    'im.chat.disbanded_v1': async (data) => {
      try {
        const chatId = data.chat_id;
        if (!chatId) return;
        const rawJid = `feishu:${chatId}`;
        const chatJid =
          getConnectOptions()?.normalizeIncomingJid?.(rawJid) ?? rawJid;
        logger.info({ chatJid }, 'Feishu group disbanded');
        getConnectOptions()?.onBotRemovedFromGroup?.(chatJid);
      } catch (err) {
        logger.error({ err }, 'Error handling group disbanded event');
      }
    },
    'card.action.trigger': async (data: any) => {
      try {
        const envelope = parseCardCallbackEnvelope(data);
        if (!envelope) {
          logger.debug(
            { keys: Object.keys(data ?? {}).join(',') },
            'Feishu card action ignored: no actionable button value',
          );
          return;
        }
        const { value, cardMessageId, operatorImId } = envelope;
        const action = value.action;
        if (!cardMessageId) return;

        let result: FollowUpActionResult | undefined;
        if (action === 'interrupt_stream') {
          const chatJid = resolveJidByMessageId(cardMessageId);
          if (!chatJid) {
            logger.debug(
              { cardMessageId },
              'Card action: no mapping for messageId',
            );
            return;
          }
          result = getConnectOptions()?.onCardInterrupt?.(
            chatJid,
            operatorImId,
          );
        } else if (
          action === 'steer_queued' ||
          action === 'cancel_queued' ||
          action === 'interrupt_and_run'
        ) {
          const mappedAction: FollowUpAction =
            action === 'steer_queued'
              ? 'steer'
              : action === 'cancel_queued'
                ? 'cancel'
                : 'interrupt_and_run';
          if (
            typeof value.sourceJid !== 'string' ||
            typeof value.targetJid !== 'string' ||
            typeof value.messageId !== 'string' ||
            typeof value.expectedRunId !== 'string'
          ) {
            return;
          }
          result = await getConnectOptions()?.onFollowUpCardAction?.({
            sourceJid: value.sourceJid,
            targetJid: value.targetJid,
            messageId: value.messageId,
            action: mappedAction,
            expectedRunId: value.expectedRunId,
            operatorImId,
          });
        }

        if (!result) return;
        if (!result.ok) {
          return {
            toast: {
              type: 'warning',
              content: result.message,
            },
          };
        }
        const client = getClient();
        if (!client) return;
        // 业务错误码不抛异常（HTTP 200 + code!=0 时尤其如此），必须记录响应，
        // 否则卡片更新失败会退化成无痕迹的静默成功。
        const patchResp = await client.im.v1.message.patch({
          path: { message_id: cardMessageId },
          data: {
            content: JSON.stringify(
              buildFollowUpActionResultCard(result.message, result.ok),
            ),
          },
        });
        logger.info(
          {
            cardMessageId,
            code: (patchResp as { code?: number } | undefined)?.code,
            msg: (patchResp as { msg?: string } | undefined)?.msg,
          },
          'Feishu follow-up card patched',
        );
      } catch (err) {
        logger.error({ err }, 'Error handling card action trigger');
      }
    },
  });
}
