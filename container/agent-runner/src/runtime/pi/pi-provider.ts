import type { Model } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

export type PiProviderResolution = {
  providerId: string;
  modelId: string;
  model: Model<any>;
};

function splitModelRef(value: string): { providerId: string; modelId: string } {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) {
    return { providerId: 'anthropic', modelId: value };
  }
  return {
    providerId: value.slice(0, slash),
    modelId: value.slice(slash + 1),
  };
}

/**
 * Bridge the existing CKQClaw provider env contract to Pi ModelRuntime.
 * Custom Anthropic-compatible endpoints are registered as a separate provider
 * so Pi's built-in Anthropic catalog and credentials remain untouched.
 *
 * ISSUE-04 ⑥: `authToken` (ANTHROPIC_AUTH_TOKEN) is deliberately not routed
 * through setRuntimeApiKey for official endpoints. A stored runtime key would
 * send it as X-Api-Key, while the official Anthropic OAuth/bearer contract is
 * `Authorization: Bearer` — leaving the env var untouched lets Pi's own
 * resolution (anthropicApiKeyAuth) discover it and emit the Bearer header.
 * Custom registrations keep folding it into the registered api key, which
 * preserves the historical third-party proxy behavior.
 *
 * ISSUE-04 ①: `contextWindow` overrides the resolved model's window via a
 * shallow copy; undefined keeps the Pi catalog/registration value.
 */
export async function resolvePiProvider(
  modelRuntime: ModelRuntime,
  input: {
    model?: string;
    endpointKind?: 'official' | 'custom';
    baseUrl?: string;
    apiKey?: string;
    authToken?: string;
    contextWindow?: number;
  },
): Promise<PiProviderResolution> {
  const rawModel = input.model?.trim() || '';
  const withContextWindow = (model: Model<any>): Model<any> =>
    input.contextWindow
      ? { ...model, contextWindow: input.contextWindow }
      : model;
  if (!rawModel && input.endpointKind !== 'custom' && !input.baseUrl?.trim()) {
    const defaultModel = modelRuntime.getModels('anthropic')[0];
    if (!defaultModel) {
      throw new Error(
        'Pi has no built-in Anthropic model. Configure ANTHROPIC_MODEL or Pi models.json.',
      );
    }
    if (input.apiKey?.trim()) {
      await modelRuntime.setRuntimeApiKey('anthropic', input.apiKey.trim());
    }
    return {
      providerId: defaultModel.provider,
      modelId: defaultModel.id,
      model: withContextWindow(defaultModel),
    };
  }
  const split = splitModelRef(rawModel || 'claude-sonnet');
  const custom = input.endpointKind === 'custom' || !!input.baseUrl?.trim();
  const providerId = custom ? `ckqclaw-${split.providerId}` : split.providerId;

  if (custom) {
    if (!input.baseUrl?.trim()) {
      throw new Error('Pi custom provider requires ANTHROPIC_BASE_URL');
    }
    if (!rawModel) {
      throw new Error('Pi custom provider requires ANTHROPIC_MODEL');
    }
    const registeredKey = input.apiKey?.trim() || input.authToken?.trim();
    modelRuntime.registerProvider(providerId, {
      name: `CKQClaw ${split.providerId} compatible provider`,
      baseUrl: input.baseUrl.trim(),
      api: 'anthropic-messages',
      ...(registeredKey ? { apiKey: registeredKey } : {}),
      models: [
        {
          id: split.modelId,
          name: split.modelId,
          api: 'anthropic-messages',
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: input.contextWindow ?? 200_000,
          maxTokens: 32_000,
        },
      ],
    });
  } else if (input.apiKey?.trim() && providerId === 'anthropic') {
    await modelRuntime.setRuntimeApiKey('anthropic', input.apiKey.trim());
  }

  const model =
    modelRuntime.getModel(providerId, split.modelId) ||
    (custom
      ? undefined
      : (
          getModel as unknown as (provider: string, model: string) => Model<any>
        )(providerId, split.modelId));
  if (!model) {
    throw new Error(
      `Pi model not found: ${providerId}/${split.modelId}. Configure ANTHROPIC_MODEL or Pi models.json.`,
    );
  }
  return {
    providerId,
    modelId: split.modelId,
    model: withContextWindow(model),
  };
}
