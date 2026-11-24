import { describe, expect, test } from 'vitest';

import { resolveClaudeProviderRuntime } from '../container/agent-runner/src/provider-runtime.js';

/**
 * D-2 ② (THESIS-04): the runtime keeps only the third-party path. An
 * `official` marker and a missing base URL are configuration errors instead of
 * silently falling back to Pi's built-in Anthropic catalog.
 */
describe('agent-runner provider model contract', () => {
  test('custom endpoint with model resolves without a provider error', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_BASE_URL: 'https://proxy.test',
      ANTHROPIC_MODEL: 'glm-5.2',
    });

    expect(runtime.providerError).toBeNull();
    expect(runtime.endpointKind).toBe('custom');
    expect(runtime.missingRequiredModel).toBe(false);
    expect(runtime.queryModelOptions).toEqual({ model: 'glm-5.2' });
    expect(runtime.usageModelKey).toBe('glm-5.2');
  });

  test('custom endpoint without model fails fast', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_BASE_URL: 'https://proxy.test',
    });

    expect(runtime.providerError).toBeNull();
    expect(runtime.missingRequiredModel).toBe(true);
    expect(runtime.queryModelOptions).toEqual({});
    expect(runtime.usageModelKey).toBe('default');
  });

  test('official marker is rejected even when a base URL is present', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'official',
      ANTHROPIC_BASE_URL: 'https://stale-proxy.test',
      ANTHROPIC_MODEL: 'sonnet',
    });

    expect(runtime.providerError).toContain('no longer supported');
    expect(runtime.providerError).toContain('ANTHROPIC_BASE_URL');
  });

  test('missing marker and missing base URL is rejected', () => {
    const runtime = resolveClaudeProviderRuntime({
      ANTHROPIC_MODEL: 'sonnet',
    });

    expect(runtime.providerError).toContain('ANTHROPIC_BASE_URL');
  });

  test('falls back to base URL detection for older hosts', () => {
    const runtime = resolveClaudeProviderRuntime({
      ANTHROPIC_BASE_URL: 'https://proxy.test',
      ANTHROPIC_MODEL: 'glm-5.2',
    });

    expect(runtime.providerError).toBeNull();
    expect(runtime.endpointKind).toBe('custom');
  });

  test('a garbage marker with a base URL still resolves as custom', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'not-a-kind',
      ANTHROPIC_BASE_URL: 'https://proxy.test',
      ANTHROPIC_MODEL: 'glm-5.2',
    });

    expect(runtime.providerError).toBeNull();
    expect(runtime.endpointKind).toBe('custom');
  });

  test('a garbage marker without a base URL is rejected', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'not-a-kind',
      ANTHROPIC_MODEL: 'glm-5.2',
    });

    expect(runtime.providerError).toContain('ANTHROPIC_BASE_URL');
  });

  test('a whitespace-only base URL is treated as missing', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_BASE_URL: '   ',
      ANTHROPIC_MODEL: 'glm-5.2',
    });

    expect(runtime.providerError).toContain('ANTHROPIC_BASE_URL');
  });

  test('legacy [1m] model is stripped on the wire and stays intact for budgeting', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_BASE_URL: 'https://proxy.test',
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
      ANTHROPIC_BASE_URL: 'https://proxy.test',
      ANTHROPIC_MODEL: 'glm-5.2',
      CKQCLAW_CONTEXT_WINDOW: '1000000',
    });

    expect(runtime.queryModelOptions).toEqual({ model: 'glm-5.2' });
    expect(runtime.declaredContextWindow).toBe(1_000_000);
  });

  test('garbage declaration falls back to the undeclared path', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_BASE_URL: 'https://proxy.test',
      ANTHROPIC_MODEL: 'glm-5.2',
      CKQCLAW_CONTEXT_WINDOW: 'not-a-number',
    });

    expect(runtime.declaredContextWindow).toBeUndefined();
  });

  test('no declaration keeps declaredContextWindow undefined', () => {
    const runtime = resolveClaudeProviderRuntime({
      CKQCLAW_CLAUDE_ENDPOINT_KIND: 'custom',
      ANTHROPIC_BASE_URL: 'https://proxy.test',
      ANTHROPIC_MODEL: 'glm-5.2',
    });

    expect(runtime.declaredContextWindow).toBeUndefined();
  });
});
