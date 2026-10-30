import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Tool approval policy — host side.
 *
 * The effective policy is computed once per process and attached to every
 * ContainerInput; the runner's approval gate extension enforces it for all
 * tool calls. Resolution order:
 *
 *   1. CKQCLAW_APPROVAL_POLICY env var (JSON object)
 *   2. data/config/approval-policy.json
 *   3. Built-in default: irreversible outbound actions require approval.
 *
 * This is deliberately not part of the Web-editable system settings yet:
 * policy is a security control and ships fail-closed defaults. Editing the
 * JSON file and restarting the backend re-computes it for new runners.
 * Warm runners keep the policy they were started with until recycled.
 */

export type ApprovalAction = 'allow' | 'ask' | 'deny';

export interface ShellPolicyConfig {
  mode?: 'off' | 'audit' | 'enforce';
  redAction?: 'ask' | 'deny';
}

export interface ApprovalPolicyConfig {
  default?: ApprovalAction;
  /** Exact tool name, or prefix match when the key ends with `*`. */
  tools?: Record<string, ApprovalAction>;
  /** How long an `ask` waits for the user before denying (ms). */
  timeoutMs?: number;
  /** Shell command classifier behaviour for native bash calls. */
  shell?: ShellPolicyConfig;
  /** Repetition brake for stuck turns. */
  loopGuard?: {
    disabled?: boolean;
    maxIdenticalCalls?: number;
    windowSize?: number;
    allowedTools?: string[];
  };
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicyConfig = {
  default: 'allow',
  tools: {
    // Irreversible outbound actions must not run without the user seeing them.
    send_file: 'ask',
    send_image: 'ask',
    edit_message: 'ask',
    recall_message: 'ask',
    api_request: 'ask',
    install_skill: 'ask',
    // Browser tools (playwright-mcp): read-only navigation/snapshot stays
    // allow; anything that pushes local data or executes page-context code
    // requires approval. Name-level granularity only — new-domain navigation
    // detection needs arg-aware policy (documented limitation).
    browser_evaluate: 'ask',
    browser_upload_file: 'ask',
    browser_fill_form: 'ask',
    // agent-browser (native CLI + MCP): agent_browser_eval/fill mirror
    // browser_evaluate/fill_form; js/new_tab are the bare names the red-team
    // run drove through browser-use heredocs (TASK-D §6.1) — listed
    // fail-closed. Bare keys also gate mcp__agent-browser__* ids via the
    // runner's bare-name fallback.
    js: 'ask',
    new_tab: 'ask',
    agent_browser_eval: 'ask',
    agent_browser_fill: 'ask',
  },
  timeoutMs: 5 * 60_000,
  // Shell red lines (rm -rf /, credential tampering, exfiltration, curl|sh,
  // persistence) suspend for user approval; yellow lines (sudo, docker,
  // global installs) run and are audit-logged by the runner.
  shell: { mode: 'enforce', redAction: 'ask' },
  // Repetition brake: the 3rd identical (tool+args) call in a 12-call window
  // is blocked with a reflection demand; any further identical call ends the
  // turn so the host reports honestly instead of burning budget.
  loopGuard: { maxIdenticalCalls: 3, windowSize: 12 },
};

const CONFIG_FILE = path.join(DATA_DIR, 'config', 'approval-policy.json');

function isAction(value: unknown): value is ApprovalAction {
  return value === 'allow' || value === 'ask' || value === 'deny';
}

function sanitizePolicy(raw: unknown): ApprovalPolicyConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const policy: ApprovalPolicyConfig = {};
  if (isAction(input.default)) policy.default = input.default;
  if (
    input.tools &&
    typeof input.tools === 'object' &&
    !Array.isArray(input.tools)
  ) {
    policy.tools = {};
    for (const [key, value] of Object.entries(
      input.tools as Record<string, unknown>,
    )) {
      if (typeof key === 'string' && key.length > 0 && isAction(value)) {
        policy.tools[key] = value;
      }
    }
  }
  if (
    typeof input.timeoutMs === 'number' &&
    Number.isFinite(input.timeoutMs) &&
    input.timeoutMs >= 5_000 &&
    input.timeoutMs <= 24 * 60 * 60_000
  ) {
    policy.timeoutMs = Math.floor(input.timeoutMs);
  }
  if (
    input.shell &&
    typeof input.shell === 'object' &&
    !Array.isArray(input.shell)
  ) {
    const rawShell = input.shell as Record<string, unknown>;
    const shell: ShellPolicyConfig = {};
    if (
      rawShell.mode === 'off' ||
      rawShell.mode === 'audit' ||
      rawShell.mode === 'enforce'
    ) {
      shell.mode = rawShell.mode;
    }
    if (rawShell.redAction === 'ask' || rawShell.redAction === 'deny') {
      shell.redAction = rawShell.redAction;
    }
    if (shell.mode !== undefined || shell.redAction !== undefined) {
      policy.shell = shell;
    }
  }
  if (
    input.loopGuard &&
    typeof input.loopGuard === 'object' &&
    !Array.isArray(input.loopGuard)
  ) {
    const rawGuard = input.loopGuard as Record<string, unknown>;
    const loopGuard: NonNullable<ApprovalPolicyConfig['loopGuard']> = {};
    if (typeof rawGuard.disabled === 'boolean') {
      loopGuard.disabled = rawGuard.disabled;
    }
    if (
      typeof rawGuard.maxIdenticalCalls === 'number' &&
      Number.isFinite(rawGuard.maxIdenticalCalls) &&
      rawGuard.maxIdenticalCalls >= 2 &&
      rawGuard.maxIdenticalCalls <= 100
    ) {
      loopGuard.maxIdenticalCalls = Math.floor(rawGuard.maxIdenticalCalls);
    }
    if (
      typeof rawGuard.windowSize === 'number' &&
      Number.isFinite(rawGuard.windowSize) &&
      rawGuard.windowSize >= 2 &&
      rawGuard.windowSize <= 500
    ) {
      loopGuard.windowSize = Math.floor(rawGuard.windowSize);
    }
    if (
      Array.isArray(rawGuard.allowedTools) &&
      rawGuard.allowedTools.every((name) => typeof name === 'string')
    ) {
      loopGuard.allowedTools = rawGuard.allowedTools as string[];
    }
    if (Object.keys(loopGuard).length > 0) {
      policy.loopGuard = loopGuard;
    }
  }
  return policy;
}

let cached: { policy: ApprovalPolicyConfig; loadedAt: number } | null = null;

export function getEffectiveApprovalPolicy(): ApprovalPolicyConfig {
  if (cached && Date.now() - cached.loadedAt < 30_000) return cached.policy;

  let policy: ApprovalPolicyConfig = DEFAULT_APPROVAL_POLICY;
  const envRaw = process.env.CKQCLAW_APPROVAL_POLICY;
  if (envRaw) {
    try {
      policy = sanitizePolicy(JSON.parse(envRaw)) ?? DEFAULT_APPROVAL_POLICY;
    } catch (error) {
      logger.warn(
        { err: error },
        'CKQCLAW_APPROVAL_POLICY is not valid JSON — using default approval policy',
      );
    }
  } else {
    try {
      const fileRaw = fs.readFileSync(CONFIG_FILE, 'utf8');
      policy = sanitizePolicy(JSON.parse(fileRaw)) ?? DEFAULT_APPROVAL_POLICY;
    } catch {
      // No file (or unreadable) — built-in default applies.
    }
  }
  cached = { policy, loadedAt: Date.now() };
  return policy;
}

/** Test hook: drop the cache so the next lookup re-reads env/file. */
export function resetApprovalPolicyCache(): void {
  cached = null;
}
