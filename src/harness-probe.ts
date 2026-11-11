import crypto from 'node:crypto';

import type {
  HarnessBlindJudge,
  HarnessProbeRound,
  HarnessProbeVerdict,
} from './eval-store.js';

/**
 * Harness probe (task AG, RSI Phase 2) — pure functions only.
 *
 * Before an admin decides a pending proposal, the probe runs a two-arm
 * single-turn A/B: the same acceptance questions answered once under the
 * active adapter block (baseline arm) and once under the proposed block
 * (proposed arm), both via the recall-judge style direct LLM endpoint. A
 * glm-flash blind judge then compares the two replies anonymously — twice per
 * question with swapped presentation order (position-bias control); the two
 * verdicts must agree or the round/note counts as tie.
 *
 * KNOWN GAP (deliberate, plan §1-1): direct single-turn calls carry no tools,
 * no memory recall, no channel. A prompt-only adapter's value lives in reply
 * text, which this covers; tool-use/recall-shaped improvements are invisible
 * here — full-chain probing is a Phase 3 question.
 *
 * Leak discipline (harness² third line of defence): the proposer's evidence
 * tree never contains acceptance sets or probe reports — this module is only
 * reachable from the admin surface and the manual CLI, never from the
 * proposer. The verdict is ADVICE for the human reviewer, never an action.
 */

export const PROBE_PROMPT_VERSION = 'harness-probe-v1';
export const BLIND_JUDGE_PROMPT_VERSION = 'harness-blind-judge-v1';

export const ACCEPTANCE_QUERIES_MIN = 1;
export const ACCEPTANCE_QUERIES_MAX = 10;

// ── Acceptance set ──────────────────────────────────────────────────────────

export interface AcceptanceQuery {
  id: string;
  text: string;
  /** Behavioural checkpoints (not exact answers), e.g. 「开头声明文件名与记录数」. */
  expectNotes: string[];
}

export interface AcceptanceValidation {
  ok: boolean;
  issues: string[];
}

/**
 * Structural validation for admin-supplied JSON (Web textarea / PUT body).
 * Extra keys on a query entry are tolerated — only the contract fields are
 * checked (validateGoldenSet posture).
 */
export function validateAcceptanceSet(queries: unknown): AcceptanceValidation {
  const issues: string[] = [];
  if (!Array.isArray(queries)) {
    return {
      ok: false,
      issues: ['验收集必须是 JSON 数组（{queries: [...]} 的 queries 值）'],
    };
  }
  if (queries.length < ACCEPTANCE_QUERIES_MIN) {
    issues.push(`至少需要 ${ACCEPTANCE_QUERIES_MIN} 题`);
  }
  if (queries.length > ACCEPTANCE_QUERIES_MAX) {
    issues.push(
      `至多 ${ACCEPTANCE_QUERIES_MAX} 题（当前 ${queries.length} 题）`,
    );
  }
  const seenIds = new Set<string>();
  queries.forEach((entry, index) => {
    const label = `第 ${index + 1} 题`;
    if (!entry || typeof entry !== 'object') {
      issues.push(`${label}：不是对象`);
      return;
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id.trim()) {
      issues.push(`${label}：id 缺失或为空`);
    } else if (seenIds.has(row.id)) {
      issues.push(`${label}：id「${row.id}」重复`);
    } else {
      seenIds.add(row.id);
    }
    if (typeof row.text !== 'string' || !row.text.trim()) {
      issues.push(`${label}：text 缺失或为空`);
    }
    if (
      !Array.isArray(row.expectNotes) ||
      row.expectNotes.length < 1 ||
      !row.expectNotes.every((note) => typeof note === 'string' && note.trim())
    ) {
      issues.push(`${label}：expectNotes 需为 ≥1 条非空字符串`);
    }
  });
  return { ok: issues.length === 0, issues };
}

// ── Arm prompt (shared by both arms; only the adapter block differs) ────────

/**
 * One probe arm = simplified platform head + (optional) adapter block +
 * acceptance question. The head is an identity SUMMARY, not the real platform
 * prompt (the known gap above) — it only fixes the role and language so the
 * two arms stay byte-identical except for the block.
 */
export function probeArmPrompt(input: {
  question: string;
  /** Empty string = baseline arm with no adapter (v0): the block is omitted, mirroring the runner. */
  adapterBlock: string;
}): string {
  const lines: string[] = [
    'You are CKQClaw, a self-hosted workspace assistant.',
    'Answer the user question below directly, in the workspace primary language.',
    `Probe prompt version: ${PROBE_PROMPT_VERSION}`,
  ];
  if (input.adapterBlock.trim()) {
    lines.push('', input.adapterBlock.trim());
  }
  lines.push('', 'User question:', input.question);
  return lines.join('\n');
}

/** Stable fingerprint of the arm template identity (proposer precedent). */
export function probeArmPromptHash(): string {
  return crypto
    .createHash('sha256')
    .update(probeArmPrompt({ question: '', adapterBlock: 'block' }), 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

// ── Blind judge ─────────────────────────────────────────────────────────────

export interface BlindJudgeVerdict {
  prefer: 'A' | 'B' | 'tie';
  perNote: Array<{ note: string; pick: 'A' | 'B' | 'tie' }>;
  reasoning: string;
}

export function blindJudgePrompt(input: {
  question: string;
  expectNotes: string[];
  replyA: string;
  replyB: string;
}): string {
  const notes = input.expectNotes.map((note) => `- ${note}`).join('\n');
  return [
    'You are a blind judge comparing two anonymous assistant replies to the',
    'same question. Reply A and Reply B come from two configurations you know',
    'nothing about; judge only what the texts themselves show.',
    `Blind judge prompt version: ${BLIND_JUDGE_PROMPT_VERSION}`,
    '',
    'Rules:',
    '- Length is not quality: a longer reply is not a better reply by default.',
    '- Check each behavioural note below against BOTH replies before judging.',
    '- "tie" is a legal answer; prefer it over a coin-flip preference.',
    '',
    `Question:\n${input.question}`,
    '',
    `Behavioural notes:\n${notes}`,
    '',
    `Reply A:\n${input.replyA}`,
    '',
    `Reply B:\n${input.replyB}`,
    '',
    'Respond with ONLY a single JSON object, no other text:',
    '{',
    '  "prefer": <A|B|tie>,',
    '  "per_note": [ {"note": "<one of the notes above>", "pick": <A|B|tie>} ],',
    '  "reasoning": "<one short sentence in Chinese>"',
    '}',
  ].join('\n');
}

/** Stable fingerprint of the judge template identity. */
export function blindJudgePromptHash(): string {
  return crypto
    .createHash('sha256')
    .update(
      blindJudgePrompt({
        question: '',
        expectNotes: [],
        replyA: '',
        replyB: '',
      }),
      'utf-8',
    )
    .digest('hex')
    .slice(0, 16);
}

function extractJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Parse a blind-judge reply; null when no structured verdict is recoverable. */
export function parseBlindJudge(raw: string): BlindJudgeVerdict | null {
  const parsed = extractJsonObject(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') return null;
  if (
    parsed.prefer !== 'A' &&
    parsed.prefer !== 'B' &&
    parsed.prefer !== 'tie'
  ) {
    return null;
  }
  const rawNotes = Array.isArray(parsed.per_note) ? parsed.per_note : [];
  const perNote: BlindJudgeVerdict['perNote'] = [];
  for (const item of rawNotes) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    const note = typeof row.note === 'string' ? row.note.trim() : '';
    if (!note) return null;
    if (row.pick !== 'A' && row.pick !== 'B' && row.pick !== 'tie') {
      return null;
    }
    perNote.push({ note, pick: row.pick });
  }
  const reasoning =
    typeof parsed.reasoning === 'string'
      ? parsed.reasoning.trim().slice(0, 500)
      : '';
  return { prefer: parsed.prefer, perNote, reasoning };
}

/** Swap A↔B across a whole verdict (both judges of one round are stored as-presented). */
export function swapLabels(verdict: BlindJudgeVerdict): BlindJudgeVerdict {
  const swap = (pick: 'A' | 'B' | 'tie'): 'A' | 'B' | 'tie' =>
    pick === 'A' ? 'B' : pick === 'B' ? 'A' : 'tie';
  return {
    prefer: swap(verdict.prefer),
    perNote: verdict.perNote.map((item) => ({
      note: item.note,
      pick: swap(item.pick),
    })),
    reasoning: verdict.reasoning,
  };
}

// ── Round assembly + gate aggregation ───────────────────────────────────────

type Arm = 'baseline' | 'proposed' | 'tie';

/**
 * Presentation labels → real arms. Direct presentation: A=baseline, B=proposed.
 * Swapped presentation: A=proposed, B=baseline.
 */
function pickToArm(pick: 'A' | 'B' | 'tie', swapped: boolean): Arm {
  if (pick === 'tie') return 'tie';
  const aIsBaseline = !swapped;
  if (pick === 'A') return aIsBaseline ? 'baseline' : 'proposed';
  return aIsBaseline ? 'proposed' : 'baseline';
}

/** Round winner from both judges; disagreement or double-tie ⇒ tie (plan §1-3). */
function roundWinner(round: HarnessProbeRound): Arm {
  const direct = round.judgeDirect
    ? pickToArm(round.judgeDirect.prefer, false)
    : 'tie';
  const swapped = round.judgeSwapped
    ? pickToArm(round.judgeSwapped.prefer, true)
    : 'tie';
  if (direct === swapped && direct !== 'tie') return direct;
  return 'tie';
}

/**
 * Assemble one stored round: both verdicts kept as-presented (audit-friendly)
 * plus the noteHits projection — a note hits an arm only when BOTH judges
 * (after swap mapping) assign it to the same non-tie arm.
 */
export function resolveRound(input: {
  queryId: string;
  baselineText: string;
  proposedText: string;
  judgeDirect: BlindJudgeVerdict | null;
  judgeSwapped: BlindJudgeVerdict | null;
  expectNotes: string[];
}): HarnessProbeRound {
  const findPick = (
    judge: BlindJudgeVerdict | null,
    note: string,
  ): 'A' | 'B' | 'tie' =>
    judge?.perNote.find((item) => item.note === note)?.pick ?? 'tie';
  const noteHits = input.expectNotes.map((note) => {
    const direct = pickToArm(findPick(input.judgeDirect, note), false);
    const swapped = pickToArm(findPick(input.judgeSwapped, note), true);
    if (direct === swapped && direct !== 'tie') {
      return { note, arm: direct };
    }
    return { note, arm: 'tie' as const };
  });
  return {
    queryId: input.queryId,
    baselineText: input.baselineText,
    proposedText: input.proposedText,
    judgeDirect: input.judgeDirect,
    judgeSwapped: input.judgeSwapped,
    noteHits,
  };
}

export interface ProbeAggregate {
  verdict: HarnessProbeVerdict;
  /** Rounds the proposed arm won (both judges agreed). */
  roundsWon: number;
  roundsLost: number;
  roundsTied: number;
  notesBaselineHit: number;
  notesProposedHit: number;
}

/**
 * Gate aggregation (plan §1-4): ADOPT needs ① roundsWon > roundsLost AND
 * ② notesProposedHit >= notesBaselineHit. Baseline clearly winning →
 * KEEP_BASE; no vote difference at all (all ties / every judge failed /
 * empty) → INCONCLUSIVE — an undetectable difference is reported honestly,
 * never as a base win.
 */
export function aggregateVerdict(rounds: HarnessProbeRound[]): ProbeAggregate {
  let roundsWon = 0;
  let roundsLost = 0;
  let roundsTied = 0;
  let notesBaselineHit = 0;
  let notesProposedHit = 0;
  for (const round of rounds) {
    const winner = roundWinner(round);
    if (winner === 'proposed') roundsWon += 1;
    else if (winner === 'baseline') roundsLost += 1;
    else roundsTied += 1;
    for (const hit of round.noteHits) {
      if (hit.arm === 'proposed') notesProposedHit += 1;
      else if (hit.arm === 'baseline') notesBaselineHit += 1;
    }
  }
  let verdict: HarnessProbeVerdict;
  if (roundsWon > roundsLost) {
    verdict = notesProposedHit >= notesBaselineHit ? 'adopt' : 'keep_base';
  } else if (roundsWon < roundsLost) {
    verdict = 'keep_base';
  } else {
    verdict = 'inconclusive';
  }
  return {
    verdict,
    roundsWon,
    roundsLost,
    roundsTied,
    notesBaselineHit,
    notesProposedHit,
  };
}

/** Storage-side verdict shape re-exported for CLI/route consumers. */
export type { HarnessBlindJudge };
