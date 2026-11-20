import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

// ISSUE-05 §2（用户拍板：连同读取端一起下线）：
// "溢出跳过退避"的实际效果由 src/index.ts 的 context_overflow handler 分支达成
// （commitCursor + return true → 队列视为成功，不走 scheduleRetry）；
// markContextOverflow / contextOverflowGroups 是从未接线的平行机制，整体下线。
// src/group-queue.ts 的导入链较重（config/db/container-runner），下线断言走源码
// 文本（先例：tests/provider-auth-error.test.ts 的源码断言模式）。
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const queueSource = readFileSync(
  path.join(repoRoot, 'src/group-queue.ts'),
  'utf-8',
);
const mainSource = readFileSync(path.join(repoRoot, 'src/index.ts'), 'utf-8');

describe('markContextOverflow teardown (ISSUE-05 §2)', () => {
  test('group-queue no longer defines the unwired context-overflow mechanism', () => {
    expect(
      queueSource,
      'markContextOverflow 应已随读取端一起下线',
    ).not.toContain('markContextOverflow');
    expect(
      queueSource,
      'contextOverflowGroups 集合应已随读取端一起下线',
    ).not.toContain('contextOverflowGroups');
  });

  test('the effective overflow skip still exists in the IPC reply handler', () => {
    // 下线的只是平行机制；实际生效的 handler 分支必须保留。
    expect(mainSource).toContain("errorDetail.startsWith('context_overflow:')");
    expect(mainSource).toMatch(/Context overflow detected, skipping retry/);
  });

  test('willRetryAfterFailure survives the teardown and keeps its caller', () => {
    // willRetryAfterFailure 是在用方法（src/index.ts 判断失败提示发本轮还是等
    // 最终失败），下线时只删其中的溢出特判行，方法本身与其调用方必须保留。
    expect(queueSource).toMatch(/willRetryAfterFailure\(groupJid: string\)/);
    expect(mainSource).toContain('queue.willRetryAfterFailure(chatJid)');
  });
});
