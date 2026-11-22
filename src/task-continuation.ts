import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { TaskRunStatus } from './types.js';

/**
 * Long-task continuation — scheduler side.
 *
 * An isolated scheduled run whose Agent declares itself unfinished (runner
 * tool `task_request_continuation`) leaves a `continuation.json` in the run's
 * tasks-run IPC namespace. The scheduler records that request on the durable
 * run row and, once the run is terminal, decides between:
 *
 *   - `continue`     — spawn one follow-up run carrying the declared reason
 *                      and next step, with a bounded backoff and a per-chain
 *                      budget (`continuation_count < maxContinuations`);
 *   - `needs_human`  — budget exhausted; the run is escalated for a human
 *                      and the owner is notified through the normal result
 *                      delivery path;
 *   - `abandon`      — the request cannot be honored (run failed, task
 *                      paused/deleted); recorded so the sweep never retries;
 *   - `none`         — nothing pending.
 *
 * Continuation runs never advance the task definition cursor: they are extra
 * occurrences owned by the parent chain, so missed/backfill semantics stay
 * untouched.
 */

/** Fixed name inside the run's tasks-run IPC namespace; latest request wins. */
export const TASK_CONTINUATION_FILE = 'continuation.json';

const CONFIG_FILE = path.join(DATA_DIR, 'config', 'task-continuation.json');
const DEFAULT_MAX_CONTINUATIONS = 3;
const DEFAULT_BACKOFF_MS = 60_000;
const MAX_FIELD_CHARS = 4_000;

interface TaskContinuationRequest {
  reason: string;
  nextStep: string | null;
  turnId: string | null;
  at: string;
}

function cleanOptionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_FIELD_CHARS);
}

/** Parse the runner-written continuation request; corrupt files yield null. */
export function readContinuationRequest(
  runIpcDir: string,
): TaskContinuationRequest | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(runIpcDir, TASK_CONTINUATION_FILE), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const reason = cleanOptionalText(record.reason);
  if (!reason) return null;
  const nextStep = cleanOptionalText(record.nextStep);
  if (record.nextStep !== undefined && record.nextStep !== null && !nextStep) {
    return null;
  }
  const turnId = cleanOptionalText(record.turnId);
  if (record.turnId !== undefined && record.turnId !== null && !turnId) {
    return null;
  }
  const at =
    typeof record.at === 'string' && record.at.trim()
      ? record.at.trim()
      : new Date().toISOString();
  return { reason, nextStep, turnId, at };
}

type ContinuationOutcome = 'continue' | 'needs_human' | 'abandon' | 'none';

/**
 * Explicit state transition for one pending continuation request.
 *
 * Ordering is deliberate: a dead task or a non-success run can never
 * escalate or spawn work, and `none` keeps untouched rows out of the sweep.
 */
export function decideContinuationOutcome(input: {
  runStatus: TaskRunStatus | string;
  continuationState: string | null;
  continuationCount: number;
  maxContinuations: number;
  taskActive: boolean;
}): ContinuationOutcome {
  if (input.continuationState !== 'requested') return 'none';
  if (input.runStatus !== 'success') return 'abandon';
  if (!input.taskActive) return 'abandon';
  if (input.continuationCount >= input.maxContinuations) {
    return 'needs_human';
  }
  return 'continue';
}

interface TaskContinuationConfig {
  /** Per-chain cap on automatic continuation runs; 0 disables continuation. */
  maxContinuations: number;
  /** Delay before a queued continuation run becomes claimable. */
  backoffMs: number;
}

function sanitizeInt(
  value: unknown,
  min: number,
  max: number,
): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null;
  }
  if (value < min || value > max) return null;
  return value;
}

/**
 * Returns null when any supplied field is invalid (fail-closed to defaults
 * for that whole source), undefined when the field is absent.
 */
export function sanitizeTaskContinuationConfig(
  raw: unknown,
): TaskContinuationConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const maxContinuations = sanitizeInt(record.maxContinuations, 0, 10);
  const backoffMs = sanitizeInt(record.backoffMs, 0, 3_600_000);
  if (maxContinuations === null || backoffMs === null) return null;
  return {
    maxContinuations: maxContinuations ?? DEFAULT_MAX_CONTINUATIONS,
    backoffMs: backoffMs ?? DEFAULT_BACKOFF_MS,
  };
}

let cached: { config: TaskContinuationConfig; loadedAt: number } | null = null;

export function getTaskContinuationConfig(): TaskContinuationConfig {
  if (cached && Date.now() - cached.loadedAt < 30_000) return cached.config;

  let config: TaskContinuationConfig = {
    maxContinuations: DEFAULT_MAX_CONTINUATIONS,
    backoffMs: DEFAULT_BACKOFF_MS,
  };
  const envRaw = process.env.CKQCLAW_TASK_CONTINUATION;
  if (envRaw) {
    try {
      config = sanitizeTaskContinuationConfig(JSON.parse(envRaw)) ?? config;
    } catch (error) {
      logger.warn(
        { err: error },
        'CKQCLAW_TASK_CONTINUATION is not valid JSON — using default continuation config',
      );
    }
  } else {
    try {
      const fileRaw = fs.readFileSync(CONFIG_FILE, 'utf8');
      config = sanitizeTaskContinuationConfig(JSON.parse(fileRaw)) ?? config;
    } catch {
      // No file (or unreadable) — built-in default applies.
    }
  }
  cached = { config, loadedAt: Date.now() };
  return config;
}

/** Test hook: drop the cache so the next lookup re-reads env/file. */
export function resetTaskContinuationConfigCache(): void {
  cached = null;
}

/** Prompt framing for a continuation run; the original prompt stays last. */
export function buildContinuationPrompt(input: {
  basePrompt: string;
  reason: string;
  nextStep: string | null;
  count: number;
  maxContinuations: number;
}): string {
  const lines = [
    `[定时任务自动续跑] 这是定时任务的自动续跑（第 ${input.count}/${input.maxContinuations} 次续跑）。上一轮智能体已把本轮任务标记为未完成。`,
    `未完成原因：${input.reason}`,
  ];
  if (input.nextStep) {
    lines.push(`建议下一步：${input.nextStep}`);
  }
  lines.push(
    '请基于工作区中上一轮留下的文件与上下文继续完成任务。',
    '如果本轮结束时机仍不成熟，请在结束前再次调用 task_request_continuation（预算用尽后会转人工处理）；任务已完成时正常结束即可，不要再调用该工具。',
    '',
    '以下是原始任务指令：',
  );
  return `${lines.join('\n')}${input.basePrompt}`;
}

/** Owner-facing escalation notice when the continuation budget is exhausted. */
export function formatNeedsHumanNotice(input: {
  taskPrompt: string;
  runId: string;
  reason: string;
  nextStep: string | null;
  count: number;
  maxContinuations: number;
}): string {
  const firstLine =
    input.taskPrompt
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || '(无任务描述)';
  const displayName = firstLine.slice(0, 120);
  const lines = [
    '## ⏸️ 定时任务需要人工处理',
    '',
    `**任务**：${displayName}`,
    `**运行 ID**：\`${input.runId}\``,
    `**原因**：连续 ${input.count} 次自动续跑后仍未完成（上限 ${input.maxContinuations} 次）`,
    `**智能体说明**：${input.reason}`,
  ];
  if (input.nextStep) {
    lines.push(`**建议下一步**：${input.nextStep}`);
  }
  lines.push(
    '',
    '已停止自动续跑。请查看该任务的运行记录，补充信息或调整任务后可手动「立即运行」。',
  );
  return lines.join('\n');
}
