/**
 * [1m] model-suffix handling shared by the host and the agent runner.
 *
 * This is the single source of truth. Build step copies this file to:
 *   - src/model-suffix.ts
 *   - container/agent-runner/src/model-suffix.ts
 *
 * DO NOT edit the copies directly -- edit this file and run `make sync-types`.
 *
 * Host consumers strip the suffix before sending model ids to third-party
 * Anthropic-compatible endpoints; the runner strips it when composing query
 * options. The host and runner are separate npm projects, so the shared
 * source travels via the copy-sync mechanism (ISSUE-11 B10).
 */
export function stripOneMillionSuffix(model: string): string {
  return model
    .trim()
    .replace(/(\[1m\])+$/i, '')
    .trim();
}
