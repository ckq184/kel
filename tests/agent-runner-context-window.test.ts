import { describe, expect, test } from 'vitest';

import {
  isExtendedContextModel,
  resolveAutoCompactWindow,
  resolveDeclaredContextWindow,
  resolveLegacyAutoCompactWindow,
  stripOneMillionSuffix,
} from '../container/agent-runner/src/context-window.js';

describe('Claude model-aware context compression', () => {
  test('uses 200K for ordinary models and 1M for [1m] models', () => {
    expect(resolveDeclaredContextWindow('claude-sonnet-4-5')).toBe(200_000);
    expect(resolveDeclaredContextWindow('model_hub/glm-5.2[1m]')).toBe(
      1_000_000,
    );
    expect(resolveDeclaredContextWindow('model[1m][1m]')).toBe(1_000_000);
    expect(isExtendedContextModel('model[1M]')).toBe(true);
    expect(isExtendedContextModel('model[1m] trailing')).toBe(false);
  });

  test('declared window wins over the [1m] heuristic, which wins over the default', () => {
    // 声明 > 启发式 > 200k 默认（任务AL 认定优先级矩阵）
    expect(resolveDeclaredContextWindow('glm-5.2', 1_000_000)).toBe(1_000_000);
    expect(resolveDeclaredContextWindow('glm-5.2', 128_000)).toBe(128_000);
    // 声明与后缀同时存在：声明为准（后缀剥离后仅剩声明语义）
    expect(resolveDeclaredContextWindow('glm-5.2[1m]', 256_000)).toBe(256_000);
    // 无声明：启发式接管
    expect(resolveDeclaredContextWindow('glm-5.2[1m]')).toBe(1_000_000);
    // 无声明无后缀：默认
    expect(resolveDeclaredContextWindow('glm-5.2')).toBe(200_000);
  });

  test('strips the [1m] suffix idempotently and case-insensitively', () => {
    expect(stripOneMillionSuffix('glm-5.2[1m]')).toBe('glm-5.2');
    expect(stripOneMillionSuffix('glm-5.2[1M]')).toBe('glm-5.2');
    expect(stripOneMillionSuffix('glm-5.2[1m][1m]')).toBe('glm-5.2');
    // 幂等：剥过的串再剥不变
    expect(stripOneMillionSuffix(stripOneMillionSuffix('glm-5.2[1m]'))).toBe(
      'glm-5.2',
    );
    // 无后缀原样返回（仅去首尾空白）
    expect(stripOneMillionSuffix('glm-5.2')).toBe('glm-5.2');
    expect(stripOneMillionSuffix('  glm-5.2[1m]  ')).toBe('glm-5.2');
    // 非结尾的 [1m] 不是后缀，不剥离
    expect(stripOneMillionSuffix('model[1m] trailing')).toBe(
      'model[1m] trailing',
    );
  });

  test('clamps legacy fixed thresholds to the effective context window', () => {
    expect(resolveLegacyAutoCompactWindow(200_000, 800_000)).toBe(180_000);
    expect(resolveLegacyAutoCompactWindow(200_000, 120_000)).toBe(120_000);
    expect(resolveLegacyAutoCompactWindow(1_000_000, 950_000)).toBe(900_000);
    expect(resolveLegacyAutoCompactWindow(1_000_000, 800_000)).toBe(800_000);
    expect(resolveLegacyAutoCompactWindow(512_000, 950_000)).toBe(460_800);
    expect(resolveLegacyAutoCompactWindow(200_000, 0)).toBeUndefined();
    // 无效窗口值（NaN/非正数）不产出阈值
    expect(resolveLegacyAutoCompactWindow(Number.NaN, 800_000)).toBeUndefined();
    expect(resolveLegacyAutoCompactWindow(0, 800_000)).toBeUndefined();
  });

  test('converts the same percentage relative to the effective context window', () => {
    expect(resolveAutoCompactWindow(200_000, 80)).toBe(160_000);
    expect(resolveAutoCompactWindow(1_000_000, 80)).toBe(800_000);
    expect(resolveAutoCompactWindow(256_000, 50)).toBe(128_000);
  });

  test('rejects percentages outside the supported safety range', () => {
    expect(resolveAutoCompactWindow(200_000, 49)).toBeUndefined();
    expect(resolveAutoCompactWindow(200_000, 91)).toBeUndefined();
    expect(resolveAutoCompactWindow(200_000, 80.5)).toBeUndefined();
    // 无效窗口值（NaN/非正数）不产出阈值
    expect(resolveAutoCompactWindow(Number.NaN, 80)).toBeUndefined();
    expect(resolveAutoCompactWindow(0, 80)).toBeUndefined();
  });
});
