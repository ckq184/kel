import { describe, expect, test } from 'vitest';

import {
  KABOO_SONNET_FALLBACK,
  estimateKabooModelCostCents,
  estimateKabooModelCostUSD,
  matchKabooModelPricing,
  priceKabooUsageByModel,
  type CustomPricingRules,
  type KabooModelPricing,
} from '../src/kaboo-pricing.js';

function rule(
  pattern: string,
  prices: Partial<KabooModelPricing> = {},
): KabooModelPricing {
  return {
    pattern,
    displayName: pattern,
    family: 'custom',
    inputPricePerMTok: 1,
    outputPricePerMTok: 2,
    cacheReadPricePerMTok: 0.1,
    cacheCreationPricePerMTok: 1,
    reasoningPricePerMTok: 2,
    ...prices,
  };
}

/** 计划 §3.2 验收价：GLM 5.3 Flash 的自定义单价。 */
const GLM_FLASH = rule('glm-5.3-flash', {
  displayName: 'GLM 5.3 Flash',
  family: 'zhipu',
  inputPricePerMTok: 0.6,
  outputPricePerMTok: 2.2,
  cacheReadPricePerMTok: 0.1,
  cacheCreationPricePerMTok: 0.7,
  reasoningPricePerMTok: 2.2,
});

const rules = (
  overrides: Partial<CustomPricingRules> = {},
): CustomPricingRules => ({
  patterns: [],
  ...overrides,
});

describe('custom pricing resolution priority', () => {
  test('custom pattern beats the built-in table even when the built-in match is longer', () => {
    // 内置 'claude-sonnet-4-5%' 远长于自定义 'sonnet'，但管理员显式规则胜出。
    const custom = rules({
      patterns: [rule('sonnet', { inputPricePerMTok: 9 })],
    });
    expect(matchKabooModelPricing('claude-sonnet-4-5', custom)).toMatchObject({
      pattern: 'sonnet',
      inputPricePerMTok: 9,
    });
  });

  test('longest custom pattern wins within the custom tier', () => {
    const custom = rules({
      patterns: [rule('glm', { inputPricePerMTok: 8 }), rule('glm-5.3')],
    });
    expect(matchKabooModelPricing('glm-5.3-flash', custom)).toMatchObject({
      pattern: 'glm-5.3',
      inputPricePerMTok: 1,
    });
  });

  test('custom patterns reuse Kaboo matching semantics', () => {
    // 大小写不敏感、尾部 % 忽略、子串命中。
    const custom = rules({ patterns: [rule('GLM-5.3%')] });
    expect(
      matchKabooModelPricing('zhipu/GLM-5.3-Flash:beta', custom),
    ).toMatchObject({ pattern: 'GLM-5.3%' });
  });

  test('falls back to the built-in table when no custom pattern matches', () => {
    const custom = rules({ patterns: [GLM_FLASH] });
    expect(matchKabooModelPricing('claude-opus-4-5', custom)).toMatchObject({
      pattern: 'claude-opus-4-5%',
      inputPricePerMTok: 5,
    });
  });

  test('matching stays undefined for unmatched models, fallback applies in estimate only', () => {
    const custom = rules({
      patterns: [GLM_FLASH],
      fallback: rule('', { inputPricePerMTok: 0.5 }),
    });
    expect(matchKabooModelPricing('kimi-k3', custom)).toBeUndefined();
    expect(
      estimateKabooModelCostUSD('kimi-k3', { inputTokens: 1_000_000 }, custom),
    ).toBeCloseTo(0.5);
  });

  test('custom fallback replaces the built-in Sonnet fallback only when nothing matches', () => {
    const custom = rules({
      patterns: [GLM_FLASH],
      fallback: rule('', {
        displayName: 'Custom fallback',
        inputPricePerMTok: 0.5,
        outputPricePerMTok: 2,
      }),
    });
    // 内置表命中的模型不受自定义兜底影响。
    expect(
      estimateKabooModelCostUSD(
        'claude-haiku-4-5',
        { inputTokens: 1_000_000 },
        custom,
      ),
    ).toBeCloseTo(1);
    // 自定义 pattern 命中的模型优先于自定义兜底。
    expect(
      estimateKabooModelCostUSD(
        'glm-5.3-flash',
        { inputTokens: 1_000_000 },
        custom,
      ),
    ).toBeCloseTo(0.6);
    // 未命中任何规则 → 自定义兜底。
    expect(
      estimateKabooModelCostUSD('kimi-k3', { inputTokens: 1_000_000 }, custom),
    ).toBeCloseTo(0.5);
  });

  test('empty custom rules keep the built-in Sonnet fallback', () => {
    expect(
      estimateKabooModelCostUSD('kimi-k3', { inputTokens: 1_000_000 }, rules()),
    ).toBeCloseTo(KABOO_SONNET_FALLBACK.inputPricePerMTok);
    expect(
      estimateKabooModelCostUSD('kimi-k3', { inputTokens: 1_000_000 }),
    ).toBeCloseTo(KABOO_SONNET_FALLBACK.inputPricePerMTok);
  });

  test('prices all five categories with custom rules at the same cent boundary', () => {
    const custom = rules({ patterns: [GLM_FLASH] });
    expect(
      estimateKabooModelCostCents(
        'glm-5.3-flash',
        {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadInputTokens: 1_000_000,
          cacheCreationInputTokens: 1_000_000,
          reasoningTokens: 1_000_000,
        },
        custom,
      ),
    ).toBe(Math.round((0.6 + 2.2 + 0.1 + 0.7 + 2.2) * 100));
  });
});

describe('custom pricing in per-model attribution', () => {
  test('priceKabooUsageByModel threads custom rules into every model row', () => {
    const custom = rules({ patterns: [GLM_FLASH] });
    const priced = priceKabooUsageByModel(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      {
        'glm-5.3-flash': {
          inputTokens: 55_679,
          outputTokens: 3_230,
          cacheReadInputTokens: 50_112,
          cacheCreationInputTokens: 0,
        },
        'claude-opus-4-5': {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      custom,
    );

    const glm = priced.models.find((m) => m.model === 'glm-5.3-flash')!;
    expect(glm.pricing.pattern).toBe('glm-5.3-flash');
    // 手算验收基线：55,679×0.6/1M + 3,230×2.2/1M + 50,112×0.1/1M = $0.0455246 → 5 cents
    expect(glm.costCents).toBe(5);
    expect(glm.costUSD).toBe(0.05);

    const opus = priced.models.find((m) => m.model === 'claude-opus-4-5')!;
    expect(opus.pricing.inputPricePerMTok).toBe(5);
    expect(opus.costCents).toBe(500);
  });

  test('custom fallback prices unmatched model rows', () => {
    const custom = rules({
      fallback: rule('', { inputPricePerMTok: 0.25 }),
    });
    const priced = priceKabooUsageByModel(
      {},
      { 'kimi-k3': { inputTokens: 2_000_000 } },
      custom,
    );
    expect(priced.models[0].pricing.displayName).toBe(''); // 自定义兜底对象原样透传
    expect(priced.models[0].costCents).toBe(50);
  });

  test('omitting the third argument keeps the historical Sonnet-fallback behaviour', () => {
    const priced = priceKabooUsageByModel(
      {},
      { 'kimi-k3': { inputTokens: 1_000_000 } },
    );
    expect(priced.models[0].pricing).toBe(KABOO_SONNET_FALLBACK);
    expect(priced.models[0].costCents).toBe(300);
  });
});
