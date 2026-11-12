/**
 * Harness adapter evolution CLI (task AE, RSI Phase 1; Phase 3 defaults from
 * task AH).
 *
 * One propose step of the harness² loop, CKQClaw edition: read the
 * workspace's recent observed turns (leak-free via sanitizeObsTurn), hand
 * them to the LLM proposer with the current adapter + lessons, and land a
 * PENDING proposal in eval.db. Nothing here adopts anything — adoption is
 * the admin's explicit action in the Web「Harness 演化」tab (or the API).
 *
 * Usage (manual — REAL LLM requests cost money; same category as
 * `npm run eval:auto-recall`, never part of the verify gate):
 *
 *   npm run eval:harness-evolve -- --workspace <chat-jid> [--limit 40] [--dry-run]
 *                                [--no-cluster] [--no-neighbors]
 *
 *   --workspace      workspace chat JID (the obs_turns.workspace_jid value,
 *                    e.g. feishu:123456)
 *   --limit N        how many recent turns feed the evidence (default 40)
 *   --dry-run        print the proposal + evidence without touching eval.db
 *   --no-cluster     disable turn clustering (task AH fallback to flat turns)
 *   --no-neighbors   disable cross-workspace neighbor lessons (task AH)
 *
 * Phase 3 defaults (task AH): evidence turns cluster by channel+time window
 * with an input-variance label, and up to 3 lexical-matched lessons from
 * OTHER workspaces join the evidence tree (hermit's transferability sell;
 * leak discipline intact — lessons are behavioral, never grader material).
 *
 * Prerequisites: observability on (obs_turns rows exist) and the auto-memory
 * llm endpoint configured (data/config/auto-memory.json — the same glm-flash
 * family endpoint the RecallJudge uses).
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { EvalStore } from '../src/eval-store.js';
import { getAutoMemoryHostConfig } from '../src/auto-memory-config.js';
import { createJudgeLlmClient } from '../src/recall-judge.js';
import { readAdapterFile } from '../src/harness-adapter-store.js';
import {
  buildEvidence,
  buildUnifiedDiff,
  clusterTurns,
  parseProposerResponse,
  pickNeighborLessons,
  proposerPrompt,
  proposerPromptHash,
  sanitizeObsTurn,
} from '../src/harness-proposer.js';
import { validateAdapterMd } from '../src/harness-adapter-store.js';

const MIN_TURNS_FOR_PROPOSAL = 5;

export interface EvolveCliOptions {
  workspace: string;
  limit: number;
  dryRun: boolean;
  /** Task AH: cluster the evidence turns by channel+time+input similarity. */
  cluster: boolean;
  /** Task AH: inject up to 3 lexically-matched lessons from other workspaces. */
  neighbors: boolean;
}

export function parseEvolveArgs(argv: string[]): EvolveCliOptions | null {
  const options: EvolveCliOptions = {
    workspace: '',
    limit: 40,
    dryRun: false,
    cluster: true,
    neighbors: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--no-cluster') {
      options.cluster = false;
    } else if (arg === '--no-neighbors') {
      options.neighbors = false;
    } else if (arg === '--workspace') {
      options.workspace = argv[++i] ?? '';
    } else if (arg === '--limit') {
      const parsed = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(parsed) && parsed >= 1) {
        options.limit = Math.min(parsed, 200);
      }
    } else {
      return null;
    }
  }
  if (!options.workspace.trim()) return null;
  return options;
}

async function main(): Promise<void> {
  const options = parseEvolveArgs(process.argv.slice(2));
  if (!options) {
    console.error(
      'usage: npm run eval:harness-evolve -- --workspace <chat-jid> [--limit 40] [--dry-run]',
    );
    process.exitCode = 1;
    return;
  }

  const store = EvalStore.open();
  try {
    const turnsResult = store.listTurns({
      workspaceJid: options.workspace,
      limit: options.limit,
    });
    if (turnsResult.total < MIN_TURNS_FOR_PROPOSAL) {
      console.error(
        `证据不足：workspace ${options.workspace} 只有 ${turnsResult.total} 条观测 turn（需要 ≥${MIN_TURNS_FOR_PROPOSAL}）——KEEP_BASE，不产提案。` +
          '先在该 workspace 产生真实对话（且 observability 已开启）。',
      );
      process.exitCode = 1;
      return;
    }

    const config = getAutoMemoryHostConfig();
    if (!config.enabled || !config.llm) {
      console.error(
        'auto-memory llm endpoint 未配置（data/config/auto-memory.json）——proposer 无可用模型端点。',
      );
      process.exitCode = 1;
      return;
    }

    const active = store.getActiveHarnessVersion(options.workspace);
    const currentFile = readAdapterFile(options.workspace);
    const currentAdapterMd = currentFile?.text ?? null;
    const lessons = store.listHarnessLessons(options.workspace).map((row) => ({
      cue: row.cue,
      lesson: row.lesson,
      evidence: row.evidence,
      confidence: row.confidence,
    }));

    // Leak-free by construction: judge/cost columns never survive this call.
    const turns = turnsResult.items.map((turn) => sanitizeObsTurn(turn));

    // Phase 3 enhancements (task AH), both optional with --no-* fallbacks.
    const clusters = options.cluster ? clusterTurns(turns) : undefined;
    const neighborLessons = options.neighbors
      ? pickNeighborLessons({
          selfJid: options.workspace,
          selfTurnTexts: turns.map((turn) => turn.inputText),
          allLessons: store.listAllHarnessLessons().map((row) => ({
            workspaceJid: row.workspaceJid,
            cue: row.cue,
            lesson: row.lesson,
            evidence: row.evidence,
            confidence: row.confidence,
          })),
          limit: 3,
        })
      : undefined;

    const evidence = buildEvidence({
      workspaceJid: options.workspace,
      turns,
      currentAdapterMd,
      lessons,
      ...(clusters ? { clusters } : {}),
      ...(neighborLessons ? { neighborLessons } : {}),
    });

    console.error(
      `proposing for ${options.workspace}: ${turns.length} turns, ${lessons.length} lessons, baseline adapter v${currentFile?.version ?? 0}`,
    );
    // Phase 3 audit line (stderr): cluster/neighbor counts for the run log.
    console.error(
      `phase3 evidence: clusters ${clusters ? clusters.length : 'off'} ` +
        `(${turns.length} turns), neighbor lessons ${neighborLessons ? neighborLessons.length : 'off'}`,
    );
    const client = createJudgeLlmClient(config.llm);
    const raw = await client.complete(proposerPrompt(evidence));
    const parsed = parseProposerResponse(raw);
    if (!parsed) {
      // Audit trail: keep the unusable reply addressable (hermit INVALID_MARK).
      store.insertHarnessProposal({
        id: `hp_${randomUUID()}`,
        workspaceJid: options.workspace,
        adapterMd: '',
        keepBase: false,
        diff: null,
        rationale: '(proposer reply failed to parse — recorded for audit)',
        evidence: [],
        baselineVersion: active?.version ?? 0,
        model: config.llm.model,
        promptHash: proposerPromptHash(),
      });
      console.error('proposer 回复不可解析，已记为 invalid 提案（审计）。');
      process.exitCode = 1;
      return;
    }
    if (!parsed.keepBase) {
      const validation = validateAdapterMd(parsed.adapterMd);
      if (!validation.ok) {
        console.error(
          `提案校验失败：\n${validation.issues.map((i) => `- ${i}`).join('\n')}`,
        );
        process.exitCode = 1;
        return;
      }
    }

    const diff = parsed.keepBase
      ? null
      : buildUnifiedDiff(currentAdapterMd, parsed.adapterMd);

    if (options.dryRun) {
      console.log('=== DRY RUN — nothing persisted ===');
      console.log(`keep_base: ${parsed.keepBase}`);
      console.log(`rationale: ${parsed.rationale}`);
      console.log('--- proposed adapter ---');
      console.log(parsed.adapterMd || '(keep base — no change)');
      console.log('--- diff vs current ---');
      console.log(diff ?? '(no baseline / no change)');
      console.log('--- evidence ---');
      for (const item of parsed.evidence) {
        console.log(`* ${item.turnId}: ${item.why}`);
      }
      return;
    }

    const id = `hp_${randomUUID()}`;
    store.insertHarnessProposal({
      id,
      workspaceJid: options.workspace,
      adapterMd: parsed.adapterMd,
      keepBase: parsed.keepBase,
      diff,
      rationale: parsed.rationale,
      evidence: parsed.evidence,
      baselineVersion: active?.version ?? 0,
      model: config.llm.model,
      promptHash: proposerPromptHash(),
    });
    console.log(
      parsed.keepBase
        ? `提案 ${id} 已落库（KEEP_BASE——proposer 认为证据不支持改动，可在 Web 评测页查看后拒绝）。`
        : `提案 ${id} 已落库（pending）——到 Web「评测 → Harness 演化」tab 查看并人审采纳。`,
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
