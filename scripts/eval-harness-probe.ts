/**
 * Harness probe CLI (task AG, RSI Phase 2).
 *
 * A/B-probes a PENDING proposal before the admin decides it: every
 * acceptance-set question is answered twice via direct single-turn LLM calls
 * (baseline arm = current ACTIVE adapter block, proposed arm = the proposal's
 * block), then a glm-flash blind judge compares the replies anonymously in
 * both presentation orders (swap kills position bias). The aggregated
 * ADOPT/KEEP_BASE/INCONCLUSIVE verdict lands in eval.db `harness_probes`
 * attached to the proposal — ADVICE for the human reviewer, never an action.
 *
 * Known gap (plan §1-1, echoed in the report docs): single-turn direct calls
 * carry no tools, no memory recall, no channel — prompt-only adapter value is
 * what this can see. Full-chain probing is a Phase 3 question.
 *
 * Usage (manual — REAL LLM requests cost money; never part of the verify gate):
 *
 *   npm run eval:harness-probe -- --workspace <chat-jid> --proposal <id> [--dry-run]
 *
 *   --workspace   workspace chat JID (obs_turns.workspace_jid value)
 *   --proposal    harness proposal id (must be pending, non-KEEP_BASE)
 *   --dry-run     print the two-arm plan + call estimate, no LLM calls,
 *                 nothing persisted
 *
 * Prerequisites: an acceptance set for the workspace (Web「Harness 演化」tab
 * or the admin API) and the auto-memory llm endpoint configured
 * (data/config/auto-memory.json — the glm-flash family endpoint).
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { EvalStore } from '../src/eval-store.js';
import type {
  HarnessAcceptanceSetRecord,
  HarnessProposalRecord,
} from '../src/eval-store.js';
import { getAutoMemoryHostConfig } from '../src/auto-memory-config.js';
import { createJudgeLlmClient } from '../src/recall-judge.js';
import {
  buildAdapterBlock,
  readAdapterFile,
} from '../src/harness-adapter-store.js';
import {
  aggregateVerdict,
  blindJudgePrompt,
  parseBlindJudge,
  probeArmPrompt,
  resolveRound,
  validateAcceptanceSet,
} from '../src/harness-probe.js';

// ── Pure CLI helpers (exported for tests, evolve-CLI precedent) ─────────────

export interface ProbeCliOptions {
  workspace: string;
  proposal: string;
  dryRun: boolean;
}

export function parseProbeArgs(argv: string[]): ProbeCliOptions | null {
  const options: ProbeCliOptions = {
    workspace: '',
    proposal: '',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--workspace') {
      options.workspace = argv[++i] ?? '';
    } else if (arg === '--proposal') {
      options.proposal = argv[++i] ?? '';
    } else {
      return null;
    }
  }
  if (!options.workspace.trim() || !options.proposal.trim()) return null;
  return options;
}

/**
 * Backoff wrapper around every probe LLM call (task AG follow-up). The
 * endpoint dropped connections mid-run three probes in a row (~25 rapid
 * calls in), which fail-fast turned into a lost, already-paid run; a short
 * retry absorbs exactly those transient disconnects. Sleep is injectable so
 * the retry contract stays unit-testable.
 */
export async function completeWithRetry(
  client: { model: string; complete(prompt: string): Promise<string> },
  prompt: string,
  options: {
    retries?: number;
    delaysMs?: number[];
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<string> {
  const retries = options.retries ?? 3;
  const delays = options.delaysMs ?? [2_000, 5_000, 10_000];
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await client.complete(prompt);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await sleep(delays[Math.min(attempt, delays.length - 1)]);
    }
  }
  throw lastError;
}

export type ProbePlanReject =
  | { kind: 'proposal_not_found' }
  | { kind: 'proposal_not_pending'; status: string }
  | { kind: 'proposal_workspace_mismatch' }
  | { kind: 'keep_base_proposal' }
  | { kind: 'acceptance_set_missing' }
  | { kind: 'acceptance_set_invalid'; issues: string[] };

export interface ProbePlan {
  proposalId: string;
  workspaceJid: string;
  /** ACTIVE adapter version at probe time; 0 = no adapter (baseline prompt alone). */
  baselineVersion: number;
  /** Display version the proposal would become if adopted. */
  proposedVersion: number;
  queryCount: number;
  /** 2 per query (both arms). */
  generations: number;
  /** 4 per query (2 judges × 2 presentation orders). */
  judgeCalls: number;
  totalCalls: number;
}

/**
 * All pre-flight guardrails as one pure function (the dry-run payload and the
 * run share it): pending-only, non-KEEP_BASE, workspace match, and a valid
 * acceptance set — otherwise the probe must not spend a single call.
 */
export function buildProbePlan(input: {
  proposal: HarnessProposalRecord | null;
  acceptanceSet: HarnessAcceptanceSetRecord | null;
  activeVersion: number;
  workspace: string;
}): ProbePlan | ProbePlanReject {
  if (!input.proposal) return { kind: 'proposal_not_found' };
  if (input.proposal.status !== 'pending') {
    return { kind: 'proposal_not_pending', status: input.proposal.status };
  }
  if (input.proposal.workspaceJid !== input.workspace) {
    return { kind: 'proposal_workspace_mismatch' };
  }
  if (input.proposal.keepBase) return { kind: 'keep_base_proposal' };
  if (!input.acceptanceSet) return { kind: 'acceptance_set_missing' };
  const validation = validateAcceptanceSet(input.acceptanceSet.queries);
  if (!validation.ok) {
    return { kind: 'acceptance_set_invalid', issues: validation.issues };
  }
  const queryCount = input.acceptanceSet.queries.length;
  return {
    proposalId: input.proposal.id,
    workspaceJid: input.proposal.workspaceJid,
    baselineVersion: input.activeVersion,
    proposedVersion: input.activeVersion + 1,
    queryCount,
    generations: queryCount * 2,
    judgeCalls: queryCount * 4,
    totalCalls: queryCount * 6,
  };
}

async function main(): Promise<void> {
  const options = parseProbeArgs(process.argv.slice(2));
  if (!options) {
    console.error(
      'usage: npm run eval:harness-probe -- --workspace <chat-jid> --proposal <id> [--dry-run]',
    );
    process.exitCode = 1;
    return;
  }

  const store = EvalStore.open();
  try {
    const proposal = store.getHarnessProposal(options.proposal);
    const acceptanceSet = store.getAcceptanceSet(options.workspace);
    const active = readAdapterFile(options.workspace);

    const plan = buildProbePlan({
      proposal,
      acceptanceSet,
      activeVersion: active?.version ?? 0,
      workspace: options.workspace,
    });
    if ('kind' in plan) {
      const reasons: Record<string, string> = {
        proposal_not_found: `提案 ${options.proposal} 不存在`,
        proposal_not_pending: `提案 ${options.proposal} 状态为 ${plan.status}——探针只对 pending 提案跑（报告是采纳前证据）`,
        proposal_workspace_mismatch: `提案属于 workspace ${proposal?.workspaceJid}，与 --workspace ${options.workspace} 不符`,
        keep_base_proposal:
          'KEEP_BASE 提案不改 adapter——双臂相同，探针无意义，直接人审拒绝即可',
        acceptance_set_missing: `workspace ${options.workspace} 尚无验收集——先在 Web「评测 → Harness 演化」写入 1–10 题验收问题`,
        acceptance_set_invalid: `验收集校验失败：\n${(plan.issues ?? []).map((i) => `- ${i}`).join('\n')}`,
      };
      console.error(reasons[plan.kind]);
      process.exitCode = 1;
      return;
    }

    const baselineMd = active?.text ?? '';
    const baselineBlock = active
      ? buildAdapterBlock({ version: active.version, text: baselineMd })
      : '';
    const proposedBlock = buildAdapterBlock({
      version: plan.proposedVersion,
      text: proposal!.adapterMd,
    });

    if (options.dryRun) {
      console.log('=== DRY RUN — no LLM calls, nothing persisted ===');
      console.log(
        `proposal: ${plan.proposalId} (pending, 提案时基线 v${proposal!.baselineVersion})`,
      );
      console.log(
        `baseline arm: ${active ? `ACTIVE adapter v${active.version} (${Buffer.byteLength(baselineMd)} bytes)` : '无 adapter（v0 基线 = 平台 prompt 单独）'}`,
      );
      console.log(
        `proposed arm: adapter v${plan.proposedVersion} 候选 (${Buffer.byteLength(proposal!.adapterMd)} bytes)`,
      );
      console.log(`acceptance set: ${plan.queryCount} 题`);
      for (const query of acceptanceSet!.queries) {
        console.log(
          `  - [${query.id}] ${query.text}（要点 ${query.expectNotes.length} 条）`,
        );
      }
      console.log(
        `estimated cost: ${plan.generations} 次生成 + ${plan.judgeCalls} 次盲选判定 = ${plan.totalCalls} 次 flash 调用（费用视端点单价）`,
      );
      console.log(
        '已知覆盖面 gap：单轮直调无工具/无记忆召回——工具类 adapter 改进探不出（Phase 3 再议全链路）。',
      );
      return;
    }

    const config = getAutoMemoryHostConfig();
    if (!config.enabled || !config.llm) {
      console.error(
        'auto-memory llm endpoint 未配置（data/config/auto-memory.json）——探针无可用模型端点。',
      );
      process.exitCode = 1;
      return;
    }

    const client = createJudgeLlmClient(config.llm);
    console.error(
      `probing ${plan.proposalId}: ${plan.queryCount} 题 × 双臂单轮直调 + 双向匿名盲选（judge ${client.model}）`,
    );

    const rounds = [];
    for (const query of acceptanceSet!.queries) {
      const baselineText = await completeWithRetry(
        client,
        probeArmPrompt({ question: query.text, adapterBlock: baselineBlock }),
      );
      const proposedText = await completeWithRetry(
        client,
        probeArmPrompt({ question: query.text, adapterBlock: proposedBlock }),
      );
      // Blind, anonymous, both orders; a failed parse keeps the round as tie.
      const judgeDirect = parseBlindJudge(
        await completeWithRetry(
          client,
          blindJudgePrompt({
            question: query.text,
            expectNotes: query.expectNotes,
            replyA: baselineText,
            replyB: proposedText,
          }),
        ),
      );
      const judgeSwapped = parseBlindJudge(
        await completeWithRetry(
          client,
          blindJudgePrompt({
            question: query.text,
            expectNotes: query.expectNotes,
            replyA: proposedText,
            replyB: baselineText,
          }),
        ),
      );
      rounds.push(
        resolveRound({
          queryId: query.id,
          baselineText,
          proposedText,
          judgeDirect,
          judgeSwapped,
          expectNotes: query.expectNotes,
        }),
      );
      console.error(
        `  [${query.id}] done (${rounds.length}/${plan.queryCount})`,
      );
    }

    const aggregate = aggregateVerdict(rounds);
    const id = `hpr_${randomUUID()}`;
    store.insertHarnessProbe({
      id,
      proposalId: plan.proposalId,
      workspaceJid: plan.workspaceJid,
      baselineVersion: plan.baselineVersion,
      ...aggregate,
      rounds,
      // The judge endpoint client does not expose usage pricing; the call
      // count (printed above) is the cost proxy until Phase 3 revisits.
      costUsd: null,
      model: client.model,
    });
    console.log(
      `探针报告 ${id} 已落库：verdict=${aggregate.verdict}，胜/负/平 ${aggregate.roundsWon}/${aggregate.roundsLost}/${aggregate.roundsTied}，要点命中 基线 ${aggregate.notesBaselineHit} vs 提案 ${aggregate.notesProposedHit}（共 ${plan.totalCalls} 次 ${client.model} 调用）——到 Web「评测 → Harness 演化」提案详情查看逐题对照后**人审**采纳/拒绝。`,
    );
  } finally {
    store.close();
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  await main();
}
