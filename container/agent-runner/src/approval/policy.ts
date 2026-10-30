import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Tool approval policy and the durable request/decision file protocol.
 *
 * The host computes the effective policy and ships it in ContainerInput;
 * the runner installs it here before sessions are created. The Pi approval
 * gate extension evaluates every tool call against it. `ask` actions suspend
 * the tool call while the extension writes an approval request under
 * `<ipcRoot>/approvals/pending/` and polls `<ipcRoot>/approvals/decisions/`
 * for the host-mediated decision. The IPC directory is shared between host
 * and runner (Docker mount or direct filesystem), so decisions survive
 * runner restarts and work across every channel the host serves.
 *
 * Fail-closed: missing decision, timeout, and aborted turns all deny.
 */

export type ApprovalAction = 'allow' | 'ask' | 'deny';

export interface ApprovalPolicy {
  /** Action for tools without an explicit entry. Defaults to 'allow'. */
  default?: ApprovalAction;
  /** Exact tool name, or prefix match when the key ends with `*`. */
  tools?: Record<string, ApprovalAction>;
  /** How long an `ask` waits for the user before defaulting to deny. */
  timeoutMs?: number;
  /** Shell command classifier behaviour for native bash calls. */
  shell?: {
    /** `off` disables classification; `audit` allows red lines but logs
     * them; `enforce` (default) triggers `redAction` on red-line matches. */
    mode?: 'off' | 'audit' | 'enforce';
    /** Red-line outcome in enforce mode. Default `ask`. */
    redAction?: 'ask' | 'deny';
  };
  /** Repetition brake for stuck turns. */
  loopGuard?: {
    disabled?: boolean;
    maxIdenticalCalls?: number;
    windowSize?: number;
    allowedTools?: string[];
  };
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * Holder state is anchored on globalThis: Pi loads gate extensions through
 * jiti, whose module registry is separate from the runner's ESM cache — a
 * module-local `let` gives the extension an empty second instance and
 * silently disables the whole gate (observed live in container mode).
 */
interface ApprovalHolderState {
  policy: ApprovalPolicy;
  ipcRoot: string;
  context: ApprovalRequestContext;
}

const HOLDER_KEY = '__ckqclawApprovalHolder__';

function holder(): ApprovalHolderState {
  const globalScope = globalThis as Record<string, unknown>;
  if (!globalScope[HOLDER_KEY]) {
    globalScope[HOLDER_KEY] = {
      policy: {},
      ipcRoot: '',
      context: { groupFolder: '', chatJid: '' },
    } satisfies ApprovalHolderState;
  }
  return globalScope[HOLDER_KEY] as ApprovalHolderState;
}

export interface ApprovalRequestContext {
  groupFolder: string;
  chatJid: string;
  sessionId?: string;
  turnId?: string;
}

export function setApprovalPolicy(policy: ApprovalPolicy | undefined): void {
  holder().policy = policy ?? {};
}

export function getApprovalPolicy(): ApprovalPolicy {
  return holder().policy;
}

export function setApprovalIpcRoot(ipcRoot: string): void {
  holder().ipcRoot = ipcRoot;
}

export function getApprovalIpcRoot(): string {
  return holder().ipcRoot;
}

export function setApprovalRequestContext(
  context: ApprovalRequestContext,
): void {
  holder().context = {
    groupFolder: context.groupFolder ?? '',
    chatJid: context.chatJid ?? '',
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
  };
}

export function getApprovalRequestContext(): ApprovalRequestContext {
  return holder().context;
}

/** True when the policy would block or hold anything — gates must load. */
export function isPolicyEnforced(
  policy: ApprovalPolicy = holder().policy,
): boolean {
  if (policy.default === 'ask' || policy.default === 'deny') return true;
  return Object.values(policy.tools ?? {}).some(
    (action) => action === 'ask' || action === 'deny',
  );
}

export function resolveApprovalAction(
  policy: ApprovalPolicy,
  toolName: string,
): ApprovalAction {
  const tools = policy.tools ?? {};
  const exact = tools[toolName];
  if (exact) return exact;
  let best: { prefix: string; action: ApprovalAction } | undefined;
  for (const [key, action] of Object.entries(tools)) {
    if (!key.endsWith('*')) continue;
    const prefix = key.slice(0, -1);
    if (!toolName.startsWith(prefix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, action };
  }
  if (best) return best.action;
  // Namespaced tool ids (`mcp__<server>__<name>`) never match bare policy
  // keys verbatim; fall back to the bare tool name so entries like
  // `send_file` or `browser_evaluate` also gate namespaced calls.
  const bare = toolName.replace(/^mcp__[A-Za-z0-9_-]+__/, '');
  if (bare !== toolName) {
    const bareAction = tools[bare];
    if (bareAction) return bareAction;
  }
  return policy.default ?? 'allow';
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  input: unknown;
  groupFolder: string;
  chatJid: string;
  sessionId?: string;
  turnId?: string;
  createdAt: string;
  timeoutMs: number;
}

export interface ApprovalDecision {
  id: string;
  approved: boolean;
  decidedBy?: string;
  decidedAt: string;
}

export function approvalDirs(ipcRoot: string): {
  pending: string;
  decisions: string;
} {
  return {
    pending: path.join(ipcRoot, 'approvals', 'pending'),
    decisions: path.join(ipcRoot, 'approvals', 'decisions'),
  };
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export function writeApprovalRequest(
  ipcRoot: string,
  request: Omit<ApprovalRequest, 'id' | 'createdAt'>,
): ApprovalRequest {
  const full: ApprovalRequest = {
    ...request,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const { pending } = approvalDirs(ipcRoot);
  writeJsonAtomic(path.join(pending, `${full.id}.json`), full);
  return full;
}

export function readApprovalDecision(
  ipcRoot: string,
  id: string,
): ApprovalDecision | undefined {
  const { decisions } = approvalDirs(ipcRoot);
  const decision = readJson<ApprovalDecision>(
    path.join(decisions, `${id}.json`),
  );
  return decision && typeof decision.approved === 'boolean'
    ? decision
    : undefined;
}

export type WaitOutcome =
  | { kind: 'approved'; decision: ApprovalDecision }
  | { kind: 'denied'; decision?: ApprovalDecision }
  | { kind: 'timeout' }
  | { kind: 'aborted'; reason: string };

/**
 * Poll for the host-written decision file. Resolves denied on timeout or
 * abort — never leaves the caller waiting past timeoutMs.
 */
export function awaitApprovalDecision(
  ipcRoot: string,
  request: ApprovalRequest,
  signal?: AbortSignal,
): Promise<WaitOutcome> {
  const { decisions } = approvalDirs(ipcRoot);
  const decisionFile = path.join(decisions, `${request.id}.json`);
  const deadline = Date.now() + request.timeoutMs;
  return new Promise((resolve) => {
    const finish = (outcome: WaitOutcome) => {
      signal?.removeEventListener('abort', onAbort);
      clearInterval(timer);
      resolve(outcome);
    };
    const onAbort = () => {
      finish({
        kind: 'aborted',
        reason: signal?.reason?.toString() ?? 'aborted',
      });
    };
    const poll = () => {
      const decision = readJson<ApprovalDecision & { cancelled?: string }>(
        decisionFile,
      );
      if (decision) {
        finish(
          decision.approved
            ? { kind: 'approved', decision }
            : { kind: 'denied', decision },
        );
        return;
      }
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (Date.now() >= deadline) finish({ kind: 'timeout' });
    };
    const timer = setInterval(poll, 500);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
