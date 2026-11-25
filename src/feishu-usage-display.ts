/**
 * Feishu usage footer note.
 *
 * THESIS-09 (D-C3 ②): only the reply duration and turn count are displayed.
 * Token totals, cache breakdowns and cost were removed from both the legacy
 * footer note and the v2 card meta row.
 */
interface FeishuUsageNoteInput {
  durationMs: number;
  numTurns: number;
}

function formatSeconds(ms: number): string | null {
  return Number.isFinite(ms) && ms > 0 ? `${(ms / 1000).toFixed(1)}s` : null;
}

function formatTurns(numTurns: number): string | null {
  return Number.isFinite(numTurns) && numTurns > 1 ? `${numTurns} 轮` : null;
}

export function formatFeishuUsageNote(usage: FeishuUsageNoteInput): string {
  const parts = [
    formatSeconds(usage.durationMs),
    formatTurns(usage.numTurns),
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? `⏱ ${parts.join(' · ')}` : '';
}
