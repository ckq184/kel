/**
 * THESIS-07 用量（二）：停记账，气泡回写改为不经账本。
 *
 * 验收锚点（源码契约，行为面见 tests/usage-accumulator.test.ts）：
 * - 五处账本写入点、`writeUsageRecords` 包装与 `usage-service`/`task-usage`
 *   两个模块全部删除，`src/` 不再有 `recordUsageEventBatch` 的生产调用方；
 * - 推送给 Web/飞书的 `usage` 流事件不再被宿主覆盖 `costUSD`；
 * - 气泡耗时改由 `usage-accumulator` 在内存累加后经
 *   `updateLatestMessageTokenUsage` 回写；
 * - `usage` 流事件本身保留（THESIS-09 之前前端仍从事件拼 token 展示）。
 *
 * 本包不改 `src/db.ts` 与表结构；`rebuildMessageTokenUsageFromLedger` 等
 * 函数本体留给 THESIS-14 随表删除。
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const repoRoot = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
const exists = (relativePath: string) =>
  fs.existsSync(path.join(repoRoot, relativePath));

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    return entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

describe('usage ledger writers are removed', () => {
  test('usage-service and task-usage modules are deleted', () => {
    expect(exists('src/usage-service.ts')).toBe(false);
    expect(exists('src/task-usage.ts')).toBe(false);
  });

  test('index.ts has no ledger writer, ledger rebuild or cost override', () => {
    const source = read('src/index.ts');
    expect(source).not.toMatch(/recordUsageEvent\b/);
    expect(source).not.toContain('writeUsageRecords');
    expect(source).not.toContain('rebuildMessageTokenUsageFromLedger');
    expect(source).not.toContain('providerEstimatedCostUSD');
    expect(source).not.toMatch(/usage\.costUSD\s*=/);
    expect(source).not.toContain("from './usage-service.js'");
    expect(source).not.toContain("from './task-usage.js'");
  });

  test('task-scheduler no longer records isolated task usage', () => {
    const source = read('src/task-scheduler.ts');
    expect(source).not.toContain('recordIsolatedTaskUsage');
    expect(source).not.toContain("from './task-usage.js'");
  });

  test('no production caller of recordUsageEventBatch outside db.ts', () => {
    const srcRoot = path.join(repoRoot, 'src');
    const offenders = listSourceFiles(srcRoot)
      .filter((file) => path.basename(file) !== 'db.ts')
      .filter((file) =>
        fs.readFileSync(file, 'utf8').includes('recordUsageEventBatch'),
      );
    expect(offenders).toEqual([]);
  });
});

describe('bubble duration is accumulated without the ledger', () => {
  test('index.ts uses the in-memory accumulator for both reply paths', () => {
    const source = read('src/index.ts');
    expect(source).toContain("from './usage-accumulator.js'");
    expect(source).toContain('createUsageAccumulator');
    expect(source.match(/replyUsageAccumulator\.accrue\(/g) ?? []).toHaveLength(
      2,
    );
    expect(source).toContain('replyUsageKey(chatJid, lastReplyMsgId)');
    expect(source).toContain(
      'replyUsageKey(virtualChatJid, lastAgentReplyMsgId)',
    );
    expect(source.match(/JSON\.stringify\(totals\)/g) ?? []).toHaveLength(2);
    expect(source).toContain('updateLatestMessageTokenUsage');
    expect(source).toMatch(/eventType === 'usage'/);
  });

  test('accumulator module is a side-effect-free pure helper', () => {
    const source = read('src/usage-accumulator.ts');
    expect(source).not.toMatch(/from '\.\/(db|logger|config)\.js'/);
    expect(source).not.toContain('fs.');
    expect(source).not.toContain('process.');
  });
});

describe('superseded ledger tests are gone', () => {
  test('usage-accounting and task-usage-routing tests are deleted', () => {
    expect(exists('tests/usage-accounting.test.ts')).toBe(false);
    expect(exists('tests/task-usage-routing.test.ts')).toBe(false);
  });
});
