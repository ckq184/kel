/**
 * THESIS-14 删除五张死表：源码契约。
 *
 * 行为面（新库/旧库升级、迁移前备份）见
 * `tests/db-upgrade-safety.test.ts` 的 v79 用例。
 *
 * 验收锚点：
 * - `usage_records`、`usage_events`、`custom_model_pricing`、`invite_codes`、
 *   `auth_audit_log` 在 `src/` 不再有建表、ensureColumn、assertSchema 或读写函数；
 * - `src/db.ts` 不再导出方案列出的 24 个孤儿函数；
 * - `src/types.ts` 不再保留只服务这些函数的四个类型；
 * - v78→v79 迁移显式 DROP 五张表，head 版本升到 79。
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const repoRoot = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const exists = (relativePath: string) =>
  fs.existsSync(path.join(repoRoot, relativePath));

const DEAD_TABLES = [
  'usage_records',
  'usage_events',
  'custom_model_pricing',
  'invite_codes',
  'auth_audit_log',
] as const;

const DELETED_EXPORTS = [
  // 用量
  'rebuildMessageTokenUsageFromLedger',
  'getUsageDateWindow',
  'getRecordedUsageEventCost',
  'getUsagePricingBucketTotals',
  'recordUsageEventBatch',
  'getUsageAnalytics',
  'getUsageModelsForFilters',
  'getUsageRecordsPage',
  'getUsageUsers',
  'insertUsageInsert',
  // 单价
  'normalizePricingPattern',
  'listCustomModelPricingRules',
  'getCustomModelPricingRule',
  'createCustomModelPricingRule',
  'updateCustomModelPricingRule',
  'deleteCustomModelPricingRule',
  'CustomModelPricing',
  // 邀请码
  'createInviteCode',
  'getInviteCode',
  'registerUserWithInvite',
  'getAllInviteCodes',
  'deleteInviteCode',
  // 审计
  'logAuthEvent',
  'queryAuthAuditLogs',
  // 注册下线后的孤儿
  'registerUserWithoutInvite',
] as const;

describe('THESIS-14: five dead tables are removed', () => {
  test('src/db.ts no longer names the five tables or the 24 orphan exports', () => {
    const source = read('src/db.ts');
    for (const table of DEAD_TABLES) {
      expect(source, table).not.toContain(table);
    }
    for (const symbol of DELETED_EXPORTS) {
      expect(source, symbol).not.toContain(symbol);
    }
    // The usage insert prepared statement belongs to the deleted batch writer.
    expect(source).not.toContain('insertUsageInsert');
    // The message-level write used by THESIS-07 must survive.
    expect(source).toContain('export function updateLatestMessageTokenUsage');
  });

  test('schema modules no longer create, ensure or assert the five tables', () => {
    expect(exists('src/db-schema/usage-tables.ts')).toBe(false);

    const auth = read('src/db-schema/auth-tables.ts');
    expect(auth).not.toContain('invite_codes');
    expect(auth).not.toContain('auth_audit_log');

    const agentProfile = read('src/db-schema/agent-profile-tables.ts');
    expect(agentProfile).not.toContain('custom_model_pricing');

    const taskTables = read('src/db-schema/task-tables.ts');
    expect(taskTables).not.toContain('invite_codes');

    const legacyRebuilds = read('src/db-schema/migrations-legacy-rebuilds.ts');
    expect(legacyRebuilds).not.toContain('invite_codes');
    expect(legacyRebuilds).not.toContain('auth_audit_log');
  });

  test('src/types.ts no longer exports the dead auth types', () => {
    const source = read('src/types.ts');
    for (const symbol of [
      'InviteCode',
      'InviteCodeWithCreator',
      'AuthEventType',
      'AuthAuditLog',
    ]) {
      expect(source, symbol).not.toMatch(new RegExp(`\\b${symbol}\\b`));
    }
  });

  test('v78→v79 drops all five tables and the head version is 79', () => {
    const migration = read('src/db-schema/migrations-channel-trims.ts');
    expect(migration).toMatch(/v78\s*→\s*v79/);
    for (const table of DEAD_TABLES) {
      expect(migration).toContain(`DROP TABLE IF EXISTS ${table};`);
    }
    expect(read('src/db.ts')).toMatch(
      /export const CURRENT_SCHEMA_VERSION = 79;/,
    );
  });

  test('superseded v51 ledger test and stale runner table reference are gone', () => {
    expect(exists('tests/schema-v51-usage.test.ts')).toBe(false);
    expect(
      read('container/agent-runner/src/runtime/pi/pi-session.ts'),
    ).not.toContain('usage_events');
  });

  test('CLAUDE.md core table families no longer list the dead tables', () => {
    const source = read('CLAUDE.md');
    for (const table of DEAD_TABLES) {
      expect(source, table).not.toContain(table);
    }
    // V-F5: usage_daily_summary was already dropped in v77.
    expect(source).not.toContain('usage_daily_summary');
  });
});
