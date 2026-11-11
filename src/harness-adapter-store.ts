import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';

/**
 * Workspace harness adapter store (task AE, RSI Phase 1).
 *
 * A harness adapter is a per-workspace external harness layer (the hermit
 * "adapter" idea reduced to its prompt-only minimum): one `ADAPTER.md` file
 * injected into the runner's first user turn next to the workspace memory
 * block. Everything lives under `data/harness-adapters/<sanitized-jid>/` —
 * runtime data, gitignored, admin-gated writes.
 *
 * The learnable surface is a code constant for Phase 1 (one file, byte cap);
 * Phase 2 will grow it into a data manifest (skills/, memory notes) along the
 * hermit adapter.yaml learnable/fixed model.
 */

/** Hard cap on the adapter body (plan §1-1; PromptPlan budget sits on top). */
export const ADAPTER_MAX_BYTES = 16_384;

/**
 * Grader-directed leakage markers (harness² discipline): an adapter that
 * talks about judging/scoring is trying to game evaluation, not help the
 * agent — refuse it at validation time, before it ever reaches a proposal.
 */
const ADAPTER_FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /score|rubric|grader|pass_rate|eval_result/i,
  /评测|评分/,
];

export interface AdapterValidation {
  ok: boolean;
  issues: string[];
}

export function validateAdapterMd(text: string): AdapterValidation {
  const issues: string[] = [];
  if (!text.trim()) {
    issues.push('adapter is empty or whitespace-only');
  }
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes > ADAPTER_MAX_BYTES) {
    issues.push(
      `adapter is ${bytes} bytes (forbidden: exceeds ${ADAPTER_MAX_BYTES} byte cap)`,
    );
  }
  for (const pattern of ADAPTER_FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) {
      issues.push(
        `adapter contains a forbidden evaluation-directed marker (${pattern.source}); adapters must improve the agent, not address the judge`,
      );
    }
  }
  return { ok: issues.length === 0, issues };
}

/** Marker-tagged block injected into the runner's decorated first user turn. */
export function buildAdapterBlock(input: {
  version: number;
  text: string;
}): string {
  return [
    `<!-- ckqclaw-harness-adapter v${input.version} -->`,
    '# Workspace Harness Adapter',
    input.text.trim(),
    '<!-- /ckqclaw-harness-adapter -->',
  ].join('\n');
}

const ADAPTER_FILENAME = 'ADAPTER.md';
const ACTIVE_FILENAME = 'ACTIVE';

/**
 * Filesystem-safe directory per workspace JID. Hostile characters collapse
 * to `_`, and a short content hash keeps distinct JIDs from colliding after
 * sanitization (`a/b` vs `a_b`).
 */
export function adapterDirFor(workspaceJid: string): string {
  const safe = workspaceJid.replace(/[^\w.-]/g, '_');
  if (safe === workspaceJid) {
    return path.join(DATA_DIR, 'harness-adapters', safe);
  }
  const suffix = crypto
    .createHash('sha1')
    .update(workspaceJid, 'utf-8')
    .digest('hex')
    .slice(0, 8);
  return path.join(DATA_DIR, 'harness-adapters', `${safe}-${suffix}`);
}

function writeIfChanged(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf-8');
}

/** Persist the adapter body and the active version pointer atomically-ish (body first). */
export function writeAdapterFile(
  workspaceJid: string,
  text: string,
  activeVersion: number,
): void {
  const dir = adapterDirFor(workspaceJid);
  writeIfChanged(path.join(dir, ADAPTER_FILENAME), text);
  writeIfChanged(path.join(dir, ACTIVE_FILENAME), String(activeVersion));
}

/** Rollback path: re-point ACTIVE without rewriting history (plan §5-6). */
export function writeActiveVersion(
  workspaceJid: string,
  version: number,
): void {
  writeIfChanged(
    path.join(adapterDirFor(workspaceJid), ACTIVE_FILENAME),
    String(version),
  );
}

export function readAdapterFile(
  workspaceJid: string,
): { text: string; version: number } | null {
  const dir = adapterDirFor(workspaceJid);
  const adapterPath = path.join(dir, ADAPTER_FILENAME);
  if (!fs.existsSync(adapterPath)) return null;
  const text = fs.readFileSync(adapterPath, 'utf-8');
  const activePath = path.join(dir, ACTIVE_FILENAME);
  const versionRaw = fs.existsSync(activePath)
    ? fs.readFileSync(activePath, 'utf-8').trim()
    : '';
  const version = Number.parseInt(versionRaw, 10);
  return { text, version: Number.isFinite(version) ? version : 0 };
}

/**
 * ContainerInput projection: the active adapter for a workspace chat JID, or
 * undefined when none exists / anything fails (zero-impact guarantee — the
 * runner path must behave byte-identically when this is absent).
 */
export function buildHarnessAdapterInput(
  workspaceJid: string,
): { text: string; version: number } | undefined {
  try {
    return readAdapterFile(workspaceJid) ?? undefined;
  } catch {
    return undefined;
  }
}
