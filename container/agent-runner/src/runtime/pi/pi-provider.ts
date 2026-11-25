import type { Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

import {
  MODEL_REQUIRED_MESSAGE,
  resolveProviderConfigError,
} from '../../provider-runtime.js';

export type PiProviderResolution = {
  providerId: string;
  modelId: string;
  model: Model<any>;
};

export type CustomHeaderWarning = { line: number; message: string };

export type ParsedCustomHeaders = {
  headers: Record<string, string>;
  warnings: CustomHeaderWarning[];
};

// RFC 9110 token characters for a header field name.
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Control characters other than horizontal tab are not valid in a value.
const HEADER_VALUE_INVALID_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/**
 * ISSUE-18: parse `ANTHROPIC_CUSTOM_HEADERS` using the Claude Code convention
 * of one `Name: value` per line. Invalid lines are skipped and reported by
 * line number only — warnings never echo the value, which may be a secret.
 * A later line wins over an earlier one with the same (case-insensitive) name.
 */
export function parseCustomHeaders(
  raw: string | undefined,
): ParsedCustomHeaders {
  const headers: Record<string, string> = {};
  const warnings: CustomHeaderWarning[] = [];
  if (!raw) return { headers, warnings };
  raw.split(/\r\n|\r|\n/).forEach((text, index) => {
    const line = index + 1;
    if (!text.trim()) return;
    const colon = text.indexOf(':');
    if (colon < 0) {
      warnings.push({ line, message: 'missing ":" separator' });
      return;
    }
    const name = text.slice(0, colon).trim();
    const value = text.slice(colon + 1).trim();
    if (!name) {
      warnings.push({ line, message: 'empty header name' });
      return;
    }
    if (!HEADER_NAME_RE.test(name)) {
      warnings.push({ line, message: 'invalid header name' });
      return;
    }
    if (!value) {
      warnings.push({ line, message: `empty value for header ${name}` });
      return;
    }
    if (HEADER_VALUE_INVALID_RE.test(value)) {
      warnings.push({
        line,
        message: `control character in value for header ${name}`,
      });
      return;
    }
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase()) {
        Reflect.deleteProperty(headers, existing);
      }
    }
    headers[name] = value;
  });
  return { headers, warnings };
}

/**
 * Pi resolves header values as config values: a leading `!` runs a shell
 * command and `$VAR` / `${VAR}` expand environment variables. User-supplied
 * header values are literals, so escape them (`$` → `$$`, leading `!` → `$!`).
 */
export function escapePiConfigLiteral(value: string): string {
  const escaped = value.replace(/\$/g, '$$$$');
  return escaped.startsWith('!') ? `$${escaped}` : escaped;
}

/**
 * ISSUE-22: under a custom endpoint the runner environment still carries the
 * endpoint's key in ANTHROPIC_API_KEY, so Pi's env discovery marks the
 * built-in `anthropic` provider available. pi-subagents resolves agent-type
 * models (Explore pins `anthropic/claude-haiku-4-5`) only among available
 * models and falls back to the parent model otherwise. Narrowing this
 * runtime's availability snapshot to the custom provider keeps subagents —
 * which share the parent's ModelRuntime — on the custom endpoint.
 */
export function restrictAvailableModelsToProvider(
  modelRuntime: ModelRuntime,
  providerId: string,
): void {
  const readSnapshot = modelRuntime.getAvailableSnapshot.bind(modelRuntime);
  modelRuntime.getAvailableSnapshot = () =>
    readSnapshot().filter((model) => model.provider === providerId);
}

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
 * D-2 ② (THESIS-04): third-party Anthropic-compatible endpoints are the only
 * supported path; they are registered as a separate provider so Pi's built-in
 * Anthropic catalog is never used. An `official` marker or a missing base URL
 * is a configuration error.
 *
 * ISSUE-04 ⑥: custom registrations fold `authToken` (ANTHROPIC_AUTH_TOKEN)
 * into the registered api key, which preserves the historical third-party
 * proxy behavior.
 *
 * ISSUE-04 ①: `contextWindow` is written into the registered model definition;
 * undefined keeps the 200k registration default.
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
    /**
     * ISSUE-18: extra request headers (parsed `ANTHROPIC_CUSTOM_HEADERS`),
     * applied to the registered third-party provider.
     */
    headers?: Record<string, string>;
  },
): Promise<PiProviderResolution> {
  const configError = resolveProviderConfigError(
    input.endpointKind,
    input.baseUrl,
  );
  if (configError) throw new Error(configError);
  const baseUrl = input.baseUrl?.trim() || '';
  const rawModel = input.model?.trim() || '';
  if (!rawModel) throw new Error(MODEL_REQUIRED_MESSAGE);

  const split = splitModelRef(rawModel);
  const providerId = `ckqclaw-${split.providerId}`;
  const registeredKey = input.apiKey?.trim() || input.authToken?.trim();
  // Model-level headers are merged by ModelRuntime.getAuth however the key
  // resolves; provider-level headers would only join API-key auth.
  const headerEntries = Object.entries(input.headers ?? {});
  const modelHeaders =
    headerEntries.length > 0
      ? Object.fromEntries(
          headerEntries.map(([name, value]) => [
            name,
            escapePiConfigLiteral(value),
          ]),
        )
      : undefined;
  modelRuntime.registerProvider(providerId, {
    name: `CKQClaw ${split.providerId} compatible provider`,
    baseUrl,
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
        ...(modelHeaders ? { headers: modelHeaders } : {}),
      },
    ],
  });
  restrictAvailableModelsToProvider(modelRuntime, providerId);

  const model = modelRuntime.getModel(providerId, split.modelId);
  if (!model) {
    throw new Error(
      `Pi model not found: ${providerId}/${split.modelId}. Configure ANTHROPIC_MODEL or Pi models.json.`,
    );
  }
  return {
    providerId,
    modelId: split.modelId,
    model,
  };
}
