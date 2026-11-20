/**
 * Custom model pricing API (task V): admin-managed per-model unit prices.
 *
 * Resolution order for new usage events only (history is never repriced):
 * custom patterns → built-in Kaboo table → custom fallback → Sonnet fallback.
 * All endpoints require manage_system_config.
 */

import { Hono } from 'hono';

import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import {
  createCustomModelPricingRule,
  deleteCustomModelPricingRule,
  getCustomModelPricingRule,
  listCustomModelPricingRules,
  normalizePricingPattern,
  updateCustomModelPricingRule,
  type CustomModelPricing,
} from '../db.js';
import {
  getEffectiveCustomPricing,
  invalidateCustomPricingCache,
} from '../custom-pricing-store.js';
import {
  KABOO_SONNET_FALLBACK,
  matchKabooModelPricing,
  type KabooModelPricing,
} from '../kaboo-pricing.js';
import {
  CustomPricingCreateSchema,
  CustomPricingPatchSchema,
  CustomPricingPreviewSchema,
} from '../schemas.js';
import type { Variables } from '../web-context.js';

const pricingRoutes = new Hono<{ Variables: Variables }>();

interface PricingPreviewResponse {
  source: 'custom' | 'builtin' | 'fallback-custom' | 'fallback-sonnet';
  rule?: CustomModelPricing;
  pricing: KabooModelPricing;
}

pricingRoutes.use('*', authMiddleware, systemConfigMiddleware);

// GET /rules — full admin view, disabled rules included.
pricingRoutes.get('/rules', (c) => {
  const rules = listCustomModelPricingRules();
  const fallback = rules.find((rule) => rule.kind === 'fallback') ?? null;
  return c.json({
    rules: rules.filter((rule) => rule.kind === 'pattern'),
    fallback,
  });
});

// POST /rules — create; one fallback max and unique patterns are 409s.
pricingRoutes.post('/rules', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = CustomPricingCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const data = validation.data;
  const existing = listCustomModelPricingRules();
  if (data.kind === 'fallback' && existing.some((r) => r.kind === 'fallback')) {
    return c.json({ error: '自定义兜底价已存在（至多一条）' }, 409);
  }
  if (
    data.kind === 'pattern' &&
    existing.some(
      (r) =>
        r.kind === 'pattern' &&
        r.pattern === normalizePricingPattern(data.pattern!),
    )
  ) {
    return c.json({ error: '该模型模式已存在同名规则' }, 409);
  }

  const rule = createCustomModelPricingRule(data);
  invalidateCustomPricingCache();
  return c.json(rule, 201);
});

// PATCH /rules/:id — partial update; pattern clashes are 409s.
pricingRoutes.patch('/rules/:id', async (c) => {
  const id = c.req.param('id');
  if (!getCustomModelPricingRule(id)) {
    return c.json({ error: 'Rule not found' }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const validation = CustomPricingPatchSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const updates = validation.data;
  if (updates.pattern !== undefined) {
    const normalized = normalizePricingPattern(updates.pattern);
    const clash = listCustomModelPricingRules().some(
      (r) => r.kind === 'pattern' && r.pattern === normalized && r.id !== id,
    );
    if (clash) {
      return c.json({ error: '该模型模式已存在同名规则' }, 409);
    }
  }

  const updated = updateCustomModelPricingRule(id, updates);
  if (!updated) return c.json({ error: 'Rule not found' }, 404);
  invalidateCustomPricingCache();
  return c.json(updated);
});

// DELETE /rules/:id
pricingRoutes.delete('/rules/:id', (c) => {
  const id = c.req.param('id');
  if (!getCustomModelPricingRule(id)) {
    return c.json({ error: 'Rule not found' }, 404);
  }
  deleteCustomModelPricingRule(id);
  invalidateCustomPricingCache();
  return c.json({ success: true });
});

// POST /preview — show which rule a model name resolves to right now.
pricingRoutes.post('/preview', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = CustomPricingPreviewSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const model = validation.data.model;
  const effective = getEffectiveCustomPricing();
  const matched = matchKabooModelPricing(model, effective);

  if (matched) {
    // Compare by pattern string: the effective set holds freshly projected
    // KabooModelPricing objects, so identity checks would be unstable.
    const fromCustom = effective.patterns.some(
      (p) => p.pattern === matched.pattern,
    );
    const row = fromCustom
      ? listCustomModelPricingRules().find(
          (r) =>
            r.kind === 'pattern' && r.enabled && r.pattern === matched.pattern,
        )
      : undefined;
    const response: PricingPreviewResponse = {
      source: row ? 'custom' : 'builtin',
      ...(row ? { rule: row } : {}),
      pricing: matched,
    };
    return c.json(response);
  }

  const response: PricingPreviewResponse = effective.fallback
    ? { source: 'fallback-custom', pricing: effective.fallback }
    : { source: 'fallback-sonnet', pricing: KABOO_SONNET_FALLBACK };
  return c.json(response);
});

export default pricingRoutes;
