/**
 * Golden-set types and integrity validation (task AD).
 *
 * Moved verbatim from scripts/eval-auto-recall.ts: the host build only
 * compiles src/ (tsconfig rootDir), so routes and the store need the
 * validation chain in src/. The script re-exports these symbols to keep its
 * existing import surface (tests/eval-auto-recall-metrics.test.ts) intact.
 *
 * QUERY_MAX_CHARS mirrors the runner turn contract (trim, then slice to the
 * IPC limit); the truncation-category rule below depends on it.
 */

export interface GoldenSeedItem {
  marker: string;
  content: string;
  /** Distinctive substrings that survive mem0's LLM extraction; used to map
   * stored/retrieved entries back to this item. Globally unique by rule. */
  keys: string[];
}

export type GoldenCategory = 'verbatim' | 'paraphrase' | 'multi' | 'truncation';

export interface GoldenQuery {
  id: string;
  category: GoldenCategory;
  text: string;
  expected: string[];
  note?: string;
}

export interface GoldenSet {
  seed: GoldenSeedItem[];
  queries: GoldenQuery[];
}

/** Mirrors the runner contract: trim first, then slice to the IPC limit. */
export const QUERY_MAX_CHARS = 500;

export const GOLDEN_CATEGORIES: ReadonlySet<string> = new Set([
  'verbatim',
  'paraphrase',
  'multi',
  'truncation',
]);

/** Integrity rules that keep the golden set measurable. Empty = valid. */
export function validateGoldenSet(fixture: GoldenSet): string[] {
  const issues: string[] = [];
  const markers = new Set<string>();
  const keyOwner = new Map<string, string>();

  if (!Array.isArray(fixture.seed) || fixture.seed.length === 0) {
    issues.push('seed must be a non-empty array');
    return issues;
  }
  if (!Array.isArray(fixture.queries) || fixture.queries.length === 0) {
    issues.push('queries must be a non-empty array');
    return issues;
  }

  for (const item of fixture.seed) {
    if (!item.marker) {
      issues.push('seed marker must be non-empty');
      continue;
    }
    if (markers.has(item.marker)) {
      issues.push(`duplicate marker: ${item.marker}`);
      continue;
    }
    markers.add(item.marker);
    if (!item.content || !item.content.trim()) {
      issues.push(`seed[${item.marker}] content must be non-empty`);
    }
    if (!Array.isArray(item.keys) || item.keys.length === 0) {
      issues.push(`seed[${item.marker}] keys must be a non-empty array`);
      continue;
    }
    for (const key of item.keys) {
      if (!key || !key.trim()) {
        issues.push(`seed[${item.marker}] has an empty key`);
        continue;
      }
      const owner = keyOwner.get(key);
      if (owner) {
        issues.push(
          `duplicate key "${key}" shared by ${owner} and ${item.marker}`,
        );
      } else {
        keyOwner.set(key, item.marker);
      }
    }
  }

  // A key leaking into another item's content makes text→marker mapping
  // ambiguous: that content would match the other item's marker too.
  for (const item of fixture.seed) {
    for (const [key, owner] of keyOwner) {
      if (owner !== item.marker && item.content.includes(key)) {
        issues.push(
          `seed[${item.marker}] content contains key "${key}" owned by ${owner}`,
        );
      }
    }
  }

  const seenCategories = new Set<string>();
  for (const query of fixture.queries) {
    if (!query.id) issues.push('query with empty id');
    if (!GOLDEN_CATEGORIES.has(query.category)) {
      issues.push(`query[${query.id}] unknown category: ${query.category}`);
    } else {
      seenCategories.add(query.category);
    }
    if (!query.text || !query.text.trim()) {
      issues.push(`query[${query.id}] text must be non-empty`);
    }
    if (!Array.isArray(query.expected) || query.expected.length === 0) {
      issues.push(`query[${query.id}] expected must be a non-empty array`);
    } else {
      for (const marker of query.expected) {
        if (!markers.has(marker)) {
          issues.push(`query[${query.id}] expected unknown marker ${marker}`);
        }
      }
    }
    if (
      query.category === 'truncation' &&
      query.text &&
      query.text.trim().length <= QUERY_MAX_CHARS
    ) {
      issues.push(
        `query[${query.id}] (truncation) text must exceed ${QUERY_MAX_CHARS} chars (got ${query.text.trim().length})`,
      );
    }
  }
  for (const category of GOLDEN_CATEGORIES) {
    if (!seenCategories.has(category)) {
      issues.push(`golden set missing category: ${category}`);
    }
  }
  return issues;
}
