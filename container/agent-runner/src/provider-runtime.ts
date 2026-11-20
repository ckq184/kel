import { stripOneMillionSuffix } from './context-window.js';

export const CLAUDE_ENDPOINT_KIND_ENV = 'CKQCLAW_CLAUDE_ENDPOINT_KIND';
export const CKQCLAW_CLAUDE_ENDPOINT_KIND_ENV = 'CKQCLAW_CLAUDE_ENDPOINT_KIND';
export const CKQCLAW_CONTEXT_WINDOW_ENV = 'CKQCLAW_CONTEXT_WINDOW';

export type ClaudeEndpointKind = 'official' | 'custom';

export interface ClaudeProviderRuntime {
  endpointKind: ClaudeEndpointKind;
  model: string;
  queryModelOptions: { model?: string };
  usageModelKey: string;
  missingRequiredModel: boolean;
  /**
   * Host-normalized context-window declaration (任务AL), or undefined when the
   * host never injected one — the runner then falls back to the [1m] heuristic
   * on the raw model string so mixed host/runner versions stay no worse than
   * the status quo. Consumed by the Pi wiring as a model-definition override
   * (ISSUE-04 ①, `resolveContextWindowOverride`).
   */
  declaredContextWindow: number | undefined;
}

/** Parse the host declaration; garbage or missing values fall back to the heuristic. */
function parseDeclaredContextWindow(
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const raw = env[CKQCLAW_CONTEXT_WINDOW_ENV]?.trim();
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Resolve the provider/model contract once at runner startup.
 *
 * New hosts inject an authoritative endpoint-kind marker. Falling back to
 * ANTHROPIC_BASE_URL keeps the runner compatible with older hosts and images.
 */
export function resolveClaudeProviderRuntime(
  env: Readonly<Record<string, string | undefined>>,
): ClaudeProviderRuntime {
  const model = env.ANTHROPIC_MODEL?.trim() ?? '';
  const marker = (
    env[CKQCLAW_CLAUDE_ENDPOINT_KIND_ENV] || env[CLAUDE_ENDPOINT_KIND_ENV]
  )
    ?.trim()
    .toLowerCase();
  const endpointKind: ClaudeEndpointKind =
    marker === 'official' || marker === 'custom'
      ? marker
      : env.ANTHROPIC_BASE_URL?.trim()
        ? 'custom'
        : 'official';

  return {
    endpointKind,
    model,
    queryModelOptions: model ? { model: stripOneMillionSuffix(model) } : {},
    usageModelKey: model || 'default',
    missingRequiredModel: endpointKind === 'custom' && !model,
    declaredContextWindow: parseDeclaredContextWindow(env),
  };
}
