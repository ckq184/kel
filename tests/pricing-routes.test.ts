import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-routes-'));
const storeDir = path.join(tmpDir, 'db');
const groupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));

vi.mock('../src/runtime-config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  // 计价与路由测试只关心规则解析与落库；钱包路径不在本文件范围。
  getSystemSettings: () => ({ billingEnabled: false }),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Keep the real permission middleware; only swap session auth for a header so
// 401/403 paths exercise the genuine systemConfigMiddleware gate.
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      const role = c.req.header('x-test-role');
      if (!role) return c.json({ error: 'Unauthorized' }, 401);
      const permission = c.req.header('x-test-permission');
      c.set('user', {
        id: 'pricing-admin',
        username: 'pricing-admin',
        role,
        permissions: permission ? [permission] : [],
      });
      return next();
    },
  };
});

const db = await import('../src/db.js');
const { getEffectiveCustomPricing, invalidateCustomPricingCache } =
  await import('../src/custom-pricing-store.js');
const { recordUsageEvent } = await import('../src/usage-service.js');
const pricingRoutes = (await import('../src/routes/pricing.js')).default;

const dbPath = path.join(storeDir, 'messages.db');

afterAll(() => {
  if (db.isDatabaseInitialized()) db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function openProbe(): InstanceType<typeof Database> {
  return new Database(dbPath, { readonly: true });
}

describe('custom_model_pricing migration (v73)', () => {
  test('creates the idempotent table and partial unique indexes at v73', () => {
    db.initDatabase();

    expect(db.CURRENT_SCHEMA_VERSION).toBe(76);
    const probe = openProbe();
    try {
      const version = probe
        .prepare('SELECT value FROM router_state WHERE key = ?')
        .get('schema_version') as { value: string } | undefined;
      expect(version?.value).toBe('76');

      const objects = probe
        .prepare(
          `SELECT name, sql FROM sqlite_master
           WHERE name IN ('custom_model_pricing', 'idx_custom_pricing_fallback', 'idx_custom_pricing_pattern')`,
        )
        .all() as Array<{ name: string; sql: string }>;
      const byName = new Map(objects.map((row) => [row.name, row.sql]));
      expect(byName.get('custom_model_pricing')).toMatch(
        /CREATE TABLE custom_model_pricing/,
      );
      // 兜底与模式串唯一性都必须是 DB 层强制的部分唯一索引。
      expect(byName.get('idx_custom_pricing_fallback')).toMatch(
        /UNIQUE INDEX \S+\s+ON custom_model_pricing\s*\(kind\)\s+WHERE kind = 'fallback'/i,
      );
      expect(byName.get('idx_custom_pricing_pattern')).toMatch(
        /UNIQUE INDEX \S+\s+ON custom_model_pricing\s*\(pattern\)\s+WHERE kind = 'pattern'/i,
      );
    } finally {
      probe.close();
    }
  });

  test('re-initializing the upgraded database stays idempotent', () => {
    db.closeDatabase();
    expect(() => db.initDatabase()).not.toThrow();
    const probe = openProbe();
    try {
      const version = probe
        .prepare('SELECT value FROM router_state WHERE key = ?')
        .get('schema_version') as { value: string } | undefined;
      expect(version?.value).toBe('76');
    } finally {
      probe.close();
    }
  });

  test('rejects a second fallback row and duplicate pattern rows at the DB layer', () => {
    const probe = new Database(dbPath);
    try {
      const insert = probe.prepare(
        `INSERT INTO custom_model_pricing (id, kind, pattern, display_name, family,
           input_price_per_mtok, output_price_per_mtok, cache_read_price_per_mtok,
           cache_creation_price_per_mtok, reasoning_price_per_mtok, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      );
      insert.run(
        'db-fallback-a',
        'fallback',
        '',
        '兜底A',
        'custom',
        1,
        2,
        0.1,
        1,
        2,
      );
      expect(() =>
        insert.run(
          'db-fallback-b',
          'fallback',
          '',
          '兜底B',
          'custom',
          2,
          3,
          0.2,
          2,
          3,
        ),
      ).toThrow(/UNIQUE/i);

      insert.run(
        'db-pattern-a',
        'pattern',
        'glm-5.3',
        'GLM',
        'zhipu',
        1,
        2,
        0.1,
        1,
        2,
      );
      expect(() =>
        insert.run(
          'db-pattern-b',
          'pattern',
          'glm-5.3',
          'GLM 重复',
          'zhipu',
          2,
          3,
          0.2,
          2,
          3,
        ),
      ).toThrow(/UNIQUE/i);
      // pattern 唯一性只作用于 pattern 规则；fallback 的空模式串不受影响（上一段已证）。
      // 临时 DB 在整个文件内共享，清掉探针行避免污染后续 CRUD 断言。
      probe
        .prepare(
          "DELETE FROM custom_model_pricing WHERE id IN ('db-fallback-a', 'db-pattern-a')",
        )
        .run();
    } finally {
      probe.close();
    }
  });
});

describe('custom_model_pricing CRUD', () => {
  test('create/list/get round-trips pricing fields with defaults and flag mapping', () => {
    const created = db.createCustomModelPricingRule({
      kind: 'pattern',
      pattern: 'glm-5.3-flash',
      displayName: 'GLM 5.3 Flash',
      family: 'zhipu',
      inputPricePerMTok: 0.6,
      outputPricePerMTok: 2.2,
      cacheReadPricePerMTok: 0.1,
      cacheCreationPricePerMTok: 0.7,
      reasoningPricePerMTok: 2.2,
    });
    expect(created.id).toMatch(/^cmp_/);
    expect(created.kind).toBe('pattern');
    expect(created.pattern).toBe('glm-5.3-flash');
    expect(created.enabled).toBe(true);
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBe(created.createdAt);

    const fetched = db.getCustomModelPricingRule(created.id);
    expect(fetched).toEqual(created);

    const fallback = db.createCustomModelPricingRule({
      kind: 'fallback',
      inputPricePerMTok: 1.5,
      outputPricePerMTok: 6,
    });
    expect(fallback.kind).toBe('fallback');
    expect(fallback.pattern).toBe('');
    expect(fallback.family).toBe('custom');
    expect(fallback.displayName).toBe('');
    expect(fallback.cacheReadPricePerMTok).toBe(0);
    expect(fallback.cacheCreationPricePerMTok).toBe(0);
    expect(fallback.reasoningPricePerMTok).toBe(0);

    const listed = db.listCustomModelPricingRules();
    expect(listed.map((rule) => rule.id)).toEqual(
      expect.arrayContaining([created.id, fallback.id]),
    );
  });

  test('update patches only provided fields and maps the enabled flag', () => {
    const created = db.createCustomModelPricingRule({
      kind: 'pattern',
      pattern: 'glm-4.7',
      inputPricePerMTok: 1,
      outputPricePerMTok: 4,
    });
    const updated = db.updateCustomModelPricingRule(created.id, {
      enabled: false,
      inputPricePerMTok: 1.1,
      displayName: 'GLM 4.7 自定义',
    });
    expect(updated?.enabled).toBe(false);
    expect(updated?.inputPricePerMTok).toBe(1.1);
    expect(updated?.displayName).toBe('GLM 4.7 自定义');
    expect(updated?.outputPricePerMTok).toBe(4);
    expect(updated?.pattern).toBe('glm-4.7');
    expect(updated?.updatedAt).toBeTruthy();

    expect(
      db.updateCustomModelPricingRule('cmp_does-not-exist', { enabled: true }),
    ).toBeUndefined();
  });

  test('delete removes only the targeted rule', () => {
    const created = db.createCustomModelPricingRule({
      kind: 'pattern',
      pattern: 'to-delete-model',
    });
    expect(db.deleteCustomModelPricingRule(created.id)).toBe(true);
    expect(db.getCustomModelPricingRule(created.id)).toBeUndefined();
    expect(db.deleteCustomModelPricingRule(created.id)).toBe(false);
  });
});

describe('custom pricing store + recordUsageEvent injection', () => {
  // 临时 DB 在文件内共享：前序 describe 的 CRUD 残留必须清空，桶断言才独立。
  beforeEach(() => {
    for (const rule of db.listCustomModelPricingRules()) {
      db.deleteCustomModelPricingRule(rule.id);
    }
    invalidateCustomPricingCache();
  });

  const glmUsage = {
    inputTokens: 55_679,
    outputTokens: 3_230,
    cacheReadInputTokens: 50_112,
    cacheCreationInputTokens: 0,
    costUSD: 0,
    durationMs: 1_000,
    numTurns: 1,
    modelUsage: {
      'glm-5.3-flash': {
        inputTokens: 55_679,
        outputTokens: 3_230,
        cacheReadInputTokens: 50_112,
        cacheCreationInputTokens: 0,
        costUSD: 0,
      },
    },
  };

  function recordOnce(eventId: string, createdAt: string) {
    return recordUsageEvent({
      userId: 'pricing-owner',
      groupFolder: 'pricing-group',
      source: 'agent',
      eventId,
      createdAt,
      usage: { ...glmUsage, eventId },
    });
  }

  test('an enabled custom pattern prices new events; disabling falls back', () => {
    db.createUser({
      id: 'pricing-owner',
      username: 'pricing-owner',
      password_hash: 'x',
      display_name: 'Pricing Owner',
      role: 'member',
      status: 'active',
      permissions: [],
      must_change_password: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // 无规则 → 内置 Sonnet 兜底：0.167037+0.04845+0.0150336 = $0.2305206 → 23 cents
    const baseline = recordOnce('usage:baseline', '2026-11-09T10:00:00.000Z');
    expect(baseline.providerEstimatedCostUSD).toBe(0.23);

    const rule = db.createCustomModelPricingRule({
      kind: 'pattern',
      pattern: 'glm-5.3-flash',
      inputPricePerMTok: 0.6,
      outputPricePerMTok: 2.2,
      cacheReadPricePerMTok: 0.1,
      cacheCreationPricePerMTok: 0.7,
      reasoningPricePerMTok: 2.2,
    });
    invalidateCustomPricingCache();
    expect(getEffectiveCustomPricing().patterns.map((p) => p.pattern)).toEqual([
      'glm-5.3-flash',
    ]);

    // 自定义价：55,679×0.6 + 3,230×2.2 + 50,112×0.1（/1M）= $0.0455246 → 5 cents
    // （独立半小时桶，事件金额=单笔全价而非桶增量）
    const customPriced = recordOnce('usage:custom', '2026-11-09T10:35:00.000Z');
    expect(customPriced.providerEstimatedCostUSD).toBe(0.05);

    // 禁用规则 → 显式失效后立即回落 Sonnet 兜底。
    db.updateCustomModelPricingRule(rule.id, { enabled: false });
    invalidateCustomPricingCache();
    const disabled = recordOnce('usage:disabled', '2026-11-09T11:05:00.000Z');
    expect(disabled.providerEstimatedCostUSD).toBe(0.23);

    db.deleteCustomModelPricingRule(rule.id);
    invalidateCustomPricingCache();
  });

  test('custom fallback prices unmatched models and cache TTL is bypassed by invalidation', () => {
    const fallback = db.createCustomModelPricingRule({
      kind: 'fallback',
      inputPricePerMTok: 0.5,
      outputPricePerMTok: 2,
      cacheReadPricePerMTok: 0.05,
      cacheCreationPricePerMTok: 0.5,
      reasoningPricePerMTok: 2,
    });
    invalidateCustomPricingCache();
    const effective = getEffectiveCustomPricing();
    expect(effective.patterns).toEqual([]);
    expect(effective.fallback?.inputPricePerMTok).toBe(0.5);

    // 55,679×0.5 + 3,230×2 + 50,112×0.05（/1M）= $0.0402336 → 4 cents
    const priced = recordOnce('usage:fallback', '2026-11-09T12:00:00.000Z');
    expect(priced.providerEstimatedCostUSD).toBe(0.04);

    db.deleteCustomModelPricingRule(fallback.id);
    invalidateCustomPricingCache();
    expect(getEffectiveCustomPricing().fallback).toBeUndefined();
  });

  test('disabled rules are never projected into the effective set', () => {
    const disabledPattern = db.createCustomModelPricingRule({
      kind: 'pattern',
      pattern: 'glm',
      enabled: false,
      inputPricePerMTok: 99,
    });
    const disabledFallback = db.createCustomModelPricingRule({
      kind: 'fallback',
      enabled: false,
      inputPricePerMTok: 99,
    });
    invalidateCustomPricingCache();
    const effective = getEffectiveCustomPricing();
    expect(effective.patterns).toEqual([]);
    expect(effective.fallback).toBeUndefined();

    db.deleteCustomModelPricingRule(disabledPattern.id);
    db.deleteCustomModelPricingRule(disabledFallback.id);
    invalidateCustomPricingCache();
  });

  test('half-hour bucket keeps new-price re-basing semantics: never over-charges', () => {
    // 同一 UTC 半小时桶内两次事件，中途把单价从 $100/MTok 降到 $0.4/MTok。
    const rule = db.createCustomModelPricingRule({
      kind: 'pattern',
      pattern: 'clamp-model',
      inputPricePerMTok: 100,
    });
    invalidateCustomPricingCache();
    const usage = (tokens: number, eventId: string) => ({
      eventId,
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
      durationMs: 1,
      numTurns: 1,
      modelUsage: {
        'clamp-model': {
          inputTokens: tokens,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0,
        },
      },
    });

    const first = recordUsageEvent({
      userId: 'pricing-owner',
      groupFolder: 'pricing-group',
      source: 'agent',
      eventId: 'usage:clamp-1',
      createdAt: '2026-11-09T12:00:00.000Z',
      usage: usage(6_000, 'usage:clamp-1'),
    });
    // 6,000×100/1M = $0.6 → 60 cents
    expect(first.providerEstimatedCostUSD).toBe(0.6);

    db.updateCustomModelPricingRule(rule.id, { inputPricePerMTok: 0.4 });
    invalidateCustomPricingCache();

    const second = recordUsageEvent({
      userId: 'pricing-owner',
      groupFolder: 'pricing-group',
      source: 'agent',
      eventId: 'usage:clamp-2',
      createdAt: '2026-11-09T12:10:00.000Z',
      usage: usage(6_000, 'usage:clamp-2'),
    });
    // 桶前量按新价重算：round(12,000×0.4/1M×100)=0 − round(6,000×0.4/1M×100)=0 → 增量 0，
    // 绝不为负也绝不多计；历史第一行 60 cents 不回算。
    expect(second.providerEstimatedCostUSD).toBe(0);

    const third = recordUsageEvent({
      userId: 'pricing-owner',
      groupFolder: 'pricing-group',
      source: 'agent',
      eventId: 'usage:clamp-3',
      createdAt: '2026-11-09T12:20:00.000Z',
      usage: usage(1_000_000, 'usage:clamp-3'),
    });
    // round(1,012,000×0.4/1M×100)=40 − round(12,000×0.4/1M×100)=0 → 40 cents
    expect(third.providerEstimatedCostUSD).toBe(0.4);

    db.deleteCustomModelPricingRule(rule.id);
    invalidateCustomPricingCache();
  });
});

describe('/api/pricing admin routes', () => {
  const admin = { 'x-test-role': 'admin' } as Record<string, string>;
  const member = { 'x-test-role': 'member' } as Record<string, string>;
  const opsManager = {
    'x-test-role': 'member',
    'x-test-permission': 'manage_system_config',
  } as Record<string, string>;

  beforeEach(() => {
    for (const rule of db.listCustomModelPricingRules()) {
      db.deleteCustomModelPricingRule(rule.id);
    }
    invalidateCustomPricingCache();
  });

  function post(body: unknown, headers = admin) {
    return pricingRoutes.request('/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  test('rejects unauthenticated and unauthorized callers', async () => {
    const anon = await pricingRoutes.request('/rules');
    expect(anon.status).toBe(401);

    const forbidden = await pricingRoutes.request('/rules', {
      headers: member,
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({
      error: expect.stringContaining('manage_system_config'),
    });
  });

  test('member holding manage_system_config may manage pricing rules', async () => {
    const ops = await post(
      { kind: 'pattern', pattern: 'ops-model', inputPricePerMTok: 1 },
      opsManager,
    );
    expect(ops.status).toBe(201);
  });

  test('lists rules and fallback for the admin view', async () => {
    await post({
      kind: 'pattern',
      pattern: 'glm-5.3-flash',
      inputPricePerMTok: 0.6,
    });
    const created = await post({
      kind: 'fallback',
      inputPricePerMTok: 0.5,
      outputPricePerMTok: 2,
    });
    expect(created.status).toBe(201);

    const list = await pricingRoutes.request('/rules', { headers: admin });
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.rules).toHaveLength(1);
    expect(body.rules[0]).toMatchObject({
      kind: 'pattern',
      pattern: 'glm-5.3-flash',
      inputPricePerMTok: 0.6,
      enabled: true,
    });
    expect(body.fallback).toMatchObject({
      kind: 'fallback',
      inputPricePerMTok: 0.5,
    });
  });

  test('validates create bodies: pattern length, price bounds, finite numbers', async () => {
    const noPattern = await post({ kind: 'pattern' });
    expect(noPattern.status).toBe(400);

    const shortPattern = await post({ kind: 'pattern', pattern: 'g' });
    expect(shortPattern.status).toBe(400);

    const overflow = await post({
      kind: 'pattern',
      pattern: 'glm-5.3-flash',
      inputPricePerMTok: 20_000,
    });
    expect(overflow.status).toBe(400);

    const negative = await post({
      kind: 'pattern',
      pattern: 'glm-5.3-flash',
      inputPricePerMTok: -1,
    });
    expect(negative.status).toBe(400);

    // JSON.parse turns 1e999 into Infinity; finite() must reject it.
    const notFinite = await pricingRoutes.request('/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...admin },
      body: '{"kind":"pattern","pattern":"glm-5.3-flash","inputPricePerMTok":1e999}',
    });
    expect(notFinite.status).toBe(400);
  });

  test('conflicts: duplicate pattern and second fallback are 409', async () => {
    const first = await post({ kind: 'pattern', pattern: 'glm-5.3-flash' });
    expect(first.status).toBe(201);
    const dup = await post({ kind: 'pattern', pattern: 'GLM-5.3-FLASH' });
    expect(dup.status).toBe(409);

    await post({ kind: 'fallback', inputPricePerMTok: 0.5 });
    const secondFallback = await post({
      kind: 'fallback',
      inputPricePerMTok: 1,
    });
    expect(secondFallback.status).toBe(409);
  });

  test('patches rules, returns 404 for unknown ids and 409 on pattern clash', async () => {
    const created = await post({
      kind: 'pattern',
      pattern: 'glm-4.7',
      inputPricePerMTok: 1,
    });
    const rule = await created.json();

    const patch = await pricingRoutes.request(`/rules/${rule.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...admin },
      body: JSON.stringify({ enabled: false, outputPricePerMTok: 4.5 }),
    });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({
      enabled: false,
      outputPricePerMTok: 4.5,
    });

    const missing = await pricingRoutes.request('/rules/cmp_missing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...admin },
      body: JSON.stringify({ enabled: true }),
    });
    expect(missing.status).toBe(404);

    await post({ kind: 'pattern', pattern: 'glm-5.3' });
    const clash = await pricingRoutes.request(`/rules/${rule.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...admin },
      body: JSON.stringify({ pattern: 'glm-5.3' }),
    });
    expect(clash.status).toBe(409);
  });

  test('deletes rules and 404s on repeat deletes', async () => {
    const created = await post({ kind: 'pattern', pattern: 'doomed-model' });
    const rule = await created.json();

    const del = await pricingRoutes.request(`/rules/${rule.id}`, {
      method: 'DELETE',
      headers: admin,
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ success: true });

    const again = await pricingRoutes.request(`/rules/${rule.id}`, {
      method: 'DELETE',
      headers: admin,
    });
    expect(again.status).toBe(404);
  });

  test('preview reports the four resolution sources', async () => {
    const preview = (model: string) =>
      pricingRoutes.request('/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...admin },
        body: JSON.stringify({ model }),
      });

    // 无任何自定义 → 内置表命中
    const builtin = await preview('claude-opus-4-5');
    expect(builtin.status).toBe(200);
    expect(await builtin.json()).toMatchObject({
      source: 'builtin',
      pricing: { pattern: 'claude-opus-4-5%', inputPricePerMTok: 5 },
    });

    // 未命中 → 内置 Sonnet 兜底
    const sonnet = await preview('kimi-k3');
    expect(await sonnet.json()).toMatchObject({
      source: 'fallback-sonnet',
      pricing: { displayName: 'Claude Sonnet fallback', inputPricePerMTok: 3 },
    });

    await post({
      kind: 'pattern',
      pattern: 'glm-5.3-flash',
      inputPricePerMTok: 0.6,
      outputPricePerMTok: 2.2,
    });
    const custom = await preview('zhipu/GLM-5.3-FLASH:beta');
    expect(await custom.json()).toMatchObject({
      source: 'custom',
      rule: { pattern: 'glm-5.3-flash', inputPricePerMTok: 0.6 },
      pricing: { inputPricePerMTok: 0.6, outputPricePerMTok: 2.2 },
    });

    await post({ kind: 'fallback', inputPricePerMTok: 0.5 });
    const customFallback = await preview('kimi-k3');
    expect(await customFallback.json()).toMatchObject({
      source: 'fallback-custom',
      pricing: { inputPricePerMTok: 0.5 },
    });
  });

  test('mutations invalidate the pricing cache for the very next usage event', async () => {
    const created = await post({
      kind: 'pattern',
      pattern: 'glm-5.3-flash',
      inputPricePerMTok: 0.6,
      outputPricePerMTok: 2.2,
      cacheReadPricePerMTok: 0.1,
    });
    expect(created.status).toBe(201);
    // 不手动 invalidate：路由变更必须已使缓存失效，下一事件按新价落库。
    const priced = recordUsageEvent({
      userId: 'pricing-owner',
      groupFolder: 'pricing-group',
      source: 'agent',
      eventId: 'usage:route-cache',
      createdAt: '2026-11-09T13:00:00.000Z',
      usage: {
        eventId: 'usage:route-cache',
        inputTokens: 55_679,
        outputTokens: 3_230,
        cacheReadInputTokens: 50_112,
        cacheCreationInputTokens: 0,
        costUSD: 0,
        durationMs: 1,
        numTurns: 1,
        modelUsage: {
          'glm-5.3-flash': {
            inputTokens: 55_679,
            outputTokens: 3_230,
            cacheReadInputTokens: 50_112,
            cacheCreationInputTokens: 0,
            costUSD: 0,
          },
        },
      },
    });
    expect(priced.providerEstimatedCostUSD).toBe(0.05);
  });
});
