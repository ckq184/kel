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
