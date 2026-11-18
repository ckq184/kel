import { describe, expect, test } from 'vitest';

import { buildEffectiveMcpManifest } from '../src/effective-mcp-manifest.js';

describe('Effective MCP Manifest', () => {
  test('is order-stable and changes for add, remove, or definition changes', () => {
    const first = buildEffectiveMcpManifest({
      alpha: { command: 'alpha', args: ['one'], env: { TOKEN: 'secret-a' } },
      beta: { type: 'http', url: 'https://example.test/mcp' },
    });
    const reordered = buildEffectiveMcpManifest({
      beta: { url: 'https://example.test/mcp', type: 'http' },
      alpha: { env: { TOKEN: 'secret-a' }, args: ['one'], command: 'alpha' },
    });
    const changedDefinition = buildEffectiveMcpManifest({
      alpha: { command: 'alpha', args: ['two'], env: { TOKEN: 'secret-a' } },
      beta: { type: 'http', url: 'https://example.test/mcp' },
    });
    const removed = buildEffectiveMcpManifest({
      alpha: { command: 'alpha', args: ['one'], env: { TOKEN: 'secret-a' } },
    });

    expect(reordered).toEqual(first);
    expect(changedDefinition.hash).not.toBe(first.hash);
    expect(removed.hash).not.toBe(first.hash);
    expect(first.serverIds).toEqual(['alpha', 'beta']);
  });
});
