import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * 契约测试（ISSUE-13 §B.1）：`shared/stream-event.ts` 的每个 `StreamEventType`
 * 在 runner（container/agent-runner/src）或宿主（src/）中至少有一个生产者
 * （`eventType: '<type>'` 字面量构造）。
 *
 * 已知缺口进下方 `KNOWN_GAPS` 白名单，每条注明 issue 号；对应 issue 完成后
 * 必须删掉条目。失败处置指引：删除某事件的生产者时，必须同步处理三侧消费端
 * （宿主 src/index.ts、Web 快照、飞书/QQ 卡片），或把缺口登记进白名单并注明
 * issue 号——不得静默留下只有消费端的事件类型。
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/** 已知缺口白名单：类型 → 挂靠的 issue（完成后删除条目）。 */
const KNOWN_GAPS: Record<string, string> = {
  raw_sdk_event: 'ISSUE-02（消息边界复用）/ ISSUE-10（若不复用则下线）',
  tool_result:
    'ISSUE-03（Pi 结果在 tool_use_end.toolResult，补读取或下线分支）',
  task_start: 'ISSUE-03（子代理识别与工具卡修复）',
  task_updated: 'ISSUE-03（子代理识别与工具卡修复）',
  task_notification: 'ISSUE-03（完成摘要落库等价实现）',
  context_audit: 'ISSUE-07 第 5 项（宿主直用快照或下线，ISSUE-10 执行）',
  hook_started: 'ISSUE-10（Pi 无 hook 概念，消费分支待下线）',
  hook_progress: 'ISSUE-10（同上）',
  hook_response: 'ISSUE-10（同上）',
  init: 'ISSUE-10（Claude SDK 概念，消费分支待下线）',
  permission_denied: 'ISSUE-10（消费分支待下线）',
  memory_recall: 'ISSUE-10（消费分支待下线）',
  notification: 'ISSUE-10（消费分支待下线）',
  prompt_suggestion: 'ISSUE-10（消费分支待下线）',
  todo_update: 'ISSUE-10（需确认：删除还是让 Pi 补生产者）',
};

/** 现行实际有生产者的类型（2026-11 全仓 grep 取证，Pi runner + 宿主）。 */
const PRODUCED_TODAY = [
  'text_delta',
  'thinking_delta',
  'tool_use_start',
  'tool_progress',
  'tool_use_end',
  'usage',
  'status',
  'compact_boundary',
  'task_progress',
] as const;

const streamEventSource = readFileSync(
  path.join(repoRoot, 'shared/stream-event.ts'),
  'utf-8',
);

/** 从真相源提取 StreamEventType 联合类型的全部成员。 */
function extractStreamEventTypes(): string[] {
  const match = streamEventSource.match(
    /export type StreamEventType =\s*((?:\|\s*'[a-z_]+'\s*)+);/,
  );
  expect(
    match,
    'StreamEventType 联合类型应存在于 shared/stream-event.ts（若词汇表改写为其他形态，需同步更新本测试的提取器）',
  ).toBeTruthy();
  return [...match![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(p));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** 生产者扫描范围：宿主 src/ 与 runner container/agent-runner/src/（排除同步副本与测试）。 */
function collectProducers(): Map<string, string[]> {
  const files = [
    ...walkTsFiles(path.join(repoRoot, 'src')),
    ...walkTsFiles(path.join(repoRoot, 'container/agent-runner/src')),
  ].filter((f) => !f.endsWith('stream-event.types.ts'));

  const producers = new Map<string, string[]>();
  for (const file of files) {
    const source = readFileSync(file, 'utf-8');
    for (const m of source.matchAll(/eventType:\s*'([a-z_]+)'/g)) {
      const list = producers.get(m[1]) ?? [];
      list.push(path.relative(repoRoot, file));
      producers.set(m[1], list);
    }
  }
  return producers;
}

describe('StreamEvent producer coverage contract (ISSUE-13 §B.1)', () => {
  const eventTypes = extractStreamEventTypes();
  const producers = collectProducers();

  test('stream event vocabulary is extracted from the single source of truth', () => {
    // 结构锚点：词汇表提取失败或意外缩小时测试必须红，防止扫描器静默漏扫。
    expect(eventTypes.length).toBeGreaterThan(20);
    expect(eventTypes).toContain('text_delta');
    expect(eventTypes).toContain('status');
  });

  test('every StreamEventType has a producer or a whitelisted issue', () => {
    const missing = eventTypes.filter(
      (type) => !producers.has(type) && !(type in KNOWN_GAPS),
    );
    expect(
      missing,
      `以下事件类型没有任何生产者，也没有白名单登记：${missing.join(', ')}。` +
        '删除生产者时必须同步处理对应消费端；确实保留的缺口请登记进 KNOWN_GAPS 并注明 issue 号。',
    ).toEqual([]);
  });

  test('every whitelisted gap still lacks a producer (whitelist anti-rot)', () => {
    const stale = Object.keys(KNOWN_GAPS).filter((type) => producers.has(type));
    expect(
      stale,
      `以下白名单条目已经重新出现生产者，请删除对应条目：${stale.join(', ')}。`,
    ).toEqual([]);
  });

  test('known produced event types keep at least one producer', () => {
    // 回归锚点：这 9 类是 Pi runner 与宿主的现行生产集（审查报告 §4.1）。
    // 若因重构导致扫描器漏扫或生产者被静默删除，此断言先红。
    const lost = PRODUCED_TODAY.filter((type) => !producers.has(type));
    expect(
      lost,
      `以下现行生产事件类型失去了生产者：${lost.join(', ')}。` +
        '请确认删除是有意的，并同步处理消费端（或按需更新本契约的回归锚点）。',
    ).toEqual([]);
  });
});
