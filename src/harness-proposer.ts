import crypto from 'node:crypto';

/**
 * Harness adapter proposer (task AE, RSI Phase 1) — pure functions only.
 *
 * Transplants the harness² propose discipline onto CKQClaw:
 *  - evidence is trajectory-shaped and leak-free BY CONSTRUCTION
 *    (`sanitizeObsTurn` whitelists fields; judge internals never leave
 *    eval.db into a prompt);
 *  - divergence between similar turns outranks uniform failure;
 *  - every edit must cite a concrete turn id, or the proposal is invalid;
 *  - KEEP_BASE ("change nothing") is a legal, encouraged answer;
 *  - lessons distil with cue/lesson/evidence all mandatory — anything less
 *    is dropped (宁缺毋滥), mirroring harness²'s library admission rule.
 *
 * The LLM client is recall-judge's `createJudgeLlmClient` (same endpoint
 * family, same fail-closed posture); callers inject it, keeping this module
 * deterministic and unit-testable.
 */

export const PROPOSER_PROMPT_VERSION = 'harness-propose-v1';
export const REFLECT_PROMPT_VERSION = 'harness-reflect-v1';

/** Excerpt cap for turn text embedded in prompts and stored evidence. */
export const EXCERPT_MAX_CHARS = 200;

// ── Leak-free evidence turns ────────────────────────────────────────────────

export interface EvidenceTurn {
  turnId: string;
  inputText: string;
  outputText: string;
  channel: string;
  createdAt: string;
}

/**
 * Whitelist projection of an obs_turns record (ObsTurnRecord shape):
 * judge_* fields, cost, and every other scoring artifact are structurally
 * unreachable from here.
 */
export function sanitizeObsTurn(row: {
  turnId?: string | null;
  inputText?: string | null;
  outputText?: string | null;
  channel?: string | null;
  createdAt?: string | null;
}): EvidenceTurn {
  return {
    turnId: row.turnId ?? '',
    inputText: row.inputText ?? '',
    outputText: row.outputText ?? '',
    channel: row.channel ?? '',
    createdAt: row.createdAt ?? '',
  };
}

export interface EvidenceLesson {
  cue: string;
  lesson: string;
  evidence: string;
  confidence: string | null;
}

function excerpt(text: string): string {
  return text.length > EXCERPT_MAX_CHARS
    ? `${text.slice(0, EXCERPT_MAX_CHARS)}…`
    : text;
}

// ── Lexical matching helpers (task AH, RSI Phase 3) ─────────────────────────
//
// Runtime deps are frozen and neither evolve nor probe touches an embedder, so
// cross-workspace transfer rides on plain lexical overlap: CJK text as 2-grams
// (single-char runs stay single tokens), latin text as whole words.

/** Inline tokenizer shared by neighbor-lesson matching and clustering. */
function tokenizeForMatch(text: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = text.toLowerCase();
  for (const match of normalized.match(/[a-z0-9]+/g) ?? []) {
    if (match.length >= 2) tokens.add(`w:${match}`);
  }
  for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.add(`c:${run}`);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) {
      tokens.add(`c:${run.slice(i, i + 2)}`);
    }
  }
  return tokens;
}

export interface NeighborLessonCandidate {
  workspaceJid: string;
  cue: string;
  lesson: string;
  evidence: string;
  confidence: string | null;
}

export interface NeighborLessonPick extends NeighborLessonCandidate {
  /** How many cue tokens the recent turn texts contain (raw overlap). */
  score: number;
}

/**
 * hermit's transferability sell, lexical edition: lessons distilled in OTHER
 * workspaces can seed this workspace's proposal — ranked by cue/turn token
 * overlap, top-N, self-workspace rows excluded (they are already injected).
 * Heuristic signal only; the proposer prompt carries the caution disclaimer.
 */
export function pickNeighborLessons(input: {
  selfJid: string;
  selfTurnTexts: string[];
  allLessons: NeighborLessonCandidate[];
  limit?: number;
}): NeighborLessonPick[] {
  const limit = Math.max(1, input.limit ?? 3);
  const turnTokens = new Set<string>();
  for (const text of input.selfTurnTexts) {
    for (const token of tokenizeForMatch(text)) turnTokens.add(token);
  }
  if (turnTokens.size === 0) return [];
  const scored: NeighborLessonPick[] = [];
  for (const lesson of input.allLessons) {
    if (lesson.workspaceJid === input.selfJid) continue;
    let score = 0;
    for (const token of tokenizeForMatch(lesson.cue)) {
      if (turnTokens.has(token)) score++;
    }
    if (score > 0) {
      scored.push({
        workspaceJid: lesson.workspaceJid,
        cue: lesson.cue,
        lesson: lesson.lesson,
        evidence: lesson.evidence,
        confidence: lesson.confidence,
        score,
      });
    }
  }
  // Stable sort: equal scores keep pool order (newest lessons first from the
  // store query), so the pick is deterministic run-to-run.
  return scored
    .map((pick, index) => ({ pick, index }))
    .sort((a, b) => b.pick.score - a.pick.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.pick);
}

// ── Evidence clustering (task AH, RSI Phase 3) ──────────────────────────────

export interface TurnCluster {
  clusterId: string;
  turns: EvidenceTurn[];
  /** 0-1 input diversity inside the cluster; 0 = singleton/identical inputs. */
  inputVariance: number;
}

const CLUSTER_WINDOW_MS = 30 * 60 * 1000;
/** Common-token ratio (公共词占比) at which two inputs join one cluster. */
const CLUSTER_MERGE_THRESHOLD = 0.5;

/** Common-token ratio: shared tokens over the smaller token set (0 when empty). */
function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const token of small) if (large.has(token)) shared++;
  return shared / small.size;
}

/**
 * Pre-computed divergence layout for the evidence tree (task AH §1-3):
 * sessions = same channel + ≤30-minute gaps; inside a session, inputs merge
 * when their common-token ratio reaches the threshold (single linkage). The
 * output covers every input turn exactly once, time-ascending, and each
 * cluster carries an input-variance label the proposer can read off. Heuristic
 * presentation only — never a gate.
 */
export function clusterTurns(turns: EvidenceTurn[]): TurnCluster[] {
  const ordered = turns
    .map((turn, index) => ({
      turn,
      index,
      at: Date.parse(turn.createdAt),
    }))
    .sort(
      (a, b) =>
        (Number.isNaN(a.at) ? 0 : a.at) - (Number.isNaN(b.at) ? 0 : b.at) ||
        a.index - b.index,
    )
    .map((entry) => entry.turn);

  const sessions: EvidenceTurn[][] = [];
  for (const turn of ordered) {
    const session = sessions[sessions.length - 1];
    const prev = session?.[session.length - 1];
    const gapOk =
      prev !== undefined &&
      prev.channel === turn.channel &&
      Date.parse(turn.createdAt) - Date.parse(prev.createdAt) <=
        CLUSTER_WINDOW_MS;
    if (gapOk) {
      session.push(turn);
    } else {
      sessions.push([turn]);
    }
  }

  const clusters: TurnCluster[] = [];
  for (const session of sessions) {
    // Sub-clusters inside one session: input-similarity merge, single linkage.
    const groups: Array<{ turns: EvidenceTurn[]; tokenSets: Set<string>[] }> =
      [];
    for (const turn of session) {
      const tokens = tokenizeForMatch(turn.inputText);
      let target = -1;
      for (let g = 0; g < groups.length; g++) {
        const linked = groups[g].tokenSets.some(
          (set) => overlapRatio(set, tokens) >= CLUSTER_MERGE_THRESHOLD,
        );
        if (linked) {
          target = g;
          break;
        }
      }
      if (target === -1) {
        groups.push({ turns: [turn], tokenSets: [tokens] });
      } else {
        groups[target].turns.push(turn);
        groups[target].tokenSets.push(tokens);
      }
    }
    for (const group of groups) {
      let variance = 0;
      if (group.turns.length > 1) {
        let total = 0;
        let pairs = 0;
        for (let i = 0; i < group.tokenSets.length; i++) {
          for (let j = i + 1; j < group.tokenSets.length; j++) {
            total += overlapRatio(group.tokenSets[i], group.tokenSets[j]);
            pairs++;
          }
        }
        variance = pairs > 0 ? 1 - total / pairs : 0;
      }
      clusters.push({
        clusterId: `c${clusters.length + 1}`,
        turns: group.turns,
        inputVariance: Math.min(Math.max(variance, 0), 1),
      });
    }
  }
  return clusters;
}

// ── Evidence assembly ───────────────────────────────────────────────────────

export function buildEvidence(input: {
  workspaceJid: string;
  turns: EvidenceTurn[];
  currentAdapterMd: string | null;
  lessons: EvidenceLesson[];
  /**
   * Task AH: pre-computed cluster layout (clusterTurns). When present the
   * turns render grouped with an input-variance label; absent = legacy flat
   * list (byte-identical to the pre-AH output).
   */
  clusters?: TurnCluster[];
  /**
   * Task AH: lessons transferred from other workspaces (pickNeighborLessons).
   * An empty list renders nothing — same shape as the legacy call.
   */
  neighborLessons?: NeighborLessonPick[];
}): string {
  const lines: string[] = [];
  lines.push(`# Evidence for workspace ${input.workspaceJid}`);
  lines.push('');
  lines.push('## Current adapter (baseline harness)');
  if (input.currentAdapterMd && input.currentAdapterMd.trim()) {
    lines.push('```markdown');
    lines.push(input.currentAdapterMd.trim());
    lines.push('```');
  } else {
    lines.push(
      '(no adapter yet — the baseline harness is the platform prompt alone)',
    );
  }
  lines.push('');
  lines.push('## Lessons from earlier adoptions');
  if (input.lessons.length === 0) {
    lines.push('(none recorded yet)');
  } else {
    for (const lesson of input.lessons) {
      lines.push(
        `- cue: ${lesson.cue} | lesson: ${lesson.lesson} | evidence: ${lesson.evidence}` +
          (lesson.confidence ? ` | confidence: ${lesson.confidence}` : ''),
      );
    }
  }
  lines.push('');
  if (input.neighborLessons && input.neighborLessons.length > 0) {
    lines.push('## Neighbor lessons from other workspaces (reference only)');
    lines.push(
      'These lessons were distilled in OTHER workspaces. They are reference',
    );
    lines.push(
      'experience that may not transfer to this one — cite with caution.',
    );
    for (const neighbor of input.neighborLessons) {
      lines.push(
        `- from ${neighbor.workspaceJid} | cue: ${neighbor.cue} | lesson: ${neighbor.lesson}` +
          ` | evidence: ${neighbor.evidence}` +
          (neighbor.confidence ? ` | confidence: ${neighbor.confidence}` : ''),
      );
    }
    lines.push('');
  }
  lines.push('## Recent turns (trajectory evidence)');
  const clusters = input.clusters;
  if (clusters && clusters.length > 0) {
    for (const cluster of clusters) {
      lines.push(
        `### cluster ${cluster.clusterId} — ${cluster.turns.length} turn(s) · ` +
          `channel ${cluster.turns[0]?.channel || 'unknown'} · ` +
          `input variance ${cluster.inputVariance.toFixed(2)}`,
      );
      for (const turn of cluster.turns) {
        lines.push(`### turn_id: ${turn.turnId || '(unknown)'}`);
        lines.push(
          `- channel: ${turn.channel || 'unknown'} | at: ${turn.createdAt || 'unknown'}`,
        );
        lines.push(`- input: ${excerpt(turn.inputText) || '(empty)'}`);
        lines.push(`- output: ${excerpt(turn.outputText) || '(empty)'}`);
        lines.push('');
      }
    }
  } else {
    for (const turn of input.turns) {
      lines.push(`### turn_id: ${turn.turnId || '(unknown)'}`);
      lines.push(
        `- channel: ${turn.channel || 'unknown'} | at: ${turn.createdAt || 'unknown'}`,
      );
      lines.push(`- input: ${excerpt(turn.inputText) || '(empty)'}`);
      lines.push(`- output: ${excerpt(turn.outputText) || '(empty)'}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ── Proposer prompt ─────────────────────────────────────────────────────────

export function proposerPrompt(evidence: string): string {
  return [
    'You are a harness editor: you refine a workspace-level harness adapter',
    '(a markdown instruction file injected into this workspace assistant).',
    `Proposer prompt version: ${PROPOSER_PROMPT_VERSION}`,
    '',
    'HOW TO DECIDE WHAT TO CHANGE:',
    '- Divergence first: when similar input turns produced divergent behavior,',
    '  the harness left the decision to luck — that is where an edit helps most.',
    '- Uniform failure second: the same mistake across every turn means a',
    '  standing instruction is missing.',
    '- An edit citing a single turn is weak evidence; say so in the rationale.',
    '- KEEP_BASE (change nothing) is a legal and encouraged answer when the',
    '  evidence does not clearly support a specific edit.',
    '- Every edit must be traceable to concrete turn id(s) below; edits you',
    '  cannot anchor to a turn_id are speculation and will be rejected.',
    '- The adapter instructs the ASSISTANT, never the evaluation: writing',
    '  anything about scoring, judges, rubrics, or grading is forbidden.',
    '',
    'Constraints on adapter_md:',
    '- A single markdown file; concise, imperative, workspace-specific;',
    '  at most ~16000 bytes; write it in the workspace primary language.',
    '',
    'Evidence (the only source you may cite):',
    '',
    evidence,
    '',
    'Respond with ONLY a single JSON object, no other text:',
    '{',
    '  "keep_base": <true|false>,',
    '  "adapter_md": "<full new adapter markdown; empty string when keep_base>",',
    '  "rationale": "<why, in 1-3 sentences, anchored to the evidence>",',
    '  "evidence": [',
    '    {"turn_id": "<id from evidence>", "input_excerpt": "<short quote>",',
    '     "output_excerpt": "<short quote>", "why": "<what this turn shows>"}',
    '  ]',
    '}',
  ].join('\n');
}

/** Stable fingerprint of the prompt template identity (not the evidence). */
export function proposerPromptHash(): string {
  return crypto
    .createHash('sha256')
    .update(proposerPrompt(''), 'utf-8')
    .digest('hex')
    .slice(0, 16);
}

// ── Proposer response parsing ───────────────────────────────────────────────

export interface ParsedEvidence {
  turnId: string;
  inputExcerpt: string;
  outputExcerpt: string;
  why: string;
}

export interface ParsedProposal {
  keepBase: boolean;
  adapterMd: string;
  rationale: string;
  evidence: ParsedEvidence[];
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

export function parseProposerResponse(raw: string): ParsedProposal | null {
  const parsed = extractJsonObject(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') return null;
  const keepBase = parsed.keep_base === true;
  const adapterMd =
    typeof parsed.adapter_md === 'string' ? parsed.adapter_md : '';
  const rationale =
    typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '';
  if (!rationale) return null;
  if (!keepBase && !adapterMd.trim()) return null;
  const rawEvidence = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  const evidence: ParsedEvidence[] = [];
  for (const item of rawEvidence) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    const turnId = typeof row.turn_id === 'string' ? row.turn_id.trim() : '';
    const why = typeof row.why === 'string' ? row.why.trim() : '';
    if (!turnId || !why) return null;
    evidence.push({
      turnId,
      inputExcerpt:
        typeof row.input_excerpt === 'string' ? excerpt(row.input_excerpt) : '',
      outputExcerpt:
        typeof row.output_excerpt === 'string'
          ? excerpt(row.output_excerpt)
          : '',
      why,
    });
  }
  if (!keepBase && evidence.length === 0) return null;
  return {
    keepBase,
    adapterMd: keepBase ? '' : adapterMd,
    rationale,
    evidence,
  };
}

// ── Reflect (lesson distillation on adoption) ───────────────────────────────

export function reflectPrompt(input: {
  adapterMd: string;
  rationale: string;
  turns: EvidenceTurn[];
}): string {
  const turnLines = input.turns
    .map(
      (turn) =>
        `- turn_id: ${turn.turnId} | input: ${excerpt(turn.inputText)} | output: ${excerpt(turn.outputText)}`,
    )
    .join('\n');
  return [
    'You are reflecting on an adopted harness adapter change to distil one',
    'transferable lesson (the harness² improvement-harness recursion).',
    `Reflect prompt version: ${REFLECT_PROMPT_VERSION}`,
    '',
    'Adopted adapter:',
    '```markdown',
    input.adapterMd.trim(),
    '```',
    '',
    `Adoption rationale: ${input.rationale}`,
    '',
    'Turns behind the adoption:',
    turnLines || '(none)',
    '',
    'Rules:',
    '- A lesson must name a situation shape (cue) and an actionable adapter',
    '  operation (lesson), both anchored in evidence.',
    '- Adoption alone never establishes that an edit helped; be conservative',
    '  with confidence.',
    '- If nothing generalizes beyond this single task, answer NO_ENTRY.',
    '',
    'Respond with ONLY a single JSON object, no other text:',
    '{',
    '  "cue": "<situation shape where this lesson applies>",',
    '  "lesson": "<actionable adapter operation>",',
    '  "evidence": "<which turns/edits support it>",',
    '  "confidence": "<high|medium|low or omit>"',
    '}',
    '—or— {"no_entry": true}',
  ].join('\n');
}

export interface ParsedLesson {
  cue: string;
  lesson: string;
  evidence: string;
  confidence: string | null;
}

export function parseReflectResponse(raw: string): ParsedLesson | null {
  const parsed = extractJsonObject(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.no_entry === true) return null;
  const cue = typeof parsed.cue === 'string' ? parsed.cue.trim() : '';
  const lesson = typeof parsed.lesson === 'string' ? parsed.lesson.trim() : '';
  const evidence =
    typeof parsed.evidence === 'string' ? parsed.evidence.trim() : '';
  if (!cue || !lesson || !evidence) return null;
  const confidence =
    typeof parsed.confidence === 'string' && parsed.confidence.trim()
      ? parsed.confidence.trim()
      : null;
  return { cue, lesson, evidence, confidence };
}

// ── Unified diff (display only; stored on the proposal row) ─────────────────

/**
 * Minimal line-level unified diff (LCS). Not a patch format — the Web detail
 * view renders it as an audit trail of what the proposal changes.
 */
export function buildUnifiedDiff(
  before: string | null,
  after: string,
  contextLabel = 'ADAPTER.md',
): string {
  const beforeLines = (before ?? '').split('\n');
  const afterLines = after.split('\n');
  // LCS table over the two line arrays.
  const table: number[][] = Array.from({ length: beforeLines.length + 1 }, () =>
    new Array<number>(afterLines.length + 1).fill(0),
  );
  for (let i = beforeLines.length - 1; i >= 0; i--) {
    for (let j = afterLines.length - 1; j >= 0; j--) {
      table[i][j] =
        beforeLines[i] === afterLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const lines: string[] = [
    `--- ${contextLabel} (current)`,
    `+++ ${contextLabel} (proposed)`,
  ];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      lines.push(`  ${beforeLines[i]}`);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push(`- ${beforeLines[i]}`);
      i++;
    } else {
      lines.push(`+ ${afterLines[j]}`);
      j++;
    }
  }
  while (i < beforeLines.length) lines.push(`- ${beforeLines[i++]}`);
  while (j < afterLines.length) lines.push(`+ ${afterLines[j++]}`);
  return lines.join('\n');
}
