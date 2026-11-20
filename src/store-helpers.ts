/**
 * Tiny shared helpers for the SQLite-backed stores
 * (memory-store / owner-profile-store / channel-reliability-store).
 *
 * ISSUE-11 B6 convergence: each store previously carried its own verbatim
 * `nowIso` and `requireDatabase` copies. The error text below is contract —
 * existing callers and tests match on the exact
 * "<store label> store is not initialized" wording, so the label is
 * parameterized instead of rewritten.
 */

/** Current time in ISO 8601 (UTC). */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Return the store's database handle or throw the store's canonical
 * "not initialized" error. `storeLabel` is the store's display name, e.g.
 * 'Workspace memory' → 'Workspace memory store is not initialized'.
 */
export function requireDatabase<T extends object>(
  db: T | null | undefined,
  storeLabel: string,
): T {
  if (!db) {
    throw new Error(`${storeLabel} store is not initialized`);
  }
  return db;
}
