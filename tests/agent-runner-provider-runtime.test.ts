import { describe, expect, test } from 'vitest';

import { resolveClaudeProviderRuntime } from '../container/agent-runner/src/provider-runtime.js';

describe('agent-runner provider model contract', () => {
  test.each([
    {
      name: 'official without model uses the SDK default',
      env: { CKQCLAW_CLAUDE_ENDPOINT_KIND: 'official' },
      missingRequiredModel: false,
      queryModelOptions: {},
      usageModelKey: 'default',
    },
    {
      name: 'official with model passes the selected model',
      env: {
        CKQCLAW_CLAUDE_ENDPOINT_KIND: 'official',
        ANTHROPIC_MODEL: 'sonnet',
      },
      missingRequiredModel: false,
      queryModelOptions: { model: 'sonnet' },
      usageModelKey: 'sonnet',
    },
    {
      name: 'custom endpoint without model fails fast',
      env: { CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom' },
      missingRequiredModel: true,
      queryModelOptions: {},
      usageModelKey: 'default',
    },
    {
      name: 'custom endpoint with model passes the selected model',
      env: {
        CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
        ANTHROPIC_MODEL: 'glm-5.2',
      },
      missingRequiredModel: false,
      queryModelOptions: { model: 'glm-5.2' },
      usageModelKey: 'glm-5.2',
    },
  ])(
    '$name',
    ({ env, missingRequiredModel, queryModelOptions, usageModelKey }) => {
      const runtime = resolveClaudeProviderRuntime(env);

      expect(runtime.missingRequiredModel).toBe(missingRequiredModel);
      expect(runtime.queryModelOptions).toEqual(queryModelOptions);
      expect(runtime.usageModelKey).toBe(usageModelKey);
    },
  );

  test('legacy [1m] model is stripped on the wire and stays intact for budgeting', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_MODEL: 'glm-5.2[1m]',
    });

    // 出口剥离：上送模型名不带后缀（根治第三方端点 400）
    expect(runtime.queryModelOptions).toEqual({ model: 'glm-5.2' });
    // usage 聚合键保持原始串：存量统计桶不因剥离而分裂
    expect(runtime.usageModelKey).toBe('glm-5.2[1m]');
    // 无声明时 declaredContextWindow 为空：[1m] 启发式在窗口覆盖层接管
    expect(runtime.declaredContextWindow).toBeUndefined();
  });

  test('declared context window is parsed from the host env declaration', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_MODEL: 'glm-5.2',
      CKQCLAW_CONTEXT_WINDOW: '1000000',
    });

    expect(runtime.queryModelOptions).toEqual({ model: 'glm-5.2' });
    expect(runtime.declaredContextWindow).toBe(1_000_000);
  });

  test('garbage declaration falls back to the undeclared path', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'official',
      ANTHROPIC_MODEL: 'glm-5.2',
      CKQCLAW_CONTEXT_WINDOW: 'not-a-number',
    });

    expect(runtime.declaredContextWindow).toBeUndefined();
  });

  test('no declaration keeps declaredContextWindow undefined', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_MODEL: 'glm-5.2',
    });

    expect(runtime.declaredContextWindow).toBeUndefined();
  });

  test('authoritative official marker ignores an inherited stale base URL', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'official',
      ANTHROPIC_BASE_URL: 'https://stale-proxy.test',
    });

    expect(runtime.endpointKind).toBe('official');
    expect(runtime.missingRequiredModel).toBe(false);
  });

  test('falls back to base URL detection for older hosts', () => {
    expect(
      resolveClaudeProviderRuntime({
        ANTHROPIC_BASE_URL: 'https://proxy.test',
      }).endpointKind,
    ).toBe('custom');
  });
});
