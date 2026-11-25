import { describe, expect, test } from 'vitest';
import { parseTokenUsage } from '../web/src/lib/token-usage-presentation.js';
import { formatFeishuUsageNote } from '../src/feishu-usage-display.js';
import { buildMetaRow } from '../src/feishu-cards/sections.js';

describe('web token usage parsing', () => {
  test('parses a legacy payload with full token details', () => {
    const usage = parseTokenUsage(
      JSON.stringify({
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadInputTokens: 100_000,
        cacheCreationInputTokens: 25_000,
        reasoningTokens: 750,
        costUSD: 1.2345,
        durationMs: 2_500,
        numTurns: 3,
        modelUsage: {
          'claude-opus': {
            inputTokens: 900,
            outputTokens: 450,
            costUSD: 2,
          },
        },
      }),
    );

    expect(usage).not.toBeNull();
    expect(usage).toMatchObject({ durationMs: 2_500, numTurns: 3 });
  });

  test('parses the post-THESIS-07 duration-only payload', () => {
    expect(
      parseTokenUsage(JSON.stringify({ durationMs: 72_776, numTurns: 3 })),
    ).toEqual({ durationMs: 72_776, numTurns: 3 });
  });

  test('returns null for malformed or non-object payloads', () => {
    expect(parseTokenUsage('not-json')).toBeNull();
    expect(parseTokenUsage('null')).toBeNull();
    expect(parseTokenUsage('"text"')).toBeNull();
    expect(parseTokenUsage('[]')).toBeNull();
  });
});

describe('Feishu usage note only keeps duration and turns', () => {
  test('renders duration and turns without tokens or cost', () => {
    const legacyUsage = {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadInputTokens: 100_000,
      cacheCreationInputTokens: 25_000,
      reasoningTokens: 750,
      costUSD: 1.23456,
      durationMs: 2_500,
      numTurns: 3,
    };

    const note = formatFeishuUsageNote(legacyUsage);

    expect(note).toBe('⏱ 2.5s · 3 轮');
    expect(note).not.toMatch(/token/i);
    expect(note).not.toContain('$');
    expect(note).not.toContain('缓存');
    expect(note).not.toContain('推理');
  });

  test('omits a single turn and a zero duration', () => {
    expect(formatFeishuUsageNote({ durationMs: 2_500, numTurns: 1 })).toBe(
      '⏱ 2.5s',
    );
    expect(formatFeishuUsageNote({ durationMs: 0, numTurns: 3 })).toBe(
      '⏱ 3 轮',
    );
  });

  test('returns an empty note when neither duration nor turns is useful', () => {
    expect(formatFeishuUsageNote({ durationMs: 0, numTurns: 1 })).toBe('');
    expect(formatFeishuUsageNote({ durationMs: 0, numTurns: 0 })).toBe('');
  });
});

describe('Feishu card metadata only keeps duration and turns', () => {
  test('renders duration and turns without a Token field', () => {
    const meta = {
      durationMs: 2_500,
      numTurns: 3,
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadInputTokens: 100_000,
      cacheCreationInputTokens: 25_000,
      reasoningTokens: 750,
      costUSD: 1.23456,
    };

    const serialized = JSON.stringify(buildMetaRow(meta));

    expect(serialized).toContain('⏱ 耗时');
    expect(serialized).toContain('2.5s');
    expect(serialized).toContain('3 轮');
    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toContain('💡');
    expect(serialized).not.toContain('输入');
    expect(serialized).not.toContain('缓存');
    expect(serialized).not.toContain('推理');
    expect(serialized).not.toContain('$');
  });

  test('renders turns when duration is absent', () => {
    const serialized = JSON.stringify(buildMetaRow({ numTurns: 3 }));

    expect(serialized).toContain('3 轮');
    expect(serialized).not.toContain('耗时');
  });

  test('returns no row when only zero or single-turn usage is reported', () => {
    expect(buildMetaRow({ durationMs: 0, numTurns: 1 })).toEqual([]);
    expect(buildMetaRow({})).toEqual([]);
    expect(
      buildMetaRow({
        durationMs: Number.POSITIVE_INFINITY,
        numTurns: Number.POSITIVE_INFINITY,
      }),
    ).toEqual([]);
  });

  test('keeps non-usage metadata untouched', () => {
    const serialized = JSON.stringify(
      buildMetaRow({ model: 'claude-opus-4-7', toolCount: 2 }),
    );

    expect(serialized).toContain('opus-4.7');
    expect(serialized).toContain('2 次');
  });
});
