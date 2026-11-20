import crypto from 'node:crypto';

import {
  getRecordedUsageEventCost,
  getUsagePricingBucketTotals,
  recordUsageEventBatch,
  type UsageModelRecordInput,
} from './db.js';
import {
  estimateKabooModelCostCents,
  kabooCostCentsToUSD,
  priceKabooUsageByModel,
} from './kaboo-pricing.js';
import { getEffectiveCustomPricing } from './custom-pricing-store.js';

export interface UsagePayload {
  eventId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens?: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      reasoningTokens?: number;
      costUSD: number;
    }
  >;
}

export interface RecordUsageEventOptions {
  userId: string;
  groupFolder: string;
  agentId?: string | null;
  messageId?: string | null;
  source?: string;
  usage: UsagePayload;
  /** Stable runner turn/event ID. Required for strong replay protection. */
  eventId?: string;
  createdAt?: string;
}

function safe(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value || 0) : 0;
}

function usageIdentityPayload(usage: UsagePayload): Record<string, unknown> {
  const modelUsage = Object.fromEntries(
    Object.entries(usage.modelUsage || {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([model, value]) => [
        model,
        {
          inputTokens: value.inputTokens,
          outputTokens: value.outputTokens,
          cacheReadInputTokens: value.cacheReadInputTokens,
          cacheCreationInputTokens: value.cacheCreationInputTokens,
          reasoningTokens: value.reasoningTokens || 0,
        },
      ]),
  );
  return {
    eventId: usage.eventId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    reasoningTokens: usage.reasoningTokens || 0,
    durationMs: usage.durationMs,
    numTurns: usage.numTurns,
    modelUsage,
  };
}

/**
 * Compatibility fallback for integrations that have not started sending a
 * runner event ID yet. It is deterministic for the same message + payload,
 * but new callers should always pass eventId explicitly.
 */
export function deriveUsageEventId(options: RecordUsageEventOptions): string {
  const explicit = options.eventId || options.usage.eventId;
  if (explicit?.trim()) return explicit.trim();
  return `usage:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        userId: options.userId,
        groupFolder: options.groupFolder,
        agentId: options.agentId || null,
        messageId: options.messageId || null,
        source: options.source || 'agent',
        // SDK dollar estimates are deliberately excluded: they are neither an
        // accounting authority nor part of a logical event's identity.
        usage: usageIdentityPayload(options.usage),
      }),
    )
    .digest('hex')}`;
}

/**
 * The sole application entry point for usage accounting.
 *
 * - one logical run = one eventId
 * - all model rows and analytics are committed atomically
 * - replaying the same eventId is a no-op
 * - zero-cost events still count every token category toward token quotas
 */
export function recordUsageEvent(options: RecordUsageEventOptions): {
  eventId: string;
  inserted: boolean;
  providerEstimatedCostUSD: number;
} {
  const eventId = deriveUsageEventId(options);
  const existing = getRecordedUsageEventCost(eventId);
  if (existing) {
    return { eventId, inserted: false, ...existing };
  }
  const usage = options.usage;
  const source = options.source?.trim() || 'agent';
  const createdAt = options.createdAt || new Date().toISOString();
  // One synchronous snapshot per event keeps all pricing calls below on the
  // same rule set even if an admin mutates rules mid-event.
  const customPricing = getEffectiveCustomPricing();
  const priced = priceKabooUsageByModel(
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      reasoningTokens: usage.reasoningTokens || 0,
    },
    usage.modelUsage,
    customPricing,
  );
  const models: UsageModelRecordInput[] = priced.models.map((model) => {
    const previous = getUsagePricingBucketTotals({
      userId: options.userId,
      groupFolder: options.groupFolder,
      source,
      model: model.model,
      createdAt,
    });
    const previousCostCents = estimateKabooModelCostCents(
      model.model,
      previous,
      customPricing,
    );
    const nextCostCents = estimateKabooModelCostCents(
      model.model,
      {
        inputTokens: previous.inputTokens + model.inputTokens,
        outputTokens: previous.outputTokens + model.outputTokens,
        cacheReadInputTokens:
          previous.cacheReadInputTokens + model.cacheReadInputTokens,
        cacheCreationInputTokens:
          previous.cacheCreationInputTokens + model.cacheCreationInputTokens,
        reasoningTokens: previous.reasoningTokens + model.reasoningTokens,
      },
      customPricing,
    );
    // Store this event's increment to the raw-model/UTC-half-hour headline.
    // Summing all increments in the bucket equals Kaboo's single rounded cent
    // value, including the sub-cent carry between small API calls.
    const incrementalCostUSD = kabooCostCentsToUSD(
      Math.max(0, nextCostCents - previousCostCents),
    );
    return {
      model: model.model,
      inputTokens: model.inputTokens,
      outputTokens: model.outputTokens,
      cacheReadInputTokens: model.cacheReadInputTokens,
      cacheCreationInputTokens: model.cacheCreationInputTokens,
      reasoningTokens: model.reasoningTokens,
      providerEstimatedCostUSD: incrementalCostUSD,
    };
  });
  const providerEstimatedCostUSD = models.reduce(
    (sum, model) => sum + model.providerEstimatedCostUSD,
    0,
  );

  const result = recordUsageEventBatch({
    eventId,
    userId: options.userId,
    groupFolder: options.groupFolder,
    agentId: options.agentId,
    messageId: options.messageId,
    inputTokens: priced.usage.inputTokens,
    outputTokens: priced.usage.outputTokens,
    cacheReadInputTokens: priced.usage.cacheReadInputTokens,
    cacheCreationInputTokens: priced.usage.cacheCreationInputTokens,
    reasoningTokens: priced.usage.reasoningTokens,
    providerEstimatedCostUSD,
    durationMs: safe(usage.durationMs),
    numTurns: safe(usage.numTurns),
    source,
    createdAt,
    models,
  });

  return {
    eventId,
    inserted: result.inserted,
    providerEstimatedCostUSD,
  };
}
