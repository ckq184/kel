/**
 * Workspace harness adapter turn decoration (task AE, RSI Phase 1).
 *
 * Prepends the version-tagged adapter block to the decorated initial user
 * turn, ahead of the workspace-memory block. The host owns the adapter file
 * and passes its projection via ContainerInput.harnessAdapter; when absent
 * the message is returned byte-identically (zero-impact guarantee).
 *
 * Format mirrors the host's buildAdapterBlock (src/harness-adapter-store.ts)
 * — keep the two in sync; the host test suite locks the shared shape.
 */
export function decorateHarnessAdapterTurn(
  message: string,
  adapter: { text: string; version: number } | undefined,
): string {
  if (!adapter) return message;
  return [
    `<!-- ckqclaw-harness-adapter v${adapter.version} -->`,
    '# Workspace Harness Adapter',
    adapter.text.trim() || '(empty)',
    '<!-- /ckqclaw-harness-adapter -->',
    '',
    message,
  ].join('\n');
}
