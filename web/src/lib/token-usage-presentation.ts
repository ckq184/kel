/**
 * `messages.token_usage` JSON parsing.
 *
 * THESIS-09 (D-C2): the bubble only displays the reply duration. Historical
 * rows still carry input/output/cache/reasoning token details and cost; those
 * fields are intentionally ignored rather than deleted from storage.
 */
interface TokenUsagePayload {
  durationMs?: number;
  numTurns?: number;
}

export function parseTokenUsage(json: string): TokenUsagePayload | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as TokenUsagePayload)
      : null;
  } catch {
    return null;
  }
}
