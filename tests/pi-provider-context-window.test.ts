import { describe, expect, test } from 'vitest';
import { resolvePiProvider } from '../container/agent-runner/src/runtime/pi/pi-provider.js';

/**
 * Minimal fake ModelRuntime: captures what resolvePiProvider registers for a
 * custom endpoint so the window it hands to Pi can be asserted without a real
 * Pi agent dir or any network.
 */
interface RegisteredModel {
  id: string;
  contextWindow: number;
  maxTokens: number;
}

function fakeModelRuntime(builtin?: { provider: string; model: object }) {
  const registered: Array<{ providerId: string; models: RegisteredModel[] }> =
    [];
  const runtime = {
    registerProvider(
      providerId: string,
      config: { models: RegisteredModel[] },
    ) {
      registered.push({ providerId, models: config.models });
    },
    getModel(providerId: string, modelId: string) {
      const hit = registered
        .find((entry) => entry.providerId === providerId)
        ?.models.find((model) => model.id === modelId);
      if (hit) return { ...hit, provider: providerId };
      if (builtin && builtin.provider === providerId) return builtin.model;
      return undefined;
    },
    getModels: () => [],
    setRuntimeApiKey: async () => undefined,
  };
  return {
    runtime: runtime as unknown as Parameters<typeof resolvePiProvider>[0],
    registered,
  };
}

const custom = {
  endpointKind: 'custom' as const,
  baseUrl: 'https://llm.example.test/anthropic',
  apiKey: 'test-key',
};

describe('pi custom provider context window', () => {
  test('a declared window is handed to Pi as the model context window', async () => {
    const { runtime, registered } = fakeModelRuntime();
    const resolution = await resolvePiProvider(runtime, {
      ...custom,
      model: 'glm-5.2',
      contextWindow: 1_000_000,
    });

    expect(registered).toHaveLength(1);
    expect(registered[0].models[0].contextWindow).toBe(1_000_000);
    expect(resolution.model.contextWindow).toBe(1_000_000);
  });

  test('a declared window smaller than the default is honored, not floored at 200K', async () => {
    // Pi compacts at contextWindow - reserveTokens: a 128K model left at the
    // 200K default would only compact after it has already overflowed.
    const { runtime, registered } = fakeModelRuntime();
    await resolvePiProvider(runtime, {
      ...custom,
      model: 'glm-5.2',
      contextWindow: 128_000,
    });

    expect(registered[0].models[0].contextWindow).toBe(128_000);
  });

  test('no declaration and no [1m] suffix keeps the 200K default', async () => {
    const { runtime, registered } = fakeModelRuntime();
    await resolvePiProvider(runtime, { ...custom, model: 'glm-5.2' });

    expect(registered[0].models[0].contextWindow).toBe(200_000);
  });

  test('no declaration but a legacy [1m] suffix falls back to the 1M heuristic', async () => {
    // Older hosts do not inject CKQCLAW_CONTEXT_WINDOW; the suffix still means 1M.
    const { runtime, registered } = fakeModelRuntime();
    await resolvePiProvider(runtime, { ...custom, model: 'glm-5.2[1m]' });

    expect(registered[0].models[0].contextWindow).toBe(1_000_000);
  });

  test('a declaration wins over the [1m] heuristic', async () => {
    const { runtime, registered } = fakeModelRuntime();
    await resolvePiProvider(runtime, {
      ...custom,
      model: 'glm-5.2[1m]',
      contextWindow: 256_000,
    });

    expect(registered[0].models[0].contextWindow).toBe(256_000);
  });

  test('the output cap is independent of the window', async () => {
    const { runtime, registered } = fakeModelRuntime();
    await resolvePiProvider(runtime, {
      ...custom,
      model: 'glm-5.2',
      contextWindow: 1_000_000,
    });

    expect(registered[0].models[0].maxTokens).toBe(32_000);
  });
});

describe('pi official provider is not affected by a declaration', () => {
  test('built-in models keep their own window and no provider is registered', async () => {
    const builtinModel = { id: 'claude-sonnet-4-5', contextWindow: 200_000 };
    const { runtime, registered } = fakeModelRuntime({
      provider: 'anthropic',
      model: builtinModel,
    });
    const resolution = await resolvePiProvider(runtime, {
      model: 'claude-sonnet-4-5',
      endpointKind: 'official',
      apiKey: 'test-key',
      contextWindow: 1_000_000,
    });

    expect(registered).toHaveLength(0);
    expect(resolution.model).toBe(builtinModel);
    expect(resolution.model.contextWindow).toBe(200_000);
  });
});
