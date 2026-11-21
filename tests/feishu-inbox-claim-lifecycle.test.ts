import fs from 'node:fs';

import { describe, expect, test } from 'vitest';

// ISSUE-12 单元 2.7 附带的表驱动 claim 生命周期契约（计划 §4.1 风险注记）：
// processClaimedIncomingMessage 每条提前 return 必须命中且仅命中
// completeClaimedInbound / ignoreClaimedInbound / failClaimedInbound 之一。
// 唯一白名单是「丢失租约后弃权」：updateClaimedChannelInbox 返回 false 证明
// 行已不归本实例所有，此时只 stopInboxHeartbeat 后 return，终态转换归属
// 下一个持有者——再触任何终态调用都只会产生第二条 lost-lease 噪音日志。
//
// 断言形态：切出主管道函数体，逐条枚举 return 语句，与下方手工核账的
// CLAIM_RETURN_CONTRACT 表逐行核对（条数 + 行文本 + 前驱段终态种类 +
// 前驱段终态唯一性）。任何新增无终态提前 return 会让条数或某行的
// 前驱段断言翻红；插入合法终态 return 也必须显式改表——这是刻意的
// 改动摩擦（2.8/2.10 继续拆主管道时随搬迁同提交改锚）。
//
// 锚定文件：processClaimedIncomingMessage 本体按单元规则留在 src/feishu.ts
// （2.7 只搬 F2/F3/F4/F10/F13/F14 辅助群），因此本测试在重构前后均锚
// feishu.ts、无需改锚；对已搬走的辅助群/恢复入口的结构断言，则在
// feishu.ts ∪ feishu-inbox.ts（若存在）的联合文本上进行，重构前后同绿。
//
// 2.8 改锚说明：受众门 / mention 门 / 路由准入三段「决策体」（含拒绝侧
// SILENT 反应、节流告警、lazy refetch 自愈、首条 P2P DM 自举、@bot 前缀
// 归一）搬至 src/feishu-inbound-admission.ts，但每段的 claim 终态记账
// （ignoreClaimedInbound 调用）与 return 控制流留在主管道按 verdict 分支
// 沿用原文——因此 21 行表仍逐行锚 feishu.ts：条数、行文本、marker、
// via 终态计数全部不变（三行 return 由原决策段出口改写为 verdict 分支
// 出口，前驱段内终态调用仍恰 1 次）。被搬走的决策体与拒绝文案则以
// 「新模块切片 + 主管道 verdict 分支」双锚收进下方 describe 块
// （Feishu 入站三段准入决策模块契约），等强于原表行对该段可达的全部
// 断言（原表只锁 marker + 终态计数，新 describe 另锁决策体结构与文案）。

const source = fs.readFileSync('src/feishu.ts', 'utf8');
const inboxModuleSource = fs.existsSync('src/feishu-inbox.ts')
  ? fs.readFileSync('src/feishu-inbox.ts', 'utf8')
  : '';
const inboxFamily = `${source}\n${inboxModuleSource}`;
const admissionModuleSource = fs.existsSync('src/feishu-inbound-admission.ts')
  ? fs.readFileSync('src/feishu-inbound-admission.ts', 'utf8')
  : '';

// ─── 工具 ────────────────────────────────────────────────────────────────

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** 去掉行尾 // 注释并 trim（return 行本身允许携带尾注释）。 */
function stripTrailingComment(line: string): string {
  const commentIndex = line.indexOf('//');
  return (commentIndex === -1 ? line : line.slice(0, commentIndex)).trim();
}

/** 花括号深度扫描切出 processClaimedIncomingMessage 完整函数体。 */
function sliceClaimPipeline(): string {
  const marker = 'async function processClaimedIncomingMessage(';
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let cursor = source.indexOf('{', start);
  for (; cursor < source.length; cursor += 1) {
    const ch = source[cursor];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  expect(cursor).toBeLessThan(source.length);
  const bodyText = source.slice(start, cursor + 1);
  // 防误切自检：切出的必须是完整主管道（开头心跳、收尾 intake catch）。
  expect(bodyText).toContain('startInboxHeartbeat(claim);');
  expect(bodyText).toContain('failClaimedInbound(claim, payload, err, true);');
  return bodyText;
}

const pipelineBody = sliceClaimPipeline();
const pipelineLines = pipelineBody.split('\n');

interface ClaimedReturn {
  /** 去注释、trim 后的 return 行原文。 */
  text: string;
  /** 上一条 return 行之后到本行之前的源文本（前驱段）。 */
  segment: string;
}

function enumerateClaimedReturns(): ClaimedReturn[] {
  const found: ClaimedReturn[] = [];
  let previousLine = 0;
  for (let index = 0; index < pipelineLines.length; index += 1) {
    const line = pipelineLines[index];
    if (line.trim().startsWith('//')) continue;
    if (!/\breturn\b/.test(line)) continue;
    found.push({
      text: stripTrailingComment(line),
      segment: pipelineLines.slice(previousLine, index).join('\n'),
    });
    previousLine = index + 1;
  }
  return found;
}

// ─── 表驱动契约本体 ───────────────────────────────────────────────────────

type ClaimTerminalKind = 'complete' | 'ignore' | 'fail';

interface ClaimReturnRow {
  /** 该 return 行（去尾注释、trim）必须逐字等于。 */
  line: string;
  /**
   * pipeline = 主管道提前 return：前驱段必须恰好命中 via 声明的终态调用
   *   （calls 次，多分支时每路径恰一），且不得出现任何其他终态调用。
   * lost-lease = 丢失租约弃权白名单：前驱段只许 stopInboxHeartbeat(claim);
   *   与日志，不得出现任何终态调用（行已不归本实例所有）。
   * nested = 管道体内嵌套函数（箭头回调）的 return，不是管道出口，
   *   仅钉行文本防错位。
   */
  scope: 'pipeline' | 'lost-lease' | 'nested';
  via?: ClaimTerminalKind;
  /** 前驱段内必须出现的定位片段（诊断锚 + 防错位）。 */
  marker: string;
  /** 前驱段内 via 终态调用次数；默认 1（if/else-if/else 分支族为分支数）。 */
  calls?: number;
}

// HEAD（24ef334）逐行核账：21 条 return + 1 条落尾收尾；2.8 后受众门 /
// mention 门 / 路由准入三行的 return 为 verdict 分支出口（决策体在
// src/feishu-inbound-admission.ts，见下方 describe 块）。改动主管道时随提交更新本表。
const CLAIM_RETURN_CONTRACT: ClaimReturnRow[] = [
  {
    // 恢复门：shouldDeferInbound 未开即 fail（retry=true 走恢复调度）
    line: 'return;',
    scope: 'pipeline',
    via: 'fail',
    marker: 'Channel recovery is still reconciling previous turns',
  },
  {
    line: 'return;',
    scope: 'pipeline',
    via: 'fail',
    marker: 'Claimed Feishu Inbox payload is missing chat/message id',
  },
  {
    line: 'return;',
    scope: 'pipeline',
    via: 'ignore',
    marker: "'empty_content'",
  },
  {
    // 2.8：受众门决策体在 feishu-inbound-admission.ts；此 return 为
    // verdict 分支出口，终态记账（ignore ×1）仍在主管道。
    line: 'return;',
    scope: 'pipeline',
    via: 'ignore',
    marker: "'audience_rejected'",
  },
  {
    line: 'return;',
    scope: 'pipeline',
    via: 'complete',
    marker: '请在 /',
  },
  {
    line: 'return;',
    scope: 'pipeline',
    via: 'fail',
    marker:
      'Durable Feishu slash-command checkpoint does not match the recovered input',
  },
  {
    line: 'return;',
    scope: 'pipeline',
    via: 'fail',
    marker: 'interruptedWhileSending',
  },
  {
    line: 'return;',
    scope: 'pipeline',
    via: 'complete',
    marker: 'reply_acknowledged',
  },
  {
    line: 'return;',
    scope: 'lost-lease',
    marker: 'Lost Feishu Inbox lease before command execution checkpoint',
  },
  {
    line: 'return;',
    scope: 'lost-lease',
    marker: 'Lost Feishu Inbox lease before command result checkpoint',
  },
  {
    line: 'return;',
    scope: 'lost-lease',
    marker:
      'Lost Feishu Inbox lease while clearing an unknown command checkpoint',
  },
  {
    line: 'return;',
    scope: 'lost-lease',
    marker: 'Lost Feishu Inbox lease before command reply send checkpoint',
  },
  {
    line: 'return;',
    scope: 'lost-lease',
    marker: 'Lost Feishu Inbox lease after command reply ACK',
  },
  {
    line: 'return;',
    scope: 'pipeline',
    via: 'complete',
    marker: 'completeClaimedInbound(claim, payload);',
  },
  {
    line: 'return;',
    scope: 'lost-lease',
    marker: 'Could not restore rejected slash-command reply checkpoint',
  },
  {
    line: 'return;',
    scope: 'pipeline',
    via: 'fail',
    // 三分支（retryable 拒收 / 投递不确定 / 执行失败）每路径恰一次 fail
    marker: 'delivery outcome is uncertain and requires manual reconciliation',
    calls: 3,
  },
  {
    // 2.8：mention 门决策体在 feishu-inbound-admission.ts；此 return 为
    // verdict 分支出口，终态模板 `mention_gate:${reason}` 仍在主管道。
    line: 'return;',
    scope: 'pipeline',
    via: 'ignore',
    marker: 'mention_gate:',
  },
  {
    // 2.8：路由准入决策体在 feishu-inbound-admission.ts；此 return 为
    // verdict 分支出口，终态记账（ignore ×1）仍在主管道。
    line: 'return;',
    scope: 'pipeline',
    via: 'ignore',
    marker: "'binding_rejected'",
  },
  {
    // replaceReferenceMarker 箭头函数内部的守卫 return（非管道出口）
    line: 'if (!reference) return;',
    scope: 'nested',
    marker: 'replaceReferenceMarker',
  },
  {
    // ack reaction attach 工厂的返回值（非管道出口）
    line: 'return reactionId ? { messageId, reactionId } : null;',
    scope: 'nested',
    marker: 'addReaction(messageId',
  },
  {
    line: 'return;',
    scope: 'pipeline',
    via: 'complete',
    marker: 'Feishu message queued behind active query',
  },
];

const TERMINAL_CALL: Record<ClaimTerminalKind, string> = {
  complete: 'completeClaimedInbound(',
  ignore: 'ignoreClaimedInbound(',
  fail: 'failClaimedInbound(',
};

describe('Feishu durable Inbox claim lifecycle contract', () => {
  test('每条提前 return 恰命中一种终态（或落入 lost-lease 弃权白名单），条数与表锁定', () => {
    const returns = enumerateClaimedReturns();
    expect(returns).toHaveLength(CLAIM_RETURN_CONTRACT.length);

    CLAIM_RETURN_CONTRACT.forEach((row, index) => {
      const found = returns[index];
      // 行文本钉死，防止表与实际 return 错位对齐
      expect({ index, line: found.text }).toEqual({ index, line: row.line });

      if (row.scope === 'nested') {
        // 嵌套函数 return 不是管道出口，前驱段断言不适用
        expect(found.segment).toContain(row.marker);
        return;
      }

      expect({
        index,
        markerPresent: found.segment.includes(row.marker),
      }).toEqual({ index, markerPresent: true });

      if (row.scope === 'lost-lease') {
        // 弃权路径：只停搏心跳，不得再触任何终态转换
        expect(found.segment).toContain('stopInboxHeartbeat(claim);');
        for (const call of Object.values(TERMINAL_CALL)) {
          expect({
            index,
            call,
            count: countOccurrences(found.segment, call),
          }).toEqual({ index, call, count: 0 });
        }
        return;
      }

      // pipeline：via 终态恰好 calls 次，其他终态零次
      const viaCall = TERMINAL_CALL[row.via as ClaimTerminalKind];
      expect({
        index,
        via: row.via,
        count: countOccurrences(found.segment, viaCall),
      }).toEqual({ index, via: row.via, count: row.calls ?? 1 });
      for (const [kind, call] of Object.entries(TERMINAL_CALL)) {
        if (kind !== row.via) {
          expect({
            index,
            kind,
            count: countOccurrences(found.segment, call),
          }).toEqual({ index, kind, count: 0 });
        }
      }
    });
  });

  test('落尾收尾：成功路径 complete、intake 异常路径 fail，无第三种终态', () => {
    const lastReturnLine = pipelineLines.reduce(
      (last, line, index) =>
        /\breturn\b/.test(line) && !line.trim().startsWith('//') ? index : last,
      -1,
    );
    expect(lastReturnLine).toBeGreaterThan(-1);
    const tail = pipelineLines.slice(lastReturnLine + 1).join('\n');
    expect(countOccurrences(tail, TERMINAL_CALL.complete)).toBe(1);
    expect(countOccurrences(tail, TERMINAL_CALL.fail)).toBe(1);
    expect(countOccurrences(tail, TERMINAL_CALL.ignore)).toBe(0);
    expect(tail).toContain(
      'Feishu message intake failed; durable Inbox scheduled a retry',
    );
  });

  test('shouldDeferInbound 恢复门保持在主管道入口（心跳启动后、任何准入决策之前）', () => {
    const heartbeatIdx = pipelineBody.indexOf('startInboxHeartbeat(claim);');
    const gateIdx = pipelineBody.indexOf(
      'connectOptions?.shouldDeferInbound?.()',
    );
    const destructureIdx = pipelineBody.indexOf('const {');
    const terminalIdx = pipelineBody.indexOf(TERMINAL_CALL.fail);
    expect(heartbeatIdx).toBeGreaterThanOrEqual(0);
    expect(gateIdx).toBeGreaterThan(heartbeatIdx);
    expect(gateIdx).toBeLessThan(destructureIdx);
    expect(gateIdx).toBeLessThan(terminalIdx);
  });

  test('durable 持久键推导原文保留（跨实例去重与游标恢复的键面不得漂移）', () => {
    expect(source).toMatch(
      /const reliabilityAccountId =\s*config\.channelAccountId\?\.trim\(\) \|\| `app:\$\{config\.appId\}`;/,
    );
    expect(source).toMatch(
      /const inboxOwner = `feishu:\$\{reliabilityAccountId\}:\$\{randomUUID\(\)\}`;/,
    );
  });

  test('Inbox 辅助群在全仓 feishu 源内唯一定义（防搬运期重复定义或双份漂移）', () => {
    const familyFiles = ['src/feishu.ts'];
    if (inboxModuleSource) familyFiles.push('src/feishu-inbox.ts');
    for (const name of [
      'rememberChatProgress',
      'rememberTerminalProgress',
      'completeClaimedInbound',
      'ignoreClaimedInbound',
      'failClaimedInbound',
      'startInboxHeartbeat',
      'stopInboxHeartbeat',
      'handleIncomingMessage',
      'recoverQueuedInbox',
    ]) {
      const definitions = familyFiles.reduce(
        (total, file) =>
          total +
          countOccurrences(fs.readFileSync(file, 'utf8'), `function ${name}(`),
        0,
      );
      expect({ name, definitions }).toEqual({ name, definitions: 1 });
    }
  });

  test('F10 结构：durable 记录失败必须拒绝无围栏执行，先记录后认领再派发', () => {
    const recordIdx = inboxFamily.indexOf('recordChannelInbox({');
    const claimIdx = inboxFamily.indexOf('claimChannelInboxById(');
    const dispatchIdx = inboxFamily.indexOf(
      'await processClaimedIncomingMessage(payload, source, claim);',
    );
    expect(recordIdx).toBeGreaterThanOrEqual(0);
    expect(claimIdx).toBeGreaterThan(recordIdx);
    expect(dispatchIdx).toBeGreaterThan(claimIdx);

    const refuseIdx = inboxFamily.indexOf(
      'Failed to durably record Feishu message; refusing unfenced execution',
    );
    expect(refuseIdx).toBeGreaterThan(recordIdx);
    // 记录失败只许抛出重抛，禁止回退到易失执行
    expect(inboxFamily.slice(refuseIdx, refuseIdx + 400)).toContain(
      'throw err;',
    );
  });

  test('F13/F14 结构：恢复路径认领用 inboxOwner，无效信封终态 fail，有效信封重派主管道', () => {
    const parseIdx = inboxFamily.indexOf('function parseRecoveredInbox(');
    const recoverIdx = inboxFamily.indexOf(
      'async function recoverQueuedInbox(',
    );
    expect(parseIdx).toBeGreaterThanOrEqual(0);
    expect(recoverIdx).toBeGreaterThan(parseIdx);
    const recoverSlice = inboxFamily.slice(recoverIdx, recoverIdx + 4_000);
    expect(recoverSlice).toContain(
      'claimNextChannelInbox(inboxOwner, FEISHU_INBOX_LEASE_MS, {',
    );
    expect(recoverSlice).toContain(
      "new Error('Invalid durable Feishu Inbox payload')",
    );
    expect(recoverSlice).toContain('await processClaimedIncomingMessage(');
    expect(inboxFamily).toContain('FEISHU_INBOX_RECOVERY_LIMIT');
  });
});

// ─── 单元 2.8：入站三段准入决策模块契约 ───────────────────────────────────
//
// 受众门 / mention 门 / 路由准入三段决策体自 processClaimedIncomingMessage
// 搬至 src/feishu-inbound-admission.ts 后，每个被搬走的分支在此双锚锁定：
// 决策体结构与拒绝文案锚新模块切片，claim 终态记账与 verdict 分支锚主管道
// 切片（21 行表仍锁调用侧，此处补锁被搬走的部分——等强迁移，无断言删除）。

function admissionSlice(fromMarker: string, toMarker: string): string {
  const start = admissionModuleSource.indexOf(fromMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = admissionModuleSource.indexOf(toMarker, start);
  expect(end).toBeGreaterThan(start);
  return admissionModuleSource.slice(start, end);
}

describe('Feishu 入站三段准入决策模块契约（单元 2.8 搬迁锚）', () => {
  test('三段决策体在新模块唯一定义，主管道仅余委托调用与 verdict 分支', () => {
    expect(admissionModuleSource).toContain(
      'function evaluateAudienceAdmission(',
    );
    expect(admissionModuleSource).toContain(
      'function evaluateMentionAdmission(',
    );
    expect(admissionModuleSource).toContain('function evaluateRouteAdmission(');
    // 决策体标志调用只许出现在新模块，不得残留在主管道
    for (const body of [
      'evaluateMentionGate({',
      'resolveAdmittedChannelRoute<FeishuMessageMeta>(',
      "addReaction(messageId, 'SILENT')",
      'text = stripLeadingBotMention(',
    ]) {
      expect({ body, inPipeline: pipelineBody.includes(body) }).toEqual({
        body,
        inPipeline: false,
      });
      expect({
        body,
        inModule: admissionModuleSource.includes(body),
      }).toEqual({ body, inModule: true });
    }
    // 主管道侧恰三处委托调用（防重复接线或漏接）
    for (const call of [
      'evaluateAudienceAdmission({',
      'evaluateMentionAdmission({',
      'evaluateRouteAdmission({',
    ]) {
      expect({ call, count: countOccurrences(pipelineBody, call) }).toEqual({
        call,
        count: 1,
      });
    }
  });

  test('受众门分支：fail-closed 决策与 SILENT 反应/拒绝文案随模块，终态记账在主管道不变', () => {
    const slice = admissionSlice(
      'function evaluateAudienceAdmission(',
      'function evaluateMentionAdmission(',
    );
    expect(slice).toContain('!isSenderAllowedInGroup(chatJid, senderOpenId)');
    expect(slice).toContain("addReaction(messageId, 'SILENT').catch(() => {})");
    expect(slice).toContain(
      "'Dropped Feishu message: sender rejected by audience policy'",
    );
    expect(slice).toContain(
      '// Audience is an identity boundary, independent from @/topic activation,',
    );
    // 终态记账与 return 留在主管道 verdict 分支（等强于原表行锚）
    expect(pipelineBody).toContain(
      "if (audienceAdmission.verdict === 'audience_rejected') {",
    );
    expect(pipelineBody).toContain(
      "ignoreClaimedInbound(claim, payload, 'audience_rejected');",
    );
  });

  test('mention 门分支：自愈与四态拒绝文案随模块，终态模板逐字节沿用', () => {
    const slice = admissionSlice(
      'function evaluateMentionAdmission(',
      'function evaluateRouteAdmission(',
    );
    expect(slice).toContain(
      "void ensureBotOpenIdFresh('mention-gate-fallback');",
    );
    expect(slice).toContain('BOT_INFO_MISSING_WARN_INTERVAL_MS');
    expect(slice).toContain(
      "'Dropping group messages: bot open_id unknown (fail-closed). Triggered lazy refetch.'",
    );
    expect(slice).toContain(
      "'Dropped group message: bot open_id missing (warn throttled)'",
    );
    expect(slice).toContain(
      "'Dropped group message: mention required but bot not mentioned'",
    );
    expect(slice).toContain(
      "'Dropped group message: owner_mentioned mode, sender is not owner'",
    );
    expect(slice).toContain(
      "'Dropped Feishu message: activation mode is disabled'",
    );
    // 节流计数为工厂闭包状态（随 2.8 自 feishu.ts 迁入，每连接一份）
    expect(admissionModuleSource).toContain(
      'let lastBotInfoMissingWarnAt = 0;',
    );
    expect(admissionModuleSource).toContain(
      'let botInfoMissingDroppedSinceLastWarn = 0;',
    );
    // 终态模板在主管道 verdict 分支（decision → mentionAdmission 机械更名）
    expect(pipelineBody).toContain(
      "if (mentionAdmission.verdict === 'mention_gate') {",
    );
    expect(pipelineBody).toContain('`mention_gate:${mentionAdmission.reason}`');
  });

  test('路由准入分支：P2P 自举先于严格路由检查，strip 归一与 warn 文案随模块', () => {
    const slice = admissionSlice(
      'function evaluateRouteAdmission(',
      '\n  return {',
    );
    expect(slice).toContain('text = stripLeadingBotMention(');
    expect(slice).toContain(
      "if (chatType === 'p2p' && resolveEffectiveChatJid) {",
    );
    expect(slice).toContain(
      'if (!(err instanceof ChannelRouteRejectedError)) throw err;',
    );
    // 自举注册先于严格路由检查（feishu-route-safety 顺序锚的模块侧镜像）
    const bootstrapIdx = slice.indexOf(
      'onNewChat?.(chatJid, resolvedChatName)',
    );
    const routeCheckIdx = slice.indexOf(
      'resolveAdmittedChannelRoute<FeishuMessageMeta>',
    );
    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(routeCheckIdx).toBeGreaterThan(bootstrapIdx);
    expect(slice).toContain(
      "'Feishu binding resolver rejected route; dropping message'",
    );
    // 终态记账与路由结果回接在主管道 verdict 分支
    expect(pipelineBody).toContain(
      "if (routeAdmission.verdict === 'binding_rejected') {",
    );
    expect(pipelineBody).toContain(
      "ignoreClaimedInbound(claim, payload, 'binding_rejected');",
    );
    expect(pipelineBody).toContain(
      'const admittedRoute = routeAdmission.admittedRoute;',
    );
    expect(pipelineBody).toContain(
      'const agentRouting = admittedRoute.routing;',
    );
    expect(pipelineBody).toContain('text = routeAdmission.strippedText;');
    // admittedRoute 仍先于 enrich / 下载 / 持久化
    // （channel-route-side-effect-order 锚的管道侧镜像，防回接错位）
    const admittedIdx = pipelineBody.indexOf('const admittedRoute =');
    const enrichIdx = pipelineBody.indexOf('await enrichFeishuInboundContent(');
    expect(admittedIdx).toBeGreaterThan(-1);
    expect(enrichIdx).toBeGreaterThan(admittedIdx);
  });
});
