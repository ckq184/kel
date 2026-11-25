/**
 * THESIS-09 用量（四）：气泡只留耗时，飞书摘要按 D-C3 ② 只留耗时与轮数。
 *
 * 验收锚点（源码契约，行为面见 tests/message-bubble-duration-only.test.tsx
 * 与 tests/usage-display-formatting.test.ts）：
 * - `MessageBubble.tsx` 不再引用三个 token 明细辅助函数，也不再出现 token
 *   字样与悬停明细；
 * - `token-usage-presentation.ts` 只导出 `parseTokenUsage`；
 * - `stores/chat.ts` 两处实时拼装只写 `durationMs`/`numTurns`；
 * - 飞书 legacy note 与 v2 meta row 不再保留 token/费用字段或格式化函数；
 * - `CardMeta` 不再有 token/cost 字段。
 *
 * 非目标：`usage` 流事件结构与宿主回写不动。
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const repoRoot = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

describe('web bubble only keeps duration', () => {
  test('MessageBubble no longer references token detail helpers', () => {
    const source = read('web/src/components/chat/MessageBubble.tsx');
    expect(source).not.toMatch(
      /getAuthoritativeTokenBreakdown|getDisplayedTokenTotal|getPrimaryModelUsage/,
    );
    expect(source).not.toContain('TooltipContent');
    expect(source).not.toMatch(/tokens/i);
    expect(source).not.toContain('主模型');
    expect(source).not.toContain('缓存读取');
    expect(source).not.toContain('推理');
  });

  test('token-usage-presentation exports only parseTokenUsage', () => {
    const source = read('web/src/lib/token-usage-presentation.ts');
    expect(source.match(/export function /g) ?? []).toHaveLength(1);
    expect(source).toContain('export function parseTokenUsage');
    expect(source).not.toMatch(
      /getAuthoritativeTokenBreakdown|getDisplayedTokenTotal|getPrimaryModelUsage/,
    );
  });

  test('chat store serializes only durationMs and numTurns in both usage paths', () => {
    const source = read('web/src/stores/chat.ts');
    const serialized = source.match(
      /JSON\.stringify\(\{\s*durationMs: usage\.durationMs,\s*numTurns: usage\.numTurns,?\s*\}\)/g,
    );
    expect(serialized ?? []).toHaveLength(2);
    expect(source).not.toContain('inputTokens: usage.inputTokens');
    expect(source).not.toContain('outputTokens: usage.outputTokens');
    expect(source).not.toContain(
      'cacheReadInputTokens: usage.cacheReadInputTokens',
    );
    expect(source).not.toContain(
      'cacheCreationInputTokens: usage.cacheCreationInputTokens',
    );
    expect(source).not.toContain('reasoningTokens: usage.reasoningTokens');
    expect(source).not.toContain('costUSD: usage.costUSD');
    expect(source).not.toContain('modelUsage: usage.modelUsage');
  });
});

describe('Feishu usage summary only keeps duration and turns', () => {
  test('usage display module has no token summary or cost branch', () => {
    const source = read('src/feishu-usage-display.ts');
    expect(source).not.toContain('formatFeishuTokenSummary');
    expect(source).not.toMatch(/tokens/i);
    expect(source).not.toContain('costUSD');
    expect(source).not.toContain('inputTokens');
    expect(source).not.toContain('cacheReadInputTokens');
  });

  test('card meta row has no Token field or unused token formatter', () => {
    const source = read('src/feishu-cards/sections.ts');
    expect(source).not.toContain('💡 Token');
    expect(source).not.toContain('formatTokens');
    expect(source).not.toContain('formatFeishuTokenSummary');
  });

  test('CardMeta no longer carries token or cost fields', () => {
    const source = read('src/feishu-cards/types.ts');
    expect(source).not.toMatch(
      /inputTokens|outputTokens|cacheReadInputTokens|cacheCreationInputTokens|reasoningTokens|costUSD/,
    );
  });

  test('streaming card no longer plumbs token or cost fields into the card', () => {
    const source = read('src/feishu-streaming-card.ts');
    expect(source).not.toContain('inputTokens');
    // `outputTokens` remains only on the modelUsage type used to pick the
    // primary model; it is never copied into the card metadata.
    expect(source).not.toContain('outputTokens: usage');
    expect(source).not.toContain('cacheReadInputTokens');
    expect(source).not.toContain('cacheCreationInputTokens');
    expect(source).not.toContain('reasoningTokens');
    expect(source).not.toContain('costUSD');
  });
});
