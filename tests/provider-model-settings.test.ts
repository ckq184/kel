import { describe, expect, test } from 'vitest';

import {
  buildDefaultProviderEnv,
  buildProviderModel,
  parseProviderModel,
  resolveProviderContextWindow,
} from '../web/src/utils/provider-model.js';

describe('third-party provider model settings', () => {
  test('parses the one-million context suffix from an existing model', () => {
    expect(parseProviderModel('  glm-5.2[1m]  ')).toEqual({
      model: 'glm-5.2',
      oneMillionContext: true,
    });
  });

  test('never appends the suffix when building the model value (任务AL)', () => {
    // 后缀只剥离、永不追加：窗口语义由独立 contextWindow 声明承载
    expect(buildProviderModel('glm-5.2')).toBe('glm-5.2');
    expect(buildProviderModel('qwen3.7-max[1M][1m]')).toBe('qwen3.7-max');
    expect(buildProviderModel('MiniMax-M3[1m]')).toBe('MiniMax-M3');
    expect(buildProviderModel(' ')).toBe('');
  });

  test('resolves the effective window with declared > suffix heuristic > default', () => {
    expect(resolveProviderContextWindow('glm-5.2', 1_000_000)).toBe(1_000_000);
    expect(resolveProviderContextWindow('glm-5.2', 128_000)).toBe(128_000);
    // 声明与存量后缀并存：声明为准
    expect(resolveProviderContextWindow('glm-5.2[1m]', 256_000)).toBe(256_000);
    // auto：后缀启发式兼容展示
    expect(resolveProviderContextWindow('glm-5.2[1m]', 'auto')).toBe(1_000_000);
    expect(resolveProviderContextWindow('glm-5.2', 'auto')).toBe(200_000);
  });

  test('shows managed values for a declared-window provider without suffix', () => {
    expect(
      Object.fromEntries(
        buildDefaultProviderEnv('glm-5.2', 1_000_000).map(({ key, value }) => [
          key,
          value,
        ]),
      ),
    ).toEqual({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.2',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      CLAUDE_CODE_NO_FLICKER: '1',
      API_TIMEOUT_MS: '3000000',
    });
  });

  test('keeps model-derived rows pending until a model is entered', () => {
    const rows = buildDefaultProviderEnv('', 'auto');

    expect(rows.filter((row) => row.source === 'model')).toHaveLength(3);
    expect(rows.filter((row) => row.source === 'model')).toSatisfy((items) =>
      items.every((row) => row.value === ''),
    );
    expect(
      rows.find((row) => row.key === 'CLAUDE_CODE_AUTO_COMPACT_WINDOW')?.value,
    ).toBe('200000');
  });
});
