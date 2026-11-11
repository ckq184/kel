import { describe, expect, test } from 'vitest';

// The turn decorator lives in its own module: runner tests never import the
// full index.ts entry (its SDK imports do not resolve at test time —
// background-task-drain.test.ts precedent of testing leaf modules only).
import { decorateHarnessAdapterTurn } from '../src/harness-adapter-turn.js';

describe('decorateHarnessAdapterTurn', () => {
  test('prepends the version-tagged block before the message', () => {
    const decorated = decorateHarnessAdapterTurn('用户消息', {
      text: '# Adapter\n\n先确认币种。',
      version: 2,
    });
    expect(decorated.startsWith('<!-- ckqclaw-harness-adapter v2 -->')).toBe(
      true,
    );
    expect(decorated).toContain('# Workspace Harness Adapter');
    expect(decorated).toContain('先确认币种。');
    expect(decorated.endsWith('用户消息')).toBe(true);
  });

  test('returns the message byte-identically when no adapter is set', () => {
    const message = 'plain message\nwith lines';
    expect(decorateHarnessAdapterTurn(message, undefined)).toBe(message);
  });

  test('empty adapter text still decorates (host never sends empty, but stay total)', () => {
    const decorated = decorateHarnessAdapterTurn('m', {
      text: '  ',
      version: 1,
    });
    expect(decorated).toContain('ckqclaw-harness-adapter v1');
  });
});
