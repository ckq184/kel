/**
 * 飞书入站三段准入决策（原 createFeishuConnection 工厂内
 * processClaimedIncomingMessage 主管道三段，ISSUE-12 单元 2.8 原文搬运）。
 *
 * 三段在主管道中彼此不连续（受众门与 mention 门之间隔着斜杠指令段，后者
 * 属单元 2.10），故拆为三个决策函数、共用一个工厂：
 *   - 受众门（audience gate）：isSenderAllowedInGroup fail-closed；群聊且
 *     @bot 的拒绝消息补一个 SILENT 反应，让"静默丢弃"可被群里观察；
 *   - mention 门（fail-closed）：evaluateMentionGate 纯函数决策；botOpenId
 *     缺失时经 ensureBotOpenIdFresh 触发后台 lazy refetch 自愈，warn 日志按
 *     BOT_INFO_MISSING_WARN_INTERVAL_MS 节流（节流计数原为 feishu.ts 工厂
 *     let 闭包，随本单元迁入本工厂，每连接一份、生命周期不变）；
 *   - 路由准入 + P2P bootstrap：群聊先 stripLeadingBotMention 归一；首条
 *     P2P DM 即 "bot added" 自举信号（onNewChat / onP2pSender），再经
 *     resolveAdmittedChannelRoute fail-closed。
 *
 * 边界（近纯决策模块）：决策体及其伴生观察/自愈侧效（SILENT 反应、节流
 * 告警、lazy refetch、bootstrap 注册、@bot 前缀归一）随本模块；claim 终态
 * 记账（ignoreClaimedInbound 调用与 return 控制流）留在
 * processClaimedIncomingMessage 按 verdict 分支沿用原文——claim 生命周期
 * 契约由 tests/feishu-inbox-claim-lifecycle.test.ts 锁定，
 * P2P 自举顺序由 tests/feishu-route-safety.test.ts 锚定本模块切片。
 */
import { logger } from './logger.js';
import {
  evaluateMentionGate,
  stripLeadingBotMention,
  type MentionGateMention,
} from './feishu-mention-gate.js';
import {
  ChannelRouteRejectedError,
  resolveAdmittedChannelRoute,
} from './channel-admission.js';
import type { createFeishuBotInfoRefresher } from './feishu-bot-info.js';
import type { FeishuConversationPlan } from './feishu-conversation-policy.js';
import type { FeishuMentionLike } from './feishu-inbox.js';
import type { FeishuMessageMeta } from './types.js';

// "因 botOpenId 缺失而丢消息" 的 warn 节流间隔，避免日志刷屏
const BOT_INFO_MISSING_WARN_INTERVAL_MS = 5 * 60 * 1000;

/** 受众门 verdict：admitted 放行；audience_rejected 拒绝。 */
export type FeishuAudienceAdmission =
  | { verdict: 'admitted' }
  | { verdict: 'audience_rejected' };

/** mention 门 verdict：admitted 放行；mention_gate + reason 为四态拒绝因。 */
export type FeishuMentionAdmission =
  | { verdict: 'admitted' }
  | { verdict: 'mention_gate'; reason: string };

/** resolveAdmittedChannelRoute<FeishuMessageMeta> 的非空 admitted 结果。 */
export type AdmittedFeishuRoute = NonNullable<
  ReturnType<typeof resolveAdmittedChannelRoute<FeishuMessageMeta>>
>;

/** 路由准入 verdict：admitted 回传路由与归一后文本；binding_rejected 拒绝。 */
export type FeishuRouteAdmission =
  | {
      verdict: 'admitted';
      admittedRoute: AdmittedFeishuRoute;
      strippedText: string;
    }
  | { verdict: 'binding_rejected' };

export function createFeishuInboundAdmission(deps: {
  /** bot open_id 探测（mention 门与群聊 @bot 前缀归一依赖）。 */
  botInfoRefresher: Pick<
    ReturnType<typeof createFeishuBotInfoRefresher>,
    'getOpenId'
  >;
  /** mention 门 fail-closed 触发的后台 lazy refetch 自愈。 */
  ensureBotOpenIdFresh: (reason: string) => Promise<void>;
}) {
  const { botInfoRefresher, ensureBotOpenIdFresh } = deps;
  // mention gate fail-closed 的 warn 节流：避免 botOpenId 长时间缺失时日志洪水
  let lastBotInfoMissingWarnAt = 0;
  let botInfoMissingDroppedSinceLastWarn = 0;

  function evaluateAudienceAdmission(input: {
    isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
    chatJid: string;
    senderOpenId: string;
    chatType: string | undefined;
    mentionedBot: boolean;
    messageId: string;
    addReaction: (messageId: string, emojiType: string) => Promise<unknown>;
  }): FeishuAudienceAdmission {
    const {
      isSenderAllowedInGroup,
      chatJid,
      senderOpenId,
      chatType,
      mentionedBot,
      messageId,
      addReaction,
    } = input;
    // Audience is an identity boundary, independent from @/topic activation,
    // and therefore runs before commands and before the mention gate. This
    // also applies to p2p chats and already-active topics.
    if (
      isSenderAllowedInGroup &&
      !isSenderAllowedInGroup(chatJid, senderOpenId)
    ) {
      if (chatType === 'group' && mentionedBot) {
        addReaction(messageId, 'SILENT').catch(() => {});
      }
      logger.debug(
        { chatJid, messageId, senderOpenId, chatType },
        'Dropped Feishu message: sender rejected by audience policy',
      );
      return { verdict: 'audience_rejected' };
    }
    return { verdict: 'admitted' };
  }

  function evaluateMentionAdmission(input: {
    normalizedChatType: 'p2p' | 'group' | undefined;
    mentions: FeishuMentionLike[] | undefined;
    chatJid: string;
    senderOpenId: string;
    messageId: string;
    shouldProcessGroupMessage?: (
      chatJid: string,
      senderImId?: string,
    ) => boolean;
    isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
    conversationPlan: FeishuConversationPlan | undefined;
  }): FeishuMentionAdmission {
    const {
      normalizedChatType,
      mentions,
      chatJid,
      senderOpenId,
      messageId,
      shouldProcessGroupMessage,
      isGroupOwnerMessage,
      conversationPlan,
    } = input;
    // ── 群聊 Mention 过滤：require_mention / owner_mentioned 模式下过滤 ──
    // 决策由 evaluateMentionGate（src/feishu-mention-gate.ts）以纯函数形式给出，
    // 历史上这里曾因 botOpenId 缺失而 fail-open 静默失效；新版 fail-closed，
    // 并通过 ensureBotOpenIdFresh() 触发后台 lazy refetch 自愈。
    {
      const decision = evaluateMentionGate({
        chatType: normalizedChatType,
        botOpenId: botInfoRefresher.getOpenId(),
        mentions: mentions as MentionGateMention[] | undefined,
        chatJid,
        senderOpenId,
        shouldProcessGroupMessage,
        isGroupOwnerMessage,
        conversationPlan,
      });
      if (!decision.allow) {
        if (decision.reason === 'bot_open_id_missing') {
          // 触发后台 lazy refetch（节流由函数内部保证），不阻塞当前消息
          void ensureBotOpenIdFresh('mention-gate-fallback');
          // warn 日志按 5 分钟节流，避免 botOpenId 长时间缺失时刷屏
          const now = Date.now();
          botInfoMissingDroppedSinceLastWarn++;
          if (
            now - lastBotInfoMissingWarnAt >=
            BOT_INFO_MISSING_WARN_INTERVAL_MS
          ) {
            logger.warn(
              {
                chatJid,
                messageId,
                droppedSinceLastWarn: botInfoMissingDroppedSinceLastWarn,
              },
              'Dropping group messages: bot open_id unknown (fail-closed). Triggered lazy refetch.',
            );
            lastBotInfoMissingWarnAt = now;
            botInfoMissingDroppedSinceLastWarn = 0;
          } else {
            logger.debug(
              { chatJid, messageId },
              'Dropped group message: bot open_id missing (warn throttled)',
            );
          }
        } else if (decision.reason === 'not_mentioned') {
          logger.debug(
            { chatJid, messageId },
            'Dropped group message: mention required but bot not mentioned',
          );
        } else if (decision.reason === 'not_owner') {
          logger.debug(
            { chatJid, messageId, senderOpenId },
            'Dropped group message: owner_mentioned mode, sender is not owner',
          );
        } else {
          logger.debug(
            { chatJid, messageId },
            'Dropped Feishu message: activation mode is disabled',
          );
        }
        return { verdict: 'mention_gate', reason: decision.reason };
      }
    }
    return { verdict: 'admitted' };
  }

  function evaluateRouteAdmission(input: {
    chatType: string | undefined;
    normalizedChatType: 'p2p' | 'group' | undefined;
    chatJid: string;
    text: string;
    mentionedBot: boolean;
    mentions: FeishuMentionLike[] | undefined;
    messageId: string;
    senderOpenId: string;
    threadId: string | undefined;
    rootId: string | undefined;
    parentId: string | undefined;
    conversationPlan: FeishuConversationPlan | undefined;
    source: 'ws' | 'backfill';
    resolveEffectiveChatJid?: (
      chatJid: string,
      messageMeta?: FeishuMessageMeta,
    ) => {
      effectiveJid: string;
      agentId: string | null;
      sourceJid?: string;
    } | null;
    onNewChat?: (chatJid: string, chatName: string) => void;
    onP2pSender?: (senderOpenId: string) => void;
    resolvedChatName: string;
  }): FeishuRouteAdmission {
    const {
      chatType,
      normalizedChatType,
      chatJid,
      mentionedBot,
      mentions,
      messageId,
      senderOpenId,
      threadId,
      rootId,
      parentId,
      conversationPlan,
      source,
      resolveEffectiveChatJid,
      onNewChat,
      onP2pSender,
      resolvedChatName,
    } = input;
    let text = input.text;
    // Feishu requires @bot in mention-gated groups, but the durable human
    // text should contain the actual request. Strip only the leading bot
    // token proven by Feishu mention metadata; other @mentions remain.
    if (chatType === 'group') {
      text = stripLeadingBotMention(
        text,
        botInfoRefresher.getOpenId(),
        mentions as MentionGateMention[] | undefined,
      );
    }

    // Validate the binding before registration, owner learning, metadata or
    // attachment downloads. The title/context metadata available here is
    // sufficient for native-thread routing; downloaded paths are payload.
    //
    // Group chats get an external ownership signal before their first
    // message can ever arrive here (im.chat.member.bot.added_v1 →
    // onBotAddedToGroup, wired to the same onNewChat below), so the route
    // check below can safely fail-closed on an unregistered group chat —
    // it should never actually be unregistered by the time a message
    // shows up. P2P chats have no equivalent bootstrap event: the first
    // DM IS the "bot added" signal (mirrors the "/pair establishes
    // ownership before routing" contract other channels use — see
    // channel-admission.ts). Without this, resolveAdmittedChannelRoute
    // would fail-closed on every message from a brand-new P2P chat
    // forever, since registration (below) never gets a chance to run.
    // onNewChat/onP2pSender are idempotent no-ops once already
    // registered, so calling them again in their normal position below
    // is safe and keeps this bootstrap narrowly scoped to P2P.
    //
    // The resolver wired in by IMConnectionManager (scopeConnectOpts) does
    // not return null for an unresolved route: it throws
    // ChannelRouteRejectedError, which for this probe means exactly "not
    // registered yet". Treat only that error as the bootstrap signal; any
    // other failure must still surface. The strict route check below keeps
    // rejecting legitimately rejected routes.
    if (chatType === 'p2p' && resolveEffectiveChatJid) {
      let routeResolved = true;
      try {
        routeResolved = !!resolveEffectiveChatJid(chatJid);
      } catch (err) {
        if (!(err instanceof ChannelRouteRejectedError)) throw err;
        routeResolved = false;
      }
      if (!routeResolved) {
        onNewChat?.(chatJid, resolvedChatName);
        if (senderOpenId && onP2pSender) {
          onP2pSender(senderOpenId);
        }
      }
    }

    const admittedRoute = resolveAdmittedChannelRoute<FeishuMessageMeta>(
      chatJid,
      resolveEffectiveChatJid,
      {
        provider: 'feishu',
        chatType: normalizedChatType,
        mentionedBot,
        nativeContextType:
          conversationPlan?.independentContext ||
          (!conversationPlan && !!threadId)
            ? 'thread'
            : undefined,
        contextId: conversationPlan?.contextId || threadId,
        threadId,
        rootId: conversationPlan?.rootMessageId || rootId,
        parentId,
        messageId,
        text,
      },
    );
    if (!admittedRoute) {
      logger.warn(
        { chatJid, messageId, source },
        'Feishu binding resolver rejected route; dropping message',
      );
      return { verdict: 'binding_rejected' };
    }
    return {
      verdict: 'admitted',
      admittedRoute,
      strippedText: text,
    };
  }

  return {
    evaluateAudienceAdmission,
    evaluateMentionAdmission,
    evaluateRouteAdmission,
  };
}
