/**
 * Synchronous cache between custom_model_pricing rows and the pricing hot
 * path (task V).
 *
 * recordUsageEvent is a synchronous better-sqlite3 hot path, so effective
 * rules must be readable without any await. The cache mirrors the billing
 * quota-cache pattern: 30s TTL plus explicit invalidation from the admin CRUD
 * routes so price changes apply to the next event without waiting out the TTL.
 */
import { listCustomModelPricingRules, type CustomModelPricing } from './db.js';
import type { CustomPricingRules, KabooModelPricing } from './kaboo-pricing.js';

const CUSTOM_PRICING_CACHE_TTL_MS = 30_000;

let cache: { rules: CustomPricingRules; expires: number } | null = null;

/** DB rows carry id/kind/enabled metadata the pure matcher must not see. */
function toKabooPricing(rule: CustomModelPricing): KabooModelPricing {
  return {
    pattern: rule.pattern,
    displayName: rule.displayName,
    family: rule.family,
    inputPricePerMTok: rule.inputPricePerMTok,
    outputPricePerMTok: rule.outputPricePerMTok,
    cacheReadPricePerMTok: rule.cacheReadPricePerMTok,
    cacheCreationPricePerMTok: rule.cacheCreationPricePerMTok,
    reasoningPricePerMTok: rule.reasoningPricePerMTok,
  };
}

/** Effective (enabled-only) custom rules for pricing; never returns null. */
export function getEffectiveCustomPricing(): CustomPricingRules {
  if (cache && cache.expires > Date.now()) {
    return cache.rules;
  }
  const rows = listCustomModelPricingRules();
  const patterns = rows
    .filter((row) => row.kind === 'pattern' && row.enabled)
    .map(toKabooPricing);
  const fallbackRow = rows.find(
    (row) => row.kind === 'fallback' && row.enabled,
  );
  const rules: CustomPricingRules = fallbackRow
    ? { patterns, fallback: toKabooPricing(fallbackRow) }
    : { patterns };
  cache = { rules, expires: Date.now() + CUSTOM_PRICING_CACHE_TTL_MS };
  return rules;
}

/** Called by every pricing CRUD mutation; the next event re-reads the table. */
export function invalidateCustomPricingCache(): void {
  cache = null;
}
