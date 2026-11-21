/**
 * 飞书斜杠指令分发与 durable 命令检查点状态机（原
 * createFeishuConnection 工厂内 processClaimedIncomingMessage 主管道斜杠段
 * 及其专属的 FeishuSlashCommandCheckpoint 校验纯函数，ISSUE-12 单元 2.10
 * 原文搬运）。
 *
 * 段内职责：/queue /steer follow-up 模式请求（缺正文即回用法提示并
 * complete；有正文则剥前缀、携带 requestedFollowUpMode 穿透）、已知
 * /xxx 命令拦截、四态 durable 检查点状态机（executing → pending_reply →
 * sending_reply → reply_acknowledged）、六处 lost-lease 弃权分支（每步
 * 副作用落盘前都经 updateClaimedChannelInbox 做 fenced 写，写失败即只停
 * 心跳后弃权，终态转换归属下一个持有者）、命令失败三分支 fail 族
 * （拒收可安全重排队 / 投递不确定人工核对 / 执行失败终态不重放）。
 *
 * 边界：claim 终态记账（completeClaimedInbound / failClaimedInbound）与
 * 心跳停搏（stopInboxHeartbeat）随搬运体经参数注入触发，主管道调用侧仅
 * 按 handled 返回值回接控制流（handled=true 即段内已终态记账、调用方立即
 * return；handled=false 回接剥前缀后的 text 与 requestedFollowUpMode 沿原
 * 下游继续）——claim 生命周期契约由 tests/feishu-inbox-claim-lifecycle.test.ts
 * 锁定，斜杠段 12 条 return 随本单元同提交等强改锚新模块切片表。
 *
 * 搬运体逐字节保留，仅两类机械替换：① 12 条段内出口 `return;` →
 * `return { handled: true };`（「经返回值表达」的最小扰动形态）；② 闭包
 * 依赖显式参数化（sendTextToChat / 终态记账 / 心跳停搏 /
 * FeishuTextDeliveryError 类身份逐一经入参注入，identifier 原名沿用）。
 * updateClaimedChannelInbox 与 logger 为模块级单例，新模块直接 import
 * （与 src/feishu.ts 引用同一模块实例，2.9 先例）。
 */
import { logger } from './logger.js';
import {
  updateClaimedChannelInbox,
  type ClaimedChannelInboxItem,
} from './channel-reliability-store.js';
import type {
  createFeishuInboxController,
  FeishuMentionLike,
  IncomingMessagePayload,
} from './feishu-inbox.js';
import type { FollowUpMode } from './types.js';

/** 2.7 durable Inbox 控制器的函数族签名（索引引用避免在新模块重述）。 */
type FeishuInboxController = ReturnType<typeof createFeishuInboxController>;

/**
 * src/feishu.ts sendTextToChat 抛出的文本投递错误类（构造签名注入）。
 * feishu.ts 的 FeishuTextDeliveryError 类未导出（本单元不得扩宽 feishu.ts
 * 导出面）；段内 instanceof 身份判定经注入的构造引用保持与抛出侧同一类，
 * outcome 语义（rejected=可安全重排队 / uncertain=须人工核对）原文保留。
 */
export type FeishuTextDeliveryErrorCtor = new (
  message: string,
  outcome: 'rejected' | 'uncertain',
  cause?: unknown,
) => { message: string; outcome: 'rejected' | 'uncertain' };

type FeishuSlashCommandCheckpoint =
  | {
      version: 1;
      kind: 'feishu_slash_command';
      state: 'executing';
      command: string;
      replyTarget: string;
    }
  | {
      version: 1;
      kind: 'feishu_slash_command';
      state: 'pending_reply' | 'sending_reply' | 'reply_acknowledged';
      command: string;
      replyTarget: string;
      replyText: string;
    };

function parseFeishuSlashCommandCheckpoint(
  value: unknown,
): FeishuSlashCommandCheckpoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const checkpoint = value as Record<string, unknown>;
  if (
    checkpoint.version !== 1 ||
    checkpoint.kind !== 'feishu_slash_command' ||
    typeof checkpoint.command !== 'string' ||
    !checkpoint.command ||
    typeof checkpoint.replyTarget !== 'string' ||
    !checkpoint.replyTarget ||
    (checkpoint.state !== 'executing' &&
      checkpoint.state !== 'pending_reply' &&
      checkpoint.state !== 'sending_reply' &&
      checkpoint.state !== 'reply_acknowledged')
  ) {
    return undefined;
  }
  if (checkpoint.state === 'executing') {
    return checkpoint as FeishuSlashCommandCheckpoint;
  }
  return typeof checkpoint.replyText === 'string'
    ? (checkpoint as FeishuSlashCommandCheckpoint)
    : undefined;
}

/** 斜杠段搬运体的入参（依赖显式参数化，见模块头注）。 */
export interface FeishuCommandDispatchInput {
  /** durable Inbox 认领行（检查点 fenced 写与终态记账的键）。 */
  claim: ClaimedChannelInboxItem;
  /** 入站消息载荷（终态记账沿原文传参）。 */
  payload: IncomingMessagePayload;
  /** 会话 JID（命令回调与日志沿原文）。 */
  chatJid: string;
  /** 消息 id（日志沿原文）。 */
  messageId: string;
  /** 发送者 open_id（onCommand 沿原文传参）。 */
  senderOpenId: string;
  /** @ 信息（onCommand 沿原文传参）。 */
  mentions?: FeishuMentionLike[];
  /**
   * 飞书路由目标。feishu.ts 的 FeishuRouteTarget 接口未导出（本单元不得
   * 扩宽 feishu.ts 导出面），此处按搬运体实际消费的字段（仅 .raw）结构
   * 重述，调用侧整对象传入结构兼容（2.9 同款处置）。
   */
  messageRouteTarget: { raw: string };
  /** ConnectOptions.onCommand 回调；未注册即 undefined，段内守卫原文保留。 */
  onCommand:
    | ((
        chatJid: string,
        command: string,
        senderImId?: string,
        senderMentions?: FeishuMentionLike[],
      ) => Promise<string | null>)
    | undefined;
  /** mention 归一后的入站正文；follow-up 模式剥前缀后随结果回传。 */
  text: string;
  /** feishu.ts 工厂内 sendTextToChat（回复 / 提示投递与超时语义由其承载）。 */
  sendTextToChat: (chatId: string, text: string) => Promise<void>;
  /** 2.7 durable Inbox 终态记账（complete）。 */
  completeClaimedInbound: FeishuInboxController['completeClaimedInbound'];
  /** 2.7 durable Inbox 终态记账（fail，含 retry 与重试延迟语义）。 */
  failClaimedInbound: FeishuInboxController['failClaimedInbound'];
  /** 2.7 心跳停搏（lost-lease 弃权白名单分支的原文调用）。 */
  stopInboxHeartbeat: FeishuInboxController['stopInboxHeartbeat'];
  /** feishu.ts 文本投递错误类身份（段内 instanceof 判定注入）。 */
  FeishuTextDeliveryError: FeishuTextDeliveryErrorCtor;
}

/**
 * 斜杠段结果：handled=true 表示该输入已被命令流完全消费（终态已在段内
 * 记账），主管道立即 return；handled=false 表示非终态穿透（未知命令 /
 * follow-up 模式请求），回接剥前缀后的正文与 follow-up 模式，沿主管道
 * 原下游（mention 门 → 路由准入 → enrich → 下载 → 持久化）继续。
 */
export type FeishuCommandDispatchResult =
  | { handled: true }
  | {
      handled: false;
      /** follow-up 模式（/queue /steer）剥前缀后的正文；未命中模式时原样回传。 */
      text: string;
      /** /queue /steer 请求的持久模式；未请求时为 undefined。 */
      requestedFollowUpMode: FollowUpMode | undefined;
    };

export async function dispatchFeishuCommand(
  input: FeishuCommandDispatchInput,
): Promise<FeishuCommandDispatchResult> {
  const {
    claim,
    payload,
    chatJid,
    messageId,
    senderOpenId,
    mentions,
    messageRouteTarget,
    onCommand,
    sendTextToChat,
    completeClaimedInbound,
    failClaimedInbound,
    stopInboxHeartbeat,
    FeishuTextDeliveryError,
  } = input;
  let { text } = input;

  // ── 斜杠指令：拦截已知 /xxx 命令，不进入消息流 ──
  // 群聊中 @机器人 后跟斜杠命令，mention 替换后文本为 "@botname /cmd"，
  // 需要先 strip 掉开头的 @mention 前缀再匹配
  let textForSlash = text?.trim().replace(/^@\S+\s+/, '') ?? '';
  let requestedFollowUpMode: FollowUpMode | undefined;
  const followUpModeMatch = textForSlash.match(
    /^\/(queue|steer)(?:\s+([\s\S]+))?$/i,
  );
  if (followUpModeMatch) {
    const modeContent = followUpModeMatch[2]?.trim();
    if (!modeContent) {
      await sendTextToChat(
        messageRouteTarget.raw,
        `请在 /${followUpModeMatch[1].toLowerCase()} 后输入消息内容。`,
      );
      completeClaimedInbound(claim, payload);
      return { handled: true };
    }
    requestedFollowUpMode =
      followUpModeMatch[1].toLowerCase() === 'steer' ? 'steer' : 'queue';
    text = modeContent;
    textForSlash = modeContent;
  }
  const slashMatch = textForSlash.match(/^\/(\S+)(.*)$/);
  if (slashMatch && onCommand && !requestedFollowUpMode) {
    const cmdBody = (slashMatch[1] + slashMatch[2]).trim();
    const persistedCommand = parseFeishuSlashCommandCheckpoint(
      claim.normalizedPayload,
    );
    logger.info(
      {
        chatJid,
        cmd: slashMatch[1],
        cmdBody,
        checkpointState: persistedCommand?.state,
      },
      'Feishu slash command detected',
    );
    if (persistedCommand && persistedCommand.command !== cmdBody) {
      failClaimedInbound(
        claim,
        payload,
        new Error(
          'Durable Feishu slash-command checkpoint does not match the recovered input',
        ),
        false,
      );
      return { handled: true };
    }
    if (
      persistedCommand?.state === 'executing' ||
      persistedCommand?.state === 'sending_reply'
    ) {
      // The prior process may have executed arbitrary command side
      // effects or reached the provider before it died. Re-running either
      // step is unsafe, so stop for manual reconciliation instead.
      const interruptedWhileSending =
        persistedCommand.state === 'sending_reply';
      failClaimedInbound(
        claim,
        payload,
        new Error(
          interruptedWhileSending
            ? 'Feishu slash command reply delivery was interrupted after send began; manual reconciliation required'
            : 'Feishu slash command execution was interrupted before its result was persisted; manual reconciliation required',
        ),
        false,
      );
      try {
        await sendTextToChat(
          persistedCommand.replyTarget,
          interruptedWhileSending
            ? '⚠️ 上一次命令回复可能已经送达，但系统未能确认，请核对后再决定是否重试。'
            : '⚠️ 上一次命令执行在结果落盘前中断，为避免重复执行，系统已停止自动重试，请人工核对。',
        );
      } catch (sendErr) {
        logger.error(
          { chatJid, messageId, sendErr },
          'Failed to send interrupted slash-command reconciliation notice',
        );
      }
      return { handled: true };
    }
    if (persistedCommand?.state === 'reply_acknowledged') {
      completeClaimedInbound(claim, payload);
      return { handled: true };
    }
    let retryableReply: FeishuSlashCommandCheckpoint | undefined;
    try {
      let reply: string | null;
      let replyTarget: string;
      if (persistedCommand?.state === 'pending_reply') {
        reply = persistedCommand.replyText;
        replyTarget = persistedCommand.replyTarget;
        retryableReply = persistedCommand;
      } else {
        const executingCheckpoint: FeishuSlashCommandCheckpoint = {
          version: 1,
          kind: 'feishu_slash_command',
          state: 'executing',
          command: cmdBody,
          replyTarget: messageRouteTarget.raw,
        };
        if (
          !updateClaimedChannelInbox(claim, {
            normalizedPayload: executingCheckpoint,
          })
        ) {
          stopInboxHeartbeat(claim);
          logger.warn(
            { inboxId: claim.id, messageId, cmd: slashMatch[1] },
            'Lost Feishu Inbox lease before command execution checkpoint',
          );
          return { handled: true };
        }
        reply = await onCommand(chatJid, cmdBody, senderOpenId, mentions);
        replyTarget = messageRouteTarget.raw;
        if (reply) {
          const pendingReply: FeishuSlashCommandCheckpoint = {
            ...executingCheckpoint,
            state: 'pending_reply',
            replyText: reply,
          };
          if (
            !updateClaimedChannelInbox(claim, {
              normalizedPayload: pendingReply,
            })
          ) {
            stopInboxHeartbeat(claim);
            logger.error(
              { inboxId: claim.id, messageId, cmd: slashMatch[1] },
              'Lost Feishu Inbox lease before command result checkpoint; refusing reply delivery',
            );
            return { handled: true };
          }
          retryableReply = pendingReply;
        } else if (
          !updateClaimedChannelInbox(claim, { normalizedPayload: null })
        ) {
          stopInboxHeartbeat(claim);
          logger.warn(
            { inboxId: claim.id, messageId, cmd: slashMatch[1] },
            'Lost Feishu Inbox lease while clearing an unknown command checkpoint',
          );
          return { handled: true };
        }
      }
      logger.info(
        {
          chatJid,
          cmd: slashMatch[1],
          hasReply: !!reply,
          replyLen: reply?.length,
        },
        'Feishu slash command processed',
      );
      if (reply) {
        const sendingReply: FeishuSlashCommandCheckpoint = {
          version: 1,
          kind: 'feishu_slash_command',
          state: 'sending_reply',
          command: cmdBody,
          replyTarget,
          replyText: reply,
        };
        if (
          !updateClaimedChannelInbox(claim, {
            normalizedPayload: sendingReply,
          })
        ) {
          stopInboxHeartbeat(claim);
          logger.error(
            { inboxId: claim.id, messageId, cmd: slashMatch[1] },
            'Lost Feishu Inbox lease before command reply send checkpoint',
          );
          return { handled: true };
        }
        await sendTextToChat(replyTarget, reply);
        const acknowledged: FeishuSlashCommandCheckpoint = {
          version: 1,
          kind: 'feishu_slash_command',
          state: 'reply_acknowledged',
          command: cmdBody,
          replyTarget,
          replyText: reply,
        };
        if (
          !updateClaimedChannelInbox(claim, {
            normalizedPayload: acknowledged,
          })
        ) {
          stopInboxHeartbeat(claim);
          logger.error(
            { inboxId: claim.id, messageId, cmd: slashMatch[1] },
            'Lost Feishu Inbox lease after command reply ACK; refusing an unfenced completion',
          );
          return { handled: true };
        }
        completeClaimedInbound(claim, payload);
        return { handled: true }; // 已知命令，拦截
      }
      // reply 为 null 表示未知命令，继续作为普通消息处理
    } catch (err) {
      const deliveryFailure = err instanceof FeishuTextDeliveryError;
      const rejectedBeforeAcceptance =
        deliveryFailure && err.outcome === 'rejected';
      logger.error(
        {
          chatJid,
          cmd: slashMatch[1],
          err,
          deliveryFailure,
          rejectedBeforeAcceptance,
        },
        'Feishu slash command failed',
      );
      if (!deliveryFailure) {
        try {
          await sendTextToChat(
            messageRouteTarget.raw,
            '⚠️ 命令执行失败，请稍后重试',
          );
        } catch (sendErr) {
          logger.error(
            { chatJid, sendErr },
            'Failed to send slash command error feedback',
          );
        }
      }
      if (rejectedBeforeAcceptance && retryableReply) {
        const safelyRequeued = updateClaimedChannelInbox(claim, {
          normalizedPayload: retryableReply,
        });
        if (!safelyRequeued) {
          stopInboxHeartbeat(claim);
          logger.error(
            { inboxId: claim.id, messageId, cmd: slashMatch[1] },
            'Could not restore rejected slash-command reply checkpoint',
          );
          return { handled: true };
        }
        failClaimedInbound(claim, payload, err, true);
      } else if (deliveryFailure) {
        failClaimedInbound(
          claim,
          payload,
          new Error(
            `${err.message}; delivery outcome is uncertain and requires manual reconciliation`,
          ),
          false,
        );
        try {
          await sendTextToChat(
            messageRouteTarget.raw,
            '⚠️ 命令回复的投递结果未知，为避免重复发送，系统已停止自动重试，请人工核对。',
          );
        } catch (sendErr) {
          logger.error(
            { chatJid, messageId, sendErr },
            'Failed to send uncertain slash-command delivery notice',
          );
        }
      } else {
        // Command execution failures stay terminal because replaying
        // arbitrary command side effects is not safe.
        failClaimedInbound(claim, payload, err, false);
      }
      return { handled: true };
    }
  }
  // 未知命令（reply 为 null）或 /queue /steer follow-up 模式请求：非终态
  // 穿透，已剥模式前缀的 text 与 requestedFollowUpMode 回接主管道普通消息流
  return { handled: false, text, requestedFollowUpMode };
}
