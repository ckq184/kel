/**
 * QQ 流式会话状态与端点（原 src/qq.ts createQQConnection 工厂内
 * getNextMsgSeq 与 lastIncomingMsgId 状态簇（原 qq.ts 状态区），及门面
 * sendStreamMessage 方法体（原 qq.ts Connection Interface 段），ISSUE-12
 * 单元 2.16 原文搬运，QQ 六连收官）。
 *
 * 状态归属（disconnect 清理行为最小扰动准则，2.14/2.15 状态留守同款）：
 *   - msgSeqCounters：disconnect 清理（msgSeqCounters.clear()）→ 本体留守
 *     src/qq.ts 状态区，经同名参数注入本工厂；getNextMsgSeq 函数体逐字节
 *     保留；
 *   - lastIncomingMsgId：disconnect 本不清（被动回复引用跨连接存续语义），
 *     随迁本工厂内部；门面 getLastIncomingMsgId 读点与 2.15 inbound 的
 *     c2c 写点经返回面同名 Map 零改动（同一 Map 实例透传）。
 *
 * 依赖注入：api.apiRequest（2.12 createQQApi 返回面的结构子集）——
 * sendStreamMessage 流式分片端点唯一外依赖。
 *
 * 同名解构使 src/qq.ts 的 sendQQMessage / 2.13 media 接线 / 门面
 * getNextMsgSeq 转发调用点零改动；门面 sendStreamMessage 方法壳与签名
 * 不动，方法体改一行委托（搬运体仅缩进随工厂层级归一）。
 */

// src/qq.ts 的 createQQApi 返回面的结构子集——仅收流式端点实际消费的
// apiRequest；完整 api 对象经结构化类型自然满足。
export interface QQStreamApi {
  apiRequest: <T = any>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => Promise<T>;
}

export function createQQStreamState(
  api: QQStreamApi,
  msgSeqCounters: Map<string, number>,
) {
  const { apiRequest } = api;

  // Latest incoming msg_id per C2C openid, used as passive-reply reference
  // for stream_messages (QQ API rejects the endpoint without msg_id).
  const lastIncomingMsgId = new Map<string, string>();

  function getNextMsgSeq(chatId: string): number {
    const current = msgSeqCounters.get(chatId) ?? 0;
    const next = current + 1;
    msgSeqCounters.set(chatId, next);
    return next;
  }

  async function sendStreamMessage(
    openid: string,
    params: {
      input_mode: string;
      input_state: number;
      content_type: string;
      content_raw: string;
      msg_seq: number;
      index: number;
      stream_msg_id?: string;
      msg_id?: string;
      event_id?: string;
    },
  ): Promise<{ id?: string }> {
    const endpoint = `/v2/users/${openid}/stream_messages`;
    const body: Record<string, unknown> = {
      input_mode: params.input_mode,
      input_state: params.input_state,
      content_type: params.content_type,
      content_raw: params.content_raw,
      msg_seq: params.msg_seq,
      index: params.index,
    };
    if (params.stream_msg_id) {
      body.stream_msg_id = params.stream_msg_id;
    }
    if (params.msg_id) {
      body.msg_id = params.msg_id;
    }
    if (params.event_id) {
      body.event_id = params.event_id;
    }
    return apiRequest<{ id?: string }>('POST', endpoint, body);
  }

  return {
    getNextMsgSeq,
    sendStreamMessage,
    lastIncomingMsgId,
  };
}
