/**
 * Host setting → Pi session-option resolution (ISSUE-04).
 *
 * Kept in a dedicated module (not pi-index.ts) so the contract stays unit
 * testable: the runner entry point executes `main()` on import.
 */

/** Pi thinkingLevel-compatible effort values the host may resolve. */
export type AgentSdkEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const SDK_EFFORT_LEVELS = new Set<string>([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * ISSUE-04 ③: map the host effort settings onto the Pi thinkingLevel.
 *
 * Precedence mirrors the host contract: an Agent-level effort override wins
 * (the host already strips the provider-level `CLAUDE_CODE_EFFORT_LEVEL` env
 * line when the Agent sets one), the provider-level env value is the fallback,
 * and undefined defers to Pi's own default. Values outside the Pi level set
 * — including `inherit` or garbage env content — are dropped instead of being
 * forwarded to the session.
 */
export function resolveAgentThinkingLevel(
  agentEffort: string | undefined,
  envEffort: string | undefined,
): AgentSdkEffort | undefined {
  const agent = agentEffort?.trim();
  if (agent && SDK_EFFORT_LEVELS.has(agent)) {
    return agent as AgentSdkEffort;
  }
  const env = envEffort?.trim();
  if (env && SDK_EFFORT_LEVELS.has(env)) {
    return env as AgentSdkEffort;
  }
  return undefined;
}
