import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * ISSUE-17 防回潮契约：StreamEvent 中“只有消费者、没有生产者”的字段
 * 按用户逐字段拍板下线后，不得在信封与三侧消费代码里回潮；
 * 保留项（messageUuid 有意不产出、subagentType 已补生产者）仍在信封上。
 */

const ROOT = path.resolve(__dirname, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function streamEventInterface(): string {
  const source = read('shared/stream-event.ts');
  const start = source.indexOf('export interface StreamEvent {');
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start);
}

function expectAbsent(files: string[], identifiers: string[]): void {
  for (const file of files) {
    const source = read(file);
    for (const id of identifiers) {
      const hit = new RegExp(`\\b${id}\\b`).test(source);
      expect(hit, `${file} 仍引用已下线字段 ${id}`).toBe(false);
    }
  }
}

describe('ISSUE-17 保留项', () => {
  test('messageUuid（有意不产出，宿主回退 implicit-N）与 subagentType（已补生产者）仍在信封上', () => {
    const envelope = streamEventInterface();
    expect(envelope).toMatch(/\bmessageUuid\?: string;/);
    expect(envelope).toMatch(/\bsubagentType\?: string;/);
  });
});

describe('ISSUE-17 T2：isSynthetic 与 usage 分片下线', () => {
  const ids = [
    'isSynthetic',
    'batchIndex',
    'batchCount',
    'mergeHeldUsage',
    'HeldUsageTotals',
    'pendingLedgerUsageBatch',
    'pendingAgentLedgerUsageBatch',
  ];

  test('信封不再声明 isSynthetic / batchIndex / batchCount', () => {
    const envelope = streamEventInterface();
    for (const id of ['isSynthetic', 'batchIndex', 'batchCount']) {
      expect(envelope, id).not.toMatch(new RegExp(`\\b${id}\\b`));
    }
  });

  test('宿主不再写 isSynthetic，也不再暂存合并 usage 分片', () => {
    expectAbsent(['src/index.ts'], ids);
  });
});
