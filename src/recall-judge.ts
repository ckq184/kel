import crypto from 'node:crypto';

import { logger } from './logger.js';
import {
  getObservabilityConfig,
  type ObservabilityConfig,
} from './observability-config.js';
import { getAutoMemoryHostConfig } from './auto-memory-config.js';
import { getDefaultEvalStore, type EvalStore } from './eval-store.js';

/**
 * recall_utilized judge (task AB, batch 5).
 *
 * Batch-scores finished, recall-injected turns (`listPendingJudgeTurns`: the
 * single hardcoded rule — Langfuse's EvaluationRule engine reduced to one
 * predicate) with a structured glm-flash verdict. Every verdict row carries
 * the judge prompt hash + model so results stay attributable when the prompt
 * or model evolves (the Version lesson from the Langfuse source analysis).
 *
 * Fail-closed circuit breaker: 5 consecutive failures stop all judging with
 * one warn (EvaluatorBlockReason lesson). Recovery is a process restart or
 * any observability config change — no background self-healing, because a
 * judge that keeps failing usually means the endpoint is wrong.
 *
 * No self-referential loop is possible BY CONSTRUCTION (the langfuse
 * environment-marker lesson for free): the judge 直调 the OpenAI-compatible
 * LLM endpoint and never travels through a conversation channel, so its own
 * calls can never become observed turns.
 */

export const JUDGE_PROMPT_VERSION = 'recall-utilized-v1';
/** langfuse EvaluatorBlockReason lesson: fail-closed after N consecutive failures. */
export const JUDGE_CONSECUTIVE_FAILURE_BREAK = 5;
const DEFAULT_BATCH_SIZE = 20;

// ── Pure helpers ────────────────────────────────────────────────────────────

export function judgePrompt(input: {
  userMessage: string;
  assistantAnswer: string;
  recalledCount: number | null;
}): string {
  return [
    'You are evaluating whether an assistant answer utilized auto-recalled historical memory.',
    `Judge prompt version: ${JUDGE_PROMPT_VERSION}`,
    '',
    `User message:\n${input.userMessage}`,
    '',
    `Assistant answer:\n${input.assistantAnswer}`,
    '',
    `Number of memory entries recalled into the turn context: ${input.recalledCount ?? 'unknown'}`,
    '',
    'Question: does the assistant answer demonstrably rely on the recalled historical memory',
    '(cites a recalled fact, continues from it, or would clearly differ without it)?',
    'Base this ONLY on the two texts above; do not guess.',
    '',
    'Respond with ONLY a single JSON object, no other text:',
    '{"used": <true|false>, "reasoning": "<one short sentence in Chinese>"}',
  ].join('\n');
}

/** Stable version fingerprint: prompt template identity, not per-turn content. */
export function judgePromptHash(): string {
  return crypto
    .createHash('sha256')
    .update(
      judgePrompt({
        userMessage: '',
        assistantAnswer: '',
        recalledCount: null,
      }),
    )
    .digest('hex')
    .slice(0, 16);
}

/** Parse the model's verdict; null when no structured verdict is recoverable. */
export function parseJudgeResponse(
  raw: string,
): { used: boolean; reasoning: string } | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [
    fenced?.[1],
    raw,
    raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as {
        used?: unknown;
        reasoning?: unknown;
      };
      if (typeof parsed.used !== 'boolean') continue;
      const reasoning =
        typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
          ? parsed.reasoning.trim().slice(0, 500)
          : '';
      return { used: parsed.used, reasoning };
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/**
 * Deterministic sampling hook (langfuse lesson): v1 judges everything
 * (rate=1); the hash keeps any future sampling reproducible per turn id.
 */
export function sampleByTurnId(turnId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const hash = crypto.createHash('sha256').update(turnId).digest();
  return hash.readUInt32BE(0) / 0xffff_ffff < rate;
}

// ── LLM client (direct endpoint calls — never a conversation channel) ───────

export interface JudgeLlmClient {
  model: string;
  complete(prompt: string): Promise<string>;
}

export function createJudgeLlmClient(endpoint: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): JudgeLlmClient {
  return {
    model: endpoint.model,
    async complete(prompt: string): Promise<string> {
      const response = await fetch(
        `${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${endpoint.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: endpoint.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`judge endpoint HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('judge endpoint returned no message content');
      }
      return content;
    },
  };
}

// ── Judge ───────────────────────────────────────────────────────────────────

export interface JudgeRunReport {
  judged: number;
  failed: number;
  skipped: number;
  circuitOpen: boolean;
}

export interface RecallJudgeOptions {
  getStore?: () => Pick<EvalStore, 'listPendingJudgeTurns' | 'updateTurn'>;
  getConfig?: () => ObservabilityConfig;
  getClient?: () => JudgeLlmClient | null;
  failureThreshold?: number;
  batchSize?: number;
  /** Deterministic sampling rate; v1 keeps 1 (judge everything). */
  sampleRate?: number;
}

function configFingerprint(config: ObservabilityConfig): string {
  return JSON.stringify({
    enabled: config.enabled,
    contentMode: config.contentMode,
    judge: config.judge,
  });
}

export class RecallJudge {
  private readonly getStore: () => Pick<
    EvalStore,
    'listPendingJudgeTurns' | 'updateTurn'
  >;
  private readonly getConfig: () => ObservabilityConfig;
  private readonly getClient: () => JudgeLlmClient | null;
  private readonly failureThreshold: number;
  private readonly batchSize: number;
  private readonly sampleRate: number;
  private consecutiveFailures = 0;
  private circuitOpen = false;
  private circuitConfigFingerprint: string | null = null;

  constructor(options: RecallJudgeOptions = {}) {
    this.getStore = options.getStore ?? getDefaultEvalStore;
    this.getConfig = options.getConfig ?? getObservabilityConfig;
    // Default client: the auto-memory llm endpoint (glm-flash). Unavailable
    // endpoints keep the judge idle without touching the circuit.
    this.getClient =
      options.getClient ??
      (() =>
        getAutoMemoryHostConfig().llm
          ? createJudgeLlmClient(getAutoMemoryHostConfig().llm!)
          : null);
    this.failureThreshold =
      options.failureThreshold ?? JUDGE_CONSECUTIVE_FAILURE_BREAK;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.sampleRate = options.sampleRate ?? 1;
  }

  /** Judge one batch of pending turns. Never throws. */
  async runOnce(): Promise<JudgeRunReport> {
    const report: JudgeRunReport = {
      judged: 0,
      failed: 0,
      skipped: 0,
      circuitOpen: false,
    };
    try {
      const config = this.getConfig();
      if (!config.enabled || !config.judge.enabled) return report;

      // Config changes are the documented circuit reset (short of restart).
      if (
        this.circuitOpen &&
        this.circuitConfigFingerprint !== null &&
        this.circuitConfigFingerprint !== configFingerprint(config)
      ) {
        this.circuitOpen = false;
        this.consecutiveFailures = 0;
        this.circuitConfigFingerprint = null;
        logger.info(
          'Recall judge circuit reset by observability config change',
        );
      }
      if (this.circuitOpen) {
        report.circuitOpen = true;
        return report;
      }

      const client = this.getClient();
      if (!client) {
        report.skipped = 0;
        return report;
      }

      const pending = this.getStore().listPendingJudgeTurns(this.batchSize);
      for (const turn of pending) {
        if (
          !turn.inputText ||
          !turn.outputText ||
          !sampleByTurnId(turn.turnId, this.sampleRate)
        ) {
          // Metadata-mode turns carry no text: nothing to judge, leave the
          // row pending forever rather than inventing a verdict.
          report.skipped += 1;
          continue;
        }
        try {
          const raw = await client.complete(
            judgePrompt({
              userMessage: turn.inputText,
              assistantAnswer: turn.outputText,
              recalledCount: turn.recallHitCount,
            }),
          );
          const verdict = parseJudgeResponse(raw);
          if (!verdict) {
            this.getStore().updateTurn(turn.turnId, {
              judgeError: 'parse: model returned no structured verdict',
            });
            this.consecutiveFailures += 1;
            report.failed += 1;
          } else {
            this.getStore().updateTurn(turn.turnId, {
              judgeUsed: verdict.used ? 1 : 0,
              judgeReasoning: verdict.reasoning,
              judgeError: null,
              judgePromptHash: judgePromptHash(),
              judgeModel: client.model,
            });
            this.consecutiveFailures = 0;
            report.judged += 1;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.getStore().updateTurn(turn.turnId, {
            judgeError: message.slice(0, 300),
          });
          this.consecutiveFailures += 1;
          report.failed += 1;
        }
        if (this.consecutiveFailures >= this.failureThreshold) {
          this.circuitOpen = true;
          this.circuitConfigFingerprint = configFingerprint(config);
          logger.warn(
            {
              failureThreshold: this.failureThreshold,
              judgeModel: client.model,
            },
            'Recall judge circuit OPEN after consecutive failures (warn-once; reset by restart or observability config change)',
          );
          report.circuitOpen = true;
          break;
        }
      }
    } catch (error) {
      logger.warn(
        { err: error },
        'Recall judge runOnce failed at the boundary (observation only)',
      );
    }
    return report;
  }
}

/** Process singleton. */
export const recallJudge = new RecallJudge();

// ── Scheduler wiring ────────────────────────────────────────────────────────

const JUDGE_INTERVAL_MS = 60_000;

let judgeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the periodic judge loop (host startup). Each tick re-reads the
 * observability config, so flipping judge.enabled never needs a restart.
 */
export function startRecallJudgeScheduler(): void {
  if (judgeTimer) return;
  judgeTimer = setInterval(() => {
    void recallJudge.runOnce();
  }, JUDGE_INTERVAL_MS);
  judgeTimer.unref?.();
}

/** Test hook. */
export function stopRecallJudgeScheduler(): void {
  if (judgeTimer) {
    clearInterval(judgeTimer);
    judgeTimer = null;
  }
}
