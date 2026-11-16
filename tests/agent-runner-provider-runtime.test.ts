import { describe, expect, test } from 'vitest';

import {
  resolveClaudeProviderRuntime,
  resolveClaudeQueryModelRuntime,
} from '../container/agent-runner/src/provider-runtime.js';

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

  test('legacy [1m] model is stripped on the wire and stays 1M for budgeting', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_MODEL: 'glm-5.2[1m]',
    });
    const queryRuntime = resolveClaudeQueryModelRuntime(runtime);

    // 出口剥离：上送模型名不带后缀（根治第三方端点 400）
    expect(runtime.queryModelOptions).toEqual({ model: 'glm-5.2' });
    // usage 聚合键保持原始串：存量统计桶不因剥离而分裂
    expect(runtime.usageModelKey).toBe('glm-5.2[1m]');
    // 无声明时后缀启发式接管：按 1M 认定（兼容承诺）
    expect(queryRuntime.contextWindow).toBe(1_000_000);
  });

  test('declared context window applies without any model suffix', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_MODEL: 'glm-5.2',
      CKQCLAW_CONTEXT_WINDOW: '1000000',
    });
    const queryRuntime = resolveClaudeQueryModelRuntime(runtime);

    expect(runtime.queryModelOptions).toEqual({ model: 'glm-5.2' });
    expect(runtime.declaredContextWindow).toBe(1_000_000);
    expect(queryRuntime.contextWindow).toBe(1_000_000);
  });

  test('declared window wins over the [1m] heuristic', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_MODEL: 'glm-5.2[1m]',
      CKQCLAW_CONTEXT_WINDOW: '256000',
    });
    const queryRuntime = resolveClaudeQueryModelRuntime(runtime);

    expect(runtime.queryModelOptions).toEqual({ model: 'glm-5.2' });
    expect(queryRuntime.contextWindow).toBe(256_000);
  });

  test('garbage declaration falls back to the heuristic path', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'official',
      ANTHROPIC_MODEL: 'glm-5.2',
      CKQCLAW_CONTEXT_WINDOW: 'not-a-number',
    });
    const queryRuntime = resolveClaudeQueryModelRuntime(runtime);

    expect(runtime.declaredContextWindow).toBeUndefined();
    expect(queryRuntime.contextWindow).toBe(200_000);
  });

  test('no declaration and no suffix keeps the 200K default', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_MODEL: 'glm-5.2',
    });
    const queryRuntime = resolveClaudeQueryModelRuntime(runtime);

    expect(runtime.declaredContextWindow).toBeUndefined();
    expect(queryRuntime.contextWindow).toBe(200_000);
  });

  test('per-query model override is stripped and budgeted by its own suffix', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'official',
      ANTHROPIC_MODEL: 'sonnet',
    });
    const queryRuntime = resolveClaudeQueryModelRuntime(runtime, 'glm-5.2[1m]');

    expect(queryRuntime.queryModelOptions).toEqual({ model: 'glm-5.2' });
    expect(queryRuntime.usageModelKey).toBe('glm-5.2[1m]');
    expect(queryRuntime.contextWindow).toBe(1_000_000);
  });

  test('query runtime honors the provider-level declaration', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_MODEL: 'glm-5.2',
      CKQCLAW_CONTEXT_WINDOW: '512000',
    });
    const queryRuntime = resolveClaudeQueryModelRuntime(runtime);

    expect(queryRuntime.contextWindow).toBe(512_000);
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
