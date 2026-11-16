const STANDARD_CONTEXT_WINDOW = 200_000;
const EXTENDED_CONTEXT_WINDOW = 1_000_000;

/** Legacy heuristic: the [1m] model suffix marks an extended-context model. */
export function isExtendedContextModel(model: string): boolean {
  return /(\[1m\])+$/i.test(model.trim());
}

/**
 * Strip the legacy `[1m]` suffix from a model name so the bare id goes on the
 * wire (third-party Anthropic-compatible endpoints reject the suffix with 400).
 * Idempotent; only a trailing suffix is removed, interior matches stay intact.
 */
export function stripOneMillionSuffix(model: string): string {
  return model
    .trim()
    .replace(/(\[1m\])+$/i, '')
    .trim();
}

/**
 * Resolve the effective context window: declared value > [1m] heuristic > 200K.
 * The declaration is the provider-level `contextWindow` preset normalized by
 * the host (任务AL); the heuristic remains as the compat path for hosts that
 * never inject a declaration.
 */
export function resolveDeclaredContextWindow(
  model: string,
  declared?: number,
): number {
  if (declared !== undefined && Number.isFinite(declared) && declared > 0) {
    return declared;
  }
  return isExtendedContextModel(model)
    ? EXTENDED_CONTEXT_WINDOW
    : STANDARD_CONTEXT_WINDOW;
}

/** Convert a window-relative compact percentage into the SDK token setting. */
export function resolveAutoCompactWindow(
  contextWindow: number,
  percentage: number,
): number | undefined {
  if (!Number.isInteger(percentage) || percentage < 50 || percentage > 90) {
    return undefined;
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  return Math.round((contextWindow * percentage) / 100);
}

/**
 * Older installs persisted an absolute compact threshold.  Preserve smaller
 * values, but never pass a threshold above 90% of the effective context window
 * to the SDK: an 800K value inherited from a 1M-window model would otherwise
 * overflow after switching back to a regular 200K model before compaction can
 * run.
 */
export function resolveLegacyAutoCompactWindow(
  contextWindow: number,
  configuredTokens: number,
): number | undefined {
  if (!Number.isFinite(configuredTokens) || configuredTokens <= 0) {
    return undefined;
  }
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return undefined;
  }
  const safeMaximum = Math.floor(contextWindow * 0.9);
  return Math.min(Math.floor(configuredTokens), safeMaximum);
}
